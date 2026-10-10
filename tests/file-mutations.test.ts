import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EditProposalService, EDIT_PROPOSAL_LIMITS, type WorkspaceBinaryEdit } from '../src/little/tools/edit-proposals';
import { createEditTools } from '../src/little/tools/edit-tools';
import { LittleError } from '../src/little/shared/errors';
import { WorkspaceService } from '../src/little/tools/workspace-service';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof LittleError && error.code === expected;
async function fixture(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'little-file-mutations-'));
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('little-file-mutations-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'workspace'), storage = path.join(base, 'private');
  await fs.mkdir(root); await fs.mkdir(storage);
  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), bytes);
  }
  const workspace = new WorkspaceService(root);
  return { root, storage, workspace, service: new EditProposalService(workspace, storage) };
}
function binary(file: string, before: Buffer | null, after: Uint8Array): WorkspaceBinaryEdit {
  return { kind: 'binary', path: file, operation: before === null ? 'create' : 'replace', content: after, expectedHash: before === null ? null : hash(before),
    preview: { original: before === null ? null : 'Original source-derived document summary.', proposed: 'Proposed document summary.' } };
}

test('reviewed text, empty, and binary deletion restores exact bytes after reopening', async t => {
  const originals = { 'app.ts': Buffer.from('\uFEFFbefore\r\n'), 'empty.txt': Buffer.alloc(0), 'image.bin': Buffer.from([0xff, 0, 0xfe, 1]) };
  const f = await fixture(t, originals);
  const proposal = await f.service.stage(Object.keys(originals).map(file => ({ kind: 'delete', path: file })));
  assert.deepEqual(await fs.readdir(f.storage), []);
  assert.equal(proposal.changes.every(change => change.kind === 'delete' && change.afterHash === null && change.afterBytes === 0), true);
  assert.match(proposal.changes[0]!.diff, /\+\+\+ \/dev\/null/);
  assert.equal(f.service.preview(proposal.id)[0]!.proposed, '');
  assert.match(f.service.preview(proposal.id)[2]!.original!, /SHA-256:/);
  assert.match(f.service.preview(proposal.id)[2]!.proposed, /DELETE image.bin/);
  for (const [file, bytes] of Object.entries(originals)) assert.deepEqual(await fs.readFile(path.join(f.root, file)), bytes);
  await assert.rejects(f.service.apply({ proposalId: proposal.id, accepted: true }), code('PERMISSION_DENIED'));
  const applied = await f.service.apply(f.service.accept(proposal.id));
  assert.equal(applied.status, 'applied');
  for (const [index, file] of Object.keys(originals).entries()) {
    await assert.rejects(fs.stat(path.join(f.root, file)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(f.storage, applied.checkpointId, `original-${index}`)), originals[file as keyof typeof originals]);
  }
  const reopened = new EditProposalService(f.workspace, f.storage);
  assert.deepEqual((await reopened.listCheckpoints())[0]?.paths, Object.keys(originals));
  assert.deepEqual(await reopened.rollback(applied.checkpointId), { restored: Object.keys(originals).reverse(), conflicts: [] });
  for (const [file, bytes] of Object.entries(originals)) assert.deepEqual(await fs.readFile(path.join(f.root, file)), bytes);
  assert.deepEqual(await reopened.rollback(applied.checkpointId), { restored: [], conflicts: [] });
});

