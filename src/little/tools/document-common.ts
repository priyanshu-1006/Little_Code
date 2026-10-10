import { LittleError } from '../shared/errors';

export const DOCUMENT_LIMITS = Object.freeze({ maxFileBytes: 16 * 1024 * 1024, maxExpandedBytes: 32 * 1024 * 1024,
  maxEntries: 2048, maxXmlBytes: 2 * 1024 * 1024, maxSourceChars: 1024 * 1024, maxUnits: 10_000,
  maxRangeUnits: 20, maxOutputChars: 12_000, maxUnitChars: 4000, maxCreateChars: 100_000,
  maxReplacements: 32, maxPdfPages: 256, maxPdfItems: 250_000, pdfTimeoutMs: 15_000 });
export type DocumentFormat = 'docx' | 'pptx' | 'pdf';
export interface DocumentRange { start?: number; end?: number }
export interface DocumentSection { unit: number; text: string }
export interface DocumentExtraction { format: DocumentFormat; totalUnits: number; sections: DocumentSection[]; note: string }
export function documentFailure(message = 'The document is corrupt, encrypted or uses an unsupported format. No document text was returned.'): never {
  throw new LittleError('TOOL_FAILED', message);
}
export function documentRange(range: DocumentRange = {}) {
  const start = range.start ?? 1;
  const end = range.end ?? Math.min(DOCUMENT_LIMITS.maxUnits, start + DOCUMENT_LIMITS.maxRangeUnits - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start ||
    end > DOCUMENT_LIMITS.maxUnits || end - start + 1 > DOCUMENT_LIMITS.maxRangeUnits) {
    throw new LittleError('TOOL_VALIDATION_FAILED', 'Document ranges require positive ordered paragraph, slide or page numbers, with at most 20 units.');
  }
  return { start, end };
}
export function documentFormat(path: string): DocumentFormat {
  const match = /\.(docx|pptx|pdf)$/i.exec(path);
  if (!match) throw new LittleError('TOOL_VALIDATION_FAILED', 'Supported document formats are .docx, .pptx and text-based .pdf. Legacy .doc/.ppt, macros and OCR are unsupported.');
  return match[1]!.toLowerCase() as DocumentFormat;
}
export function validDocumentText(value: string, limit: number = DOCUMENT_LIMITS.maxCreateChars): void {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
    Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new LittleError('TOOL_VALIDATION_FAILED', 'Document content must be bounded valid Unicode text without binary control characters.');
  }
}
