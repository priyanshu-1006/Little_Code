import { LittleError, type LittleErrorCode, type ProviderErrorDiagnostic } from '../shared/errors';

const MAX_ERROR_BYTES = 8192;
const MAX_RESET_MS = 7 * 24 * 60 * 60 * 1000;
interface ErrorDetails { code?: string; type?: string; message?: string; status?: number; parameter?: ProviderErrorDiagnostic['parameter'] }
/** UUIDs and Groq's documented request ULIDs are safe correlation metadata. */
export function groqRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:(?:req_)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|req_01[0-9a-hjkmnp-tv-z]{24})$/i.test(value) ? value : undefined;
}
export interface GroqRequestLimits {
  tokensPerMinute?: number; remainingTokens?: number; resetAfterMs?: number;
  requestsRemaining?: number; requestsResetAfterMs?: number; retryAfterMs?: number;
}

function errorDetails(value: unknown): ErrorDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const status = record.status ?? record.status_code;
  const parameter = (['response_format', 'reasoning_effort', 'include_reasoning', 'max_completion_tokens', 'messages', 'model'] as const)
    .find(name => typeof record.param === 'string' && (record.param === name || record.param.startsWith(`${name}.`) || record.param.startsWith(`${name}[`)));
  return {
    ...(typeof record.code === 'string' && record.code.length <= 80 ? { code: record.code } : {}),
    ...(typeof record.type === 'string' && record.type.length <= 80 ? { type: record.type } : {}),
    ...(typeof record.message === 'string' && record.message.length <= MAX_ERROR_BYTES && new TextEncoder().encode(record.message).length <= MAX_ERROR_BYTES ? { message: record.message } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
    ...(parameter ? { parameter } : {}),
  };
}

function integer(value: string | null, allowZero = true): number | undefined {
  if (value === null || !/^\d{1,10}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= (allowZero ? 0 : 1) && parsed <= 1_000_000_000 ? parsed : undefined;
}

/** Groq reset durations use e.g. 2m59.56s, not an epoch timestamp. */
export function groqResetDuration(value: string | null): number | undefined {
  if (!value || value.length > 80 || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) return undefined;
  let ms = 0;
  for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    ms += Number(part[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[part[2] as 'ms' | 's' | 'm' | 'h' | 'd']);
  }
  return Number.isFinite(ms) && ms <= MAX_RESET_MS ? Math.ceil(ms) : undefined;
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value || value.length > 80) return undefined;
  const seconds = /^(?:\d+(?:\.\d+)?)$/.test(value) ? Number(value) : undefined;
  const ms = seconds === undefined ? Date.parse(value) - Date.now() : seconds * 1000;
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_RESET_MS ? Math.ceil(ms) : undefined;
}

export function groqLimits(headers: Headers, details?: ErrorDetails): GroqRequestLimits {
  // The headers are account/model observations, never assumptions about a free plan.
  const bodyTpm = details?.message?.match(/tokens per minute\s*\(TPM\)[\s\S]{0,160}?\bLimit\s+(\d{1,10})\b/i)?.[1];
  const tokensPerMinute = integer(headers.get('x-ratelimit-limit-tokens'), false) ?? integer(bodyTpm ?? null, false);
  const remainingTokens = integer(headers.get('x-ratelimit-remaining-tokens'));
  const resetAfterMs = groqResetDuration(headers.get('x-ratelimit-reset-tokens'));
  const requestsRemaining = integer(headers.get('x-ratelimit-remaining-requests'));
  const requestsResetAfterMs = groqResetDuration(headers.get('x-ratelimit-reset-requests'));
  const bodyRetry = details?.message?.match(/(?:please\s+)?try again in\s+(\d+(?:\.\d+)?(?:ms|s|m|h|d))\b/i)?.[1];
  const retryAfterMs = retryAfter(headers) ?? groqResetDuration(bodyRetry ?? null);
  return {
    ...(tokensPerMinute === undefined ? {} : { tokensPerMinute }),
    ...(remainingTokens === undefined ? {} : { remainingTokens }),
    ...(resetAfterMs === undefined ? {} : { resetAfterMs }),
    ...(requestsRemaining === undefined ? {} : { requestsRemaining }),
    ...(requestsResetAfterMs === undefined ? {} : { requestsResetAfterMs }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** Read only a small error envelope. Raw provider messages never leave this module. */
async function details(response: Response, signal?: AbortSignal): Promise<ErrorDetails> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  let timedOut = false;
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 1500);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new LittleError('AGENT_CANCELLED', 'Run stopped.');
    let size = 0;
    let text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const next = await reader.read();
      if (signal?.aborted) throw new LittleError('AGENT_CANCELLED', 'Run stopped.');
      if (timedOut || next.done) break;
      size += next.value.length;
      if (size > MAX_ERROR_BYTES) return {};
      text += decoder.decode(next.value, { stream: true });
    }
    if (timedOut) return {};
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return errorDetails((parsed as Record<string, unknown>).error);
  } catch (error) {
    if (signal?.aborted) throw new LittleError('AGENT_CANCELLED', 'Run stopped.');
    if (error instanceof LittleError) throw error;
    return {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function waitText(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1000))} seconds`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60000)} minutes`;
  return `${Math.ceil(ms / 3600000)} hours`;
}

