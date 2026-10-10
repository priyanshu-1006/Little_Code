import * as vscode from 'vscode';
import type { AgentTool, CommandResult, RuntimeEvent, ToolContext } from '../little/shared/contracts';
import { LittleError } from '../little/shared/errors';
import { ProjectCommandService, type CommandProposal } from '../little/tools/command-service';
import { createCommandTools } from '../little/tools/command-tools';
import type { WorkspaceService } from '../little/tools/workspace-service';

interface PendingCommand {
  proposal: CommandProposal; service: ProjectCommandService; context: ToolContext;
  deciding: boolean; executing: boolean;
  resolve: (result: CommandResult) => void; reject: (error: unknown) => void; cleanup: () => void;
}

/** Native confirmation, private one-use grants, and owned child lifetime stay in the extension host. */
export class CommandReviewHost implements vscode.Disposable {
  private pending?: PendingCommand;
  private disposed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly output = vscode.window.createOutputChannel('Little Commands');
  constructor(private readonly emit: (event: RuntimeEvent) => void) {}
  get busy(): boolean { return this.pending !== undefined; }
  tools(workspace: WorkspaceService): AgentTool[] {
    const service = new ProjectCommandService(workspace);
    return createCommandTools(service, (proposal, context) => this.request(proposal, service, context)).map(tool => ({ ...tool,
      execute: async (input, context) => {
        if (this.disposed) throw new LittleError('AGENT_CANCELLED', 'The command host was closed.');
        const controller = new AbortController();
        const abort = () => controller.abort();
        this.controllers.add(controller);
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) controller.abort();
        try { return await tool.execute(input, { ...context, signal: controller.signal }); }
        finally { context.signal.removeEventListener('abort', abort); this.controllers.delete(controller); }
      },
    }));
  }
  private request(proposal: CommandProposal, service: ProjectCommandService, context: ToolContext): Promise<CommandResult> {
    context.signal.throwIfAborted();
    if (!context.runId || this.pending || this.disposed) throw new LittleError('PERMISSION_DENIED', 'Only one project command may be active.');
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.pending !== pending || pending.executing) return;
        const result: CommandResult = { status: 'cancelled', exitCode: null, output: '', truncated: false, durationMs: 0 };
        this.emit({ type: 'command.completed', runId: context.runId!, commandId: proposal.id, result });
        pending.cleanup(); resolve(result);
      };
      const pending: PendingCommand = { proposal, service, context, deciding: false, executing: false, resolve, reject,
        cleanup: () => { context.signal.removeEventListener('abort', abort); service.discard(proposal.id); if (this.pending === pending) this.pending = undefined; } };
      this.pending = pending;
      context.signal.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'agent.state.changed', runId: context.runId!, state: 'waiting_for_permission' });
      this.emit({ type: 'command.proposed', runId: context.runId!, commandId: proposal.id, command: proposal.command, risk: proposal.risk });
      if (context.signal.aborted) abort();
    });
  }
  async decide(id: string, decision: 'allow' | 'reject'): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.proposal.id !== id || pending.deciding || pending.context.signal.aborted || this.disposed) throw new LittleError('PERMISSION_DENIED', 'This command request expired or already has a decision.');
    const runId = pending.context.runId!;
    pending.deciding = true;
    const command = pending.proposal.command;
    if (decision === 'allow') {
      let confirm: string | undefined;
      try { confirm = await vscode.window.showWarningMessage('Run this project command?', { modal: true,
        detail: `${command.program} ${command.args.join(' ')}\n\nProject folder: ${command.cwd}\nReason: ${command.purpose}\nTimeout: ${command.timeoutMs / 1000}s\n\nThis runs with your current user permissions. Project scripts can change files or access the network. Little checkpoints cover accepted file edits, not command side effects.` }, 'Run command');
      } catch (error) {
        if (this.pending === pending) {
          this.emit({ type: 'command.completed', runId, commandId: id, result: { status: 'failed', exitCode: null, output: 'Native command confirmation could not open.', truncated: false, durationMs: 0 } });
          pending.cleanup(); pending.reject(error);
        }
        return;
      }
      if (this.pending !== pending || pending.context.signal.aborted || this.disposed) return;
      if (confirm !== 'Run command') decision = 'reject';
    }
    if (decision === 'reject') {
      const result: CommandResult = { status: 'rejected', exitCode: null, output: '', truncated: false, durationMs: 0 };
      this.emit({ type: 'command.completed', runId, commandId: id, result });
      pending.cleanup(); pending.resolve(result); return;
    }
    if (!vscode.workspace.isTrusted) {
      this.emit({ type: 'command.completed', runId, commandId: id, result: { status: 'failed', exitCode: null, output: 'Workspace trust is required to run commands.', truncated: false, durationMs: 0 } });
      pending.cleanup(); pending.reject(new LittleError('PERMISSION_DENIED', 'Trust this workspace before executing project commands.')); return;
    }
    try {
      const grant = pending.service.approve(pending.proposal);
      pending.executing = true;
      this.emit({ type: 'command.started', runId, commandId: id });
      this.emit({ type: 'agent.state.changed', runId, state: 'verifying' });
      const result = await pending.service.execute(pending.proposal, grant, pending.context.signal);
      this.emit({ type: 'command.completed', runId, commandId: id, result });
      if (!this.disposed) {
        this.output.appendLine(`> ${command.program} ${command.args.join(' ')} [${command.cwd}]`);
        this.output.appendLine(result.output);
        this.output.appendLine(`${result.status}; exit ${result.exitCode ?? 'none'}; ${result.durationMs}ms${result.truncated ? '; output truncated' : ''}`);
      }
      pending.cleanup(); pending.resolve(result);
    } catch (error) {
      this.emit({ type: 'command.completed', runId, commandId: id, result: { status: 'failed', exitCode: null, output: 'The project command could not complete. Inspect the reported tool error.', truncated: false, durationMs: 0 } });
      pending.cleanup(); pending.reject(error);
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    if (this.pending && !this.pending.executing) {
      const pending = this.pending; pending.cleanup(); pending.reject(new LittleError('AGENT_CANCELLED', 'Command approval was closed.'));
    }
    this.output.dispose();
  }
}
