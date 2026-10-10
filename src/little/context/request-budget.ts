import type { AgentMode, AgentTool, ContextItem, LLMMessage, LLMProvider, LLMRequest, RunContext, ToolDefinition } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { redactSecrets } from './redact-secrets';
import { groqNativeRequest } from '../providers/groq-request';
import { fileWorkflow } from '../agent/file-instructions';

export interface RequestBudgetOptions {
  maxRequestTokens?: number;
  maxOutputTokens?: number;
  modelContextWindow?: number;
  modelMaxOutputTokens?: number;
  maxContextChars?: number;
  /** Original user request when a trusted host adds role instructions to the provider prompt. */
  fileWorkflowPrompt?: string;
  /** Selected workspace root; only absolute paths contained by this exact root become relative. */
  workspaceRoot?: string;
}
type ProviderLimits = ReturnType<NonNullable<LLMProvider['requestLimits']>>;
export const REQUEST_BUDGET_LIMITS = Object.freeze({ groqTokens: 5_500, otherTokens: 24_000, groqOutput: 1_024, groqGptOssOutput: 2_048,
  otherOutput: 2_048, maxChars: 64_000, observationTokens: 1_200, notice: '[Context shortened to fit this request. Use focused read tools for omitted evidence.]' });

/** A conservative UTF-8 estimate, including wire structure; this is not a model tokenizer. */
export function estimateRequestTokens(messages: LLMMessage[], tools: ToolDefinition[] = []): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') / 3) + 64 + tools.length * 8;
}
function serializedRequest(providerId: string, model: string, messages: LLMMessage[], tools: ToolDefinition[], output?: number): string {
  if (providerId === 'groq') {
    return JSON.stringify(groqNativeRequest({ model, messages, tools, ...(output === undefined ? {} : { maxOutputTokens: output }) }));
  }
  return JSON.stringify({ messages, tools });
}
export function estimateProviderRequestTokens(providerId: string, model: string, messages: LLMMessage[], tools: ToolDefinition[] = [], output?: number): number {
  return Math.ceil(Buffer.byteLength(serializedRequest(providerId, model, messages, tools, output), 'utf8') / 3) + 64 + tools.length * 8;
}
function textTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, 'utf8') / 3); }
function finitePositive(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) && value > 0; }
function clipText(text: string, tokens: number, notice: string): string {
  if (textTokens(text) <= tokens) return text;
  const bytes = Math.max(0, Math.floor(tokens * 3) - Buffer.byteLength(notice, 'utf8'));
  // Work in code points so neither a UTF-8 sequence nor a surrogate pair is cut.
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= bytes) low = middle; else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low) + notice;
}
function profile(providerId: string, model: string, options: RequestBudgetOptions, limits: ProviderLimits): { total: number; output: number; chars: number } {
  const groq = providerId === 'groq';
  const gptOss = groq && (model === 'openai/gpt-oss-20b' || model === 'openai/gpt-oss-120b');
  const candidates = [groq ? REQUEST_BUDGET_LIMITS.groqTokens : REQUEST_BUDGET_LIMITS.otherTokens,
    options.maxRequestTokens, options.modelContextWindow, limits?.tokensPerMinute && Math.floor(limits.tokensPerMinute * 0.9)].filter(finitePositive);
  const total = Math.floor(Math.min(...candidates));
  const output = Math.floor(Math.min(gptOss ? REQUEST_BUDGET_LIMITS.groqGptOssOutput : groq ? REQUEST_BUDGET_LIMITS.groqOutput : REQUEST_BUDGET_LIMITS.otherOutput,
    ...[options.maxOutputTokens, options.modelMaxOutputTokens, Math.floor(total / (gptOss ? 2 : 4))].filter(finitePositive)));
  const chars = Math.floor(options.maxContextChars ?? REQUEST_BUDGET_LIMITS.maxChars);
  if (total < 256 || output < 64 || chars < 1) throw new LittleError('CONTEXT_LIMIT', 'This model or request budget is too small for a coding request. Select another model.');
  return { total, output, chars };
}
function priority(id: string): number {
  if (id.startsWith('selection:')) return 100;
  if (id === 'project-instructions') return 95;
  if (id === 'workspace') return 90;
  if (id.startsWith('retrieved:')) return 85;
  if (id.startsWith('file:')) return 80;
  if (id === 'diagnostics') return 75;
  if (id === 'user-preferences') return 95;
  if (id === 'project-memory') return 87;
  return 60;
}
function boundContext(context: RunContext, tokens: number): RunContext {
  const safeText = redactSecrets(context.text);
  if (textTokens(safeText) <= tokens) return { text: safeText, items: context.items.map(item => ({ ...item })),
    ...(context.sections ? { sections: context.sections.map(section => ({ itemId: section.itemId, text: redactSecrets(section.text) })) } : {}) };
  const sections = context.sections?.filter(section => context.items.some(item => item.id === section.itemId));
  if (!sections?.length) {
    return { text: clipText(safeText, tokens, `\n${REQUEST_BUDGET_LIMITS.notice}`), items: [{ id: 'bounded-context', label: 'Selected repository context',
      type: 'workspace', estimatedTokens: tokens, reason: 'Repository context shortened for the model and provider request budget.' }] };
  }
  // Give each selected section a useful excerpt before assigning extra space. This retains the map
  // and several ranked source headers instead of filling the request with one large active buffer.
  const order = sections.map((section, index) => ({ ...section, text: redactSecrets(section.text), index, priority: priority(section.itemId) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  const selected = order.slice(0, Math.max(1, Math.min(order.length, Math.floor(tokens / 180))));
  const remaining = Math.max(0, tokens - textTokens(REQUEST_BUDGET_LIMITS.notice) - selected.length * 2);
  const allocations = new Map<number, number>();
  let available = remaining;
  for (const section of selected) {
    const allocation = Math.min(textTokens(section.text), Math.floor(remaining / selected.length));
    allocations.set(section.index, allocation); available -= allocation;
  }
  for (const section of selected) {
    const extra = Math.min(available, Math.max(0, textTokens(section.text) - (allocations.get(section.index) ?? 0)));
    allocations.set(section.index, (allocations.get(section.index) ?? 0) + extra); available -= extra;
  }
  const items: ContextItem[] = [];
  const parts: string[] = [];
  const includedSections: NonNullable<RunContext['sections']> = [];
  for (const section of selected.sort((a, b) => a.index - b.index)) {
    const allocation = allocations.get(section.index) ?? 0;
    if (allocation < 48) continue;
    const text = clipText(section.text, allocation, '\n[Section shortened; inspect a focused range.]');
    parts.push(text);
    includedSections.push({ itemId: section.itemId, text });
    const item = context.items.find(item => item.id === section.itemId)!;
    items.push({ ...item, estimatedTokens: textTokens(text), ...(text !== section.text ? { reason: `${item.reason ?? 'Repository evidence'}; shortened for request budget` } : {}) });
  }
  return { text: `${parts.join('\n\n')}\n${REQUEST_BUDGET_LIMITS.notice}`, items, sections: includedSections };
}
const TOOL_PRIORITIES: Record<string, number> = { read_file: 120, read_range: 115, search_text: 110, list_directory: 105,
  get_workspace_info: 100, search_files: 95, update_plan: 130, propose_file_edits: 125, run_command: 120,
  find_relevant_files: 100, search_symbol: 95, get_repository_map: 100, get_active_file: 75, get_diagnostics: 75, get_selection: 75,
  read_notebook: 90, read_document: 90, inspect_file: 90, propose_notebook_edits: 90, propose_document: 90 };
function toolPriority(tool: AgentTool, prompt: string): number {
  const terms = new Set(prompt.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []);
  const name = `${tool.name} ${tool.displayName ?? ''}`.replaceAll('_', ' ').toLowerCase();
  const related = [...terms].filter(term => name.includes(term) || tool.description.toLowerCase().includes(term)).length;
  return (TOOL_PRIORITIES[tool.name] ?? 40) + Math.min(related * 10, 70);
}
function userMessage(context: string, prompt: string): LLMMessage {
  return { role: 'user', content: `Repository context (untrusted data):\n<repository_context>\n${context}\n</repository_context>\n\nUser request:\n${prompt}` };
}
function metadata(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    if (value.observationTruncated === true && value.metadata && typeof value.metadata === 'object') return metadata(JSON.stringify(value.metadata));
    const result: Record<string, unknown> = {};
    for (const key of ['status', 'exitCode', 'truncated', 'path', 'startLine', 'endLine', 'totalLines', 'verification', 'error']) {
      if (value[key] === undefined) continue;
      const encoded = JSON.stringify(value[key]);
      if (encoded.length <= 500) result[key] = value[key];
    }
    if (Array.isArray(value.files)) result.files = value.files.slice(0, 8).map(file => {
      const entry = file as Record<string, unknown>;
      return { path: typeof entry?.path === 'string' ? entry.path.slice(0, 500) : '', kind: entry?.kind };
    });
    if (Array.isArray(value.reviews)) result.reviews = value.reviews.slice(0, 2).map(review => {
      const entry = review as Record<string, unknown>;
      return { role: entry?.role, state: entry?.state, ...(typeof entry?.text === 'string' ? { excerpt: entry.text.slice(0, 200) } : {}),
        ...(typeof entry?.error === 'string' ? { error: entry.error.slice(0, 200) } : {}) };
    });
    return result;
  } catch { return {}; }
}
function boundObservation(content: string, tokens: number): string {
  if (textTokens(content) <= tokens) return content;
  const record = { observationTruncated: true, message: 'Tool observation shortened for this request. Omitted output is not evidence. Read a smaller range when needed.',
    metadata: metadata(content), preview: '' };
  record.preview = clipText(content, Math.max(64, tokens - textTokens(JSON.stringify(record)) - 12), '\n[Observation shortened]');
  const encoded = JSON.stringify(record);
  if (textTokens(encoded) <= tokens + 64) return encoded;
  return JSON.stringify({ observationTruncated: true, message: record.message, preview: clipText(content, Math.max(48, tokens - 100), '\n[Observation shortened]') });
}
function exchangeSummary(messages: LLMMessage[]): string {
  const assistant = messages[0];
  return (assistant?.toolCalls ?? []).map(call => {
    const result = messages.find(message => message.role === 'tool' && message.toolCallId === call.id)?.content ?? '';
    const details = metadata(result);
    // Keep actual outcomes, especially denied commands and applied edits; source text is deliberately
    // omitted here. The runtime's verification and repetition ledgers remain authoritative.
    return `${call.name}: ${Object.keys(details).length ? JSON.stringify(details) : 'Earlier observation omitted; inspect again if required.'}`;
  }).join('\n');
}

export interface PreparedRequest { request: LLMRequest; items: ContextItem[]; estimatedTokens: number }
/** Deterministic compaction of complete tool exchanges. It performs no extra inference or tool calls. */
export class RequestBudget {
  readonly tools: AgentTool[];
  private readonly context: RunContext;
  private readonly system: string;
  private readonly prompt: string;
  private readonly omittedTools: number;
  constructor(private readonly providerId: string, private readonly model: string, mode: AgentMode, system: string, prompt: string,
    context: RunContext, tools: AgentTool[], private readonly options: RequestBudgetOptions = {}, limits?: ProviderLimits) {
    this.system = system;
    this.prompt = redactSecrets(prompt);
    const budget = profile(providerId, model, options, limits);
    const mandatory = mode === 'agent' ? new Set(['update_plan', 'propose_file_edits', 'run_command', 'read_file'])
      : mode === 'edit' ? new Set(['propose_file_edits', 'read_file']) : new Set(['read_file']);
    const workflow = fileWorkflow(options.fileWorkflowPrompt ?? prompt, mode, options.workspaceRoot);
    if (workflow.explicit) {
      const readers = workflow.createOnly ? workflow.readers.filter(name => tools.some(tool => tool.name === name)).slice(0, 1)
        : workflow.readers.filter(name => tools.some(tool => tool.name === name));
      if (readers.length && !readers.includes('read_file')) mandatory.delete('read_file');
      for (const name of readers) mandatory.add(name);
      if (workflow.mutate) {
        if (!workflow.proposals.includes('propose_file_edits') && workflow.proposals.some(name => tools.some(tool => tool.name === name))) mandatory.delete('propose_file_edits');
        for (const name of workflow.proposals) if (tools.some(tool => tool.name === name)) mandatory.add(name);
      }
    }
    const selected: AgentTool[] = [];
    const ordered = tools.map((tool, index) => ({ tool, index, score: toolPriority(tool, prompt) }))
      .sort((a, b) => Number(mandatory.has(b.tool.name)) - Number(mandatory.has(a.tool.name)) || b.score - a.score || a.index - b.index);
    const definitionBudget = Math.floor((budget.total - budget.output) * 0.5);
    for (const { tool } of ordered) {
      const definitions = [...selected, tool].map(({ name, description, parameters }) => ({ name, description, parameters }));
      const size = estimateProviderRequestTokens(providerId, model, [], definitions, budget.output) - 64;
      if (size <= definitionBudget || mandatory.has(tool.name)) selected.push(tool);
    }
    // Stable registry order makes tool schemas easier to cache and avoids request-to-request churn.
    this.tools = tools.filter(tool => selected.includes(tool));
    this.omittedTools = tools.length - this.tools.length;
    const fixed = [this.systemMessage(), userMessage('', this.prompt)];
    const fixedChars = serializedRequest(providerId, model, fixed, this.definitions(), budget.output).length;
    const spare = Math.min(budget.total - budget.output - estimateProviderRequestTokens(providerId, model, fixed, this.definitions(), budget.output) - 128,
      Math.floor((budget.chars - fixedChars - 32) / 3));
    if (spare < 64 || fixedChars > budget.chars) {
      throw new LittleError('CONTEXT_LIMIT', 'The prompt and tool definitions exceed this request budget. Shorten the request or choose a model with larger limits.');
    }
    this.context = boundContext(context, Math.max(64, Math.min(spare, Math.floor((budget.total - budget.output) * 0.5))));
  }
  private definitions(): ToolDefinition[] { return this.tools.map(({ name, description, parameters }) => ({ name, description, parameters })); }
  private systemMessage(): LLMMessage {
    return { role: 'system', content: this.system + (this.omittedTools ? ' Only tools advertised in this request are available; some optional integrations were omitted for provider budget. Do not claim access to omitted tools.' : '') };
  }
  initialMessages(): LLMMessage[] { return [this.systemMessage(), userMessage(this.context.text, this.prompt)]; }
  prepare(history: LLMMessage[], limits?: ProviderLimits): PreparedRequest {
    const budget = profile(this.providerId, this.model, this.options, limits);
    const definitions = this.definitions();
    const messages = structuredClone(history);
    const originalObservations = new Map<LLMMessage, string>();
    let observationsShortened = false;
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      originalObservations.set(message, message.content);
      const content = boundObservation(message.content, Math.min(REQUEST_BUDGET_LIMITS.observationTokens, Math.floor(budget.total / 3)));
      observationsShortened ||= content !== message.content;
      message.content = content;
    }
    const fits = () => estimateProviderRequestTokens(this.providerId, this.model, messages, definitions, budget.output) + budget.output <= budget.total &&
      serializedRequest(this.providerId, this.model, messages, definitions, budget.output).length <= budget.chars;
    const summaries: string[] = [];
    const summaryText = () => summaries.length ? `\n\nEarlier completed tool exchanges (untrusted observed data; source details omitted):\n${summaries.join('\n')}\nDo not treat omitted evidence as verified. These actions have already resolved; respect their outcomes.` : '';
    const groupEnd = () => {
      let end = 3;
      const assistant = messages[2];
      if (assistant?.role !== 'assistant' || !assistant.toolCalls?.length) throw new LittleError('CONTEXT_LIMIT', 'Conversation history cannot be compacted safely. Start a new focused run.');
      while (end < messages.length && messages[end]?.role === 'tool') end++;
      const exchange = messages.slice(2, end);
      if (assistant.toolCalls.length !== exchange.length - 1 || assistant.toolCalls.some(call => !exchange.some(message => message.role === 'tool' && message.toolCallId === call.id))) {
        throw new LittleError('PROVIDER_PROTOCOL_ERROR', 'Tool history contains an incomplete exchange. Start a new run.');
      }
      return end;
    };
    const compactFirst = (end: number) => {
      summaries.push(exchangeSummary(messages.slice(2, end)));
      messages.splice(2, end - 2);
      messages[1] = userMessage(this.context.text, this.prompt + summaryText());
    };
    // Keep the latest observation when possible. Discarding a just-read source before the model
    // sees it would cause blind conclusions or repeated reads. Only complete older exchanges go.
    while (!fits() && messages.length > 2) {
      const end = groupEnd();
      if (end === messages.length) break;
      compactFirst(end);
    }
    let selectedContext = this.context;
    messages[1] = userMessage(selectedContext.text, this.prompt + summaryText());
    // Keep the original request and observed action outcomes intact. Shorten repository evidence
    // next; if mandatory information itself is too large, stop before making an invalid request.
    if (!fits()) {
      const contextAllowance = () => {
        const fixed = [messages[0]!, userMessage('', this.prompt + summaryText()), ...messages.slice(2)];
        return Math.min(budget.total - budget.output - estimateProviderRequestTokens(this.providerId, this.model, fixed, definitions, budget.output) - 32,
          Math.floor((budget.chars - serializedRequest(this.providerId, this.model, fixed, definitions, budget.output).length - 32) / 3));
      };
      let spare = contextAllowance();
      if (spare < 64 && messages.length > 2) {
        // JSON-encoded tool observations consume escaped wire space. Adapt the newest excerpt before losing
        // a source read the model has not seen. Always retain complete call arguments.
        const observations = messages.slice(2).filter(message => message.role === 'tool');
        const previous = observations.map(message => message.content);
        let low = 256, high = Math.min(REQUEST_BUDGET_LIMITS.observationTokens, Math.floor(budget.total / 3));
        let best: string[] | undefined;
        while (observations.length && low <= high) {
          const middle = Math.floor((low + high) / 2);
          for (const message of observations) message.content = boundObservation(originalObservations.get(message) ?? message.content, middle);
          if (contextAllowance() >= 128) { best = observations.map(message => message.content); low = middle + 1; }
          else high = middle - 1;
        }
        observations.forEach((message, index) => { message.content = (best ?? previous)[index]!; });
        if (best) { observationsShortened = true; spare = contextAllowance(); }
      }
      // Very large resolved edit arguments cannot be clipped literally. If even an empty source
      // context cannot fit, replace that entire resolved exchange with its actual outcome summary.
      if (spare < 64 && messages.length > 2) { compactFirst(groupEnd()); spare = contextAllowance(); }
      if (spare < 64) throw new LittleError('CONTEXT_LIMIT', 'The prompt and resolved actions exceed this request budget. Start a focused run; no actions were replayed.');
      // Source newlines and quotes also consume JSON wire space. Search against the complete
      // serialized request rather than assuming the plain source estimate is the final size.
      let low = 64, high = spare;
      let best: RunContext | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = boundContext(this.context, middle);
        messages[1] = userMessage(candidate.text, this.prompt + summaryText());
        if (fits()) { best = candidate; low = middle + 1; } else high = middle - 1;
      }
      if (!best) throw new LittleError('CONTEXT_LIMIT', 'The prompt and resolved actions exceed this request budget. Start a focused run; no actions were replayed.');
      selectedContext = best;
      messages[1] = userMessage(best.text, this.prompt + summaryText());
    }
    if (!fits()) throw new LittleError('CONTEXT_LIMIT', 'The request exceeds the model or provider budget. Narrow the request or choose another model.');
    const items = selectedContext.items.map(item => ({ ...item }));
    const notes = [selectedContext.text !== this.context.text ? 'Repository evidence shortened.' : '',
      this.context.text.includes(REQUEST_BUDGET_LIMITS.notice) ? 'Repository evidence shortened.' : '',
      this.omittedTools ? `${this.omittedTools} optional tool definitions omitted.` : '', observationsShortened ? 'Large tool observations shortened.' : '',
      summaries.length ? `${summaries.length} earlier tool exchanges summarized; no actions replayed.` : ''].filter(Boolean);
    if (notes.length || this.providerId === 'groq') items.push({ id: 'request-budget', label: 'Request budget', type: 'workspace', estimatedTokens: 0,
      reason: `${[...new Set(notes)].join(' ')} Approximate request ceiling: ${budget.total} tokens including ${budget.output} response tokens.` });
    return { request: { model: this.model, messages, tools: definitions, maxOutputTokens: budget.output }, items,
      estimatedTokens: estimateProviderRequestTokens(this.providerId, this.model, messages, definitions, budget.output) + budget.output };
  }
}
/** Header-based pacing before a new request; this never retries an HTTP response or replays tools. */
export function quotaWait(limits: ProviderLimits, estimatedTokens: number): number | undefined {
  if (!limits) return;
  const waits: number[] = [];
  if (finitePositive(limits.retryAfterMs)) waits.push(limits.retryAfterMs);
  if (limits.remainingTokens !== undefined && limits.remainingTokens < estimatedTokens) {
    if (!finitePositive(limits.resetAfterMs)) throw new LittleError('PROVIDER_RATE_LIMITED', 'The provider has insufficient token allowance. Wait for your quota to reset, or select another model.');
    waits.push(limits.resetAfterMs);
  }
  if (limits.requestsRemaining !== undefined && limits.requestsRemaining <= 0) {
    if (!finitePositive(limits.requestsResetAfterMs)) throw new LittleError('PROVIDER_RATE_LIMITED', 'The provider request allowance is exhausted. Wait for your quota to reset.');
    waits.push(limits.requestsResetAfterMs);
  }
  return waits.length ? Math.ceil(Math.max(...waits)) : undefined;
}
