import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { EDIT_PROPOSAL_LIMITS, EditProposalService, type WorkspaceEdit } from '../src/little/tools/edit-proposals';
import { WorkspaceService } from '../src/little/tools/workspace-service';
import { LittleError } from '../src/little/shared/errors';

async function fixture(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'little-code-edits-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), temporaryRoot);
    assert.ok(relative.startsWith('little-code-edits-') && !relative.includes(path.sep));
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });
  const root = path.join(temporaryRoot, 'workspace');
  const outside = path.join(temporaryRoot, 'outside');
  const checkpoints = path.join(temporaryRoot, 'checkpoints');
  await Promise.all([fs.mkdir(root), fs.mkdir(outside), fs.mkdir(checkpoints)]);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const workspace = new WorkspaceService(root);
  return { root, outside, checkpoints, workspace, service: new EditProposalService(workspace, checkpoints) };
}

function code(expected: LittleError['code']) {
  return (error: unknown) => error instanceof LittleError && error.code === expected;
}
const replace = (file: string, search = 'before', replacement = 'after'): WorkspaceEdit => ({ kind: 'replace', path: file, replacements: [{ search, replacement }] });
const create = (file: string, content = 'new contents'): WorkspaceEdit => ({ kind: 'create', path: file, content });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('staging is read-only, immutable, bounded and separates private host previews', async (t) => {
  const original = 'before\napiKey="sk-1234567890abcdefghijklmnop"\n';
  const { root, checkpoints, service } = await fixture(t, { 'app.ts': original });
  const proposal = await service.stage([replace('app.ts'), create('new.ts', 'export const value = 1;')]);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), original);
  assert.deepEqual(await fs.readdir(root), ['app.ts']);
  assert.deepEqual(await fs.readdir(checkpoints), []);
  assert.equal(proposal.changes[0]!.beforeHash, hash(original));
  assert.equal(proposal.changes[0]!.afterHash, hash(original.replace('before', 'after')));
  assert.equal(proposal.changes[1]!.beforeHash, null);
  assert.ok(proposal.changes[0]!.diff.includes('-before'));
  assert.ok(!JSON.stringify(proposal).includes('sk-1234567890abcdefghijklmnop'));
  assert.ok(Object.isFrozen(proposal) && Object.isFrozen(proposal.changes) && Object.isFrozen(proposal.changes[0]));
  const preview = service.preview(proposal.id);
  assert.equal(preview[0]!.original, original);
  assert.equal(preview[0]!.proposed, original.replace('before', 'after'));
  assert.equal(preview[1]!.original, null);
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview[0]));
});

test('only an authentic, one-use, non-discarded host acceptance can apply', async (t) => {
  const { root, checkpoints, service, workspace } = await fixture(t, { 'app.ts': 'before' });
  const proposal = await service.stage([replace('app.ts')]);
  await assert.rejects(service.apply({ proposalId: proposal.id, accepted: true }), code('PERMISSION_DENIED'));
  const acceptance = service.accept(proposal.id);
  assert.throws(() => service.accept(proposal.id), code('PERMISSION_DENIED'));
  await assert.rejects(service.apply({ ...acceptance }), code('PERMISSION_DENIED'));
  await assert.rejects(new EditProposalService(workspace, checkpoints).apply(acceptance), code('PERMISSION_DENIED'));
  assert.equal((await service.apply(acceptance)).status, 'applied');
  await assert.rejects(service.apply(acceptance), code('PERMISSION_DENIED'));
  const next = await service.stage([replace('app.ts', 'after', 'next')]);
  const discarded = service.accept(next.id);
  service.discard(next.id);
  assert.throws(() => service.preview(next.id), code('PERMISSION_DENIED'));
  await assert.rejects(service.apply(discarded), code('PERMISSION_DENIED'));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'after');
});

