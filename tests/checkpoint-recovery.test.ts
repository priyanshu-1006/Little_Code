import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { EditProposalService, type WorkspaceEdit, type WorkspaceBinaryEdit } from '../src/little/tools/edit-proposals';
import { createHash } from 'node:crypto';
import { WorkspaceService } from '../src/little/tools/workspace-service';

const original = Buffer.from('\uFEFFbefore\r\nexact bytes\r\n');
const replacement: WorkspaceEdit = { kind: 'replace', path: 'app.ts', replacements: [{ search: 'before', replacement: 'after' }] };

async function fixture(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'little-code-journal-'));
  t.after(async () => {
    assert.ok(path.basename(temporary).startsWith('little-code-journal-'));
    assert.equal(path.dirname(temporary), os.tmpdir());
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const root = path.join(temporary, 'workspace'), storage = path.join(temporary, 'checkpoints');
  await fs.mkdir(root); await fs.mkdir(storage);
  await fs.writeFile(path.join(root, 'app.ts'), original);
  const workspace = new WorkspaceService(root);
  return { temporary, root, storage, workspace, service: new EditProposalService(workspace, storage) };
}

type Crash = 'before-move' | 'after-move' | 'after-link' | 'after-unlink' | 'after-record' | 'after-cleanup';
async function crashWorker(root: string, storage: string, crash: Crash, checkpointId?: string, edits: WorkspaceEdit[] = [replacement], crashFile = 'app.ts', binaryEdits?: WorkspaceBinaryEdit[]) {
  // The worker exits immediately at actual filesystem boundaries. The production
  // service has no fault hooks; only this isolated child patches Node's fs exports.
  const script = `
    import { createRequire } from 'node:module';
    import * as path from 'node:path';
    import { EditProposalService } from ${JSON.stringify(pathToFileURL(path.resolve('src/little/tools/edit-proposals.ts')).href)};
    import { WorkspaceService } from ${JSON.stringify(pathToFileURL(path.resolve('src/little/tools/workspace-service.ts')).href)};
    const io = createRequire(import.meta.url)('node:fs/promises');
    const root = ${JSON.stringify(root)}, storage = ${JSON.stringify(storage)}, crash = ${JSON.stringify(crash)}, crashFile = ${JSON.stringify(crashFile)};
    const move = io.rename, link = io.link, unlink = io.unlink, removeDirectory = io.rmdir;
    io.rename = async (from, to) => {
      if (path.basename(to) === 'displaced' && path.basename(from) === crashFile && crash === 'before-move') process.exit(72);
      await move(from, to);
      if (path.basename(to) === 'displaced' && path.basename(from) === crashFile && crash === 'after-move') process.exit(72);
      if (path.basename(to) === 'manifest.json' && crash === 'after-record') {
        const record = JSON.parse(await io.readFile(to, 'utf8'));
        if (record.entries.some(entry => entry.intent && (entry.intent.operation === 'apply' ? entry.applied : !entry.applied))) process.exit(72);
      }
    };
    io.link = async (from, to) => {
      await link(from, to);
      if (path.basename(from) === 'candidate' && crash === 'after-link') process.exit(72);
    };
    io.unlink = async (file) => {
      await unlink(file);
      if (path.basename(file) === 'candidate' && crash === 'after-unlink') process.exit(72);
    };
    io.rmdir = async (directory) => {
      await removeDirectory(directory);
      if (path.basename(directory).startsWith('.little-edit-') && crash === 'after-cleanup') process.exit(72);
    };
    const service = new EditProposalService(new WorkspaceService(root), storage);
    const id = ${JSON.stringify(checkpointId)};
    if (id) await service.rollback(id);
    else {
      const bytes = ${JSON.stringify(binaryEdits?.map(edit => ({ ...edit, content: Array.from(edit.content) })))};
      const proposal = bytes ? await service.stageBinary(bytes.map(edit => ({ ...edit, content: Buffer.from(edit.content) }))) : await service.stage(${JSON.stringify(edits)});
      await service.apply(service.accept(proposal.id));
    }
    throw new Error('The requested crash boundary was not reached.');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += value.toString(); });
  child.stderr.on('data', value => { output += value.toString(); });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 72, output);
  } finally { clearTimeout(timeout); }
  const ids = (await fs.readdir(storage)).filter(name => /^[a-f0-9]{32}$/.test(name));
  assert.equal(ids.length, 1);
  return ids[0]!;
}

for (const crash of ['before-move', 'after-move', 'after-record', 'after-cleanup'] as const) {
  test(`a reviewed deletion crash ${crash} is reversible with its exact original bytes`, async t => {
    const { root, storage, service } = await fixture(t);
    const id = await crashWorker(root, storage, crash, undefined, [{ kind: 'delete', path: 'app.ts' }]);
    assert.equal((await service.listCheckpoints())[0]!.interrupted, true);
    assert.deepEqual((await service.rollback(id)).conflicts, []);
    assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
    assert.deepEqual(await service.listCheckpoints(), []);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.little-edit-')), []);
  });
}

for (const crash of ['after-link', 'after-unlink', 'after-record', 'after-cleanup'] as const) {
  test(`a deleted file restoration crash ${crash} resumes without clobbering original bytes`, async t => {
    const { root, storage, service } = await fixture(t);
    const staged = await service.stage([{ kind: 'delete', path: 'app.ts' }]);
    const applied = await service.apply(service.accept(staged.id));
    await assert.rejects(fs.stat(path.join(root, 'app.ts')), { code: 'ENOENT' });
    await crashWorker(root, storage, crash, applied.checkpointId);
    assert.deepEqual((await service.rollback(applied.checkpointId)).conflicts, []);
    assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
    assert.deepEqual(await service.listCheckpoints(), []);
  });
}

test('a binary edit crash after installation restores exact non-UTF8 original bytes', async t => {
  const { root, storage, service } = await fixture(t);
  const bytes = Buffer.from([0xff, 0, 0xfe, 42]);
  await fs.writeFile(path.join(root, 'app.ts'), bytes);
  const id = await crashWorker(root, storage, 'after-link', undefined, [], 'app.ts', [{ kind: 'binary', path: 'app.ts', operation: 'replace', content: Buffer.from([1, 0, 99]),
    expectedHash: createHash('sha256').update(bytes).digest('hex'), preview: { original: 'Original document summary.', proposed: 'Changed document summary.' } }]);
  assert.deepEqual(await service.rollback(id), { restored: ['app.ts'], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), bytes);
});

test('a deletion crash preserves a later recreated target while retaining the original checkpoint', async t => {
  const { root, storage, service } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-move', undefined, [{ kind: 'delete', path: 'app.ts' }]);
  const userBytes = Buffer.from('Saved by the user after the interrupted deletion.');
  await fs.writeFile(path.join(root, 'app.ts'), userBytes);
  assert.equal((await service.rollback(id)).conflicts.length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), userBytes);
  assert.deepEqual(await fs.readFile(path.join(storage, id, 'original-0')), original);
  assert.equal((await service.listCheckpoints()).length, 1);
});

test('an uncommitted deletion intent preserves a later user deletion as an ambiguous conflict', async t => {
  const { root, storage, service } = await fixture(t);
  const id = await crashWorker(root, storage, 'before-move', undefined, [{ kind: 'delete', path: 'app.ts' }]);
  await fs.unlink(path.join(root, 'app.ts'));
  const recovery = await service.rollback(id);
  assert.equal(recovery.conflicts.length, 1);
  assert.deepEqual(recovery.restored, []);
  await assert.rejects(fs.stat(path.join(root, 'app.ts')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(storage, id, 'original-0')), original);
});

for (const crash of ['before-move', 'after-move', 'after-link', 'after-unlink', 'after-record', 'after-cleanup'] as const) {
  test(`an actual process crash ${crash} is discoverable and recovers exact original bytes`, async t => {
    const { root, storage, service } = await fixture(t);
    const id = await crashWorker(root, storage, crash);
    const checkpoints = await service.listCheckpoints();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]!.id, id);
    assert.equal(checkpoints[0]!.interrupted, true);
    assert.deepEqual(checkpoints[0]!.paths, ['app.ts']);
    const recovery = await service.rollback(id);
    assert.deepEqual(recovery.conflicts, []);
    assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.little-edit-')), []);
    assert.deepEqual(await service.listCheckpoints(), []);
    assert.deepEqual(await service.rollback(id), { restored: [], conflicts: [] });
  });
}

for (const crash of ['after-move', 'after-link', 'after-unlink', 'after-record', 'after-cleanup'] as const) {
  test(`a process crash during restore ${crash} can resume without losing the original`, async t => {
    const { root, storage, service } = await fixture(t);
    const proposal = await service.stage([replacement]);
    const applied = await service.apply(service.accept(proposal.id));
    await crashWorker(root, storage, crash, applied.checkpointId);
    assert.equal((await service.listCheckpoints())[0]!.interrupted, true);
    const recovery = await service.rollback(applied.checkpointId);
    assert.deepEqual(recovery.conflicts, []);
    assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
    assert.deepEqual(await service.listCheckpoints(), []);
  });
}

test('recovery of an interrupted new-file deletion recognizes its committed absence', async t => {
  const { root, storage, service } = await fixture(t);
  const proposal = await service.stage([{ kind: 'create', path: 'new.ts', content: 'new' }]);
  const applied = await service.apply(service.accept(proposal.id));
  await crashWorker(root, storage, 'after-move', applied.checkpointId, [], 'new.ts');
  assert.deepEqual(await service.rollback(applied.checkpointId), { restored: ['new.ts'], conflicts: [] });
  await assert.rejects(fs.stat(path.join(root, 'new.ts')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
});

test('a multi-file crash restores both an earlier committed file and the displaced current file', async t => {
  const { root, storage, service } = await fixture(t);
  const second = Buffer.from('before\r\nsecond exact file\r\n');
  await fs.writeFile(path.join(root, 'b.ts'), second);
  const id = await crashWorker(root, storage, 'after-move', undefined, [replacement, { ...replacement, path: 'b.ts' }], 'b.ts');
  assert.deepEqual((await service.listCheckpoints())[0]!.paths, ['app.ts', 'b.ts']);
  assert.deepEqual(await service.rollback(id), { restored: ['b.ts', 'app.ts'], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
  assert.deepEqual(await fs.readFile(path.join(root, 'b.ts')), second);
});

test('an interrupted new-file installation removes only its recorded candidate inode', async t => {
  const { root, storage, service } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-link', undefined, [{ kind: 'create', path: 'new.ts', content: 'new exact file\r\n' }]);
  assert.deepEqual(await service.rollback(id), { restored: ['new.ts'], conflicts: [] });
  await assert.rejects(fs.stat(path.join(root, 'new.ts')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
});

test('an unrelated hard-link alias blocks recovery of the owned candidate pair', async t => {
  const { root, storage, service, temporary } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-link');
  const target = path.join(root, 'app.ts'), alias = path.join(temporary, 'alias.ts');
  await fs.link(target, alias);
  const after = await fs.readFile(target);
  const recovery = await service.rollback(id);
  assert.deepEqual(recovery.restored, []);
  assert.equal(recovery.conflicts.length, 1);
  assert.deepEqual(await fs.readFile(target), after);
  assert.deepEqual(await fs.readFile(alias), after);
  await fs.unlink(alias);
  assert.deepEqual((await service.rollback(id)).conflicts, []);
  assert.deepEqual(await fs.readFile(target), original);
});

test('an interrupted installation preserves a later save and identical bytes on a new inode', async t => {
  const { root, storage, service, temporary } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-unlink');
  const file = path.join(root, 'app.ts');
  const after = await fs.readFile(file);
  await fs.rename(file, path.join(temporary, 'little-applied.ts'));
  await fs.writeFile(file, after);
  const recovery = await service.rollback(id);
  assert.deepEqual(recovery.restored, []);
  assert.equal(recovery.conflicts.length, 1);
  assert.ok(recovery.conflicts[0]!.recoveryPath);
  assert.deepEqual(await fs.readFile(file), after);
  assert.deepEqual(await fs.readFile(recovery.conflicts[0]!.recoveryPath!), original);
  await fs.writeFile(file, 'later user save');
  assert.equal((await service.rollback(id)).conflicts.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'later user save');
});

test('a later user deletion after an interrupted installation is preserved as a conflict', async t => {
  const { root, storage, service } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-unlink');
  await fs.unlink(path.join(root, 'app.ts'));
  const recovery = await service.rollback(id);
  assert.deepEqual(recovery.restored, []);
  assert.equal(recovery.conflicts.length, 1);
  assert.ok(recovery.conflicts[0]!.recoveryPath);
  await assert.rejects(fs.stat(path.join(root, 'app.ts')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(recovery.conflicts[0]!.recoveryPath!), original);
});

test('new ignore policy prevents crash recovery writes until the policy is reviewed', async t => {
  const { root, storage, service } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-move');
  await fs.writeFile(path.join(root, '.littleignore'), 'app.ts\n');
  const blocked = await service.rollback(id);
  assert.equal(blocked.conflicts.length, 1);
  await assert.rejects(fs.stat(path.join(root, 'app.ts')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, '.littleignore'), '');
  assert.deepEqual((await service.rollback(id)).conflicts, []);
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
});

test('corrupt private originals preserve the crash recovery inode instead of cleaning it', async t => {
  const { root, storage, service } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-unlink');
  const manifest = JSON.parse(await fs.readFile(path.join(storage, id, 'manifest.json'), 'utf8'));
  const displaced = path.join(root, manifest.entries[0].intent.scratch, 'displaced');
  await fs.writeFile(path.join(storage, id, 'original-0'), 'corrupt');
  const recovery = await service.rollback(id);
  assert.equal(recovery.conflicts.length, 1);
  assert.match(recovery.conflicts[0]!.reason, /integrity/);
  assert.deepEqual(await fs.readFile(displaced), original);
  assert.match(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), /after/);
});

test('a replaced scratch directory and malicious mutation paths cannot redirect recovery', async t => {
  const { root, storage, service, temporary } = await fixture(t);
  const id = await crashWorker(root, storage, 'after-move');
  const manifestFile = path.join(storage, id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const scratch = path.join(root, manifest.entries[0].intent.scratch), held = path.join(temporary, 'held');
  await fs.rename(scratch, held);
  await fs.mkdir(scratch);
  await fs.writeFile(path.join(scratch, 'displaced'), 'unrelated');
  const recovery = await service.rollback(id);
  assert.equal(recovery.conflicts.length, 1);
  assert.equal(await fs.readFile(path.join(scratch, 'displaced'), 'utf8'), 'unrelated');
  assert.deepEqual(await fs.readFile(path.join(held, 'displaced')), original);
  manifest.entries[0].intent.scratch = '../held';
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(service.rollback(id));
  assert.deepEqual(await service.listCheckpoints(), []);
  await assert.rejects(fs.stat(path.join(root, 'app.ts')), { code: 'ENOENT' });
});

test('legacy checkpoint manifests still restore after upgrading the service', async t => {
  const { root, storage, service, workspace } = await fixture(t);
  const proposal = await service.stage([replacement]);
  const applied = await service.apply(service.accept(proposal.id));
  const file = path.join(storage, applied.checkpointId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.version = 1;
  await fs.writeFile(file, JSON.stringify(manifest));
  const restarted = new EditProposalService(workspace, storage);
  assert.equal((await restarted.listCheckpoints())[0]!.interrupted, false);
  assert.deepEqual(await restarted.rollback(applied.checkpointId), { restored: ['app.ts'], conflicts: [] });
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
});

test('a filesystem storage obstruction before journal flush never moves the original', async t => {
  const { root, storage, service, temporary } = await fixture(t);
  const proposal = await service.stage([replacement]);
  type Flush = (directory: string, checkpoint: { entries: { intent?: unknown }[] }) => Promise<void>;
  const flush = (Reflect.get(service, 'saveManifest') as Flush).bind(service);
  const held = path.join(temporary, 'held-checkpoint');
  let obstructedDirectory = '';
  Reflect.set(service, 'saveManifest', async (directory: string, checkpoint: { entries: { intent?: unknown }[] }) => {
    if (!obstructedDirectory && checkpoint.entries.some(entry => entry.intent)) {
      obstructedDirectory = directory;
      await fs.rename(directory, held);
      await fs.writeFile(directory, 'A real file now obstructs the checkpoint directory.');
    }
    await flush(directory, checkpoint);
  });
  await assert.rejects(service.apply(service.accept(proposal.id)));
  assert.deepEqual(await fs.readFile(path.join(root, 'app.ts')), original);
  assert.deepEqual(await fs.readFile(path.join(held, 'original-0')), original);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.little-edit-')), []);
  await fs.unlink(obstructedDirectory);
  await fs.rename(held, obstructedDirectory);
  assert.deepEqual(await service.listCheckpoints(), []);
  assert.equal((await fs.readdir(storage)).length, 1);
});