function classify(parsed: ErrorDetails, headers: Headers, phase: ProviderErrorDiagnostic['phase'], completion: boolean, status?: number, streamRequestId?: unknown): { error: LittleError; limits: GroqRequestLimits } {
  const limits = groqLimits(headers, parsed);
  // Accept UUIDs and Groq's documented req_ ULIDs, never arbitrary reflected text.
  const requestId = groqRequestId(streamRequestId) ?? groqRequestId(headers.get('x-request-id'));
  const knownCodes = ['invalid_request_error', 'json_validate_failed', 'structured_generation_failed', 'invalid_json_schema', 'unsupported_response_format'] as const;
  const providerCode = knownCodes.find(code => code === parsed.code);
  const failure = (code: LittleErrorCode, category: ProviderErrorDiagnostic['category'], message: string, retry?: number, reason?: ProviderErrorDiagnostic['reason']): { error: LittleError; limits: GroqRequestLimits } => ({
    error: new LittleError(code, message, retry, { provider: 'groq', phase, category,
      ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }),
      ...(providerCode ? { providerCode } : {}), ...(parsed.parameter ? { parameter: parsed.parameter } : {}), ...(reason ? { reason } : {}) }),
    limits: { ...limits, ...(retry === undefined ? {} : { retryAfterMs: retry }) },
  });
  if (status === 401 || status === 403 || /^(?:invalid_api_key|authentication_error|permission_denied)$/.test(parsed.code ?? '') || /^(?:authentication_error|permission_error)$/.test(parsed.type ?? '')) return failure('PROVIDER_AUTH_FAILED', 'auth', 'Groq rejected the API key or model permission. Configure a valid key and check your Groq project permissions.');
  if (status === 429 || /^(?:rate_limit_exceeded|insufficient_quota)$/.test(parsed.code ?? '') || parsed.type === 'rate_limit_error') {
    const requested = integer(parsed.message?.match(/\bRequested\s+(\d{1,10})\b/i)?.[1] ?? null);
    const oversized = (requested !== undefined && limits.tokensPerMinute !== undefined && requested > limits.tokensPerMinute) || /request too large|reduce.*(?:message|token)/i.test(parsed.message ?? '');
    const exhausted = [limits.remainingTokens === 0 ? limits.resetAfterMs : undefined, limits.requestsRemaining === 0 ? limits.requestsResetAfterMs : undefined].filter((value): value is number => value !== undefined);
    const retry = limits.retryAfterMs ?? (exhausted.length ? Math.max(...exhausted) : undefined);
    let message = 'Groq rate limit reached.';
    if (limits.tokensPerMinute !== undefined) message += ` This model's current account limit is ${limits.tokensPerMinute.toLocaleString('en-US')} tokens per minute.`;
    if (requested !== undefined) message += ` Groq counted ${requested.toLocaleString('en-US')} requested tokens.`;
    if (limits.requestsRemaining === 0) message += ' The daily request quota is exhausted.';
    if (oversized) message += ' This request is too large for that quota; reduce the attached context and output budget, or choose another model. Waiting alone will not make this request fit.';
    else message += retry === undefined ? ' Wait for the account quota to reset, then retry.' : ` Retry in ${waitText(retry)}.`;
    message += ' Check Groq Console → Settings → Limits for your organization quota.';
    return failure('PROVIDER_RATE_LIMITED', 'rate_limit', message, retry);
  }
  if (completion && (status === 404 || /^(?:model_not_found|model_decommissioned|model_not_available)$/.test(parsed.code ?? ''))) return failure('MODEL_UNAVAILABLE', 'model', 'The selected Groq model is unavailable. Refresh the model list and choose another model.');
  if (status === 413 || /^(?:context_length_exceeded|request_too_large)$/.test(parsed.code ?? '')) return failure('CONTEXT_LIMIT', 'context', 'Groq rejected an oversized request. Narrow the context or output budget and retry.');
  if (parsed.code === 'tool_use_failed' || /failed to call a function|failed to generate a valid tool call/i.test(parsed.message ?? '')) return failure('PROVIDER_PROTOCOL_ERROR', 'tool_call', 'Groq could not produce a valid tool call. No tool from this response was executed. Prepare a retry or choose another coding model.');
  if (/^(?:json_validate_failed|structured_generation_failed)$/.test(parsed.code ?? '') || /generated json does not match|failed to generate (?:valid )?json|json.*validation.*failed/i.test(parsed.message ?? '')) {
    return failure('PROVIDER_PROTOCOL_ERROR', 'tool_call', 'Groq could not generate the requested structured response. No action was executed. Prepare a retry. Safe failure details are available in the Little Code output channel.', undefined, 'schema_generation');
  }
  if (/too complex|schema.*too large|grammar.*(?:size|limit|compile)/i.test(parsed.message ?? '')) return failure('PROVIDER_PROTOCOL_ERROR', 'parameters',
    'Groq rejected the complexity of Little Code\'s response schema. No action was executed. Safe failure details are available in the Little Code output channel.', undefined, 'schema_complexity');
  if (parsed.code === 'invalid_json_schema' || /invalid (?:json )?schema|schema.*invalid/i.test(parsed.message ?? '')) return failure('PROVIDER_PROTOCOL_ERROR', 'parameters',
    'Groq rejected Little Code\'s response schema. No action was executed. Safe failure details are available in the Little Code output channel.', undefined, 'invalid_schema');
  if (parsed.code === 'unsupported_response_format' || /unsupported parameter|parameter.*not supported/i.test(parsed.message ?? '')) return failure('PROVIDER_PROTOCOL_ERROR', 'parameters',
    'Groq does not support a requested option for this model. No action was executed. Safe failure details are available in the Little Code output channel.', undefined, 'unsupported_parameter');
  if (status === 498 || parsed.code === 'capacity_exceeded') return failure('PROVIDER_UNAVAILABLE', 'capacity', 'Groq capacity is temporarily unavailable. Retry shortly.');
  if ((status !== undefined && status >= 400 && status < 500) || parsed.type === 'invalid_request_error' || parsed.code === 'invalid_request_error') return failure('PROVIDER_PROTOCOL_ERROR', 'parameters', 'Groq rejected the request. No action was executed. Safe failure details are available in the Little Code output channel.');
  if ((status !== undefined && status >= 500) || parsed.type === 'server_error' || /^(?:internal_server_error|service_unavailable)$/.test(parsed.code ?? '')) return failure('PROVIDER_UNAVAILABLE', 'server', 'Groq reported a server error. Prepare a retry or choose another discovered model.');
  return failure('PROVIDER_UNAVAILABLE', 'unknown', phase === 'stream' ? 'Groq stopped the response with an unrecognized provider error. Prepare a retry or choose another discovered model. Safe diagnostics are available in the Little Code output channel.' : 'Groq is temporarily unavailable. Retry shortly.');
}

