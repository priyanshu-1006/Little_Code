import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from '../context/redact-secrets';
import type { AgentTool, ToolContext } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { assertNotAborted } from './workspace-service';
import { EDIT_PROPOSAL_LIMITS, type EditApplyResult, type EditProposal, type EditProposalService, type WorkspaceBinaryEdit } from './edit-proposals';
import { DOCUMENT_LIMITS, documentFormat, documentRange, validDocumentText, type DocumentExtraction, type DocumentRange } from './document-common';
import { createDocx, createPptx, extractOoxml, replaceOoxmlText } from './document-ooxml';
import { extractPdf, generatePdf } from './document-pdf';

export interface DocumentWorkspaceReader {
  readBinaryFile(path: string, signal?: AbortSignal, maxBytes?: number): Promise<{ path: string; bytes: Uint8Array; totalBytes: number }>;
}
export interface DocumentSource {
  path: string; format: 'docx' | 'pptx' | 'pdf'; content: string; truncated: boolean;
  bytesRead: number; totalBytes: number; totalUnits: number; start: number; end: number;
  citations: { unit: number; label: string; truncated: boolean }[]; note: string;
}
const pathSchema = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f]/.test(value));
const readSchema = z.object({ path: pathSchema, start: z.number().int().min(1).max(DOCUMENT_LIMITS.maxUnits).optional(),
  end: z.number().int().min(1).max(DOCUMENT_LIMITS.maxUnits).optional() }).strict();
const proposalSchema = z.object({ path: pathSchema, format: z.enum(['docx', 'pptx', 'pdf']),
  action: z.enum(['create', 'replace_text', 'append_text']), content: z.string().min(1).max(DOCUMENT_LIMITS.maxCreateChars).optional(),
  replacements: z.array(z.object({ search: z.string().min(1).max(8192), replacement: z.string().max(8192) }).strict()).min(1).max(DOCUMENT_LIMITS.maxReplacements).optional(),
}).strict();

