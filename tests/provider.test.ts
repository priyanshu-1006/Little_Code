import test from 'node:test';
import assert from 'node:assert/strict';
import { GROQ_SECRET_KEY, GroqProvider } from '../src/little/providers/groq';
import type { LLMEvent, LLMRequest, SecretStore } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { groqResetDuration } from '../src/little/providers/groq-errors';

const request: LLMRequest = { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] };
const encoder = new TextEncoder();
function secrets(value: string | undefined = 'test-private-key'): SecretStore {
  return { get: async key => { assert.equal(key, GROQ_SECRET_KEY); return value; }, store: async () => undefined, delete: async () => undefined };
}
function data(value: unknown): string { return `data: ${JSON.stringify(value)}\r\n\r\n`; }
function choice(delta: unknown, finish: string | null = null): unknown {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}
function sse(parts: (string | Uint8Array)[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part); controller.close(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const readDefinition = { name: 'read_file', description: 'Read bounded source', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} };
async function collect(provider: GroqProvider, input = request, signal?: AbortSignal): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.stream(input, signal)) events.push(event);
  return events;
}
function isCode(code: string): (error: unknown) => boolean {
  return error => error instanceof LittleError && error.code === code;
}

test('discovers current active models and keeps unknown tool capabilities', async () => {
  const provider = new GroqProvider(secrets(), async (url, options) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/models');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-private-key');
    return Response.json({ data: [
      { id: 'z-new', context_window: 131072 }, { id: 'a-new', name: 'A new model', context_window: 8192 },
      { id: 'a-new' }, { id: 'inactive', active: false },
    ] });
  });
  assert.deepEqual(await provider.listModels(), [
    { id: 'a-new', name: 'A new model', contextWindow: 8192, capabilities: { streaming: true, tools: 'unknown' } },
    { id: 'z-new', name: 'z-new', contextWindow: 131072, capabilities: { streaming: true, tools: 'unknown' } },
  ]);
});

test('chat model discovery excludes speech, safety, hosted agents, and explicitly incompatible models', async () => {
  const provider = new GroqProvider(secrets(), async () => Response.json({ data: [
    { id: 'canopylabs/orpheus-v1-english', context_window: 4000 },
    { id: 'whisper-large-v3' }, { id: 'whisper-large-v3-turbo' },
    { id: 'meta-llama/llama-prompt-guard-2-22m' }, { id: 'openai/gpt-oss-safeguard-20b' },
    { id: 'groq/compound' }, { id: 'groq/compound-mini' },
    { id: 'novel-model', task: 'speech-to-text' },
    { id: 'other-a', supported_endpoints: ['/v1/audio/speech'] },
    { id: 'other-b', modalities: { output: ['audio'] } },
    { id: 'other-c', supports_streaming: false },
    { id: 'openai/gpt-oss-120b', context_window: 65536, max_completion_tokens: 12000 },
    { id: 'openai/gpt-oss-20b' }, { id: 'llama-3.1-8b-instant' },
    { id: 'future-chat', supported_endpoints: ['/v1/chat/completions'], supports_tool_calling: false },
    { id: 'another-future' },
    null, {}, { id: '../bad id\n' }, { id: 'inactive', active: false },
  ] }));
  const models = await provider.listModels();
  assert.deepEqual(models.map(model => model.id), ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'another-future', 'future-chat']);
  assert.deepEqual(models.find(model => model.id === 'openai/gpt-oss-120b'), {
    id: 'openai/gpt-oss-120b', name: 'openai/gpt-oss-120b', contextWindow: 65536, maxOutputTokens: 12000,
    capabilities: { streaming: true, tools: true, reasoning: true },
  });
  assert.equal(models.find(model => model.id === 'another-future')?.capabilities.tools, 'unknown');
  assert.equal(models.find(model => model.id === 'future-chat')?.capabilities.tools, false);
});

test('published metadata never invents models absent from authenticated discovery', async () => {
  const provider = new GroqProvider(secrets(), async () => Response.json({ data: [{ id: 'whisper-large-v3' }] }));
  assert.deepEqual(await provider.listModels(), []);
  const invalid = new GroqProvider(secrets(), async () => Response.json({ data: [{ id: 'future', name: 'bad\nname', context_window: -1, max_completion_tokens: 1e15 }, { id: 'constructor' }] }));
  assert.deepEqual(await invalid.listModels(), [
    { id: 'constructor', name: 'constructor', capabilities: { streaming: true, tools: 'unknown' } },
    { id: 'future', name: 'future', capabilities: { streaming: true, tools: 'unknown' } },
  ]);
});