test('checkpoints preserve exact original bytes and rollback survives a service restart', async (t) => {
  const original = Buffer.from('\uFEFFfirst\r\nbefore\r\nlast\r\n');
  const { root, checkpoints, workspace, service } = await fixture(t, { 'src/app.ts': original, 'empty.txt': '' });
  await assert.rejects(service.stage([replace('src/app.ts'), replace('empty.txt', 'x', 'y')]), code('TOOL_VALIDATION_FAILED'));
  const valid = await service.stage([replace('src\\app.ts'), create('src/new.ts', '')]);
  const result = await service.apply(service.accept(valid.id));
  assert.equal(result.status, 'applied');
  assert.deepEqual(await fs.readFile(path.join(checkpoints, result.checkpointId, 'original-0')), original);
  assert.deepEqual(await fs.readFile(path.join(root, 'src/app.ts')), Buffer.from(original.toString().replace('before', 'after')));
  assert.equal((await fs.stat(path.join(root, 'src/new.ts'))).size, 0);
  const restarted = new EditProposalService(workspace, checkpoints);
  assert.deepEqual(await restarted.rollback(result.checkpointId), { restored: ['src/new.ts', 'src/app.ts'], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(root, 'src/app.ts')), original);
  await assert.rejects(fs.stat(path.join(root, 'src/new.ts')), { code: 'ENOENT' });
  assert.deepEqual(await restarted.rollback(result.checkpointId), { restored: [], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(checkpoints, result.checkpointId, 'original-0')), original);
});

test('literal replacements require one unambiguous match, including overlapping occurrences', async (t) => {
  const { root, service } = await fixture(t, { 'app.ts': 'before', 'ambiguous.ts': 'aaa' });
  for (const edit of [replace('app.ts', '', 'x'), replace('app.ts', 'missing', 'x'), replace('app.ts', 'before', 'before'), replace('ambiguous.ts', 'aa', 'x')]) {
    await assert.rejects(service.stage([edit]), code('TOOL_VALIDATION_FAILED'));
  }
  const proposal = await service.stage([replace('app.ts', 'before', '$&-$`-$\'')]);
  await service.apply(service.accept(proposal.id));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), '$&-$`-$\'');
});

