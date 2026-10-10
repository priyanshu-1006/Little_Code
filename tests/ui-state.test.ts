import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepositoryStatus, RuntimeEvent } from '../src/little/shared/contracts';
import { ClientMessageSchema, MAX_PROMPT_CHARACTERS } from '../src/little/ui/protocol';
import { initialState, MAX_ACTIVITY_ITEMS, MAX_COMMAND_OUTPUT_CHARACTERS, uiReducer } from '../src/little/ui/state';
import { App, ProjectSettings } from '../src/little/ui/view';

const start: RuntimeEvent = { type: 'agent.started', runId: 'run-1', mode: 'ask', model: 'discovered-model' };
const event = (runtimeEvent: RuntimeEvent) => ({ type: 'event' as const, event: runtimeEvent });

test('model discovery has explicit loading/failure states and retains a usable cached catalog', () => {
  const models = [{ id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', capabilities: { streaming: true, tools: true as const } }];
  let state = uiReducer(initialState, { type: 'snapshot', configured: true, models, selectedModel: models[0]!.id, workspace: 'project', busy: false, discovery: 'loading', events: [] });
  let view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.match(view, /Loading models…/); assert.match(view, /<select[^>]+disabled/);
  state = uiReducer(state, { type: 'snapshot', configured: true, models, selectedModel: models[0]!.id, workspace: 'project', busy: false, discovery: 'failed', providerError: { code: 'PROVIDER_UNAVAILABLE', message: 'Model discovery timed out. Refresh models.' }, events: [] });
  view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.equal(state.models.length, 1); assert.match(view, /Model discovery timed out/); assert.match(view, /Refresh models/);
});

test('rate limit cooldown survives snapshots without extending the server wait', () => {
  const deadline = Date.now() + 10_000;
  const failure: RuntimeEvent = { type: 'agent.failed', runId: start.runId, code: 'PROVIDER_RATE_LIMITED', message: 'Groq token limit reached. Try again in 10 seconds.', retryAfterMs: 10_000 };
  let state = uiReducer(initialState, event(start));
  state = uiReducer(state, event(failure));
  assert.ok(state.cooldownUntil > Date.now()); assert.equal(state.busy, false);
  state = uiReducer(state, { type: 'snapshot', configured: true, models: [{ id: start.model, name: start.model, capabilities: { streaming: true, tools: true } }], selectedModel: start.model, workspace: 'project', events: [start, failure], busy: false, cooldownUntil: deadline });
  assert.equal(state.cooldownUntil, deadline);
  const view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.match(view, /Provider cooldown/); assert.match(view, /retried in/); assert.match(view, /choose another loaded chat model/);
  const switched = uiReducer(state, { type: 'snapshot', configured: true, models: [], selectedModel: 'other', workspace: 'project', events: [], busy: false, cooldownUntil: 0 });
  assert.equal(switched.cooldownUntil, 0);
});

test('provider quota wait is cancellable UI work and stale wait messages cannot revive a run', () => {
  let state = uiReducer(initialState, event(start));
  state = uiReducer(state, event({ type: 'agent.state.changed', runId: start.runId, state: 'waiting_for_provider' }));
  state = uiReducer(state, event({ type: 'agent.provider.wait', runId: start.runId, until: Date.now() + 1000, message: 'Waiting for the observed token quota to reset.' }));
  assert.equal(state.busy, true);
  const view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.match(view, /Waiting for provider/); assert.match(view, /Stop is available/); assert.match(view, /Stop Little run/);
  state = uiReducer(state, event({ type: 'agent.cancelled', runId: start.runId }));
  assert.equal(state.run?.providerWait, undefined);
  assert.equal(uiReducer(state, event({ type: 'agent.provider.wait', runId: start.runId, until: Date.now() + 1000, message: 'late' })), state);
});

test('main run usage totals use actual provider events and replay consistently after restart', () => {
  const usage: RuntimeEvent[] = [{ type: 'agent.usage', runId: start.runId, inputTokens: 100, outputTokens: 20 }, { type: 'agent.usage', runId: start.runId, inputTokens: 150, outputTokens: 30 }];
  let state = uiReducer(initialState, event(start));
  for (const value of usage) state = uiReducer(state, event(value));
  assert.deepEqual(state.run?.usage, { inputTokens: 250, outputTokens: 50, requests: 2 });
  const replay = uiReducer(state, { type: 'snapshot', configured: true, models: [], selectedModel: '', workspace: 'project', events: [start, ...usage], busy: true });
  assert.deepEqual(replay.run?.usage, state.run?.usage);
  const view = renderToStaticMarkup(createElement(App, { initialViewState: replay, send: () => {} }));
  assert.match(view, /Main run token usage/); assert.match(view, /2 responses/); assert.match(view, /300/); assert.match(view, /cost depends on your account/);
});

test('provider and project features remain separate from credentials and stale project messages', () => {
  const features = { memory: { entries: [{ id: 'a'.repeat(32), title: '<script>note</script>', content: 'A convention & decision', kind: 'inference' as const, createdAt: 1, updatedAt: 1 }] }, mcp: [{ id: 'b'.repeat(16), name: 'Local MCP', url: 'http://127.0.0.1:3000/mcp', state: 'connected' as const, tools: 2 }] };
  const state = uiReducer(initialState, { type: 'snapshot', configured: true, provider: 'ollama', endpoint: 'http://127.0.0.1:11434', models: [{ id: 'local:model', name: 'local:model', capabilities: { streaming: true, tools: 'unknown' } }], selectedModel: 'local:model', workspace: 'project', busy: false, events: [], features });
  assert.equal(state.provider, 'ollama');
  assert.equal(uiReducer(state, { type: 'features', workspace: 'other', features: { memory: { entries: [] }, mcp: [] } }), state);
  const settings = renderToStaticMarkup(createElement(ProjectSettings, { state, send: () => {} }));
  assert.match(settings, /Ollama · local/); assert.match(settings, /Configure Ollama/); assert.match(settings, /Project memory/); assert.match(settings, /Inference/); assert.match(settings, /MCP integrations/);
  assert.match(settings, /&lt;script&gt;note&lt;\/script&gt;/); assert.doesNotMatch(settings, /<script>/);
  assert.doesNotMatch(settings, /Replace key|Remove key/);
  const view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.match(view, /Ollama model/); assert.match(view, /Review Git changes/); assert.match(view, /Saved checkpoints/);
  assert.doesNotMatch(view, /Groq model|Groq Cloud/);
  const switched = uiReducer(state, { type: 'snapshot', configured: false, models: [], selectedModel: '', workspace: 'other', busy: false, events: [] });
  assert.equal(switched.features.memory.entries.length, 0); assert.equal(switched.features.mcp.length, 0);
  for (const message of [{ type: 'selectProvider', provider: 'ollama' }, { type: 'configureOllama' }, { type: 'addMemory' }, { type: 'editMemory', id: 'a'.repeat(32) }, { type: 'connectMcpServer', id: 'b'.repeat(16) }]) assert.equal(ClientMessageSchema.safeParse(message).success, true);
  for (const message of [{ type: 'selectProvider', provider: 'unknown' }, { type: 'configureOllama', apiKey: 'private' }, { type: 'editMemory', id: '../note' }, { type: 'addMcpServer', url: 'https://remote.example' }]) assert.equal(ClientMessageSchema.safeParse(message).success, false);
});

test('review cards show real bounded states and cancelled runs ignore late reviewer completion', () => {
  let state = uiReducer(initialState, event({ ...start, mode: 'agent' }));
  state = uiReducer(state, event({ type: 'review.updated', runId: start.runId, role: 'architecture', state: 'running' }));
  state = uiReducer(state, event({ type: 'review.updated', runId: start.runId, role: 'architecture', state: 'completed', text: '<b>Evidence</b>' }));
  state = uiReducer(state, event({ type: 'review.updated', runId: start.runId, role: 'verification', state: 'failed', error: 'No result' }));
  const view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.match(view, /Architecture reviewer/); assert.match(view, /Verification reviewer/); assert.match(view, /&lt;b&gt;Evidence&lt;\/b&gt;/); assert.match(view, /No result/);
  state = uiReducer(state, event({ type: 'agent.cancelled', runId: start.runId }));
  assert.equal(uiReducer(state, event({ type: 'review.updated', runId: start.runId, role: 'verification', state: 'completed', text: 'late' })), state);
});

test('host-owned MCP names survive tool results and remain safely escaped', () => {
  let state = uiReducer(initialState, event({ ...start, mode: 'agent' }));
  state = uiReducer(state, event({ type: 'tool.started', runId: start.runId, call: { id: 'mcp-call', name: 'mcp_opaque_name', arguments: '' }, label: 'MCP · Local / <echo>' }));
  state = uiReducer(state, event({ type: 'tool.completed', runId: start.runId, callId: 'mcp-call', name: 'mcp_opaque_name', summary: 'Tool returned a result.' }));
  assert.equal(state.run?.activity[0]?.name, 'MCP · Local / <echo>');
  const view = renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
  assert.match(view, /MCP · Local \/ &lt;echo&gt;/); assert.doesNotMatch(view, /mcp opaque name/);
});

test('local repository refresh is available without a key and ignores stale status', () => {
  const status: RepositoryStatus = { state: 'ready', workspace: 'project', files: 12, processed: 2, symbols: 24, reused: 10, truncated: false, generation: 3 };
  let state = uiReducer(initialState, { type: 'snapshot', configured: false, models: [], selectedModel: '', workspace: 'project', busy: false, events: [], repository: status });
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Project intelligence/); assert.match(markup, /12 files · 24 symbols/);
  assert.match(markup, /aria-label="Refresh project index"/); assert.match(markup, /10 unchanged files reused/);
  assert.match(markup, /Connect Groq/);
  state = uiReducer(state, { type: 'requestRepositoryRefresh' });
  assert.equal(state.repositoryPending, true);
  assert.equal(uiReducer(state, { type: 'requestRepositoryRefresh' }), state);
  state = uiReducer(state, { type: 'repository', status: { ...status, state: 'indexing' } });
  assert.equal(state.repositoryPending, false);
  assert.equal(uiReducer(state, { type: 'requestRepositoryRefresh' }), state);
  assert.equal(uiReducer(state, { type: 'repository', status: { ...status, generation: 2 } }), state);
  assert.equal(uiReducer(state, { type: 'repository', status: { ...status, workspace: 'other' } }), state);
  state = uiReducer(state, { type: 'snapshot', configured: false, models: [], selectedModel: '', workspace: 'other', busy: false, events: [] });
  assert.equal(state.repository, null);
  assert.equal(ClientMessageSchema.safeParse({ type: 'refreshRepository' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'refreshRepository', includeSecrets: true }).success, false);
});

test('context provenance renders escaped text and failed repository refresh can retry', () => {
  let state = uiReducer(initialState, { type: 'snapshot', configured: true, models: [], selectedModel: '', workspace: 'project', busy: false, events: [start,
    { type: 'context.updated', runId: 'run-1', items: [{ id: 'auth', label: 'auth.ts:1-10', type: 'file', estimatedTokens: 100, reason: 'Symbol match <script>authenticate</script>' }] },
    { type: 'agent.completed', runId: 'run-1' },
  ] });
  state = uiReducer(state, { type: 'requestRepositoryRefresh' });
  state = uiReducer(state, { type: 'error', code: 'TOOL_FAILED', message: 'Refresh failed.' });
  assert.equal(state.repositoryPending, false);
  assert.equal(uiReducer(state, { type: 'requestRepositoryRefresh' }).repositoryPending, true);
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Symbol match &lt;script&gt;authenticate&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});

test('snapshot recreates streamed text, context, and completed tools', () => {
  const state = uiReducer(initialState, { type: 'snapshot', configured: true, models: [], selectedModel: 'discovered-model', workspace: 'project', busy: false, events: [
    start,
    { type: 'context.updated', runId: 'run-1', items: [{ id: 'workspace', label: 'workspace', type: 'workspace', estimatedTokens: 60 }] },
    { type: 'agent.text.delta', runId: 'run-1', text: 'Architecture: ' },
    { type: 'agent.text.delta', runId: 'run-1', text: 'TypeScript.' },
    { type: 'tool.started', runId: 'run-1', call: { id: 'call-1', name: 'read_file', arguments: '{}' } },
    { type: 'tool.completed', runId: 'run-1', callId: 'call-1', name: 'read_file', summary: 'Read package.json' },
    { type: 'agent.completed', runId: 'run-1' },
  ] });
  assert.equal(state.run?.text, 'Architecture: TypeScript.');
  assert.equal(state.run?.context[0]?.estimatedTokens, 60);
  assert.equal(state.run?.activity[0]?.status, 'success');
  assert.equal(state.run?.state, 'completed');
  assert.equal(state.busy, false);
});

test('cancellation waits for confirmation and rejects late provider completion', () => {
  let state = uiReducer(initialState, event(start));
  state = uiReducer(state, { type: 'requestCancel' });
  assert.equal(state.busy, true);
  assert.equal(state.cancelPending, true);
  state = uiReducer(state, event({ type: 'agent.cancelled', runId: 'run-1' }));
  state = uiReducer(state, event({ type: 'agent.text.delta', runId: 'run-1', text: 'Late text' }));
  state = uiReducer(state, event({ type: 'agent.completed', runId: 'run-1' }));
  assert.equal(state.run?.state, 'cancelled');
  assert.equal(state.run?.text, '');
  assert.equal(state.busy, false);
});

test('a failed state notification still accepts its detailed final error', () => {
  let state = uiReducer(initialState, event(start));
  state = uiReducer(state, event({ type: 'agent.state.changed', runId: 'run-1', state: 'failed' }));
  state = uiReducer(state, event({ type: 'agent.failed', runId: 'run-1', code: 'RATE_LIMIT', message: 'Retry after the provider rate limit resets.' }));
  assert.equal(state.run?.error?.code, 'RATE_LIMIT');
});

test('previous run events cannot alter the latest run and activity is bounded', () => {
  let state = uiReducer(initialState, event(start));
  state = uiReducer(state, event({ ...start, runId: 'run-2' }));
  state = uiReducer(state, event({ type: 'agent.failed', runId: 'run-1', code: 'OLD', message: 'Old run failed' }));
  for (let index = 0; index < MAX_ACTIVITY_ITEMS + 5; index++) {
    state = uiReducer(state, event({ type: 'tool.started', runId: 'run-2', call: { id: `call-${index}`, name: 'read_file', arguments: '{}' } }));
  }
  assert.equal(state.run?.id, 'run-2');
  assert.equal(state.run?.activity.length, MAX_ACTIVITY_ITEMS);
  assert.equal(state.run?.omittedActivity, 5);
  assert.equal(state.run?.error, undefined);
});

test('host protocol allows supervised Agent while rejecting credentials and autopilot', () => {
  assert.equal(ClientMessageSchema.safeParse({ type: 'configure', apiKey: 'must-never-be-sent' }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: 'start', mode: 'agent', prompt: 'Inspect, plan, and request permission before checks' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'start', mode: 'plan', prompt: '   ' }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: 'start', mode: 'ask', prompt: 'Explain this repository' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'start', mode: 'edit', prompt: 'Propose a focused change for review' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'start', mode: 'autopilot', prompt: 'Do everything' }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: 'start', mode: 'ask', prompt: 'x'.repeat(MAX_PROMPT_CHARACTERS + 1) }).success, false);
});

