import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { BrowserClient, BROWSER_LIMITS, validateBrowserEndpoint, validateBrowserPage } from '../src/little/browser/browser-client';
import { LittleError } from '../src/little/shared/errors';

interface FixtureSocket { send(data: string): void; close(): void; terminate(): void; on(event: 'message', listener: (data: Buffer) => void): void }
interface FixtureSocketServer { clients: Set<FixtureSocket>; on(event: 'connection', listener: (socket: FixtureSocket, request: IncomingMessage) => void): void; close(callback: (error?: Error) => void): void }
type SocketServerConstructor = new (options: { server: ReturnType<typeof createServer> }) => FixtureSocketServer;
let SocketServer: SocketServerConstructor | undefined;
try { SocketServer = (createRequire(import.meta.url)('../.upstream/codeoss/node_modules/ws') as { WebSocketServer: SocketServerConstructor }).WebSocketServer; }
catch { /* The upstream dependency is optional for a fresh extension-only checkout. */ }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=';
type Mode = 'normal' | 'redirect' | 'final-drift' | 'wrong-socket' | 'wrong-path' | 'http-redirect' | 'http-large' | 'message-large' | 'screenshot-large' | 'hang' | 'slow-create' | 'close-failure';
interface Options { mode?: Mode; redirectUrl?: string; text?: string; title?: string; onNavigate?: () => void }
function code(expected: LittleError['code']) { return (error: unknown) => error instanceof LittleError && error.code === expected; }

async function fixture(t: TestContext, options: Options = {}) {
  if (!SocketServer) { t.skip('Socket fixtures require the existing optional Code-OSS ws dependency.'); return; }
  const mode = options.mode ?? 'normal';
  const requests: { method: string; url: string }[] = [];
  const methods: { method: string; params: Record<string, unknown> }[] = [];
  const owned = new Set<string>();
  const closed: string[] = [];
  let counter = 0;
  let endpoint = '';
  let blocked = false;
  let continuedRemote = false;
  function json(response: ServerResponse, value: unknown) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
  const server = createServer((request, response) => {
    const route = request.url ?? '';
    requests.push({ method: request.method ?? '', url: route });
    if (route.startsWith('/json/new?')) {
      if (mode === 'http-redirect') { response.writeHead(302, { Location: 'https://example.invalid/debug' }); response.end(); return; }
      if (mode === 'http-large') { response.writeHead(200, { 'content-length': String(BROWSER_LIMITS.httpBytes + 1) }); response.end('x'.repeat(BROWSER_LIMITS.httpBytes + 1)); return; }
      const id = `owned_${++counter}`;
      owned.add(id);
      const target = { id, type: 'page', url: 'about:blank', webSocketDebuggerUrl: endpoint.replace('http:', 'ws:') + (mode === 'wrong-path' ? `/devtools/browser/${id}` : `/devtools/page/${id}`) };
      if (mode === 'wrong-socket') target.webSocketDebuggerUrl = target.webSocketDebuggerUrl.replace('127.0.0.1', 'localhost');
      if (mode === 'slow-create') setTimeout(() => json(response, target), 100);
      else json(response, target);
    } else if (route.startsWith('/json/close/')) {
      const id = route.slice('/json/close/'.length);
      closed.push(id);
      if (mode === 'close-failure') { response.writeHead(500); response.end('Target not closed'); return; }
      owned.delete(id);
      for (const socket of sockets.clients) socket.close();
      response.end('Target is closing');
    } else if (route === '/json' || route === '/json/list') json(response, [{ id: 'private_existing_target', url: 'https://private.example.invalid', title: 'Private user content' }]);
    else { response.writeHead(404); response.end(); }
  });
  const sockets = new SocketServer({ server });
  sockets.on('connection', (socket) => {
    let navigationId: number | undefined;
    let navigatedUrl = '';
    const reply = (id: number, result: unknown = {}) => socket.send(JSON.stringify({ id, result }));
    const event = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params }));
    const paused = (requestId: string, url: string) => event('Fetch.requestPaused', { resourceType: 'Document', requestId, request: { url } });
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { id: number; method: string; params: Record<string, unknown> };
      methods.push({ method: message.method, params: message.params });
      if (mode === 'hang' && message.method === 'Page.enable') return;
      if (message.method === 'Page.navigate') {
        navigationId = message.id;
        navigatedUrl = String(message.params.url);
        options.onNavigate?.();
        paused('initial', navigatedUrl);
      } else if (message.method === 'Fetch.continueRequest') {
        reply(message.id);
        if (message.params.requestId === 'redirect') { continuedRemote = true; return; }
        if (mode === 'redirect') { paused('redirect', options.redirectUrl ?? 'https://example.invalid/private'); return; }
        event('Page.frameNavigated', { frame: { id: 'owned_frame', url: navigatedUrl } });
        event('Page.loadEventFired', { timestamp: 1 });
        if (navigationId !== undefined) reply(navigationId, { frameId: 'owned_frame', loaderId: 'owned_loader' });
      } else if (message.method === 'Fetch.failRequest') {
        blocked = true;
        reply(message.id);
        if (navigationId !== undefined) reply(navigationId, { errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
      } else if (message.method === 'Runtime.evaluate') {
        const text = mode === 'message-large' ? 'x'.repeat(BROWSER_LIMITS.messageBytes + 1) : options.text ?? 'Visible local application content';
        reply(message.id, { result: { type: 'object', value: { url: mode === 'final-drift' ? 'https://example.invalid/private' : navigatedUrl, title: options.title ?? 'Local Application', text, truncated: false } } });
      } else if (message.method === 'Page.captureScreenshot') {
        const data = mode === 'screenshot-large' ? Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(BROWSER_LIMITS.screenshotBytes - 7)]).toString('base64') : PNG;
        reply(message.id, { data });
      } else reply(message.id);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { endpoint, requests, methods, owned, closed, blocked: () => blocked, continuedRemote: () => continuedRemote };
}

