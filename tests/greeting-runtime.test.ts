import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../src/little/agent/runtime';
import type { AgentMode, AgentTool, LLMEvent, LLMProvider, LLMRequest, RunContext, RuntimeEvent } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { GroqProvider } from '../src/little/providers/groq';

const sourceContext: RunContext = { text: 'PRIVATE_REPOSITORY_CONTENT', items: [
  { id: 'file:src/hi.ts', label: 'src/hi.ts', type: 'file', estimatedTokens: 8 },
] };
const read: AgentTool = {
  name: 'read_file', description: 'Read source.', risk: 'SAFE',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  validate: value => value, async execute() { return { content: 'PRIVATE_REPOSITORY_CONTENT' }; },
};
function capture(runtime: AgentRuntime): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  return events;
}
function answerProvider(requests: LLMRequest[]): LLMProvider {
  return { id: 'groq', async listModels() { return []; }, async *stream(request) {
    requests.push(structuredClone(request));
    yield { type: 'text', text: 'PROVIDER_GENERATED_GREETING' };
    yield { type: 'usage', inputTokens: 12, outputTokens: 4 };
    yield { type: 'done', reason: 'stop' };
  } };
}

test('standalone ASK greetings call the selected provider without context collection or offered tools', async () => {
  for (const prompt of ['hi', 'Hello!', 'HEY?', ' hello there. ', 'Hi, Little!', 'hey Little Code', 'Hi...']) {
    let collections = 0;
    let executions = 0;
    const requests: LLMRequest[] = [];
    const runtime = new AgentRuntime(answerProvider(requests), [{ ...read, async execute() { executions++; return {}; } }],
      async () => { collections++; throw new Error('A greeting must not read the workspace.'); });
    const events = capture(runtime);
    await runtime.run({ mode: 'ask', model: 'openai/gpt-oss-120b', prompt });
    assert.equal(collections, 0, prompt);
    assert.equal(executions, 0, prompt);
    assert.equal(requests.length, 1, prompt);
    assert.equal(requests[0]!.model, 'openai/gpt-oss-120b');
    assert.deepEqual(requests[0]!.tools, []);
    assert.deepEqual(requests[0]!.messages[1], { role: 'user', content: prompt });
    assert.match(requests[0]!.messages[0]!.content, /Respond to this greeting briefly and naturally/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE_REPOSITORY_CONTENT|repository_context|Use structured tools/);
    assert.ok((requests[0]!.maxOutputTokens ?? 0) > 0, 'The normal request budget must remain in use.');
    assert.ok(events.some(event => event.type === 'agent.text.delta' && event.text === 'PROVIDER_GENERATED_GREETING'));
    assert.ok(events.some(event => event.type === 'agent.usage' && event.inputTokens === 12 && event.outputTokens === 4));
    assert.equal(events.some(event => event.type === 'tool.started' || event.type === 'tool.completed'), false);
    assert.equal(events.some(event => event.type === 'agent.state.changed' && event.state === 'searching'), false);
    assert.equal(events.at(-1)?.type, 'agent.completed');
    assert.equal(runtime.busy, false);
  }
});

test('greeting prefixes, paths and extra task clauses retain the normal ASK repository pipeline', async () => {
  for (const prompt of ['hi analyse codebase', 'hello, fix src/hi.ts', 'hey there and inspect', 'hi\nanalyse codebase',
    'hi.ts', 'hello/src', 'hey Little: search', 'hi there, what is next?', 'hello world', 'hi' + ' '.repeat(41)]) {
    let collections = 0;
    const requests: LLMRequest[] = [];
    const runtime = new AgentRuntime(answerProvider(requests), [read], async () => { collections++; return sourceContext; });
    await runtime.run({ mode: 'ask', model: 'openai/gpt-oss-120b', prompt });
    assert.equal(collections, 1, prompt);
    assert.deepEqual(requests[0]?.tools?.map(tool => tool.name), ['read_file'], prompt);
    assert.match(JSON.stringify(requests[0]), /PRIVATE_REPOSITORY_CONTENT/, prompt);
    assert.match(requests[0]!.messages[0]!.content, /Use structured tools/, prompt);
  }
});

