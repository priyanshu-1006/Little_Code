import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { collectContext, MAX_CONTEXT_CHARS } from '../src/little/context/collect-context';
import { EDITOR_CONTEXT_LIMITS, getDiagnosticsContext } from '../src/little/context/editor-context';
import { redactSecrets } from '../src/little/context/redact-secrets';
import type { EditorService, EditorSnapshot } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';
import { WORKSPACE_LIMITS, WorkspaceService } from '../src/little/tools/workspace-service';

async function fixture(t: TestContext, files: Record<string, string | Buffer> = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'little-code-workspace-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), temporaryRoot);
    assert.ok(relative.startsWith('little-code-workspace-') && !relative.includes(path.sep));
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });
  const root = path.join(temporaryRoot, 'workspace');
  const outside = path.join(temporaryRoot, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { root, outside, workspace: new WorkspaceService(root) };
}

function errorCode(code: LittleError['code']) {
  return (error: unknown) => error instanceof LittleError && error.code === code;
}
function editor(snapshot: Partial<EditorSnapshot> = {}): EditorService {
  return { snapshot: () => ({ openFiles: [], diagnostics: [], ...snapshot }) };
}

test('workspace boundaries reject traversal and absolute external paths', async (t) => {
  const { root, outside, workspace } = await fixture(t, { 'safe.ts': 'export const safe = true;' });
  await fs.writeFile(path.join(outside, 'private.ts'), 'external content');
  for (const input of ['../outside/private.ts', '..\\outside\\private.ts', path.join(outside, 'private.ts'), 'C:private.ts']) {
    await assert.rejects(workspace.readFile(input), errorCode('WORKSPACE_BOUNDARY_VIOLATION'));
  }
  assert.equal((await workspace.readFile(path.join(root, 'safe.ts'))).path, 'safe.ts');
  assert.equal((await workspace.readFile('src/../safe.ts')).content, 'export const safe = true;');
  await assert.rejects(workspace.readFile('safe.ts\u0000'), errorCode('TOOL_VALIDATION_FAILED'));
});

test('root and nested ignores apply to listings, search, and explicit reads', async (t) => {
  const { workspace } = await fixture(t, {
    '.gitignore': '*.cache\nhidden/\n!hidden/reinclude.ts\nroot-only.txt\n',
    '.littleignore': 'private.txt\n',
    'src/.gitignore': '!keep.cache\nnested.txt\n',
    'src/.littleignore': 'little.txt\n',
    'src/keep.cache': 'visible-match',
    'src/drop.cache': 'hidden-match',
    'src/nested.txt': 'hidden-match',
    'src/little.txt': 'hidden-match',
    'src/normal.ts': 'visible-match',
    'private.txt': 'hidden-match',
    'root-only.txt': 'hidden-match',
    'hidden/reinclude.ts': 'hidden-match',
    'node_modules/library.ts': 'hidden-match',
    'generated/client.ts': 'hidden-match',
    'vendor/library.ts': 'hidden-match',
  });
  const files = await workspace.searchFiles('');
  assert.ok(files.matches.includes('src/keep.cache'));
  assert.ok(files.matches.includes('src/normal.ts'));
  for (const input of ['src/drop.cache', 'src/nested.txt', 'src/little.txt', 'private.txt', 'root-only.txt', 'hidden/reinclude.ts', 'node_modules/library.ts', 'generated/client.ts', 'vendor/library.ts']) {
    assert.ok(!files.matches.includes(input), input);
    await assert.rejects(workspace.readFile(input), errorCode('PERMISSION_DENIED'));
  }
  assert.deepEqual((await workspace.searchText('hidden-match')).matches, []);
  assert.ok(!(await workspace.listDirectory()).entries.some((entry) => entry.name === 'hidden'));
});

test('ignore updates are applied on the next operation', async (t) => {
  const { root, workspace } = await fixture(t, { 'visible.ts': 'visible content' });
  assert.equal((await workspace.readFile('visible.ts')).content, 'visible content');
  await fs.writeFile(path.join(root, '.littleignore'), 'visible.ts\n');
  await assert.rejects(workspace.readFile('visible.ts'), errorCode('PERMISSION_DENIED'));
});

