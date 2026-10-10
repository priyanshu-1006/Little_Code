export type LittleErrorCode = 'PROVIDER_AUTH_FAILED' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'MODEL_UNAVAILABLE' | 'PROVIDER_PROTOCOL_ERROR' | 'TOOL_VALIDATION_FAILED' | 'TOOL_FAILED' | 'PERMISSION_DENIED' | 'WORKSPACE_BOUNDARY_VIOLATION' | 'AGENT_CANCELLED' | 'AGENT_LOOP_LIMIT' | 'CONTEXT_LIMIT';
/** Provider adapters construct these from fixed classifications, never raw error text. */
export interface ProviderErrorDiagnostic {
  provider: 'groq'; phase: 'http' | 'stream' | 'structured'; category: 'auth' | 'rate_limit' | 'model' | 'context' | 'tool_call' | 'parameters' | 'capacity' | 'server' | 'unknown';
  status?: number; requestId?: string;
  providerCode?: 'invalid_request_error' | 'json_validate_failed' | 'structured_generation_failed' | 'invalid_json_schema' | 'unsupported_response_format';
  parameter?: 'response_format' | 'reasoning_effort' | 'include_reasoning' | 'max_completion_tokens' | 'messages' | 'model';
  reason?: 'schema_generation' | 'invalid_schema' | 'schema_complexity' | 'unsupported_parameter';
}
export class LittleError extends Error {
  constructor(readonly code: LittleErrorCode, message: string, readonly retryAfterMs?: number, readonly diagnostic?: ProviderErrorDiagnostic) {
    super(message);
    this.name = 'LittleError';
  }
}
export function normalizeError(error: unknown): LittleError {
  if (error instanceof LittleError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new LittleError('AGENT_CANCELLED', 'Run stopped.');
  return new LittleError('TOOL_FAILED', 'The operation failed. Retry or inspect the workspace.');
}
