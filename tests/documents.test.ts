import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { XMLValidator } from 'fast-xml-parser';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Worker } from 'node:worker_threads';
import { LittleError } from '../src/little/shared/errors';
import { DOCUMENT_LIMITS } from '../src/little/tools/document-common';
import { createDocx, createPptx, replaceOoxmlText } from '../src/little/tools/document-ooxml';
import { generatePdf, runPdfWorker } from '../src/little/tools/document-pdf';
import { createDocumentEditTools, createDocumentReadTools, extractDocument, readDocument } from '../src/little/tools/document-tools';
import { DocumentArchive, documentZip } from '../src/little/tools/document-zip';
import { EDIT_PROPOSAL_LIMITS, EditProposalService, type EditProposal } from '../src/little/tools/edit-proposals';
import { WorkspaceService } from '../src/little/tools/workspace-service';

const signal = () => new AbortController().signal;
const code = (expected: LittleError['code']) => (error: unknown) => error instanceof LittleError && error.code === expected;
async function fixture(t: TestContext, files: Record<string, Uint8Array | string> = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'little-documents-'));
  t.after(async () => { assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.ok(path.basename(base).startsWith('little-documents-')); await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'repo'), storage = path.join(base, 'private');
  await fs.mkdir(root); await fs.mkdir(storage);
  for (const [name, bytes] of Object.entries(files)) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
  const workspace = new WorkspaceService(root);
  return { root, storage, workspace, service: new EditProposalService(workspace, storage) };
}