test('setup renders an accessible connection action without a credential field', () => {
  const markup = renderToStaticMarkup(createElement(App, { send: () => {} }));
  assert.match(markup, /<button[^>]*>Connect Groq/);
  assert.match(markup, /Groq Cloud/);
  assert.match(markup, /<label[^>]*for="little-prompt"/);
  assert.match(markup, /<textarea[^>]*maxLength="12000"[^>]*disabled=""/);
  assert.doesNotMatch(markup, /type="password"|apiKey|API_KEY/);
});

test('connected composer, tool errors, and streamed content render safely and semantically', () => {
  let state = uiReducer(initialState, { type: 'snapshot', configured: true, models: [{ id: 'live-model', name: 'Live model', capabilities: { streaming: true, tools: 'unknown' } }], selectedModel: 'live-model', workspace: 'sample-project', busy: false, events: [
    start,
    { type: 'tool.started', runId: 'run-1', call: { id: 'call-1', name: 'read_file', arguments: '{}' } },
    { type: 'tool.failed', runId: 'run-1', callId: 'call-1', name: 'read_file', code: 'OUTSIDE_WORKSPACE', message: 'File is outside the workspace.' },
    { type: 'agent.text.delta', runId: 'run-1', text: '<script>alert("untrusted")</script>' },
    { type: 'agent.failed', runId: 'run-1', code: 'PROVIDER_ERROR', message: '<img src=x onerror=alert(1)>' },
  ] });
  state = { ...state, busy: false };
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /aria-label="Little mode"/);
  assert.match(markup, /aria-pressed="true"[^>]*>Ask/);
  assert.match(markup, /<select[^>]*id="little-model"/);
  assert.match(markup, /Live model · tools unverified/);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /OUTSIDE_WORKSPACE/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<script>|<img src=x/);
  assert.match(markup, /No file changes/);
});

