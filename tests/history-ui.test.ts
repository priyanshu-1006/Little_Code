import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatHistorySnapshot, ChatTurn } from '../src/little/history/chat-history';
import type { RuntimeEvent } from '../src/little/shared/contracts';
import { ClientMessageSchema } from '../src/little/ui/protocol';
import { initialState, uiReducer } from '../src/little/ui/state';
import { App, SavedTurn } from '../src/little/ui/view';

const turn: ChatTurn = { id: 'b'.repeat(32), prompt: '<script>question</script>', answer: 'Saved answer & evidence',
  mode: 'agent', provider: 'groq', model: 'model', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, status: 'completed' };
function history(changes: Partial<ChatHistorySnapshot> = {}): ChatHistorySnapshot {
  return { workspaceKey: 'opaque-workspace-one', revision: 2, selectedId: 'a'.repeat(32),
    sessions: [{ id: 'a'.repeat(32), title: 'Project conversation', createdAt: turn.createdAt, updatedAt: turn.updatedAt, turns: [structuredClone(turn)] }], ...changes };
}
function restored(value = history()) {
  return uiReducer(initialState, { type: 'snapshot', configured: true, workspace: 'project', selectedModel: 'model',
    models: [{ id: 'model', name: 'model', capabilities: { streaming: true, tools: true } }], discovery: 'ready',
    events: [], busy: false, chatHistory: value });
}
const render = (state = restored()) => renderToStaticMarkup(createElement(App, { initialViewState: state, send: () => {} }));
const event = (value: RuntimeEvent) => ({ type: 'event' as const, event: value });

test('restart displays saved questions and answers without reviving runtime actions', () => {
  const state = restored(); const view = render(state);
  assert.equal(state.run, null); assert.equal(state.busy, false); assert.equal(state.cooldownUntil, 0);
  assert.match(view, /Saved chats for this project/); assert.match(view, /Project conversation · 1 turn/);
  assert.match(view, /New chat/); assert.match(view, /Clear saved chats for this project/);
  assert.match(view, /&lt;script&gt;question&lt;\/script&gt;/); assert.doesNotMatch(view, /<script>/);
  assert.match(view, /Saved answer &amp; evidence/); assert.match(view, /Chats are saved locally for this project/);
  assert.match(view, /Saved cards cannot execute actions/);
  assert.doesNotMatch(view, /Accept changes|Allow once|Restore changes|Stop Little run|class="response-card/);
  assert.doesNotMatch(view, /What are we/);
});

test('interrupted saved runs remain read-only and do not claim completion', () => {
  const view = renderToStaticMarkup(createElement(SavedTurn, { turn: { ...turn, status: 'interrupted', answer: '', truncated: true } }));
  assert.match(view, /Interrupted/); assert.match(view, /No actions were resumed/);
  assert.match(view, /No text response was saved/); assert.match(view, /stored preview was shortened/);
  assert.doesNotMatch(view, /Complete|<button/);
});

test('history updates preserve active permissions, cancel state, and provider cooldown', () => {
  let state = restored();
  state = uiReducer(state, event({ type: 'agent.started', runId: 'current', mode: 'agent', model: 'model' }));
  state = uiReducer(state, event({ type: 'command.proposed', runId: 'current', commandId: 'c'.repeat(32), command: { program: 'node', args: ['--test'], cwd: '.', timeoutMs: 1000, purpose: 'Run checks' }, risk: 'DANGEROUS' }));
  state = uiReducer(state, { type: 'requestCommandDecision', commandId: 'c'.repeat(32), decision: 'allow' });
  state = { ...state, cooldownUntil: 12345, cancelPending: true };
  const updated = uiReducer(state, { type: 'chatHistory', history: history({ revision: 3, notice: 'Stored preview shortened.' }) });
  assert.equal(updated.run, state.run); assert.equal(updated.busy, true); assert.equal(updated.cancelPending, true);
  assert.equal(updated.cooldownUntil, 12345); assert.equal(updated.run?.commands[0]?.pendingDecision, 'allow');
  assert.equal(updated.chatHistory?.notice, 'Stored preview shortened.');
  assert.equal(uiReducer(state, { type: 'requestHistoryChange' }), state);
});

test('foreign workspace and stale saved-chat messages cannot replace current history', () => {
  const state = restored();
  assert.equal(uiReducer(state, { type: 'chatHistory', history: history({ workspaceKey: 'other-project', revision: 50 }) }), state);
  assert.equal(uiReducer(state, { type: 'chatHistory', history: history({ revision: 1 }) }), state);
  const switched = uiReducer(state, { type: 'snapshot', configured: false, selectedModel: '', models: [], workspace: 'other-project', busy: false, events: [], chatHistory: history({ workspaceKey: 'other-project' }) });
  assert.equal(uiReducer(switched, { type: 'chatHistory', history: history({ revision: 50 }) }), switched);
});

test('current streamed response and saved prior turns have separate UI cards', () => {
  const live = { ...turn, id: 'd'.repeat(32), prompt: 'Current question', answer: 'Current answer', status: 'running' as const };
  const data = history({ activeTurnId: live.id }); data.sessions[0]!.turns.push(live);
  let state = restored(data);
  state = uiReducer(state, event({ type: 'agent.started', runId: 'current', mode: 'ask', model: 'model' }));
  state = uiReducer(state, event({ type: 'agent.text.delta', runId: 'current', text: 'Current answer' }));
  const view = render(state);
  assert.equal((view.match(/class="response-card /g) ?? []).length, 1);
  assert.equal((view.match(/aria-label="Saved conversation turn"/g) ?? []).length, 1);
  assert.equal((view.match(/Current answer/g) ?? []).length, 1);
  assert.match(view, /aria-label="Current question"/); assert.match(view, /Saving this run locally/);
  assert.match(view, /id="little-chat" disabled/); assert.match(view, /new-chat-button" disabled/);
});

test('history navigation requests are bounded and cannot carry executable metadata', () => {
  for (const value of [{ type: 'newChat' }, { type: 'selectChat', id: 'a'.repeat(32) }, { type: 'clearChatHistory' }]) assert.equal(ClientMessageSchema.safeParse(value).success, true);
  for (const value of [{ type: 'selectChat', id: '../chat' }, { type: 'selectChat', id: 'a'.repeat(32), decision: 'allow' },
    { type: 'newChat', tool: 'run_command' }, { type: 'clearChatHistory', workspace: 'outside' }]) assert.equal(ClientMessageSchema.safeParse(value).success, false);
});

test('navigation pending state clears on authoritative host snapshot or error', () => {
  const state = restored(); const pending = uiReducer(state, { type: 'requestHistoryChange' });
  assert.equal(pending.historyPending, true); assert.equal(uiReducer(pending, { type: 'requestHistoryChange' }), pending);
  const view = render(pending); assert.match(view, /Updating saved chats/); assert.match(view, /new-chat-button" disabled/);
  assert.equal(uiReducer(pending, { type: 'error', code: 'TOOL_FAILED', message: 'Chat could not be saved.' }).historyPending, false);
  assert.equal(uiReducer(pending, { type: 'chatHistory', history: history({ revision: 3 }) }).historyPending, false);
});
