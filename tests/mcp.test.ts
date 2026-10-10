import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpClient, McpError, MCP_LIMITS, validateMcpEndpoint, type McpTool } from '../src/little/mcp/client';
import { validateMcpInput, validateMcpSchema } from '../src/little/mcp/validate-input';

interface Rpc { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> }
interface Seen { message: Rpc; headers: IncomingMessage['headers'] }
const tool: McpTool = { name: 'echo', description: 'Return a short project note.', inputSchema: {
  type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 20 }, count: { type: 'integer', minimum: 1, maximum: 3 }, labels: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['one', 'two'] } } }, required: ['message'], additionalProperties: false,
} };
const signal = (): AbortSignal => new AbortController().signal;
const isMcp = (code: string) => (error: unknown): boolean => error instanceof McpError && error.mcpCode === code;

interface FixtureOptions {
  modern?: boolean;
  version?: string;
  tools?: unknown[];
  sse?: boolean;
  override?: (message: Rpc, response: ServerResponse, request: IncomingMessage) => boolean | Promise<boolean>;
}
async function fixture(t: TestContext, options: FixtureOptions = {}): Promise<{ client: McpClient; seen: Seen[]; url: string }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
      let body = '';
      for await (const bytes of request) body += String(bytes);
      const message = JSON.parse(body) as Rpc;
      seen.push({ message, headers: request.headers });
      if (await options.override?.(message, response, request)) return;
      if (message.method === 'server/discover' && !options.modern) { response.writeHead(400).end(); return; }
      if (message.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
      const result = message.method === 'server/discover' ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'stateless-test-server', version: '1.0.0' } } }
        : message.method === 'initialize'
        ? { protocolVersion: options.version ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-test-server', version: '1.0.0' } }
        : message.method === 'tools/list' ? { tools: options.tools ?? [{ ...tool, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: `Note: ${(message.params?.arguments as Record<string, unknown>)?.message ?? ''}` }], isError: false };
      const headers: Record<string, string> = { 'Content-Type': options.sse ? 'text/event-stream' : 'application/json' };
      if (message.method === 'initialize') headers['MCP-Session-Id'] = 'test-session';
      response.writeHead(200, headers);
      if (options.sse) {
        const json = JSON.stringify({ jsonrpc: '2.0', id: message.id, result }, null, 2);
        const payload = `: keepalive\r\nid: prime\r\ndata:\r\n\r\nevent: message\r\n${json.split('\n').map(line => `data: ${line}`).join('\r\n')}\r\n\r\n`;
        const bytes = Buffer.from(payload);
        for (let index = 0; index < bytes.length; index += 17) response.write(bytes.subarray(index, index + 17));
        response.end();
      } else response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tools/mcp`;
  const client = new McpClient({ id: '0123456789abcdef', name: 'Local fixture', url });
  t.after(async () => { client.disconnect(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { client, seen, url };
}
function json(response: ServerResponse, id: number | undefined, result: unknown): void { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result })); }
async function until(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > 2000) throw new Error('Local HTTP fixture did not observe the expected request.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('real HTTP handshake negotiates protocol/session and revalidates discovered tool arguments', async t => {
  const { client, seen } = await fixture(t, { version: '2025-06-18' });
  const discovered = await client.connect(signal());
  assert.deepEqual(seen.map(entry => entry.message.method), ['server/discover', 'initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(seen[1]?.message.params?.protocolVersion, '2025-11-25');
  assert.deepEqual(seen[1]?.message.params?.capabilities, {});
  assert.equal(seen[1]?.headers['mcp-session-id'], undefined);
  assert.equal(seen[1]?.headers['mcp-protocol-version'], undefined);
  assert.equal(seen[1]?.headers['mcp-method'], undefined);
  assert.match(String(seen[1]?.headers.accept), /application\/json, text\/event-stream/);
  for (const entry of seen.slice(2)) { assert.equal(entry.headers['mcp-session-id'], 'test-session'); assert.equal(entry.headers['mcp-protocol-version'], '2025-06-18'); }
  assert.deepEqual(discovered, [tool]);
  // Mutating metadata returned to the host cannot loosen the client's own schema.
  discovered[0]!.inputSchema.additionalProperties = true;
  await assert.rejects(client.callTool('echo', { message: 'hello', unexpected: true }, signal()), isMcp('MCP_INPUT_INVALID'));
  await assert.rejects(client.callTool('unknown', {}, signal()), isMcp('MCP_INPUT_INVALID'));
  await assert.rejects(client.callTool('echo', { message: 'hello', count: 99 }, signal()), isMcp('MCP_INPUT_INVALID'));
  assert.equal(seen.filter(entry => entry.message.method === 'tools/call').length, 0);
  assert.deepEqual(await client.callTool('echo', { message: 'hello', count: 2, labels: ['one'] }, signal()), { content: [{ type: 'text', text: 'Note: hello' }] });
  assert.equal(seen.at(-1)?.headers['mcp-session-id'], 'test-session');
  client.disconnect();
  await assert.rejects(client.callTool('echo', { message: 'hello' }, signal()), isMcp('MCP_NOT_CONNECTED'));
});

test('bounded SSE accepts UTF-8, split CRLF, priming and multiline JSON messages', async t => {
  const { client } = await fixture(t, { sse: true });
  await client.connect(signal());
  assert.deepEqual(await client.callTool('echo', { message: 'café' }, signal()), { content: [{ type: 'text', text: 'Note: café' }] });
});

test('endpoint validation prevents credentials, redirects, external DNS, ambiguous numeric hosts and query routing', async t => {
  assert.equal(validateMcpEndpoint('http://localhost:1234/mcp/nested'), 'http://127.0.0.1:1234/mcp/nested');
  assert.equal(validateMcpEndpoint('http://[::1]:1234/mcp'), 'http://[::1]:1234/mcp');
  for (const value of ['https://localhost/mcp', 'http://example.com/mcp', 'http://127.1/mcp', 'http://2130706433/mcp', 'http://user:pass@127.0.0.1/mcp', 'http://127.0.0.1/mcp?token=value', 'http://127.0.0.1/mcp#fragment', 'http://127.0.0.1:0/mcp', 'http://localhost\n/mcp']) assert.throws(() => validateMcpEndpoint(value), isMcp('MCP_CONFIG_INVALID'));
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => { redirectedRequests++; response.end('unexpected'); });
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
  t.after(async () => { destination.closeAllConnections(); await new Promise<void>(resolve => destination.close(() => resolve())); });
  const { client } = await fixture(t, { override(_message, response) { response.writeHead(307, { Location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/redirected` }).end(); return true; } });
  await assert.rejects(client.connect(signal()), isMcp('MCP_UNAVAILABLE'));
  assert.equal(redirectedRequests, 0);
});

