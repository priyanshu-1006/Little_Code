import type { AgentMode, AgentState, ContextItem, FeatureSnapshot, ProviderId, RepositoryStatus, RuntimeEvent } from '../shared/contracts';
import type { HostMessage } from './protocol';
import type { ChatHistorySnapshot } from '../history/chat-history';

export const MAX_ACTIVITY_ITEMS = 60;
export const MAX_COMMAND_OUTPUT_CHARACTERS = 65536;
const MAX_RESPONSE_CHARACTERS = 512000;

export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'success' | 'failed';
  summary?: string;
  errorCode?: string;
}
export interface EditProposalView {
  id: string;
  files: { path: string; kind: 'replace' | 'create' | 'delete' }[];
  status: 'pending' | 'applied' | 'rejected' | 'conflicted' | 'restored';
  checkpointId?: string;
  pendingDecision?: 'accept' | 'reject';
  restorePending?: boolean;
}
export interface CommandView {
  id: string;
  command: Extract<RuntimeEvent, { type: 'command.proposed' }>['command'];
  risk: Extract<RuntimeEvent, { type: 'command.proposed' }>['risk'];
  status: 'pending' | 'running' | 'completed';
  pendingDecision?: 'allow' | 'reject';
  result?: Extract<RuntimeEvent, { type: 'command.completed' }>['result'];
  displayTruncated?: boolean;
}
export type VerificationView = Omit<Extract<RuntimeEvent, { type: 'agent.verification' }>, 'type' | 'runId'>;
export interface RunView {
  id: string;
  mode: AgentMode;
  model: string;
  state: AgentState;
  text: string;
  context: ContextItem[];
  activity: ToolActivity[];
  omittedActivity: number;
  edits: EditProposalView[];
  commands: CommandView[];
  plan: string[];
  reviews?: Omit<Extract<RuntimeEvent, { type: 'review.updated' }>, 'type' | 'runId'>[];
  verification?: VerificationView;
  usage?: { inputTokens: number; outputTokens: number; requests: number };
  providerWait?: { until: number; message: string };
  error?: { code: string; message: string; retryAfterMs?: number };
}
export interface UiState {
  provider: ProviderId;
  endpoint: string;
  features: FeatureSnapshot;
  configured: boolean;
  models: Extract<HostMessage, { type: 'snapshot' }>['models'];
  selectedModel: string;
  discovery: 'idle' | 'loading' | 'ready' | 'failed';
  providerError?: { code: string; message: string; retryAt?: number };
  cooldownUntil: number;
  workspace: string;
  repository: RepositoryStatus | null;
  repositoryPending: boolean;
  busy: boolean;
  pendingStart: boolean;
  cancelPending: boolean;
  chatHistory: ChatHistorySnapshot | null;
  historyPending: boolean;
  run: RunView | null;
  error: { code: string; message: string; retryAfterMs?: number } | null;
}
export const initialState: UiState = {
  provider: 'groq', endpoint: 'http://127.0.0.1:11434', features: { memory: { entries: [] }, mcp: [] },
  configured: false, models: [], selectedModel: '', workspace: '', busy: false,
  discovery: 'idle', cooldownUntil: 0,
  repository: null, repositoryPending: false,
  pendingStart: false, cancelPending: false, chatHistory: null, historyPending: false, run: null, error: null,
};
export type UiAction = HostMessage | { type: 'requestStart' } | { type: 'requestCancel' } | { type: 'dismissError' } | { type: 'requestRepositoryRefresh' }
  | { type: 'requestHistoryChange' }
  | { type: 'requestEditDecision'; proposalId: string; decision: 'accept' | 'reject' }
  | { type: 'requestRestore'; checkpointId: string }
  | { type: 'requestCommandDecision'; commandId: string; decision: 'allow' | 'reject' };

export function isTerminal(state: AgentState): boolean {
  return ['completed', 'failed', 'cancelled', 'blocked'].includes(state);
}

