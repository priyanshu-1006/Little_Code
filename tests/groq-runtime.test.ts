import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentRuntime } from '../src/little/agent/runtime';
import { GroqProvider } from '../src/little/providers/groq';
import { groqNativeRequest } from '../src/little/providers/groq-request';
import { REQUEST_BUDGET_LIMITS } from '../src/little/context/request-budget';
import type { AgentMode, AgentTool, LLMEvent, LLMRequest, RuntimeEvent } from '../src/little/shared/contracts';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';
import { createEditTools } from '../src/little/tools/edit-tools';
import type { EditProposalService } from '../src/little/tools/edit-proposals';
import { createCommandTools } from '../src/little/tools/command-tools';
import type { ProjectCommandService } from '../src/little/tools/command-service';
import { WorkspaceService } from '../src/little/tools/workspace-service';

type WireRequest = ReturnType<typeof groqNativeRequest>;
interface FixtureTurn { calls?: { id?: string; name: string; arguments: string }[]; text?: string; finish?: string; omitDone?: boolean }
const models = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
const decision = (name: string, args: unknown): FixtureTurn => ({ calls: [{ name, arguments: JSON.stringify(args) }] });
const answer = (text: string): FixtureTurn => ({ text });
const context = async () => ({ text: 'Source entrypoint: src/auth.ts. Inspect current repository source before answering.', items: [] });

class RecordingGroqProvider extends GroqProvider {
  readonly canonical: LLMRequest[] = [];
  override async *stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMEvent> {
    const original = structuredClone(request);
    this.canonical.push(original);
    try { yield* super.stream(request, signal); }
    finally { assert.deepEqual(request, original, 'Provider wire rewriting must not mutate host history or tool definitions.'); }
  }
}

