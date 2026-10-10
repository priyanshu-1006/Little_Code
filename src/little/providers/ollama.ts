import type { LLMEvent, LLMMessage, LLMProvider, LLMRequest, ModelInfo, ToolCall } from '../shared/contracts';
import { LittleError } from '../shared/errors';

export const OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
export const OLLAMA_LIMITS = Object.freeze({ discoveryBytes: 1024 * 1024, discoveryTimeoutMs: 15_000, models: 512, streamBytes: 16 * 1024 * 1024,
  lineChars: 256 * 1024, textChars: 2 * 1024 * 1024, toolCalls: 64, argumentChars: 64 * 1024, requestChars: 4 * 1024 * 1024 });
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$(?![\s\S])/;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$(?![\s\S])/;
function cloudName(name: string): boolean { return /(?:-cloud(?::[^/]*)?|:cloud|:[^/]*-cloud)$/i.test(name); }

/** Restrict provider traffic to explicit loopback origins; localhost never depends on DNS. */
export function validateOllamaEndpoint(value: string): string {
  const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?\/?$/i.exec(value);
  if (!match || match[0] !== value || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) {
    throw new LittleError('TOOL_VALIDATION_FAILED', 'Ollama must use an HTTP or HTTPS loopback origin without credentials, a path, or a query.');
  }
  const host = match[2]!.toLowerCase() === 'localhost' ? '127.0.0.1' : match[2]!.toLowerCase();
  return new URL(`${match[1]!.toLowerCase()}://${host}${match[3] ? ':' + match[3] : ''}`).origin;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new LittleError('AGENT_CANCELLED', 'Ollama request stopped.'); }
function protocol(): LittleError { return new LittleError('PROVIDER_PROTOCOL_ERROR', 'Ollama returned an invalid or incomplete response.'); }
function normalized(error: unknown, signal?: AbortSignal): LittleError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return new LittleError('AGENT_CANCELLED', 'Ollama request stopped.');
  return error instanceof LittleError ? error : new LittleError('PROVIDER_UNAVAILABLE', 'Ollama is unavailable. Start the local server and try again.');
}
function stopBody(body: ReadableStream<Uint8Array> | null): void { if (body) void body.cancel().catch(() => {}); }
async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  cancelled(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new LittleError('AGENT_CANCELLED', 'Ollama request stopped.')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 24 * 60 * 60 * 1000)) : undefined;
}
function checkResponse(response: Response, modelRequest: boolean): void {
  if (response.redirected || (response.status >= 300 && response.status < 400)) throw new LittleError('PROVIDER_UNAVAILABLE', 'Ollama redirects are not permitted.');
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) throw new LittleError('PROVIDER_AUTH_FAILED', 'The local Ollama server denied access.');
  if (response.status === 429) throw new LittleError('PROVIDER_RATE_LIMITED', 'The local Ollama server is busy. Try again later.', retryAfter(response.headers.get('retry-after')));
  if (response.status === 404 && modelRequest) throw new LittleError('MODEL_UNAVAILABLE', 'The selected Ollama model is unavailable. Choose an installed model.');
  if (response.status === 400 || response.status === 422) throw protocol();
  throw new LittleError('PROVIDER_UNAVAILABLE', 'Ollama is unavailable. Start the local server and try again.');
}
function json(value: string): unknown { try { return JSON.parse(value); } catch { throw protocol(); } }
function argumentsObject(value: unknown): Record<string, unknown> {
  if (!record(value)) throw protocol();
  return value;
}
function serializedArguments(value: unknown): string {
  const object = argumentsObject(value);
  let serialized: string;
  try { serialized = JSON.stringify(object); } catch { throw protocol(); }
  if (serialized.length > OLLAMA_LIMITS.argumentChars) throw protocol();
  return serialized;
}
function nativeMessages(messages: LLMMessage[]): Record<string, unknown>[] {
  const calls = new Map<string, string>();
  return messages.map(message => {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') throw new LittleError('TOOL_VALIDATION_FAILED', 'The Ollama conversation is invalid.');
    const native: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.toolCalls?.length) {
      if (message.role !== 'assistant' || message.toolCalls.length > OLLAMA_LIMITS.toolCalls) throw new LittleError('TOOL_VALIDATION_FAILED', 'The Ollama conversation contains invalid tool calls.');
      native.tool_calls = message.toolCalls.map((call, index) => {
        if (!call.id || calls.has(call.id) || !TOOL_NAME.test(call.name) || typeof call.arguments !== 'string' || call.arguments.length > OLLAMA_LIMITS.argumentChars) throw new LittleError('TOOL_VALIDATION_FAILED', 'The Ollama conversation contains invalid tool calls.');
        calls.set(call.id, call.name);
        return { type: 'function', function: { index, name: call.name, arguments: argumentsObject(json(call.arguments)) } };
      });
    }
    if (message.role === 'tool') {
      const name = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      if (!name) throw new LittleError('TOOL_VALIDATION_FAILED', 'The Ollama tool result has no matching call.');
      native.tool_name = name;
    }
    return native;
  });
}

