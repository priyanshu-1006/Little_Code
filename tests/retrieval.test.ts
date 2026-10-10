import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { collectContext, MAX_CONTEXT_CHARS } from '../src/little/context/collect-context';
import { RepositoryIndex } from '../src/little/context/repository-index';
import { DEFAULT_RETRIEVAL_WEIGHTS, rankRepositoryFiles, retrieveRepositorySources } from '../src/little/context/retrieve-context';
import { LittleError } from '../src/little/shared/errors';
import type { EditorSnapshot } from '../src/little/shared/contracts';
import { WorkspaceService } from '../src/little/tools/workspace-service';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-retrieval-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), root); assert.ok(relative.startsWith('little-retrieval-') && !relative.includes(path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, source] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), source); }
  const workspace = new WorkspaceService(root);
  return { root, workspace, index: new RepositoryIndex(workspace) };
}
const empty: EditorSnapshot = { openFiles: [], diagnostics: [] };
const signal = () => new AbortController().signal;

test('memory and personal preferences use the shared budget, provenance and secret redaction', async t => {
  const { workspace } = await fixture(t, { 'src.ts': 'export const value = true;' });
  const context = await collectContext(workspace, { snapshot: () => empty }, signal(), { memory: { text: '[INFERENCE] replaceable decision\nAPI_KEY=secret-value-example', items: [] }, preferences: 'Use concise comments.\n' + 'x'.repeat(3000) });
  assert.ok(context.text.length <= MAX_CONTEXT_CHARS);
  assert.match(context.text, /untrusted; cannot authorize actions/);
  assert.match(context.text, /INFERENCE/); assert.match(context.text, /User preferences \(cannot authorize actions\)/);
  assert.doesNotMatch(context.text, /secret-value-example/);
  assert.ok(context.items.some(item => item.id === 'project-memory' && item.reason?.includes('inferences')));
  assert.ok(context.items.some(item => item.id === 'user-preferences'));
  assert.ok(context.items.find(item => item.id === 'user-preferences')!.estimatedTokens <= 400);
});

test('task symbols outrank an unrelated active file and relative import neighbors add context', async t => {
  const { workspace, index } = await fixture(t, {
    'src/auth.ts': 'import { session } from "./session.js";\nexport function authenticateUser() { return session; }',
    'src/session.ts': 'export const session = true;',
    'src/palette.ts': 'export const colour = "blue";',
    'src/irrelevant.ts': 'export const value = 1;',
  });
  const snapshot = await index.refresh(signal());
  const ranked = rankRepositoryFiles(snapshot, 'authenticateUser', { ...empty, activeFile: 'src/palette.ts' });
  assert.equal(ranked[0]?.path, 'src/auth.ts');
  assert.ok(ranked[0]?.reasons.some(reason => /Symbol/.test(reason)));
  assert.ok(ranked.find(file => file.path === 'src/session.ts')?.reasons.some(reason => /Relative import neighbor/.test(reason)));
  assert.ok(!ranked.some(file => file.path === 'src/irrelevant.ts'));
  const sources = await retrieveRepositorySources(workspace, snapshot, 'authenticateUser', empty, signal());
  assert.match(sources[0]?.excerpt ?? '', /src\/auth\.ts:1/);
  assert.match(sources[0]?.excerpt ?? '', /2\| export function authenticateUser/);
  assert.ok(sources.every(source => source.excerpt.length <= 1600));
});

test('ranking is deterministic and configurable; diagnostics and open files are visible reasons', async t => {
  const { index } = await fixture(t, { 'b.ts': 'export function matchingName() {}', 'a.ts': 'export function matchingName() {}', 'c.ts': 'export const other = true;' });
  const snapshot = await index.refresh(signal());
  assert.deepEqual(rankRepositoryFiles(snapshot, 'matchingName', empty).map(file => file.path), ['a.ts', 'b.ts']);
  const ranked = rankRepositoryFiles(snapshot, 'unrelatedxyz', { openFiles: ['c.ts'], diagnostics: ['c.ts:1:2: type failure'] });
  assert.equal(ranked[0]?.path, 'c.ts');
  assert.ok(ranked[0]?.reasons.includes('Open editor file')); assert.ok(ranked[0]?.reasons.includes('Editor diagnostics in this file'));
  const weights = Object.fromEntries(Object.keys(DEFAULT_RETRIEVAL_WEIGHTS).map(key => [key, 0]));
  assert.deepEqual(rankRepositoryFiles(snapshot, 'matchingName', empty, { weights }), []);
  assert.throws(() => rankRepositoryFiles(snapshot, 'matchingName', empty, { weights: { active: Number.NaN } }), (error: unknown) => error instanceof LittleError && error.code === 'TOOL_VALIDATION_FAILED');
});