test('text, file count, replacement count, aggregate bytes and preview limits are enforced', async (t) => {
  const large = 'a'.repeat(EDIT_PROPOSAL_LIMITS.maxFileBytes);
  const { service } = await fixture(t, { 'binary.txt': Buffer.from([0xc0, 0xaf]), 'nul.txt': 'before\u0000', 'a.txt': large, 'b.txt': large, 'c.txt': large });
  for (const edit of [create('big.txt', `${large}x`), create('nul-new.txt', 'a\u0000b'), create('surrogate.txt', '\uD800'), replace('binary.txt', 'x', 'y'), replace('nul.txt')]) {
    await assert.rejects(service.stage([edit]), code('TOOL_VALIDATION_FAILED'));
  }
  await assert.rejects(service.stage(Array.from({ length: 9 }, (_, i) => create(`${i}.txt`))), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(service.stage([{ kind: 'replace', path: 'a.txt', replacements: Array.from({ length: 33 }, () => ({ search: 'a', replacement: 'b' })) }]), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(service.stage(['a.txt', 'b.txt', 'c.txt'].map(file => replace(file, large, 'b'.repeat(large.length)))), code('CONTEXT_LIMIT'));
  const preview = await service.stage([replace('a.txt', large, 'b'.repeat(large.length))]);
  assert.ok(preview.changes[0]!.diffTruncated);
  assert.equal(preview.changes[0]!.diff.length, EDIT_PROPOSAL_LIMITS.maxDiffChars);
  await assert.rejects(service.stage([create('same.txt'), create('same.txt')]), code('TOOL_VALIDATION_FAILED'));
});

test('sensitive, generated, ignore policy, ambiguous and traversal paths are denied', async (t) => {
  const { service, root } = await fixture(t, { 'app.ts': 'before' });
  for (const file of ['../outside/new.ts', '..\\outside\\new.ts', 'src/../new.ts', path.join(root, 'new.ts'), 'C:new.ts', '/new.ts']) {
    await assert.rejects(service.stage([create(file)]), code('WORKSPACE_BOUNDARY_VIOLATION'));
  }
  for (const file of ['.env', '.env.local', 'id_rsa', 'cert.pem', 'credentials.json', '.aws/key.txt', 'node_modules/x.ts', 'generated/x.ts', '.gitignore', '.littleignore', '.LITTLE-EDIT-held/displaced']) {
    await assert.rejects(service.stage([create(file)]), code('PERMISSION_DENIED'));
  }
  for (const file of ['app.ts:stream', 'CON.txt', 'new.ts.', 'new.ts ', './new.ts', 'src//new.ts']) {
    await assert.rejects(service.stage([create(file)]), code('TOOL_VALIDATION_FAILED'));
  }
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'before');
});

test('root, nested and refreshed ignore rules protect existing files and nonexistent leaves', async (t) => {
  const { service, root, checkpoints } = await fixture(t, {
    '.gitignore': '*.cache\nhidden/\n!hidden/keep.ts\n', '.littleignore': 'private.ts\n',
    'src/.gitignore': '!keep.cache\nnested.ts\n', 'src/keep.cache': 'before', 'src/nested.ts': 'before',
    'src/drop.cache': 'before', 'hidden/keep.ts': 'before', 'private.ts': 'before', 'safe.ts': 'before',
  });
  for (const file of ['src/drop.cache', 'src/nested.ts', 'hidden/keep.ts', 'private.ts']) await assert.rejects(service.stage([replace(file)]), code('PERMISSION_DENIED'));
  for (const file of ['new.cache', 'src/new.cache', 'src/nested.ts', 'hidden/new.ts']) await assert.rejects(service.stage([create(file)]), code('PERMISSION_DENIED'));
  assert.equal((await service.stage([replace('src/keep.cache')])).changes[0]!.path, 'src/keep.cache');
  const proposal = await service.stage([replace('safe.ts')]);
  await fs.appendFile(path.join(root, '.littleignore'), 'safe.ts\n');
  await assert.rejects(service.apply(service.accept(proposal.id)), code('PERMISSION_DENIED'));
  assert.equal(await fs.readFile(path.join(root, 'safe.ts'), 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(checkpoints), []);
});

test('symlinks and junctions cannot redirect replacements or new files', async (t) => {
  const { root, outside, service } = await fixture(t, { 'safe/app.ts': 'before' });
  await fs.writeFile(path.join(outside, 'app.ts'), 'external before');
  try {
    await fs.symlink(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(root, 'safe'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links are unavailable.'); return; }
    throw error;
  }
  for (const edit of [replace('external/app.ts', 'external before'), create('external/new.ts'), replace('alias/app.ts'), create('alias/new.ts')]) await assert.rejects(service.stage([edit]), code('WORKSPACE_BOUNDARY_VIOLATION'));
  assert.equal(await fs.readFile(path.join(outside, 'app.ts'), 'utf8'), 'external before');
  assert.deepEqual(await fs.readdir(outside), ['app.ts']);
});

test('hard-linked originals cannot be modified through an alias', async (t) => {
  const { root, outside, service } = await fixture(t, { 'app.ts': 'before' });
  await fs.link(path.join(root, 'app.ts'), path.join(outside, 'alias.ts'));
  await assert.rejects(service.stage([replace('app.ts')]), code('PERMISSION_DENIED'));
  assert.equal(await fs.readFile(path.join(outside, 'alias.ts'), 'utf8'), 'before');
});

test('all originals are checked before any writes, even for identical bytes on a new inode', async (t) => {
  const { root, outside, checkpoints, service } = await fixture(t, { 'a.ts': 'before', 'b.ts': 'before' });
  const proposal = await service.stage([replace('a.ts'), replace('b.ts')]);
  await fs.rename(path.join(root, 'b.ts'), path.join(outside, 'old-b.ts'));
  await fs.writeFile(path.join(root, 'b.ts'), 'before');
  await assert.rejects(service.apply(service.accept(proposal.id)), code('TOOL_FAILED'));
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(checkpoints), []);
});

test('changed, deleted or newly created originals invalidate accepted proposals', async (t) => {
  const { root, service } = await fixture(t, { 'app.ts': 'before' });
  let proposal = await service.stage([replace('app.ts')]);
  await fs.writeFile(path.join(root, 'app.ts'), 'user saved');
  await assert.rejects(service.apply(service.accept(proposal.id)), code('TOOL_FAILED'));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'user saved');
  proposal = await service.stage([replace('app.ts', 'user saved')]);
  await fs.unlink(path.join(root, 'app.ts'));
  await assert.rejects(service.apply(service.accept(proposal.id)), code('TOOL_FAILED'));
  proposal = await service.stage([create('new.ts')]);
  await fs.writeFile(path.join(root, 'new.ts'), 'user created');
  await assert.rejects(service.apply(service.accept(proposal.id)), code('TOOL_FAILED'));
  assert.equal(await fs.readFile(path.join(root, 'new.ts'), 'utf8'), 'user created');
});

test('rollback preserves concurrent user saves and reports conflicts while restoring unaffected files', async (t) => {
  const { root, outside, checkpoints, service } = await fixture(t, { 'a.ts': 'before', 'b.ts': 'before', 'c.ts': 'before' });
  const proposal = await service.stage([replace('a.ts'), replace('b.ts'), replace('c.ts'), create('new.ts')]);
  const result = await service.apply(service.accept(proposal.id));
  await fs.writeFile(path.join(root, 'a.ts'), 'user saved');
  await fs.rename(path.join(root, 'b.ts'), path.join(outside, 'old-b.ts'));
  await fs.writeFile(path.join(root, 'b.ts'), 'after');
  await fs.writeFile(path.join(root, 'new.ts'), 'user edited new');
  const recovery = await service.rollback(result.checkpointId);
  assert.deepEqual(recovery.restored, ['c.ts']);
  assert.deepEqual(recovery.conflicts.map(item => item.path).sort(), ['a.ts', 'b.ts', 'new.ts']);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'user saved');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'after');
  assert.equal(await fs.readFile(path.join(root, 'new.ts'), 'utf8'), 'user edited new');
  assert.equal(await fs.readFile(path.join(root, 'c.ts'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(checkpoints, result.checkpointId, 'original-0'), 'utf8'), 'before');
});

test('rollback never overwrites a concurrent save racing with its exclusive installation', async (t) => {
  const { root, checkpoints, service } = await fixture(t, { 'app.ts': 'before' });
  const proposal = await service.stage([replace('app.ts')]);
  const applied = await service.apply(service.accept(proposal.id));
  let concurrentSave = false;
  const watcher = watch(root, (_event, filename) => {
    if (filename?.toString() !== 'app.ts' || concurrentSave) return;
    concurrentSave = true;
    writeFileSync(path.join(root, 'app.ts'), 'user saved during rollback');
  });
  t.after(() => watcher.close());
  const result = await service.rollback(applied.checkpointId);
  assert.ok(concurrentSave);
  assert.deepEqual(result.restored, []);
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.conflicts[0]!.recoveryPath);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'user saved during rollback');
  assert.equal(await fs.readFile(path.join(checkpoints, applied.checkpointId, 'original-0'), 'utf8'), 'before');
  assert.equal(await fs.readFile(result.conflicts[0]!.recoveryPath!, 'utf8'), 'after');
});

