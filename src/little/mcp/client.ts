import { assertSafeJson, McpError, object, validateMcpInput, validateMcpSchema, type JsonObject } from './validation';
import { redactSecrets } from '../context/redact-secrets';
export { McpError, validateMcpInput } from './validation';

export interface McpServerConfig { id: string; name: string; url: string }
export interface McpTool { name: string; description: string; inputSchema: JsonObject }
type Fetch = typeof globalThis.fetch;
export const MCP_LIMITS = Object.freeze({ responseBytes: 512 * 1024, requestBytes: 64 * 1024, tools: 50, pages: 10, sseEvents: 128, requestTimeoutMs: 10000 });
const SUPPORTED_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const PREFERRED_VERSION = '2025-11-25';
const MODERN_VERSION = '2026-07-28';
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
function protocol(): McpError { return new McpError('MCP_PROTOCOL_ERROR', 'The MCP server returned an invalid or unsupported protocol response.'); }
class LegacyProbeFallback extends Error {}
function encodeHeader(value: string | number | boolean): string {
  const text = String(value);
  return /^[\x20-\x7e\t]*$/.test(text) && text.trim() === text && !(text.startsWith('=?base64?') && text.endsWith('?=')) ? text : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}
function parameterHeaders(schema: JsonObject, args: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  const visit = (node: JsonObject, value: unknown): void => {
    const name = node['x-mcp-header'];
    if (typeof name === 'string' && value !== undefined && value !== null) headers[`Mcp-Param-${name}`] = encodeHeader(value as string | number | boolean);
    const properties = object(node.properties);
    const values = object(value);
    if (properties && values) for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(values, key)) visit(child as JsonObject, values[key]);
  };
  visit(schema, args);
  return headers;
}

/** Literal loopback destinations only; localhost is rewritten instead of resolved through DNS. */
export function validateMcpEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value) || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^?#]*)?$/i.test(value)) throw new McpError('MCP_CONFIG_INVALID', 'Use a loopback HTTP MCP endpoint without credentials, query parameters, or a fragment.');
  let url: URL;
  try { url = new URL(value); } catch { throw new McpError('MCP_CONFIG_INVALID', 'The MCP endpoint URL is invalid.'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'http:' || url.port === '0') throw new McpError('MCP_CONFIG_INVALID', 'The MCP endpoint URL is invalid.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

function parseJson(text: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw protocol(); }
  // JSON.parse silently overwrites duplicate keys; reject ambiguous server messages instead.
  const stack: { object: boolean; keys: Set<string>; expectsKey: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '{' || char === '[') stack.push({ object: char === '{', keys: new Set(), expectsKey: char === '{' });
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',') { const top = stack.at(-1); if (top?.object) top.expectsKey = true; }
    else if (char === '"') {
      const start = index++;
      for (; index < text.length; index++) { if (text[index] === '\\') index++; else if (text[index] === '"') break; }
      const top = stack.at(-1);
      if (top?.object && top.expectsKey) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (top.keys.has(key)) throw protocol();
        top.keys.add(key); top.expectsKey = false;
      }
    }
  }
  assertSafeJson(value);
  return value;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw new DOMException('Aborted', 'AbortError'); }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

async function* bodyChunks(response: Response, signal: AbortSignal): AsyncIterable<Uint8Array> {
  if (!response.body) throw protocol();
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = await abortable(reader.read(), signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (chunk.done) return;
      bytes += chunk.value.byteLength;
      if (bytes > MCP_LIMITS.responseBytes) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP response exceeded the supported size limit.');
      yield chunk.value;
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function responseMessages(response: Response, signal: AbortSignal): Promise<unknown[]> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/event-stream') throw protocol();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  if (type === 'application/json') {
    let text = '';
    for await (const bytes of bodyChunks(response, signal)) text += decoder.decode(bytes, { stream: true });
    text += decoder.decode();
    return [parseJson(text)];
  }
  let buffer = '';
  let data: string[] = [];
  let dataLength = 0;
  let events = 0;
  const messages: unknown[] = [];
  const line = (text: string): void => {
    if (text === '') {
      if (++events > MCP_LIMITS.sseEvents) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP stream exceeded the supported event limit.');
      const payload = data.join('\n');
      if (payload.trim()) messages.push(parseJson(payload));
      data = []; dataLength = 0;
    } else if (text.startsWith('data:')) {
      const entry = text.slice(5).replace(/^ /, '');
      dataLength += entry.length + 1;
      if (dataLength > 128 * 1024) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP stream event exceeded the supported size limit.');
      data.push(entry);
    } else if (text.startsWith(':') || /^(?:id|event|retry):/.test(text)) { /* Transport fields never initiate reconnection or execution. */ }
    else throw protocol();
  };
  for await (const bytes of bodyChunks(response, signal)) {
    buffer += decoder.decode(bytes, { stream: true });
    let position = 0;
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index];
      if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && index === buffer.length - 1) break;
      line(buffer.slice(position, index));
      if (char === '\r' && buffer[index + 1] === '\n') index++;
      position = index + 1;
    }
    buffer = buffer.slice(position);
    if (buffer.length > 128 * 1024) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP stream line exceeded the supported size limit.');
  }
  buffer += decoder.decode();
  // An unterminated SSE frame is incomplete, rather than implicitly accepted at EOF.
  if (buffer.trim() || data.length) throw protocol();
  return messages;
}