function formatSource(extraction: DocumentExtraction, path: string, bytes: number, range: DocumentRange): DocumentSource {
  const selected = documentRange(range);
  if (extraction.totalUnits && selected.start > extraction.totalUnits) throw new LittleError('TOOL_VALIDATION_FAILED', 'The requested starting document unit is beyond this file.');
  const end = Math.min(selected.end, extraction.totalUnits);
  const label = extraction.format === 'docx' ? 'paragraph' : extraction.format === 'pptx' ? 'slide' : 'page';
  const citations: DocumentSource['citations'] = [];
  const parts = [`Document text: ${redactSecrets(path)} (${extraction.format}; ${extraction.totalUnits} ${label} units)\n${extraction.note}\n`];
  let used = parts[0]!.length, clipped = false;
  for (const section of extraction.sections) {
    if (section.unit < selected.start || section.unit > end) continue;
    const header = `\n${redactSecrets(path)}#${label}-${section.unit}\n`;
    const available = Math.min(DOCUMENT_LIMITS.maxUnitChars, DOCUMENT_LIMITS.maxOutputChars - used - header.length - 100);
    if (available <= 0) { clipped = true; break; }
    const safe = redactSecrets(section.text || '[No extractable text in this unit; images are excluded.]');
    const text = safe.slice(0, available), truncated = safe.length > text.length;
    const body = header + text + (truncated ? '\n[Unit text shortened; omitted text is not evidence.]' : '') + '\n';
    parts.push(body); used += body.length; clipped ||= truncated;
    citations.push({ unit: section.unit, label, truncated });
  }
  const truncated = clipped || selected.start > 1 || end < extraction.totalUnits || citations.length < Math.max(0, end - selected.start + 1);
  if (truncated) parts.push('\n[Document excerpt bounded. Use read_document with a later range for more text.]');
  return { path, format: extraction.format, content: parts.join('').slice(0, DOCUMENT_LIMITS.maxOutputChars), truncated,
    bytesRead: bytes, totalBytes: bytes, totalUnits: extraction.totalUnits, start: selected.start, end, citations, note: extraction.note };
}
function reviewExcerpt(text: string, limit: number): string {
  const safe = redactSecrets(text);
  const suffix = '\n[Review excerpt shortened; omitted text is not shown in this preview.]';
  return safe.length > limit ? safe.slice(0, Math.max(0, limit - suffix.length)) + suffix : safe;
}
export async function extractDocument(bytes: Uint8Array, path: string, range: DocumentRange = {}, signal?: AbortSignal): Promise<DocumentSource> {
  assertNotAborted(signal); documentRange(range);
  if (bytes.length > DOCUMENT_LIMITS.maxFileBytes) throw new LittleError('CONTEXT_LIMIT', 'The document exceeds the bounded 16 MiB inspection size.');
  const format = documentFormat(path);
  const extraction = format === 'pdf' ? await extractPdf(bytes, range, signal) : extractOoxml(bytes, format, signal);
  assertNotAborted(signal);
  return formatSource(extraction, path, bytes.length, range);
}
export async function readDocument(workspace: DocumentWorkspaceReader, path: string, range: DocumentRange = {}, signal?: AbortSignal): Promise<DocumentSource> {
  assertNotAborted(signal); documentFormat(path); documentRange(range);
  const current = await workspace.readBinaryFile(path, signal, DOCUMENT_LIMITS.maxFileBytes);
  assertNotAborted(signal);
  if (current.totalBytes !== current.bytes.length) throw new LittleError('CONTEXT_LIMIT', 'The document input was shortened before parsing. No document text was returned.');
  return extractDocument(current.bytes, current.path, range, signal);
}
export function createDocumentReadTools(workspace: DocumentWorkspaceReader): AgentTool[] {
  const validate = (input: unknown) => {
    const result = readSchema.safeParse(input);
    if (!result.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Document inspection needs a .docx/.pptx/.pdf path and at most 20 ordered paragraph, slide or page units.');
    documentFormat(result.data.path); return { path: result.data.path, ...documentRange(result.data) };
  };
  return [{ name: 'read_document', risk: 'SAFE', description: 'Read bounded text from a workspace DOCX, PPTX or PDF. Cite paragraph/slide/page numbers. start/end are one-based units, at most 20. Images, macros, external links and embedded files are not opened; legacy DOC/PPT, encrypted files and OCR are unsupported.',
    parameters: z.toJSONSchema(readSchema, { io: 'input' }) as Record<string, unknown>, validate,
    async execute(input, context) { const args = validate(input); return readDocument(workspace, args.path, args, context.signal); } }];
}

export function createDocumentEditTools(workspace: DocumentWorkspaceReader,
  service: Pick<EditProposalService, 'stageBinary' | 'discard'>,
  review: (proposal: EditProposal, context: ToolContext) => Promise<EditApplyResult | { status: 'rejected' }>,
  assertClean: (paths: readonly string[]) => void,
): AgentTool[] {
  const validate = (input: unknown) => {
    const result = proposalSchema.safeParse(input);
    if (!result.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Document proposals require a supported format/path, explicit action and bounded content or exact replacements.');
    const args = result.data;
    if (documentFormat(args.path) !== args.format) throw new LittleError('TOOL_VALIDATION_FAILED', 'The document format must match its filename extension.');
    if (args.action === 'replace_text' ? args.format === 'pdf' || !args.replacements || args.content !== undefined
      : !args.content || args.replacements !== undefined || (args.action === 'append_text' && args.format !== 'pdf')) {
      throw new LittleError('TOOL_VALIDATION_FAILED', 'create takes content; replace_text takes unique DOCX/PPTX replacements; append_text takes PDF content and adds pages. PDF in-place text replacement is unsupported.');
    }
    if (args.content) validDocumentText(args.content);
    return args;
  };
  return [{ name: 'propose_document', risk: 'WORKSPACE_WRITE',
    description: 'Review/checkpoint DOCX/PPTX/PDF creation or exact DOCX/PPTX text edits. create content: DOCX lines are paragraphs; PPTX uses --- between slides, first line title; PDF creates text pages. replace_text search must match once in one paragraph and preserves other OOXML parts. append_text adds PDF pages while preserving existing pages; it does not replace original layout/text. Changes require acceptance; deletion uses propose_file_edits with kind delete.',
    parameters: z.toJSONSchema(proposalSchema, { io: 'input' }) as Record<string, unknown>, validate,
    async execute(input, context) {
      assertNotAborted(context.signal);
      const args = validate(input); assertClean([args.path]);
      const original = args.action === 'create' ? undefined : await workspace.readBinaryFile(args.path, context.signal, DOCUMENT_LIMITS.maxFileBytes);
      const before = original ? await extractDocument(original.bytes, original.path, {}, context.signal) : undefined;
      const bytes = args.action === 'replace_text' ? replaceOoxmlText(original!.bytes, args.format as 'docx' | 'pptx', args.replacements!, context.signal)
        : args.format === 'docx' ? createDocx(args.content!) : args.format === 'pptx' ? createPptx(args.content!)
          : await generatePdf(args.content!, original?.bytes, context.signal);
      assertNotAborted(context.signal);
      const after = await extractDocument(bytes, args.path, {}, context.signal);
      const changes = args.replacements?.map((replacement, index) => `Unique text replacement ${index + 1}:\n- ${reviewExcerpt(replacement.search, 170)}\n+ ${reviewExcerpt(replacement.replacement, 170)}`).join('\n\n')
        ?? (args.action === 'append_text' ? `Appended text (new PDF pages):\n${reviewExcerpt(args.content!, 5000)}` : '');
      const limitation = args.action === 'append_text' ? 'APPEND REVIEW: New text pages are appended after existing PDF pages. Existing page content/layout is preserved; original text is not replaced.'
        : args.action === 'replace_text' ? 'TEXT EDIT REVIEW: Exact text changed inside existing OOXML runs. Other package parts are preserved; long replacements can affect Office text wrapping.'
          : 'CREATE REVIEW: A new document with simple text formatting is generated. This is an extracted text preview, not an Office/PDF layout rendering.';
      const edit: WorkspaceBinaryEdit = { kind: 'binary', path: args.path, operation: original ? 'replace' : 'create', content: bytes,
        expectedHash: original ? createHash('sha256').update(original.bytes).digest('hex') : null,
        preview: { original: before ? reviewExcerpt(`${limitation}\n\n${before.content}`, EDIT_PROPOSAL_LIMITS.maxReviewChars) : null,
          proposed: reviewExcerpt(`${limitation}\n\n${changes}\n\n${after.content}`, EDIT_PROPOSAL_LIMITS.maxReviewChars) } };
      const proposal = await service.stageBinary([edit], context.signal);
      try {
        const result = await review(proposal, context);
        return { status: result.status, path: args.path, format: args.format, action: args.action,
          ...('checkpointId' in result ? { checkpointId: result.checkpointId } : {}),
          ...('error' in result && result.error ? { error: result.error } : {}),
          note: limitation, verification: 'This result confirms the reviewed file operation. Extracted text previews do not establish rendered layout or external application checks.' };
      } finally { service.discard(proposal.id); }
    },
  }];
}
