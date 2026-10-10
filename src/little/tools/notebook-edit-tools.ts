import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ToolContext } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { redactSecrets } from '../context/redact-secrets';
import { NOTEBOOK_LIMITS, extractNotebookSource } from './notebook-source';
import { assertNotAborted, type WorkspaceService } from './workspace-service';
import type { EditApplyResult, EditProposal, EditProposalService } from './edit-proposals';

const source = z.string().max(32_000).refine(value => !value.includes('\u0000') && Buffer.from(value, 'utf8').toString('utf8') === value);
const schema = z.object({ path: z.string().min(1).max(4096).regex(/\.ipynb$/i), action: z.enum(['create', 'edit']),
  edits: z.array(z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('replace'), cell: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxCells), expectedSource: source, source }).strict(),
    z.object({ operation: z.literal('patch'), cell: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxCells), search: source.min(1), replacement: source }).strict(),
    z.object({ operation: z.literal('insert'), cell: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxCells), cellType: z.enum(['code', 'markdown']), source }).strict(),
    z.object({ operation: z.literal('delete'), cell: z.number().int().min(1).max(NOTEBOOK_LIMITS.maxCells), expectedSource: source }).strict(),
  ])).min(1).max(16),
}).strict();
type NotebookEditRequest = z.infer<typeof schema>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message: string): never { throw new LittleError('TOOL_VALIDATION_FAILED', message); }
function cellSource(cell: Record<string, unknown>): string {
  if (typeof cell.source === 'string') return cell.source;
  if (Array.isArray(cell.source) && cell.source.every(part => typeof part === 'string')) return cell.source.join('');
  return invalid('A notebook cell has malformed source. No changes were proposed.');
}

/** Builds valid source edits; metadata and unrelated cell outputs stay private and byte content is host-only. */
export function buildNotebookEdit(json: string | undefined, request: NotebookEditRequest, signal?: AbortSignal) {
  assertNotAborted(signal);
  let notebook: Record<string, unknown>;
  if (request.action === 'create') {
    if (json !== undefined || request.edits.some(edit => edit.operation !== 'insert')) invalid('New notebooks require only sequential insert operations.');
    notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
  } else {
    if (json === undefined) invalid('Notebook edits require an existing .ipynb file.');
    extractNotebookSource(json!, request.path, {}, signal);
    let parsed: unknown;
    try { parsed = JSON.parse(json!.replace(/^\uFEFF/, '')); } catch { invalid('The notebook JSON is invalid.'); }
    if (!object(parsed) || !Array.isArray(parsed.cells) || !object(parsed.metadata)) invalid('Notebook edits require valid nbformat 4 cells and metadata.');
    notebook = parsed;
  }
  const cells = notebook.cells as Record<string, unknown>[];
  for (const cell of cells) {
    if (!object(cell) || !['code', 'markdown', 'raw'].includes(String(cell.cell_type)) || !object(cell.metadata)) invalid('A notebook cell has unsupported structure.');
    if (cellSource(cell).includes('\u0000')) invalid('Notebook source cannot contain NUL characters.');
    if (cell.cell_type === 'code' && (!Array.isArray(cell.outputs) || (cell.execution_count !== null && !Number.isSafeInteger(cell.execution_count)))) invalid('A code cell has invalid execution fields.');
  }
  const before: string[] = [], after: string[] = [];
  let generatedBytes = 0;
  for (const edit of request.edits) {
    assertNotAborted(signal);
    const index = edit.cell - 1;
    if (edit.operation === 'insert') {
      if (index > cells.length || cells.length >= NOTEBOOK_LIMITS.maxCells) invalid('Insert at an existing cell position or one past the last cell. Cell numbers apply sequentially.');
      const cell: Record<string, unknown> = { cell_type: edit.cellType, id: randomUUID().replaceAll('-', '').slice(0, 12), metadata: {}, source: edit.source };
      if (edit.cellType === 'code') { cell.outputs = []; cell.execution_count = null; }
      cells.splice(index, 0, cell);
      before.push(`Cell ${edit.cell}: insert ${edit.cellType} source (no prior cell changed)`);
      after.push(`Cell ${edit.cell} (${edit.cellType}; inserted):\n${edit.source}`);
    } else {
      const cell = cells[index];
      if (!cell || !['code', 'markdown'].includes(String(cell.cell_type))) invalid('Select an existing code or markdown cell returned by read_notebook.');
      const original = cellSource(cell);
      const normalizedOriginal = original.replace(/\r\n?/g, '\n');
      if (edit.operation !== 'patch' && normalizedOriginal !== edit.expectedSource.replace(/\r\n?/g, '\n')) invalid('The expected cell source does not match exactly. Read the current cell source before editing.');
      before.push(`Cell ${edit.cell} (${cell.cell_type}):\n${original}`);
      if (edit.operation === 'delete') {
        cells.splice(index, 1);
        after.push(`Cell ${edit.cell}: deleted, including its saved outputs/attachments.`);
      } else {
        let changed: string;
        if (edit.operation === 'patch') {
          const search = edit.search.replace(/\r\n?/g, '\n'), index = normalizedOriginal.indexOf(search);
          if (index < 0 || normalizedOriginal.indexOf(search, index + 1) >= 0) invalid('A notebook patch search must match exactly once in the inspected cell.');
          changed = normalizedOriginal.slice(0, index) + edit.replacement + normalizedOriginal.slice(index + search.length);
        } else changed = edit.source;
        if (original === changed || normalizedOriginal === changed.replace(/\r\n?/g, '\n')) invalid('A replacement must change the cell source.');
        cell.source = changed;
        if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null; }
        after.push(`Cell ${edit.cell} (${cell.cell_type}; changed${cell.cell_type === 'code' ? ', saved output cleared' : ''}):\n${changed}`);
      }
    }
    if ('source' in edit) generatedBytes += Buffer.byteLength(edit.source, 'utf8');
    if ('replacement' in edit) generatedBytes += Buffer.byteLength(edit.replacement, 'utf8');
    if (generatedBytes > 256 * 1024) throw new LittleError('CONTEXT_LIMIT', 'The proposed notebook source is too large. Make smaller cell changes.');
  }
  const content = Buffer.from(JSON.stringify(notebook, null, 2) + '\n', 'utf8');
  if (content.length > NOTEBOOK_LIMITS.maxFileBytes) throw new LittleError('CONTEXT_LIMIT', 'The resulting notebook exceeds the 8 MiB notebook limit.');
  extractNotebookSource(content.toString('utf8'), request.path, {}, signal);
  const preview = (parts: string[]) => {
    const text = redactSecrets(parts.join('\n\n'));
    return text.length > 16_000 ? text.slice(0, 15_900) + '\n[Source preview shortened. No notebook cells were executed.]' : text;
  };
  return { content, preview: { original: request.action === 'create' ? null : preview(before), proposed: preview(after) + '\n\nNo notebook cells were executed. Unchanged cells and metadata are preserved.' } };
}