function transport(turns: FixtureTurn[]) {
  const wire: WireRequest[] = [];
  const groq = new RecordingGroqProvider({ get: async () => 'fixture-only-key', store: async () => undefined, delete: async () => undefined }, async (url, init) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(String(init.body)) as WireRequest;
    wire.push(body);
    assert.ok(wire.length <= turns.length, 'No replay or extra generation is permitted after the final answer.');
    const turn = turns[wire.length - 1]!;
    const data = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
    const calls = turn.calls?.map((call, index) => ({ index, id: call.id ?? `call_runtime_${wire.length}_${index}`, type: 'function',
      function: { name: call.name, arguments: call.arguments } }));
    return new Response(data({ choices: [{ index: 0, delta: calls ? { tool_calls: calls } : { content: turn.text }, finish_reason: null }] }) +
      data({ choices: [{ index: 0, delta: {}, finish_reason: turn.finish ?? (calls ? 'tool_calls' : 'stop') }] }) +
      data({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 40 }, x_groq: { id: `req_runtime_${wire.length}` } }) +
      (turn.omitDone ? '' : 'data: [DONE]\r\n\r\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  return { groq, wire };
}

async function workspaceFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-groq-runtime-'));
  t.after(async () => {
    const target = path.relative(os.tmpdir(), root);
    assert.ok(target.startsWith('little-groq-runtime-') && !target.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/auth.ts'), 'export function login() {\n  return "current-source-evidence";\n}\n');
  const workspace = new WorkspaceService(root);
  return { root, tools: createReadOnlyTools(workspace, { snapshot: () => ({ openFiles: [], diagnostics: [] }) }) };
}

function capture(runtime: AgentRuntime): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  return events;
}

function offeredNames(body: WireRequest): string[] {
  return body.tools?.map(tool => tool.function.name) ?? [];
}
function assertNativeWire(body: WireRequest, canonical: LLMRequest) {
  assert.deepEqual(body, groqNativeRequest(canonical));
  assert.equal(body.stream, true);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, 'auto');
  assert.equal('response_format' in body, false);
  assert.ok(offeredNames(body).includes('read_file'), 'Mandatory evidence reading must survive budgeting.');
  const wireEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 3) + 64 + (canonical.tools?.length ?? 0) * 8;
  assert.ok(wireEstimate + body.max_completion_tokens! <= REQUEST_BUDGET_LIMITS.groqTokens, 'The actual native schemas and canonical tool history must fit the request ceiling.');
}

test('actual GPT OSS provider and runtime execute one native read then answer with canonical tool feedback', async t => {
  for (const model of models) for (const selection of [
    { name: 'read_file', args: { path: 'src/auth.ts' }, normalized: { path: 'src/auth.ts' } },
    { name: 'search_text', args: { query: 'login' }, normalized: { query: 'login', path: '.', caseSensitive: false } },
  ]) await t.test(`${model} / ${selection.name}`, async child => {
    const { tools } = await workspaceFixture(child);
    const sourceTool = tools.find(tool => tool.name === selection.name)!;
    const schemaBefore = JSON.stringify(tools.map(tool => tool.parameters));
    let executed = 0;
    const validated: unknown[] = [];
    const wrapped = tools.map(tool => tool === sourceTool ? { ...tool,
      validate(input: unknown) { const result = tool.validate(input); validated.push(result); return result; },
      async execute(input, toolContext) { executed++; return tool.execute(input, toolContext); },
    } satisfies AgentTool : tool);
    const text = selection.name === 'read_file' ? 'Authentication is in src/auth.ts:1; login returns current-source-evidence.' : 'The search found login declared in src/auth.ts:1.';
    const { groq, wire } = transport([decision(selection.name, selection.args), answer(text)]);
    const runtime = new AgentRuntime(groq, wrapped, context);
    const events = capture(runtime);
    await runtime.run({ mode: 'ask', model, prompt: 'Inspect authentication source and explain login.' });
    assert.equal(runtime.busy, false);
    assert.equal(executed, 1);
    assert.deepEqual(validated, [selection.normalized]);
    assert.equal(wire.length, 2);
    assert.equal(events.at(-1)?.type, 'agent.completed', JSON.stringify(events.find(event => event.type === 'agent.failed')));
    assert.equal(events.filter(event => event.type === 'tool.completed').length, 1);
    assert.equal(events.some(event => event.type === 'tool.failed' || event.type === 'agent.failed'), false);
    assert.equal(events.filter(event => event.type === 'agent.text.delta').map(event => event.text).join(''), text);
    assert.equal(groq.canonical[0]!.messages.length, 2);
    const history = groq.canonical[1]!.messages;
    const call = history.find(message => message.role === 'assistant')!.toolCalls![0]!;
    assert.equal(call.name, selection.name);
    assert.deepEqual(JSON.parse(call.arguments), selection.name === 'search_text' ? { query: 'login' } : selection.args);
    assert.equal(history.find(message => message.role === 'tool')?.toolCallId, call.id);
    const observation = history.find(message => message.role === 'tool')?.content ?? '';
    assert.match(observation, /login/);
    if (selection.name === 'read_file') assert.match(observation, /current-source-evidence/);
    else assert.deepEqual(JSON.parse(observation).matches, [{ path: 'src/auth.ts', line: 1, text: 'export function login() {' }]);
    assert.equal(wire[1]!.messages.find(message => message.role === 'assistant')?.tool_calls?.[0]?.id, call.id);
    assert.equal(wire[1]!.messages.at(-1)?.role, 'tool');
    assert.equal(wire[1]!.messages.at(-1)?.tool_call_id, call.id);
    assert.match(wire[1]!.messages.at(-1)?.content ?? '', /login/);
    for (let index = 0; index < wire.length; index++) assertNativeWire(wire[index]!, groq.canonical[index]!);
    assert.equal(JSON.stringify(tools.map(tool => tool.parameters)), schemaBefore);
  });
});

test('a native no-argument workspace tool receives the original empty object without transport markers', async t => {
  const { tools } = await workspaceFixture(t);
  let executed = 0;
  const validated: unknown[] = [];
  // Keep the required source read and the action under test; unrelated optional definitions
  // need not fit a focused empty-object fixture alongside the native tool definitions.
  const guarded = tools.filter(tool => ['read_file', 'get_workspace_info'].includes(tool.name)).map(tool => tool.name === 'get_workspace_info' ? { ...tool,
    validate(input: unknown) { validated.push(structuredClone(input)); return tool.validate(input); },
    async execute(input, toolContext) { executed++; return tool.execute(input, toolContext); },
  } satisfies AgentTool : tool);
  const { groq, wire } = transport([decision('get_workspace_info', {}), answer('The workspace metadata was inspected.')]);
  const runtime = new AgentRuntime(groq, guarded, context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: models[1]!, prompt: 'Inspect workspace metadata.' });
  assert.equal(executed, 1);
  assert.deepEqual(validated, [{}]);
  assert.equal(wire.length, 2);
  assert.deepEqual(offeredNames(wire[0]!), ['get_workspace_info', 'read_file']);
  const call = groq.canonical[1]!.messages.find(message => message.role === 'assistant')!.toolCalls![0]!;
  assert.equal(call.name, 'get_workspace_info');
  assert.equal(call.arguments, '{}');
  assert.equal(JSON.stringify(groq.canonical[1]!.messages).includes('_little_empty'), false);
  assert.equal(events.some(event => event.type === 'tool.failed' || event.type === 'agent.failed'), false);
  assert.equal(events.at(-1)?.type, 'agent.completed');
  wire.forEach((body, index) => assertNativeWire(body, groq.canonical[index]!));
});

