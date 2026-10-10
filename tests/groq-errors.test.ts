import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groqHttpError, groqStreamError, groqStructuredError } from '../src/little/providers/groq-errors';
import { LittleError } from '../src/little/shared/errors';

const requestId = 'req_01m0jacw8zemabfp437wn7hdt8';
const privateMarker = 'PRIVATE_PROMPT_SOURCE_CREDENTIAL_ORGANIZATION';
async function http(error: Record<string, unknown>, status = 400, headers: HeadersInit = {}) {
  return groqHttpError(Response.json({ error }, { status, headers }), true);
}
function assertPrivate(result: Awaited<ReturnType<typeof http>>): void {
  const visible = JSON.stringify({ code: result.error.code, message: result.error.message, diagnostic: result.error.diagnostic, limits: result.limits });
  assert.equal(visible.includes(privateMarker), false);
  assert.equal(visible.includes('failed_generation'), false);
}

test('an invalid response schema is distinct from a generated structured-output failure', async () => {
  const invalid = await http({ type: 'invalid_request_error', code: 'invalid_json_schema',
    param: `response_format.json_schema.schema.properties.${privateMarker}`, message: privateMarker, failed_generation: privateMarker },
    400, { 'x-request-id': requestId });
  assert.equal(invalid.error.code, 'PROVIDER_PROTOCOL_ERROR');
  assert.deepEqual(invalid.error.diagnostic, { provider: 'groq', phase: 'http', category: 'parameters', status: 400,
    requestId, providerCode: 'invalid_json_schema', parameter: 'response_format', reason: 'invalid_schema' });
  assert.match(invalid.error.message, /rejected Little Code's response schema/);
  assertPrivate(invalid);
  for (const code of ['json_validate_failed', 'structured_generation_failed']) {
    const generated = await http({ type: 'invalid_request_error', code, param: 'response_format',
      message: `Generated JSON does not match the expected schema. ${privateMarker}`, failed_generation: privateMarker });
    assert.equal(generated.error.code, 'PROVIDER_PROTOCOL_ERROR');
    assert.equal(generated.error.diagnostic?.category, 'tool_call');
    assert.equal(generated.error.diagnostic?.reason, 'schema_generation');
    assert.equal(generated.error.diagnostic?.providerCode, code);
    assert.equal(generated.error.diagnostic?.parameter, 'response_format');
    assert.match(generated.error.message, /could not generate the requested structured response/);
    assert.doesNotMatch(generated.error.message, /rejected.*(?:parameters|schema)/i);
    assertPrivate(generated);
  }
});

test('a provider grammar complexity rejection records only a fixed reason and root parameter', async () => {
  const result = await http({ type: 'invalid_request_error', code: 'invalid_request_error', param: 'response_format.json_schema.schema',
    message: `The response schema is too complex for the grammar size limit. ${privateMarker}`, failed_generation: privateMarker });
  assert.equal(result.error.diagnostic?.category, 'parameters');
  assert.equal(result.error.diagnostic?.reason, 'schema_complexity');
  assert.equal(result.error.diagnostic?.parameter, 'response_format');
  assert.equal(result.error.diagnostic?.providerCode, 'invalid_request_error');
  assert.match(result.error.message, /complexity/);
  assertPrivate(result);
});

test('unsupported model options are distinct from rejected schemas and failed generation', async () => {
  for (const input of [
    { code: 'unsupported_response_format', param: 'response_format', message: privateMarker },
    { code: 'invalid_request_error', param: 'reasoning_effort', message: `Unsupported parameter for this model. ${privateMarker}` },
  ]) {
    const result = await http({ type: 'invalid_request_error', ...input, failed_generation: privateMarker });
    assert.equal(result.error.diagnostic?.category, 'parameters');
    assert.equal(result.error.diagnostic?.reason, 'unsupported_parameter');
    assert.equal(result.error.diagnostic?.parameter, input.param);
    assert.equal(result.error.diagnostic?.providerCode, input.code);
    assert.match(result.error.message, /does not support a requested option/);
    assertPrivate(result);
  }
});

test('recognized generation failures remain recognizable without a provider error code', async () => {
  const result = await http({ type: 'invalid_request_error', message: `Generated JSON does not match the expected schema. ${privateMarker}`,
    failed_generation: privateMarker });
  assert.equal(result.error.diagnostic?.reason, 'schema_generation');
  assert.equal(result.error.diagnostic?.category, 'tool_call');
  assert.equal(result.error.diagnostic?.providerCode, undefined);
  assertPrivate(result);
});

test('only known root request parameters are retained; nested property details are discarded', async () => {
  const names = ['response_format', 'reasoning_effort', 'include_reasoning', 'max_completion_tokens', 'messages', 'model'];
  for (const name of names) {
    for (const suffix of ['', `.${privateMarker}`, `[${privateMarker}]`]) {
      const result = await http({ code: 'invalid_request_error', param: name + suffix, message: privateMarker, failed_generation: privateMarker });
      assert.equal(result.error.diagnostic?.parameter, name);
      assertPrivate(result);
    }
  }
  for (const param of [privateMarker, 'model_extra', 'response_format_extra', 'messages-private', 'Authorization', 'api_key', 'tools[0]',
    { privateMarker }, 42, null]) {
    const result = await http({ code: 'invalid_request_error', param, message: privateMarker, failed_generation: privateMarker });
    assert.equal(result.error.diagnostic?.parameter, undefined);
    assertPrivate(result);
  }
});

test('arbitrary provider codes and request IDs never enter diagnostics', async () => {
  for (const code of [privateMarker, 'json_validate_failed_private', 'INVALID_JSON_SCHEMA', 42, null]) {
    const result = await http({ type: 'invalid_request_error', code, message: privateMarker, failed_generation: privateMarker },
      400, { 'x-request-id': privateMarker });
    assert.equal(result.error.code, 'PROVIDER_PROTOCOL_ERROR');
    assert.equal(result.error.diagnostic?.providerCode, undefined);
    assert.equal(result.error.diagnostic?.requestId, undefined);
    assert.equal(result.error.diagnostic?.reason, undefined);
    assertPrivate(result);
  }
});

test('unknown HTTP 400 failures make no unsupported assertion that the schema was invalid', async () => {
  const result = await http({ type: 'invalid_request_error', message: privateMarker,
    failed_generation: 'invalid schema; schema too large; unsupported parameter; failed to call a function' });
  assert.equal(result.error.diagnostic?.category, 'parameters');
  assert.equal(result.error.diagnostic?.reason, undefined);
  assert.equal(result.error.diagnostic?.providerCode, undefined);
  assert.match(result.error.message, /Groq rejected the request\./);
  assert.doesNotMatch(result.error.message, /rejected.*(?:parameters|schema)/i);
  assertPrivate(result);
});

test('HTTP 200 structured and stream errors preserve generation reasons with their own phases', () => {
  const body = { type: 'invalid_request_error', code: 'json_validate_failed', status_code: 400, param: 'response_format',
    message: privateMarker, failed_generation: privateMarker };
  for (const [classify, phase] of [[groqStructuredError, 'structured'], [groqStreamError, 'stream']] as const) {
    const result = classify(body, new Headers(), requestId);
    assert.deepEqual(result.error.diagnostic, { provider: 'groq', phase, category: 'tool_call', status: 400, requestId,
      providerCode: 'json_validate_failed', parameter: 'response_format', reason: 'schema_generation' });
    assertPrivate(result);
  }
});

test('malformed or oversized HTTP error bodies remain bounded and disclose no partial metadata', async () => {
  const responses = [
    new Response(`not JSON ${privateMarker}`, { status: 400 }),
    new Response(JSON.stringify({ error: { code: 'invalid_json_schema', param: 'response_format', message: privateMarker.repeat(200) } }), { status: 400 }),
    Response.json({ error: [privateMarker] }, { status: 400 }),
  ];
  for (const response of responses) {
    const result = await groqHttpError(response, true);
    assert.equal(result.error.diagnostic?.providerCode, undefined);
    assert.equal(result.error.diagnostic?.parameter, undefined);
    assert.equal(result.error.diagnostic?.reason, undefined);
    assertPrivate(result);
  }
});

test('caller cancellation while reading an error never becomes a schema or generation error', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(groqHttpError(Response.json({ error: { code: 'invalid_json_schema', message: privateMarker } }, { status: 400 }),
    true, controller.signal), error => error instanceof LittleError && error.code === 'AGENT_CANCELLED' && error.diagnostic === undefined);
});
