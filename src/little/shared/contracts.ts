import type { ProviderErrorDiagnostic } from './errors';

export type AgentMode = 'ask' | 'plan' | 'edit' | 'agent';
export type AgentState = 'idle' | 'understanding' | 'searching' | 'planning' | 'waiting_for_permission' | 'waiting_for_provider' | 'executing' | 'verifying' | 'repairing' | 'reviewing' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type ToolRisk = 'SAFE' | 'WORKSPACE_WRITE' | 'EXECUTION' | 'SENSITIVE' | 'DANGEROUS';
export type ProviderId = 'groq' | 'ollama';
export interface ProjectMemoryView { id: string; title: string; content: string; kind: 'user' | 'fact' | 'inference'; source?: string; createdAt: number; updatedAt: number }
export interface McpServerView { id: string; name: string; url: string; state: 'disconnected' | 'connecting' | 'connected' | 'failed'; tools: number; message?: string }
export interface FeatureSnapshot { memory: { entries: ProjectMemoryView[]; error?: string }; mcp: McpServerView[] }

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: { streaming: boolean; tools: boolean | 'unknown'; vision?: boolean; reasoning?: boolean };
}
export interface ToolCall { id: string; name: string; arguments: string }
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface LLMRequest { model: string; messages: LLMMessage[]; tools?: ToolDefinition[]; maxOutputTokens?: number }
export type LLMEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; reason: string };
export interface LLMProvider {
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMEvent>;
  requestLimits?(model: string): { tokensPerMinute?: number; remainingTokens?: number; resetAfterMs?: number; requestsRemaining?: number; requestsResetAfterMs?: number; retryAfterMs?: number } | undefined;
}
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface ToolContext { signal: AbortSignal; runId?: string }
export interface ProjectCommand { program: string; args: string[]; cwd: string; purpose: string; timeoutMs: number }
export interface CommandResult {
  status: 'exited' | 'rejected' | 'cancelled' | 'timed_out' | 'output_limit' | 'failed';
  exitCode: number | null; output: string; truncated: boolean; durationMs: number;
}
export interface AgentTool extends ToolDefinition {
  displayName?: string;
  risk: ToolRisk;
  validate(input: unknown): unknown;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
export interface ContextItem { id: string; label: string; type: 'workspace' | 'file' | 'selection' | 'diagnostics'; estimatedTokens: number; reason?: string }
export interface RepositoryStatus {
  state: 'idle' | 'indexing' | 'ready' | 'failed'; workspace: string;
  files: number; processed: number; symbols: number; reused: number; truncated: boolean; generation: number;
  updatedAt?: number; message?: string;
}
export interface RunContext { text: string; items: ContextItem[]; sections?: { itemId: string; text: string }[] }
export type RuntimeEvent =
  | { type: 'agent.started'; runId: string; mode: AgentMode; model: string }
  | { type: 'agent.state.changed'; runId: string; state: AgentState }
  | { type: 'context.updated'; runId: string; items: ContextItem[] }
  | { type: 'agent.text.delta'; runId: string; text: string }
  | { type: 'tool.started'; runId: string; call: ToolCall; label?: string }
  | { type: 'tool.completed'; runId: string; callId: string; name: string; summary: string }
  | { type: 'tool.failed'; runId: string; callId: string; name: string; code: string; message: string }
  | { type: 'agent.usage'; runId: string; inputTokens: number; outputTokens: number }
  | { type: 'agent.provider.wait'; runId: string; until: number; message: string }
  | { type: 'edits.proposed'; runId: string; proposalId: string; files: { path: string; kind: 'replace' | 'create' | 'delete' }[] }
  | { type: 'edits.resolved'; runId: string; proposalId: string; decision: 'applied' | 'rejected' | 'conflicted'; checkpointId?: string }
  | { type: 'edits.restored'; runId: string; checkpointId: string }
  | { type: 'command.proposed'; runId: string; commandId: string; command: ProjectCommand; risk: ToolRisk }
  | { type: 'command.started'; runId: string; commandId: string }
  | { type: 'command.completed'; runId: string; commandId: string; result: CommandResult }
  | { type: 'agent.plan.updated'; runId: string; steps: string[] }
  | { type: 'review.updated'; runId: string; role: 'architecture' | 'verification'; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; text?: string; error?: string }
  | { type: 'agent.verification'; runId: string; status: 'passed' | 'failed' | 'not_run'; checks: { command: string; status: CommandResult['status']; exitCode: number | null; passed: boolean; durationMs: number }[]; outstandingEdits: boolean }
  | { type: 'agent.completed'; runId: string }
  | { type: 'agent.cancelled'; runId: string }
  | { type: 'agent.failed'; runId: string; code: string; message: string; retryAfterMs?: number; diagnostic?: ProviderErrorDiagnostic };
export interface EditorSnapshot { activeFile?: string; activeContent?: string; selection?: string; openFiles: string[]; diagnostics: string[] }
export interface EditorService { snapshot(): EditorSnapshot }
