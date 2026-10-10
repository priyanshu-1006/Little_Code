import { z } from 'zod';
import type { FeatureSnapshot, ModelInfo, ProviderId, RepositoryStatus, RuntimeEvent } from '../shared/contracts';
import { MAX_PROMPT_CHARACTERS } from '../shared/limits';
import type { ChatHistorySnapshot } from '../history/chat-history';

export { MAX_PROMPT_CHARACTERS } from '../shared/limits';

/** The webview may request actions, but credentials and execution stay in the host. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('openProject') }).strict(),
  z.object({ type: z.literal('toggleAppearance') }).strict(),
  z.object({ type: z.literal('newChat') }).strict(),
  z.object({ type: z.literal('selectChat'), id: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ type: z.literal('clearChatHistory') }).strict(),
  z.object({ type: z.literal('configure') }).strict(),
  z.object({ type: z.literal('removeKey') }).strict(),
  z.object({ type: z.literal('refreshModels') }).strict(),
  z.object({ type: z.literal('refreshRepository') }).strict(),
  z.object({ type: z.literal('reviewGit') }).strict(),
  z.object({ type: z.literal('browseCheckpoints') }).strict(),
  z.object({ type: z.literal('configureBrowser') }).strict(),
  z.object({ type: z.literal('inspectBrowser') }).strict(),
  z.object({ type: z.literal('selectProvider'), provider: z.enum(['groq', 'ollama']) }).strict(),
  z.object({ type: z.literal('configureOllama') }).strict(),
  z.object({ type: z.literal('configurePreferences') }).strict(),
  z.object({ type: z.literal('addMemory') }).strict(),
  z.object({ type: z.literal('editMemory'), id: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ type: z.literal('removeMemory'), id: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ type: z.literal('addMcpServer') }).strict(),
  z.object({ type: z.literal('connectMcpServer'), id: z.string().regex(/^[a-f0-9]{16}$/) }).strict(),
  z.object({ type: z.literal('disconnectMcpServer'), id: z.string().regex(/^[a-f0-9]{16}$/) }).strict(),
  z.object({ type: z.literal('removeMcpServer'), id: z.string().regex(/^[a-f0-9]{16}$/) }).strict(),
  z.object({ type: z.literal('selectModel'), model: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('start'), prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARACTERS), mode: z.enum(['ask', 'plan', 'edit', 'agent']) }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  z.object({ type: z.literal('reviewEdits'), proposalId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ type: z.literal('decideEdits'), proposalId: z.string().regex(/^[a-f0-9]{32}$/), decision: z.enum(['accept', 'reject']) }).strict(),
  z.object({ type: z.literal('restoreCheckpoint'), checkpointId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ type: z.literal('decideCommand'), commandId: z.string().regex(/^[a-f0-9]{32}$/), decision: z.enum(['allow', 'reject']) }).strict(),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HostMessage =
  | { type: 'snapshot'; configured: boolean; models: ModelInfo[]; selectedModel: string; workspace: string; events: RuntimeEvent[]; busy: boolean; chatHistory?: ChatHistorySnapshot; discovery?: 'idle' | 'loading' | 'ready' | 'failed'; providerError?: { code: string; message: string; retryAt?: number }; cooldownUntil?: number; repository?: RepositoryStatus; provider?: ProviderId; endpoint?: string; features?: FeatureSnapshot }
  | { type: 'chatHistory'; history: ChatHistorySnapshot }
  | { type: 'features'; workspace: string; features: FeatureSnapshot }
  | { type: 'repository'; status: RepositoryStatus }
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'error'; code: string; message: string; retryAfterMs?: number };
