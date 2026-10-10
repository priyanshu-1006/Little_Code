import assert from 'node:assert/strict';
import test from 'node:test';
import { GroqProvider } from '../src/little/providers/groq';
import { groqNativeRequest } from '../src/little/providers/groq-request';
import type { LLMEvent, LLMRequest, SecretStore } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';

const secrets: SecretStore = { get: async () => 'fixture-key', store: async () => {}, delete: async () => {} };
const request: LLMRequest = { model: 'openai/gpt-oss-120b', maxOutputTokens: 2048,
  messages: [{ role: 'system', content: 'Use observed evidence.' }, { role: 'user', content: 'Inspect the codebase.' }],
  tools: [{ name: 'search_text', description: 'Search bounded source', parameters: { type: 'object', additionalProperties: false,
    properties: { query: { type: 'string' }, path: { type: 'string', default: '.' } }, required: ['query'] } }] };
const encoder = new TextEncoder();
const requestId = 'req_01jbd6g2qdfw2adyrt2az8hz4w';
const data = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const choice = (delta: unknown, reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: reason }] });
const call = (index = 0, id = 'call_search', name = 'search_text', args = '{"query":"architecture"}') => ({ index, id, type: 'function', function: { name, arguments: args } });
function sse(parts: (string | Uint8Array)[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': requestId } });
}
async function events(provider: GroqProvider, input = request, signal?: AbortSignal) {
  const result: LLMEvent[] = [];
  for await (const event of provider.stream(input, signal)) result.push(event);
  return result;
}

test('both GPT OSS models use the exact sequential native wire body without mutating canonical schemas or history', async () => {
  for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']) {
    const input: LLMRequest = { ...request, model, messages: [...request.messages,
      { role: 'assistant', content: '', toolCalls: [{ id: 'prior', name: 'search_text', arguments: '{"query":"entry"}' }] },
      { role: 'tool', content: '{"matches":[]}', toolCallId: 'prior' }], tools: [...request.tools!,
      { name: 'get_workspace_info', description: 'Inspect local metadata', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'mcp_dictionary', description: 'Permitted dictionary schema', parameters: { type: 'object', additionalProperties: { type: 'string' } } }] };
    const original = structuredClone(input);
    const provider = new GroqProvider(secrets, async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as ReturnType<typeof groqNativeRequest> & Record<string, unknown>;
      assert.deepEqual(body, groqNativeRequest(input));
      assert.equal(body.stream, true); assert.equal(body.parallel_tool_calls, false); assert.equal(body.tool_choice, 'auto');
      assert.equal(body.max_completion_tokens, 2048); assert.equal(body.include_reasoning, false); assert.equal(body.reasoning_effort, 'low');
      assert.equal(body.response_format, undefined);
      assert.deepEqual(body.messages[2]!.tool_calls![0], { id: 'prior', type: 'function', function: { name: 'search_text', arguments: '{"query":"entry"}' } });
      assert.deepEqual(body.messages[3], { role: 'tool', content: '{"matches":[]}', tool_call_id: 'prior' });
      assert.deepEqual(body.tools!.map(tool => tool.function), input.tools);
      assert.equal(String(options?.body).includes('fixture-key'), false);
      return sse([data(choice({ content: 'Visible answer.', reasoning: 'PRIVATE_REASONING' }, 'stop')), 'data: [DONE]\n\n']);
    });
    assert.deepEqual(await events(provider, input), [{ type: 'text', text: 'Visible answer.' }, { type: 'done', reason: 'stop' }]);
    assert.deepEqual(input, original);
  }
});

