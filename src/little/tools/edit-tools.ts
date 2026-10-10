import { z } from 'zod';
import type { AgentTool, ToolContext } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { EDIT_PROPOSAL_LIMITS, type EditApplyResult, type EditProposal, type EditProposalService, type WorkspaceEdit } from './edit-proposals';

const editPath = z.string().min(1).max(4096);
const editText = z.string().max(EDIT_PROPOSAL_LIMITS.maxFileBytes);
const schema = z.object({ edits: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replace'), path: editPath, replacements: z.array(z.object({ search: editText.min(1), replacement: editText }).strict()).min(1).max(EDIT_PROPOSAL_LIMITS.maxReplacements) }).strict(),
  z.object({ kind: z.literal('create'), path: editPath, content: editText }).strict(),
  z.object({ kind: z.literal('delete'), path: editPath }).strict(),
])).min(1).max(EDIT_PROPOSAL_LIMITS.maxFiles) }).strict();

export function createEditTools(
  service: EditProposalService,
  review: (proposal: EditProposal, context: ToolContext) => Promise<EditApplyResult | { status: 'rejected' }>,
  assertClean: (paths: readonly string[]) => void,
): AgentTool[] {
  const validate = (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Edits require relative paths and bounded literal replacements, new file content, or regular-file deletion.');
    return parsed.data;
  };
  return [{
    name: 'propose_file_edits', risk: 'WORKSPACE_WRITE',
    description: 'Propose small literal changes to inspected UTF-8 source files, create a text file in an existing directory, or delete an existing regular file. Replacement searches must match exactly once. No files change until native review and explicit acceptance; rejection writes nothing. Accepted changes receive an exact-byte recovery checkpoint. Use dedicated tools to create/edit notebooks, DOCX, PPTX, or PDF. Cannot modify dirty, ignored, linked, sensitive files, delete directories, or run commands.',
    parameters: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, validate,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const { edits } = validate(input);
      assertClean(edits.map(edit => edit.path));
      const proposal = await service.stage(edits as WorkspaceEdit[], context.signal);
      try {
        const result = await review(proposal, context);
        return { status: result.status, files: proposal.changes.map(change => ({ path: change.path, kind: change.kind })),
          ...('error' in result && result.error ? { error: result.error } : {}),
          ...('recovery' in result && result.recovery ? { recoveryConflicts: result.recovery.conflicts.map(conflict => conflict.path) } : {}),
          verification: 'This proposal result confirms file changes only. Check command results separately; it does not establish test or build success.' };
      } finally { service.discard(proposal.id); }
    },
  }];
}
