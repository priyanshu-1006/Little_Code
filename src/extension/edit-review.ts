import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentTool, RuntimeEvent, ToolContext } from '../little/shared/contracts';
import { LittleError } from '../little/shared/errors';
import { EditProposalService, type EditApplyResult, type EditProposal } from '../little/tools/edit-proposals';
import { createEditTools } from '../little/tools/edit-tools';
import { createNotebookEditTools } from '../little/tools/notebook-edit-tools';
import { createDocumentEditTools } from '../little/tools/document-tools';
import type { WorkspaceService } from '../little/tools/workspace-service';

type Decision = EditApplyResult | { status: 'rejected' };
interface PendingReview {
  proposal: EditProposal; service: EditProposalService; folder: vscode.WorkspaceFolder; context: ToolContext;
  reviewed: boolean; deciding: boolean; resolve: (result: Decision) => void; reject: (error: unknown) => void; cleanup: () => void;
}
interface RecoveryRecord { service: EditProposalService; folder: vscode.WorkspaceFolder; runId: string; paths: string[] }

/** The model can stage a proposal; only this host can mint its acceptance grant. */
export class EditReviewHost implements vscode.Disposable {
  private pending?: PendingReview;
  private readonly documents = new Map<string, string>();
  private readonly recoveries = new Map<string, RecoveryRecord>();
  private readonly provider: vscode.Disposable;
  private restoring = false;
  constructor(private readonly extension: vscode.ExtensionContext, private readonly emit: (event: RuntimeEvent) => void, private readonly runBusy: () => boolean, private readonly activeFolder?: () => vscode.WorkspaceFolder | undefined) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider('little-edit', {
      provideTextDocumentContent: uri => this.documents.get(uri.toString()) ?? 'This Little diff has expired.',
    });
  }
  get busy(): boolean { return this.restoring; }

  private storage(folder: vscode.WorkspaceFolder): string {
    const key = createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 24);
    return vscode.Uri.joinPath(this.extension.storageUri ?? this.extension.globalStorageUri, 'checkpoints', key).fsPath;
  }

  assertClean(folder: vscode.WorkspaceFolder, paths: readonly string[]): void {
    const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const targets = new Set(paths.map(file => normalize(path.join(folder.uri.fsPath, file))));
    if ([...vscode.workspace.textDocuments, ...vscode.workspace.notebookDocuments].some(document => document.uri.scheme === 'file' && document.isDirty && targets.has(normalize(document.uri.fsPath)))) {
      throw new LittleError('PERMISSION_DENIED', 'Save the affected editor files before proposing, applying, or restoring changes.');
    }
  }

  async tools(workspace: WorkspaceService, folder: vscode.WorkspaceFolder): Promise<AgentTool[]> {
    const directory = this.storage(folder);
    await fs.mkdir(directory, { recursive: true });
    const service = new EditProposalService(workspace, directory);
    const review = (proposal: EditProposal, context: ToolContext) => this.request(proposal, service, folder, context);
    const assertClean = (paths: readonly string[]) => this.assertClean(folder, paths);
    return [...createEditTools(service, review, assertClean), ...createNotebookEditTools(workspace, service, review, assertClean), ...createDocumentEditTools(workspace, service, review, assertClean)];
  }

  private request(proposal: EditProposal, service: EditProposalService, folder: vscode.WorkspaceFolder, context: ToolContext): Promise<Decision> {
    context.signal.throwIfAborted();
    if (!context.runId || this.pending || this.restoring) throw new LittleError('PERMISSION_DENIED', 'Only one edit or recovery may be active.');
    this.assertClean(folder, proposal.changes.map(change => change.path));
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.pending !== pending || pending.deciding) return;
        service.discard(proposal.id);
        this.emit({ type: 'edits.resolved', runId: context.runId!, proposalId: proposal.id, decision: 'rejected' });
        pending.cleanup();
        reject(new LittleError('AGENT_CANCELLED', 'Edit review stopped. No pending changes were applied.'));
      };
      const pending: PendingReview = { proposal, service, folder, context, reviewed: false, deciding: false, resolve, reject,
        cleanup: () => {
          context.signal.removeEventListener('abort', abort);
          if (this.pending === pending) this.pending = undefined;
          for (const uri of this.documents.keys()) if (uri.includes(`/${proposal.id}/`)) this.documents.delete(uri);
        } };
      this.pending = pending;
      context.signal.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'edits.proposed', runId: context.runId!, proposalId: proposal.id, files: proposal.changes.map(change => ({ path: change.path, kind: change.kind })) });
      if (context.signal.aborted) abort();
    });
  }

  async review(proposalId: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.proposal.id !== proposalId || pending.deciding) throw new LittleError('PERMISSION_DENIED', 'This proposal has already resolved or is no longer available.');
    pending.context.signal.throwIfAborted();
    const previews = pending.service.preview(proposalId);
    for (const [index, file] of previews.entries()) {
      pending.context.signal.throwIfAborted();
      const name = /\.(?:ipynb|docx|pptx|pdf)$/i.test(file.path) ? `${path.basename(file.path)}.review.txt` : path.basename(file.path);
      const uri = (side: string) => vscode.Uri.from({ scheme: 'little-edit', path: `/${proposalId}/${index}/${side}/${name}` });
      const before = uri('before'), after = uri('proposed');
      this.documents.set(before.toString(), file.original ?? '');
      this.documents.set(after.toString(), file.proposed);
      await vscode.commands.executeCommand('vscode.diff', before, after, `${file.path} · Little proposed change`, { preview: false });
    }
    if (this.pending === pending && !pending.context.signal.aborted) pending.reviewed = true;
  }

  async decide(proposalId: string, decision: 'accept' | 'reject'): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.proposal.id !== proposalId || pending.deciding) throw new LittleError('PERMISSION_DENIED', 'This proposal has already resolved or is no longer available.');
    pending.context.signal.throwIfAborted();
    if (decision === 'reject') {
      pending.service.discard(proposalId);
      this.emit({ type: 'edits.resolved', runId: pending.context.runId!, proposalId, decision: 'rejected' });
      pending.cleanup(); pending.resolve({ status: 'rejected' }); return;
    }
    if (!pending.reviewed) throw new LittleError('PERMISSION_DENIED', 'Open Review diff before accepting these changes.');
    this.assertClean(pending.folder, pending.proposal.changes.map(change => change.path));
    if (!vscode.workspace.isTrusted) throw new LittleError('PERMISSION_DENIED', 'Trust the workspace before accepting changes.');
    pending.deciding = true;
    try {
      let result = await pending.service.apply(pending.service.accept(proposalId), pending.context.signal);
      if (result.status === 'applied') {
        try { this.assertClean(pending.folder, pending.proposal.changes.map(change => change.path)); }
        catch {
          const recovery = await pending.service.rollback(result.checkpointId);
          result = { ...result, status: 'failed', recovery, error: { code: 'PERMISSION_DENIED', message: 'An editor changed while applying. Saved changes were rolled back where possible; unsaved text is preserved.' } };
        }
      }
      this.recoveries.set(result.checkpointId, { service: pending.service, folder: pending.folder, runId: pending.context.runId!, paths: pending.proposal.changes.map(change => change.path) });
      this.emit({ type: 'edits.resolved', runId: pending.context.runId!, proposalId, decision: result.status === 'applied' ? 'applied' : 'conflicted', checkpointId: result.checkpointId });
      pending.resolve(result);
      if (result.recovery?.conflicts.length) void vscode.window.showWarningMessage('Some files need recovery. Their checkpoint is preserved; use Little: Restore Checkpoint after resolving conflicts.');
      if (result.cleanupPaths?.length || result.recovery?.cleanupPaths?.length) void vscode.window.showWarningMessage('The edit result is recorded, but temporary recovery files remain in the project. Keep them until you have checked the change and its checkpoint.');
    } catch (error) {
      this.emit({ type: 'edits.resolved', runId: pending.context.runId!, proposalId, decision: 'conflicted' });
      pending.reject(error);
      throw error;
    } finally { pending.cleanup(); }
  }

  async restore(checkpointId: string): Promise<void> {
    const record = this.recoveries.get(checkpointId);
    if (!record) throw new LittleError('PERMISSION_DENIED', 'This checkpoint has already restored or is no longer available.');
    if (this.pending || this.restoring) throw new LittleError('PERMISSION_DENIED', 'Wait for the current edit or restoration to finish.');
    if (this.runBusy()) throw new LittleError('PERMISSION_DENIED', 'Stop the current run before restoring changes.');
    if (!vscode.workspace.isTrusted) throw new LittleError('PERMISSION_DENIED', 'Trust the workspace before restoring changes.');
    if (this.activeFolder && this.activeFolder()?.uri.toString() !== record.folder.uri.toString()) throw new LittleError('PERMISSION_DENIED', 'Return to this checkpoint’s project before restoring changes.');
    this.assertClean(record.folder, record.paths);
    this.restoring = true;
    try {
      const choice = await vscode.window.showWarningMessage('Restore this Little checkpoint?', { modal: true, detail: `${record.folder.name}\n\n${record.paths.join('\n')}\n\nLittle will reconcile recorded interrupted writes and restore unchanged affected files. Later file changes are preserved as conflicts. Commands and other external side effects are not rolled back.` }, 'Restore checkpoint');
      if (choice !== 'Restore checkpoint') return;
      if (!vscode.workspace.isTrusted || this.runBusy() || (this.activeFolder && this.activeFolder()?.uri.toString() !== record.folder.uri.toString())) throw new LittleError('PERMISSION_DENIED', 'The project or trust changed while checkpoint restoration was waiting.');
      this.assertClean(record.folder, record.paths);
      const result = await record.service.rollback(checkpointId);
      if (result.cleanupPaths?.length) void vscode.window.showWarningMessage('Restoration finished with temporary recovery files remaining. Keep them until you have checked the restored files.');
      if (result.conflicts.length) throw new LittleError('TOOL_FAILED', `Restore preserved later changes in: ${result.conflicts.map(item => item.path).join(', ')}. Unchanged files were restored; the checkpoint remains available.`);
      if (record.runId) this.emit({ type: 'edits.restored', runId: record.runId, checkpointId });
      this.recoveries.delete(checkpointId);
      void vscode.window.showInformationMessage(`Little restored ${result.restored.length} file(s).`);
    } finally { this.restoring = false; }
  }

  async restoreSaved(workspace: WorkspaceService, folder: vscode.WorkspaceFolder): Promise<void> {
    if (this.pending || this.restoring) return;
    const directory = this.storage(folder);
    await fs.mkdir(directory, { recursive: true });
    const service = new EditProposalService(workspace, directory);
    const items = (await service.listCheckpoints()).filter(item => item.paths.length > 0).map(item => ({ id: item.id, paths: [...item.paths], label: new Date(item.modifiedMs).toLocaleString(), description: item.interrupted ? 'Interrupted edit · recovery available' : item.state, detail: item.paths.join(', ') }));
    const selected = await vscode.window.showQuickPick(items, { title: 'Restore a Little checkpoint', placeHolder: items.length ? 'Review recorded or interrupted edits. Later file changes are preserved.' : 'No recoverable checkpoints in this project.' });
    if (!selected) return;
    const runId = this.recoveries.get(selected.id)?.runId ?? '';
    if (this.activeFolder && this.activeFolder()?.uri.toString() !== folder.uri.toString()) throw new LittleError('PERMISSION_DENIED', 'The active project changed while selecting a checkpoint.');
    this.recoveries.set(selected.id, { service, folder, runId, paths: selected.paths });
    await this.restore(selected.id);
  }

  dispose(): void {
    const pending = this.pending;
    if (pending && !pending.deciding) { pending.service.discard(pending.proposal.id); pending.cleanup(); pending.reject(new LittleError('AGENT_CANCELLED', 'Little closed the pending edit review.')); }
    this.provider.dispose(); this.documents.clear();
  }
}
