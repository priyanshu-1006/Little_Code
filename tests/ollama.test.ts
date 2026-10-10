import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test, type TestContext } from 'node:test';
import { OLLAMA_DEFAULT_ENDPOINT, OLLAMA_LIMITS, OllamaProvider, validateOllamaEndpoint } from '../src/little/providers/ollama';
import type { LLMEvent, LLMRequest } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';

const request: LLMRequest = { model: 'fixture:latest', messages: [{ role: 'user', content: 'Explain the auth module.' }], maxOutputTokens: 512 };
function errorCode(code: LittleError['code']) { return (error: unknown) => error instanceof LittleError && error.code === code; }
async function collect(provider: OllamaProvider, input = request, signal?: AbortSignal): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.stream(input, signal)) events.push(event);
  return events;
}
function ndjson(frames: unknown[], trailingNewline = true): string { return frames.map(frame => JSON.stringify(frame)).join('\n') + (trailingNewline ? '\n' : ''); }
function fixtureFetch(frames: unknown[]): typeof fetch { return async () => new Response(ndjson(frames), { headers: { 'Content-Type': 'application/x-ndjson' } }); }
function tool(name = 'read_file', args: unknown = { path: 'auth.ts' }, index?: number) { return { function: { name, arguments: args, ...(index === undefined ? {} : { index }) } }; }
function done(extra: Record<string, unknown> = {}) { return { done: true, done_reason: 'stop', message: { role: 'assistant', content: '' }, ...extra }; }
async function serverFixture(t: TestContext, handler: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>) {
  const server = http.createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, server };
}
async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

test('endpoint validation permits exact loopback origins and rejects remote, redirected, and ambiguous input', () => {
  assert.equal(new OllamaProvider().endpoint, OLLAMA_DEFAULT_ENDPOINT);
  assert.equal(validateOllamaEndpoint('http://localhost:11434/'), OLLAMA_DEFAULT_ENDPOINT);
  assert.equal(validateOllamaEndpoint('https://[::1]:1234'), 'https://[::1]:1234');
  assert.equal(validateOllamaEndpoint('http://127.0.0.1:80'), 'http://127.0.0.1');
  for (const endpoint of ['', 'http://example.org:11434', 'http://192.168.1.1:11434', 'http://0.0.0.0:11434', 'http://127.0.0.2', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]', 'http://localhost.example.org', 'http://user:password@localhost', 'http://localhost/api', 'http://localhost/.', 'http://localhost?key=secret', 'http://localhost#fragment', 'http://localhost:0', 'http://localhost:65536', 'file://localhost', ' http://localhost', 'http://localhost\n']) {
    assert.throws(() => new OllamaProvider(endpoint), errorCode('TOOL_VALIDATION_FAILED'), endpoint);
  }
});

test('native tags discovery returns only real eligible local models without invented capabilities', async (t) => {
  const received: { url: string | undefined; method: string | undefined; authorization: string | undefined }[] = [];
  const { endpoint } = await serverFixture(t, (req, res) => {
    received.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ models: [
      { name: 'fixture:latest', model: 'fixture:latest', details: { family: 'qwen', context_length: 999999, tools: true } },
      { name: 'other:8b' }, { name: 'fixture:latest' },
      { name: 'proxy:latest', remote_model: 'upstream' }, { name: 'remote:latest', remote_host: 'https://example.org' },
      { name: 'gpt-oss:120b-cloud' }, { name: 'kimi:cloud' }, { name: 'cloud-model-cloud:latest' },
    ] }));
  });
  const provider = new OllamaProvider(endpoint);
  assert.equal(provider.id, 'ollama');
  assert.deepEqual(await provider.listModels(), [
    { id: 'fixture:latest', name: 'fixture:latest', capabilities: { streaming: true, tools: 'unknown' } },
    { id: 'other:8b', name: 'other:8b', capabilities: { streaming: true, tools: 'unknown' } },
  ]);
  assert.deepEqual(received, [{ url: '/api/tags', method: 'GET', authorization: undefined }]);
});