test('fragmented UTF-8 tool arguments stay buffered until DONE and validated usage', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const provider = new GroqProvider(secrets, async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { controller = stream;
    stream.enqueue(encoder.encode(data(choice({ content: 'Inspecting source.' }))));
    const fragment = encoder.encode(data(choice({ tool_calls: [{ index: 0, id: 'call_', function: { name: 'search_', arguments: '{"query":"café 🌍' } }] })));
    for (const byte of fragment) stream.enqueue(new Uint8Array([byte]));
    stream.enqueue(encoder.encode(data(choice({ tool_calls: [{ index: 0, id: 'search', function: { name: 'text', arguments: '"}' } }] }, 'tool_calls'))));
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  const iterator = provider.stream(request)[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: 'text', text: 'Inspecting source.' });
  let emitted = false;
  const pending = iterator.next().then(event => { emitted = true; return event; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(emitted, false, 'A finish reason without DONE must not release executable calls.');
  controller.enqueue(encoder.encode(data({ choices: [], x_groq: { usage: { prompt_tokens: 950, completion_tokens: 80 } } })));
  controller.enqueue(encoder.encode('data: [DONE]\r\n\r\n')); controller.close();
  assert.deepEqual((await pending).value, { type: 'tool_call', call: { id: 'call_search', name: 'search_text', arguments: '{"query":"café 🌍"}' } });
  assert.deepEqual((await iterator.next()).value, { type: 'usage', inputTokens: 950, outputTokens: 80 });
  assert.deepEqual((await iterator.next()).value, { type: 'done', reason: 'tool_calls' });
});

test('malformed, unoffered, duplicate and parallel GPT OSS calls fail before any call becomes executable', async () => {
  const invalid = [
    [call(0, 'first', 'run_command', '{}')], [call(0, 'first', 'search_text', '{')],
    ...['null', '[]', '1', '"source"'].map(args => [call(0, 'first', 'search_text', args)]),
    [call(0, 'duplicate'), call(1, 'duplicate')], [call(0, 'first'), call(1, 'second')],
  ];
  for (const calls of invalid) {
    const observed: LLMEvent[] = [];
    let fetches = 0;
    const provider = new GroqProvider(secrets, async () => { fetches++; return sse([
      data(choice({ content: 'Partial visible text.' })), data(choice({ tool_calls: calls }, 'tool_calls')), 'data: [DONE]\n\n']); });
    await assert.rejects(async () => { for await (const event of provider.stream(request)) observed.push(event); }, error => {
      assert.ok(error instanceof LittleError);
      assert.equal(error.code, 'PROVIDER_PROTOCOL_ERROR');
      assert.deepEqual(error.diagnostic, { provider: 'groq', phase: 'stream', category: 'tool_call', requestId });
      assert.match(error.message, /No tool from this response was executed/);
      assert.equal(JSON.stringify(error).includes('fixture-key'), false);
      return true;
    });
    assert.deepEqual(observed, [{ type: 'text', text: 'Partial visible text.' }]); assert.equal(fetches, 1);
  }
});

test('truncated, filtered and missing-DONE mixed tool responses never emit calls, usage or completion', async () => {
  for (const reason of ['length', 'content_filter', 'stop', 'tool_calls']) {
    const observed: LLMEvent[] = [];
    const provider = new GroqProvider(secrets, async () => sse([data(choice({ tool_calls: [call()] }, reason)),
      data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }), ...(reason === 'tool_calls' ? [] : ['data: [DONE]\n\n'])]));
    await assert.rejects(async () => { for await (const event of provider.stream(request)) observed.push(event); },
      error => error instanceof LittleError && error.code === 'PROVIDER_PROTOCOL_ERROR' && error.diagnostic?.category === 'tool_call');
    assert.deepEqual(observed, []);
  }
});

test('terminal choice reasons cannot be overridden or followed by tool or content deltas', async () => {
  const fixtures = [
    ...['length', 'content_filter', 'tool_calls'].map(reason => [choice({ tool_calls: [call()] }, reason), choice({}, 'tool_calls')]),
    [choice({}, 'stop'), choice({}, 'stop')],
    [choice({ tool_calls: [call()] }, 'tool_calls'), choice({ tool_calls: [call(0, '', '', '')] })],
    [choice({ tool_calls: [call()] }, 'tool_calls'), choice({ content: 'Unvalidated late content.' })],
    [choice({}, 'stop'), choice({ tool_calls: [call()] })],
    [choice({}, 'length'), choice({ tool_calls: [call()] })],
    [choice({}, 'content_filter'), choice({ content: 'Unvalidated late content.' })],
  ];
  for (const chunks of fixtures) {
    const observed: LLMEvent[] = [];
    let requests = 0;
    const provider = new GroqProvider(secrets, async () => { requests++; return sse([
      ...chunks.map(data), data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }), 'data: [DONE]\n\n']); });
    await assert.rejects(async () => { for await (const event of provider.stream(request)) observed.push(event); },
      error => error instanceof LittleError && error.code === 'PROVIDER_PROTOCOL_ERROR');
    assert.deepEqual(observed, [], 'A malformed terminal sequence must release no tool, late text, usage or completion.');
    assert.equal(requests, 1, 'Rejecting a completed generation must never trigger a replay.');
  }
});