test('a cancelled rollback persists already restored files so a later retry is safe', async (t) => {
  const { root, service } = await fixture(t, { 'a.ts': 'before', 'b.ts': 'before' });
  const proposal = await service.stage([replace('a.ts'), replace('b.ts')]);
  const applied = await service.apply(service.accept(proposal.id));
  const controller = new AbortController();
  const watcher = watch(root, (_event, filename) => {
    if (filename?.toString() !== 'b.ts') return;
    try { if (readFileSync(path.join(root, 'b.ts'), 'utf8') === 'before') controller.abort(); } catch { /* Await the committed restoration. */ }
  });
  t.after(() => watcher.close());
  await assert.rejects(service.rollback(applied.checkpointId, controller.signal), code('AGENT_CANCELLED'));
  assert.ok(controller.signal.aborted);
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'after');
  assert.deepEqual(await service.rollback(applied.checkpointId), { restored: ['a.ts'], conflicts: [] });
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'before');
});

test('rollback rejects corrupt original bytes and checkpoint metadata without changing files', async (t) => {
  const { root, checkpoints, service } = await fixture(t, { 'app.ts': 'before' });
  const proposal = await service.stage([replace('app.ts')]);
  const result = await service.apply(service.accept(proposal.id));
  const directory = path.join(checkpoints, result.checkpointId);
  await fs.writeFile(path.join(directory, 'original-0'), 'tampered');
  const recovery = await service.rollback(result.checkpointId);
  assert.equal(recovery.conflicts.length, 1);
  assert.match(recovery.conflicts[0]!.reason, /integrity/);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'after');
  const manifestFile = path.join(directory, 'manifest.json');
  const originalManifest = await fs.readFile(manifestFile, 'utf8');
  for (const contents of ['null', '{', JSON.stringify({ ...JSON.parse(originalManifest), entries: [{ ...JSON.parse(originalManifest).entries[0], path: '../outside/app.ts' }] })]) {
    await fs.writeFile(manifestFile, contents);
    await assert.rejects(service.rollback(result.checkpointId), (error: unknown) => error instanceof LittleError);
  }
  await assert.rejects(service.rollback('../outside'), code('TOOL_VALIDATION_FAILED'));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'after');
});

