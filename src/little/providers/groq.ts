import type { LLMEvent, LLMProvider, LLMRequest, ModelInfo, SecretStore, ToolCall } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { groqHttpError, groqStreamError, groqRequestId, groqLimits, type GroqRequestLimits } from './groq-errors';
import { discoveredGroqModel, sortGroqModels } from './groq-models';
import { groqNativeRequest } from './groq-request';

/** Only the extension host reads this key through VS Code SecretStorage. */
export const GROQ_SECRET_KEY = 'little.groq.apiKey';
const API_BASE = 'https://api.groq.com/openai/v1';
const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_MODEL_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 256 * 1024;
const MAX_ALL_TOOL_CHARS = 1024 * 1024;
const MAX_TOOL_CALLS = 128;
export const GROQ_DISCOVERY_TIMEOUT_MS = 12000;
type JsonObject = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function protocolError(): LittleError {
  return new LittleError('PROVIDER_PROTOCOL_ERROR', 'Groq returned an incomplete or unsupported response. Retry the request.');
}
function invalidToolResponse(requestId?: string): LittleError {
  return new LittleError('PROVIDER_PROTOCOL_ERROR', 'Groq returned an invalid or incomplete tool response. No tool from this response was executed. Prepare a retry.',
    undefined, { provider: 'groq', phase: 'stream', category: 'tool_call', ...(requestId ? { requestId } : {}) });
}
function cancelled(): LittleError { return new LittleError('AGENT_CANCELLED', 'Run stopped.'); }
function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }
async function withCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) { void operation.catch(() => undefined); throw cancelled(); }
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        if (value instanceof Response) void value.body?.cancel().catch(() => undefined);
        reject(cancelled());
      } else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function safeError(error: unknown, signal?: AbortSignal): LittleError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled();
  if (error instanceof LittleError) return error;
  return new LittleError('PROVIDER_UNAVAILABLE', 'Groq could not be reached. Check your connection and retry.');
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Cancels the pending read as well as the HTTP request when a run is stopped. */
async function* chunks(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  checkCancelled(signal);
  const reader = body.getReader();
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkCancelled(signal);
      const next = await reader.read();
      checkCancelled(signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** SSE is parsed by lines, preserving split CRLF pairs and multi-line data events. */
async function* eventData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let lines: string[] = [];
  let eventChars = 0;
  const line = (value: string): string | undefined => {
    if (value === '') {
      const data = lines.length ? lines.join('\n') : undefined;
      lines = [];
      eventChars = 0;
      return data;
    }
    if (value.startsWith('data:')) {
      let data = value.slice(5);
      if (data.startsWith(' ')) data = data.slice(1);
      eventChars += data.length + 1;
      if (eventChars > MAX_EVENT_CHARS) throw protocolError();
      lines.push(data);
    }
    return undefined;
  };
  try {
    for await (const bytes of chunks(body, signal)) {
      buffer += decoder.decode(bytes, { stream: true });
      // Limit a single network chunk as well as the line/event retained across chunks.
      if (buffer.length > MAX_EVENT_CHARS * 2) throw protocolError();
      let position = 0;
      for (let index = 0; index < buffer.length; index++) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === buffer.length - 1) break;
        const data = line(buffer.slice(position, index));
        if (character === '\r' && buffer[index + 1] === '\n') index++;
        position = index + 1;
        if (data !== undefined) yield data;
      }
      buffer = buffer.slice(position);
      if (buffer.length > MAX_EVENT_CHARS) throw protocolError();
    }
    buffer += decoder.decode();
    // Tolerate an explicit DONE marker at EOF without its final blank line.
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer !== '') line(buffer);
    const data = line('');
    if (data !== undefined) yield data;
  } catch (error) {
    if (error instanceof TypeError) throw protocolError();
    throw error;
  }
}

export class GroqProvider implements LLMProvider {
  readonly id = 'groq';
  private readonly observedLimits = new Map<string, { limits: GroqRequestLimits; at: number }>();
  constructor(private readonly secretStore: SecretStore, private readonly fetchImpl: Fetch = globalThis.fetch) {}

  /** The host calls this whenever Groq credentials change organization. */
  resetRequestLimits(): void { this.observedLimits.clear(); }

  requestLimits(model: string): GroqRequestLimits | undefined {
    const observed = this.observedLimits.get(model);
    if (!observed) return undefined;
    const elapsed = Math.max(0, Date.now() - observed.at);
    const result: GroqRequestLimits = { ...observed.limits };
    const decay = (reset: 'resetAfterMs' | 'requestsResetAfterMs' | 'retryAfterMs', counter?: 'remainingTokens' | 'requestsRemaining'): void => {
      const duration = result[reset];
      if (duration === undefined) {
        // A remaining counter without a reset header is useful only briefly.
        if (counter && elapsed >= 60_000) delete result[counter];
        return;
      }
      if (elapsed >= duration) { delete result[reset]; if (counter) delete result[counter]; }
      else result[reset] = duration - elapsed;
    };
    decay('resetAfterMs', 'remainingTokens');
    decay('requestsResetAfterMs', 'requestsRemaining');
    decay('retryAfterMs');
    return result;
  }

