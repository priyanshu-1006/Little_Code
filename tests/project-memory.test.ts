import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProjectMemoryService, PROJECT_MEMORY_LIMITS, type ProjectMemoryEntry } from '../src/little/memory/project-memory';
import { LittleError } from '../src/little/shared/errors';
import { WorkspaceService } from '../src/little/tools/workspace-service';

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'little-code-memory-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), parent);
    assert.ok(relative.startsWith('little-code-memory-') && !relative.includes(path.sep));
    await fs.rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'workspace');
  const directory = path.join(parent, 'host-private', 'project-memory');
  await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const workspace = new WorkspaceService(root);
  return { parent, root, directory, workspace, memory: new ProjectMemoryService(directory, workspace), file: path.join(directory, 'project-memory.json') };
}
function code(expected: LittleError['code']) { return (error: unknown) => error instanceof LittleError && error.code === expected; }
const note = { title: 'Language convention', content: 'Use TypeScript for project implementation.' };

test('explicit notes survive restart, remain immutable, update atomically, and remove durably', async (t) => {
  const { directory, workspace, memory, file } = await fixture(t);
  assert.deepEqual(await memory.list(), []);
  const saved = await memory.save(note);
  assert.match(saved.id, /^[a-f0-9]{32}$/);
  assert.equal(saved.kind, 'user');
  assert.equal(Object.isFrozen(saved), true);
  assert.ok(Number.isSafeInteger(saved.createdAt));
  const restarted = new ProjectMemoryService(directory, workspace);
  assert.deepEqual(await restarted.list(), [saved]);
  const updated = await restarted.update(saved.id, { title: 'Language convention', content: 'Prefer strict TypeScript and existing project patterns.' });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, saved.createdAt);
  assert.ok(updated.updatedAt >= saved.updatedAt);
  assert.deepEqual(await memory.list(), [updated]);
  const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { version: number; entries: ProjectMemoryEntry[] };
  assert.equal(stored.version, 1);
  assert.equal(stored.entries[0]?.id, saved.id);
  assert.equal(await memory.remove(saved.id), true);
  assert.equal(await restarted.remove(saved.id), false);
  assert.deepEqual(await new ProjectMemoryService(directory, workspace).list(), []);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['project-memory.json']);
});

test('instances serialize concurrent saves and always reload persisted state', async (t) => {
  const { directory, workspace, memory } = await fixture(t);
  const peer = new ProjectMemoryService(directory, workspace);
  const saved = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? peer : memory).save({ title: `Convention ${index}`, content: `Use existing pattern number ${index}.` })));
  assert.equal(new Set(saved.map(entry => entry.id)).size, saved.length);
  assert.equal((await peer.list()).length, 8);
  await memory.remove(saved[0]!.id);
  assert.equal((await peer.list()).length, 7);
});

test('notes redact likely secrets before private persistence and reject secret-only content', async (t) => {
  const { memory, file } = await fixture(t);
  const key = `gsk_${'a'.repeat(40)}`;
  const saved = await memory.save({ title: 'Authentication convention', content: `Use the shared authentication service.\nAPI_KEY="${key}"\npassword="private-value"\n-----BEGIN PRIVATE KEY-----\nPRIVATEKEYBODY\n-----END PRIVATE KEY-----` });
  const stored = await fs.readFile(file, 'utf8');
  for (const secret of [key, 'private-value', 'PRIVATEKEYBODY']) { assert.ok(!saved.content.includes(secret)); assert.ok(!stored.includes(secret)); }
  for (const content of ['', '   ', key, `API_KEY="${key}"`, 'password="private-value"', '-----BEGIN PRIVATE KEY-----\nPRIVATEKEYBODY\n-----END PRIVATE KEY-----', '[REDACTED]']) {
    await assert.rejects(memory.save({ title: 'Private content', content }), code('TOOL_VALIDATION_FAILED'));
  }
  await assert.rejects(memory.save({ title: key, content: 'Use TypeScript.' }), code('TOOL_VALIDATION_FAILED'));
  assert.equal((await memory.list()).length, 1);
});