test('cancellation invalidates pending approvals, and pre-aborted operations perform no writes', async (t) => {
  const { root, checkpoints, service } = await fixture(t, { 'app.ts': 'before' });
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(service.stage([replace('app.ts')], stopped.signal), code('AGENT_CANCELLED'));
  const controller = new AbortController();
  let proposal = await service.stage([replace('app.ts')], controller.signal);
  let acceptance = service.accept(proposal.id);
  controller.abort();
  assert.throws(() => service.accept(proposal.id), code('PERMISSION_DENIED'));
  assert.throws(() => service.preview(proposal.id), code('PERMISSION_DENIED'));
  await assert.rejects(service.apply(acceptance), code('PERMISSION_DENIED'));
  proposal = await service.stage([replace('app.ts')]);
  acceptance = service.accept(proposal.id);
  await assert.rejects(service.apply(acceptance, stopped.signal), code('AGENT_CANCELLED'));
  await assert.rejects(service.apply(acceptance), code('PERMISSION_DENIED'));
  assert.deepEqual(await fs.readdir(checkpoints), []);
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'before');
  const final = await service.stage([replace('app.ts')]);
  const result = await service.apply(service.accept(final.id));
  await assert.rejects(service.rollback(result.checkpointId, stopped.signal), code('AGENT_CANCELLED'));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'after');
});

test('cancellation after checkpoint creation recovers without losing original bytes', async (t) => {
  const { root, checkpoints, service } = await fixture(t, { 'app.ts': 'before' });
  const controller = new AbortController();
  const watcher = watch(checkpoints, () => controller.abort());
  t.after(() => watcher.close());
  const proposal = await service.stage([replace('app.ts')], controller.signal);
  const acceptance = service.accept(proposal.id);
  const result = await service.apply(acceptance);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error?.code, 'AGENT_CANCELLED');
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'before');
  assert.deepEqual(result.recovery?.conflicts, []);
  await assert.rejects(service.apply(acceptance), code('PERMISSION_DENIED'));
});