test('streams split UTF-8 bytes, CRLF boundaries, and multiline SSE data', async () => {
  const text = ': keepalive\r\n\r\n' +
    'data: {"choices": [\r\ndata: {"index": 0, "delta": {"content": "Hi 🌍"}, "finish_reason": null}]}\r\n\r\n' +
    data(choice({}, 'stop')) + data({ choices: [], x_groq: { usage: { prompt_tokens: 11, completion_tokens: 3 } } }) +
    'data: [DONE]\r\n\r\n';
  const bytes = encoder.encode(text);
  const provider = new GroqProvider(secrets(), async () => sse(Array.from(bytes, byte => new Uint8Array([byte]))));
  assert.deepEqual(await collect(provider), [
    { type: 'text', text: 'Hi 🌍' }, { type: 'usage', inputTokens: 11, outputTokens: 3 }, { type: 'done', reason: 'stop' },
  ]);
});

test('maps host messages and tools without exposing the key in the body', async () => {
  const provider = new GroqProvider(secrets(), async (_url, options) => {
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    assert.equal(body.stream, true);
    assert.equal(body.max_completion_tokens, 123);
    assert.equal(body.max_tokens, undefined);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.deepEqual(body.messages, [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', content: 'source', tool_call_id: 'call1' },
    ]);
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }]);
    assert.equal(String(options?.body).includes('test-private-key'), false);
    return sse([data(choice({ content: 'Result' }, 'stop')), 'data: [DONE]\n\n']);
  });
  await collect(provider, {
    model: 'test-model', maxOutputTokens: 123,
    messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
      { role: 'tool', content: 'source', toolCallId: 'call1' }],
    tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
  });
});

test('GPT OSS120B uses sequential native tool calling with bounded effort and excludes provider private reasoning', async () => {
  const provider = new GroqProvider(secrets(), async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.include_reasoning, false);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.reasoning_format, undefined, 'GPT OSS does not support reasoning_format.');
    assert.equal(body.max_completion_tokens, 2048);
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools, [{ type: 'function', function: readDefinition }]);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.response_format, undefined);
    return sse([data(choice({ content: 'Visible answer.', reasoning: 'Private provider reasoning' }, 'stop')),
      data({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 25 } }), 'data: [DONE]\n\n']);
  });
  assert.deepEqual(await collect(provider, { ...request, model: 'openai/gpt-oss-120b', maxOutputTokens: 2048,
    tools: [readDefinition] }), [
    { type: 'text', text: 'Visible answer.' }, { type: 'usage', inputTokens: 1200, outputTokens: 25 }, { type: 'done', reason: 'stop' },
  ]);
});

test('Qwen reasoning options remain compatible with tool use and keep reasoning hidden', async () => {
  const provider = new GroqProvider(secrets(), async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    assert.equal(body.reasoning_format, 'hidden');
    assert.equal(body.reasoning_effort, 'default');
    assert.equal(body.include_reasoning, undefined);
    return sse([data(choice({ content: 'Done.' }, 'stop')), 'data: [DONE]\n\n']);
  });
  await collect(provider, { ...request, model: 'qwen/qwen3.8-27b' });
});

test('native GPT OSS policy covers both models and preserves model-specific options for other models or plain requests', async () => {
  for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'future-chat']) {
    const provider = new GroqProvider(secrets(), async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      assert.equal(body.parallel_tool_calls, model.startsWith('openai/gpt-oss-') ? false : undefined);
      assert.equal(body.stream, true);
      assert.equal(body.response_format, undefined);
      assert.ok(body.tools);
      return sse([data(choice({ content: 'Answer' }, 'stop')), 'data: [DONE]\n\n']);
    });
    await collect(provider, { ...request, model, tools: [readDefinition] });
  }
  const plain = new GroqProvider(secrets(), async (_url, options) => {
    assert.equal((JSON.parse(String(options?.body)) as Record<string, unknown>).parallel_tool_calls, undefined);
    return sse([data(choice({ content: 'Hello' }, 'stop')), 'data: [DONE]\n\n']);
  });
  await collect(plain, { ...request, model: 'openai/gpt-oss-120b' });
});