function applyEvent(state: UiState, event: RuntimeEvent): UiState {
  if (event.type === 'agent.started') {
    if (state.run?.id === event.runId) return state;
    return {
      ...state, busy: true, pendingStart: false, cancelPending: false, error: null,
      run: { id: event.runId, mode: event.mode, model: event.model, state: 'understanding', text: '', context: [], activity: [], omittedActivity: 0, edits: [], commands: [], plan: [] },
    };
  }
  const run = state.run;
  // A stopped run cannot be resurrected by a provider or tool result arriving late.
  if (!run || run.id !== event.runId) return state;
  if (isTerminal(run.state)) {
    const matchingFinalEvent = (run.state === 'failed' && event.type === 'agent.failed')
      || (run.state === 'cancelled' && event.type === 'agent.cancelled')
      || (run.state === 'completed' && event.type === 'agent.completed')
      || event.type === 'edits.resolved' || event.type === 'edits.restored'
      || event.type === 'command.completed' || event.type === 'agent.verification';
    if (!matchingFinalEvent) return state;
  }
  switch (event.type) {
    case 'review.updated':
      if (run.mode !== 'agent') return state;
      return { ...state, run: { ...run, reviews: [...(run.reviews ?? []).filter(review => review.role !== event.role), { role: event.role, state: event.state, text: event.text?.slice(0, 4000), error: event.error?.slice(0, 400) }] } };
    case 'edits.proposed': {
      if (!['edit', 'agent'].includes(run.mode) || run.edits.some(proposal => proposal.id === event.proposalId)) return state;
      return { ...state, run: { ...run, edits: [...run.edits, { id: event.proposalId, files: event.files.map(file => ({ ...file })), status: 'pending' }] } };
    }
    case 'edits.resolved': {
      const proposal = run.edits.find(item => item.id === event.proposalId);
      if (!proposal || proposal.status !== 'pending') return state;
      return { ...state, run: { ...run, verification: event.decision === 'applied' ? undefined : run.verification, edits: run.edits.map(item => item.id !== event.proposalId ? item : {
        ...item, status: event.decision, pendingDecision: undefined,
        checkpointId: event.decision === 'applied' || event.decision === 'conflicted' ? event.checkpointId : undefined,
      }) } };
    }
    case 'edits.restored':
      return { ...state, run: { ...run, edits: run.edits.map(item => item.checkpointId !== event.checkpointId || !['applied', 'conflicted'].includes(item.status) ? item : {
        ...item, status: 'restored', restorePending: false,
      }) } };
    case 'command.proposed':
      if (run.mode !== 'agent' || state.cancelPending || run.commands.some(command => command.id === event.commandId)) return state;
      return { ...state, run: { ...run, commands: [...run.commands, {
        id: event.commandId, command: { ...event.command, args: [...event.command.args] }, risk: event.risk, status: 'pending',
      }] } };
    case 'command.started': {
      const command = run.commands.find(item => item.id === event.commandId);
      if (run.mode !== 'agent' || !command || command.status !== 'pending') return state;
      return { ...state, run: { ...run, commands: run.commands.map(item => item.id !== event.commandId ? item : {
        ...item, status: 'running', pendingDecision: undefined,
      }) } };
    }
    case 'command.completed': {
      const command = run.commands.find(item => item.id === event.commandId);
      if (run.mode !== 'agent' || !command || command.status === 'completed') return state;
      return { ...state, run: { ...run, commands: run.commands.map(item => item.id !== event.commandId ? item : {
        ...item, status: 'completed', pendingDecision: undefined,
        result: { ...event.result, output: event.result.output.slice(0, MAX_COMMAND_OUTPUT_CHARACTERS) },
        displayTruncated: event.result.output.length > MAX_COMMAND_OUTPUT_CHARACTERS,
      }) } };
    }
    case 'agent.plan.updated':
      return run.mode !== 'agent' ? state : { ...state, run: { ...run, plan: event.steps.slice(0, 30).map(step => step.slice(0, 2048)) } };
    case 'agent.verification':
      return run.mode !== 'agent' ? state : { ...state, run: { ...run, verification: {
        status: event.status, checks: event.checks.map(check => ({ ...check })), outstandingEdits: event.outstandingEdits,
      } } };
    case 'agent.state.changed': {
      const terminal = isTerminal(event.state);
      return { ...state, busy: !terminal, cancelPending: terminal ? false : state.cancelPending, run: { ...run, state: event.state, providerWait: event.state === 'waiting_for_provider' ? run.providerWait : undefined } };
    }
    case 'agent.provider.wait':
      return { ...state, run: { ...run, providerWait: { until: event.until, message: event.message } } };
    case 'context.updated':
      return { ...state, run: { ...run, context: event.items } };
    case 'agent.text.delta':
      return { ...state, run: { ...run, text: (run.text + event.text).slice(0, MAX_RESPONSE_CHARACTERS) } };
    case 'tool.started': {
      if (run.activity.some(item => item.id === event.call.id)) return state;
      const next = [...run.activity, { id: event.call.id, name: (event.label ?? event.call.name).slice(0, 160), status: 'running' as const }];
      const removed = Math.max(0, next.length - MAX_ACTIVITY_ITEMS);
      return { ...state, run: { ...run, activity: next.slice(-MAX_ACTIVITY_ITEMS), omittedActivity: run.omittedActivity + removed } };
    }
    case 'tool.completed':
    case 'tool.failed': {
      const activity = run.activity.map(item => item.id !== event.callId ? item : {
        ...item,
        status: event.type === 'tool.completed' ? 'success' as const : 'failed' as const,
        summary: (event.type === 'tool.completed' ? event.summary : event.message).slice(0, 4096),
        errorCode: event.type === 'tool.failed' ? event.code : undefined,
      });
      return { ...state, run: { ...run, activity } };
    }
    case 'agent.completed':
    case 'agent.cancelled':
    case 'agent.failed': {
      const nextState = event.type === 'agent.completed' ? 'completed' : event.type === 'agent.cancelled' ? 'cancelled' : 'failed';
      const error = event.type === 'agent.failed' ? { code: event.code, message: event.message, retryAfterMs: event.retryAfterMs } : undefined;
      return { ...state, busy: false, pendingStart: false, cancelPending: false, cooldownUntil: event.type === 'agent.failed' && event.code === 'PROVIDER_RATE_LIMITED' && event.retryAfterMs ? Date.now() + Math.min(event.retryAfterMs, 86_400_000) : state.cooldownUntil, run: { ...run, state: nextState, error, providerWait: undefined,
        reviews: run.reviews?.map(review => ['queued', 'running'].includes(review.state) ? { ...review, state: nextState === 'cancelled' ? 'cancelled' : 'failed', error: 'Run ended before this review completed.' } : review),
        activity: run.activity.map(item => item.status === 'running' && nextState !== 'completed'
          ? { ...item, status: 'failed', summary: nextState === 'cancelled' ? 'Stopped with this run.' : 'Run ended before this tool completed.' }
          : item),
      } };
    }
    case 'agent.usage':
      return { ...state, run: { ...run, usage: { inputTokens: (run.usage?.inputTokens ?? 0) + event.inputTokens, outputTokens: (run.usage?.outputTokens ?? 0) + event.outputTokens, requests: (run.usage?.requests ?? 0) + 1 } } };
  }
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'snapshot': {
      let next: UiState = { ...initialState, configured: action.configured, models: action.models, selectedModel: action.selectedModel, workspace: action.workspace,
        discovery: action.discovery ?? 'idle', providerError: action.providerError,
        provider: action.provider ?? 'groq', endpoint: action.endpoint ?? initialState.endpoint,
        features: action.features ?? (action.workspace === state.workspace ? state.features : initialState.features),
        chatHistory: action.chatHistory ? structuredClone(action.chatHistory) : null,
        repository: action.repository?.workspace === action.workspace ? { ...action.repository } : action.workspace === state.workspace ? state.repository : null };
      for (const event of action.events) next = applyEvent(next, event);
      // A workspace snapshot cannot grant permission again while a host decision is in flight.
      if (next.run && next.run.id === state.run?.id) {
        const previous = state.run;
        next.run = { ...next.run, commands: next.run.commands.map(command => command.status !== 'pending' ? command : {
          ...command, pendingDecision: previous.commands.find(item => item.id === command.id && item.status === 'pending')?.pendingDecision,
        }) };
      }
      return { ...next, cooldownUntil: action.cooldownUntil ?? next.cooldownUntil, busy: action.busy, pendingStart: false, cancelPending: action.busy && state.cancelPending };
    }
    case 'repository':
      if (!state.workspace || action.status.workspace !== state.workspace || action.status.generation < (state.repository?.generation ?? 0)) return state;
      return { ...state, repository: { ...action.status }, repositoryPending: false };
    case 'chatHistory':
      if (!state.chatHistory || action.history.workspaceKey !== state.chatHistory.workspaceKey || action.history.revision < state.chatHistory.revision) return state;
      return { ...state, chatHistory: structuredClone(action.history), historyPending: false };
    case 'requestHistoryChange':
      return state.busy || state.historyPending ? state : { ...state, historyPending: true };
    case 'features':
      return action.workspace !== state.workspace ? state : { ...state, features: structuredClone(action.features) };
    case 'requestRepositoryRefresh':
      return !state.workspace || state.busy || state.repositoryPending || state.repository?.state === 'indexing' ? state : { ...state, repositoryPending: true };
    case 'event':
      return applyEvent(state, action.event);
    case 'error':
      return { ...state, error: { code: action.code, message: action.message, retryAfterMs: action.retryAfterMs }, busy: state.pendingStart ? false : state.busy, pendingStart: false, repositoryPending: false, historyPending: false,
        run: state.run ? { ...state.run,
          edits: state.run.edits.map(item => ({ ...item, pendingDecision: undefined, restorePending: false })),
          commands: state.run.commands.map(item => ({ ...item, pendingDecision: undefined })),
        } : null,
      };
    case 'requestStart':
      return { ...state, busy: true, pendingStart: true, cancelPending: false, run: null, error: null };
    case 'requestCancel':
      return state.busy ? { ...state, cancelPending: true } : state;
    case 'requestEditDecision':
      return !state.run || state.cancelPending || ['failed', 'cancelled', 'blocked'].includes(state.run.state) ? state : { ...state, run: { ...state.run,
        edits: state.run.edits.map(item => item.id !== action.proposalId || item.status !== 'pending' || item.pendingDecision ? item : { ...item, pendingDecision: action.decision }),
      } };
    case 'requestRestore':
      return !state.run || state.busy ? state : { ...state, run: { ...state.run,
        edits: state.run.edits.map(item => item.checkpointId !== action.checkpointId || !['applied', 'conflicted'].includes(item.status) ? item : { ...item, restorePending: true }),
      } };
    case 'requestCommandDecision':
      return !state.run || state.run.mode !== 'agent' || !state.busy || state.cancelPending || isTerminal(state.run.state) ? state : {
        ...state, run: { ...state.run, commands: state.run.commands.map(item => item.id !== action.commandId || item.status !== 'pending' || item.pendingDecision ? item : {
          ...item, pendingDecision: action.decision,
        }) },
      };
    case 'dismissError':
      return { ...state, error: null };
  }
}
