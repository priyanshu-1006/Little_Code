// This module is imported only by the bounded PDF worker. Parsing and rewriting
// untrusted PDF streams must never occur in the extension host.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { DOCUMENT_LIMITS, validDocumentText } from './document-common';

function wrapLine(line: string, font: PDFFont, size: number, width: number): string[] {
  const result: string[] = []; let current = '';
  for (const word of line.split(/\s+/)) {
    for (const character of word) { try { font.encodeText(character); } catch { throw new Error('unsupported_character'); } }
    if (font.widthOfTextAtSize(word, size) > width) {
      if (current) { result.push(current); current = ''; }
      let split = '';
      for (const character of word) { if (font.widthOfTextAtSize(split + character, size) > width) { result.push(split); split = ''; } split += character; }
      current = split;
    } else if (current && font.widthOfTextAtSize(`${current} ${word}`, size) > width) { result.push(current); current = word; }
    else current += `${current ? ' ' : ''}${word}`;
  }
  result.push(current); return result;
}

export async function generatePdfInWorker(content: string, original?: Uint8Array): Promise<Uint8Array> {
  validDocumentText(content);
  if (original && (!(original instanceof Uint8Array) || original.length > DOCUMENT_LIMITS.maxFileBytes)) throw new Error('bounded_input');
  const document = original ? await PDFDocument.load(original, { updateMetadata: false, throwOnInvalidObject: true }) : await PDFDocument.create();
  if (document.isEncrypted) throw new Error('unsupported');
  if (document.getPageCount() > DOCUMENT_LIMITS.maxPdfPages) throw new Error('bounded_pages');
  const font = await document.embedFont(StandardFonts.Helvetica);
  let page: PDFPage | undefined, y = 0;
  const newPage = () => {
    if (document.getPageCount() >= DOCUMENT_LIMITS.maxPdfPages) throw new Error('bounded_pages');
    page = document.addPage([595.28, 841.89]); y = 785;
  };
  newPage();
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    for (const text of wrapLine(line, font, 11, 485)) {
      if (y < 56) newPage();
      page!.drawText(text, { x: 55, y, size: 11, font, color: rgb(0.14, 0.18, 0.29) }); y -= 16;
    }
    y -= 4;
  }
  const result = await document.save({ useObjectStreams: true });
  if (result.length > DOCUMENT_LIMITS.maxFileBytes) throw new Error('bounded_input');
  return result;
}