  private rememberLimits(model: string, limits: GroqRequestLimits): void {
    if (!Object.keys(limits).length) return;
    // Bound metadata even when callers supply many arbitrary model IDs.
    if (!this.observedLimits.has(model) && this.observedLimits.size >= 64) this.observedLimits.delete(this.observedLimits.keys().next().value as string);
    const previousTpm = this.observedLimits.get(model)?.limits.tokensPerMinute;
    this.observedLimits.set(model, { limits: { ...(previousTpm === undefined ? {} : { tokensPerMinute: previousTpm }), ...limits }, at: Date.now() });
  }

  private async apiKey(signal?: AbortSignal): Promise<string> {
    checkCancelled(signal);
    const key = await withCancellation(this.secretStore.get(GROQ_SECRET_KEY), signal);
    checkCancelled(signal);
    if (!key?.trim()) throw new LittleError('PROVIDER_AUTH_FAILED', 'Configure your Groq API key to continue.');
    return key.trim();
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, GROQ_DISCOVERY_TIMEOUT_MS);
    try { return await this.discoverModels(controller.signal); }
    catch (error) {
      if (timedOut && !signal?.aborted) throw new LittleError('PROVIDER_UNAVAILABLE', 'Groq model discovery timed out. Check your connection and refresh models.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  private async discoverModels(signal: AbortSignal): Promise<ModelInfo[]> {
    try {
      const key = await this.apiKey(signal);
      let response: Response | undefined;
      // Discovery is safe to retry. Generation is deliberately never replayed.
      for (let attempt = 0; attempt < 3; attempt++) {
        checkCancelled(signal);
        try {
          response = await withCancellation(this.fetchImpl(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal }), signal);
        } catch (error) {
          const normalized = safeError(error, signal);
          if (normalized.code === 'AGENT_CANCELLED' || attempt === 2) throw normalized;
          await delay(250 * 2 ** attempt, signal);
          continue;
        }
        if (signal.aborted) { await response.body?.cancel().catch(() => undefined); throw cancelled(); }
        if (response.ok) break;
        const { error: normalized } = await groqHttpError(response, false, signal);
        if ((response.status !== 429 && response.status < 500) || attempt === 2) throw normalized;
        // A long server delay is surfaced to the caller instead of blocking the UI.
        if ((normalized.retryAfterMs ?? 0) > 2000) throw normalized;
        await delay(normalized.retryAfterMs ?? 250 * 2 ** attempt, signal);
      }
      if (!response?.body) throw protocolError();
      let size = 0;
      let text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const bytes of chunks(response.body, signal)) {
        size += bytes.length;
        if (size > MAX_MODEL_BYTES) throw protocolError();
        text += decoder.decode(bytes, { stream: true });
      }
      text += decoder.decode();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw protocolError(); }
      const data = object(parsed)?.data;
      if (!Array.isArray(data) || data.length > 2048) throw protocolError();
      const models: ModelInfo[] = [];
      const seen = new Set<string>();
      for (const value of data) {
        const model = discoveredGroqModel(value);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
      return sortGroqModels(models);
    } catch (error) {
      if (error instanceof TypeError) throw protocolError();
      throw safeError(error, signal);
    }
  }

  async *stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMEvent> {
    try {
      const key = await this.apiKey(signal);
      const body = groqNativeRequest(request);
      checkCancelled(signal);
      const response = await withCancellation(this.fetchImpl(`${API_BASE}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal,
      }), signal);
      if (signal?.aborted) { await response.body?.cancel().catch(() => undefined); throw cancelled(); }
      if (!response.ok) {
        const { error, limits } = await groqHttpError(response, true, signal);
        this.rememberLimits(request.model, limits);
        throw error;
      }
      this.rememberLimits(request.model, groqLimits(response.headers));
      const contentType = response.headers.get('content-type');
      if (!response.body || (contentType && !contentType.toLowerCase().startsWith('text/event-stream'))) {
        await response.body?.cancel().catch(() => undefined);
        throw protocolError();
      }
      const toolCalls = new Map<number, ToolCall>();
      let allToolChars = 0;
      let usage: Extract<LLMEvent, { type: 'usage' }> | undefined;
      let reason: string | undefined;
      let done = false;
      let requestId = groqRequestId(response.headers.get('x-request-id'));
      for await (const data of eventData(response.body, signal)) {
        checkCancelled(signal);
        if (data === '[DONE]') { done = true; break; }
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw protocolError(); }
        const chunk = object(parsed);
        if (!chunk) throw protocolError();
        requestId = groqRequestId(object(chunk.x_groq)?.id) ?? requestId;
        if (chunk.error !== undefined && chunk.error !== null) {
          const { error, limits } = groqStreamError(chunk.error, response.headers, requestId);
          this.rememberLimits(request.model, limits);
          throw error;
        }
        if (!Array.isArray(chunk.choices)) throw protocolError();
        const rawUsage = chunk.usage ?? object(chunk.x_groq)?.usage;
        const tokenUsage = object(rawUsage);
        if (rawUsage !== undefined && rawUsage !== null && !tokenUsage) throw protocolError();
        if (tokenUsage) {
          const input = tokenUsage.prompt_tokens;
          const output = tokenUsage.completion_tokens;
          if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
              typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) throw protocolError();
          usage = { type: 'usage', inputTokens: input, outputTokens: output };
        }
        for (const value of chunk.choices) {
          checkCancelled(signal);
          const choice = object(value);
          if (!choice || choice.index !== 0) throw protocolError();
          const delta = object(choice.delta);
          if (!delta) throw protocolError();
          // A finish reason is terminal for the sole requested choice. Usage-only chunks may
          // follow, but no later choice may revise completion or append executable/visible data.
          if (reason !== undefined && ((choice.finish_reason !== null && choice.finish_reason !== undefined) ||
              (delta.content !== undefined && delta.content !== null) || (delta.tool_calls !== undefined && delta.tool_calls !== null))) {
            throw toolCalls.size || delta.tool_calls !== undefined ? invalidToolResponse(requestId) : protocolError();
          }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            if (typeof choice.finish_reason !== 'string' || !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason)) throw protocolError();
            reason = choice.finish_reason;
          }
          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== 'string') throw protocolError();
            if (delta.content) yield { type: 'text', text: delta.content };
          }
          if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) throw invalidToolResponse(requestId);
            for (const fragment of delta.tool_calls) {
              const entry = object(fragment);
              if (!entry || typeof entry.index !== 'number' || !Number.isInteger(entry.index) ||
                  entry.index < 0 || entry.index >= MAX_TOOL_CALLS || (entry.type !== undefined && entry.type !== 'function')) throw invalidToolResponse(requestId);
              const call = toolCalls.get(entry.index) ?? { id: '', name: '', arguments: '' };
              const fn = entry.function === undefined ? undefined : object(entry.function);
              if (entry.function !== undefined && !fn) throw invalidToolResponse(requestId);
              const append = (value: unknown, field: keyof ToolCall): void => {
                if (value === undefined || value === null) return;
                if (typeof value !== 'string') throw invalidToolResponse(requestId);
                call[field] += value;
                allToolChars += value.length;
              };
              append(entry.id, 'id');
              append(fn?.name, 'name');
              append(fn?.arguments, 'arguments');
              if (call.id.length > 256 || call.name.length > 128 || call.arguments.length > MAX_TOOL_ARGUMENT_CHARS ||
                  allToolChars > MAX_ALL_TOOL_CHARS) throw invalidToolResponse(requestId);
              toolCalls.set(entry.index, call);
            }
          }
        }
      }
      checkCancelled(signal);
      if (!done || !reason) throw toolCalls.size ? invalidToolResponse(requestId) : protocolError();
      if (toolCalls.size && reason !== 'tool_calls') throw invalidToolResponse(requestId);
      if (!toolCalls.size && reason === 'tool_calls') throw invalidToolResponse(requestId);
      const completedCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
      const offeredNames = new Set(request.tools?.map(tool => tool.name) ?? []);
      const seenIds = new Set<string>();
      const sequential = request.model === 'openai/gpt-oss-20b' || request.model === 'openai/gpt-oss-120b';
      if (sequential && completedCalls.length > 1) throw invalidToolResponse(requestId);
      // Validate every call before emitting any, so one malformed call cannot start tool execution.
      for (const call of completedCalls) {
        if (!call.id.trim() || !offeredNames.has(call.name) || seenIds.has(call.id)) throw invalidToolResponse(requestId);
        seenIds.add(call.id);
        try { if (!object(JSON.parse(call.arguments))) throw invalidToolResponse(requestId); }
        catch { throw invalidToolResponse(requestId); }
      }
      for (const call of completedCalls) { checkCancelled(signal); yield { type: 'tool_call', call }; }
      checkCancelled(signal);
      if (usage) yield usage;
      checkCancelled(signal);
      yield { type: 'done', reason };
    } catch (error) { throw safeError(error, signal); }
  }

}
