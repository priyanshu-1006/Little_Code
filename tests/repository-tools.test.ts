import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { RepositoryIndex } from '../src/little/context/repository-index';
import { createRepositoryTools } from '../src/little/tools/repository-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';
import { LittleError } from '../src/little/shared/errors';
import { AgentRuntime } from '../src/little/agent/runtime';
import type { AgentTool, LLMEvent, LLMProvider, RuntimeEvent } from '../src/little/shared/contracts';

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-repository-tools-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), root); assert.ok(relative.startsWith('little-repository-tools-') && !relative.includes(path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  for (const [name, content] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), content); }
  const workspace = new WorkspaceService(root);
  const tools = createRepositoryTools({ snapshot: () => ({ openFiles: [], diagnostics: [] }) }, new RepositoryIndex(workspace));
  return { root, tools, execute: async (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute(input, { signal: new AbortController().signal }) };
}

test('repository tools expose protected metadata and task reasons, then refresh changed policy', async t => {
  const { root, tools, execute } = await fixture(t, {
    'src/auth.ts': 'export function authenticateUser() { return true; }',
    'src/palette.ts': 'export function chooseColour() { return "blue"; }',
    '.env': 'GROQ_API_KEY=secret-marker',
    'generated/client.ts': 'export function GeneratedCredential() {}',
  });
  assert.ok(tools.every(tool => tool.risk === 'SAFE'));
  const map = JSON.stringify(await execute('get_repository_map', {}));
  assert.match(map, /authenticateUser/); assert.doesNotMatch(map, /secret-marker|GeneratedCredential|\.env|content/);
  const relevant = await execute('find_relevant_files', { query: 'authenticate user' }) as { matches: { path: string; reasons: string[] }[] };
  assert.equal(relevant.matches[0]?.path, 'src/auth.ts'); assert.ok(relevant.matches[0]?.reasons.length);
  const symbol = await execute('search_symbol', { query: 'authenticate' }) as { matches: { path: string; line: number }[] };
  assert.equal(symbol.matches[0]?.line, 1);
  await fs.writeFile(path.join(root, '.littleignore'), 'src/auth.ts\n');
  assert.doesNotMatch(JSON.stringify(await execute('get_repository_map', {})), /authenticateUser/);
  assert.deepEqual((await execute('search_symbol', { query: 'authenticate' }) as { matches: unknown[] }).matches, []);
});

test('symbols refresh actual file content and tool arguments/cancellation are strict', async t => {
  const { root, tools, execute } = await fixture(t, { 'app.ts': 'export function beforeChange() {}' });
  await execute('get_repository_map', {});
  await fs.writeFile(path.join(root, 'app.ts'), 'export function afterChangeWithNewName() {}');
  assert.match(JSON.stringify(await execute('search_symbol', { query: 'afterChange' })), /afterChangeWithNewName/);
  assert.deepEqual((await execute('search_symbol', { query: 'beforeChange' }) as { matches: unknown[] }).matches, []);
  const invalid = (error: unknown) => error instanceof LittleError && error.code === 'TOOL_VALIDATION_FAILED';
  await assert.rejects(execute('get_repository_map', { command: 'npm test' }), invalid);
  await assert.rejects(execute('find_relevant_files', { query: ' ', limit: 13 }), invalid);
  await assert.rejects(execute('search_symbol', { query: 'after', path: '../private.ts' }), invalid);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools[0]!.execute({}, { signal: controller.signal }), (error: unknown) => error instanceof LittleError && error.code === 'AGENT_CANCELLED');
});

test('large repository metadata and matching-symbol outputs stay bounded', async t => {
  const declarations = Array.from({ length: 100 }, (_, i) => `export function SharedSymbol${i}${'x'.repeat(100)}() {}`).join('\n');
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`source${i}${'x'.repeat(100)}.ts`, declarations]));
  const { execute } = await fixture(t, files);
  for (const [name, args] of [['get_repository_map', { limit: 100 }], ['search_symbol', { query: 'SharedSymbol', limit: 50 }]] as const) {
    const output = await execute(name, args) as { truncated: boolean; matches: unknown[] };
    assert.ok(JSON.stringify(output).length <= 18_000); assert.equal(output.truncated, true); assert.ok(output.matches.length);
  }
});

test('an index map and published plan cannot bypass the Agent source-inspection prerequisite', async t => {
  const { tools } = await fixture(t, { 'auth.ts': 'export function authenticateUser() {}' });
  let wrote = false, turn = 0;
  const call = (id: string, name: string, input: unknown): LLMEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(input) } });
  const turns: LLMEvent[][] = [
    [call('map', 'get_repository_map', {}), call('plan', 'update_plan', { steps: ['Inspect source before proposing changes'] })],
    [call('edit', 'propose_file_edits', {})],
    [{ type: 'text', text: 'Source inspection is still required.' }],
  ];
  const provider: LLMProvider = { id: 'fixture', async listModels() { return []; }, async *stream() { const events = turns[turn++]!; yield* events; yield { type: 'done', reason: events.some(event => event.type === 'tool_call') ? 'tool_calls' : 'stop' }; } };
  const write: AgentTool = { name: 'propose_file_edits', description: 'Fixture write', parameters: { type: 'object' }, risk: 'WORKSPACE_WRITE', validate: input => input, async execute() { wrote = true; } };
  const runtime = new AgentRuntime(provider, [...tools, write], async () => ({ text: 'Initial indexed context does not authorize edits', items: [] }));
  const events: RuntimeEvent[] = []; runtime.events.subscribe(event => events.push(event));
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Inspect and improve authentication' });
  assert.equal(wrote, false);
  assert.ok(events.some(event => event.type === 'tool.completed' && event.name === 'get_repository_map'));
  assert.ok(events.some(event => event.type === 'tool.failed' && event.callId === 'edit' && event.code === 'PERMISSION_DENIED'));
});