test('actual loopback HTTP streams split UTF-8 NDJSON, omit thinking, and report native usage', async (t) => {
  let received: Record<string, unknown> | undefined;
  let route: string | undefined;
  const { endpoint } = await serverFixture(t, async (req, res) => {
    route = req.url;
    received = await body(req);
    res.setHeader('Content-Type', 'application/x-ndjson');
    const encoded = Buffer.from(ndjson([
      { done: false, message: { role: 'assistant', content: '', thinking: 'PRIVATE_CHAIN_OF_THOUGHT' } },
      { done: false, message: { role: 'assistant', content: 'Auth 😀' } },
      { done: false, message: { role: 'assistant', content: ' works.' } },
      done({ prompt_eval_count: 23, eval_count: 7 }),
    ], false));
    const astral = encoded.indexOf(Buffer.from('😀'));
    res.write(encoded.subarray(0, astral + 1));
    await new Promise(resolve => setImmediate(resolve));
    res.write(encoded.subarray(astral + 1, astral + 3));
    await new Promise(resolve => setImmediate(resolve));
    res.end(encoded.subarray(astral + 3));
  });
  const events = await collect(new OllamaProvider(endpoint));
  assert.equal(route, '/api/chat');
  assert.deepEqual(received, { model: 'fixture:latest', messages: request.messages, stream: true, think: false, options: { num_predict: 512 } });
  assert.deepEqual(events, [{ type: 'text', text: 'Auth 😀' }, { type: 'text', text: ' works.' }, { type: 'usage', inputTokens: 23, outputTokens: 7 }, { type: 'done', reason: 'stop' }]);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_CHAIN_OF_THOUGHT'));
});

