import { z } from 'zod';
import { GitService } from '../git/git-service';
import type { AgentTool } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import type { WorkspaceService } from './workspace-service';

export function createGitTools(workspace: WorkspaceService): AgentTool[] {
  const service = new GitService(workspace);
  const empty = z.object({}).strict();
  const diff = z.object({ path: z.string().min(1).max(4096), staged: z.boolean().default(false) }).strict();
  return [
    { name: 'git_status', description: 'Read protected Git status for the exact project root. Only current permitted files are shown; deleted and private paths can be omitted. Does not stage or commit.', risk: 'SAFE', parameters: z.toJSONSchema(empty, { io: 'input' }),
      validate(input) { if (!empty.safeParse(input).success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Git status takes no arguments.'); return {}; },
      execute: (_, context) => service.status(context.signal) },
    { name: 'git_diff', description: 'Read a bounded redacted staged or working-tree Git diff for one current permitted file. Uses fixed Git arguments without external diff, textconv or filters. Does not modify Git.', risk: 'SAFE', parameters: z.toJSONSchema(diff, { io: 'input' }),
      validate(input) { const result = diff.safeParse(input); if (!result.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Supply a project-relative path and staged flag.'); return result.data; },
      execute: (input, context) => { const parsed = diff.parse(input); return service.diff(parsed.path, parsed.staged, context.signal); } },
  ];
}