test('browser validators accept canonical loopback origins/pages and reject remote or credential URLs', () => {
  assert.equal(validateBrowserEndpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  assert.equal(validateBrowserEndpoint('http://localhost:9222'), 'http://127.0.0.1:9222');
  assert.equal(validateBrowserEndpoint('http://[::1]:9222'), 'http://[::1]:9222');
  assert.equal(validateBrowserPage('https://localhost:3000/app?tab=home'), 'https://127.0.0.1:3000/app?tab=home');
  for (const endpoint of ['https://localhost:9222', 'http://example.invalid', 'http://user:password@localhost:9222', 'http://localhost:9222/json', 'http://localhost:9222?query=1', 'http://localhost:9222?', 'http://localhost:9222/.', 'http://localhost:9222/#hash', 'http://localhost:0', 'http://127.1:9222', 'http://2130706433:9222', 'http://%6cocalhost:9222']) assert.throws(() => validateBrowserEndpoint(endpoint), code('PERMISSION_DENIED'));
  for (const url of ['https://example.invalid', 'file:///private', 'data:text/plain,private', 'javascript:alert(1)', 'http://user:password@localhost:3000', 'http://localhost.example.invalid', 'http://localhost:0/app', 'http://127.1/app', 'http://2130706433/app', 'http://%6cocalhost/app', 'http://localhost:3000/#fragment', `http://localhost:3000/?token=gsk_${'a'.repeat(40)}`]) assert.throws(() => validateBrowserPage(url), code('PERMISSION_DENIED'));
  assert.throws(() => validateBrowserPage('http://local\thost:3000'), code('TOOL_VALIDATION_FAILED'));
  assert.throws(() => validateBrowserPage(' http://localhost:3000'), code('TOOL_VALIDATION_FAILED'));
  assert.throws(() => validateBrowserEndpoint('http://localhost:9222\n'), code('TOOL_VALIDATION_FAILED'));
});

test('owned browser inspection uses fixed gated commands and never enumerates or reads user tabs', async (t) => {
  const host = await fixture(t);
  if (!host) return;
  const client = new BrowserClient(host.endpoint);
  t.after(() => client.dispose());
  const result = await client.snapshot(`${host.endpoint}/app?q=malicious-browser-script`, new AbortController().signal);
  assert.equal(result.title, 'Local Application');
  assert.equal(result.text, 'Visible local application content');
  assert.ok(result.screenshot?.startsWith('data:image/png;base64,'));
  assert.deepEqual(host.requests[0], { method: 'PUT', url: '/json/new?about:blank' });
  assert.ok(!host.requests.some(request => ['/json', '/json/list'].includes(request.url)));
  assert.deepEqual(host.closed, ['owned_1']);
  assert.equal(host.owned.size, 0);
  const order = host.methods.map(command => command.method);
  assert.ok(order.indexOf('Fetch.enable') < order.indexOf('Page.navigate'));
  const expression = host.methods.find(command => command.method === 'Runtime.evaluate')?.params.expression;
  assert.equal(typeof expression, 'string');
  assert.ok(String(expression).includes('input,textarea,select,form,[contenteditable]'));
  assert.ok(String(expression).includes('script,style,noscript,template,[hidden]'));
  assert.ok(!String(expression).includes('malicious-browser-script'));
});

test('DOM text and title are redacted and bounded; screenshots stay optional', async (t) => {
  const key = `gsk_${'a'.repeat(40)}`;
  const host = await fixture(t, { title: key, text: `Use shared auth. API_KEY="${key}"\n${'x'.repeat(9_000)}` });
  if (!host) return;
  const result = await new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, new AbortController().signal);
  assert.ok(!result.title.includes(key));
  assert.ok(!result.text.includes(key));
  assert.ok(result.text.length <= BROWSER_LIMITS.textChars);
  assert.equal(result.truncated, true);
});