export async function groqHttpError(response: Response, completion: boolean, signal?: AbortSignal): Promise<{ error: LittleError; limits: GroqRequestLimits }> {
  return classify(await details(response, signal), response.headers, 'http', completion, response.status);
}

/** Stream errors arrive after HTTP 200. Do not misclassify them using that status. */
export function groqStreamError(value: unknown, headers: Headers, requestId?: unknown): { error: LittleError; limits: GroqRequestLimits } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {
    error: new LittleError('PROVIDER_PROTOCOL_ERROR', 'Groq returned a malformed streamed error. Prepare a retry or choose another discovered model.', undefined, { provider: 'groq', phase: 'stream', category: 'unknown' }), limits: groqLimits(headers),
  };
  const parsed = errorDetails(value);
  return classify(parsed, headers, 'stream', true, parsed.status, requestId);
}

/** Buffered response errors also arrive after HTTP 200; the body supplies the failure. */
export function groqStructuredError(value: unknown, headers: Headers, requestId?: unknown): { error: LittleError; limits: GroqRequestLimits } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {
    error: new LittleError('PROVIDER_PROTOCOL_ERROR', 'Groq returned a malformed structured error. Prepare a retry.', undefined,
      { provider: 'groq', phase: 'structured', category: 'unknown' }), limits: groqLimits(headers),
  };
  const parsed = errorDetails(value);
  return classify(parsed, headers, 'structured', true, parsed.status, requestId);
}