test('a concurrent save during a multi-file apply is preserved and earlier edits are recovered', async (t) => {
  const { root, service } = await fixture(t, { 'a.ts': 'before', 'b.ts': 'before' });
  let concurrentSave = false;
  const watcher = watch(root, (_event, filename) => {
    if (filename?.toString() !== 'a.ts' || concurrentSave) return;
    concurrentSave = true;
    writeFileSync(path.join(root, 'b.ts'), 'user saved during apply');
  });
  t.after(() => watcher.close());
  const proposal = await service.stage([replace('a.ts'), replace('b.ts')]);
  const result = await service.apply(service.accept(proposal.id));
  assert.ok(concurrentSave);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.recovery?.restored, ['a.ts']);
  assert.deepEqual(result.recovery?.conflicts, []);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'user saved during apply');
});

test('cancellation after installing a file records its identity before recovering it', async (t) => {
  const { root, service } = await fixture(t, { 'a.ts': 'before', 'b.ts': 'before' });
  const controller = new AbortController();
  const watcher = watch(root, (_event, filename) => {
    if (filename?.toString() !== 'a.ts') return;
    try { if (readFileSync(path.join(root, 'a.ts'), 'utf8') === 'after') controller.abort(); } catch { /* The original is temporarily displaced. */ }
  });
  t.after(() => watcher.close());
  const proposal = await service.stage([replace('a.ts'), replace('b.ts')], controller.signal);
  const result = await service.apply(service.accept(proposal.id));
  assert.ok(controller.signal.aborted);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.recovery?.restored, ['a.ts']);
  assert.deepEqual(result.recovery?.conflicts, []);
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'before');
});

test('workspace and checkpoint roots remain pinned from staging through acceptance', async (t) => {
  const { root, outside, checkpoints, workspace, service } = await fixture(t, { 'app.ts': 'before' });
  await assert.rejects(new EditProposalService(workspace, root).stage([replace('app.ts')]), code('TOOL_VALIDATION_FAILED'));
  const proposal = await service.stage([replace('app.ts')]);
  await fs.rename(checkpoints, path.join(outside, 'old-checkpoints'));
  await fs.mkdir(checkpoints);
  await assert.rejects(service.apply(service.accept(proposal.id)), code('WORKSPACE_BOUNDARY_VIOLATION'));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'before');
  const moved = await service.stage([replace('app.ts')]);
  await fs.rename(root, path.join(outside, 'old-workspace'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'app.ts'), 'new workspace');
  await assert.rejects(service.apply(service.accept(moved.id)), code('WORKSPACE_BOUNDARY_VIOLATION'));
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'new workspace');
});

test('a service serializes transactions and bounds pending proposals', async (t) => {
  const { service } = await fixture(t, { 'app.ts': 'before' });
  const proposals = await Promise.all(Array.from({ length: EDIT_PROPOSAL_LIMITS.maxPending }, () => service.stage([replace('app.ts')])));
  await assert.rejects(service.stage([replace('app.ts')]), code('TOOL_VALIDATION_FAILED'));
  const first = service.apply(service.accept(proposals[0]!.id));
  await assert.rejects(service.apply(service.accept(proposals[1]!.id)), code('TOOL_FAILED'));
  assert.equal((await first).status, 'applied');
  service.discard(proposals[1]!.id);
});

test('POSIX mode changes invalidate acceptance and original modes survive replacements', { skip: process.platform === 'win32' }, async (t) => {
  const { root, service } = await fixture(t, { 'app.ts': 'before' });
  const file = path.join(root, 'app.ts');
  await fs.chmod(file, 0o664);
  let proposal = await service.stage([replace('app.ts')]);
  await fs.chmod(file, 0o644);
  await assert.rejects(service.apply(service.accept(proposal.id)), code('TOOL_FAILED'));
  await fs.chmod(file, 0o664);
  proposal = await service.stage([replace('app.ts')]);
  const result = await service.apply(service.accept(proposal.id));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o664);
  await service.rollback(result.checkpointId);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o664);
});