test('a GPT OSS greeting reaches the Groq adapter without its strict action schema', async () => {
  let calls = 0;
  let sent: Record<string, unknown> | undefined;
  const provider = new GroqProvider({ get: async () => 'local-fixture-key', store: async () => undefined, delete: async () => undefined },
    async (_url, init) => {
      calls++;
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const event = { choices: [{ index: 0, delta: { content: 'Actual adapter greeting.' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    });
  const runtime = new AgentRuntime(provider, [read], async () => { throw new Error('No context read.'); });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'openai/gpt-oss-120b', prompt: 'hi' });
  assert.equal(calls, 1);
  assert.equal(sent?.model, 'openai/gpt-oss-120b');
  assert.equal(sent?.stream, true);
  for (const field of ['response_format', 'tools', 'tool_choice', 'parallel_tool_calls']) assert.equal(sent?.[field], undefined);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_REPOSITORY_CONTENT|repository_context/);
  assert.ok(events.some(event => event.type === 'agent.text.delta' && event.text === 'Actual adapter greeting.'));
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('PLAN, EDIT and AGENT greetings retain repository collection and their normal gates', async () => {
  for (const mode of ['plan', 'edit', 'agent'] satisfies AgentMode[]) {
    let collections = 0;
    const requests: LLMRequest[] = [];
    const runtime = new AgentRuntime(answerProvider(requests), [read], async () => { collections++; return sourceContext; });
    const events = capture(runtime);
    await runtime.run({ mode, model: 'openai/gpt-oss-120b', prompt: 'hi' });
    assert.equal(collections, 1, mode);
    assert.ok(requests[0]?.tools?.some(tool => tool.name === 'read_file'), mode);
    assert.equal(requests[0]?.tools?.some(tool => tool.name === 'update_plan'), mode === 'agent');
    assert.match(requests[0]!.messages[0]!.content, new RegExp(`Mode: ${mode.toUpperCase()}`));
    if (mode === 'agent') assert.ok(events.some(event => event.type === 'agent.verification' && event.status === 'not_run'));
  }
});

test('a provider cannot execute an unoffered read during a greeting', async () => {
  let requests = 0;
  let validations = 0;
  let executions = 0;
  const provider: LLMProvider = { id: 'fixture', async listModels() { return []; }, async *stream() {
    if (++requests === 1) {
      yield { type: 'tool_call', call: { id: 'unoffered-read', name: 'read_file', arguments: '{"path":"src/hi.ts"}' } };
      yield { type: 'done', reason: 'tool_calls' };
    } else { yield { type: 'text', text: 'Hello.' }; yield { type: 'done', reason: 'stop' }; }
  } };
  const runtime = new AgentRuntime(provider, [{ ...read, validate(value) { validations++; return value; }, async execute() { executions++; return {}; } }],
    async () => { throw new Error('A greeting must not collect context.'); });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'selected', prompt: 'hi' });
  assert.equal(validations, 0);
  assert.equal(executions, 0);
  assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'TOOL_VALIDATION_FAILED'));
});

test('greeting requests still fail a restrictive budget before provider invocation', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(answerProvider(requests), [read], async () => { throw new Error('No context read.'); }, { maxContextChars: 5 });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'openai/gpt-oss-120b', prompt: 'hi' });
  assert.equal(requests.length, 0);
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'CONTEXT_LIMIT'));
  assert.equal(runtime.busy, false);
});

test('a greeting observes model quota pacing before invoking the provider', async () => {
  let observations = 0;
  let calls = 0;
  const provider: LLMProvider = { id: 'fixture', async listModels() { return []; }, requestLimits(model) {
    assert.equal(model, 'selected');
    return ++observations <= 2 ? { remainingTokens: 0, resetAfterMs: 10 } : undefined;
  }, async *stream() { calls++; yield { type: 'text', text: 'Hello.' }; yield { type: 'done', reason: 'stop' }; } };
  const runtime = new AgentRuntime(provider, [read], async () => { throw new Error('No context read.'); });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'selected', prompt: 'hello' });
  assert.equal(calls, 1);
  assert.ok(events.some(event => event.type === 'agent.provider.wait'));
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('cancel stops the real greeting provider and releases the runtime without completing', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const provider: LLMProvider = { id: 'fixture', async listModels() { return []; }, async *stream(_request, signal) {
    calls++;
    entered();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    yield { type: 'text', text: 'Unreachable.' };
  } };
  const runtime = new AgentRuntime(provider, [read], async () => { throw new Error('No context read.'); });
  const events = capture(runtime);
  const running = runtime.run({ mode: 'ask', model: 'selected', prompt: 'hi' });
  await started;
  runtime.cancel();
  await running;
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.type, 'agent.cancelled');
  assert.equal(events.some(event => event.type === 'agent.completed'), false);
  assert.equal(runtime.busy, false);
});

test('greeting provider failures preserve diagnostics and require an explicit new run', async () => {
  let calls = 0;
  const failure = new LittleError('PROVIDER_RATE_LIMITED', 'Observed quota failure.', 3000,
    { provider: 'groq', phase: 'http', category: 'rate_limit', status: 429 });
  const provider: LLMProvider = { id: 'fixture', async listModels() { return []; }, async *stream() {
    if (++calls === 1) throw failure;
    yield { type: 'text', text: 'Hello after an explicit retry.' }; yield { type: 'done', reason: 'stop' };
  } };
  const runtime = new AgentRuntime(provider, [read], async () => { throw new Error('No context read.'); });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'selected', prompt: 'hi' });
  assert.equal(calls, 1, 'A failed provider response must not be retried automatically.');
  const failed = events.find(event => event.type === 'agent.failed');
  assert.ok(failed?.type === 'agent.failed');
  assert.equal(failed.code, failure.code);
  assert.equal(failed.retryAfterMs, 3000);
  assert.deepEqual(failed.diagnostic, failure.diagnostic);
  assert.equal(runtime.busy, false);
  await runtime.run({ mode: 'ask', model: 'selected', prompt: 'hi' });
  assert.equal(calls, 2);
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('an incomplete greeting response never claims completion', async () => {
  const provider: LLMProvider = { id: 'fixture', async listModels() { return []; }, async *stream() {
    yield { type: 'text', text: 'Partial greeting.' } satisfies LLMEvent;
  } };
  const runtime = new AgentRuntime(provider, [read], async () => { throw new Error('No context read.'); });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'selected', prompt: 'hey' });
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'PROVIDER_PROTOCOL_ERROR'));
  assert.equal(events.some(event => event.type === 'agent.completed'), false);
});