test('unsupported negotiated versions, malformed schemas, duplicate tools and oversized metadata are rejected', async t => {
  const unsupported = await fixture(t, { version: '2026-07-28' });
  await assert.rejects(unsupported.client.connect(signal()), isMcp('MCP_PROTOCOL_ERROR'));
  for (const tools of [
    [tool, tool],
    [{ ...tool, name: 'x'.repeat(65) }],
    [{ ...tool, description: 'x'.repeat(1001) }],
    [{ ...tool, inputSchema: { type: 'object', properties: { path: { $ref: 'https://example.com/schema' } } } }],
    Array.from({ length: 51 }, (_, index) => ({ ...tool, name: `tool_${index}` })),
  ]) {
    const server = await fixture(t, { tools });
    await assert.rejects(server.client.connect(signal()), isMcp('MCP_PROTOCOL_ERROR'));
  }
});

test('tool metadata and returned embedded resources cannot disclose credentials', async t => {
  const secret = 'gsk_LeakedCredential1234567890123456';
  const metadata = await fixture(t, { tools: [{ ...tool, description: `Credentials: ${secret}` }] });
  await assert.rejects(metadata.client.connect(signal()), error => isMcp('MCP_PROTOCOL_ERROR')(error) && !String(error).includes(secret));
  const result = await fixture(t, { override(message, response) {
    if (message.method !== 'tools/call') return false;
    json(response, message.id, { content: [{ type: 'resource', resource: { uri: 'file:///private/credentials', text: 'private resource' } }] }); return true;
  } });
  await result.client.connect(signal());
  await assert.rejects(result.client.callTool('echo', { message: 'hello' }, signal()), isMcp('MCP_PROTOCOL_ERROR'));
  const credentials = await fixture(t, { override(message, response) {
    if (message.method !== 'tools/call') return false;
    json(response, message.id, { content: [{ type: 'text', text: secret }] }); return true;
  } });
  await credentials.client.connect(signal());
  await assert.rejects(credentials.client.callTool('echo', { message: 'hello' }, signal()), error => isMcp('MCP_PROTOCOL_ERROR')(error) && !String(error).includes(secret));
});

