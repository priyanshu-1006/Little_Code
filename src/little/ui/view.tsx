import { useEffect, useReducer, useRef, useState } from 'react';
import type { AgentMode, AgentState } from '../shared/contracts';
import type { ClientMessage, HostMessage } from './protocol';
import type { ChatTurn } from '../history/chat-history';
import { MAX_PROMPT_CHARACTERS } from '../shared/limits';
import { initialState, isTerminal, uiReducer, type CommandView, type EditProposalView, type RunView, type UiState, type VerificationView } from './state';

const stateLabels: Record<AgentState, string> = {
  idle: 'Ready', understanding: 'Understanding', searching: 'Searching', planning: 'Planning',
  waiting_for_permission: 'Permission needed', waiting_for_provider: 'Waiting for provider', executing: 'Working', verifying: 'Checking results', repairing: 'Repairing', reviewing: 'Reviewing',
  completed: 'Complete', failed: 'Failed', cancelled: 'Stopped', blocked: 'Blocked',
};

function LittleMark({ active = false, logoUrl }: { active?: boolean; logoUrl?: string }) {
  if (logoUrl) return <img className={`little-mark supplied-logo${active ? ' is-active' : ''}`} src={logoUrl} alt="" />;
  return <svg className={`little-mark${active ? ' is-active' : ''}`} viewBox="0 0 40 40" aria-hidden="true">
    <defs><linearGradient id="little-node-gradient" x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--little-violet)" /><stop offset=".52" stopColor="var(--little-cyan)" /><stop offset="1" stopColor="var(--little-rose)" /></linearGradient></defs>
    <path d="M10 9h8v19h13v7H14a4 4 0 0 1-4-4Z" fill="currentColor" />
    <rect className="little-mark-node" x="25" y="6" width="10" height="10" rx="3" fill="url(#little-node-gradient)" />
  </svg>;
}

type IconName = 'settings' | 'folder' | 'arrow' | 'shield' | 'search' | 'plan' | 'refresh' | 'stop' | 'check' | 'edit' | 'terminal' | 'sun' | 'moon' | 'chat';
const iconPaths: Record<IconName, string> = {
  settings: 'M4 7h7m5 0h4M4 17h3m5 0h8M11 4v6m-4 4v6',
  folder: 'M3 9V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Zm0 1h18',
  arrow: 'M5 12h14m-5-5 5 5-5 5M4 5v2',
  shield: 'M12 3 4 6v6c0 4 3 7 8 9 5-2 8-5 8-9V6l-8-3Zm-4 9 3 3 5-6',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1 5 5 5M8 10h4m-2-2v4',
  plan: 'M4 3h5v5H4V3Zm11 13h5v5h-5v-5ZM6.5 8v8a2.5 2.5 0 0 0 2.5 2.5h6M12 5.5h7',
  refresh: 'M20 4v6h-6M4 20v-6h6M5 8a7.5 7.5 0 0 1 12-3l3 5M4 14l3 5a7.5 7.5 0 0 0 12-3',
  stop: 'M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z',
  check: 'm5 12 4 4L19 6M4 20h5',
  edit: 'm14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Zm9 0h7',
  terminal: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 5 3 3-3 3m7 0h3',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5ZM17 3v4m-2-2h4',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-1-2V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6',
};

const modeDetails: Record<AgentMode, { label: string; icon: IconName; hint: string; promptLabel: string; placeholder: string; submitLabel: string }> = {
  ask: { label: 'Ask', icon: 'search', hint: 'Explore & explain', promptLabel: 'Ask Little about this project', placeholder: 'Ask anything about your project…', submitLabel: 'Send question to Little' },
  plan: { label: 'Plan', icon: 'plan', hint: 'Inspect & prepare', promptLabel: 'Describe the change to plan', placeholder: 'Describe the change you have in mind…', submitLabel: 'Create implementation plan' },
  edit: { label: 'Edit', icon: 'edit', hint: 'Propose & review', promptLabel: 'Describe the changes to propose', placeholder: 'Describe a focused change to review…', submitLabel: 'Propose changes for review' },
  agent: { label: 'Agent', icon: 'terminal', hint: 'Approve & verify', promptLabel: 'Describe the task and checks for Little Agent', placeholder: 'Describe a task and the checks to run…', submitLabel: 'Start a supervised Agent run' },
};