test('invalid, unoffered, truncated and filtered native responses fail runtime before any tool starts or executes', async t => {
  const valid = decision('read_file', { path: 'src/auth.ts' });
  const invalidTurns: FixtureTurn[] = [
    { calls: [{ name: 'read_file', arguments: '{' }] }, { calls: [{ name: 'read_file', arguments: '[]' }] },
    decision('run_command', { program: 'node', args: [], cwd: '.' }),
    { calls: [...valid.calls!, ...decision('get_workspace_info', {}).calls!] },
    { ...valid, omitDone: true }, { ...valid, finish: 'length' }, { ...valid, finish: 'content_filter' },
  ];
  for (const invalid of invalidTurns) {
    const { tools } = await workspaceFixture(t);
    let executed = 0;
    const guarded = tools.map(tool => ({ ...tool, async execute(input: unknown, toolContext) { executed++; return tool.execute(input, toolContext); } } satisfies AgentTool));
    const { groq, wire } = transport([invalid]);
    const runtime = new AgentRuntime(groq, guarded, context);
    const events = capture(runtime);
    await runtime.run({ mode: 'ask', model: models[1]!, prompt: 'Inspect authentication source.' });
    assert.equal(executed, 0);
    assert.equal(wire.length, 1);
    assert.equal(runtime.busy, false);
    assert.equal(events.some(event => event.type === 'tool.started' || event.type === 'agent.completed' || event.type === 'agent.text.delta'), false);
    const failure = events.find(event => event.type === 'agent.failed');
    assert.ok(failure?.type === 'agent.failed');
    assert.equal(failure.code, 'PROVIDER_PROTOCOL_ERROR');
    assert.equal(failure.diagnostic?.phase, 'stream');
    assert.equal(failure.diagnostic?.category, 'tool_call');
  }
});