const proposalId = 'a'.repeat(32);
const checkpointId = 'b'.repeat(32);
const editStart: RuntimeEvent = { ...start, mode: 'edit' };
const proposed: RuntimeEvent = { type: 'edits.proposed', runId: 'run-1', proposalId, files: [{ path: 'src/app.ts', kind: 'replace' }, { path: 'src/new.ts', kind: 'create' }] };

function pendingEdit() {
  return uiReducer(initialState, { type: 'snapshot', configured: true, models: [], selectedModel: '', workspace: 'project', busy: true, events: [editStart, proposed] });
}

test('a proposal stays pending until a matching host decision confirms the result', () => {
  let state = pendingEdit();
  state = uiReducer(state, { type: 'requestEditDecision', proposalId, decision: 'accept' });
  assert.equal(state.run?.edits[0]?.status, 'pending');
  assert.equal(state.run?.edits[0]?.pendingDecision, 'accept');
  assert.equal(state.run?.edits[0]?.checkpointId, undefined);
  assert.equal(state.busy, true);
  state = uiReducer(state, { type: 'requestEditDecision', proposalId, decision: 'reject' });
  assert.equal(state.run?.edits[0]?.pendingDecision, 'accept');
  state = uiReducer(state, event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'applied', checkpointId }));
  assert.equal(state.run?.edits[0]?.status, 'applied');
  assert.equal(state.run?.edits[0]?.checkpointId, checkpointId);
  assert.equal(state.run?.edits[0]?.pendingDecision, undefined);
  assert.equal(state.run?.edits[0]?.files[1]?.kind, 'create');
  state = uiReducer(state, event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'rejected' }));
  assert.equal(state.run?.edits[0]?.status, 'applied');
});

