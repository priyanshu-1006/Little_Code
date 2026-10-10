import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { RepositoryIndex, REPOSITORY_INDEX_LIMITS, type IndexSnapshot } from '../src/little/context/repository-index';
import type { RepositoryStatus } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { WorkspaceService, WORKSPACE_LIMITS, type FileContent, type WorkspaceInventory } from '../src/little/tools/workspace-service';

class ObservedWorkspace extends WorkspaceService {
  readonly reads: string[] = [];
  bytesRead = 0;
  inventoryCalls = 0;
  afterRead?: (input: string) => Promise<void> | void;
  afterInventory?: (inventory: WorkspaceInventory) => Promise<void> | void;
  override async readFile(input: string, signal?: AbortSignal): Promise<FileContent> {
    this.reads.push(input);
    const content = await super.readFile(input, signal);
    this.bytesRead += content.bytesRead;
    await this.afterRead?.(input);
    return content;
  }
  override async inventory(signal?: AbortSignal): Promise<WorkspaceInventory> {
    this.inventoryCalls++;
    const inventory = await super.inventory(signal);
    await this.afterInventory?.(inventory);
    return inventory;
  }
}

async function fixture(t: TestContext, files: Record<string, string | Buffer>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-index-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('little-index-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const workspace = new ObservedWorkspace(root);
  return { root, workspace, index: new RepositoryIndex(workspace) };
}
function errorCode(code: LittleError['code']) { return (error: unknown) => error instanceof LittleError && error.code === code; }
function signal() { return new AbortController().signal; }
function indexed(snapshot: IndexSnapshot, name: string) {
  const file = snapshot.files.find(file => file.path === name);
  assert.ok(file, `Expected indexed file ${name}`);
  return file;
}
function names(snapshot: IndexSnapshot, name: string) { return indexed(snapshot, name).symbols.map(symbol => symbol.name); }

test('real inventory skips linked directories, hard links, generated sources and newly ignored paths', async t => {
  const { root, workspace } = await fixture(t, { 'safe.ts': 'export const safe = true;', 'linked/original.ts': 'export const linked = true;', 'nested/file.ts': 'export const nested = true;', 'generated/client.ts': 'private generated content', '.env': 'private credential' });
  await fs.link(path.join(root, 'linked/original.ts'), path.join(root, 'alias.ts'));
  await fs.symlink(path.join(root, 'nested'), path.join(root, 'directory-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const inventory = await workspace.inventory(signal());
  assert.deepEqual(inventory.files.map(file => file.path), ['nested/file.ts', 'safe.ts']);
  assert.ok(inventory.files.every(file => file.bytes > 0 && file.modifiedMs > 0 && file.createdMs > 0));
  await fs.writeFile(path.join(root, 'nested/.littleignore'), 'file.ts\n');
  assert.ok(!(await workspace.inventory(signal())).files.some(file => file.path === 'nested/file.ts'));
  await assert.rejects(workspace.inventory(AbortSignal.abort()), errorCode('AGENT_CANCELLED'));
});

test('real inventory stops at two thousand files and reports a limited map', async t => {
  const { root, workspace } = await fixture(t, {});
  for (let start = 0; start < 2001; start += 100) await Promise.all(Array.from({ length: Math.min(100, 2001 - start) }, (_, index) => fs.writeFile(path.join(root, `file${start + index}.bin`), '')));
  const inventory = await workspace.inventory(signal());
  assert.equal(inventory.files.length, 2000); assert.equal(inventory.truncated, true);
  assert.ok(inventory.visitedEntries <= WORKSPACE_LIMITS.maxVisitedEntries);
});

test('heuristics extract supported declarations and imports while masking comments and literals', async (t) => {
  const { index } = await fixture(t, {
    'src/auth.ts': [
      '// 😀 export function CommentPhantom() {}',
      'const prose = `😀\nexport class TemplatePhantom {}\nimport "template-phantom"`; ',
      'import { Session } from "./session";',
      'import "@scope/startup";',
      'export { Session } from "./session";',
      'const util = require("node:path");',
      'const dynamic = import("./lazy");',
      'const quoted = "require(\'quoted-phantom\')";',
      'export async function authenticate(user: Session) { return user; }',
      'export class AuthService {}',
      'export interface AuthOptions {}',
      'export type AuthToken = string;',
      'export const verify = () => true;',
      '/* export function BlockPhantom() {} */',
    ].join('\n'),
    'worker.py': [
      '"""😀\ndef DocstringPhantom():\n    pass\nimport docstring_phantom\n"""',
      'from .auth.sessions import Session',
      'import os, pathlib as paths',
      'async def authenticate(user):',
      '    return user',
      'class AuthService:',
      '    pass',
      'enabled: bool = True',
      '# def CommentPhantom(): pass',
    ].join('\n'),
    'worker.go': [
      'package auth',
      'import (',
      '  "fmt"',
      '  local "example.org/session"',
      ')',
      'var prose = `😀',
      'import "raw-phantom"',
      'func RawPhantom() {}',
      '`',
      'type Session[T any] struct {}',
      'func (s *Session[T]) Authenticate() {}',
      'const Enabled = true',
    ].join('\n'),
    'worker.rs': [
      'use std::collections::{HashMap, HashSet};',
      'pub mod auth;',
      'pub struct Session {}',
      'pub trait Authenticator {}',
      'pub type AuthToken = String;',
      'pub(crate) async fn authenticate<\'a>(user: &\'a str) {}',
      'const PROSE: &str = r#"😀',
      'pub fn RawPhantom() {}',
      'use phantom::module;',
      '"#;',
      '/* nested /* fn BlockPhantom() {} */ comment */',
    ].join('\n'),
  });
  const snapshot = await index.refresh(signal());
  const ts = indexed(snapshot, 'src/auth.ts');
  assert.equal(ts.language, 'typescript');
  assert.deepEqual(ts.symbols.find(symbol => symbol.name === 'authenticate'), { name: 'authenticate', kind: 'function', line: 11 });
  assert.deepEqual(ts.symbols.find(symbol => symbol.name === 'verify')?.kind, 'function');
  for (const file of snapshot.files) {
    assert.ok(!file.symbols.some(symbol => /Phantom/.test(symbol.name)), file.path);
    assert.ok(!file.imports.some(dependency => /phantom/.test(dependency)), file.path);
    assert.ok(!file.terms.some(term => /phantom/.test(term)), file.path);
  }
  assert.deepEqual(ts.imports, ['./session', '@scope/startup', 'node:path', './lazy'].filter(value => value !== 'node:path'));
  // Scheme-like imports are omitted conservatively; Rust module separators remain valid.
  assert.deepEqual(indexed(snapshot, 'worker.rs').imports, ['std::collections', 'auth']);
  assert.deepEqual(indexed(snapshot, 'worker.py').imports, ['.auth.sessions', 'os', 'pathlib']);
  assert.deepEqual(indexed(snapshot, 'worker.go').imports, ['fmt', 'example.org/session']);
  assert.ok(names(snapshot, 'worker.go').includes('Authenticate'));
  assert.ok(names(snapshot, 'worker.py').includes('authenticate'));
  assert.ok(names(snapshot, 'worker.rs').includes('authenticate'));
  assert.equal(snapshot.stats.symbols, snapshot.files.reduce((count, file) => count + file.symbols.length, 0));
});

test('cache retains metadata only and omits literal credentials and unsafe import locations', async (t) => {
  const privateToken = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
  const { index } = await fixture(t, {
    'safe.ts': [
      `const apiKey = "${privateToken}";`,
      'const quoted = "UniquePrivateLiteralValue";',
      '// UniquePrivateCommentValue',
      'import remote from "https://alice:UniquePrivatePassword@example.org/source";',
      'const longName = ' + 'x'.repeat(60) + ';',
      'export function lookupSession() {}',
      '-----BEGIN PRIVATE KEY-----',
      'UniquePrivateKeyLine',
      '-----END PRIVATE KEY-----',
      'export class AfterPrivateKey {}',
    ].join('\n'),
    '.env': `GROQ_API_KEY=${privateToken}`,
    'credentials.json': '{"password":"UniquePrivateCredential"}',
    'node_modules/package/index.ts': 'export class IgnoredDependency {}',
  });
  const snapshot = await index.refresh(signal());
  assert.deepEqual(snapshot.files.map(file => file.path), ['safe.ts']);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [privateToken, 'UniquePrivateLiteralValue', 'UniquePrivateCommentValue', 'UniquePrivatePassword', 'UniquePrivateKeyLine', 'UniquePrivateCredential', 'export function lookupSession']) assert.ok(!serialized.includes(secret), secret);
  assert.deepEqual(indexed(snapshot, 'safe.ts').imports, []);
  assert.deepEqual(indexed(snapshot, 'safe.ts').symbols.find(symbol => symbol.name === 'AfterPrivateKey'), { name: 'AfterPrivateKey', kind: 'class', line: 10 });
  assert.ok(indexed(snapshot, 'safe.ts').terms.includes('lookupsession'));
  assert.ok(indexed(snapshot, 'safe.ts').terms.every(term => term.length <= REPOSITORY_INDEX_LIMITS.termChars));
  assert.equal(snapshot.truncated, true);
});

test('unchanged metadata is reused and retained-mtime edits, moves, deletions, and fresh ignores update the cache', async (t) => {
  const { root, workspace, index } = await fixture(t, { 'alpha.ts': 'export const alpha = 1;', 'nested/beta.py': 'def beta(): pass' });
  const first = await index.refresh(signal());
  assert.equal(first.stats.processed, 2);
  assert.equal(first.stats.reused, 0);
  const warm = await index.refresh(signal());
  assert.equal(warm.stats.processed, 0);
  assert.equal(warm.stats.reused, 2);
  assert.deepEqual(workspace.reads, ['alpha.ts', 'nested/beta.py']);
  const target = path.join(root, 'alpha.ts');
  const before = await fs.stat(target);
  await new Promise(resolve => setTimeout(resolve, 20));
  await fs.writeFile(target, 'export const bravo = 1;');
  await fs.utimes(target, before.atime, before.mtime);
  const changed = await index.refresh(signal());
  assert.deepEqual(names(changed, 'alpha.ts'), ['bravo']);
  assert.equal(changed.stats.processed, 1);
  assert.equal(changed.stats.reused, 1);
  await fs.rename(path.join(root, 'nested/beta.py'), path.join(root, 'moved.py'));
  await fs.rm(target);
  const moved = await index.refresh(signal());
  assert.deepEqual(moved.files.map(file => file.path), ['moved.py']);
  assert.deepEqual(names(moved, 'moved.py'), ['beta']);
  await fs.writeFile(path.join(root, '.littleignore'), 'moved.py\n');
  const ignored = await index.refresh(signal());
  assert.ok(!ignored.files.some(file => file.path === 'moved.py'));
  await fs.writeFile(path.join(root, '.littleignore'), '');
  const visible = await index.refresh(signal());
  assert.deepEqual(names(visible, 'moved.py'), ['beta']);
  assert.equal(visible.generation, first.generation + 5);
  assert.ok(workspace.inventoryCalls >= 12);
});

test('path and whole-index invalidation force new reads and returned snapshots are deeply immutable', async (t) => {
  const { root, workspace, index } = await fixture(t, { 'a.ts': 'export function alpha() {}', 'b.ts': 'export class Beta {}' });
  const first = await index.refresh(signal());
  const file = indexed(first, 'a.ts');
  assert.throws(() => first.files.push(file), TypeError);
  assert.throws(() => { file.path = 'overwritten.ts'; }, TypeError);
  assert.throws(() => { file.symbols[0]!.name = 'overwritten'; }, TypeError);
  assert.throws(() => file.imports.push('overwritten'), TypeError);
  assert.throws(() => file.terms.push('overwritten'), TypeError);
  assert.throws(() => { first.stats.files = 99; }, TypeError);
  index.invalidate([path.join(root, 'a.ts')]);
  const dirty = await index.refresh(signal());
  assert.equal(dirty.stats.processed, 1);
  assert.equal(dirty.stats.reused, 1);
  assert.deepEqual(workspace.reads, ['a.ts', 'b.ts', 'a.ts']);
  index.invalidate([]);
  assert.equal((await index.refresh(signal())).stats.reused, 2);
  index.invalidate();
  assert.equal((await index.refresh(signal())).stats.processed, 2);
  assert.deepEqual(names(first, 'a.ts'), ['alpha']);
});

test('symbol, import, identifier, and content limits are enforced and omissions are reported', async (t) => {
  const declarations = Array.from({ length: 380 }, (_, index) => `export const identifier${index} = ${index};`).join('\n');
  const imports = Array.from({ length: 100 }, (_, index) => `import "module${index}";`).join('\n');
  const { workspace, index } = await fixture(t, {
    'limits.ts': imports + '\n' + declarations,
    'long.ts': 'export function visible() {}\n' + ' '.repeat(WORKSPACE_LIMITS.maxReadChars) + '\nexport function omitted() {}',
    'oversize.ts': ' '.repeat(WORKSPACE_LIMITS.maxFileBytes + 1),
    'binary.ts': Buffer.from([0, 1, 2, 3]),
    'asset.bin': Buffer.from([0, 1, 2, 3]),
  });
  const snapshot = await index.refresh(signal());
  const limited = indexed(snapshot, 'limits.ts');
  assert.equal(limited.symbols.length, REPOSITORY_INDEX_LIMITS.symbols);
  assert.equal(limited.imports.length, REPOSITORY_INDEX_LIMITS.imports);
  assert.equal(limited.terms.length, REPOSITORY_INDEX_LIMITS.terms);
  assert.deepEqual(names(snapshot, 'long.ts'), ['visible']);
  for (const name of ['oversize.ts', 'binary.ts', 'asset.bin']) assert.deepEqual(indexed(snapshot, name).symbols, []);
  assert.equal(indexed(snapshot, 'asset.bin').language, 'unknown');
  assert.ok(!workspace.reads.includes('asset.bin'));
  assert.ok(!workspace.reads.includes('oversize.ts'));
  assert.equal(snapshot.truncated, true);
  const warm = await index.refresh(signal());
  assert.equal(warm.stats.reused, 5);
  assert.equal(warm.truncated, true);
});

test('aggregate source reads stay within eight MiB and omitted candidates are retried after reused files', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
    const source = `export function candidate${index}() {}\n`;
    return [`file${String(index).padStart(2, '0')}.ts`, source + ' '.repeat(WORKSPACE_LIMITS.maxFileBytes - Buffer.byteLength(source))];
  }));
  const { workspace, index } = await fixture(t, files);
  const first = await index.refresh(signal());
  assert.ok(workspace.bytesRead <= REPOSITORY_INDEX_LIMITS.readBytes);
  assert.ok(workspace.reads.length < 40);
  assert.equal(first.truncated, true);
  const omitted = first.files.filter(file => file.symbols.length === 0).map(file => file.path);
  assert.ok(omitted.length > 0);
  const beforeReads = workspace.reads.length;
  const beforeBytes = workspace.bytesRead;
  const second = await index.refresh(signal());
  assert.deepEqual(workspace.reads.slice(beforeReads), omitted);
  assert.ok(workspace.bytesRead - beforeBytes <= REPOSITORY_INDEX_LIMITS.readBytes);
  assert.ok(second.files.every(file => file.symbols.length === 1));
  assert.equal(second.stats.reused, 40 - omitted.length);
});