test('native completed tool calls use deterministic distinct IDs and observations carry tool_name', async (t) => {
  const requests: Record<string, unknown>[] = [];
  const { endpoint } = await serverFixture(t, async (req, res) => {
    requests.push(await body(req));
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.end(requests.length === 1 ? ndjson([
      { done: false, message: { role: 'assistant', content: '', tool_calls: [tool('search_text', { query: 'authenticate' }, 0)] } },
      { done: false, message: { role: 'assistant', content: '', tool_calls: [tool('read_file', { path: 'auth.ts' }, 1)] } },
      done(),
    ]) : ndjson([{ done: false, message: { role: 'assistant', content: 'Authentication checks a session.' } }, done()]));
  });
  const provider = new OllamaProvider(endpoint);
  const first = await collect(provider, { ...request, tools: [{ name: 'read_file', description: 'Read source', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });
  const calls = first.filter((event): event is Extract<LLMEvent, { type: 'tool_call' }> => event.type === 'tool_call').map(event => event.call);
  assert.deepEqual(calls, [{ id: 'ollama_1_0', name: 'search_text', arguments: '{"query":"authenticate"}' }, { id: 'ollama_1_1', name: 'read_file', arguments: '{"path":"auth.ts"}' }]);
  const second = await collect(provider, { ...request, messages: [request.messages[0]!, { role: 'assistant', content: '', toolCalls: calls }, ...calls.map(call => ({ role: 'tool' as const, content: call.name === 'search_text' ? 'auth.ts:1' : 'export function authenticate() {}', toolCallId: call.id }))] });
  assert.deepEqual(second.at(-1), { type: 'done', reason: 'stop' });
  assert.deepEqual((requests[0]?.tools as unknown[])[0], { type: 'function', function: { name: 'read_file', description: 'Read source', parameters: { type: 'object', properties: { path: { type: 'string' } } } } });
  const history = requests[1]?.messages as Record<string, unknown>[];
  assert.deepEqual(history[1]?.tool_calls, [{ type: 'function', function: { index: 0, name: 'search_text', arguments: { query: 'authenticate' } } }, { type: 'function', function: { index: 1, name: 'read_file', arguments: { path: 'auth.ts' } } }]);
  assert.deepEqual(history.slice(2), [{ role: 'tool', content: 'auth.ts:1', tool_name: 'search_text' }, { role: 'tool', content: 'export function authenticate() {}', tool_name: 'read_file' }]);
});

test('tool calls remain buffered until completion and interrupted responses never expose executable calls', async () => {
  const events: LLMEvent[] = [];
  const provider = new OllamaProvider(undefined, fixtureFetch([{ done: false, message: { tool_calls: [tool()] } }]));
  await assert.rejects(async () => { for await (const event of provider.stream(request)) events.push(event); }, errorCode('PROVIDER_PROTOCOL_ERROR'));
  assert.deepEqual(events, []);
  const truncated = await collect(new OllamaProvider(undefined, fixtureFetch([{ done: false, message: { content: 'Partial', tool_calls: [tool()] } }, done({ done_reason: 'length' })])));
  assert.deepEqual(truncated, [{ type: 'text', text: 'Partial' }, { type: 'done', reason: 'length' }]);
  const filtered = await collect(new OllamaProvider(undefined, fixtureFetch([{ done: false, message: { tool_calls: [tool()] } }, done({ done_reason: 'content_filter' })])));
  assert.deepEqual(filtered, [{ type: 'done', reason: 'content_filter' }]);
});

test('malformed NDJSON, invalid UTF-8, trailing frames, tool conflicts, and unsafe arguments fail closed', async () => {
  const invalidFrames: unknown[][] = [
    [{ message: { content: 'missing done flag' } }],
    [{ done: false, message: { role: 'tool', content: '' } }, done()],
    [{ done: false, message: { content: 23 } }, done()],
    [done(), { done: false, message: { content: 'late' } }],
    [{ done: false, message: { tool_calls: [tool('read_file', 'not an object')] } }, done()],
    [{ done: false, message: { tool_calls: [tool('read_file', { path: 'a.ts' }, 0), tool('read_file', { path: 'b.ts' }, 0)] } }, done()],
    [{ done: false, message: { tool_calls: [tool('read_file', {}, -1)] } }, done()],
    [{ done: false, message: { tool_calls: [tool('read_file', {}, 64)] } }, done()],
    [{ done: false, message: { tool_calls: [tool('invalid name')] } }, done()],
    [done({ prompt_eval_count: 1, eval_count: -1 })],
    [done({ done_reason: 'private error contents!' })],
    [{ done: false, remote_host: 'https://remote.example', message: { content: 'remote response' } }, done()],
  ];
  for (const frames of invalidFrames) await assert.rejects(collect(new OllamaProvider(undefined, fixtureFetch(frames))), errorCode('PROVIDER_PROTOCOL_ERROR'));
  for (const bytes of [Buffer.from('{"done":false,\n'), Buffer.from([0xc3, 0x28]), Buffer.from('{"done":true}').subarray(0, 10)]) {
    await assert.rejects(collect(new OllamaProvider(undefined, async () => new Response(bytes))), errorCode('PROVIDER_PROTOCOL_ERROR'));
  }
});

test('discovery and streaming respect buffer limits and never emit a partial tool call', async () => {
  const oversizedDiscovery = new OllamaProvider(undefined, async () => new Response(' '.repeat(OLLAMA_LIMITS.discoveryBytes + 1)));
  await assert.rejects(oversizedDiscovery.listModels(), errorCode('PROVIDER_PROTOCOL_ERROR'));
  const tooManyModels = new OllamaProvider(undefined, async () => Response.json({ models: Array.from({ length: OLLAMA_LIMITS.models + 1 }, (_, index) => ({ name: `model${index}` })) }));
  await assert.rejects(tooManyModels.listModels(), errorCode('PROVIDER_PROTOCOL_ERROR'));
  await assert.rejects(collect(new OllamaProvider(undefined, async () => new Response('x'.repeat(OLLAMA_LIMITS.lineChars + 1)))), errorCode('PROVIDER_PROTOCOL_ERROR'));
  await assert.rejects(collect(new OllamaProvider(undefined, fixtureFetch([{ done: false, message: { tool_calls: [tool('read_file', { path: 'x'.repeat(OLLAMA_LIMITS.argumentChars) })] } }, done()]))), errorCode('PROVIDER_PROTOCOL_ERROR'));
  const tooManyCalls = Array.from({ length: OLLAMA_LIMITS.toolCalls + 1 }, () => tool());
  await assert.rejects(collect(new OllamaProvider(undefined, fixtureFetch([{ done: false, message: { tool_calls: tooManyCalls } }, done()]))), errorCode('PROVIDER_PROTOCOL_ERROR'));
  const textFrames = Array.from({ length: 65 }, () => ({ done: false, message: { content: 'x'.repeat(32768) } }));
  await assert.rejects(collect(new OllamaProvider(undefined, fixtureFetch([...textFrames, done()]))), errorCode('PROVIDER_PROTOCOL_ERROR'));
  let suppliedBytes = 0;
  const ignoredThinking = Buffer.from(ndjson([{ done: false, message: { content: '', thinking: 'x'.repeat(64000) } }]));
  const oversizedStream = new OllamaProvider(undefined, async () => new Response(new ReadableStream<Uint8Array>({ pull(stream) {
    if (suppliedBytes <= OLLAMA_LIMITS.streamBytes) { suppliedBytes += ignoredThinking.byteLength; stream.enqueue(ignoredThinking); }
    else { stream.enqueue(Buffer.from(ndjson([done()]))); stream.close(); }
  } })));
  await assert.rejects(collect(oversizedStream), errorCode('PROVIDER_PROTOCOL_ERROR'));
});

test('provider errors are sanitized, include Retry-After, and generation is never retried', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [429, 'PROVIDER_RATE_LIMITED'], [404, 'MODEL_UNAVAILABLE'], [500, 'PROVIDER_UNAVAILABLE'], [400, 'PROVIDER_PROTOCOL_ERROR']] as const) {
    let attempts = 0;
    const provider = new OllamaProvider(undefined, async () => { attempts++; return new Response('gsk_PrivateProviderBodyAndPassword', { status, headers: { 'Retry-After': '2.5' } }); });
    await assert.rejects(collect(provider), error => error instanceof LittleError && error.code === code && !error.message.includes('gsk_') && (status !== 429 || error.retryAfterMs === 2500));
    assert.equal(attempts, 1);
  }
  const date = new Date(Date.now() + 10_000).toUTCString();
  await assert.rejects(collect(new OllamaProvider(undefined, async () => new Response('', { status: 429, headers: { 'Retry-After': date } }))), error => error instanceof LittleError && error.retryAfterMs !== undefined && error.retryAfterMs > 0 && error.retryAfterMs <= 10_000);
  const network = new OllamaProvider(undefined, async () => { throw new Error('gsk_PrivateNetworkDiagnostic'); });
  await assert.rejects(collect(network), error => error instanceof LittleError && error.code === 'PROVIDER_UNAVAILABLE' && !error.message.includes('gsk_'));
  const streaming = new OllamaProvider(undefined, fixtureFetch([{ done: false, message: { tool_calls: [tool()] } }, { error: 'gsk_PrivateStreamDiagnostic' }]));
  await assert.rejects(collect(streaming), error => error instanceof LittleError && error.code === 'PROVIDER_PROTOCOL_ERROR' && !error.message.includes('gsk_'));
});