test('unknown, duplicate, stale, and read-only proposals cannot create actionable edits', () => {
  let state = pendingEdit();
  state = uiReducer(state, event(proposed));
  assert.equal(state.run?.edits.length, 1);
  state = uiReducer(state, event({ type: 'edits.resolved', runId: 'run-1', proposalId: 'unknown', decision: 'applied', checkpointId }));
  assert.equal(state.run?.edits[0]?.status, 'pending');
  state = uiReducer(state, event({ ...editStart, runId: 'run-2' }));
  state = uiReducer(state, event(proposed));
  state = uiReducer(state, event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'applied', checkpointId }));
  assert.equal(state.run?.edits.length, 0);
  let readOnly = uiReducer(initialState, event(start));
  readOnly = uiReducer(readOnly, event(proposed));
  assert.equal(readOnly.run?.edits.length, 0);
  state = uiReducer(state, event({ type: 'agent.completed', runId: 'run-2' }));
  state = uiReducer(state, event({ ...proposed, runId: 'run-2' }));
  assert.equal(state.run?.edits.length, 0);
});

test('rejection and conflict remove approval affordances without claiming an applied checkpoint', () => {
  for (const decision of ['rejected', 'conflicted'] as const) {
    const state = uiReducer(pendingEdit(), event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision }));
    assert.equal(state.run?.edits[0]?.status, decision);
    assert.equal(state.run?.edits[0]?.checkpointId, undefined);
    const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
    assert.doesNotMatch(markup, /Accept changes|>Review diff|Restore changes|Checkpoint saved/);
    assert.match(markup, decision === 'rejected' ? /No changes from this proposal were applied/ : /could not be applied safely/);
  }
});