test('abort after a read never commits partial metadata and the next refresh rereads changed files', async (t) => {
  const { root, workspace, index } = await fixture(t, { 'a.ts': 'export const alpha = 1;', 'b.ts': 'export const beta = 1;' });
  const baseline = await index.refresh(signal());
  await fs.writeFile(path.join(root, 'a.ts'), 'export const updatedAlpha = 2;');
  await fs.writeFile(path.join(root, 'b.ts'), 'export const updatedBeta = 2;');
  const controller = new AbortController();
  workspace.afterRead = () => controller.abort();
  const statuses: RepositoryStatus[] = [];
  await assert.rejects(index.refresh(controller.signal, status => statuses.push(status)), errorCode('AGENT_CANCELLED'));
  assert.ok(!statuses.some(status => status.state === 'ready' || status.state === 'failed'));
  workspace.afterRead = undefined;
  const before = workspace.reads.length;
  const complete = await index.refresh(signal());
  assert.deepEqual(workspace.reads.slice(before), ['a.ts', 'b.ts']);
  assert.equal(complete.generation, baseline.generation + 1);
  assert.deepEqual(names(complete, 'a.ts'), ['updatedAlpha']);
  assert.deepEqual(names(baseline, 'a.ts'), ['alpha']);
});

test('concurrent refresh is rejected and watcher invalidation during a read prevents commit', async (t) => {
  const { workspace, index } = await fixture(t, { 'a.ts': 'export const alpha = 1;' });
  let release!: () => void;
  let announce!: () => void;
  const reading = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  workspace.afterRead = async () => { announce(); await gate; };
  const pending = index.refresh(signal());
  await reading;
  await assert.rejects(index.refresh(signal()), errorCode('PERMISSION_DENIED'));
  index.invalidate(['a.ts']);
  release();
  await assert.rejects(pending, errorCode('AGENT_CANCELLED'));
  workspace.afterRead = undefined;
  const refreshed = await index.refresh(signal());
  assert.equal(refreshed.generation, 1);
  assert.equal(refreshed.stats.processed, 1);
  assert.equal(workspace.reads.length, 2);
});