test('native calls still pass original path/range validators and recover from a host rejection observation', async t => {
  for (const rejected of [
    { name: 'read_file', args: { path: '' } },
    { name: 'read_range', args: { path: 'src/auth.ts', startLine: 5, endLine: 2 } },
  ]) await t.test(rejected.name, async child => {
    const { tools } = await workspaceFixture(child);
    let rejectedExecutions = 0, reads = 0;
    const guarded = tools.map(tool => ({ ...tool, async execute(input: unknown, toolContext) {
      if (tool.name === rejected.name && JSON.stringify(input) === JSON.stringify(rejected.args)) rejectedExecutions++;
      reads++; return tool.execute(input, toolContext);
    } } satisfies AgentTool));
    const { groq, wire } = transport([decision(rejected.name, rejected.args), decision('read_file', { path: 'src/auth.ts' }), answer('The corrected read inspected src/auth.ts:1; login returns current-source-evidence.')]);
    const runtime = new AgentRuntime(groq, guarded, context);
    const events = capture(runtime);
    await runtime.run({ mode: 'ask', model: models[1]!, prompt: 'Read authentication source and explain login.' });
    assert.equal(rejectedExecutions, 0, 'Invalid original tool bounds must stop execution after native decoding.');
    assert.equal(reads, 1);
    assert.equal(wire.length, 3);
    assert.equal(events.at(-1)?.type, 'agent.completed', JSON.stringify(events.find(event => event.type === 'agent.failed')));
    const failure = events.find(event => event.type === 'tool.failed');
    assert.ok(failure?.type === 'tool.failed');
    assert.equal(failure.name, rejected.name);
    assert.equal(failure.code, 'TOOL_VALIDATION_FAILED');
    assert.match(groq.canonical[1]!.messages.find(message => message.role === 'tool')?.content ?? '', /TOOL_VALIDATION_FAILED/);
    assert.match(wire[1]!.messages.at(-1)?.content ?? '', /TOOL_VALIDATION_FAILED/);
    const recovered = groq.canonical[2]!.messages.filter(message => message.role === 'tool');
    assert.equal(recovered.length, 2);
    assert.match(recovered[1]!.content, /current-source-evidence/);
    for (let index = 0; index < wire.length; index++) assertNativeWire(wire[index]!, groq.canonical[index]!);
  });
});

test('EDIT and AGENT retain actual mandatory schemas within the Groq wire budget without executing writes or commands', async t => {
  for (const mode of ['edit', 'agent'] as AgentMode[]) await t.test(mode, async child => {
    const { root, tools } = await workspaceFixture(child);
    const before = await fs.readFile(path.join(root, 'src/auth.ts'), 'utf8');
    let sideEffects = 0;
    const edits = createEditTools({} as EditProposalService, async () => { sideEffects++; throw new Error('A final-answer schema test must never review edits.'); }, () => { sideEffects++; });
    const commands = createCommandTools({} as ProjectCommandService, async () => { sideEffects++; throw new Error('A final-answer schema test must never review commands.'); });
    const guarded = [...tools, ...edits, ...commands].map(tool => ({ ...tool, async execute(input: unknown, toolContext) { sideEffects++; return tool.execute(input, toolContext); } } satisfies AgentTool));
    const { groq, wire } = transport([answer('No files were changed and no check commands were run.')]);
    const runtime = new AgentRuntime(groq, guarded, context);
    const events = capture(runtime);
    await runtime.run({ mode, model: models[1]!, prompt: 'Explain which source inspection, reviewed edits and checks are available.' });
    assert.equal(events.at(-1)?.type, 'agent.completed', JSON.stringify(events.find(event => event.type === 'agent.failed')));
    assert.equal(wire.length, 1);
    const names = offeredNames(wire[0]!);
    for (const name of mode === 'agent' ? ['read_file', 'propose_file_edits', 'run_command', 'update_plan'] : ['read_file', 'propose_file_edits']) assert.ok(names.includes(name), `${mode} must retain ${name}.`);
    if (mode === 'edit') assert.equal(names.includes('run_command'), false);
    assertNativeWire(wire[0]!, groq.canonical[0]!);
    assert.equal(sideEffects, 0);
    assert.equal(await fs.readFile(path.join(root, 'src/auth.ts'), 'utf8'), before);
    if (mode === 'agent') assert.ok(events.some(event => event.type === 'agent.verification' && event.status === 'not_run' && !event.outstandingEdits));
  });
});