/** Tools-only 2026 stateless and 2025 session-based HTTP client; no server-initiated execution. */
export class McpClient {
  readonly config: Readonly<McpServerConfig>;
  private sequence = 0;
  private session?: string;
  private version?: string;
  private era?: 'modern' | 'legacy';
  private connected = false;
  private connecting = false;
  private generation = 0;
  private readonly active = new Set<AbortController>();
  private tools = new Map<string, McpTool>();
  constructor(config: McpServerConfig, private readonly fetcher: Fetch = globalThis.fetch) {
    if (!config || Object.keys(config).some(key => !['id', 'name', 'url'].includes(key)) || typeof config.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.id) || /[\r\n]/.test(config.id) || typeof config.name !== 'string' || !config.name.trim() || config.name.length > 60 || /[\u0000-\u001f\u007f]/u.test(config.name)) throw new McpError('MCP_CONFIG_INVALID', 'The MCP server identity is invalid.');
    assertSafeJson(config.name, 60);
    this.config = Object.freeze({ id: config.id, name: config.name.trim(), url: validateMcpEndpoint(config.url) });
  }

  async connect(signal: AbortSignal): Promise<McpTool[]> {
    if (this.connecting) throw new McpError('MCP_NOT_CONNECTED', 'MCP connection setup is already in progress.');
    this.disconnect();
    const generation = this.generation;
    this.connecting = true;
    try {
      this.era = 'modern'; this.version = MODERN_VERSION;
      try {
        const discovery = object(await this.request('server/discover', {}, signal, false, true));
        if (!discovery || !Array.isArray(discovery.supportedVersions) || !discovery.supportedVersions.length || discovery.supportedVersions.length > 16 || discovery.supportedVersions.some(version => typeof version !== 'string' || version.length > 32) || !discovery.supportedVersions.includes(MODERN_VERSION) || !object(object(discovery.capabilities)?.tools)) throw protocol();
      } catch (error) {
        if (!(error instanceof LegacyProbeFallback)) throw error;
        this.era = 'legacy'; this.version = undefined;
        const initialized = object(await this.request('initialize', { protocolVersion: PREFERRED_VERSION, capabilities: {}, clientInfo: { name: 'little-code', version: '0.2.0' } }, signal, true));
        if (!initialized || typeof initialized.protocolVersion !== 'string' || !SUPPORTED_VERSIONS.has(initialized.protocolVersion)) throw new McpError('MCP_PROTOCOL_ERROR', 'This MCP server does not support a compatible Streamable HTTP protocol version.');
        const capabilities = object(initialized.capabilities);
        const info = object(initialized.serverInfo);
        if (!capabilities || !object(capabilities.tools) || !info || typeof info.name !== 'string' || !info.name || info.name.length > 100 || typeof info.version !== 'string' || !info.version || info.version.length > 100) throw protocol();
        this.version = initialized.protocolVersion;
        await this.notification('notifications/initialized', undefined, signal);
      }
      const tools: McpTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let finished = false;
      let listedCount = 0;
      for (let page = 0; page < MCP_LIMITS.pages; page++) {
        const result = object(await this.request('tools/list', cursor ? { cursor } : {}, signal));
        if (!result || !Array.isArray(result.tools) || (listedCount += result.tools.length) > MCP_LIMITS.tools) throw protocol();
        for (const item of result.tools) {
          const tool = object(item);
          if (!tool || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || /[\r\n]/.test(tool.name) || names.has(tool.name) || tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 1000)) throw protocol();
          names.add(tool.name);
          let inputSchema: JsonObject;
          try { inputSchema = validateMcpSchema(tool.inputSchema); } catch (error) { if (error instanceof McpError && error.mcpCode === 'MCP_HEADER_INVALID') continue; throw error; }
          const definition: McpTool = { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema };
          tools.push(definition);
        }
        if (result.nextCursor === undefined) { finished = true; break; }
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 512 || cursors.has(result.nextCursor)) throw protocol();
        cursor = result.nextCursor; cursors.add(cursor);
      }
      if (!finished || signal.aborted || generation !== this.generation) throw protocol();
      this.tools = new Map(tools.map(tool => [tool.name, tool]));
      this.connected = true;
      return structuredClone(tools);
    } catch (error) { this.disconnect(); throw error; }
    finally { this.connecting = false; }
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.connected) throw new McpError('MCP_NOT_CONNECTED', 'Connect this MCP server before calling its tools.');
    const tool = this.tools.get(name);
    if (!tool) throw new McpError('MCP_INPUT_INVALID', 'The requested MCP tool was not discovered on this server.');
    const validated = validateMcpInput(tool.inputSchema, args);
    const result = object(await this.request('tools/call', { name, arguments: validated }, signal));
    if (!result || !Array.isArray(result.content) || result.content.length > 50 || result.isError !== undefined && typeof result.isError !== 'boolean') throw protocol();
    let characters = 0;
    const content = result.content.map(item => {
      const entry = object(item);
      if (!entry || entry.type !== 'text' || typeof entry.text !== 'string') throw new McpError('MCP_PROTOCOL_ERROR', 'This MCP client supports text tool results only. Embedded resources and media are not accepted.');
      characters += entry.text.length;
      if (characters > 65536) throw new McpError('MCP_RESPONSE_LIMIT', 'MCP tool text exceeded the supported size limit.');
      return { type: 'text' as const, text: entry.text };
    });
    if (result.structuredContent !== undefined && !object(result.structuredContent)) throw protocol();
    if (result.isError === true) throw new McpError('MCP_TOOL_FAILED', 'The MCP server reported that this tool failed.');
    return { content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
  }

  disconnect(): void {
    this.generation++;
    for (const controller of this.active) controller.abort('disconnect');
    const session = this.session;
    const version = this.version;
    this.session = undefined; this.version = undefined; this.era = undefined; this.connected = false; this.tools.clear();
    if (session) void this.fetcher(this.config.url, { method: 'DELETE', headers: { 'MCP-Session-Id': session, ...(version ? { 'MCP-Protocol-Version': version } : {}) }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(1000) }).then(response => response.body?.cancel()).catch(() => undefined);
  }

  private headers(message?: JsonObject): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(this.version ? { 'MCP-Protocol-Version': this.version } : {}), ...(this.session ? { 'MCP-Session-Id': this.session } : {}) };
    if (this.era === 'modern' && message) {
      headers['Mcp-Method'] = String(message.method);
      const params = object(message.params);
      if (message.method === 'tools/call' && params && typeof params.name === 'string') {
        headers['Mcp-Name'] = encodeHeader(params.name);
        const tool = this.tools.get(params.name);
        if (tool) Object.assign(headers, parameterHeaders(tool.inputSchema, params.arguments as JsonObject));
      }
    }
    return headers;
  }

  private async notification(method: string, params: JsonObject | undefined, signal: AbortSignal): Promise<void> {
    await this.exchange({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, signal);
  }

  private async request(method: string, params: JsonObject, signal: AbortSignal, initializing = false, probing = false): Promise<unknown> {
    const id = ++this.sequence;
    const metadata = this.era === 'modern' ? { _meta: { 'io.modelcontextprotocol/protocolVersion': this.version, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'little-code', version: '0.2.0' }, progressToken: id } } : {};
    const messages = await this.exchange({ jsonrpc: '2.0', id, method, params: { ...params, ...metadata } }, signal, initializing, probing);
    const responses: unknown[] = [];
    for (const value of messages) {
      const message = object(value);
      if (message?.jsonrpc !== '2.0') throw protocol();
      if (message.method !== undefined) {
        if (responses.length) throw protocol();
        const notification = object(message.params);
        if (message.id !== undefined || !notification || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw protocol();
        if (message.method === 'notifications/progress') {
          if (notification.progressToken !== id || typeof notification.progress !== 'number' || !Number.isFinite(notification.progress) || notification.progress < 0) throw protocol();
          if (notification.total !== undefined && (typeof notification.total !== 'number' || !Number.isFinite(notification.total) || notification.total < notification.progress)) throw protocol();
          if (notification.message !== undefined && (typeof notification.message !== 'string' || notification.message.length > 1000)) throw protocol();
        } else if (message.method === 'notifications/message') {
          if (!['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(String(notification.level))) throw protocol();
        } else throw protocol();
      } else responses.push(value);
    }
    if (responses.length !== 1) throw protocol();
    const response = object(responses[0]);
    if (!response || response.jsonrpc !== '2.0' || response.id !== id || response.method !== undefined || Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) throw protocol();
    if (response.error !== undefined) {
      const error = object(response.error);
      if (!error || typeof error.code !== 'number' || !Number.isSafeInteger(error.code) || typeof error.message !== 'string' || error.message.length > 2000) throw protocol();
      throw new McpError('MCP_SERVER_ERROR', `The MCP server rejected this request (JSON-RPC ${error.code}).`);
    }
    const result = object(response.result);
    if (!result || result.resultType !== undefined && result.resultType !== 'complete') throw new McpError('MCP_PROTOCOL_ERROR', 'The MCP server requested an unsupported result flow. Additional client input and request replay are disabled.');
    return result;
  }

  private async exchange(message: JsonObject, signal: AbortSignal, initializing = false, probing = false): Promise<unknown[]> {
    if (signal.aborted) throw new McpError('MCP_CANCELLED', 'MCP request stopped.');
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, 'utf8') > MCP_LIMITS.requestBytes) throw new McpError('MCP_INPUT_INVALID', 'MCP request exceeded the supported size limit.');
    const controller = new AbortController();
    this.active.add(controller);
    const notifyCancellation = (): void => {
      if (!initializing && Object.hasOwn(message, 'id') && this.version && this.era === 'legacy') this.cancelNotification(message.id as number);
    };
    controller.signal.addEventListener('abort', notifyCancellation, { once: true });
    const onAbort = (): void => controller.abort('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), MCP_LIMITS.requestTimeoutMs);
    try {
      if (signal.aborted) onAbort();
      const response = await abortable(this.fetcher(this.config.url, { method: 'POST', headers: this.headers(message), body: serialized, redirect: 'error', credentials: 'omit', signal: controller.signal }), controller.signal);
      if (response.redirected || response.url && response.url !== this.config.url) throw protocol();
      if (!response.ok) {
        if (probing && response.status === 400) {
          let text = '';
          const decoder = new TextDecoder('utf-8', { fatal: true });
          if (response.body) { for await (const bytes of bodyChunks(response, controller.signal)) text += decoder.decode(bytes, { stream: true }); text += decoder.decode(); }
          if (redactSecrets(text) !== text) throw protocol();
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw new LegacyProbeFallback(); }
          parsed = parseJson(text);
          const error = object(object(parsed)?.error);
          if (error && typeof error.code === 'number' && MODERN_ERRORS.has(error.code)) return [parsed];
          throw new LegacyProbeFallback();
        }
        if (this.era === 'modern' && response.headers.get('content-type')?.startsWith('application/json')) return await responseMessages(response, controller.signal);
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404 && this.session) this.disconnect();
        throw new McpError('MCP_UNAVAILABLE', `The MCP endpoint rejected this request (HTTP ${response.status}). Reconnect or inspect the server.`);
      }
      if (initializing) {
        const session = response.headers.get('mcp-session-id');
        if (session !== null) { if (!/^[\x21-\x7e]{1,256}$/.test(session)) throw protocol(); this.session = session; }
      } else if (response.headers.has('mcp-session-id') && response.headers.get('mcp-session-id') !== this.session) throw protocol();
      if (!Object.hasOwn(message, 'id')) {
        if (response.status !== 202) throw protocol();
        if (response.body) for await (const bytes of bodyChunks(response, controller.signal)) if (bytes.length) throw protocol();
        return [];
      }
      return await responseMessages(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new McpError(controller.signal.reason === 'timeout' ? 'MCP_TIMEOUT' : 'MCP_CANCELLED', controller.signal.reason === 'timeout' ? 'MCP request timed out. The server may still be working.' : 'MCP request stopped. The server may still be working.');
      }
      if (error instanceof McpError || error instanceof LegacyProbeFallback) throw error;
      throw new McpError('MCP_UNAVAILABLE', 'The MCP server could not be reached or returned an unreadable response.');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.signal.removeEventListener('abort', notifyCancellation); this.active.delete(controller); }
  }

  private cancelNotification(requestId: number): void {
    void this.fetcher(this.config.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'Client stopped waiting.' } }), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(1000) }).then(response => response.body?.cancel()).catch(() => undefined);
  }
}
