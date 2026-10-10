import { redactSecrets } from '../context/redact-secrets';
import { LittleError } from '../shared/errors';
import { assertNotAborted, type FileContent } from './workspace-service';

export const NOTEBOOK_LIMITS = Object.freeze({ maxFileBytes: 8 * 1024 * 1024, maxCells: 10_000, maxRangeCells: 20,
  maxOutputChars: 12_000, maxCellChars: 4_000, maxCellLines: 120, maxSourceLines: 100_000 });
export interface NotebookWorkspaceReader { readNotebookFile(input: string, signal?: AbortSignal): Promise<FileContent> }
export interface NotebookRange { startCell?: number; endCell?: number; startLine?: number; endLine?: number }
export interface NotebookCellCitation {
  cell: number; type: 'code' | 'markdown'; startLine: number; endLine: number; totalLines: number; truncated: boolean;
}
export interface NotebookSource {
  path: string; format: 'jupyter-notebook-v4'; totalCells: number; startCell: number; endCell: number;
  cells: NotebookCellCitation[]; content: string; truncated: boolean; omittedCells: number; omittedCellTypes: number;
  outputsIncluded: false; metadataIncluded: false;
}
function invalid(): never {
  throw new LittleError('TOOL_FAILED', 'The notebook does not contain valid nbformat 4 cell source. No notebook content was returned.');
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function bounded(text: string, chars: number): string {
  let end = Math.max(0, chars);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}
function omitInlineImageData(source: string): string {
  return source.replace(/data:image\/[a-z0-9.+-]+(?:;[a-z0-9._=+-]+)*;base64,[a-z0-9+/=\n]+/gi,
    payload => payload.split('\n').map(() => '[IMAGE DATA OMITTED]').join('\n'));
}
export function notebookCellRange(range: NotebookRange): { startCell: number; endCell: number } {
  const startCell = range.startCell ?? 1;
  const endCell = range.endCell ?? (range.startLine !== undefined || range.endLine !== undefined ? startCell : Math.min(NOTEBOOK_LIMITS.maxCells, startCell + NOTEBOOK_LIMITS.maxRangeCells - 1));
  if (!Number.isSafeInteger(startCell) || !Number.isSafeInteger(endCell) || startCell < 1 || endCell < startCell ||
      endCell > NOTEBOOK_LIMITS.maxCells || endCell - startCell + 1 > NOTEBOOK_LIMITS.maxRangeCells) {
    throw new LittleError('TOOL_VALIDATION_FAILED', `Notebook ranges require one-based cell numbers and at most ${NOTEBOOK_LIMITS.maxRangeCells} ordered cells.`);
  }
  return { startCell, endCell };
}

/** Source extraction only. Cell numbers and source lines are distinct from serialized JSON lines. */
export function extractNotebookSource(json: string, path: string, range: NotebookRange = {}, signal?: AbortSignal): NotebookSource {
  assertNotAborted(signal);
  const requested = notebookCellRange(range);
  const startLine = range.startLine ?? 1;
  const requestedEndLine = range.endLine ?? Math.min(NOTEBOOK_LIMITS.maxSourceLines, startLine + NOTEBOOK_LIMITS.maxCellLines - 1);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(requestedEndLine) || startLine < 1 || requestedEndLine < startLine ||
      requestedEndLine > NOTEBOOK_LIMITS.maxSourceLines || requestedEndLine - startLine + 1 > NOTEBOOK_LIMITS.maxCellLines ||
      ((range.startLine !== undefined || range.endLine !== undefined) && requested.startCell !== requested.endCell)) {
    throw new LittleError('TOOL_VALIDATION_FAILED', 'Source line ranges select one notebook cell and at most 120 ordered source lines.');
  }
  if (Buffer.byteLength(json, 'utf8') > NOTEBOOK_LIMITS.maxFileBytes) throw new LittleError('CONTEXT_LIMIT', 'The notebook exceeds the bounded source inspection size.');
  let parsed: unknown;
  try { parsed = JSON.parse(json.replace(/^\uFEFF/, '')); } catch { invalid(); }
  const notebook = object(parsed);
  if (!notebook || notebook.nbformat !== 4 || !Number.isSafeInteger(notebook.nbformat_minor) || Number(notebook.nbformat_minor) < 0 || !Array.isArray(notebook.cells)) invalid();
  if (notebook.cells.length > NOTEBOOK_LIMITS.maxCells) throw new LittleError('CONTEXT_LIMIT', 'The notebook has too many cells for bounded source inspection.');
  const cells: { cell: number; type: 'code' | 'markdown'; offset: number; totalLines: number }[] = [];
  const sourceLines: string[] = [];
  let omittedCellTypes = 0;
  for (let index = 0; index < notebook.cells.length; index++) {
    assertNotAborted(signal);
    const cell = object(notebook.cells[index]);
    if (!cell || typeof cell.cell_type !== 'string') invalid();
    if (cell.cell_type !== 'code' && cell.cell_type !== 'markdown') { omittedCellTypes++; continue; }
    let source: string;
    if (typeof cell.source === 'string') source = cell.source;
    else if (Array.isArray(cell.source) && cell.source.every(part => typeof part === 'string')) source = cell.source.join('');
    else invalid();
    if (source.includes('\u0000')) invalid();
    const lines = omitInlineImageData(source.replace(/\r\n?/g, '\n')).split('\n');
    if (sourceLines.length + lines.length > NOTEBOOK_LIMITS.maxSourceLines) throw new LittleError('CONTEXT_LIMIT', 'The notebook has too many source lines for bounded inspection.');
    cells.push({ cell: index + 1, type: cell.cell_type, offset: sourceLines.length, totalLines: lines.length });
    for (const line of lines) sourceLines.push(line);
  }
  // Redact all source before choosing cells, so a range cannot expose the middle of a key block.
  const safeLines = redactSecrets(sourceLines.join('\n')).split('\n');
  const totalCells = notebook.cells.length;
  if (totalCells && requested.startCell > totalCells) throw new LittleError('TOOL_VALIDATION_FAILED', 'The requested starting cell is beyond this notebook.');
  const endCell = Math.min(requested.endCell, totalCells);
  const citations: NotebookCellCitation[] = [];
  const parts = [`Notebook source: ${redactSecrets(path)}\nCitations use original one-based cell numbers and lines within each cell. Outputs, attachments, execution information and metadata are omitted.\n`];
  let length = parts[0]!.length;
  let clipped = false;
  for (const cell of cells) {
    assertNotAborted(signal);
    if (cell.cell < requested.startCell || cell.cell > endCell) continue;
    if (startLine > cell.totalLines) throw new LittleError('TOOL_VALIDATION_FAILED', 'The requested source line is beyond this notebook cell.');
    const header = `\n${redactSecrets(path)}#cell-${cell.cell}:source-${startLine} (${cell.type}; ${cell.totalLines} source lines)\n`;
    if (length + header.length + 64 >= NOTEBOOK_LIMITS.maxOutputChars) { clipped = true; break; }
    const rendered: string[] = [];
    let cellChars = 0;
    let cellTruncated = startLine > 1 || requestedEndLine < cell.totalLines;
    let endLine = 0;
    for (let line = startLine - 1; line < Math.min(cell.totalLines, requestedEndLine); line++) {
      assertNotAborted(signal);
      const text = `${line + 1}| ${safeLines[cell.offset + line] ?? ''}\n`;
      const remaining = Math.min(NOTEBOOK_LIMITS.maxCellChars - cellChars, NOTEBOOK_LIMITS.maxOutputChars - length - header.length - cellChars - 48);
      if (remaining < 8) { cellTruncated = true; break; }
      const visible = bounded(text, remaining);
      rendered.push(visible); cellChars += visible.length; endLine = line + 1;
      if (visible.length !== text.length) { cellTruncated = true; break; }
    }
    if (cellTruncated) rendered.push('\n[Cell source shortened; omitted source is not evidence.]\n');
    const section = header + rendered.join('');
    parts.push(section); length += section.length;
    citations.push({ cell: cell.cell, type: cell.type, startLine, endLine, totalLines: cell.totalLines, truncated: cellTruncated });
    clipped ||= cellTruncated;
  }
  if (!citations.length) parts.push('\n[No code or markdown source was included in this cell range.]\n');
  assertNotAborted(signal);
  return { path, format: 'jupyter-notebook-v4', totalCells, startCell: requested.startCell, endCell, cells: citations,
    content: bounded(parts.join(''), NOTEBOOK_LIMITS.maxOutputChars), truncated: clipped || citations.length < cells.length,
    omittedCells: totalCells - citations.length, omittedCellTypes, outputsIncluded: false, metadataIncluded: false };
}

export async function readNotebookSource(workspace: NotebookWorkspaceReader, path: string, range: NotebookRange = {}, signal?: AbortSignal) {
  assertNotAborted(signal);
  notebookCellRange(range);
  const source = await workspace.readNotebookFile(path, signal);
  assertNotAborted(signal);
  if (source.truncated) throw new LittleError('CONTEXT_LIMIT', 'The notebook JSON was shortened before parsing. No notebook source was returned.');
  const extracted = extractNotebookSource(source.content, source.path, range, signal);
  return { ...extracted, bytesRead: source.bytesRead, totalBytes: source.totalBytes };
}