test('HTTP200 SSE errors retain actionable categories without reflecting provider secrets or replaying', async () => {
  for (const [detail, code, category] of [
    [{ code: 'tool_use_failed' }, 'PROVIDER_PROTOCOL_ERROR', 'tool_call'],
    [{ code: 'context_length_exceeded' }, 'CONTEXT_LIMIT', 'context'],
    [{ code: 'model_decommissioned' }, 'MODEL_UNAVAILABLE', 'model'],
    [{ code: 'invalid_api_key' }, 'PROVIDER_AUTH_FAILED', 'auth'],
    [{ type: 'invalid_request_error' }, 'PROVIDER_PROTOCOL_ERROR', 'parameters'],
    [{ type: 'server_error' }, 'PROVIDER_UNAVAILABLE', 'server'],
    [{ status: 498 }, 'PROVIDER_UNAVAILABLE', 'capacity'],
    [{ code: 'test-private-key' }, 'PROVIDER_UNAVAILABLE', 'unknown'],
  ] as const) {
    let count = 0;
    const provider = new GroqProvider(secrets(), async () => { count++; return sse([data({ error: {
      ...detail, message: 'test-private-key private prompt and organization', failed_generation: 'PRIVATE_TOOL_ARGUMENTS',
    } })]); });
    await assert.rejects(collect(provider), error => {
      assert.ok(error instanceof LittleError);
      assert.equal(error.code, code);
      assert.equal(error.diagnostic?.phase, 'stream');
      assert.equal(error.diagnostic?.category, category);
      assert.equal(error.diagnostic?.status, 'status' in detail ? detail.status : undefined);
      assert.equal(JSON.stringify(error).includes('test-private-key'), false);
      assert.equal(JSON.stringify(error).includes('PRIVATE_TOOL_ARGUMENTS'), false);
      assert.equal(error.message.includes('organization'), false);
      return true;
    });
    assert.equal(count, 1);
  }
});

test('streamed rate limit records body quota and reset even after successful HTTP headers', async () => {
  let count = 0;
  const provider = new GroqProvider(secrets(), async () => {
    count++;
    const response = sse([data({ error: { code: 'rate_limit_exceeded', message: 'private-org on tokens per minute (TPM): Limit 8000, Used 7500, Requested 4800. Please try again in 120s. test-private-key' } })]);
    response.headers.set('x-ratelimit-remaining-tokens', '7500');
    return response;
  });
  await assert.rejects(collect(provider), error => error instanceof LittleError && error.code === 'PROVIDER_RATE_LIMITED' &&
    error.retryAfterMs === 120000 && error.diagnostic?.category === 'rate_limit' &&
    error.message.includes('8,000 tokens per minute') && error.message.includes('4,800 requested tokens') &&
    error.message.includes('Retry in 2 minutes') && !error.message.includes('private-org') && !error.message.includes('test-private-key'));
  assert.equal(count, 1);
  assert.equal(provider.requestLimits(request.model)?.tokensPerMinute, 8000);
  assert.ok((provider.requestLimits(request.model)?.retryAfterMs ?? 0) > 119000);
});

