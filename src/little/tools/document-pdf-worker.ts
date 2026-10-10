import { parentPort, workerData } from 'node:worker_threads';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import DOMMatrix from '@thednp/dommatrix';
import { redactSecrets } from '../context/redact-secrets';
import { DOCUMENT_LIMITS, documentRange, type DocumentExtraction, type DocumentRange } from './document-common';
import { generatePdfInWorker } from './document-pdf-generation';

interface PdfPage { streamTextContent(options: Record<string, unknown>): ReadableStream<{ items: unknown[] }>; cleanup(): void }
interface PdfDocument { numPages: number; getPage(index: number): Promise<PdfPage> }
interface PdfTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
interface PdfApi { GlobalWorkerOptions: { workerSrc: string }; getDocument(options: Record<string, unknown>): PdfTask }
interface ExtractInput { mode: 'extract'; bytes: Uint8Array; assetRoot: string; resourceRoot: string; range: DocumentRange }
interface GenerateInput { mode: 'generate'; content: string; bytes?: Uint8Array }
type WorkerInput = ExtractInput | GenerateInput;

async function extract(input: ExtractInput): Promise<DocumentExtraction> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length > DOCUMENT_LIMITS.maxFileBytes) throw new Error('bounded_input');
  const range = documentRange(input.range);
  if (!('DOMMatrix' in globalThis)) Object.defineProperty(globalThis, 'DOMMatrix', { value: DOMMatrix, configurable: true });
  const api = await import(pathToFileURL(path.join(input.assetRoot, 'pdf.mjs')).href) as PdfApi;
  api.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(input.assetRoot, 'pdf.worker.mjs')).href;
  // Only complete bytes and locally packaged assets are supplied. No URL, action,
  // annotation, rendering, embedded-file or JavaScript API is invoked.
  const task = api.getDocument({ data: input.bytes, verbosity: 0, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, useWorkerFetch: false, useWasm: false, enableXfa: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, disableWorkerRendering: true,
    disableAutoFetch: true, disableRange: true, disableStream: true, stopAtErrors: true,
    // PDF.js requires a literal trailing URL slash, including on Windows.
    // Its Node factories read these local paths directly; no remote URL exists.
    cMapUrl: path.join(input.resourceRoot, 'cmaps').replace(/\\/g, '/') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(input.resourceRoot, 'standard_fonts').replace(/\\/g, '/') + '/' });
  let document: PdfDocument | undefined;
  try {
    document = await task.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > DOCUMENT_LIMITS.maxPdfPages) throw new Error('bounded_pages');
    if (range.start > document.numPages) throw new Error('invalid_range');
    const pages: string[] = []; let items = 0, chars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let text = '';
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          for (const value of chunk.value.items) {
            if (++items > DOCUMENT_LIMITS.maxPdfItems) throw new Error('bounded_text');
            if (!value || typeof value !== 'object' || !('str' in value) || typeof value.str !== 'string') continue;
            text += value.str + ('hasEOL' in value && value.hasEOL === true ? '\n' : ' ');
            chars += value.str.length + 1;
            if (chars > DOCUMENT_LIMITS.maxSourceChars) throw new Error('bounded_text');
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); page.cleanup(); }
      pages.push(text.trim());
    }
    const offsets: { offset: number; lines: number }[] = []; const lines: string[] = [];
    for (const text of pages) { const split = text.split('\n'); offsets.push({ offset: lines.length, lines: split.length }); for (const line of split) lines.push(line); }
    const safe = redactSecrets(lines.join('\n')).split('\n');
    const sections = offsets.map((position, index) => ({ unit: index + 1, text: safe.slice(position.offset, position.offset + position.lines).join('\n') }))
      .filter(section => section.unit >= range.start && section.unit <= range.end);
    if (!sections.some(section => section.text.trim())) throw new Error('no_text');
    return { format: 'pdf', totalUnits: document.numPages, sections,
      note: 'Extracted PDF text in parser order. Images, annotations, embedded files and actions are excluded. Reading order and layout may differ from the rendered page; scanned PDFs require OCR, which is unavailable.' };
  } finally { await task.destroy().catch(() => {}); }
}

async function run(input: WorkerInput) {
  if (input.mode === 'extract') { parentPort!.postMessage({ ok: true, extraction: await extract(input) }); return; }
  if (input.mode !== 'generate') throw new Error('unsupported');
  const bytes = await generatePdfInWorker(input.content, input.bytes);
  const transferable = Uint8Array.from(bytes);
  parentPort!.postMessage({ ok: true, bytes: transferable }, [transferable.buffer]);
}
if (parentPort) void run(workerData as WorkerInput).catch(error => {
  // Fixed allowlisted reasons only: parser messages can contain document content.
  const reason = error instanceof Error && ['bounded_input', 'bounded_pages', 'bounded_text', 'invalid_range', 'no_text', 'unsupported_character'].includes(error.message) ? error.message : 'unsupported';
  parentPort!.postMessage({ ok: false, reason });
});