async function readText(body: ReadableStream<Uint8Array>, limit: number, signal?: AbortSignal): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      cancelled(signal);
      const chunk = await abortable(reader.read(), signal);
      cancelled(signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw protocol();
      try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw protocol(); }
    }
    try { return text + decoder.decode(); } catch { throw protocol(); }
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function* readLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let bytes = 0;
  let buffered = '';
  try {
    while (true) {
      cancelled(signal);
      const chunk = await abortable(reader.read(), signal);
      cancelled(signal);
      if (!chunk.done) { bytes += chunk.value.byteLength; if (bytes > OLLAMA_LIMITS.streamBytes) throw protocol(); }
      try { buffered += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }); } catch { throw protocol(); }
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        if (newline > OLLAMA_LIMITS.lineChars) throw protocol();
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        if (line.trim()) yield line;
        cancelled(signal);
        newline = buffered.indexOf('\n');
      }
      if (buffered.length > OLLAMA_LIMITS.lineChars) throw protocol();
      if (chunk.done) { if (buffered.trim()) yield buffered; break; }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Ollama's native local API; no API keys, thinking events, model pulls, or generation retries. */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly endpoint: string;
  private sequence = 0;
  constructor(baseUrl: string = OLLAMA_DEFAULT_ENDPOINT, private readonly fetcher: typeof fetch = fetch) { this.endpoint = validateOllamaEndpoint(baseUrl); }

  private async request(route: string, signal?: AbortSignal, body?: string): Promise<Response> {
    cancelled(signal);
    const url = this.endpoint + route;
    const operation = this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { Accept: body === undefined ? 'application/json' : 'application/x-ndjson, application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
    operation.then(response => { if (signal?.aborted) stopBody(response.body); }, () => {});
    const response = await abortable(operation, signal);
    try {
      if (response.url && response.url !== url) throw new LittleError('PROVIDER_UNAVAILABLE', 'Ollama redirects are not permitted.');
      checkResponse(response, body !== undefined);
      if (!response.body) throw protocol();
      return response;
    } catch (error) { stopBody(response.body); throw error; }
  }
  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, OLLAMA_LIMITS.discoveryTimeoutMs);
    try {
      const response = await this.request('/api/tags', controller.signal);
      const document = json(await readText(response.body!, OLLAMA_LIMITS.discoveryBytes, controller.signal));
      if (!record(document) || !Array.isArray(document.models) || document.models.length > OLLAMA_LIMITS.models) throw protocol();
      const models: ModelInfo[] = [];
      const seen = new Set<string>();
      for (const value of document.models) {
        cancelled(controller.signal);
        if (!record(value) || typeof value.name !== 'string' || !MODEL_NAME.test(value.name)) throw protocol();
        if ('remote_model' in value || 'remote_host' in value || cloudName(value.name)) continue;
        if (seen.has(value.name)) continue;
        seen.add(value.name);
        models.push({ id: value.name, name: value.name, capabilities: { streaming: true, tools: 'unknown' } });
      }
      return models;
    } catch (error) {
      if (timedOut && !signal?.aborted) throw new LittleError('PROVIDER_UNAVAILABLE', 'Ollama model discovery timed out. Check the local server and try again.');
      throw normalized(error, signal);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
  }
  async *stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMEvent> {
    try {
      cancelled(signal);
      if (!MODEL_NAME.test(request.model) || cloudName(request.model) || !Array.isArray(request.messages) || request.messages.length === 0 ||
          (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 131072))) {
        throw new LittleError('TOOL_VALIDATION_FAILED', 'The Ollama model or request limits are invalid.');
      }
      if (request.tools && (request.tools.length > OLLAMA_LIMITS.toolCalls || request.tools.some(tool => !TOOL_NAME.test(tool.name) || typeof tool.description !== 'string' || !record(tool.parameters)))) throw new LittleError('TOOL_VALIDATION_FAILED', 'The Ollama tool definitions are invalid.');
      const payload = JSON.stringify({ model: request.model, messages: nativeMessages(request.messages), stream: true, think: false,
        ...(request.maxOutputTokens === undefined ? {} : { options: { num_predict: request.maxOutputTokens } }),
        ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', function: tool })) } : {}) });
      if (payload.length > OLLAMA_LIMITS.requestChars) throw new LittleError('CONTEXT_LIMIT', 'The Ollama request exceeds the context limit.');
      const response = await this.request('/api/chat', signal, payload);
      const sequence = ++this.sequence;
      const pending = new Map<number, { name: string; arguments: string }>();
      const existingIds = new Set(request.messages.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
      let nextIndex = 0;
      let textChars = 0;
      let completed = false;
      let reason = 'stop';
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      for await (const line of readLines(response.body!, signal)) {
        const frame = json(line);
        if (!record(frame) || completed || 'error' in frame || 'remote_model' in frame || 'remote_host' in frame || (typeof frame.model === 'string' && cloudName(frame.model)) || typeof frame.done !== 'boolean') throw protocol();
        if (frame.message !== undefined) {
          if (!record(frame.message) || (frame.message.role !== undefined && frame.message.role !== 'assistant')) throw protocol();
          const content = frame.message.content;
          if (content !== undefined && typeof content !== 'string') throw protocol();
          if (typeof content === 'string' && content) {
            textChars += content.length;
            if (textChars > OLLAMA_LIMITS.textChars) throw protocol();
            yield { type: 'text', text: content };
            cancelled(signal);
          }
          if (frame.message.tool_calls !== undefined) {
            if (!Array.isArray(frame.message.tool_calls)) throw protocol();
            for (const call of frame.message.tool_calls) {
              if (!record(call) || (call.type !== undefined && call.type !== 'function') || !record(call.function) || typeof call.function.name !== 'string' || !TOOL_NAME.test(call.function.name)) throw protocol();
              const providedIndex = call.function.index ?? call.index;
              const index = providedIndex === undefined ? nextIndex++ : providedIndex;
              if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= OLLAMA_LIMITS.toolCalls) throw protocol();
              nextIndex = Math.max(nextIndex, index + 1);
              const value = { name: call.function.name, arguments: serializedArguments(call.function.arguments) };
              const prior = pending.get(index);
              if (prior && (prior.name !== value.name || prior.arguments !== value.arguments)) throw protocol();
              pending.set(index, value);
              if (pending.size > OLLAMA_LIMITS.toolCalls) throw protocol();
            }
          }
        }
        if (frame.done) {
          completed = true;
          if (frame.done_reason !== undefined && (typeof frame.done_reason !== 'string' || !/^[A-Za-z_]{1,64}$(?![\s\S])/.test(frame.done_reason))) throw protocol();
          reason = typeof frame.done_reason === 'string' ? frame.done_reason : pending.size ? 'tool_calls' : 'stop';
          if (frame.prompt_eval_count !== undefined || frame.eval_count !== undefined) {
            if (!Number.isSafeInteger(frame.prompt_eval_count) || (frame.prompt_eval_count as number) < 0 || !Number.isSafeInteger(frame.eval_count) || (frame.eval_count as number) < 0) throw protocol();
            usage = { inputTokens: frame.prompt_eval_count as number, outputTokens: frame.eval_count as number };
          }
        }
      }
      cancelled(signal);
      if (!completed) throw protocol();
      if (reason !== 'length' && reason !== 'content_filter') {
        for (const [index, value] of [...pending.entries()].sort(([left], [right]) => left - right)) {
          const base = `ollama_${sequence}_${index}`;
          let id = base;
          let suffix = 0;
          while (existingIds.has(id)) { suffix++; id = base + (suffix === 1 ? '_next' : `_next_${suffix}`); }
          existingIds.add(id);
          const call: ToolCall = { id, ...value };
          yield { type: 'tool_call', call };
          cancelled(signal);
        }
      }
      if (usage) { yield { type: 'usage', ...usage }; cancelled(signal); }
      yield { type: 'done', reason };
    } catch (error) { throw normalized(error, signal); }
  }
}