test('deletion rejection and cancellation write no checkpoint or workspace bytes', async t => {
  const f = await fixture(t, { 'app.ts': 'keep' });
  const tools = createEditTools(f.service, async () => ({ status: 'rejected' }), () => {});
  const edits = { edits: [{ kind: 'delete', path: 'app.ts' }] };
  assert.throws(() => tools[0]!.validate({ edits: [{ ...edits.edits[0], content: 'unexpected' }] }), code('TOOL_VALIDATION_FAILED'));
  const result = await tools[0]!.execute(edits, { signal: new AbortController().signal });
  assert.equal((result as { status: string }).status, 'rejected');
  const controller = new AbortController();
  const staged = await f.service.stage(edits.edits as [{ kind: 'delete'; path: string }], controller.signal);
  controller.abort();
  assert.throws(() => f.service.accept(staged.id), code('PERMISSION_DENIED'));
  assert.equal(await fs.readFile(path.join(f.root, 'app.ts'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(f.storage), []);
});

test('the generic deletion tool waits for host review before removing a regular file', async t => {
  const f = await fixture(t, { 'app.ts': 'original' });
  let cleaned = false, reviewed = false;
  const tool = createEditTools(f.service, async proposal => {
    reviewed = true;
    assert.equal(cleaned, true);
    assert.equal(await fs.readFile(path.join(f.root, 'app.ts'), 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(f.storage), []);
    return f.service.apply(f.service.accept(proposal.id));
  }, paths => { assert.deepEqual(paths, ['app.ts']); cleaned = true; })[0]!;
  assert.equal(tool.risk, 'WORKSPACE_WRITE');
  const result = await tool.execute({ edits: [{ kind: 'delete', path: 'app.ts' }] }, { signal: new AbortController().signal }) as { status: string; files: { kind: string }[] };
  assert.equal(reviewed, true);
  assert.equal(result.status, 'applied');
  assert.equal(result.files[0]!.kind, 'delete');
  await assert.rejects(fs.stat(path.join(f.root, 'app.ts')), { code: 'ENOENT' });
  assert.equal((await f.service.listCheckpoints()).length, 1);
});

test('mixed create, replace and delete proposals share one reversible checkpoint', async t => {
  const f = await fixture(t, { 'edit.ts': 'before', 'delete.ts': 'remove' });
  const proposal = await f.service.stage([{ kind: 'create', path: 'new.ts', content: 'created' }, { kind: 'replace', path: 'edit.ts', replacements: [{ search: 'before', replacement: 'after' }] }, { kind: 'delete', path: 'delete.ts' }]);
  const applied = await f.service.apply(f.service.accept(proposal.id));
  assert.equal(applied.status, 'applied');
  assert.equal(await fs.readFile(path.join(f.root, 'new.ts'), 'utf8'), 'created');
  assert.equal(await fs.readFile(path.join(f.root, 'edit.ts'), 'utf8'), 'after');
  await assert.rejects(fs.stat(path.join(f.root, 'delete.ts')), { code: 'ENOENT' });
  assert.deepEqual(await f.service.rollback(applied.checkpointId), { restored: ['delete.ts', 'edit.ts', 'new.ts'], conflicts: [] });
  assert.equal(await fs.readFile(path.join(f.root, 'edit.ts'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(f.root, 'delete.ts'), 'utf8'), 'remove');
  await assert.rejects(fs.stat(path.join(f.root, 'new.ts')), { code: 'ENOENT' });
});

test('a later recreated deletion target and fresh ignore policy preserve conflicts', async t => {
  const f = await fixture(t, { 'app.ts': 'original' });
  const proposal = await f.service.stage([{ kind: 'delete', path: 'app.ts' }]);
  const applied = await f.service.apply(f.service.accept(proposal.id));
  await fs.writeFile(path.join(f.root, 'app.ts'), 'user created this later');
  let recovery = await f.service.rollback(applied.checkpointId);
  assert.equal(recovery.conflicts.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'app.ts'), 'utf8'), 'user created this later');
  await fs.unlink(path.join(f.root, 'app.ts'));
  await fs.writeFile(path.join(f.root, '.littleignore'), 'app.ts\n');
  recovery = await f.service.rollback(applied.checkpointId);
  assert.equal(recovery.conflicts.length, 1);
  await assert.rejects(fs.stat(path.join(f.root, 'app.ts')), { code: 'ENOENT' });
  await fs.unlink(path.join(f.root, '.littleignore'));
  assert.deepEqual(await f.service.rollback(applied.checkpointId), { restored: ['app.ts'], conflicts: [] });
  assert.equal(await fs.readFile(path.join(f.root, 'app.ts'), 'utf8'), 'original');
});

test('deletion rejects missing paths, directories, protected paths, ignore rules and hard links', async t => {
  const f = await fixture(t, { 'safe.ts': 'safe', '.env': 'secret', 'ignored.ts': 'hidden', '.littleignore': 'ignored.ts\n' });
  await fs.mkdir(path.join(f.root, 'directory'));
  await fs.link(path.join(f.root, 'safe.ts'), path.join(f.root, 'alias.ts'));
  for (const file of ['missing.ts', 'directory', '.env', '.littleignore', 'ignored.ts', 'safe.ts', '../escape.ts']) {
    await assert.rejects(f.service.stage([{ kind: 'delete', path: file }]), (error: unknown) => error instanceof LittleError);
  }
  assert.equal(await fs.readFile(path.join(f.root, 'safe.ts'), 'utf8'), 'safe');
  assert.deepEqual(await fs.readdir(f.storage), []);
});

test('format proposals copy bytes before staging, bind source hashes and restore byte-exact originals', async t => {
  const original = Buffer.from([0xff, 0xfe, 0, 2, 3]), desired = Buffer.from([1, 0, 0xfe, 4]);
  const f = await fixture(t, { 'doc.docx': original });
  const edit = binary('doc.docx', original, desired);
  const pending = f.service.stageBinary([edit]);
  desired.fill(9); edit.preview.proposed = 'Caller mutated the source object.';
  const proposal = await pending;
  assert.equal(await fs.readFile(path.join(f.root, 'doc.docx')).then(value => value.equals(original)), true);
  assert.equal(proposal.changes[0]!.afterHash, hash(Buffer.from([1, 0, 0xfe, 4])));
  assert.equal(f.service.preview(proposal.id)[0]!.proposed.includes('Caller mutated'), false);
  assert.match(f.service.preview(proposal.id)[0]!.original!, /SHA-256:/);
  const applied = await f.service.apply(f.service.accept(proposal.id));
  assert.equal(applied.status, 'applied');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'doc.docx')), Buffer.from([1, 0, 0xfe, 4]));
  assert.deepEqual(await new EditProposalService(f.workspace, f.storage).rollback(applied.checkpointId), { restored: ['doc.docx'], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(f.root, 'doc.docx')), original);
});