test('stream failure never emits buffered tools, done, or usage and preserves only safe correlation', async () => {
  const events: LLMEvent[] = [];
  const id = 'req_01jbd6g2qdfw2adyrt2az8hz4w';
  const provider = new GroqProvider(secrets(), async () => sse([
    data({ ...choice({ content: 'Partial answer.' }) as object, x_groq: { id } }),
    data(choice({ tool_calls: [{ index: 0, id: 'read-one', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] })),
    data({ error: { code: 'tool_use_failed', message: 'private failed_generation', failed_generation: 'PRIVATE_TOOL_SOURCE' } }),
    data(choice({}, 'tool_calls')), 'data: [DONE]\n\n',
  ]));
  await assert.rejects(async () => { for await (const event of provider.stream(request)) events.push(event); }, error => {
    assert.ok(error instanceof LittleError);
    assert.deepEqual(error.diagnostic, { provider: 'groq', phase: 'stream', category: 'tool_call', requestId: id });
    assert.match(error.message, /No tool from this response was executed/);
    return true;
  });
  assert.deepEqual(events, [{ type: 'text', text: 'Partial answer.' }]);
});

test('malformed or oversized stream error details and correlation identifiers stay bounded and private', async () => {
  for (const error of [false, 'test-private-key', [], { code: 'test-private-key'.repeat(10), message: 'private prompt '.repeat(1000) }]) {
    const provider = new GroqProvider(secrets(), async () => sse([data({ x_groq: { id: 'req_test-private-key' }, error })]));
    await assert.rejects(collect(provider), failure => {
      assert.ok(failure instanceof LittleError);
      assert.equal(failure.diagnostic?.phase, 'stream');
      assert.equal(failure.diagnostic?.category, 'unknown');
      assert.equal(failure.diagnostic?.requestId, undefined);
      assert.equal(failure.message.includes('private'), false);
      assert.equal(JSON.stringify(failure).includes('test-private-key'), false);
      return true;
    });
  }
});

test('known function-call failure text without a code is classified without copying failed generation', async () => {
  const provider = new GroqProvider(secrets(), async () => sse([data({ error: { type: 'invalid_request_error',
    message: 'Failed to call a function. Please adjust your prompt. failed_generation=test-private-key',
  } })]));
  await assert.rejects(collect(provider), error => error instanceof LittleError && error.diagnostic?.category === 'tool_call' &&
    error.message.includes('valid tool call') && !error.message.includes('test-private-key'));
});

test('assembles interleaved fragmented tool calls by index and emits only complete calls', async () => {
  const provider = new GroqProvider(secrets(), async () => sse([
    data(choice({ tool_calls: [
      { index: 1, id: 'call_', type: 'function', function: { name: 'list_', arguments: '{' } },
      { index: 0, id: 'read_', type: 'function', function: { name: 'read_', arguments: '{"pa' } },
    ] })),
    data(choice({ tool_calls: [
      { index: 0, id: '1', function: { name: 'file', arguments: 'th":"file.ts"}' } },
      { index: 1, id: '2', function: { name: 'files', arguments: '}' } },
    ] }, 'tool_calls')),
    'data: [DONE]\n\n',
  ]));
  assert.deepEqual(await collect(provider, { ...request, tools: [readDefinition, { name: 'list_files', description: 'List bounded files', parameters: { type: 'object' } }] }), [
    { type: 'tool_call', call: { id: 'read_1', name: 'read_file', arguments: '{"path":"file.ts"}' } },
    { type: 'tool_call', call: { id: 'call_2', name: 'list_files', arguments: '{}' } },
    { type: 'done', reason: 'tool_calls' },
  ]);
});

test('missing credentials fail before sending a network request', async () => {
  const missing = new GroqProvider({ ...secrets(), get: async () => undefined }, async () => { assert.fail('must not fetch'); });
  const empty = new GroqProvider(secrets(''), async () => { assert.fail('must not fetch'); });
  await assert.rejects(collect(missing), isCode('PROVIDER_AUTH_FAILED'));
  await assert.rejects(collect(empty), isCode('PROVIDER_AUTH_FAILED'));
  assert.equal(empty.id, 'groq');
});

test('auth and model failures use sanitized messages and never replay generation', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [404, 'MODEL_UNAVAILABLE'], [413, 'CONTEXT_LIMIT'], [498, 'PROVIDER_UNAVAILABLE'], [500, 'PROVIDER_UNAVAILABLE']] as const) {
    let count = 0;
    const provider = new GroqProvider(secrets(), async () => { count++; return new Response('secret: test-private-key raw internal detail', { status }); });
    await assert.rejects(collect(provider), error => {
      assert.ok(error instanceof LittleError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('test-private-key'), false);
      assert.equal(error.message.includes('raw internal detail'), false);
      return true;
    });
    assert.equal(count, 1);
  }
});

test('rate limits expose numeric and HTTP date retry delays', async () => {
  const numeric = new GroqProvider(secrets(), async () => new Response('private detail', { status: 429, headers: { 'Retry-After': '1.25' } }));
  await assert.rejects(collect(numeric), error => error instanceof LittleError && error.code === 'PROVIDER_RATE_LIMITED' && error.retryAfterMs === 1250);
  const future = new Date(Date.now() + 60000).toUTCString();
  const dated = new GroqProvider(secrets(), async () => new Response('', { status: 429, headers: { 'Retry-After': future } }));
  await assert.rejects(collect(dated), error => error instanceof LittleError && error.code === 'PROVIDER_RATE_LIMITED' &&
    typeof error.retryAfterMs === 'number' && error.retryAfterMs > 58000 && error.retryAfterMs <= 60000);
});