test('unrelated IDs, ambiguous duplicate JSON keys and repeated SSE replies fail closed', async t => {
  for (const format of ['unrelated', 'keys', 'sse'] as const) {
    const { client } = await fixture(t, { override(message, response) {
      if (message.method !== 'tools/call') return false;
      if (format === 'unrelated') json(response, (message.id ?? 0) + 1, { content: [] });
      else if (format === 'keys') response.writeHead(200, { 'Content-Type': 'application/json' }).end(`{"jsonrpc":"2.0","id":${message.id},"result":{"content":[]},"result":{"content":[]}}`);
      else { const frame = `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } })}\n\n`; response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(frame + frame); }
      return true;
    } });
    await client.connect(signal());
    await assert.rejects(client.callTool('echo', { message: 'hello' }, signal()), isMcp('MCP_PROTOCOL_ERROR'));
  }
});

test('actual HTTP cancellation aborts waiting, sends a cancellation notification and never retries a call', async t => {
  const { client, seen } = await fixture(t, { override(message, _response) { return message.method === 'tools/call'; } });
  await client.connect(signal());
  const controller = new AbortController();
  const pending = client.callTool('echo', { message: 'hello' }, controller.signal);
  const rejected = assert.rejects(pending, isMcp('MCP_CANCELLED'));
  await until(() => seen.some(entry => entry.message.method === 'tools/call'));
  const requestId = seen.find(entry => entry.message.method === 'tools/call')?.message.id;
  controller.abort();
  await rejected;
  await until(() => seen.some(entry => entry.message.method === 'notifications/cancelled'));
  const cancellation = seen.find(entry => entry.message.method === 'notifications/cancelled');
  assert.equal(cancellation?.message.params?.requestId, requestId);
  assert.equal(cancellation?.headers['mcp-session-id'], 'test-session');
  assert.equal(seen.filter(entry => entry.message.method === 'tools/call').length, 1);
});

test('response size limits and explicit server/tool errors are surfaced without raw diagnostics', async t => {
  for (const kind of ['large', 'rpc', 'tool'] as const) {
    const { client } = await fixture(t, { override(message, response) {
      if (message.method !== 'tools/call') return false;
      if (kind === 'large') json(response, message.id, { content: [{ type: 'text', text: 'x'.repeat(MCP_LIMITS.responseBytes + 1) }] });
      else if (kind === 'tool') json(response, message.id, { content: [{ type: 'text', text: 'Private server diagnostics must stay on the server.' }], isError: true });
      else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Private diagnostic text' } }));
      return true;
    } });
    await client.connect(signal());
    await assert.rejects(client.callTool('echo', { message: 'hello' }, signal()), error => isMcp(kind === 'large' ? 'MCP_RESPONSE_LIMIT' : kind === 'rpc' ? 'MCP_SERVER_ERROR' : 'MCP_TOOL_FAILED')(error) && !String(error).includes('Private'));
  }
});

test('supported JSON Schema subset enforces nested values and rejects unsupported validation keywords', () => {
  const schema = validateMcpSchema(tool.inputSchema);
  assert.deepEqual(validateMcpInput(schema, { message: 'hello', labels: ['one', 'two'], count: 3 }), { message: 'hello', labels: ['one', 'two'], count: 3 });
  for (const args of [{ message: '' }, { message: 'hello', count: 1.5 }, { message: 'hello', labels: ['three'] }, { message: 'hello', labels: ['one', 'two', 'one'] }, { message: 'hello', extra: true }]) assert.throws(() => validateMcpInput(schema, args), isMcp('MCP_INPUT_INVALID'));
  assert.throws(() => validateMcpSchema({ type: 'object', properties: { name: { type: 'string', pattern: '.+' } } }), isMcp('MCP_PROTOCOL_ERROR'));
  assert.throws(() => validateMcpSchema({ type: 'object', additionalProperties: { type: 'string' } }), isMcp('MCP_PROTOCOL_ERROR'));
});