test('a first terminal chunk may contain the final delta while usage-only chunks still follow safely', async () => {
  const provider = new GroqProvider(secrets, async () => sse([
    data(choice({ tool_calls: [call()] }, 'tool_calls')),
    data({ choices: [], x_groq: { usage: { prompt_tokens: 15, completion_tokens: 4 } } }), 'data: [DONE]\n\n']));
  assert.deepEqual(await events(provider), [
    { type: 'tool_call', call: { id: 'call_search', name: 'search_text', arguments: '{"query":"architecture"}' } },
    { type: 'usage', inputTokens: 15, outputTokens: 4 }, { type: 'done', reason: 'tool_calls' },
  ]);
  const text = new GroqProvider(secrets, async () => sse([data(choice({ content: 'Final text.' }, 'stop')),
    data({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }), 'data: [DONE]\n\n']));
  assert.deepEqual(await events(text), [{ type: 'text', text: 'Final text.' }, { type: 'usage', inputTokens: 12, outputTokens: 3 }, { type: 'done', reason: 'stop' }]);
});

test('every call and usage validate before any emission for models permitting multiple calls', async () => {
  for (const tail of [call(1, 'duplicate'), call(1, 'different', 'search_text', '{')]) {
    const provider = new GroqProvider(secrets, async () => sse([data(choice({ tool_calls: [call(0, 'duplicate'), tail] }, 'tool_calls')), 'data: [DONE]\n\n']));
    const observed: LLMEvent[] = [];
    await assert.rejects(async () => { for await (const event of provider.stream({ ...request, model: 'test-model' })) observed.push(event); });
    assert.deepEqual(observed, []);
  }
  const invalidUsage = new GroqProvider(secrets, async () => sse([data(choice({ tool_calls: [call()] }, 'tool_calls')),
    data({ choices: [], usage: { prompt_tokens: -1, completion_tokens: 5 } }), 'data: [DONE]\n\n']));
  await assert.rejects(events(invalidUsage), error => error instanceof LittleError && error.code === 'PROVIDER_PROTOCOL_ERROR');
});

test('native SSE errors retain safe correlation and quotas without failed-generation recovery or replay', async () => {
  let fetches = 0;
  const provider = new GroqProvider(secrets, async () => { fetches++; return sse([data({ error: { code: 'rate_limit_exceeded',
    message: 'fixture-key private-org tokens per minute (TPM): Limit 8000, Used 7900, Requested 4900. Please try again in 120s.', failed_generation: 'PRIVATE SOURCE' } })]); });
  await assert.rejects(events(provider), error => {
    assert.ok(error instanceof LittleError); assert.equal(error.code, 'PROVIDER_RATE_LIMITED'); assert.equal(error.retryAfterMs, 120000);
    assert.equal(error.diagnostic?.phase, 'stream'); assert.equal(error.diagnostic?.requestId, requestId);
    for (const privateText of ['fixture-key', 'private-org', 'PRIVATE SOURCE']) assert.equal(JSON.stringify(error).includes(privateText), false);
    return true;
  });
  assert.equal(fetches, 1); assert.equal(provider.requestLimits(request.model)?.tokensPerMinute, 8000);
});

test('native transport rejects non-SSE, invalid UTF-8 and oversized events without executable output', async () => {
  for (const response of [Response.json({ choices: [] }), sse([new Uint8Array([0xff])]), sse([`data: ${'x'.repeat(1024 * 1024 + 1)}`])]) {
    const observed: LLMEvent[] = [];
    await assert.rejects(async () => { for await (const event of new GroqProvider(secrets, async () => response).stream(request)) observed.push(event); },
      error => error instanceof LittleError && error.code === 'PROVIDER_PROTOCOL_ERROR');
    assert.deepEqual(observed, []);
  }
});

test('Stop cancels a pending GPT OSS tool stream before any buffered call can escape', async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let bodyCancelled = false;
  const provider = new GroqProvider(secrets, async () => new Response(new ReadableStream<Uint8Array>({ start(stream) {
    stream.enqueue(encoder.encode(data(choice({ tool_calls: [call()] }, 'tool_calls')))); ready();
  }, cancel() { bodyCancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
  const observed: LLMEvent[] = [];
  const pending = (async () => { for await (const event of provider.stream(request, controller.signal)) observed.push(event); })();
  await started; controller.abort();
  await assert.rejects(pending, error => error instanceof LittleError && error.code === 'AGENT_CANCELLED');
  assert.deepEqual(observed, []); assert.equal(bodyCancelled, true);
});