test('429 explains exact observed TPM and oversized request without reflecting private error text or replaying', async () => {
  let requests = 0;
  const provider = new GroqProvider(secrets(), async () => {
    requests++;
    return Response.json({ error: { code: 'rate_limit_exceeded', message: 'Rate limit for openai/gpt-oss-120b in organization private-org test-private-key on tokens per minute (TPM): Limit 8000, Used 7000, Requested 21500. Please try again in 41.2s. secret=private-request-text' } }, {
      status: 429, headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '41.2s', 'retry-after': '42' },
    });
  });
  await assert.rejects(collect(provider, { ...request, model: 'openai/gpt-oss-120b' }), error => {
    assert.ok(error instanceof LittleError);
    assert.equal(error.code, 'PROVIDER_RATE_LIMITED');
    assert.equal(error.retryAfterMs, 42000);
    assert.match(error.message, /8,000 tokens per minute/);
    assert.match(error.message, /21,500 requested tokens/);
    assert.match(error.message, /Waiting alone will not make this request fit/);
    for (const privateText of ['private-org', 'test-private-key', 'private-request-text', 'Used 7000']) assert.equal(error.message.includes(privateText), false);
    return true;
  });
  assert.equal(requests, 1);
  const observed = provider.requestLimits('openai/gpt-oss-120b');
  assert.equal(observed?.tokensPerMinute, 8000);
  assert.equal(observed?.remainingTokens, 0);
  assert.ok((observed?.resetAfterMs ?? 0) <= 41200);
  assert.equal(provider.requestLimits('different-model'), undefined);
});

test('known numeric rate-limit envelope provides safe fallback when headers are absent', async () => {
  const provider = new GroqProvider(secrets(), async () => Response.json({ error: {
    message: 'Limit reached on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2100. Please try again in 12.5s. api_key=gsk_PRIVATE_DO_NOT_DISPLAY',
  } }, { status: 429 }));
  await assert.rejects(collect(provider), error => error instanceof LittleError && error.retryAfterMs === 12500 &&
    error.message.includes('6,000 tokens per minute') && error.message.includes('Retry in 13 seconds') && !error.message.includes('gsk_PRIVATE'));
  assert.equal(provider.requestLimits('test-model')?.tokensPerMinute, 6000);
});

test('request and token reset headers expire without retaining exhausted counters', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const provider = new GroqProvider(secrets(), async () => {
    const response = sse([data(choice({ content: 'Answer' }, 'stop')), 'data: [DONE]\n\n']);
    response.headers.set('x-ratelimit-limit-tokens', '8000');
    response.headers.set('x-ratelimit-remaining-tokens', '0');
    response.headers.set('x-ratelimit-reset-tokens', '10s');
    response.headers.set('x-ratelimit-remaining-requests', '0');
    response.headers.set('x-ratelimit-reset-requests', '2m59.56s');
    return response;
  });
  await collect(provider);
  assert.deepEqual(provider.requestLimits(request.model), { tokensPerMinute: 8000, remainingTokens: 0, resetAfterMs: 10000, requestsRemaining: 0, requestsResetAfterMs: 179560 });
  t.mock.timers.setTime(15_000);
  assert.equal(provider.requestLimits(request.model)?.resetAfterMs, 5000);
  t.mock.timers.setTime(20_000);
  assert.equal(provider.requestLimits(request.model)?.remainingTokens, undefined);
  assert.equal(provider.requestLimits(request.model)?.requestsRemaining, 0);
  t.mock.timers.setTime(190_000);
  assert.deepEqual(provider.requestLimits(request.model), { tokensPerMinute: 8000 });
  provider.resetRequestLimits();
  assert.equal(provider.requestLimits(request.model), undefined);
});