test('current stateless HTTP uses explicit per-request metadata and mirrored headers without initialize or sessions', async t => {
  const { client, seen } = await fixture(t, { modern: true });
  assert.deepEqual(await client.connect(signal()), [tool]);
  assert.deepEqual(await client.callTool('echo', { message: 'hello' }, signal()), { content: [{ type: 'text', text: 'Note: hello' }] });
  assert.deepEqual(seen.map(entry => entry.message.method), ['server/discover', 'tools/list', 'tools/call']);
  for (const entry of seen) {
    const metadata = entry.message.params?._meta as Record<string, unknown>;
    assert.equal(entry.headers['mcp-protocol-version'], '2026-07-28');
    assert.equal(entry.headers['mcp-method'], entry.message.method);
    assert.equal(entry.headers['mcp-session-id'], undefined);
    assert.equal(metadata['io.modelcontextprotocol/protocolVersion'], entry.headers['mcp-protocol-version']);
    assert.deepEqual(metadata['io.modelcontextprotocol/clientCapabilities'], {});
    assert.deepEqual(metadata['io.modelcontextprotocol/clientInfo'], { name: 'little-code', version: '0.2.0' });
    assert.equal(metadata.progressToken, entry.message.id);
  }
  assert.equal(seen.at(-1)?.headers['mcp-name'], 'echo');
  client.disconnect();
  assert.equal(seen.filter(entry => entry.message.method.startsWith('notifications/')).length, 0);
});

test('current parameter headers follow exact nested paths and safely encode UTF-8, whitespace, controls and sentinels', async t => {
  const annotated: McpTool = { name: 'headers', description: 'Check header routing.', inputSchema: {
    type: 'object', additionalProperties: false, properties: {
      region: { type: 'string', 'x-mcp-header': 'Region' },
      details: { type: 'object', additionalProperties: false, properties: {
        count: { type: 'integer', 'x-mcp-header': 'Count' }, enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' },
        greeting: { type: 'string', 'x-mcp-header': 'Greeting' }, padded: { type: 'string', 'x-mcp-header': 'Padded' },
        lines: { type: 'string', 'x-mcp-header': 'Lines' }, sentinel: { type: 'string', 'x-mcp-header': 'Sentinel' },
        absent: { type: 'string', 'x-mcp-header': 'Absent' },
      } },
    },
  } };
  const { client, seen } = await fixture(t, { modern: true, tools: [annotated] });
  await client.connect(signal());
  const details = { count: -7, enabled: false, greeting: 'Hello, 世界', padded: ' padded ', lines: 'line1\nline2', sentinel: '=?base64?literal?=' };
  await client.callTool('headers', { region: 'us-west1', details }, signal());
  const headers = seen.at(-1)!.headers;
  assert.equal(headers['mcp-param-region'], 'us-west1');
  assert.equal(headers['mcp-param-count'], '-7');
  assert.equal(headers['mcp-param-enabled'], 'false');
  for (const key of ['greeting', 'padded', 'lines', 'sentinel'] as const) assert.equal(headers[`mcp-param-${key}`], `=?base64?${Buffer.from(details[key], 'utf8').toString('base64')}?=`);
  assert.equal(headers['mcp-param-absent'], undefined);
  assert.equal(headers.authorization, undefined);
  await assert.rejects(client.callTool('headers', { details: { count: Number.MAX_SAFE_INTEGER + 1 } }, signal()), isMcp('MCP_INPUT_INVALID'));
  assert.equal(seen.filter(entry => entry.message.method === 'tools/call').length, 1);
});

test('invalid parameter header annotations exclude only those tools and still count towards discovery limits', async t => {
  const invalidSchemas = [
    { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': '' } } },
    { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'A\nInjected' } } },
    { type: 'object', properties: { amount: { type: 'number', 'x-mcp-header': 'Amount' } } },
    { type: 'object', properties: { value: { type: 'string', 'x-mcp-header': 'Region' }, nested: { type: 'object', properties: { other: { type: 'string', 'x-mcp-header': 'region' } } } } },
    { type: 'object', properties: { items: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } },
    { type: 'object', 'x-mcp-header': 'Root' },
  ];
  const tools = [tool, ...invalidSchemas.map((inputSchema, index) => ({ ...tool, name: `invalid_${index}`, inputSchema }))];
  const { client, seen } = await fixture(t, { modern: true, tools });
  assert.deepEqual(await client.connect(signal()), [tool]);
  await assert.rejects(client.callTool('invalid_0', {}, signal()), isMcp('MCP_INPUT_INVALID'));
  assert.equal(seen.filter(entry => entry.message.method === 'tools/call').length, 0);
  const limited = await fixture(t, { modern: true, override(message, response) {
    if (message.method !== 'tools/list') return false;
    json(response, message.id, message.params?.cursor ? { tools: [tool] } : {
      tools: Array.from({ length: 50 }, (_, index) => ({ ...tool, name: `invalid_${index}`, inputSchema: invalidSchemas[0] })), nextCursor: 'next',
    });
    return true;
  } });
  await assert.rejects(limited.client.connect(signal()), isMcp('MCP_PROTOCOL_ERROR'));
});

