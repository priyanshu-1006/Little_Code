import { z } from 'zod';
import type { AgentTool, CommandResult, ToolContext } from '../shared/contracts';
import { CommandSchema, validateCommand, type CommandProposal, type ProjectCommandService } from './command-service';

export function createCommandTools(service: ProjectCommandService, review: (proposal: CommandProposal, context: ToolContext) => Promise<CommandResult>): AgentTool[] {
  return [{
    name: 'run_command', risk: 'EXECUTION',
    description: 'Request one project check or local script using a program and separate argument tokens. The host displays the exact command and pauses for Allow once or Reject. Each run requires fresh approval. Output and timeout are bounded. Direct shell syntax, eval, installs, network commands, parent/absolute paths, and destructive actions are unavailable. Approved scripts retain current-user OS permissions and can have side effects outside their working folder; they are not sandboxed. The cwd is a relative project folder. A rejected command did not execute. An exited result with exitCode 0 means that command succeeded; report verification honestly.',
    parameters: z.toJSONSchema(CommandSchema, { io: 'input' }) as Record<string, unknown>,
    validate: validateCommand,
    async execute(input, context) {
      const proposal = await service.stage(input, context.signal);
      try { return await review(proposal, context); }
      finally { service.discard(proposal.id); }
    },
  }];
}