test('daily request exhaustion has distinct actionable cooldown and bounded error parsing', async () => {
  const daily = new GroqProvider(secrets(), async () => Response.json({ error: { message: 'private organization quota' } }, {
    status: 429, headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2h3m' },
  }));
  await assert.rejects(collect(daily), error => error instanceof LittleError && error.retryAfterMs === 7380000 &&
    error.message.includes('daily request quota') && error.message.includes('Retry in 3 hours') && !error.message.includes('private organization'));
  const huge = new GroqProvider(secrets(), async () => Response.json({ error: { message: 'private request echo '.repeat(10000) } }, {
    status: 429, headers: { 'x-ratelimit-limit-tokens': 'Infinity', 'retry-after': '9999999999999999999999999999' },
  }));
  await assert.rejects(collect(huge), error => error instanceof LittleError && error.retryAfterMs === undefined &&
    !error.message.includes('private request echo') && !error.message.includes('Infinity'));
  assert.deepEqual(groqResetDuration('2m59.56s'), 179560);
  assert.equal(groqResetDuration('api_key=private'), undefined);
  assert.equal(groqResetDuration('100d'), undefined);
});

test('structured decommissioned, context, and tool-call failures have safe corrective messages', async () => {
  for (const [code, expected] of [['model_decommissioned', 'MODEL_UNAVAILABLE'], ['context_length_exceeded', 'CONTEXT_LIMIT'], ['tool_use_failed', 'PROVIDER_PROTOCOL_ERROR']] as const) {
    let count = 0;
    const provider = new GroqProvider(secrets(), async () => { count++; return Response.json({ error: { code, message: 'private failed_generation tool arguments' } }, { status: 400 }); });
    await assert.rejects(collect(provider), error => error instanceof LittleError && error.code === expected && !error.message.includes('failed_generation'));
    assert.equal(count, 1);
  }
});

test('discovery retries only bounded transient responses', async () => {
  let count = 0;
  const provider = new GroqProvider(secrets(), async () => {
    count++;
    return count < 3 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : Response.json({ data: [{ id: 'dynamic' }] });
  });
  assert.equal((await provider.listModels())[0]?.id, 'dynamic');
  assert.equal(count, 3);
  let failures = 0;
  const failing = new GroqProvider(secrets(), async () => { failures++; return new Response('', { status: 429, headers: { 'Retry-After': '0' } }); });
  await assert.rejects(failing.listModels(), isCode('PROVIDER_RATE_LIMITED'));
  assert.equal(failures, 3);
});

test('discovery deadline releases an unresponsive fetch with an actionable error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started: (() => void) | undefined;
  const fetched = new Promise<void>(resolve => { started = resolve; });
  let delivered: AbortSignal | null | undefined;
  const provider = new GroqProvider(secrets(), async (_url, options) => {
    delivered = options?.signal;
    started?.();
    return new Promise(() => undefined);
  });
  const pending = provider.listModels();
  await fetched;
  t.mock.timers.tick(12000);
  await assert.rejects(pending, error => error instanceof LittleError && error.code === 'PROVIDER_UNAVAILABLE' && error.message.includes('discovery timed out'));
  assert.equal(delivered?.aborted, true);
});

test('a partial stream is never retried and requires the DONE marker', async () => {
  let count = 0;
  const provider = new GroqProvider(secrets(), async () => { count++; return sse([data(choice({ content: 'partial' }, 'stop'))]); });
  const observed: LLMEvent[] = [];
  await assert.rejects(async () => { for await (const event of provider.stream(request)) observed.push(event); }, isCode('PROVIDER_PROTOCOL_ERROR'));
  assert.deepEqual(observed, [{ type: 'text', text: 'partial' }]);
  assert.equal(count, 1);
});