test('current SSE accepts correlated progress and log notifications while rejecting server requests and unrelated progress', async t => {
  for (const kind of ['valid', 'wrong-token', 'bad-total', 'server-request', 'unknown-notification', 'after-response'] as const) {
    const { client } = await fixture(t, { modern: true, override(message, response) {
      if (message.method !== 'tools/call') return false;
      const frames = [
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: kind === 'wrong-token' ? 999 : message.id, progress: 1, total: kind === 'bad-total' ? 0 : 2 } },
        { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: { operation: 'Completed local lookup.' } } },
        ...(kind === 'server-request' ? [{ jsonrpc: '2.0', id: 909, method: 'sampling/createMessage', params: {} }] : []),
        ...(kind === 'unknown-notification' ? [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} }] : []),
        { jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'Ready.' }] } },
        ...(kind === 'after-response' ? [{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.id, progress: 2, total: 2 } }] : []),
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
      return true;
    } });
    await client.connect(signal());
    const pending = client.callTool('echo', { message: 'hello' }, signal());
    if (kind === 'valid') assert.deepEqual(await pending, { content: [{ type: 'text', text: 'Ready.' }] });
    else await assert.rejects(pending, isMcp('MCP_PROTOCOL_ERROR'));
  }
});

test('recognized modern HTTP errors never downgrade, while a legacy method error permits the initialize handshake', async t => {
  for (const code of [-32020, -32021, -32022, -32601]) {
    const { client, seen } = await fixture(t, { override(message, response) {
      response.writeHead(code === -32601 ? 404 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: 'Private server reason', data: { supported: ['2025-11-25'] } } }));
      return true;
    } });
    await assert.rejects(client.connect(signal()), error => isMcp('MCP_SERVER_ERROR')(error) && !String(error).includes('Private'));
    assert.deepEqual(seen.map(entry => entry.message.method), ['server/discover']);
  }
  const legacy = await fixture(t, { override(message, response) {
    if (message.method !== 'server/discover') return false;
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } }));
    return true;
  } });
  await legacy.client.connect(signal());
  assert.deepEqual(legacy.seen.map(entry => entry.message.method), ['server/discover', 'initialize', 'notifications/initialized', 'tools/list']);
});

test('current unsupported result flows and header errors do not replay tool execution or refresh schemas automatically', async t => {
  for (const kind of ['input-required', 'header-error', 'unknown-result'] as const) {
    const { client, seen } = await fixture(t, { modern: true, override(message, response) {
      if (message.method !== 'tools/call') return false;
      if (kind === 'header-error') response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'Private mismatch' } }));
      else json(response, message.id, { resultType: kind === 'input-required' ? 'input_required' : 'future', inputRequests: [], content: [] });
      return true;
    } });
    await client.connect(signal());
    await assert.rejects(client.callTool('echo', { message: 'hello' }, signal()), isMcp(kind === 'header-error' ? 'MCP_SERVER_ERROR' : 'MCP_PROTOCOL_ERROR'));
    assert.equal(seen.filter(entry => entry.message.method === 'tools/call').length, 1);
    assert.equal(seen.filter(entry => entry.message.method === 'tools/list').length, 1);
    assert.equal(seen.filter(entry => entry.message.method === 'initialize').length, 0);
  }
});

test('current cancellation closes the request stream without sending legacy notifications or retrying', async t => {
  let closed = false;
  const { client, seen } = await fixture(t, { modern: true, override(message, response) {
    if (message.method !== 'tools/call') return false;
    response.on('close', () => { closed = true; });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': request is running\n\n');
    return true;
  } });
  await client.connect(signal());
  const controller = new AbortController();
  const rejected = assert.rejects(client.callTool('echo', { message: 'hello' }, controller.signal), isMcp('MCP_CANCELLED'));
  await until(() => seen.some(entry => entry.message.method === 'tools/call'));
  controller.abort();
  await rejected;
  await until(() => closed);
  assert.equal(seen.filter(entry => entry.message.method === 'tools/call').length, 1);
  assert.equal(seen.filter(entry => entry.message.method.startsWith('notifications/')).length, 0);
});