test('fresh post-read inventory rejects a changed ignore policy and the next refresh excludes old metadata', async (t) => {
  const { root, workspace, index } = await fixture(t, { 'a.ts': 'export class PublicSession {}' });
  const baseline = await index.refresh(signal());
  index.invalidate();
  workspace.afterRead = async () => { await fs.writeFile(path.join(root, '.littleignore'), 'a.ts\n'); };
  const statuses: RepositoryStatus[] = [];
  await assert.rejects(index.refresh(signal(), status => statuses.push(status)), errorCode('AGENT_CANCELLED'));
  assert.ok(!statuses.some(status => status.state === 'ready' || status.state === 'failed'));
  workspace.afterRead = undefined;
  const fresh = await index.refresh(signal());
  assert.equal(fresh.generation, baseline.generation + 1);
  assert.ok(!fresh.files.some(file => file.path === 'a.ts'));
  assert.ok(!JSON.stringify(fresh).includes('PublicSession'));
});

test('unexpected inventory failure is sanitized and progress never falsely reports ready', async (t) => {
  const { workspace, index } = await fixture(t, { 'a.ts': 'export const alpha = 1;' });
  const baseline = await index.refresh(signal());
  workspace.afterInventory = () => { throw new Error('private filesystem diagnostic gsk_private_value'); };
  const statuses: RepositoryStatus[] = [];
  await assert.rejects(index.refresh(signal(), status => statuses.push(status)), error => error instanceof LittleError && error.code === 'TOOL_FAILED' && !error.message.includes('private'));
  assert.equal(statuses.at(-1)?.state, 'failed');
  assert.ok(!statuses.some(status => status.state === 'ready'));
  assert.ok(!JSON.stringify(statuses).includes('private'));
  workspace.afterInventory = undefined;
  const restored = await index.refresh(signal(), () => { throw new Error('disposed UI'); });
  assert.equal(restored.generation, baseline.generation + 1);
  assert.equal(restored.stats.reused, 1);
});

test('oversized inventory is rejected before source reads and already-cancelled signals report cancellation', async (t) => {
  const { workspace, index } = await fixture(t, {});
  workspace.inventory = async () => ({ files: Array.from({ length: REPOSITORY_INDEX_LIMITS.files + 1 }, (_, number) => ({ path: `${number}.bin`, bytes: 1, modifiedMs: 1, createdMs: 1, ino: number, dev: 1 })), truncated: false, visitedEntries: 2001 });
  await assert.rejects(index.refresh(signal()), errorCode('CONTEXT_LIMIT'));
  assert.deepEqual(workspace.reads, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(index.refresh(controller.signal), errorCode('AGENT_CANCELLED'));
});