test('completed run snapshots preserve checkpoint recovery and matching restoration events', () => {
  let state = uiReducer(initialState, { type: 'snapshot', configured: true, models: [], selectedModel: '', workspace: 'project', busy: false, events: [
    editStart, proposed, { type: 'agent.completed', runId: 'run-1' },
    { type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'applied', checkpointId },
  ] });
  assert.equal(state.run?.state, 'completed');
  assert.equal(state.run?.edits[0]?.status, 'applied');
  state = uiReducer(state, { type: 'requestRestore', checkpointId });
  assert.equal(state.run?.edits[0]?.status, 'applied');
  assert.equal(state.run?.edits[0]?.restorePending, true);
  state = uiReducer(state, event({ type: 'edits.restored', runId: 'run-1', checkpointId: 'unknown' }));
  assert.equal(state.run?.edits[0]?.status, 'applied');
  state = uiReducer(state, event({ type: 'edits.restored', runId: 'run-1', checkpointId }));
  assert.equal(state.run?.edits[0]?.status, 'restored');
  assert.equal(state.run?.edits[0]?.restorePending, false);
  assert.equal(state.run?.state, 'completed');
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Changes restored/);
  assert.doesNotMatch(markup, /Restore changes|Accept changes/);
});

test('Edit exposes explicit enabled review decisions during a busy run and escapes paths', () => {
  let state = pendingEdit();
  state = uiReducer(state, event({ type: 'edits.proposed', runId: 'run-1', proposalId: 'c'.repeat(32), files: [{ path: '<img src=x onerror=alert(1)>.ts', kind: 'create' }] }));
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Review before apply/);
  assert.match(markup, /Approval required/);
  assert.match(markup, /Files stay unchanged until you accept/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Review diff/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Accept changes/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Reject/);
  assert.match(markup, /aria-pressed="true"[^>]*>Edit/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;\.ts/);
  assert.doesNotMatch(markup, /<img src=x|No file changes/);
});

test('decisions and cancellation disable duplicate approval requests until the host resolves them', () => {
  let state = uiReducer(pendingEdit(), { type: 'requestEditDecision', proposalId, decision: 'accept' });
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Accept changes/);
  assert.match(markup, /Confirming your choice/);
  assert.doesNotMatch(markup, /Changes applied|Checkpoint saved/);
  state = uiReducer(state, { type: 'error', code: 'PERMISSION_DENIED', message: 'Review the diff first.' });
  assert.equal(state.run?.edits[0]?.status, 'pending');
  assert.equal(state.run?.edits[0]?.pendingDecision, undefined);
  state = uiReducer(state, { type: 'requestCancel' });
  state = uiReducer(state, { type: 'requestEditDecision', proposalId, decision: 'accept' });
  assert.equal(state.run?.edits[0]?.pendingDecision, undefined);
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Accept changes/);
  state = uiReducer(state, event({ type: 'agent.cancelled', runId: 'run-1' }));
  state = uiReducer(state, { type: 'requestEditDecision', proposalId, decision: 'accept' });
  assert.equal(state.run?.edits[0]?.pendingDecision, undefined);
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Accept changes/);
  assert.doesNotMatch(markup, /Review needed/);
  state = uiReducer(state, event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'rejected' }));
  assert.equal(state.run?.edits[0]?.status, 'rejected');
  assert.equal(state.run?.state, 'cancelled');
});

test('only host-confirmed applied checkpoints expose restoration after the run finishes', () => {
  let state = uiReducer(pendingEdit(), event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'applied', checkpointId }));
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Checkpoint saved/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Restore changes/);
  assert.doesNotMatch(markup, /Accept changes|>Review diff/);
  state = uiReducer(state, event({ type: 'agent.completed', runId: 'run-1' }));
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Restore changes/);
});