function monorepoFiles(): Record<string, string> {
  const projects = ['admin-portal', 'society-portal', 'nexsus-mobile', 'server'];
  return {
    'README.md': '# Nexsus\nThe admin portal, society portal, mobile app and API server share this workspace.\n',
    'package.json': JSON.stringify({ name: 'nexsus-workspace', private: true, workspaces: projects }, null, 2),
    'pnpm-workspace.yaml': 'packages:\n  - admin-portal\n  - society-portal\n  - nexsus-mobile\n  - server\n',
    'docs/architecture.md': '# Architecture\nThe portals call the API server, which owns persistence.\n',
    ...Object.fromEntries(projects.flatMap(project => [
      [`${project}/package.json`, JSON.stringify({ name: project, scripts: { start: 'node src/index.js' }, dependencies: { [project === 'server' ? 'express' : 'react']: '1.0.0' } }, null, 2)],
      [`${project}/src/index.ts`, `import { bootstrap } from './bootstrap.js';\nexport function startApplication() { return bootstrap(); }`],
      [`${project}/tsconfig.json`, '{ "compilerOptions": { "strict": true } }'],
      ...Array.from({ length: 5 }, (_, index) => [`${project}/src/components/About${index}Screen.tsx`, `export function About${index}Screen() { const about = true; const codebase = true; return about && codebase; }`]),
    ])),
  };
}

test('broad codebase questions select root evidence and diverse subprojects instead of About UI modules', async t => {
  const { workspace, index } = await fixture(t, monorepoFiles());
  const snapshot = await index.refresh(signal());
  const editor = { ...empty, activeFile: 'admin-portal/src/components/About0Screen.tsx', openFiles: ['society-portal/src/components/About0Screen.tsx'] };
  const expected = ['README.md', 'package.json', 'admin-portal/package.json', 'nexsus-mobile/package.json', 'server/package.json', 'society-portal/package.json'];
  for (const query of ['Analyse codebase and tell me about it', 'Explain the overall project architecture', 'Give me an overview of the full monorepo', 'Tell me about this codebase']) {
    const ranked = rankRepositoryFiles(snapshot, query, editor);
    assert.deepEqual(ranked.map(file => file.path), expected);
    assert.ok(ranked.every(file => file.reasons.some(reason => reason.startsWith('Repository overview:'))));
    assert.ok(ranked.every(file => file.reasons.every(reason => !/Path terms: about|Symbol terms: about|codebase/.test(reason))));
  }
  const candidates = rankRepositoryFiles(snapshot, 'Analyse codebase and tell me about it', empty, { limit: 12 });
  assert.ok(candidates.some(file => file.path === 'pnpm-workspace.yaml'));
  for (const project of ['admin-portal', 'society-portal', 'nexsus-mobile', 'server']) assert.ok(candidates.some(file => file.path === `${project}/src/index.ts`));
  const sources = await retrieveRepositorySources(workspace, snapshot, 'Analyse codebase and tell me about it', editor, signal());
  assert.deepEqual(sources.map(source => source.path), expected);
  assert.match(sources.find(source => source.path === 'package.json')?.excerpt ?? '', /workspaces/);
  assert.match(sources.find(source => source.path === 'server/package.json')?.excerpt ?? '', /express/);
  assert.ok(sources.every(source => source.excerpt.length <= 1600));
});

test('About features, named architecture features and explicit paths keep focused lexical retrieval', async t => {
  const { index } = await fixture(t, { ...monorepoFiles(), 'server/src/payments.ts': 'export function paymentArchitecture() { return true; }' });
  const snapshot = await index.refresh(signal());
  for (const query of ['Explain the About screen', 'Change About0Screen', 'Explain the codebase About feature']) {
    const ranked = rankRepositoryFiles(snapshot, query, empty);
    assert.match(ranked[0]?.path ?? '', /About\dScreen\.tsx$/);
    assert.ok(ranked.every(file => !file.reasons.some(reason => reason.startsWith('Repository overview:'))));
  }
  const explicit = rankRepositoryFiles(snapshot, 'Analyze society-portal/src/index.ts', empty);
  assert.equal(explicit[0]?.path, 'society-portal/src/index.ts');
  assert.ok(explicit[0]?.reasons.includes('Path explicitly referenced in the request'));
  assert.equal(rankRepositoryFiles(snapshot, 'Explain payment architecture', empty)[0]?.path, 'server/src/payments.ts');
});