test('rejects malformed JSON and malformed tool calls without emitting tools', async () => {
  const malformed = [
    'data: {bad}\n\n',
    data(choice({ tool_calls: [{ index: 0, id: 'call', function: { name: 'read_file', arguments: '{' } }] }, 'tool_calls')) + 'data: [DONE]\n\n',
    data(choice({ tool_calls: [{ index: -1, id: 'call', function: { name: 'read_file', arguments: '{}' } }] }, 'tool_calls')) + 'data: [DONE]\n\n',
    data(choice({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls')) + 'data: [DONE]\n\n',
  ];
  for (const fixture of malformed) {
    const observed: LLMEvent[] = [];
    const provider = new GroqProvider(secrets(), async () => sse([fixture]));
    await assert.rejects(async () => { for await (const event of provider.stream(request)) observed.push(event); }, isCode('PROVIDER_PROTOCOL_ERROR'));
    assert.equal(observed.some(event => event.type === 'tool_call'), false);
  }
});

test('bounds individual tool arguments and unfinished SSE lines', async () => {
  for (const fixture of [
    data(choice({ tool_calls: [{ index: 0, id: 'call', function: { name: 'read_file', arguments: 'x'.repeat(256 * 1024 + 1) } }] }, 'tool_calls')),
    `data: ${'x'.repeat(1024 * 1024 + 1)}`,
  ]) {
    const provider = new GroqProvider(secrets(), async () => sse([fixture]));
    await assert.rejects(collect(provider), isCode('PROVIDER_PROTOCOL_ERROR'));
  }
});

test('pre-aborted requests never fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new GroqProvider(secrets(), async () => { assert.fail('must not fetch'); });
  await assert.rejects(collect(provider, request, controller.signal), isCode('AGENT_CANCELLED'));
  await assert.rejects(provider.listModels(controller.signal), isCode('AGENT_CANCELLED'));
});

test('cancellation does not wait for a pending secret store read', async () => {
  const controller = new AbortController();
  const provider = new GroqProvider({ ...secrets(), get: () => new Promise(() => undefined) }, async () => { assert.fail('must not fetch'); });
  const pending = collect(provider, request, controller.signal);
  controller.abort();
  await assert.rejects(pending, isCode('AGENT_CANCELLED'));
});

test('discovery and generation cancellation do not wait for an unresponsive network adapter', async () => {
  for (const discover of [true, false]) {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const fetched = new Promise<void>(resolve => { started = resolve; });
    const provider = new GroqProvider(secrets(), async () => { started?.(); return new Promise(() => undefined); });
    const pending = discover ? provider.listModels(controller.signal) : collect(provider, request, controller.signal);
    await fetched;
    controller.abort();
    await assert.rejects(pending, isCode('AGENT_CANCELLED'));
  }
});

test('cancelling a pending error envelope stops body reading without losing cancellation', async () => {
  const controller = new AbortController();
  let reading: (() => void) | undefined;
  const started = new Promise<void>(resolve => { reading = resolve; });
  let closed = false;
  const provider = new GroqProvider(secrets(), async () => new Response(new ReadableStream<Uint8Array>({
    pull() { reading?.(); }, cancel() { closed = true; },
  }), { status: 429 }));
  const pending = collect(provider, request, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, isCode('AGENT_CANCELLED'));
  assert.equal(closed, true);
});

test('cancellation between complete tool events stops further emission', async () => {
  const controller = new AbortController();
  const provider = new GroqProvider(secrets(), async () => sse([
    data(choice({ tool_calls: [
      { index: 0, id: 'first', function: { name: 'read_file', arguments: '{}' } },
      { index: 1, id: 'second', function: { name: 'read_file', arguments: '{}' } },
    ] }, 'tool_calls')), 'data: [DONE]\n\n',
  ]));
  const iterator = provider.stream({ ...request, tools: [readDefinition] }, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'tool_call');
  controller.abort();
  await assert.rejects(iterator.next(), isCode('AGENT_CANCELLED'));
});

test('cancelling a pending stream read closes the body and propagates cancellation', async () => {
  const controller = new AbortController();
  let bodyCancelled = false;
  let deliveredSignal: AbortSignal | null | undefined;
  const provider = new GroqProvider(secrets(), async (_url, options) => {
    deliveredSignal = options?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(encoder.encode(data(choice({ content: 'first' })))); },
      cancel() { bodyCancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const iterator = provider.stream(request, controller.signal)[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { type: 'text', text: 'first' });
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, isCode('AGENT_CANCELLED'));
  assert.equal(bodyCancelled, true);
  assert.equal(deliveredSignal, controller.signal);
});

test('network errors do not disclose raw fetch errors or keys', async () => {
  const provider = new GroqProvider(secrets(), async () => { throw new TypeError('test-private-key private request headers'); });
  await assert.rejects(collect(provider), error => error instanceof LittleError && error.code === 'PROVIDER_UNAVAILABLE' && !error.message.includes('test-private-key'));
});