test('edit review messages carry opaque IDs and decisions without content or permission grants', () => {
  assert.equal(ClientMessageSchema.safeParse({ type: 'reviewEdits', proposalId }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideEdits', proposalId, decision: 'accept' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'restoreCheckpoint', checkpointId }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideEdits', proposalId, decision: 'accept', grant: 'WORKSPACE_WRITE' }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: 'reviewEdits', proposalId, content: 'replacement source' }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: 'restoreCheckpoint', checkpointId: '../outside-workspace' }).success, false);
});

test('conflicted transactions retain recovery checkpoints without claiming successful application', () => {
  let state = uiReducer(pendingEdit(), event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'conflicted', checkpointId }));
  assert.equal(state.run?.edits[0]?.checkpointId, checkpointId);
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Review needs attention/);
  assert.match(markup, /Recovery checkpoint/);
  assert.match(markup, /could not apply this proposal safely/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Restore checkpoint/);
  assert.doesNotMatch(markup, /Changes applied|Checkpoint saved|Accept changes|No changes from this proposal were applied/);
  state = uiReducer(state, event({ type: 'agent.cancelled', runId: 'run-1' }));
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Restore checkpoint/);
  state = uiReducer(state, { type: 'requestRestore', checkpointId });
  assert.equal(state.run?.edits[0]?.restorePending, true);
  state = uiReducer(state, { type: 'error', code: 'TOOL_FAILED', message: 'A later save must be reviewed before recovery.' });
  assert.equal(state.run?.edits[0]?.restorePending, false);
  assert.equal(state.run?.edits[0]?.status, 'conflicted');
  state = uiReducer(state, { type: 'requestRestore', checkpointId });
  state = uiReducer(state, event({ type: 'edits.restored', runId: 'run-1', checkpointId }));
  assert.equal(state.run?.edits[0]?.status, 'restored');
  assert.equal(state.run?.edits[0]?.restorePending, false);
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Changes restored/);
  assert.doesNotMatch(markup, /Restore checkpoint|Accept changes|Changes applied/);
});

const commandId = 'd'.repeat(32);
const agentStart: RuntimeEvent = { ...start, mode: 'agent' };
const commandProposed: Extract<RuntimeEvent, { type: 'command.proposed' }> = {
  type: 'command.proposed', runId: 'run-1', commandId, risk: 'EXECUTION',
  command: { program: 'npm.cmd', args: ['test', '--', 'src/app.test.ts'], cwd: '.', purpose: 'Check the proposed behavior.', timeoutMs: 30000 },
};
function pendingCommand() {
  return uiReducer(initialState, { type: 'snapshot', configured: true, models: [], selectedModel: '', workspace: 'project', busy: true, events: [
    agentStart, { type: 'agent.plan.updated', runId: 'run-1', steps: ['Inspect the implementation.', 'Review changes and run an approved check.'] }, commandProposed,
    { type: 'agent.state.changed', runId: 'run-1', state: 'waiting_for_permission' },
  ] });
}
const commandCompleted: Extract<RuntimeEvent, { type: 'command.completed' }> = {
  type: 'command.completed', runId: 'run-1', commandId,
  result: { status: 'exited', exitCode: 0, output: 'One check passed.', truncated: false, durationMs: 1500 },
};

test('command approval carries only the opaque request ID and one explicit decision', () => {
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideCommand', commandId, decision: 'allow' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideCommand', commandId, decision: 'reject' }).success, true);
  for (const payload of [
    { type: 'decideCommand', commandId, decision: 'always' },
    { type: 'decideCommand', commandId: '../outside', decision: 'allow' },
    { type: 'decideCommand', commandId: commandId.toUpperCase(), decision: 'allow' },
    { type: 'decideCommand', commandId, decision: 'allow', grant: 'EXECUTION' },
    { type: 'decideCommand', commandId, decision: 'allow', program: 'other.exe' },
  ]) assert.equal(ClientMessageSchema.safeParse(payload).success, false);
});

test('only Agent accepts command requests and stale or duplicate requests have no effect', () => {
  for (const mode of ['ask', 'plan', 'edit'] as const) {
    let state = uiReducer(initialState, event({ ...start, mode }));
    state = uiReducer(state, event(commandProposed));
    state = uiReducer(state, { type: 'requestCommandDecision', commandId, decision: 'allow' });
    assert.equal(state.run?.commands.length, 0);
  }
  let state = pendingCommand();
  const args = [...commandProposed.command.args];
  assert.notEqual(state.run?.commands[0]?.command.args, commandProposed.command.args);
  assert.deepEqual(state.run?.commands[0]?.command.args, args);
  state = uiReducer(state, event(commandProposed));
  assert.equal(state.run?.commands.length, 1);
  state = uiReducer(state, event({ type: 'command.started', runId: 'run-1', commandId: 'unknown' }));
  assert.equal(state.run?.commands[0]?.status, 'pending');
  state = uiReducer(state, event({ ...agentStart, runId: 'run-2' }));
  state = uiReducer(state, event(commandProposed));
  state = uiReducer(state, event(commandCompleted));
  assert.equal(state.run?.commands.length, 0);
});