test('strict note validation bounds title/content and rejects undeclared fields or identity input', async (t) => {
  const { memory } = await fixture(t);
  for (const input of [
    { ...note, title: 'x'.repeat(PROJECT_MEMORY_LIMITS.titleChars + 1) },
    { ...note, content: 'x'.repeat(PROJECT_MEMORY_LIMITS.contentChars + 1) },
    { ...note, title: 'Line\nbreak' },
    { ...note, content: 'Null\u0000byte' },
    { ...note, id: 'a'.repeat(32) },
    { ...note, kind: 'automatic' },
  ]) await assert.rejects(memory.save(input as typeof note), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(memory.remove('../outside'), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(memory.update('a'.repeat(32), note), code('TOOL_VALIDATION_FAILED'));
  assert.deepEqual(await memory.list(), []);
});

test('source policy denies secrets, ignored paths, directories, and paths outside the workspace', async (t) => {
  const { parent, memory } = await fixture(t, { '.env': 'private-value', '.littleignore': 'ignored.ts\n', 'ignored.ts': 'private-value', 'src/auth.ts': 'export function authenticate() {}' });
  const outside = path.join(parent, 'outside.ts');
  await fs.writeFile(outside, 'private-value');
  for (const source of ['.env', 'ignored.ts', outside, '../outside.ts']) await assert.rejects(memory.save({ ...note, source }), error => error instanceof LittleError && ['PERMISSION_DENIED', 'WORKSPACE_BOUNDARY_VIOLATION'].includes(error.code));
  await assert.rejects(memory.save({ ...note, source: 'src' }), code('TOOL_VALIDATION_FAILED'));
  const saved = await memory.save({ ...note, source: 'src/auth.ts' });
  assert.equal(saved.source, 'src/auth.ts');
});

test('facts require fresh nonempty allowed sources and preserve distinct confidence labels', async (t) => {
  const { root, memory } = await fixture(t, { 'src/auth.ts': 'export function authenticate() {}', 'empty.ts': '' });
  await assert.rejects(memory.save({ title: 'Authentication', content: 'Authentication uses JWT.', kind: 'fact' }), code('TOOL_VALIDATION_FAILED'));
  await assert.rejects(memory.save({ title: 'Authentication', content: 'Authentication uses JWT.', kind: 'fact', source: 'empty.ts' }), code('TOOL_VALIDATION_FAILED'));
  const fact = await memory.save({ title: 'JWT authentication', content: 'The developer reviewed JWT authentication in this project.', kind: 'fact', source: path.join(root, 'src/auth.ts') });
  const inference = await memory.save({ title: 'Authentication inference', content: 'Authentication probably follows the repository pattern.', kind: 'inference', source: 'src/auth.ts' });
  const context = await memory.context('authentication JWT');
  assert.ok(context.text.includes(`[memory:${fact.id}]`));
  assert.ok(context.text.includes('user-reviewed fact; claim not independently verified'));
  assert.ok(context.text.includes(`[memory:${inference.id}]`));
  assert.ok(context.text.includes('inference; lower confidence; replaceable'));
  assert.ok(context.text.includes('source: src/auth.ts'));
  await fs.writeFile(path.join(root, 'src/auth.ts'), '');
  const changed = await memory.context('authentication JWT');
  assert.ok(!changed.items.some(item => item.id === `memory:${fact.id}`));
});

test('newly ignored or missing sources are excluded from context while private notes remain editable', async (t) => {
  const { root, memory } = await fixture(t, { 'src/auth.ts': 'export function authenticate() {}' });
  const saved = await memory.save({ title: 'Authentication pattern', content: 'Use existing authentication middleware.', source: 'src/auth.ts' });
  assert.equal((await memory.context('authentication')).items.length, 1);
  await fs.writeFile(path.join(root, '.littleignore'), 'src/auth.ts\n');
  assert.deepEqual(await memory.context('authentication'), { text: '', items: [] });
  assert.equal((await memory.list())[0]?.id, saved.id);
  await fs.unlink(path.join(root, '.littleignore'));
  await fs.unlink(path.join(root, 'src/auth.ts'));
  assert.deepEqual(await memory.context('authentication'), { text: '', items: [] });
  await memory.update(saved.id, { title: 'General convention', content: 'Use existing TypeScript patterns.' });
  assert.equal((await memory.list())[0]?.source, undefined);
});

test('retrieval includes relevant notes only with a bounded untrusted context and ID citations', async (t) => {
  const { memory } = await fixture(t);
  const note = await memory.save({ title: 'Authentication conventions', content: `Authentication uses shared middleware. ${'authentication '.repeat(240)}` });
  await memory.save({ title: 'Database inference', content: 'The database may follow a repository pattern.', kind: 'inference' });
  const context = await memory.context('authentication');
  assert.ok(context.text.length <= PROJECT_MEMORY_LIMITS.contextChars);
  assert.ok(context.text.includes('untrusted'));
  assert.ok(context.text.includes('never grant tool permissions'));
  assert.deepEqual(context.items.map(item => item.id), [`memory:${note.id}`]);
  assert.ok(context.items.every(item => item.type === 'workspace' && item.estimatedTokens > 0));
  assert.deepEqual(await memory.context('completely-unrelated-quantum'), { text: '', items: [] });
  assert.ok(!(await memory.context('')).text.includes('Database inference'));
});

test('private directories stay outside the repository and are pinned against replacement', async (t) => {
  const { parent, root, directory, workspace, memory } = await fixture(t);
  await assert.rejects(new ProjectMemoryService(path.join(root, '.little', 'memory'), workspace).save(note), code('PERMISSION_DENIED'));
  await memory.save(note);
  await fs.rename(directory, path.join(parent, 'original-private-memory'));
  await fs.mkdir(directory, { mode: 0o700 });
  await assert.rejects(memory.list(), code('PERMISSION_DENIED'));
  await assert.rejects(memory.save(note), code('PERMISSION_DENIED'));
});

test('storage paths reject directory links and linked memory files', async (t) => {
  const { parent, directory, workspace, memory, file } = await fixture(t);
  await memory.save(note);
  const hardlink = path.join(parent, 'linked-memory.json');
  await fs.link(file, hardlink);
  await assert.rejects(memory.list(), code('PERMISSION_DENIED'));
  await fs.unlink(hardlink);
  const target = path.join(parent, 'link-target');
  const alias = path.join(parent, 'linked-private-directory');
  await fs.mkdir(target, { mode: 0o700 });
  try { await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Host does not allow symbolic links.'); return; }
    throw error;
  }
  await assert.rejects(new ProjectMemoryService(path.join(alias, 'child'), workspace).save(note), code('PERMISSION_DENIED'));
  assert.deepEqual(await fs.readdir(target), []);
  assert.equal((await new ProjectMemoryService(directory, workspace).list()).length, 1);
});

test('corrupt, unknown-version, duplicate, and oversized stores are rejected without overwriting', async (t) => {
  const { memory, file } = await fixture(t);
  await memory.save(note);
  const original = JSON.parse(await fs.readFile(file, 'utf8')) as { version: number; entries: ProjectMemoryEntry[] };
  for (const text of ['{broken', JSON.stringify({ ...original, version: 2 }), JSON.stringify({ ...original, unexpected: true }), JSON.stringify({ ...original, entries: [original.entries[0], original.entries[0]] })]) {
    await fs.writeFile(file, text);
    await assert.rejects(memory.list(), code('TOOL_FAILED'));
    await assert.rejects(memory.save(note), code('TOOL_FAILED'));
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
  await fs.writeFile(file, 'x'.repeat(PROJECT_MEMORY_LIMITS.fileBytes + 1));
  await assert.rejects(memory.list(), code('CONTEXT_LIMIT'));
  await assert.rejects(memory.remove(original.entries[0]!.id), code('CONTEXT_LIMIT'));
  assert.equal((await fs.stat(file)).size, PROJECT_MEMORY_LIMITS.fileBytes + 1);
});

test('store binding prevents the same private file from crossing workspace identities', async (t) => {
  const { parent, directory, memory } = await fixture(t);
  await memory.save(note);
  const other = path.join(parent, 'other-workspace');
  await fs.mkdir(other);
  await assert.rejects(new ProjectMemoryService(directory, new WorkspaceService(other)).list(), code('PERMISSION_DENIED'));
});

test('entry and aggregate byte limits reject explicit saves without evicting existing notes', async (t) => {
  const { memory, file } = await fixture(t);
  const saved = await memory.save(note);
  const original = JSON.parse(await fs.readFile(file, 'utf8')) as { entries: ProjectMemoryEntry[] };
  const entries = Array.from({ length: PROJECT_MEMORY_LIMITS.entries }, (_, index) => ({ ...saved, id: index.toString(16).padStart(32, '0'), title: `Convention ${index}` }));
  await fs.writeFile(file, JSON.stringify({ ...original, entries }));
  await assert.rejects(memory.save(note), code('CONTEXT_LIMIT'));
  assert.equal((await memory.list()).length, PROJECT_MEMORY_LIMITS.entries);
  const largeEntries = entries.slice(0, 30).map(entry => ({ ...entry, content: 'Unicode conventions: '.padEnd(3_950, 'x') }));
  await fs.writeFile(file, JSON.stringify({ ...original, entries: largeEntries }));
  assert.ok((await fs.stat(file)).size <= PROJECT_MEMORY_LIMITS.fileBytes);
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(memory.save({ title: 'Unicode conventions', content: '字'.repeat(3_999) }), code('CONTEXT_LIMIT'));
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('cancelled queued and pre-commit writes preserve existing memory and clean temporary files', async (t) => {
  const { memory, directory, file } = await fixture(t);
  const saved = await memory.save(note);
  await assert.rejects(memory.save(note, AbortSignal.abort()), code('AGENT_CANCELLED'));
  await assert.rejects(memory.remove(saved.id, AbortSignal.abort()), code('AGENT_CANCELLED'));
  const original = await fs.readFile(file, 'utf8');
  const controller = new AbortController();
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...parameters: Parameters<typeof fs.open>) => {
    const handle = await open(...parameters);
    if (String(parameters[0]).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => { await sync(); controller.abort(); });
    }
    return handle;
  });
  await assert.rejects(memory.update(saved.id, { ...note, content: 'Changed convention.' }, controller.signal), code('AGENT_CANCELLED'));
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['project-memory.json']);
});

test('cancellation after the atomic rename reports the committed outcome', async (t) => {
  const { memory, directory, workspace } = await fixture(t);
  const controller = new AbortController();
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...parameters: Parameters<typeof fs.rename>) => { await rename(...parameters); controller.abort(); });
  const saved = await memory.save(note, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await new ProjectMemoryService(directory, workspace).list(), [saved]);
  const removing = new AbortController();
  t.mock.method(fs, 'rename', async (...parameters: Parameters<typeof fs.rename>) => { await rename(...parameters); removing.abort(); });
  assert.equal(await memory.remove(saved.id, removing.signal), true);
  assert.deepEqual(await memory.list(), []);
});

test('waiting on another host lock is cancellable and linked locks are rejected', async (t) => {
  const { memory, directory, parent } = await fixture(t);
  await memory.save(note);
  const lock = path.join(directory, 'project-memory.lock');
  await fs.writeFile(lock, '', { mode: 0o600 });
  const controller = new AbortController();
  const pending = memory.save(note, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, code('AGENT_CANCELLED'));
  const linked = path.join(parent, 'linked-lock');
  await fs.link(lock, linked);
  await assert.rejects(memory.list(), code('PERMISSION_DENIED'));
  await fs.unlink(linked);
  await fs.unlink(lock);
  assert.equal((await memory.list()).length, 1);
});