export function createNotebookEditTools(workspace: WorkspaceService, service: EditProposalService,
  review: (proposal: EditProposal, context: ToolContext) => Promise<EditApplyResult | { status: 'rejected' }>, assertClean: (paths: readonly string[]) => void): AgentTool[] {
  const validate = (input: unknown): NotebookEditRequest => {
    const result = schema.safeParse(input);
    if (!result.success) invalid('Provide a .ipynb path, create/edit action and up to 16 bounded cell operations.');
    return result.data;
  };
  return [{ name: 'propose_notebook_edits', risk: 'WORKSPACE_WRITE',
    description: 'Create/edit .ipynb cells through native review. Cell numbers apply sequentially; insert before N or append at count+1. Replace/delete require expectedSource; patch requires unique literal search/replacement (LF source lines). Changed code outputs clear. Unrelated cells/metadata persist. No execution; rejection writes nothing.',
    parameters: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, validate,
    async execute(input, context) {
      const request = validate(input);
      assertNotAborted(context.signal); assertClean([request.path]);
      const original = request.action === 'edit' ? await workspace.readBinaryFile(request.path, context.signal, NOTEBOOK_LIMITS.maxFileBytes) : undefined;
      let json: string | undefined;
      if (original) { try { json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original.bytes); } catch { invalid('Notebooks must contain valid UTF-8 JSON.'); } }
      const built = buildNotebookEdit(json, request, context.signal);
      const proposal = await service.stageBinary([{ kind: 'binary', path: request.path, operation: request.action === 'create' ? 'create' : 'replace',
        content: built.content, expectedHash: original ? createHash('sha256').update(original.bytes).digest('hex') : null, preview: built.preview }], context.signal);
      try {
        const result = await review(proposal, context);
        return { status: result.status, files: proposal.changes.map(change => ({ path: change.path, kind: change.kind })),
          cellsExecuted: false, ...('error' in result && result.error ? { error: result.error } : {}),
          verification: 'The reviewed result confirms notebook file changes only; no cells or tests ran.' };
      } finally { service.discard(proposal.id); }
    },
  }];
}
