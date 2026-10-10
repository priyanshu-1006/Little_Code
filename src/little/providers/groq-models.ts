import type { ModelInfo } from '../shared/contracts';

type ModelRecord = Record<string, unknown>;
interface PublishedModel { context: number; output: number; reasoning?: boolean; vision?: boolean; priority: number }

/** Metadata only: availability always comes from authenticated /models discovery.
 * Checked against https://console.groq.com/docs/models and /docs/tool-use/overview.
 * Unknown newly discovered chat models keep unknown tool support.
 */
const published: Readonly<Record<string, PublishedModel>> = {
  'openai/gpt-oss-20b': { context: 131072, output: 65536, reasoning: true, priority: 0 },
  'llama-3.1-8b-instant': { context: 131072, output: 131072, priority: 1 },
  'openai/gpt-oss-120b': { context: 131072, output: 65536, reasoning: true, priority: 2 },
  'llama-3.3-70b-versatile': { context: 131072, output: 32768, priority: 3 },
  'qwen/qwen3.8-27b': { context: 131072, output: 16384, reasoning: true, vision: true, priority: 4 },
  'minimaxai/minimax-m2.7': { context: 196608, output: 131072, reasoning: true, priority: 5 },
};
function publishedModel(id: string): PublishedModel | undefined { return Object.hasOwn(published, id) ? published[id] : undefined; }

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000 ? value : undefined;
}

function codingModel(model: ModelRecord, id: string): boolean {
  // Groq's general model endpoint also returns speech, safety, and hosted agent systems.
  // They cannot fulfill Little's local coding/tool orchestration contract.
  if (/(?:^|[/_.-])(?:whisper|orpheus|playai|tts|speech|audio|embedding|embed|rerank|safeguard|prompt[-_]guard|llama[-_]guard|compound)(?:$|[/_.-])/i.test(id)) return false;
  if (model.supports_streaming === false) return false;
  for (const value of [model.type, model.model_type, model.task]) {
    if (typeof value === 'string' && /(?:audio|speech|transcri|tts|embedding|rerank|moderation|classification|guard)/i.test(value)) return false;
  }
  const endpoints = model.supported_endpoints;
  if (Array.isArray(endpoints) && endpoints.length && !endpoints.some(value => typeof value === 'string' && /(?:^|\/)chat(?:\/completions)?$/.test(value))) return false;
  const modalities = model.modalities;
  if (modalities && typeof modalities === 'object' && !Array.isArray(modalities)) {
    const output = (modalities as ModelRecord).output;
    if (Array.isArray(output) && output.length && !output.includes('text')) return false;
  }
  return true;
}

export function discoveredGroqModel(value: unknown): ModelInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = value as ModelRecord;
  if (typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(model.id) || model.active === false || !codingModel(model, model.id)) return undefined;
  const known = publishedModel(model.id);
  const contextWindow = positiveInteger(model.context_window) ?? known?.context;
  const maxOutputTokens = positiveInteger(model.max_completion_tokens) ?? positiveInteger(model.max_output_tokens) ?? known?.output;
  const explicitTools = model.supports_tool_calling;
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.trim() && model.name.length <= 120 && !/[\x00-\x1f\x7f]/.test(model.name) ? model.name : model.id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: {
      streaming: true,
      tools: typeof explicitTools === 'boolean' ? explicitTools : known ? true : 'unknown',
      ...(known?.reasoning ? { reasoning: true } : {}),
      ...(known?.vision ? { vision: true } : {}),
    },
  };
}

export function sortGroqModels(models: ModelInfo[]): ModelInfo[] {
  return models.sort((left, right) => (publishedModel(left.id)?.priority ?? 100) - (publishedModel(right.id)?.priority ?? 100) || left.id.localeCompare(right.id));
}

export function groqReasoningOptions(id: string): Record<string, unknown> {
  if (id === 'openai/gpt-oss-20b' || id === 'openai/gpt-oss-120b') return { include_reasoning: false, reasoning_effort: 'low' };
  if (id === 'qwen/qwen3.8-27b') return { reasoning_format: 'hidden', reasoning_effort: 'default' };
  if (id === 'minimaxai/minimax-m2.7') return { reasoning_format: 'hidden' };
  return {};
}
