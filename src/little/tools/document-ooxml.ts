import * as path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { redactSecrets } from '../context/redact-secrets';
import { LittleError } from '../shared/errors';
import { assertNotAborted } from './workspace-service';
import { DOCUMENT_LIMITS, documentFailure, validDocumentText, type DocumentExtraction } from './document-common';
import { DocumentArchive, documentZip } from './document-zip';

const WORD = ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'];
const DRAWING = ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'];
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
interface TextRun { start: number; end: number; prefix: string; attributes: string; text: string; offset: number }
interface Paragraph { start: number; end: number; text: string; runs: TextRun[] }
interface TextPart { name: string; xml: string; paragraphs: Paragraph[] }
export interface DocumentReplacement { search: string; replacement: string }

export function escapeDocumentXml(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function decodeXml(text: string): string {
  if (text.includes('<')) documentFailure('Unsupported mixed XML text in the document.');
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(known, entity)) return known[entity]!;
    const value = /^#x[0-9a-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(value) || value < 1 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) documentFailure();
    return String.fromCodePoint(value);
  });
}
function checkedXml(xml: string): string {
  if (Buffer.byteLength(xml, 'utf8') > DOCUMENT_LIMITS.maxXmlBytes || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) documentFailure('The document contains unsupported XML declarations or exceeds the XML inspection limit.');
  let depth = 0, count = 0;
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\/?>/g)) {
    if (++count > 100_000) throw new LittleError('CONTEXT_LIMIT', 'The document XML has too many elements.');
    if (match[0].startsWith('</')) depth--;
    else if (!match[0].endsWith('/>') && ++depth > 64) documentFailure('The document XML nesting exceeds the safe inspection limit.');
  }
  if (depth !== 0 || XMLValidator.validate(xml) !== true) documentFailure('The document contains invalid XML. No source was returned.');
  return xml;
}
function namespacePrefix(xml: string, namespaces: readonly string[]): string {
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\bxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(["'])(.*?)\2/g)) {
    if (namespaces.includes(match[3]!)) return match[1] ? `${match[1]}:` : '';
  }
  documentFailure('The document does not declare a supported OOXML text namespace.');
}
function paragraphs(xml: string, prefix: string): Paragraph[] {
  const result: Paragraph[] = [];
  const tag = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paragraphPattern = new RegExp(`<${tag}p(?:\\s[^>]*?)?>([\\s\\S]*?)<\\/${tag}p>`, 'g');
  // Comments are not document text. Keep the same offsets for exact edits while
  // preventing tag-looking comment contents from becoming source paragraphs.
  const visibleXml = xml.replace(/<!--[\s\S]*?-->/g, comment => ' '.repeat(comment.length));
  for (const paragraph of visibleXml.matchAll(paragraphPattern)) {
    if (result.length >= DOCUMENT_LIMITS.maxUnits) throw new LittleError('CONTEXT_LIMIT', 'The document has too many paragraphs.');
    const runs: TextRun[] = []; let text = '';
    const body = paragraph[0];
    const tokenPattern = new RegExp(`<${tag}t(\\s[^>]*?)?>([\\s\\S]*?)<\\/${tag}t>|<${tag}(?:tab|br|cr)(?:\\s[^>]*?)?\\/>`, 'g');
    for (const token of body.matchAll(tokenPattern)) {
      if (token[2] === undefined) { text += /(?:br|cr)\b/.test(token[0]) ? '\n' : '\t'; continue; }
      const decoded = decodeXml(token[2]);
      const start = paragraph.index! + token.index!;
      runs.push({ start, end: start + token[0].length, prefix, attributes: token[1] ?? '', text: decoded, offset: text.length });
      text += decoded;
    }
    result.push({ start: paragraph.index!, end: paragraph.index! + body.length, text, runs });
  }
  return result;
}
function records(xml: string, localName: string): Record<string, unknown>[] {
  const parsed: unknown = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false }).parse(checkedXml(xml));
  const result: Record<string, unknown>[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (depth > 64) documentFailure();
    if (Array.isArray(node)) { for (const value of node) walk(value, depth + 1); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('@_') && key.split(':').at(-1) === localName) {
        for (const item of Array.isArray(value) ? value : [value]) if (item && typeof item === 'object' && !Array.isArray(item)) result.push(item as Record<string, unknown>);
      }
      if (!key.startsWith('@_')) walk(value, depth + 1);
    }
  };
  walk(parsed); return result;
}
function supportedContent(archive: DocumentArchive, format: 'docx' | 'pptx') {
  const xml = checkedXml(archive.xml('[Content_Types].xml'));
  if (/macroEnabled|vbaProject|activeX/i.test(xml) || !(format === 'docx' ? /wordprocessingml\.document\.main\+xml/ : /presentationml\.presentation\.main\+xml/).test(xml)) documentFailure('The package is not a supported macro-free Word or PowerPoint document.');
}
function textParts(archive: DocumentArchive, format: 'docx' | 'pptx'): TextPart[] {
  supportedContent(archive, format);
  if (format === 'docx') {
    const xml = checkedXml(archive.xml('word/document.xml'));
    return [{ name: 'word/document.xml', xml, paragraphs: paragraphs(xml, namespacePrefix(xml, WORD)) }];
  }
  const presentation = checkedXml(archive.xml('ppt/presentation.xml'));
  const relationships = records(archive.xml('ppt/_rels/presentation.xml.rels'), 'Relationship');
  const relations = new Map<string, Record<string, unknown>>();
  for (const relationship of relationships) {
    const id = relationship['@_Id'];
    if (typeof id !== 'string' || relations.has(id)) documentFailure();
    relations.set(id, relationship);
  }
  const result: TextPart[] = [];
  for (const slide of records(presentation, 'sldId')) {
    const id = Object.entries(slide).find(([key]) => /^@_(?:[\w.-]+:)?id$/.test(key) && key !== '@_id')?.[1];
    const relationship = typeof id === 'string' ? relations.get(id) : undefined;
    if (!relationship || relationship['@_TargetMode'] === 'External' || typeof relationship['@_Target'] !== 'string' ||
      !String(relationship['@_Type']).endsWith('/slide')) documentFailure('The presentation slide relationship is missing or external.');
    const name = path.posix.normalize(path.posix.join('ppt', relationship['@_Target']));
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(name)) documentFailure('Unsupported presentation slide relationship.');
    const xml = checkedXml(archive.xml(name));
    result.push({ name, xml, paragraphs: paragraphs(xml, namespacePrefix(xml, DRAWING)) });
  }
  if (result.length > DOCUMENT_LIMITS.maxUnits) throw new LittleError('CONTEXT_LIMIT', 'The presentation has too many slides.');
  return result;
}
export function extractOoxml(bytes: Uint8Array, format: 'docx' | 'pptx', signal?: AbortSignal): DocumentExtraction {
  const archive = new DocumentArchive(bytes, signal);
  const parts = textParts(archive, format);
  const texts = format === 'docx' ? parts[0]!.paragraphs.map(paragraph => paragraph.text) : parts.map(part => part.paragraphs.map(paragraph => paragraph.text).join('\n'));
  if (texts.reduce((size, text) => size + text.length + 1, 0) > DOCUMENT_LIMITS.maxSourceChars) throw new LittleError('CONTEXT_LIMIT', 'The document source text exceeds the inspection limit.');
  // Redact across paragraph/slide boundaries before any source range is selected.
  const starts: { offset: number; count: number }[] = []; const lines: string[] = [];
  for (const text of texts) { const split = text.split('\n'); starts.push({ offset: lines.length, count: split.length }); for (const line of split) lines.push(line); }
  const safe = redactSecrets(lines.join('\n')).split('\n');
  assertNotAborted(signal);
  return { format, totalUnits: texts.length, sections: starts.map((position, index) => ({ unit: index + 1, text: safe.slice(position.offset, position.offset + position.count).join('\n') })),
    note: format === 'docx' ? 'Main document paragraph order, including table paragraphs. Headers, comments, embedded objects and images are excluded; layout is not inferred.'
      : 'Slide order follows presentation relationships. Text paragraphs follow OOXML order; speaker notes, images, embedded objects and visual reading order are excluded.' };
}
export function replaceOoxmlText(bytes: Uint8Array, format: 'docx' | 'pptx', replacements: readonly DocumentReplacement[], signal?: AbortSignal): Uint8Array {
  const archive = new DocumentArchive(bytes, signal), files = archive.preserve();
  const parts = textParts(archive, format);
  for (const replacement of replacements) {
    assertNotAborted(signal);
    validDocumentText(replacement.search, 8192); validDocumentText(replacement.replacement, 8192);
    if (!replacement.search || replacement.search === replacement.replacement || /[\n\r\t]/.test(replacement.search + replacement.replacement)) throw new LittleError('TOOL_VALIDATION_FAILED', 'Document text edits require a nonempty changed literal without paragraph, tab or line-break restructuring.');
    const matches: { part: TextPart; paragraph: Paragraph; position: number }[] = [];
    for (const part of parts) for (const paragraph of part.paragraphs) {
      for (let position = paragraph.text.indexOf(replacement.search); position >= 0; position = paragraph.text.indexOf(replacement.search, position + 1)) {
        if (matches.length) throw new LittleError('TOOL_VALIDATION_FAILED', 'Each document search must match exactly once within one paragraph. Re-read the document and choose a unique literal.');
        matches.push({ part, paragraph, position });
      }
    }
    if (matches.length !== 1) throw new LittleError('TOOL_VALIDATION_FAILED', 'Each document search must match exactly once within one paragraph. Re-read the document and choose a unique literal.');
    const { part, paragraph, position } = matches[0]!; const end = position + replacement.search.length;
    const changes: { start: number; end: number; xml: string }[] = []; let inserted = false;
    for (const run of paragraph.runs) {
      const runEnd = run.offset + run.text.length;
      if (runEnd <= position || run.offset >= end) continue;
      const from = Math.max(0, position - run.offset), to = Math.min(run.text.length, end - run.offset);
      const text = run.text.slice(0, from) + (inserted ? '' : replacement.replacement) + run.text.slice(to);
      inserted = true;
      const attributes = /\bxml:space\s*=/.test(run.attributes) ? run.attributes.replace(/\bxml:space\s*=\s*(["']).*?\1/, 'xml:space="preserve"') : `${run.attributes} xml:space="preserve"`;
      changes.push({ start: run.start, end: run.end, xml: `<${run.prefix}t${attributes}>${escapeDocumentXml(text)}</${run.prefix}t>` });
    }
    if (!inserted) documentFailure('The requested text crosses an unsupported document structure.');
    for (const change of changes.sort((a, b) => b.start - a.start)) part.xml = part.xml.slice(0, change.start) + change.xml + part.xml.slice(change.end);
    files[part.name] = Buffer.from(part.xml, 'utf8');
    part.paragraphs = paragraphs(checkedXml(part.xml), namespacePrefix(part.xml, format === 'docx' ? WORD : DRAWING));
  }
  assertNotAborted(signal); return documentZip(files);
}

export function createDocx(content: string): Uint8Array {
  validDocumentText(content);
  const paragraphs = content.replace(/\r\n?/g, '\n').split('\n');
  if (paragraphs.length > DOCUMENT_LIMITS.maxUnits) throw new LittleError('CONTEXT_LIMIT', 'Too many document paragraphs.');
  const body = paragraphs.map(line => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const text = heading?.[2] ?? line;
    const formatting = heading ? `<w:rPr><w:b/><w:color w:val="5538A4"/><w:sz w:val="${heading[1]!.length === 1 ? 36 : 28}"/></w:rPr>` : '<w:rPr><w:sz w:val="22"/></w:rPr>';
    return `<w:p><w:pPr><w:spacing w:after="140"/></w:pPr><w:r>${formatting}<w:t xml:space="preserve">${escapeDocumentXml(text)}</w:t></w:r></w:p>`;
  }).join('');
  return documentZip({
    '[Content_Types].xml': `${declaration}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${declaration}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${declaration}<w:document xmlns:w="${WORD[0]}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  });
}

function slideParagraph(text: string, size: number, colour = '24304D') { return `<a:p><a:r><a:rPr lang="en-US" sz="${size}"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></a:rPr><a:t>${escapeDocumentXml(text)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${size}"/></a:p>`; }
function textShape(id: number, text: string[], title: boolean) {
  const body = (text.length ? text : ['']).map(line => slideParagraph(line, title ? 3200 : 2100, title ? '5538A4' : '24304D')).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${title ? 'Title' : 'Content'}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="700000" y="${title ? 500000 : 1500000}"/><a:ext cx="10800000" cy="${title ? 800000 : 4800000}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
export function createPptx(content: string): Uint8Array {
  validDocumentText(content);
  const slides = content.replace(/\r\n?/g, '\n').split(/^\s*---\s*$/m).map(text => text.trim().split('\n'));
  if (slides.length > 40 || slides.some(lines => lines.length > 16 || lines.some(line => line.length > 180))) throw new LittleError('TOOL_VALIDATION_FAILED', 'Presentation content allows at most 40 slides separated by ---; each slide has a title and up to 15 short body lines (180 characters each).');
  const parts: Record<string, string> = {
    '_rels/.rels': `${declaration}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${declaration}<p:presentation xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING[0]}" xmlns:r="${REL}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `${declaration}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdMaster" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
    'ppt/slideMasters/slideMaster1.xml': `${declaration}<p:sldMaster xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING[0]}" xmlns:r="${REL}"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `${declaration}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdLayout" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdTheme" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `${declaration}<p:sldLayout xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING[0]}" xmlns:r="${REL}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `${declaration}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdMaster" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': `${declaration}<a:theme xmlns:a="${DRAWING[0]}" name="Little Paper"><a:themeElements><a:clrScheme name="Little">${[['dk1', '24304D'], ['lt1', 'FFFFFF'], ['dk2', '384562'], ['lt2', 'F4F1FA'], ['accent1', '5538A4'], ['accent2', '1886A5'], ['accent3', 'DC5976'], ['accent4', '76A379'], ['accent5', 'BE8C40'], ['accent6', '7278BD'], ['hlink', '5538A4'], ['folHlink', '854C90']].map(([name, colour]) => `<a:${name}><a:srgbClr val="${colour}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="Little"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Little"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${'<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>'.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  };
  for (const [index, lines] of slides.entries()) {
    parts[`ppt/slides/slide${index + 1}.xml`] = `${declaration}<p:sld xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING[0]}" xmlns:r="${REL}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FAF9FC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${textShape(2, [lines[0] ?? ''], true)}${textShape(3, lines.slice(1), false)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = `${declaration}<Relationships xmlns="${PKG_REL}"><Relationship Id="rIdLayout" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  }
  parts['[Content_Types].xml'] = `${declaration}<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[['ppt/presentation.xml', 'presentation'], ['ppt/slideMasters/slideMaster1.xml', 'slideMaster'], ['ppt/slideLayouts/slideLayout1.xml', 'slideLayout'], ...slides.map((_, index) => [`ppt/slides/slide${index + 1}.xml`, 'slide'])].map(([name, type]) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}${type === 'presentation' ? '.main' : ''}+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`;
  return documentZip(parts);
}
