import { z } from 'zod';
import type { AgentTool } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { assertNotAborted } from './workspace-service';
import { NOTEBOOK_LIMITS, notebookCellRange, readNotebookSource, type NotebookWorkspaceReader } from './notebook-source';

const schema = z.object({
  path: z.string().min(1).max(4_096).refine(value => !/[\u0000-\u001f]/.test(value) && /\.ipynb$/i.test(value)),
  startCell: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxCells).default(1),
  endCell: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxCells).optional(),
  startLine: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxSourceLines).optional(),
  endLine: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxSourceLines).optional(),
}).strict();

export function createNotebookTools(workspace: NotebookWorkspaceReader): AgentTool[] {
  const validate = (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Notebook inspection requires a workspace .ipynb path and bounded one-based cell numbers.');
    const selected = { path: parsed.data.path, ...notebookCellRange(parsed.data),
      ...(parsed.data.startLine === undefined ? {} : { startLine: parsed.data.startLine }),
      ...(parsed.data.endLine === undefined ? {} : { endLine: parsed.data.endLine }) };
    if ((selected.startLine !== undefined || selected.endLine !== undefined) &&
      (selected.startCell !== selected.endCell || (selected.endLine ?? (selected.startLine ?? 1) + NOTEBOOK_LIMITS.maxCellLines - 1) < (selected.startLine ?? 1) ||
       (selected.endLine ?? (selected.startLine ?? 1) + NOTEBOOK_LIMITS.maxCellLines - 1) - (selected.startLine ?? 1) + 1 > NOTEBOOK_LIMITS.maxCellLines)) {
      throw new LittleError('TOOL_VALIDATION_FAILED', 'Select one cell and at most 120 source lines.');
    }
    return selected;
  };
  return [{ name: 'read_notebook', risk: 'SAFE',
    description: 'Read .ipynb code/markdown source, up to 20 cells. For long cells, set startCell=endCell and startLine/endLine (up to 120 source lines). Cite original cell/source lines. Outputs, images and metadata are excluded; no cells execute.',
    parameters: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, validate,
    async execute(input, context) {
      assertNotAborted(context.signal);
      const selected = validate(input);
      return readNotebookSource(workspace, selected.path, selected, context.signal);
    },
  }];
}