test('command choice stays pending until host evidence, survives snapshots, and permits retry after error', () => {
  let state = uiReducer(pendingCommand(), { type: 'requestCommandDecision', commandId, decision: 'allow' });
  assert.equal(state.run?.commands[0]?.status, 'pending');
  assert.equal(state.run?.commands[0]?.pendingDecision, 'allow');
  state = uiReducer(state, { type: 'requestCommandDecision', commandId, decision: 'reject' });
  assert.equal(state.run?.commands[0]?.pendingDecision, 'allow');
  state = uiReducer(state, { type: 'snapshot', configured: true, models: [], selectedModel: '', workspace: 'project', busy: true, events: [agentStart, commandProposed] });
  assert.equal(state.run?.commands[0]?.pendingDecision, 'allow');
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Allow once/);
  assert.match(markup, /Waiting for the host to confirm your choice/);
  assert.doesNotMatch(markup, /Running approved command|Command exited successfully/);
  state = uiReducer(state, { type: 'error', code: 'PERMISSION_DENIED', message: 'Please retry this command decision.' });
  assert.equal(state.run?.commands[0]?.pendingDecision, undefined);
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Allow once/);
  state = uiReducer(state, { type: 'requestCommandDecision', commandId, decision: 'reject' });
  state = uiReducer(state, event({ ...commandCompleted, result: { ...commandCompleted.result, status: 'rejected', exitCode: null, output: '' } }));
  assert.equal(state.run?.commands[0]?.status, 'completed');
  assert.equal(state.run?.commands[0]?.pendingDecision, undefined);
  assert.equal(state.run?.commands[0]?.result?.status, 'rejected');
});

test('cancellation and terminal states prevent new approvals but preserve actual late command exits', () => {
  let state = uiReducer(pendingCommand(), { type: 'requestCancel' });
  state = uiReducer(state, { type: 'requestCommandDecision', commandId, decision: 'allow' });
  assert.equal(state.run?.commands[0]?.pendingDecision, undefined);
  state = uiReducer(state, event({ ...commandProposed, commandId: 'e'.repeat(32) }));
  assert.equal(state.run?.commands.length, 1);
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Allow once/);
  state = uiReducer(state, event({ type: 'agent.cancelled', runId: 'run-1' }));
  state = uiReducer(state, event({ type: 'command.started', runId: 'run-1', commandId }));
  assert.equal(state.run?.commands[0]?.status, 'pending');
  state = uiReducer(state, { type: 'requestCommandDecision', commandId, decision: 'allow' });
  state = uiReducer(state, event({ ...commandCompleted, result: { ...commandCompleted.result, status: 'cancelled', exitCode: null } }));
  assert.equal(state.run?.commands[0]?.result?.status, 'cancelled');
  assert.equal(state.run?.state, 'cancelled');
  assert.equal(state.busy, false);
  state = uiReducer(state, event(commandCompleted));
  assert.equal(state.run?.commands[0]?.result?.status, 'cancelled');
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Command stopped/);
  assert.doesNotMatch(markup, /Allow once|Command exited successfully/);
  for (const finalState of ['completed', 'failed', 'blocked'] as const) {
    let ended = uiReducer(pendingCommand(), event({ type: 'agent.state.changed', runId: 'run-1', state: finalState }));
    ended = uiReducer(ended, { type: 'requestCommandDecision', commandId, decision: 'allow' });
    assert.equal(ended.run?.commands[0]?.pendingDecision, undefined);
  }
});

test('Agent renders exact request metadata and explicit current-user permission controls while busy', () => {
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: pendingCommand() }));
  assert.match(markup, /aria-pressed="true"[^>]*>Agent/);
  assert.match(markup, /Permission needed/);
  assert.match(markup, /Exact program and arguments/);
  assert.match(markup, /npm\.cmd/);
  assert.match(markup, /&quot;src\/app\.test\.ts&quot;/);
  assert.match(markup, /Directory <code>\.<\/code>/);
  assert.match(markup, /Check the proposed behavior/);
  assert.match(markup, /EXECUTION/);
  assert.match(markup, /30s limit/);
  assert.match(markup, /current user permissions/);
  assert.match(markup, /no OS sandbox is applied/);
  assert.match(markup, /Proposed file edits still need diff approval/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Allow once/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Reject/);
  assert.match(markup, /Plan for this run/);
  assert.match(markup, /Inspect the implementation/);
  assert.match(markup, /Commands need approval/);
  assert.doesNotMatch(markup, /Read only|No file changes|Running approved command|Approved checks passed/);
});