test('DOCX creation produces valid XML and bounded redacted paragraph citations without metadata or embedded content', async () => {
  const key = 'gsk_abcdefghijklmnop012345';
  const bytes = createDocx(`# Course introduction\nUnicode: नमस्ते 世界\nAPI_KEY = "${key}"\nFourth paragraph`);
  const original = new DocumentArchive(bytes);
  const parts = original.preserve();
  parts['docProps/core.xml'] = Buffer.from('<private>PRIVATE_AUTHOR</private>');
  parts['word/media/image.png'] = Buffer.from('PRIVATE_IMAGE_DATA');
  parts['word/_rels/document.xml.rels'] = Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="hyperlink" TargetMode="External" Target="https://example.invalid/PRIVATE_EXTERNAL"/></Relationships>');
  const source = await extractDocument(documentZip(parts), 'report.docx', {}, signal());
  assert.equal(source.totalUnits, 4);
  assert.match(source.content, /report\.docx#paragraph-1\nCourse introduction/);
  assert.match(source.content, /नमस्ते 世界/);
  assert.match(source.content, /\[REDACTED\]/);
  assert.doesNotMatch(source.content, /PRIVATE_|gsk_|<w:|word\/document\.xml|https:\/\//);
  for (const name of original.names()) if (name.endsWith('.xml') || name.endsWith('.rels')) assert.equal(XMLValidator.validate(original.xml(name)), true);
});

test('PPTX creation includes theme/master/layout relationships and source follows actual slide order', async () => {
  const bytes = createPptx('First slide\nFirst evidence\n---\nSecond slide\nSecond evidence');
  const archive = new DocumentArchive(bytes);
  for (const name of ['ppt/theme/theme1.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/slides/_rels/slide1.xml.rels']) assert.ok(archive.has(name));
  for (const name of archive.names()) if (name.endsWith('.xml') || name.endsWith('.rels')) assert.equal(XMLValidator.validate(archive.xml(name)), true);
  const parts = archive.preserve();
  parts['ppt/presentation.xml'] = Buffer.from(archive.xml('ppt/presentation.xml').replace('<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/>', '<p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/>'));
  parts['ppt/notesSlides/notesSlide1.xml'] = Buffer.from('<private>PRIVATE_NOTES</private>');
  const source = await extractDocument(documentZip(parts), 'slides.pptx', { start: 1, end: 1 });
  assert.equal(source.totalUnits, 2);
  assert.match(source.content, /slides\.pptx#slide-1\nSecond slide\nSecond evidence/);
  assert.doesNotMatch(source.content, /First evidence|PRIVATE_NOTES|<a:|<p:/);
  assert.equal(source.truncated, true);
});

test('Office exact text edits span styled runs, preserve unrelated parts and reject ambiguous searches', async () => {
  const archive = new DocumentArchive(createDocx('hello world\nunchanged paragraph'));
  const parts = archive.preserve();
  parts['word/document.xml'] = Buffer.from(archive.xml('word/document.xml').replace('<w:t xml:space="preserve">hello world</w:t>', '<w:t xml:space="preserve">hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>world</w:t>'));
  const embedded = new Uint8Array([137, 80, 78, 71, 0, 1, 2]); parts['word/media/fixture.png'] = embedded;
  const changed = replaceOoxmlText(documentZip(parts), 'docx', [{ search: 'hello world', replacement: 'updated & precise' }]);
  const changedArchive = new DocumentArchive(changed);
  assert.deepEqual(Buffer.from(changedArchive.read('word/media/fixture.png')), Buffer.from(embedded));
  assert.match(changedArchive.xml('word/document.xml'), /<w:b\/>/);
  assert.equal(XMLValidator.validate(changedArchive.xml('word/document.xml')), true);
  const source = await extractDocument(changed, 'report.docx');
  assert.match(source.content, /updated & precise/); assert.match(source.content, /unchanged paragraph/);
  assert.throws(() => replaceOoxmlText(createDocx('same\nsame'), 'docx', [{ search: 'same', replacement: 'new' }]), code('TOOL_VALIDATION_FAILED'));
  assert.throws(() => replaceOoxmlText(createDocx('first\nsecond'), 'docx', [{ search: 'first\nsecond', replacement: 'new' }]), code('TOOL_VALIDATION_FAILED'));
  const deck = replaceOoxmlText(createPptx('Title\nUnique old phrase'), 'pptx', [{ search: 'Unique old phrase', replacement: 'Unique new phrase' }]);
  assert.match((await extractDocument(deck, 'deck.pptx')).content, /Unique new phrase/);
});

test('Office source excludes tag-looking XML comments and redacts private keys before paragraph selection', async () => {
  const archive = new DocumentArchive(createDocx('Before\n-----BEGIN PRIVATE KEY-----\nPRIVATE_BLOCK_SENTINEL\n-----END PRIVATE KEY-----\nAfter'));
  const parts = archive.preserve();
  parts['word/document.xml'] = Buffer.from(archive.xml('word/document.xml').replace('<w:body>', '<w:body><!--<w:p><w:r><w:t>PRIVATE_COMMENT_SENTINEL</w:t></w:r></w:p>-->'));
  const source = await extractDocument(documentZip(parts), 'safe.docx', { start: 3, end: 3 });
  assert.equal(source.totalUnits, 5); assert.match(source.content, /safe\.docx#paragraph-3\n\[REDACTED\]/);
  assert.doesNotMatch(source.content, /PRIVATE_COMMENT_SENTINEL|PRIVATE_BLOCK_SENTINEL/);
  const styled = new DocumentArchive(createDocx('Unchanged prefix Unique phrase Unchanged suffix'));
  const styledParts = styled.preserve();
  styledParts['word/document.xml'] = Buffer.from(styled.xml('word/document.xml').replace('<w:t xml:space="preserve">Unchanged prefix Unique phrase Unchanged suffix</w:t>', '<w:t>Unchanged prefix </w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="AA3322"/></w:rPr><w:t>Unique phrase</w:t></w:r><w:r><w:t> Unchanged suffix</w:t>'));
  const changed = new DocumentArchive(replaceOoxmlText(documentZip(styledParts), 'docx', [{ search: 'Unique phrase', replacement: 'Styled replacement' }]));
  assert.match(changed.xml('word/document.xml'), /<w:rPr><w:i\/><w:color w:val="AA3322"\/><\/w:rPr><w:t xml:space="preserve">Styled replacement<\/w:t>/);
  assert.match((await extractDocument(documentZip(changed.preserve()), 'styled.docx')).content, /Unchanged prefix Styled replacement Unchanged suffix/);
});

test('Office inspection excludes external slide relationships, macros, DTD/entities and unsafe archive paths', async () => {
  const valid = new DocumentArchive(createPptx('Title\nBody'));
  const external = valid.preserve();
  external['ppt/_rels/presentation.xml.rels'] = Buffer.from(valid.xml('ppt/_rels/presentation.xml.rels').replace('Target="slides/slide1.xml"', 'TargetMode="External" Target="https://example.invalid/PRIVATE_EXTERNAL"'));
  await assert.rejects(extractDocument(documentZip(external), 'bad.pptx'), error => { assert.ok(error instanceof LittleError); assert.doesNotMatch(error.message, /PRIVATE_EXTERNAL|https:/); return true; });
  const macros = new DocumentArchive(createDocx('safe')).preserve(); macros['word/vbaProject.bin'] = Buffer.from('PRIVATE_MACRO');
  await assert.rejects(extractDocument(documentZip(macros), 'macro.docx'), code('TOOL_FAILED'));
  const entities = new DocumentArchive(createDocx('safe')).preserve(); entities['word/document.xml'] = Buffer.from('<!DOCTYPE w:document [<!ENTITY private SYSTEM "file:///PRIVATE_FILE">]><w:document/>');
  await assert.rejects(extractDocument(documentZip(entities), 'entities.docx'), error => { assert.ok(error instanceof LittleError); assert.doesNotMatch(error.message, /PRIVATE_FILE/); return true; });
  assert.throws(() => documentZip({ '../outside': 'private' }), code('TOOL_FAILED'));
  await assert.rejects(extractDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'legacy.docx'), code('TOOL_FAILED'));
  await assert.rejects(extractDocument(createDocx('safe'), 'legacy.doc'), code('TOOL_VALIDATION_FAILED'));
});

test('ZIP sizes, checksums and bounded document ranges fail before forwarding malformed source', async () => {
  const bytes = Buffer.from(createDocx('small'));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const bomb = Buffer.from(bytes); bomb.writeUInt32LE(DOCUMENT_LIMITS.maxExpandedBytes + 1, central + 24);
  assert.throws(() => new DocumentArchive(bomb), code('CONTEXT_LIMIT'));
  const corrupt = Buffer.from(bytes); corrupt.writeUInt32LE(0, central + 16);
  await assert.rejects(extractDocument(corrupt, 'bad.docx'), code('TOOL_FAILED'));
  await assert.rejects(extractDocument(bytes, 'safe.docx', { start: 1, end: 21 }), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(extractDocument(bytes, 'safe.docx', { start: 2 }), code('TOOL_VALIDATION_FAILED'));
  const many = await extractDocument(createDocx(Array.from({ length: 25 }, (_, i) => `paragraph ${i + 1}`).join('\n')), 'many.docx');
  assert.equal(many.citations.length, 20); assert.equal(many.totalUnits, 25); assert.equal(many.truncated, true);
  const bounded = await extractDocument(createDocx('x'.repeat(30_000)), 'bounded.docx');
  assert.ok(bounded.content.length <= DOCUMENT_LIMITS.maxOutputChars); assert.equal(bounded.citations[0]?.truncated, true);
});

test('real PDF creation and appended pages extract through the isolated parser with page citations', async () => {
  const bytes = await generatePdf('First page evidence\nAPI_KEY = "gsk_abcdefghijklmnop012345"');
  const source = await extractDocument(bytes, 'report.pdf');
  assert.equal(source.totalUnits, 1); assert.match(source.content, /report\.pdf#page-1/); assert.match(source.content, /First page evidence/);
  assert.doesNotMatch(source.content, /gsk_|%PDF-|\/Type|stream\n/);
  const appended = await generatePdf('Appended page evidence', bytes);
  const existing = await extractDocument(appended, 'report.pdf', { start: 1, end: 1 });
  const added = await extractDocument(appended, 'report.pdf', { start: 2, end: 2 });
  assert.equal(added.totalUnits, 2); assert.match(existing.content, /First page evidence/); assert.match(added.content, /Appended page evidence/);
  assert.doesNotMatch(added.content, /First page evidence/);
});

test('PDF rejects scanned/corrupt files and unsupported generation characters with fixed safe messages', async () => {
  const blank = await PDFDocument.create(); blank.addPage();
  await assert.rejects(extractDocument(await blank.save(), 'scan.pdf'), error => { assert.ok(error instanceof LittleError); assert.match(error.message, /OCR/); return true; });
  await assert.rejects(extractDocument(Buffer.from('%PDF-1.7\nPRIVATE_INVALID_PDF'), 'bad.pdf'), error => { assert.ok(error instanceof LittleError); assert.doesNotMatch(error.message, /PRIVATE_INVALID_PDF/); return true; });
  await assert.rejects(generatePdf('Unsupported नमस्ते'), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(extractDocument(await generatePdf('safe'), 'safe.pdf', {}, AbortSignal.abort()), code('AGENT_CANCELLED'));
});

test('PDF processing deadlines and cancellation terminate real isolated read and write workers before settlement', async () => {
  for (const mode of ['extract', 'generate'] as const) {
    const job = mode === 'extract' ? { mode, bytes: Buffer.from('%PDF-1.7\nnot parsed'), range: {} } : { mode, content: 'bounded generation' };
    const cancellation = new AbortController(); let cancelledWorker!: Worker; let cancelledExit = false;
    await assert.rejects(runPdfWorker(job, cancellation.signal, { onWorkerStarted(worker) { cancelledWorker = worker; worker.once('exit', () => { cancelledExit = true; }); cancellation.abort(); } }), code('AGENT_CANCELLED'));
    assert.equal(cancelledWorker.threadId, -1); assert.equal(cancelledExit, true);
    let timedWorker!: Worker; let timedExit = false;
    await assert.rejects(runPdfWorker(job, signal(), { timeoutMs: 1, onWorkerStarted(worker) { timedWorker = worker; worker.once('exit', () => { timedExit = true; }); } }), error => { assert.ok(error instanceof LittleError); assert.equal(error.code, 'CONTEXT_LIMIT'); assert.match(error.message, /processing time/); return true; });
    assert.equal(timedWorker.threadId, -1); assert.equal(timedExit, true);
  }
});

function encryptedPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`,
  ];
  let value = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<${'12'.repeat(16)}> <${'12'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
test('isolated PDF append rejects malformed and password-encrypted original bytes without leaking parser details', async () => {
  for (const bytes of [Buffer.from('%PDF-1.7\nPRIVATE_INVALID_PDF'), encryptedPdf()]) {
    await assert.rejects(generatePdf('new page', bytes), error => { assert.ok(error instanceof LittleError); assert.equal(error.code, 'TOOL_FAILED'); assert.match(error.message, /corrupt, encrypted or unsupported/); assert.doesNotMatch(error.message, /PRIVATE_INVALID_PDF|Encrypt|stream|PasswordException|xref/); return true; });
    await assert.rejects(extractDocument(bytes, 'protected.pdf'), code('TOOL_FAILED'));
  }
});

test('protected document reads and generic read_file observe current ignore/sensitive/boundary policy', async t => {
  const f = await fixture(t, { 'safe.docx': createDocx('protected source'), 'ignored.pptx': createPptx('Protected\nIgnored evidence'), '.aws/sensitive.docx': createDocx('PRIVATE_SENSITIVE') });
  assert.match((await f.workspace.readFile('safe.docx', signal())).content, /protected source/);
  const tool = createDocumentReadTools(f.workspace)[0]!;
  assert.equal(tool.risk, 'SAFE'); assert.match(JSON.stringify(await tool.execute({ path: 'safe.docx' }, { signal: signal() })), /protected source/);
  await fs.writeFile(path.join(f.root, '.littleignore'), 'ignored.pptx\n');
  await assert.rejects(readDocument(f.workspace, 'ignored.pptx'), code('PERMISSION_DENIED'));
  await assert.rejects(readDocument(f.workspace, '.aws/sensitive.docx'), code('PERMISSION_DENIED'));
  await assert.rejects(readDocument(f.workspace, '../outside.docx'), code('WORKSPACE_BOUNDARY_VIOLATION'));
  await assert.rejects(readDocument({ async readBinaryFile() { return { path: 'partial.docx', bytes: new Uint8Array([1]), totalBytes: 100 }; } }, 'partial.docx'), code('CONTEXT_LIMIT'));
});

test('document creation waits for actual acceptance, receives a byte checkpoint and restores to absence', async t => {
  const f = await fixture(t); let pending!: EditProposal;
  const tool = createDocumentEditTools(f.workspace, f.service, async proposal => {
    pending = proposal;
    await assert.rejects(fs.access(path.join(f.root, 'new.docx')));
    const preview = f.service.preview(proposal.id)[0]!;
    assert.equal(preview.original, null); assert.match(preview.proposed, /CREATE REVIEW/); assert.match(preview.proposed, /Accepted document source/);
    return f.service.apply(f.service.accept(proposal.id));
  }, () => {})[0]!;
  const result = await tool.execute({ path: 'new.docx', format: 'docx', action: 'create', content: 'Accepted document source' }, { signal: signal() }) as { status: string; checkpointId: string };
  assert.equal(result.status, 'applied'); assert.match((await readDocument(f.workspace, 'new.docx')).content, /Accepted document source/);
  assert.throws(() => f.service.accept(pending.id), code('PERMISSION_DENIED'));
  const reopened = new EditProposalService(f.workspace, f.storage);
  assert.deepEqual((await reopened.rollback(result.checkpointId)).conflicts, []);
  await assert.rejects(fs.access(path.join(f.root, 'new.docx')));
});

test('document replacement is bound to parsed bytes and native acceptance, with original binary checkpoint recovery', async t => {
  const original = createPptx('Original title\nOriginal phrase');
  const f = await fixture(t, { 'deck.pptx': original });
  const tool = createDocumentEditTools(f.workspace, f.service, async proposal => {
    assert.equal(proposal.changes[0]?.beforeHash, createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(await fs.readFile(path.join(f.root, 'deck.pptx')), Buffer.from(original));
    assert.match(f.service.preview(proposal.id)[0]!.proposed, /Unique text replacement/);
    return f.service.apply(f.service.accept(proposal.id));
  }, () => {})[0]!;
  const result = await tool.execute({ path: 'deck.pptx', format: 'pptx', action: 'replace_text', replacements: [{ search: 'Original phrase', replacement: 'Updated phrase' }] }, { signal: signal() }) as { status: string; checkpointId: string };
  assert.equal(result.status, 'applied'); assert.match((await readDocument(f.workspace, 'deck.pptx')).content, /Updated phrase/);
  assert.deepEqual((await new EditProposalService(f.workspace, f.storage).rollback(result.checkpointId)).conflicts, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'deck.pptx')), Buffer.from(original));
});

test('real PDF creation and append wait for acceptance, disclose appended text beyond the preview range and restore original bytes', async t => {
  const originalDocument = await PDFDocument.create(), font = await originalDocument.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= 21; page++) originalDocument.addPage().drawText(`Original page ${page}`, { font });
  const original = await originalDocument.save(); const f = await fixture(t, { 'long.pdf': original });
  const tool = createDocumentEditTools(f.workspace, f.service, async proposal => {
    const preview = f.service.preview(proposal.id)[0]!;
    assert.ok(preview.proposed.length <= EDIT_PROPOSAL_LIMITS.maxReviewChars);
    if (proposal.changes[0]!.path === 'long.pdf') {
      assert.deepEqual(await fs.readFile(path.join(f.root, 'long.pdf')), Buffer.from(original));
      assert.match(preview.proposed, /APPEND REVIEW/); assert.match(preview.proposed, /Appended text \(new PDF pages\):\nUnique appended evidence/);
      assert.doesNotMatch(preview.proposed, /gsk_|%PDF-|\/Type/);
    } else { await assert.rejects(fs.access(path.join(f.root, 'created.pdf'))); assert.match(preview.proposed, /CREATE REVIEW/); }
    return f.service.apply(f.service.accept(proposal.id));
  }, () => {})[0]!;
  const created = await tool.execute({ path: 'created.pdf', format: 'pdf', action: 'create', content: 'Accepted PDF evidence' }, { signal: signal() }) as { status: string; checkpointId: string };
  assert.equal(created.status, 'applied'); assert.match((await readDocument(f.workspace, 'created.pdf')).content, /Accepted PDF evidence/);
  const appended = await tool.execute({ path: 'long.pdf', format: 'pdf', action: 'append_text', content: 'Unique appended evidence\nAPI_KEY = "gsk_abcdefghijklmnop012345"' }, { signal: signal() }) as { status: string; checkpointId: string };
  assert.equal(appended.status, 'applied'); const finalPage = await readDocument(f.workspace, 'long.pdf', { start: 22, end: 22 });
  assert.equal(finalPage.totalUnits, 22); assert.match(finalPage.content, /Unique appended evidence/); assert.doesNotMatch(finalPage.content, /gsk_/);
  const reopened = new EditProposalService(f.workspace, f.storage);
  assert.deepEqual((await reopened.rollback(appended.checkpointId)).conflicts, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'long.pdf')), Buffer.from(original));
  assert.deepEqual((await reopened.rollback(created.checkpointId)).conflicts, []); await assert.rejects(fs.access(path.join(f.root, 'created.pdf')));
});

test('document review binds originals to the reader snapshot and summarizes every out-of-range replacement', async t => {
  const source = createDocx(Array.from({ length: 25 }, (_, index) => `Original paragraph ${index + 1}`).join('\n'));
  const f = await fixture(t, { 'many.docx': source });
  const tool = createDocumentEditTools(f.workspace, f.service, async proposal => {
    assert.match(f.service.preview(proposal.id)[0]!.proposed, /Original paragraph 25[\s\S]*Out of range replacement/);
    return { status: 'rejected' };
  }, () => {})[0]!;
  await tool.execute({ path: 'many.docx', format: 'docx', action: 'replace_text', replacements: [{ search: 'Original paragraph 25', replacement: 'Out of range replacement' }] }, { signal: signal() });
  const staleReader = { async readBinaryFile() { const current = await f.workspace.readBinaryFile('many.docx'); await fs.writeFile(path.join(f.root, 'many.docx'), createDocx('Intervening user edit')); return current; } };
  const stale = createDocumentEditTools(staleReader, f.service, async () => { assert.fail('A changed snapshot must not reach review.'); }, () => {})[0]!;
  await assert.rejects(stale.execute({ path: 'many.docx', format: 'docx', action: 'replace_text', replacements: [{ search: 'Original paragraph 25', replacement: 'Stale replacement' }] }, { signal: signal() }), error => { assert.ok(error instanceof LittleError); assert.equal(error.code, 'TOOL_FAILED'); assert.match(error.message, /format input changed/); return true; });
  assert.match((await readDocument(f.workspace, 'many.docx')).content, /Intervening user edit/);
});

test('document rejection, dirty buffers, invalid format/actions and cancellation leave bytes untouched', async t => {
  const original = createDocx('Unchanged phrase'); const f = await fixture(t, { 'report.docx': original });
  let reviewed = 0;
  const tool = createDocumentEditTools(f.workspace, f.service, async () => { reviewed++; return { status: 'rejected' }; }, () => {})[0]!;
  const args = { path: 'report.docx', format: 'docx', action: 'replace_text', replacements: [{ search: 'Unchanged phrase', replacement: 'Changed phrase' }] };
  assert.equal((await tool.execute(args, { signal: signal() }) as { status: string }).status, 'rejected');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'report.docx')), Buffer.from(original)); assert.deepEqual(await fs.readdir(f.storage), []);
  const dirty = createDocumentEditTools(f.workspace, f.service, async () => { assert.fail('Dirty files must not reach review.'); }, () => { throw new LittleError('PERMISSION_DENIED', 'Save the buffer first.'); })[0]!;
  await assert.rejects(dirty.execute(args, { signal: signal() }), code('PERMISSION_DENIED'));
  for (const input of [{ path: 'bad.pdf', format: 'pdf', action: 'replace_text', replacements: [{ search: 'x', replacement: 'y' }] },
    { path: 'bad.docx', format: 'pptx', action: 'create', content: 'Wrong extension' },
    { path: 'bad.docx', format: 'docx', action: 'append_text', content: 'Unsupported append' },
    { path: 'bad.pdf', format: 'pdf', action: 'create', content: 'safe', rawBytes: 'forged' }]) assert.throws(() => tool.validate(input), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(tool.execute(args, { signal: AbortSignal.abort() }), code('AGENT_CANCELLED'));
  assert.equal(reviewed, 1); assert.deepEqual(await fs.readFile(path.join(f.root, 'report.docx')), Buffer.from(original));
});