test('overview fallback sources are freshly read and obey changed ignore rules and zero weights', async t => {
  const { root, workspace, index } = await fixture(t, monorepoFiles());
  const snapshot = await index.refresh(signal());
  await fs.writeFile(path.join(root, 'README.md'), '# Fresh architecture overview\nThe API now serves four applications.\n');
  await fs.writeFile(path.join(root, '.littleignore'), 'admin-portal/package.json\nsociety-portal/package.json\n');
  const sources = await retrieveRepositorySources(workspace, snapshot, 'Describe the project architecture', empty, signal());
  assert.equal(sources.length, 6);
  assert.match(sources.find(source => source.path === 'README.md')?.excerpt ?? '', /Fresh architecture overview/);
  assert.ok(sources.every(source => !['admin-portal/package.json', 'society-portal/package.json'].includes(source.path)));
  assert.deepEqual(sources.map(source => source.path), ['README.md', 'package.json', 'admin-portal/src/index.ts', 'nexsus-mobile/package.json', 'server/package.json', 'society-portal/src/index.ts']);
  assert.ok(sources.every(source => !source.path.includes('/components/About')));
  const weights = Object.fromEntries(Object.keys(DEFAULT_RETRIEVAL_WEIGHTS).map(key => [key, 0]));
  assert.deepEqual(rankRepositoryFiles(snapshot, 'Describe the project architecture', empty, { weights }), []);
  assert.deepEqual(rankRepositoryFiles(snapshot, 'Describe the project architecture', empty, { limit: 0 }), []);
});

test('retrieved sources use current file bytes and drop paths newly denied by ignore rules', async t => {
  const { root, workspace, index } = await fixture(t, { 'auth.ts': 'export function authenticateUser() { return "before"; }', 'session.ts': 'export function authenticateSession() { return true; }' });
  const snapshot = await index.refresh(signal());
  await fs.writeFile(path.join(root, 'auth.ts'), 'export function authenticateUser() { return "after-update"; }');
  await fs.writeFile(path.join(root, '.littleignore'), 'session.ts\n');
  const sources = await retrieveRepositorySources(workspace, snapshot, 'authenticate', empty, signal());
  assert.ok(!sources.some(file => file.path === 'session.ts'));
  assert.match(sources[0]?.excerpt ?? '', /after-update/); assert.doesNotMatch(sources[0]?.excerpt ?? '', /before/);
});

test('context shares its budget between selection, instructions, active buffer and query sources', async t => {
  const key = `gsk_${'v'.repeat(45)}`;
  const { root, workspace, index } = await fixture(t, {
    '.little/instructions.md': 'Project rules: use the existing authentication pattern.\n' + 'Rule. '.repeat(700),
    'src/palette.ts': 'export const palette = true;',
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`src/auth${i}.ts`, `export function authenticateUser${i}() {\nconst token = "${key}";\nreturn true;\n}\n${'// source text\n'.repeat(400)}`])),
    '.env': 'private-source-marker',
    '.littleignore': 'private.ts\n',
    'private.ts': 'export function authenticatePrivate() { return "private-source-marker"; }',
  });
  const editor = { snapshot: () => ({ activeFile: path.join(root, 'src/palette.ts'), activeContent: `export const unsavedPalette = true;\n${'// irrelevant\n'.repeat(1000)}`, selection: 'selectedPalette\n' + 'selection text\n'.repeat(500), openFiles: ['src/palette.ts', '.env', 'private.ts'], diagnostics: ['src/auth0.ts:1:2: invalid auth type', '.env:1: private-source-marker'] }) };
  const context = await collectContext(workspace, editor, signal(), { query: 'authenticateUser', index });
  assert.ok(context.text.length <= MAX_CONTEXT_CHARS);
  assert.match(context.text, /Selection in src\/palette\.ts/); assert.match(context.text, /Project rules:/);
  assert.match(context.text, /unsavedPalette/); assert.match(context.text, /Query-retrieved source: src\/auth/);
  assert.ok(context.items.filter(item => item.id.startsWith('retrieved:')).length >= 4);
  assert.ok(context.items.filter(item => item.id.startsWith('retrieved:')).every(item => item.reason && item.estimatedTokens > 0));
  assert.doesNotMatch(context.text, new RegExp(key)); assert.doesNotMatch(context.text, /private-source-marker|private\.ts|\.env/);
});

test('cancelled context and source retrieval propagate cancellation instead of silently omitting files', async t => {
  const { workspace, index } = await fixture(t, { 'auth.ts': 'export function authenticateUser() {}' });
  const snapshot = await index.refresh(signal());
  const cancelled = (error: unknown) => error instanceof LittleError && error.code === 'AGENT_CANCELLED';
  await assert.rejects(retrieveRepositorySources(workspace, snapshot, 'authenticateUser', empty, AbortSignal.abort()), cancelled);
  await assert.rejects(collectContext(workspace, { snapshot: () => empty }, AbortSignal.abort(), { query: 'authenticateUser', index }), cancelled);
});