test('debugger sockets must belong to the exact approved endpoint and owned page path', async (t) => {
  for (const mode of ['wrong-socket', 'wrong-path'] as const) {
    const host = await fixture(t, { mode });
    if (!host) return;
    await assert.rejects(new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, new AbortController().signal), code('PERMISSION_DENIED'));
    assert.deepEqual(host.closed, ['owned_1']);
    assert.equal(host.methods.length, 0);
  }
});

test('document redirects are blocked before continuation and final origin drift is rejected', async (t) => {
  for (const redirectUrl of ['https://example.invalid/private', 'file:///private', 'http://user:password@127.0.0.1:3000/private', 'http://127.0.0.1:1/other']) {
    const host = await fixture(t, { mode: 'redirect', redirectUrl });
    if (!host) return;
    await assert.rejects(new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, new AbortController().signal), code('PERMISSION_DENIED'));
    assert.equal(host.continuedRemote(), false);
    assert.ok(host.methods.some(method => method.method === 'Fetch.failRequest'));
    assert.ok(!host.methods.some(method => method.method === 'Runtime.evaluate'));
    assert.deepEqual(host.closed, ['owned_1']);
  }
  const drift = await fixture(t, { mode: 'final-drift' });
  if (!drift) return;
  await assert.rejects(new BrowserClient(drift.endpoint).snapshot(`${drift.endpoint}/app`, new AbortController().signal), code('PERMISSION_DENIED'));
  assert.deepEqual(drift.closed, ['owned_1']);
});

test('HTTP redirects and response/message limits reject unsafe protocol data', async (t) => {
  for (const [mode, expected] of [['http-redirect', 'TOOL_FAILED'], ['http-large', 'CONTEXT_LIMIT'], ['message-large', 'CONTEXT_LIMIT']] as const) {
    const host = await fixture(t, { mode });
    if (!host) return;
    await assert.rejects(new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, new AbortController().signal), code(expected));
    assert.ok(!host.requests.some(request => request.url.startsWith('https:')));
    if (mode === 'message-large') assert.deepEqual(host.closed, ['owned_1']);
  }
});

test('oversized screenshot payloads are omitted while bounded rendered text remains available', async (t) => {
  const host = await fixture(t, { mode: 'screenshot-large' });
  if (!host) return;
  const result = await new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, new AbortController().signal);
  assert.equal(result.screenshot, undefined);
  assert.equal(result.text, 'Visible local application content');
  assert.deepEqual(host.closed, ['owned_1']);
});

test('cancellation stops pending navigation and closes only the owned target', async (t) => {
  const controller = new AbortController();
  const host = await fixture(t, { onNavigate: () => controller.abort() });
  if (!host) return;
  await assert.rejects(new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, controller.signal), code('AGENT_CANCELLED'));
  assert.deepEqual(host.closed, ['owned_1']);
  assert.ok(!host.closed.includes('private_existing_target'));
  assert.equal(host.owned.size, 0);
});

test('cancellation and disposal during creation still learn the owned ID and clean it up', async (t) => {
  const host = await fixture(t, { mode: 'slow-create' });
  if (!host) return;
  const controller = new AbortController();
  const client = new BrowserClient(host.endpoint);
  const pending = client.snapshot(`${host.endpoint}/app`, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, code('AGENT_CANCELLED'));
  assert.deepEqual(host.closed, ['owned_1']);
  const disposed = new BrowserClient(host.endpoint);
  const next = disposed.snapshot(`${host.endpoint}/app`, new AbortController().signal);
  setTimeout(() => disposed.dispose(), 20);
  await assert.rejects(next, code('AGENT_CANCELLED'));
  assert.deepEqual(host.closed, ['owned_1', 'owned_2']);
  await assert.rejects(disposed.snapshot(`${host.endpoint}/app`, new AbortController().signal), code('AGENT_CANCELLED'));
});

test('pending fixed protocol requests time out and tear down the owned target within the total budget', async (t) => {
  const host = await fixture(t, { mode: 'hang' });
  if (!host) return;
  const started = performance.now();
  await assert.rejects(new BrowserClient(host.endpoint).snapshot(`${host.endpoint}/app`, new AbortController().signal), code('TOOL_FAILED'));
  assert.ok(performance.now() - started < BROWSER_LIMITS.totalMs);
  assert.deepEqual(host.closed, ['owned_1']);
});

test('an owned-tab close failure is reported even after successful inspection', async (t) => {
  const host = await fixture(t, { mode: 'close-failure' });
  if (!host) return;
  const client = new BrowserClient(host.endpoint);
  await assert.rejects(client.snapshot(`${host.endpoint}/app`, new AbortController().signal), (error: unknown) => code('TOOL_FAILED')(error) && String(error).includes('could not be confirmed closed'));
  assert.deepEqual(host.closed, ['owned_1']);
  assert.equal(host.owned.size, 1);
  client.dispose();
});