function Icon({ name }: { name: IconName }) {
  return <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

const chatStatusLabels = { running: 'In progress', completed: 'Complete', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' };

export function SavedTurn({ turn }: { turn: ChatTurn }) {
  return <article className={`chat-turn chat-${turn.status}`} aria-label="Saved conversation turn" data-chat-turn={turn.id}>
    <div className="chat-turn-meta"><span>{modeDetails[turn.mode].label} · {turn.provider === 'ollama' ? 'Ollama' : 'Groq'}</span><time dateTime={new Date(turn.createdAt).toISOString()}>{new Date(turn.createdAt).toLocaleString()}</time><span className="badge">{chatStatusLabels[turn.status]}</span></div>
    <section className="chat-prompt" aria-label="Saved question"><span className="section-label">You</span><p>{turn.prompt}</p></section>
    <section className="saved-answer" aria-label="Saved Little response"><div className="section-label"><span>Little</span><span title={turn.model}>{turn.model}</span></div>{turn.answer ? <div className="saved-answer-text">{turn.answer}</div> : <p className="muted small">No text response was saved.</p>}</section>
    {turn.status === 'interrupted' && <p className="chat-turn-note">This run ended before it finished. No actions were resumed.</p>}
    {turn.truncated && <p className="chat-turn-note">The stored preview was shortened to keep local history bounded.</p>}
  </article>;
}

function Activity({ run }: { run: RunView }) {
  if (!run.activity.length) return null;
  return <section className="activity" aria-label="Repository activity">
    <div className="section-label">Activity <span>{run.activity.length} shown</span></div>
    {run.omittedActivity > 0 && <p className="muted small">{run.omittedActivity} earlier actions are hidden.</p>}
    <ol className="tool-list">{run.activity.map(tool => <li className={`tool-card tool-${tool.status}`} key={tool.id}>
      <div className="tool-heading"><span className="tool-state" aria-hidden="true">{tool.status === 'success' ? '✓' : tool.status === 'failed' ? '!' : '◌'}</span><span className="tool-name">{tool.name.replaceAll('_', ' ')}</span><span className="badge">{tool.status === 'running' ? 'Running' : tool.status === 'success' ? 'Done' : 'Failed'}</span></div>
      {tool.summary && <p className="tool-summary">{tool.summary}</p>}
      {tool.errorCode && <span className="error-code">{tool.errorCode}</span>}
    </li>)}</ol>
  </section>;
}

function EditProposal({ proposal, busy, cancelPending, runState, onReview, onDecision, onRestore }: {
  proposal: EditProposalView;
  busy: boolean;
  cancelPending: boolean;
  runState: AgentState;
  onReview: (proposalId: string) => void;
  onDecision: (proposalId: string, decision: 'accept' | 'reject') => void;
  onRestore: (checkpointId: string) => void;
}) {
  const pending = proposal.status === 'pending';
  const waiting = !!proposal.pendingDecision;
  const checkpointId = proposal.checkpointId;
  const ended = ['failed', 'cancelled', 'blocked'].includes(runState);
  const decisionsDisabled = waiting || cancelPending || ended;
  const labels = { pending: 'Proposed changes', applied: 'Changes applied', rejected: 'Proposal rejected', conflicted: 'Review needs attention', restored: 'Changes restored' };
  const guidance = waiting ? 'Confirming your choice with the editor host…'
    : cancelPending && pending ? 'Stopping this run. Waiting for the host to resolve this proposal.'
    : ended && pending ? 'This run ended. Waiting for the host to resolve this proposal.'
    : pending ? 'Review the native diff, then accept or reject these changes. Files stay unchanged until you accept.'
    : proposal.status === 'applied' ? proposal.checkpointId ? 'A checkpoint was saved before applying. You can restore these changes after this run finishes.' : 'The editor host confirmed these changes were applied.'
    : proposal.status === 'rejected' ? 'No changes from this proposal were applied.'
    : proposal.status === 'conflicted' ? checkpointId ? 'The editor host could not apply this proposal safely. Its checkpoint is available for recovery; later file changes are preserved.' : 'This proposal could not be applied safely. Review your workspace and request a new proposal.'
    : 'The editor host confirmed this checkpoint was restored.';
  return <section className={`edit-proposal edit-${proposal.status}`} aria-label={labels[proposal.status]} aria-busy={waiting || !!proposal.restorePending}>
    <div className="section-label"><span>{labels[proposal.status]}</span><span>{proposal.files.length} {proposal.files.length === 1 ? 'file' : 'files'}</span></div>
    <p className="edit-guidance" role="status">{guidance}</p>
    <ul className="edit-files">{proposal.files.map(file => <li key={file.path}><Icon name={file.kind === 'create' ? 'folder' : 'edit'} /><span title={file.path}>{file.path}</span><small>{file.kind === 'create' ? 'Create' : file.kind === 'delete' ? 'Delete' : 'Edit'}</small></li>)}</ul>
    {pending && <div className="edit-actions"><button className="secondary-button review-button" disabled={decisionsDisabled} onClick={() => onReview(proposal.id)}>Review diff <Icon name="arrow" /></button><div className="edit-decision"><button className="primary-button" disabled={decisionsDisabled} onClick={() => onDecision(proposal.id, 'accept')}>Accept changes</button><button className="secondary-button" disabled={decisionsDisabled} onClick={() => onDecision(proposal.id, 'reject')}>Reject</button></div></div>}
    {['applied', 'conflicted'].includes(proposal.status) && checkpointId && <div className="checkpoint-controls"><span className="checkpoint-label"><Icon name="shield" />{proposal.status === 'conflicted' ? 'Recovery checkpoint' : 'Checkpoint saved'}</span><button className="secondary-button" disabled={busy || !!proposal.restorePending} onClick={() => onRestore(checkpointId)}>{proposal.restorePending ? 'Restoring…' : proposal.status === 'conflicted' ? 'Restore checkpoint' : 'Restore changes'}</button></div>}
  </section>;
}

function CommandApproval({ command, busy, cancelPending, runState, onDecision }: {
  command: CommandView;
  busy: boolean;
  cancelPending: boolean;
  runState: AgentState;
  onDecision: (commandId: string, decision: 'allow' | 'reject') => void;
}) {
  const waiting = !!command.pendingDecision;
  const disabled = !busy || waiting || cancelPending || isTerminal(runState);
  const result = command.result;
  const success = result?.status === 'exited' && result.exitCode === 0;
  const resultLabels = { exited: success ? 'Command exited successfully' : 'Command exited with error', rejected: 'Command rejected', cancelled: 'Command stopped', timed_out: 'Command timed out', output_limit: 'Output limit reached', failed: 'Command failed' };
  const label = result ? resultLabels[result.status] : command.status === 'running' ? cancelPending ? 'Stopping command' : 'Running approved command' : 'Command permission';
  const guidance = waiting ? 'Waiting for the host to confirm your choice…'
    : cancelPending || isTerminal(runState) ? 'This run is stopping or has ended. Waiting for the host’s command result.'
    : command.status === 'running' ? 'The host started this command. Its result will appear here.'
    : 'Allow once runs this exact command with your current user permissions. It can change files; no OS sandbox is applied. Proposed file edits still need diff approval.';
  return <section className={`command-card command-${command.status}${result ? success ? ' command-success' : ' command-attention' : ''}`} aria-label={label} aria-busy={waiting || command.status === 'running'}>
    <div className="section-label"><span>{label}</span><span className={`risk-badge risk-${command.risk.toLowerCase()}`}>{command.risk.replaceAll('_', ' ')}</span></div>
    <p className="command-purpose">{command.command.purpose}</p>
    <div className="command-tokens" aria-label="Exact program and arguments"><code className="command-program">{command.command.program}</code>{command.command.args.map((argument, index) => <code className="command-argument" key={index}>{JSON.stringify(argument)}</code>)}</div>
    <div className="command-meta"><span>Directory <code>{command.command.cwd}</code></span><span>{Math.ceil(command.command.timeoutMs / 1000)}s limit</span></div>
    {!result && <p className="command-guidance" role="status">{guidance}</p>}
    {command.status === 'pending' && <div className="command-decisions"><button className="primary-button" disabled={disabled} onClick={() => onDecision(command.id, 'allow')}>Allow once</button><button className="secondary-button" disabled={disabled} onClick={() => onDecision(command.id, 'reject')}>Reject</button></div>}
    {result && <><p className="command-result-meta">{result.exitCode === null ? 'No exit code reported' : `Exit ${result.exitCode}`} · {(Math.max(0, result.durationMs) / 1000).toFixed(1)}s</p>{result.output ? <details className="command-output"><summary>Show command output</summary><pre>{result.output}</pre></details> : <p className="muted small">No command output received.</p>}{result.truncated && <p className="command-output-note">The host truncated command output.</p>}{command.displayTruncated && <p className="command-output-note">Output was shortened for display.</p>}</>}
  </section>;
}

function Verification({ verification }: { verification: VerificationView }) {
  const labels = { passed: 'Approved checks passed', failed: 'Checks need attention', not_run: 'Checks not run' };
  return <section className={`verification-card verification-${verification.status}`} aria-label="Command verification">
    <div className="section-label"><span>{labels[verification.status]}</span><span>{verification.checks.length} {verification.checks.length === 1 ? 'check' : 'checks'}</span></div>
    <p className="muted small">Results reflect approved command exits.</p>
    {!!verification.checks.length && <ul className="verification-checks">{verification.checks.map((check, index) => <li key={index}><span className={check.passed ? 'check-passed' : 'check-failed'}>{check.passed ? '✓' : '!'}</span><div><code>{check.command}</code><small>{check.status.replaceAll('_', ' ')} · {check.exitCode === null ? 'no exit code' : `exit ${check.exitCode}`} · {(Math.max(0, check.durationMs) / 1000).toFixed(1)}s</small></div></li>)}</ul>}
    {verification.outstandingEdits && <p className="verification-outstanding">Applied changes still need current verification.</p>}
  </section>;
}

export function ProjectSettings({ state, send }: { state: UiState; send: (message: ClientMessage) => void }) {
  const local = state.provider === 'ollama';
  const disabled = state.busy || !state.workspace;
  return <section className="project-settings" aria-label="Little settings">
    <div className="section-label">Your workspace, your way <span>Settings</span></div>
    <div className="provider-choice" role="group" aria-label="AI provider">{(['groq', 'ollama'] as const).map(provider => <button key={provider} disabled={state.busy} aria-pressed={state.provider === provider} onClick={() => send({ type: 'selectProvider', provider })}>{provider === 'groq' ? 'Groq Cloud' : 'Ollama · local'}</button>)}</div>
    <p className="muted small">{local ? 'Connect an already-running local Ollama runtime. Little discovers installed models; it does not download models.' : 'Your Groq API key stays in encrypted system storage. Prompts and selected context are sent to Groq Cloud.'}</p>
    {local && <code className="settings-endpoint">{state.endpoint}</code>}
    <div className="button-row">{local ? <button className="secondary-button" disabled={state.busy} onClick={() => send({ type: 'configureOllama' })}>Configure Ollama</button> : <><button className="secondary-button" disabled={state.busy} onClick={() => send({ type: 'configure' })}>{state.configured ? 'Replace key' : 'Connect Groq'}</button>{state.configured && <button className="text-button" disabled={state.busy} onClick={() => send({ type: 'removeKey' })}>Remove key</button>}</>}<button className="text-button" disabled={state.busy || state.discovery === 'loading' || (!local && !state.configured)} onClick={() => send({ type: 'refreshModels' })}>{state.discovery === 'loading' ? 'Loading models…' : 'Discover models'}</button></div>
    <p className="provider-discovery-status muted small" role="status">{state.discovery === 'loading' ? 'Fetching compatible models from your provider…' : state.providerError ? state.providerError.message : state.discovery === 'ready' ? `${state.models.length} compatible ${local ? 'local' : 'chat'} models loaded.` : 'Discover models after connecting.'}</p>
    <details className="feature-details" open><summary>Project memory <span>{state.features.memory.entries.length} notes</span></summary>
      <p className="muted small">Save conventions, reviewed facts with source files, and labelled inferences. Relevant notes join future context; they cannot grant tool permissions.</p>
      <div className="button-row"><button className="secondary-button" disabled={disabled} onClick={() => send({ type: 'addMemory' })}>Add note</button><button className="text-button" disabled={state.busy} onClick={() => send({ type: 'configurePreferences' })}>Personal preferences</button></div>
      {state.features.memory.error && <p className="feature-error" role="status">{state.features.memory.error}</p>}
      {state.features.memory.entries.map(note => <article className="memory-note" key={note.id}><div className="feature-heading"><strong>{note.title}</strong><span className={`badge memory-${note.kind}`}>{note.kind === 'user' ? 'Convention' : note.kind === 'fact' ? 'Reviewed fact' : 'Inference'}</span></div><p>{note.content}</p>{note.source && <small>Source: {note.source}</small>}<div className="button-row"><button className="text-button" disabled={disabled} onClick={() => send({ type: 'editMemory', id: note.id })}>Edit note</button><button className="text-button" disabled={disabled} onClick={() => send({ type: 'removeMemory', id: note.id })}>Delete note</button></div></article>)}
    </details>
    <details className="feature-details" open><summary>MCP integrations <span>{state.features.mcp.length} servers</span></summary>
      <p className="muted small">Connect local Streamable HTTP servers. Agent requests need inspection, a plan, and approval for every MCP call.</p>
      <button className="secondary-button" disabled={disabled} onClick={() => send({ type: 'addMcpServer' })}>Add MCP server</button>
      {state.features.mcp.map(server => <article className="mcp-server" key={server.id}><div className="feature-heading"><strong>{server.name}</strong><span className={`badge mcp-${server.state}`}>{server.state}</span></div><code className="settings-endpoint">{server.url}</code><small>{server.tools} discovered tools · up to 16 exposed per run</small>{server.message && <p className="feature-error">{server.message}</p>}<div className="button-row"><button className="text-button" disabled={disabled || server.state === 'connecting'} onClick={() => send({ type: server.state === 'connected' ? 'disconnectMcpServer' : 'connectMcpServer', id: server.id })}>{server.state === 'connected' ? 'Disconnect' : server.state === 'connecting' ? 'Connecting…' : 'Connect'}</button><button className="text-button" disabled={disabled || server.state === 'connecting'} onClick={() => send({ type: 'removeMcpServer', id: server.id })}>Remove server</button></div></article>)}
    </details>
    <details className="feature-details"><summary>Local browser preview <span>Inspect & capture</span></summary><p className="muted small">Inspect a locally served app through a running isolated Chrome/Edge debug endpoint. Little uses its own temporary tab. Native approval is required; screenshots stay in the editor.</p><div className="button-row"><button className="secondary-button" disabled={state.busy} onClick={() => send({ type: 'configureBrowser' })}>Configure browser</button><button className="text-button" disabled={disabled} onClick={() => send({ type: 'inspectBrowser' })}>Inspect local app</button></div></details>
  </section>;
}

export function App({ send, initialViewState = initialState, logoUrl = typeof document === 'undefined' ? undefined : document.getElementById('root')?.dataset.logo }: { send: (message: ClientMessage) => void; initialViewState?: UiState; logoUrl?: string }) {
  const [state, dispatch] = useReducer(uiReducer, initialViewState);
  const [mode, setMode] = useState<AgentMode>(initialViewState.run?.mode ?? 'ask');
  const [prompt, setPrompt] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lightAppearance, setLightAppearance] = useState(() => typeof document !== 'undefined' && (document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')));
  const [now, setNow] = useState(Date.now);
  const lastRequest = useRef<{ prompt: string; mode: AgentMode } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activityEnd = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const commandDecisionsInFlight = useRef(new Set<string>());

  useEffect(() => {
    const update = () => setLightAppearance(document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setNow(Date.now());
    const until = Math.max(state.cooldownUntil, state.providerError?.retryAt ?? 0, state.run?.providerWait?.until ?? 0);
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.cooldownUntil, state.providerError?.retryAt, state.run?.providerWait?.until]);

  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (event.data && ['snapshot', 'event', 'error', 'repository', 'features', 'chatHistory'].includes(event.data.type)) dispatch(event.data);
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [send]);

  useEffect(() => {
    if (state.configured && !state.busy) composer.current?.focus();
  }, [state.configured, state.busy]);

  useEffect(() => {
    if (state.busy && !state.pendingStart && state.run) setMode(state.run.mode);
  }, [state.busy, state.pendingStart, state.run?.mode]);

  useEffect(() => {
    if (state.run && followOutput.current) activityEnd.current?.scrollIntoView({ block: 'end' });
  }, [state.run?.text, state.run?.activity.length, state.run?.edits, state.run?.commands, state.run?.plan, state.run?.verification]);

  useEffect(() => {
    for (const id of commandDecisionsInFlight.current) {
      if (!state.run?.commands.some(command => command.id === id && command.pendingDecision)) commandDecisionsInFlight.current.delete(id);
    }
  }, [state.run?.commands]);

  const hasModel = state.models.some(model => model.id === state.selectedModel);
  const cooldownSeconds = Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000));
  const canStart = state.configured && !!state.workspace && hasModel && !!prompt.trim() && !state.busy && !state.historyPending && state.discovery !== 'loading' && cooldownSeconds === 0;
  const selectedChat = state.chatHistory?.sessions.find(chat => chat.id === state.chatHistory?.selectedId);
  const activeTurn = selectedChat?.turns.find(turn => turn.id === state.chatHistory?.activeTurnId);
  const savedTurns = selectedChat?.turns.filter(turn => turn.id !== state.chatHistory?.activeTurnId) ?? [];
  const historyDisabled = state.busy || state.historyPending || !state.workspace || !state.chatHistory;
  const error = state.error ?? state.providerError ?? state.run?.error;
  const pendingProposal = state.run && !['failed', 'cancelled', 'blocked'].includes(state.run.state) ? state.run.edits.find(proposal => proposal.status === 'pending') : undefined;
  const pendingCommand = state.run && !isTerminal(state.run.state) ? state.run.commands.find(command => command.status === 'pending') : undefined;
  const status = state.pendingStart ? 'Starting' : state.cancelPending ? 'Stopping' : pendingCommand ? pendingCommand.pendingDecision ? 'Confirming permission' : 'Permission needed' : pendingProposal ? pendingProposal.pendingDecision ? 'Confirming choice' : 'Review needed' : state.run ? stateLabels[state.run.state] : 'Ready';
  const details = modeDetails[mode];
  const activeMode = state.busy && !state.pendingStart ? state.run?.mode ?? mode : mode;
  const controlledEdit = activeMode === 'edit' || activeMode === 'agent';
  const submit = () => {
    if (!canStart) return;
    lastRequest.current = { prompt: prompt.trim(), mode };
    dispatch({ type: 'requestStart' });
    send({ type: 'start', prompt: prompt.trim(), mode });
    setPrompt('');
    followOutput.current = true;
  };
  const cancel = () => { dispatch({ type: 'requestCancel' }); send({ type: 'cancel' }); };
  const changeChat = (message: Extract<ClientMessage, { type: 'newChat' | 'selectChat' | 'clearChatHistory' }>) => {
    if (historyDisabled) return;
    dispatch({ type: 'requestHistoryChange' }); send(message);
    setPrompt(''); lastRequest.current = null; setSettingsOpen(false); followOutput.current = true;
  };
  const decideEdits = (proposalId: string, decision: 'accept' | 'reject') => {
    dispatch({ type: 'requestEditDecision', proposalId, decision });
    send({ type: 'decideEdits', proposalId, decision });
  };
  const restoreEdits = (checkpointId: string) => {
    dispatch({ type: 'requestRestore', checkpointId });
    send({ type: 'restoreCheckpoint', checkpointId });
  };
  const decideCommand = (commandId: string, decision: 'allow' | 'reject') => {
    const command = state.run?.commands.find(item => item.id === commandId);
    if (state.run?.mode !== 'agent' || !state.busy || state.cancelPending || isTerminal(state.run.state) || command?.status !== 'pending' || command.pendingDecision || commandDecisionsInFlight.current.has(commandId)) return;
    commandDecisionsInFlight.current.add(commandId);
    dispatch({ type: 'requestCommandDecision', commandId, decision });
    send({ type: 'decideCommand', commandId, decision });
  };
  const useSuggestion = (nextMode: AgentMode, text: string) => {
    setMode(nextMode);
    setPrompt(text);
    composer.current?.focus();
  };
  const local = state.provider === 'ollama';
  const providerName = local ? 'Ollama' : 'Groq';
  const configureProvider = () => send({ type: local ? 'configureOllama' : 'configure' });
  const openSettings = () => { setSettingsOpen(true); followOutput.current = false; scrollArea.current?.scrollTo({ top: 0 }); };
  const refreshRepository = () => {
    if (!state.workspace || state.busy || state.repositoryPending || state.repository?.state === 'indexing') return;
    dispatch({ type: 'requestRepositoryRefresh' });
    send({ type: 'refreshRepository' });
  };

  return <main className="agent-shell" data-appearance={lightAppearance ? 'light' : 'dark'}>
    <header className="agent-header">
      <div className="brand"><span className="brand-mark"><LittleMark active={state.busy} logoUrl={logoUrl} /></span><div><h1>Little Agent</h1><p>Your idea, in motion.</p></div></div>
      <div className="header-actions"><button className="icon-button appearance-toggle" aria-label={lightAppearance ? 'Switch to dark appearance' : 'Switch to light appearance'} title={lightAppearance ? 'Dark appearance' : 'Light appearance'} onClick={() => send({ type: 'toggleAppearance' })}><Icon name={lightAppearance ? 'moon' : 'sun'} /></button><button className="icon-button" aria-label="Little settings" aria-expanded={settingsOpen} onClick={() => settingsOpen ? setSettingsOpen(false) : openSettings()}><Icon name="settings" /></button></div>
    </header>
    <nav className="agent-navigation" aria-label="Little workspace"><button className="agent-tab" aria-pressed={!settingsOpen} onClick={() => setSettingsOpen(false)}><Icon name="chat" />Conversation</button><button className="agent-tab" aria-pressed={settingsOpen} onClick={openSettings}><Icon name="settings" />Workspace</button><span className={`connection-pill${state.configured ? ' connected' : ''}`} title={state.configured ? state.provider === 'ollama' ? 'Ollama endpoint configured' : 'Groq key saved' : 'Connect a provider to start'}><span className="provider-dot" />{state.provider === 'ollama' ? 'Local' : 'Cloud'}</span></nav>
    <div className={`agent-status ${state.run?.state ?? 'idle'}${pendingProposal || pendingCommand ? ' awaiting-review' : ''}`} role="status" aria-live="polite"><span className={`status-node${state.busy && !pendingProposal && !pendingCommand ? ' active' : ''}`} aria-hidden="true" /><span>{status}</span><span className="read-only-label">{activeMode === 'agent' ? 'Review & approve' : controlledEdit ? 'Review before apply' : 'Read only'}</span></div>

    {state.workspace && <section className="chat-history-bar" aria-label="Saved chats" aria-busy={state.historyPending}>
      <div className="chat-history-controls"><label className="sr-only" htmlFor="little-chat">Saved chats for this project</label><select id="little-chat" value={state.chatHistory?.selectedId ?? ''} disabled={historyDisabled || !state.chatHistory?.sessions.length} onChange={event => changeChat({ type: 'selectChat', id: event.target.value })}><option value="">New conversation</option>{state.chatHistory?.sessions.map(chat => <option value={chat.id} key={chat.id}>{chat.title} · {chat.turns.length} {chat.turns.length === 1 ? 'turn' : 'turns'}</option>)}</select><button className="text-button new-chat-button" disabled={historyDisabled} onClick={() => changeChat({ type: 'newChat' })}>New chat</button><button className="icon-button clear-chat-button" aria-label="Clear saved chats for this project" title="Clear saved chats" disabled={historyDisabled || !state.chatHistory?.sessions.length} onClick={() => changeChat({ type: 'clearChatHistory' })}>×</button></div>
      <p className="chat-save-status" role="status">{state.historyPending ? 'Updating saved chats…' : state.chatHistory?.notice ?? (activeTurn?.status === 'running' ? 'Saving this run locally…' : state.chatHistory ? 'Chats are saved locally for this project.' : 'Loading saved chats…')}</p>
    </section>}

    <div className="conversation" ref={scrollArea} onScroll={() => { const area = scrollArea.current; if (area) followOutput.current = area.scrollHeight - area.scrollTop - area.clientHeight < 64; }}>
      {settingsOpen && <ProjectSettings state={state} send={send} />}
      {state.workspace && <section className={`repository-card repository-${state.repository?.state ?? 'idle'}`} aria-label="Project intelligence" data-repository-state={state.repository?.state ?? 'idle'} data-repository-generation={state.repository?.generation ?? 0} data-repository-files={state.repository?.files ?? 0} data-repository-symbols={state.repository?.symbols ?? 0} data-repository-reused={state.repository?.reused ?? 0}>
        <div className="section-label"><span><Icon name="folder" /> Project intelligence</span><button className="icon-button" aria-label="Refresh project index" disabled={state.busy || state.repositoryPending || state.repository?.state === 'indexing'} onClick={refreshRepository}><Icon name="refresh" /></button></div>
        <p role="status">{state.repositoryPending ? 'Requesting a fresh project index…' : state.repository?.state === 'indexing' ? `Indexing ${(state.repository.processed + state.repository.reused).toLocaleString()} of ${state.repository.files.toLocaleString()} files…` : state.repository?.state === 'ready' ? `${state.repository.files.toLocaleString()} files · ${state.repository.symbols.toLocaleString()} symbols` : state.repository?.state === 'failed' ? 'Project index needs attention' : 'Local project index is waiting'}</p>
        <small>{state.repository?.message ?? (state.repository?.truncated ? 'Limited map: some files or source details were omitted.' : state.repository?.state === 'ready' ? `Local map ready · ${state.repository.reused.toLocaleString()} unchanged files reused` : 'Runs locally. No AI connection is needed.')}</small>
        <div className="button-row"><button className="text-button" disabled={state.busy} onClick={() => send({ type: 'reviewGit' })}>Review Git changes</button><button className="text-button" disabled={state.busy} onClick={() => send({ type: 'browseCheckpoints' })}>Saved checkpoints</button><button className="text-button" disabled={state.busy || !state.configured} onClick={() => useSuggestion('agent', 'Use delegate_reviews to get read-only architecture and verification reviews of this project. Inspect relevant source first, then compare both perspectives and clearly separate suggested checks from checks actually executed.')}>Compare reviews</button></div>
      </section>}
      {!state.configured ? <section className="welcome-card">
        <span className="eyebrow"><span className="eyebrow-node" />YOUR NEXT IDEA STARTS HERE</span><h2>Understand your code.<br /><span>Find your next move.</span></h2><p>A little context. A clearer plan. {local ? 'Discover a local Ollama model and put your project in perspective.' : 'Connect Groq and put your project in perspective.'}</p>
        <div className="setup-checklist"><div className={state.workspace ? 'setup-item done' : 'setup-item'}><span className="setup-item-icon"><Icon name={state.workspace ? 'check' : 'folder'} /></span><span><strong>{state.workspace || 'Bring your project'}</strong><small>{state.workspace ? 'Workspace context is ready' : 'Open a folder to give Little context'}</small></span></div><div className="setup-item"><span className="setup-item-icon"><Icon name="plan" /></span><span><strong>Choose how to work</strong><small>Ask, plan, edit, or approve Agent actions</small></span></div></div>
        <button className="primary-button" onClick={configureProvider}>Connect {providerName} <Icon name="arrow" /></button>
        <p className="privacy-note"><Icon name="shield" /><span>{local ? 'Prompts and selected context go to your configured loopback runtime.' : 'Prompts and selected repository context are sent to Groq Cloud.'}</span></p>
      </section> : !state.run && !selectedChat?.turns.length && <section className="empty-card"><span className="eyebrow"><span className="eyebrow-node" />A CLEAR START</span><h2>{!state.workspace ? <>Pick a project.<br /><span>Find your flow.</span></> : !hasModel ? <>Choose your model.<br /><span>Make it yours.</span></> : <>What are we<br /><span>building next?</span></>}</h2><p>{!state.workspace ? 'Open a project and Little will explore the code with you.' : !hasModel ? `Select a discovered ${providerName} model in the composer below. Your model, your project, your next idea.` : 'Find the important files. Trace a feature. Turn a rough idea into an informed plan.'}</p>{!state.workspace && <button className="primary-button" onClick={() => send({ type: 'openProject' })}>Open project <Icon name="folder" /></button>}{state.workspace && !state.models.length && <button className="secondary-button" onClick={() => send({ type: 'refreshModels' })}>Discover models <Icon name="refresh" /></button>}{state.workspace && hasModel && <div className="suggestion-list"><button onClick={() => useSuggestion('ask', 'Explain this project’s architecture and the main entry points. Cite the relevant files.')}><span className="suggestion-icon"><Icon name="search" /></span><span><strong>Understand this project</strong><small>Map the important files and decisions</small></span><Icon name="arrow" /></button><button onClick={() => useSuggestion('ask', 'Trace how this project’s main feature works across files. Inspect the entry points and important layers, and cite the relevant code.')}><span className="suggestion-icon"><Icon name="folder" /></span><span><strong>Follow the code</strong><small>Connect the pieces across your project</small></span><Icon name="arrow" /></button><button onClick={() => useSuggestion('plan', 'Prepare a plan to improve this project’s reliability. Inspect the current architecture and testing setup first.')}><span className="suggestion-icon"><Icon name="plan" /></span><span><strong>Plan the next improvement</strong><small>Investigate first. Shape a clear next step.</small></span><Icon name="arrow" /></button></div>}</section>}
      {!!savedTurns.length && <section className="saved-conversation" aria-label="Saved conversation"><div className="section-label"><span>Conversation history</span><span>Read only</span></div>{savedTurns.map(turn => <SavedTurn key={turn.id} turn={turn} />)}<p className="chat-context-note">Recent completed turns may be included in context. Saved cards cannot execute actions.</p></section>}
      {activeTurn && <section className="chat-prompt current-chat-prompt" aria-label="Current question"><div className="section-label"><span>You</span><span>{modeDetails[activeTurn.mode].label}</span></div><p>{activeTurn.prompt}</p></section>}
      {error && <section className="error-card" role="alert"><div className="error-title">{error.code === 'PROVIDER_RATE_LIMITED' ? 'Provider cooldown' : 'Request needs attention'} {state.error && <button className="icon-button" aria-label="Dismiss error" onClick={() => dispatch({ type: 'dismissError' })}>×</button>}</div><p>{error.message}</p>{cooldownSeconds > 0 && <p role="status">This model can be retried in {cooldownSeconds}s. You can choose another loaded chat model.</p>}<div className="error-actions"><span className="error-code">{error.code}</span><button className="text-button" onClick={openSettings}>Little settings</button>{(error.code === 'MODEL_UNAVAILABLE' || state.discovery === 'failed') && <button className="text-button" disabled={state.busy || state.discovery === 'loading' || (state.providerError?.retryAt ?? 0) > now} onClick={() => send({ type: 'refreshModels' })}>Refresh models</button>}{lastRequest.current && !state.busy && <button className="text-button" onClick={() => { const previous = lastRequest.current; if (previous) { setMode(previous.mode); setPrompt(previous.prompt); composer.current?.focus(); } }}>Prepare retry</button>}{!state.configured && <button className="text-button" onClick={configureProvider}>Configure {providerName}</button>}</div></section>}
      {state.run && <>
        {state.run.providerWait && <p className="run-notice" role="status">{state.run.providerWait.message} {Math.max(0, Math.ceil((state.run.providerWait.until - now) / 1000))}s remaining. Stop is available.</p>}
        {state.run.usage && <section className="usage-card" aria-label="Main run token usage"><div className="section-label">Reported usage <span>{state.run.usage.requests} responses</span></div><div className="usage-totals"><span>Input <strong>{state.run.usage.inputTokens.toLocaleString()}</strong></span><span>Output <strong>{state.run.usage.outputTokens.toLocaleString()}</strong></span><span>Total <strong>{(state.run.usage.inputTokens + state.run.usage.outputTokens).toLocaleString()}</strong></span></div><p className="muted small">Provider-reported tokens for the main run. Independent reviews have separate usage; cost depends on your account.</p></section>}
        <section className="context-section" aria-label="Included context"><div className="section-label"><span>Context</span><span>Included in this run</span></div><div className="context-chips">{state.run.context.map(item => <span className="context-chip" title={`${item.reason ? `${item.reason} · ` : ''}${item.estimatedTokens.toLocaleString()} estimated tokens`} key={item.id}>@{item.label}<span>{item.estimatedTokens.toLocaleString()} tokens</span>{item.reason && <small className="context-reason">{item.reason}</small>}</span>)}</div>{!state.run.context.length && <p className="muted small">Gathering relevant workspace context…</p>}</section>
        {!!state.run.plan.length && <section className="agent-plan" aria-label="Agent plan"><div className="section-label"><span>Plan for this run</span><span>{state.run.plan.length} steps</span></div><ol>{state.run.plan.map((step, index) => <li key={index}>{step}</li>)}</ol></section>}
        <Activity run={state.run} />
        {!!state.run.reviews?.length && <section className="review-team" aria-label="Parallel reviews"><div className="section-label">Two perspectives <span>Read only</span></div>{state.run.reviews.map(review => <article className="memory-note" key={review.role}><div className="feature-heading"><strong>{review.role === 'architecture' ? 'Architecture reviewer' : 'Verification reviewer'}</strong><span className="badge">{review.state}</span></div>{review.text && <p>{review.text}</p>}{review.error && <p className="feature-error">{review.error}</p>}</article>)}</section>}
        {state.run.text && <section className={`response-card ${state.run.mode === 'plan' ? 'plan-card' : ''}`} aria-label={state.run.mode === 'plan' ? 'Implementation plan' : 'Little response'}><div className="section-label"><span>{state.run.mode === 'plan' ? 'Implementation plan' : 'Little'}</span>{state.run.state === 'completed' && <span className="complete-label">✓ Complete</span>}</div><div className="response-text">{state.run.text}</div></section>}
        {state.run.edits.map(proposal => <EditProposal key={proposal.id} proposal={proposal} busy={state.busy} cancelPending={state.cancelPending} runState={state.run?.state ?? 'idle'} onReview={proposalId => send({ type: 'reviewEdits', proposalId })} onDecision={decideEdits} onRestore={restoreEdits} />)}
        {state.run.mode === 'agent' && state.run.commands.map(command => <CommandApproval key={command.id} command={command} busy={state.busy} cancelPending={state.cancelPending} runState={state.run?.state ?? 'idle'} onDecision={decideCommand} />)}
        {state.run.verification && <Verification verification={state.run.verification} />}
        {state.run.state === 'cancelled' && <p className="run-notice" role="status">Stopped. The response above remains available.</p>}
        {state.run.state === 'completed' && !state.run.text && <p className="run-notice">Run finished without a text response.</p>}
      </>}
      <div ref={activityEnd} />
    </div>

    <footer className="composer-area">
      {!state.workspace && <button className="workspace-notice" disabled={state.busy} onClick={() => send({ type: 'openProject' })}><Icon name="folder" /><span>Open a project</span><Icon name="arrow" /></button>}
      <div className="mode-picker" role="group" aria-label="Little mode">{(['ask', 'plan', 'edit', 'agent'] as const).map(item => <button key={item} disabled={state.busy} aria-pressed={mode === item} onClick={() => setMode(item)}>{modeDetails[item].label}<Icon name={modeDetails[item].icon} /></button>)}<span>{details.hint}</span></div>
      <form className="composer" onSubmit={event => { event.preventDefault(); submit(); }}>
        <label className="sr-only" htmlFor="little-prompt">{details.promptLabel}</label>
        <textarea id="little-prompt" ref={composer} rows={3} maxLength={MAX_PROMPT_CHARACTERS} value={prompt} disabled={!state.configured || state.busy} placeholder={!state.configured ? `Connect ${providerName} to start a conversation…` : details.placeholder} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } }} />
        {state.workspace && <div className="composer-context"><span className="workspace-chip" title={state.workspace}><Icon name="folder" />{state.workspace}</span></div>}
        <div className="composer-toolbar"><div className="model-control"><label className="sr-only" htmlFor="little-model">{providerName} model</label><select id="little-model" disabled={!state.configured || state.busy || state.discovery === 'loading' || !state.models.length} value={state.selectedModel} onChange={event => send({ type: 'selectModel', model: event.target.value })}><option value="">{state.discovery === 'loading' ? 'Loading models…' : !state.configured ? `${providerName} · not connected` : state.models.length ? 'Choose model' : state.discovery === 'failed' ? 'Could not load models' : 'No compatible models loaded'}</option>{state.selectedModel && !hasModel && <option value={state.selectedModel}>{state.selectedModel} · unavailable</option>}{state.models.map(model => <option value={model.id} key={model.id}>{model.name}{model.capabilities.tools === 'unknown' ? ' · tools unverified' : model.capabilities.tools ? ' · tools' : ''}</option>)}</select><button type="button" className="icon-button" aria-label={`Refresh available ${providerName} models`} disabled={(!local && !state.configured) || state.busy || state.discovery === 'loading' || (state.providerError?.retryAt ?? 0) > now} onClick={() => send({ type: 'refreshModels' })}><Icon name="refresh" /></button></div>{state.busy ? <button type="button" className="stop-button" aria-label="Stop Little run" disabled={state.cancelPending} onClick={cancel}><Icon name="stop" /> Stop</button> : <button type="submit" className="send-button" disabled={!canStart} aria-label={details.submitLabel} title={cooldownSeconds > 0 ? `Provider cooldown: ${cooldownSeconds}s` : undefined}><Icon name="arrow" /></button>}</div>
      </form>
      <div className="composer-meta"><span><span className={`provider-dot${state.configured ? ' connected' : ''}`} />{local ? 'Ollama · local' : 'Groq Cloud'}</span><span title={activeMode === 'agent' ? 'Commands require permission for each request and run with current user permissions. Proposed file edits require native diff review and acceptance.' : controlledEdit ? 'Edit prepares proposals. Changes require your acceptance and a saved checkpoint.' : 'Ask and Plan do not modify files or run commands.'}><Icon name="shield" />{activeMode === 'agent' ? 'Commands need approval' : controlledEdit ? 'Approval required' : 'No file changes'}</span><kbd>Ctrl / ⌘ Enter</kbd></div>
    </footer>
  </main>;
}