test('command metadata is escaped and permission cards follow the streamed explanation', () => {
  let state = uiReducer(initialState, event(agentStart));
  state = uiReducer(state, event({ type: 'agent.text.delta', runId: 'run-1', text: 'Explain the check before requesting permission.' }));
  state = uiReducer(state, event({ ...commandProposed, command: { ...commandProposed.command,
    program: '<img src=x>', args: ['<script>danger</script>'], cwd: 'src/<img>', purpose: '<svg onload=bad()>',
  } }));
  const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /&lt;img src=x&gt;/);
  assert.match(markup, /&lt;script&gt;danger&lt;\/script&gt;/);
  assert.match(markup, /src\/&lt;img&gt;/);
  assert.match(markup, /&lt;svg onload=bad\(\)&gt;/);
  assert.doesNotMatch(markup, /<img src=x|<script>|<svg onload/);
  assert(markup.indexOf('Explain the check before requesting permission.') < markup.indexOf('Command permission'));
});

test('host-confirmed starts and bounded escaped output are displayed without duplicate decisions', () => {
  let state = pendingCommand();
  state = uiReducer(state, event({ type: 'command.started', runId: 'run-1', commandId }));
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Running approved command/);
  assert.doesNotMatch(markup, /Allow once|Command exited successfully/);
  const output = '<script>alert("command")</script>' + 'x'.repeat(MAX_COMMAND_OUTPUT_CHARACTERS);
  state = uiReducer(state, event({ ...commandCompleted, result: { ...commandCompleted.result, output, truncated: true } }));
  assert.equal(state.run?.commands[0]?.result?.output.length, MAX_COMMAND_OUTPUT_CHARACTERS);
  assert.equal(state.run?.commands[0]?.displayTruncated, true);
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Command exited successfully/);
  assert.match(markup, /<details class="command-output"><summary>Show command output/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /The host truncated command output/);
  assert.match(markup, /Output was shortened for display/);
  assert.doesNotMatch(markup, /<script>|Allow once|Approved checks passed/);
  assert.equal(state.run?.verification, undefined);
});

test('failed, rejected, stopped and bounded command results never claim successful checks', () => {
  for (const status of ['rejected', 'cancelled', 'timed_out', 'output_limit', 'failed'] as const) {
    const state = uiReducer(pendingCommand(), event({ ...commandCompleted, result: { ...commandCompleted.result, status, exitCode: null, output: '' } }));
    const markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
    assert.doesNotMatch(markup, /Allow once|Command exited successfully|Approved checks passed/);
    assert.match(markup, /No command output received/);
  }
  const failed = uiReducer(pendingCommand(), event({ ...commandCompleted, result: { ...commandCompleted.result, exitCode: 1 } }));
  assert.match(renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: failed })), /Command exited with error/);
});

test('Agent keeps native edit approval and invalidates displayed verification when changes apply', () => {
  let state = uiReducer(pendingCommand(), event(proposed));
  assert.equal(state.run?.edits[0]?.status, 'pending');
  state = uiReducer(state, event({ type: 'agent.verification', runId: 'run-1', status: 'passed', checks: [{ command: 'npm.cmd test', status: 'exited', exitCode: 0, passed: true, durationMs: 1000 }], outstandingEdits: true }));
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Approved checks passed/);
  assert.match(markup, /Results reflect approved command exits/);
  assert.match(markup, /Applied changes still need current verification/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Review diff/);
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>Accept changes/);
  state = uiReducer(state, event({ type: 'edits.resolved', runId: 'run-1', proposalId, decision: 'applied', checkpointId }));
  assert.equal(state.run?.verification, undefined);
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Changes applied/);
  assert.doesNotMatch(markup, /Approved checks passed/);
});

test('final verification follows actual host outcomes and cannot alter a different run', () => {
  let state = pendingCommand();
  state = uiReducer(state, event({ type: 'agent.completed', runId: 'run-1' }));
  state = uiReducer(state, event({ type: 'agent.verification', runId: 'run-1', status: 'failed', checks: [{ command: '<img src=x>', status: 'exited', exitCode: 1, passed: false, durationMs: 2000 }], outstandingEdits: false }));
  let markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Checks need attention/);
  assert.match(markup, /&lt;img src=x&gt;/);
  assert.match(markup, /exit 1/);
  assert.doesNotMatch(markup, /<img src=x|Approved checks passed/);
  assert.equal(state.run?.state, 'completed');
  assert.equal(state.busy, false);
  state = uiReducer(state, event({ ...agentStart, runId: 'run-2' }));
  state = uiReducer(state, event({ type: 'agent.verification', runId: 'run-1', status: 'passed', checks: [], outstandingEdits: false }));
  assert.equal(state.run?.verification, undefined);
  state = uiReducer(state, event({ type: 'agent.verification', runId: 'run-2', status: 'not_run', checks: [], outstandingEdits: false }));
  markup = renderToStaticMarkup(createElement(App, { send: () => {}, initialViewState: state }));
  assert.match(markup, /Checks not run/);
  assert.doesNotMatch(markup, /Approved checks passed/);
});