test('sensitive paths are denied even when files are explicitly requested', async (t) => {
  const names = ['.env', '.env.example', '.env.production', '.git/config', 'credentials.json', 'nested/.env.local', 'id_rsa', 'private.pem', '.npmrc'];
  const { workspace } = await fixture(t, Object.fromEntries(names.map((name) => [name, 'private-value'])));
  for (const name of names) await assert.rejects(workspace.readFile(name), errorCode('PERMISSION_DENIED'));
  assert.deepEqual((await workspace.searchFiles('')).matches, []);
  assert.deepEqual((await workspace.searchText('private-value')).matches, []);
});

test('directory symlinks cannot escape boundaries or alias sensitive targets', async (t) => {
  const { root, outside, workspace } = await fixture(t, { 'credentials/private.ts': 'private-value', 'source/public.ts': 'public-value' });
  await fs.writeFile(path.join(outside, 'outside.ts'), 'private-value');
  try {
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(root, 'credentials'), path.join(root, 'innocent'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(root, 'source'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Host does not allow creating symbolic links.'); return; }
    throw error;
  }
  await assert.rejects(workspace.readFile('escape/outside.ts'), errorCode('WORKSPACE_BOUNDARY_VIOLATION'));
  await assert.rejects(workspace.readFile('innocent/private.ts'), errorCode('PERMISSION_DENIED'));
  assert.equal((await workspace.readFile('alias/public.ts')).path, 'source/public.ts');
  assert.deepEqual((await workspace.searchText('private-value')).matches, []);
});

test('source reading and literal search redact likely credentials and preserve source line numbers', async (t) => {
  const key = `gsk_${'a'.repeat(40)}`;
  const { workspace } = await fixture(t, {
    'auth.ts': `export const ready = true;\nconst apiKey = "${key}";\nconst password = "very-private";\nconst pem = \`-----BEGIN PRIVATE KEY-----\nBASE64PRIVATECONTENT\n-----END PRIVATE KEY-----\`;\nexport function validateSession() { return true; }\n`,
  });
  const file = await workspace.readFile('auth.ts');
  assert.ok(!file.content.includes(key));
  assert.ok(!file.content.includes('very-private'));
  assert.ok(!file.content.includes('BASE64PRIVATECONTENT'));
  const range = await workspace.readRange('auth.ts', 7, 7);
  assert.equal(range.content, 'export function validateSession() { return true; }');
  const matches = (await workspace.searchText('validateSession')).matches;
  assert.equal(matches[0]?.line, 7);
  assert.deepEqual((await workspace.searchText(key)).matches, []);
  assert.deepEqual((await workspace.searchText('very-private')).matches, []);
});

test('read, range, binary, and search response budgets are enforced', async (t) => {
  const { workspace } = await fixture(t, {
    'large.ts': 'a'.repeat(WORKSPACE_LIMITS.maxReadChars + 100),
    'huge.ts': 'a'.repeat(WORKSPACE_LIMITS.maxFileBytes + 1),
    'binary.dat': Buffer.from([0, 1, 2, 3]),
    'matches.ts': Array.from({ length: WORKSPACE_LIMITS.maxSearchResults + 5 }, (_, index) => `match-line-${index}`).join('\n'),
    'unicode.ts': 'const message = "नमस्ते";',
  });
  const file = await workspace.readFile('large.ts');
  assert.equal(file.content.length, WORKSPACE_LIMITS.maxReadChars);
  assert.equal(file.truncated, true);
  await assert.rejects(workspace.readFile('huge.ts'), errorCode('CONTEXT_LIMIT'));
  await assert.rejects(workspace.readFile('binary.dat'), errorCode('TOOL_FAILED'));
  await assert.rejects(workspace.readRange('matches.ts', 3, 2), errorCode('TOOL_VALIDATION_FAILED'));
  await assert.rejects(workspace.readRange('matches.ts', 1, WORKSPACE_LIMITS.maxRangeLines + 1), errorCode('TOOL_VALIDATION_FAILED'));
  const results = await workspace.searchText('match-line');
  assert.equal(results.matches.length, WORKSPACE_LIMITS.maxSearchResults);
  assert.equal(results.truncated, true);
  assert.ok((await workspace.readFile('unicode.ts')).content.includes('नमस्ते'));
});

test('directory and filename searches stop at bounded result counts', async (t) => {
  const files = Object.fromEntries(Array.from({ length: WORKSPACE_LIMITS.maxDirectoryEntries + 5 }, (_, index) => [`file-${index}.ts`, 'export {};']));
  const { workspace } = await fixture(t, files);
  const directory = await workspace.listDirectory();
  assert.equal(directory.entries.length, WORKSPACE_LIMITS.maxDirectoryEntries);
  assert.equal(directory.truncated, true);
  const results = await workspace.searchFiles('file-');
  assert.equal(results.matches.length, WORKSPACE_LIMITS.maxSearchResults);
  assert.equal(results.truncated, true);
});

test('cancellation is checked before access and during asynchronous traversal', async (t) => {
  const { workspace } = await fixture(t, Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/file-${index}.ts`, 'export {};'])));
  const stopped = AbortSignal.abort();
  await assert.rejects(workspace.readFile('src/file-0.ts', stopped), errorCode('AGENT_CANCELLED'));
  await assert.rejects(workspace.listDirectory('.', stopped), errorCode('AGENT_CANCELLED'));
  const controller = new AbortController();
  const search = workspace.searchFiles('file-', controller.signal);
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(search, errorCode('AGENT_CANCELLED'));
});

test('tool schemas are strict and execution validates unknown input', async (t) => {
  const { workspace } = await fixture(t, { 'safe.ts': 'export {};' });
  const tools = createReadOnlyTools(workspace, editor());
  assert.ok(tools.some(tool => tool.name === 'inspect_file'));
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.equal(tool.risk, 'SAFE');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.throws(() => tool.validate({ unexpected: true }), errorCode('TOOL_VALIDATION_FAILED'));
  }
  const read = tools.find((tool) => tool.name === 'read_file');
  assert.ok(read);
  await assert.rejects(read.execute({ path: 'safe.ts', surprise: 'value' }, { signal: new AbortController().signal }), errorCode('TOOL_VALIDATION_FAILED'));
  const range = tools.find((tool) => tool.name === 'read_range');
  assert.ok(range);
  assert.throws(() => range.validate({ path: 'safe.ts', startLine: 1.5, endLine: 3 }), errorCode('TOOL_VALIDATION_FAILED'));
  assert.throws(() => range.validate({ path: 'safe.ts', startLine: 3, endLine: 1 }), errorCode('TOOL_VALIDATION_FAILED'));
});

test('context uses permitted editor state with bounded redaction and visible provenance', async (t) => {
  const { root, workspace } = await fixture(t, { 'safe.ts': 'saved content', '.env': 'private-value' });
  const key = `gsk_${'z'.repeat(40)}`;
  const state = editor({
    activeFile: path.join(root, 'safe.ts'), activeContent: `const apiKey = "${key}";\n${'x'.repeat(20_000)}`,
    selection: `const password = "private-value";\n${'x'.repeat(6_000)}`,
    openFiles: [path.join(root, 'safe.ts'), path.join(root, '.env')],
    diagnostics: [`safe.ts:1: invalid token ${key}`, ...Array.from({ length: 40 }, () => 'x'.repeat(1_000))],
  });
  const context = await collectContext(workspace, state, new AbortController().signal);
  assert.ok(context.text.includes('Active file: safe.ts'));
  assert.ok(context.text.includes('Selected') || context.text.includes('Selection'));
  assert.ok(!context.text.includes(key));
  assert.ok(!context.text.includes('private-value'));
  assert.ok(!context.text.includes('.env'));
  assert.ok(context.text.length <= MAX_CONTEXT_CHARS);
  assert.ok(context.items.some((item) => item.type === 'file'));
  assert.ok(context.items.some((item) => item.type === 'selection'));
  assert.ok(context.items.every((item) => item.estimatedTokens > 0));
  const active = createReadOnlyTools(workspace, state).find((tool) => tool.name === 'get_active_file');
  assert.ok(active);
  const response = await active.execute({}, { signal: new AbortController().signal }) as { content: string; truncated: boolean };
  assert.ok(response.content.length <= EDITOR_CONTEXT_LIMITS.activeChars);
  assert.equal(response.truncated, true);
});

test('private active files never bypass context policy through unsaved content or selection', async (t) => {
  const { root, workspace } = await fixture(t, { 'safe.ts': 'safe content', '.env': 'private-value' });
  const state = editor({ activeFile: path.join(root, '.env'), activeContent: 'private-value', selection: 'private-value', openFiles: [path.join(root, '.env')] });
  const context = await collectContext(workspace, state, new AbortController().signal);
  assert.ok(!context.text.includes('private-value'));
  assert.ok(!context.items.some((item) => item.type === 'file' || item.type === 'selection'));
  for (const name of ['get_active_file', 'get_selection']) {
    const tool = createReadOnlyTools(workspace, state).find((candidate) => candidate.name === name);
    assert.ok(tool);
    await assert.rejects(tool.execute({}, { signal: new AbortController().signal }), errorCode('PERMISSION_DENIED'));
  }
  await assert.rejects(collectContext(workspace, state, AbortSignal.abort()), errorCode('AGENT_CANCELLED'));
});

test('diagnostics require a permitted workspace source before entering model context', async (t) => {
  const { root, outside, workspace } = await fixture(t, { 'safe.ts': 'safe content', '.env': 'private-value', 'ignored.ts': 'private-value', '.littleignore': 'ignored.ts\n' });
  await fs.writeFile(path.join(outside, 'outside.ts'), 'private-value');
  const state = editor({ diagnostics: [
    'safe.ts:3:2: valid diagnostic',
    `${path.join(root, 'safe.ts')}:4: another valid diagnostic`,
    '.env:1: private-value',
    'ignored.ts:1: private-value',
    `${path.join(outside, 'outside.ts')}:1: private-value`,
    'Unparseable private-value diagnostic',
  ] });
  const diagnostics = await getDiagnosticsContext(workspace, state, new AbortController().signal);
  assert.deepEqual(diagnostics.diagnostics, ['safe.ts:3:2: valid diagnostic', 'safe.ts:4: another valid diagnostic']);
  const context = await collectContext(workspace, state, new AbortController().signal);
  assert.ok(!context.text.includes('private-value'));
  const tool = createReadOnlyTools(workspace, state).find((candidate) => candidate.name === 'get_diagnostics');
  assert.ok(tool);
  const result = await tool.execute({}, { signal: new AbortController().signal }) as { diagnostics: string[] };
  assert.deepEqual(result.diagnostics, diagnostics.diagnostics);
});

test('optional project instructions are bounded and respect workspace ignore policy', async (t) => {
  const { root, workspace } = await fixture(t, { '.little/instructions.md': `Use existing TypeScript patterns.\n${'x'.repeat(5_000)}` });
  const context = await collectContext(workspace, editor(), new AbortController().signal);
  assert.ok(context.text.includes('Use existing TypeScript patterns.'));
  assert.ok(context.text.includes('[Project instructions truncated]'));
  assert.ok(context.items.some((item) => item.label === 'Project instructions'));
  await fs.writeFile(path.join(root, '.littleignore'), '.little/\n');
  const ignored = await collectContext(workspace, editor(), new AbortController().signal);
  assert.ok(!ignored.items.some((item) => item.label === 'Project instructions'));
  await fs.unlink(path.join(root, '.little', 'instructions.md'));
  const missing = await collectContext(workspace, editor(), new AbortController().signal);
  assert.ok(!missing.items.some((item) => item.label === 'Project instructions'));
});

test('redaction handles provider tokens, JWTs, passwords, private keys, and URL credentials', () => {
  const text = `token = ghp_${'a'.repeat(30)}\npassword: 'private-password'\nAuthorization: Bearer private-token\nhttps://user:private-password@host/path\neyJhbGciOiJIUzI1NiJ9.payload.signature\n-----BEGIN RSA PRIVATE KEY-----\nPRIVATE\n-----END RSA PRIVATE KEY-----`;
  const result = redactSecrets(text);
  for (const secret of ['private-password', 'private-token', `ghp_${'a'.repeat(30)}`, 'payload.signature', '\nPRIVATE\n']) assert.ok(!result.includes(secret));
  assert.ok(result.includes('[REDACTED'));
  assert.equal(result.split('\n').length, text.split('\n').length);
});

test('redaction stays responsive on long ordinary source identifiers', () => {
  const text = 'x'.repeat(WORKSPACE_LIMITS.maxFileBytes);
  const started = performance.now();
  assert.equal(redactSecrets(text), text);
  assert.ok(performance.now() - started < 1_000, 'Redaction must not backtrack quadratically over source text.');
});