test('redirect policy prevents actual HTTP requests from leaving the configured loopback server', async (t) => {
  let outsideRequests = 0;
  const outside = await serverFixture(t, (_req, res) => { outsideRequests++; res.end(ndjson([done()])); });
  const origin = await serverFixture(t, (_req, res) => { res.writeHead(302, { Location: outside.endpoint + '/api/chat' }); res.end(); });
  await assert.rejects(collect(new OllamaProvider(origin.endpoint)), errorCode('PROVIDER_UNAVAILABLE'));
  await assert.rejects(new OllamaProvider(origin.endpoint).listModels(), errorCode('PROVIDER_UNAVAILABLE'));
  assert.equal(outsideRequests, 0);
});

test('cancellation before request, during discovery, and during a stalled stream aborts promptly', async () => {
  let requests = 0;
  const already = new AbortController();
  already.abort();
  const provider = new OllamaProvider(undefined, async () => { requests++; return new Response(ndjson([done()])); });
  await assert.rejects(collect(provider, request, already.signal), errorCode('AGENT_CANCELLED'));
  await assert.rejects(provider.listModels(already.signal), errorCode('AGENT_CANCELLED'));
  assert.equal(requests, 0);
  const discoveryController = new AbortController();
  const discovery = new OllamaProvider(undefined, async () => new Promise<Response>(() => {}));
  const discovering = discovery.listModels(discoveryController.signal);
  discoveryController.abort();
  await assert.rejects(discovering, errorCode('AGENT_CANCELLED'));
  let cancelledBody = false;
  const controller = new AbortController();
  const stalled = new OllamaProvider(undefined, async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(Buffer.from(ndjson([{ done: false, message: { content: 'visible', tool_calls: [tool()] } }]))); },
    cancel() { cancelledBody = true; },
  })));
  const events: LLMEvent[] = [];
  await assert.rejects(async () => { for await (const event of stalled.stream(request, controller.signal)) { events.push(event); controller.abort(); } }, errorCode('AGENT_CANCELLED'));
  assert.deepEqual(events, [{ type: 'text', text: 'visible' }]);
  assert.equal(cancelledBody, true);
});

test('invalid conversation inputs and explicit cloud models are rejected before HTTP traffic', async () => {
  let requests = 0;
  const provider = new OllamaProvider(undefined, async () => { requests++; return new Response(ndjson([done()])); });
  for (const input of [
    { ...request, model: 'gpt-oss:120b-cloud' }, { ...request, model: 'kimi:cloud' },
    { ...request, maxOutputTokens: -1 }, { ...request, messages: [] },
    { ...request, messages: [{ role: 'tool' as const, content: 'orphan observation', toolCallId: 'unknown' }] },
    { ...request, tools: [{ name: 'invalid tool', description: 'test', parameters: {} }] },
  ]) await assert.rejects(collect(provider, input), errorCode('TOOL_VALIDATION_FAILED'));
  assert.equal(requests, 0);
});

test('tool ID generation avoids collisions with prior conversation IDs and respects CRLF framing', async () => {
  const input: LLMRequest = { ...request, messages: [request.messages[0]!, { role: 'assistant', content: '', toolCalls: [{ id: 'ollama_1_0', name: 'read_file', arguments: '{"path":"old.ts"}' }] }, { role: 'tool', content: 'old source', toolCallId: 'ollama_1_0' }] };
  const provider = new OllamaProvider(undefined, async () => new Response(ndjson([{ done: false, message: { tool_calls: [tool()] } }, done()]).replaceAll('\n', '\r\n')));
  const events = await collect(provider, input);
  const call = events.find((event): event is Extract<LLMEvent, { type: 'tool_call' }> => event.type === 'tool_call');
  assert.equal(call?.call.id, 'ollama_1_0_next');
});