test('format input hashing rejects stale parsed bytes and apply preserves a replaced inode', async t => {
  const original = Buffer.from([0, 2, 3]), after = Buffer.from([0, 4]);
  const f = await fixture(t, { 'slides.pptx': original });
  await assert.rejects(f.service.stageBinary([binary('slides.pptx', Buffer.from('stale'), after)]), code('TOOL_FAILED'));
  const proposal = await f.service.stageBinary([binary('slides.pptx', original, after)]);
  await fs.rename(path.join(f.root, 'slides.pptx'), path.join(f.root, 'original-moved.pptx'));
  await fs.writeFile(path.join(f.root, 'slides.pptx'), original);
  await assert.rejects(f.service.apply(f.service.accept(proposal.id)), code('TOOL_FAILED'));
  assert.deepEqual(await fs.readFile(path.join(f.root, 'slides.pptx')), original);
  assert.deepEqual(await fs.readdir(f.storage), []);
});

test('format edits and deletions above the ordinary text budget recover complete bytes', async t => {
  const original = Buffer.alloc(512 * 1024 + 17, 0xfe), after = Buffer.alloc(512 * 1024 + 19, 0xfa);
  const f = await fixture(t, { 'large.docx': original, 'large-delete.bin': original });
  const proposal = await f.service.stageBinary([binary('large.docx', original, after)]);
  const applied = await f.service.apply(f.service.accept(proposal.id));
  assert.equal(applied.status, 'applied');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'large.docx')), after);
  assert.deepEqual((await new EditProposalService(f.workspace, f.storage).rollback(applied.checkpointId)).conflicts, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'large.docx')), original);
  const deletion = await f.service.stage([{ kind: 'delete', path: 'large-delete.bin' }]);
  assert.match(f.service.preview(deletion.id)[0]!.original!, /Bytes: 524305/);
  const deleted = await f.service.apply(f.service.accept(deletion.id));
  assert.deepEqual((await new EditProposalService(f.workspace, f.storage).rollback(deleted.checkpointId)).conflicts, []);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'large-delete.bin')), original);
});

test('binary creation includes empty files and rollback preserves later modifications', async t => {
  const f = await fixture(t);
  const proposal = await f.service.stageBinary([binary('new.bin', null, Buffer.alloc(0)), binary('paper.pdf', null, Buffer.from([0, 0xff, 5]))]);
  const applied = await f.service.apply(f.service.accept(proposal.id));
  assert.equal((await fs.stat(path.join(f.root, 'new.bin'))).size, 0);
  await fs.writeFile(path.join(f.root, 'paper.pdf'), Buffer.from([8, 7]));
  const recovery = await f.service.rollback(applied.checkpointId);
  assert.deepEqual(recovery.restored, ['new.bin']);
  assert.equal(recovery.conflicts[0]!.path, 'paper.pdf');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'paper.pdf')), Buffer.from([8, 7]));
  await assert.rejects(fs.stat(path.join(f.root, 'new.bin')), { code: 'ENOENT' });
});

test('format summaries redact secret fields and reject oversized or invalid byte proposals', async t => {
  const f = await fixture(t);
  const edit = binary('doc.docx', null, Buffer.from([0, 1]));
  edit.preview.proposed = 'API_KEY=abcdef0123456789abcdef0123456789\n';
  const proposal = await f.service.stageBinary([edit]);
  assert.equal(f.service.preview(proposal.id)[0]!.proposed.includes('abcdef0123456789'), false);
  f.service.discard(proposal.id);
  await assert.rejects(f.service.stageBinary([{ ...edit, preview: { original: null, proposed: 'x'.repeat(EDIT_PROPOSAL_LIMITS.maxReviewChars + 1) } }]), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(f.service.stageBinary([{ ...edit, expectedHash: 'a'.repeat(64) }]), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(f.service.stageBinary([binary('too-big.docx', null, Buffer.alloc(EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes + 1))]), code('TOOL_VALIDATION_FAILED'));
  const large = Buffer.alloc(12 * 1024 * 1024);
  await assert.rejects(f.service.stageBinary(['one.docx', 'two.docx', 'three.docx'].map(file => binary(file, null, large))), code('CONTEXT_LIMIT'));
  assert.deepEqual(await fs.readdir(f.storage), []);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('generic create/replace refuses structural formats and requires their dedicated adapters', async t => {
  const f = await fixture(t, { 'notes.ipynb': '{"cells":[]}' });
  for (const file of ['new.ipynb', 'new.docx', 'new.pptx', 'new.pdf']) {
    await assert.rejects(f.service.stage([{ kind: 'create', path: file, content: 'wrong file format' }]), code('TOOL_VALIDATION_FAILED'));
  }
  await assert.rejects(f.service.stage([{ kind: 'replace', path: 'notes.ipynb', replacements: [{ search: 'cells', replacement: 'broken' }] }]), code('TOOL_VALIDATION_FAILED'));
  assert.deepEqual(await fs.readdir(f.storage), []);
});
