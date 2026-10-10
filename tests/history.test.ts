import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ChatHistoryStore, HISTORY_LIMITS } from '../src/little/history/chat-history';
import { LittleError } from '../src/little/shared/errors';

const workspace = 'file:///C:/projects/first/same-name';
const otherWorkspace = 'file:///C:/projects/second/same-name';
type HistoryInput = Parameters<ChatHistoryStore['beginTurn']>[1];
type HistoryIds = Awaited<ReturnType<ChatHistoryStore['beginTurn']>>;
type HistorySnapshot = Awaited<ReturnType<ChatHistoryStore['snapshot']>>;
type HistoryTurn = HistorySnapshot['sessions'][number]['turns'][number];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Each read crosses JSON serialization, like a reconstructed persisted Memento. */
class JsonStorage {
  readonly values = new Map<string, string>();
  readonly writes: { key: string; json: string | undefined }[] = [];
  beforeCommit?: () => Promise<void>;
  failure?: Error;
  activeWrites = 0;
  maximumActiveWrites = 0;

  get(key: string): unknown {
    const json = this.values.get(key);
    return json === undefined ? undefined : JSON.parse(json);
  }

  async update(key: string, value: unknown): Promise<void> {
    const json = value === undefined ? undefined : JSON.stringify(value);
    this.writes.push({ key, json });
    this.activeWrites += 1;
    this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
    try {
      await this.beforeCommit?.();
      if (this.failure) throw this.failure;
      if (json === undefined) this.values.delete(key);
      else this.values.set(key, json);
    } finally { this.activeWrites -= 1; }
  }
}

function fixture(t: TestContext) {
  const storage = new JsonStorage();
  const instances: ChatHistoryStore[] = [];
  let clock = 1_700_000_000_000, identity = 0;
  function restart() {
    const history = new ChatHistoryStore(storage, {
      now: () => ++clock,
      id: () => (++identity).toString(16).padStart(32, '0'),
      saveDelayMs: 60_000,
    });
    instances.push(history);
    return history;
  }
  t.after(async () => {
    storage.failure = undefined;
    storage.beforeCommit = undefined;
    await Promise.all(instances.map(history => history.flush()));
  });
  return { storage, history: restart(), restart };
}

function input(prompt: string, extras: Partial<HistoryInput> = {}): HistoryInput {
  return { prompt, mode: 'ask', model: 'test-model', provider: 'groq', ...extras };
}

async function completed(history: ChatHistoryStore, prompt: string, answer: string, root = workspace, extras: Partial<HistoryInput> = {}) {
  const ids = await history.beginTurn(root, input(prompt, extras));
  history.appendText(root, ids.turnId, answer);
  await history.finishTurn(root, ids.turnId, 'completed');
  return ids;
}

function turn(snapshot: HistorySnapshot, id: string): HistoryTurn {
  const found = snapshot.sessions.flatMap(session => session.turns).find(entry => entry.id === id);
  assert.ok(found, `Turn ${id} is present.`);
  return found;
}

function persisted(storage: JsonStorage) {
  assert.equal(storage.values.size, 1);
  const [key, json] = storage.values.entries().next().value!;
  return { key, json, record: JSON.parse(json) as Record<string, unknown> };
}

test('completed conversation survives serialized persistence and a reconstructed store', async t => {
  const { history, storage, restart } = fixture(t);
  const empty = await history.snapshot(workspace);
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.selectedId, null);
  assert.equal(empty.notice, undefined);

  const first = await completed(history, 'Explain this workspace', 'The workspace uses TypeScript.');
  const second = await completed(history, 'Plan the next change', 'Inspect the existing implementation first.', workspace, { mode: 'plan', provider: 'ollama', model: 'local-model' });
  assert.equal(first.sessionId, second.sessionId);
  const saved = await history.snapshot(workspace);
  assert.equal(saved.selectedId, first.sessionId);
  assert.ok(saved.revision > empty.revision);
  assert.equal(saved.sessions.length, 1);
  assert.ok(saved.sessions[0]!.title.length > 0);
  assert.equal(turn(saved, first.turnId).answer, 'The workspace uses TypeScript.');
  assert.deepEqual({ mode: turn(saved, second.turnId).mode, provider: turn(saved, second.turnId).provider, model: turn(saved, second.turnId).model }, { mode: 'plan', provider: 'ollama', model: 'local-model' });
  assert.ok(saved.sessions.every(session => session.createdAt <= session.updatedAt));
  assert.ok(saved.sessions.flatMap(session => session.turns).every(entry => entry.status === 'completed' && entry.createdAt <= entry.updatedAt));
  const reconstructed = await restart().snapshot(workspace);
  assert.equal(reconstructed.workspaceKey, saved.workspaceKey);
  assert.equal(reconstructed.selectedId, saved.selectedId);
  assert.deepEqual(reconstructed.sessions, saved.sessions);
  assert.equal(reconstructed.notice, undefined);
  assert.ok(persisted(storage).json.includes('The workspace uses TypeScript.'));

  saved.sessions[0]!.turns[0]!.answer = 'Mutated consumer copy';
  assert.equal(turn(await history.snapshot(workspace), first.turnId).answer, 'The workspace uses TypeScript.');
  assert.equal(turn(await restart().snapshot(workspace), first.turnId).answer, 'The workspace uses TypeScript.');
});

test('streamed deltas are durably flushed and a restart interrupts only unfinished turns', async t => {
  const { history, restart } = fixture(t);
  const done = await completed(history, 'Earlier question', 'Earlier answer.');
  const running = await history.beginTurn(workspace, input('Question still in progress', { mode: 'agent' }));
  history.appendText(workspace, running.turnId, 'First chunk. ');
  history.appendText(workspace, running.turnId, 'Second chunk.');
  await history.flush();
  const live = await history.snapshot(workspace);
  assert.equal(turn(live, running.turnId).status, 'running');
  assert.equal(turn(live, running.turnId).answer, 'First chunk. Second chunk.');

  const recovered = restart();
  const restored = await recovered.snapshot(workspace);
  assert.equal(turn(restored, running.turnId).status, 'interrupted');
  assert.equal(turn(restored, running.turnId).answer, 'First chunk. Second chunk.');
  assert.equal(turn(restored, done.turnId).status, 'completed');
  assert.equal(turn(await history.snapshot(workspace), running.turnId).status, 'running');
  await recovered.flush();
  assert.equal(turn(await restart().snapshot(workspace), running.turnId).status, 'interrupted');
  assert.deepEqual(await recovered.snapshot(workspace), restored);
});

test('new chat, selection, and clear persist without reviving cleared running output', async t => {
  const { history, restart } = fixture(t);
  const first = await completed(history, 'First chat question', 'First chat answer.');
  await history.newSession(workspace);
  const fresh = await history.snapshot(workspace);
  assert.ok(fresh.selectedId);
  assert.notEqual(fresh.selectedId, first.sessionId);
  assert.deepEqual(fresh.sessions.find(session => session.id === fresh.selectedId)!.turns, []);
  const second = await completed(history, 'Second chat question', 'Second chat answer.');
  assert.equal(second.sessionId, fresh.selectedId);
  await history.selectSession(workspace, first.sessionId);
  const followup = await completed(history, 'Follow up in the first chat', 'First chat follow up.');
  assert.equal(followup.sessionId, first.sessionId);
  assert.equal((await restart().snapshot(workspace)).selectedId, first.sessionId);

  await completed(history, 'Other workspace question', 'Other workspace answer.', otherWorkspace);
  const running = await history.beginTurn(workspace, input('Clear this running question'));
  await history.clearWorkspace(workspace);
  history.appendText(workspace, running.turnId, 'Late cancelled run output');
  await history.finishTurn(workspace, running.turnId, 'cancelled');
  await history.flush();
  const cleared = await restart().snapshot(workspace);
  assert.deepEqual(cleared.sessions, []);
  assert.equal(cleared.selectedId, null);
  assert.equal((await restart().snapshot(otherWorkspace)).sessions[0]!.turns[0]!.answer, 'Other workspace answer.');
});

test('identically named workspace URIs use separate opaque SHA-256 storage keys', async t => {
  const { history, storage, restart } = fixture(t);
  await completed(history, 'Workspace one only', 'Answer one.');
  await completed(history, 'Workspace two only', 'Answer two.', otherWorkspace);
  const first = await history.snapshot(workspace), second = await history.snapshot(otherWorkspace);
  assert.notEqual(first.workspaceKey, second.workspaceKey);
  assert.equal(storage.values.size, 2);
  for (const [key, json] of storage.values) {
    assert.match(key, /[a-f0-9]{64}$/);
    assert.ok(!key.includes(workspace) && !key.includes(otherWorkspace));
    assert.ok(!json.includes(workspace) && !json.includes(otherWorkspace));
  }
  assert.equal((await restart().snapshot(workspace)).sessions[0]!.turns[0]!.prompt, 'Workspace one only');
  assert.equal((await restart().snapshot(otherWorkspace)).sessions[0]!.turns[0]!.prompt, 'Workspace two only');
});

test('concurrent durable operations serialize gated writes without losing either workspace', async t => {
  const { history, storage, restart } = fixture(t);
  await history.snapshot(workspace);
  await history.snapshot(otherWorkspace);
  const started = deferred(), release = deferred();
  let writes = 0;
  storage.beforeCommit = async () => {
    if (++writes === 1) { started.resolve(); await release.promise; }
  };
  const firstPending = history.beginTurn(workspace, input('Concurrent first question'));
  await started.promise;
  const secondPending = history.beginTurn(otherWorkspace, input('Concurrent second question'));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(storage.activeWrites, 1);
  } finally { release.resolve(); }
  const [first, second] = await Promise.all([firstPending, secondPending]);
  history.appendText(workspace, first.turnId, 'First concurrent answer.');
  history.appendText(otherWorkspace, second.turnId, 'Second concurrent answer.');
  await Promise.all([history.finishTurn(workspace, first.turnId, 'completed'), history.finishTurn(otherWorkspace, second.turnId, 'completed')]);
  assert.equal(storage.maximumActiveWrites, 1);
  assert.equal(turn(await restart().snapshot(workspace), first.turnId).answer, 'First concurrent answer.');
  assert.equal(turn(await restart().snapshot(otherWorkspace), second.turnId).answer, 'Second concurrent answer.');
});

test('concurrent turns in one chat keep every prompt and completion after restart', async t => {
  const { history, restart } = fixture(t);
  await history.newSession(workspace);
  const ids = await Promise.all(Array.from({ length: 6 }, (_, index) => history.beginTurn(workspace, input(`Concurrent turn ${index}`))));
  assert.equal(new Set(ids.map(entry => entry.turnId)).size, ids.length);
  assert.equal(new Set(ids.map(entry => entry.sessionId)).size, 1);
  await Promise.all(ids.map(async (entry, index) => {
    history.appendText(workspace, entry.turnId, `Concurrent answer ${index}`);
    await history.finishTurn(workspace, entry.turnId, 'completed');
  }));
  const restored = await restart().snapshot(workspace);
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0]!.turns.length, ids.length);
  for (const [index, entry] of ids.entries()) {
    assert.equal(turn(restored, entry.turnId).prompt, `Concurrent turn ${index}`);
    assert.equal(turn(restored, entry.turnId).answer, `Concurrent answer ${index}`);
    assert.equal(turn(restored, entry.turnId).status, 'completed');
  }
});

test('failed persistence rejects durable operations with a fixed safe notice and preserves saved backing', async t => {
  const { history, storage, restart } = fixture(t);
  await completed(history, 'Successfully saved question', 'Successfully saved answer.');
  const saved = new Map(storage.values);
  storage.failure = new Error('Private disk error password=do-not-expose-this');
  let safeMessage = '';
  await assert.rejects(history.beginTurn(workspace, input('Unsaved question')), error => {
    assert.ok(error instanceof LittleError);
    safeMessage = error.message;
    assert.ok(!safeMessage.includes('do-not-expose-this'));
    return true;
  });
  assert.deepEqual(storage.values, saved);
  const failed = await history.snapshot(workspace);
  assert.ok(failed.notice);
  assert.ok(!failed.notice.includes('do-not-expose-this'));
  assert.match(failed.notice, /sav|stor|persist/i);
  storage.failure = new Error('Another unrelated private filesystem message');
  await assert.rejects(history.newSession(workspace), error => error instanceof LittleError && error.message === safeMessage);
  assert.equal((await history.snapshot(workspace)).notice, failed.notice);
  assert.deepEqual(storage.values, saved);
  const recovered = await restart().snapshot(workspace);
  assert.deepEqual(recovered.sessions.flatMap(session => session.turns).map(entry => entry.prompt), ['Successfully saved question']);
  storage.failure = undefined;
  await history.flush();
  assert.equal((await history.snapshot(workspace)).notice, undefined);
});

test('a failed clear is not reported as durable and saved chats remain recoverable after restart', async t => {
  const { history, storage, restart } = fixture(t);
  const savedTurn = await completed(history, 'Keep this saved conversation', 'This answer remains on disk.');
  const saved = new Map(storage.values);
  storage.failure = new Error('Private clear failure');
  await assert.rejects(history.clearWorkspace(workspace), error => error instanceof LittleError);
  assert.deepEqual(storage.values, saved);
  assert.ok((await history.snapshot(workspace)).notice);
  storage.failure = undefined;
  const recovered = await restart().snapshot(workspace);
  assert.equal(recovered.selectedId, savedTurn.sessionId);
  assert.equal(turn(recovered, savedTurn.turnId).answer, 'This answer remains on disk.');
});

test('corrupt and unknown-schema records show a safe notice without automatic overwrite', async t => {
  const { history, storage, restart } = fixture(t);
  await completed(history, 'Seed question', 'Seed answer.');
  const { key, record } = persisted(storage);
  const session = (record.sessions as Record<string, unknown>[])[0]!;
  const entry = (session.turns as Record<string, unknown>[])[0]!;
  const cases: unknown[] = [
    null, '{broken json', [], { ...record, version: 999 }, { ...record, sessions: 'not-an-array' },
    { ...record, selectedId: 'f'.repeat(32) }, { ...record, sessions: [session, session] },
    { ...record, sessions: [{ ...session, turns: [entry, entry] }] },
    { ...record, sessions: [{ ...session, turns: [{ ...entry, status: 'executing' }] }] },
    { ...record, sessions: [{ ...session, turns: [{ ...entry, provider: 'unknown-provider' }] }] },
    { ...record, sessions: [{ ...session, turns: [{ ...entry, createdAt: -1 }] }] },
    { ...record, sessions: [{ ...session, turns: [{ ...entry, createdAt: Number.MAX_SAFE_INTEGER }] }] },
    { ...record, sessions: [{ ...session, turns: [{ ...entry, answer: 'x'.repeat(HISTORY_LIMITS.answerCharacters + 1) }] }] },
  ];
  let notice: string | undefined;
  for (const candidate of cases) {
    const json = JSON.stringify(candidate);
    storage.values.set(key, json);
    const writes = storage.writes.length;
    const reconstructed = restart();
    const recovered = await reconstructed.snapshot(workspace);
    assert.deepEqual(recovered.sessions, []);
    assert.equal(recovered.selectedId, null);
    assert.ok(recovered.notice);
    notice ??= recovered.notice;
    assert.equal(recovered.notice, notice);
    await reconstructed.flush();
    assert.equal(storage.values.get(key), json);
    assert.equal(storage.writes.length, writes);
  }
  const cleared = restart();
  await cleared.clearWorkspace(workspace);
  const empty = await restart().snapshot(workspace);
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.notice, undefined);
});

test('restored title redaction stays within schema bounds after another durable save', async t => {
  const { history, storage, restart } = fixture(t);
  const saved = await completed(history, 'A question', 'A public answer.');
  const { key, record } = persisted(storage);
  const session = (record.sessions as Record<string, unknown>[])[0]!;
  session.title = `${'x'.repeat(84)} apiKey=foo`;
  storage.values.set(key, JSON.stringify(record));
  const reconstructed = restart();
  const loaded = await reconstructed.snapshot(workspace);
  assert.ok(loaded.sessions[0]!.title.length <= 96);
  assert.doesNotMatch(loaded.sessions[0]!.title, /foo/);
  await reconstructed.selectSession(workspace, saved.sessionId);
  const durable = await restart().snapshot(workspace);
  assert.equal(durable.sessions.length, 1);
  assert.equal(turn(durable, saved.turnId).answer, 'A public answer.');
});

test('unreadable serialized backing reports a safe read notice without replacing the original data', async t => {
  const { history, storage, restart } = fixture(t);
  await completed(history, 'Seed read question', 'Seed read answer.');
  const { key } = persisted(storage);
  const raw = '{invalid-json private-read-marker', writes = storage.writes.length;
  storage.values.set(key, raw);
  const reconstructed = restart();
  const recovered = await reconstructed.snapshot(workspace);
  assert.deepEqual(recovered.sessions, []);
  assert.equal(recovered.selectedId, null);
  assert.match(recovered.notice ?? '', /read|load/i);
  assert.ok(!recovered.notice!.includes('private-read-marker'));
  await reconstructed.flush();
  assert.equal(storage.values.get(key), raw);
  assert.equal(storage.writes.length, writes);
});

test('persisted executable fields and raw runtime metadata are rejected at every record level', async t => {
  const { history, storage, restart } = fixture(t);
  await completed(history, 'Show me an example command', 'The command example is ordinary conversation text.', workspace, { mode: 'edit' });
  const { key, record } = persisted(storage);
  const session = (record.sessions as Record<string, unknown>[])[0]!;
  const entry = (session.turns as Record<string, unknown>[])[0]!;
  const forbidden = {
    runId: 'runtime-run-id',
    events: [{ type: 'command.started', runId: 'runtime-run-id' }],
    toolCalls: [{ id: 'call-id', name: 'run_command', arguments: '{"program":"deploy"}' }],
    approvals: { command: true },
    quota: { retryAfterMs: 60_000 },
    command: { program: 'deploy', args: ['--production'] },
  };
  for (const [field, value] of Object.entries(forbidden)) {
    const candidates = [
      { ...record, [field]: value },
      { ...record, sessions: [{ ...session, [field]: value }] },
      { ...record, sessions: [{ ...session, turns: [{ ...entry, [field]: value }] }] },
    ];
    for (const candidate of candidates) {
      const json = JSON.stringify(candidate), writes = storage.writes.length;
      storage.values.set(key, json);
      const reconstructed = restart();
      const recovered = await reconstructed.snapshot(workspace);
      assert.deepEqual(recovered.sessions, [], `Reject ${field} instead of restoring action metadata.`);
      assert.ok(recovered.notice);
      assert.ok(!recovered.notice.includes('deploy'));
      await reconstructed.flush();
      assert.equal(storage.values.get(key), json);
      assert.equal(storage.writes.length, writes);
    }
  }
});

test('terminal history restores display fields without runtime replay or extra persistence writes', async t => {
  const { history, storage, restart } = fixture(t);
  await completed(history, 'Describe how to run npm test', 'Run npm test when you decide to verify the project.', workspace, { mode: 'agent' });
  const { json } = persisted(storage);
  const restored = restart(), writes = storage.writes.length;
  const snapshot = await restored.snapshot(workspace);
  assert.deepEqual(await restored.snapshot(workspace), snapshot);
  await restored.flush();
  assert.equal(storage.writes.length, writes);
  const sessionKeys = ['id', 'title', 'createdAt', 'updatedAt', 'turns'];
  const turnKeys = ['id', 'prompt', 'answer', 'mode', 'provider', 'model', 'createdAt', 'updatedAt', 'status', 'truncated'];
  assert.ok(snapshot.sessions.every(session => Object.keys(session).every(key => sessionKeys.includes(key))));
  assert.ok(snapshot.sessions.flatMap(session => session.turns).every(entry => Object.keys(entry).every(key => turnKeys.includes(key))));
  for (const field of ['runId', 'toolCalls', 'toolCallId', 'approvals', 'retryAfterMs', 'command.started', 'agent.started']) assert.ok(!json.includes(field));
  assert.equal(snapshot.sessions[0]!.turns[0]!.answer, 'Run npm test when you decide to verify the project.');
});

test('secrets and pasted private provider payloads are removed before persistence and continuity', async t => {
  const { history, storage, restart } = fixture(t);
  const secret = `gsk_${'a'.repeat(40)}`;
  const prompt = `Explain this public example. API_KEY="${secret}"\n<think>private-prompt-thought</think>\n{"failed_generation":"private-prompt-payload"}`;
  const ids = await history.beginTurn(workspace, input(prompt));
  history.appendText(workspace, ids.turnId, `Public result. ${secret.slice(0, 20)}`);
  await history.flush();
  history.appendText(workspace, ids.turnId, `${secret.slice(20)}\npassword="private-password"\n<think>private-answer-thought</think>\n{"failed_generation":"private-answer-payload"}`);
  await history.finishTurn(workspace, ids.turnId, 'completed');
  const snapshot = await restart().snapshot(workspace), entry = turn(snapshot, ids.turnId);
  const persistedText = storage.writes.flatMap(write => write.json === undefined ? [] : [write.json]).join('\n');
  const context = history.conversationContext(workspace);
  for (const privateText of [secret, secret.slice(0, 20), secret.slice(20), 'private-password', 'private-prompt-thought', 'private-prompt-payload', 'private-answer-thought', 'private-answer-payload']) {
    assert.ok(!entry.prompt.includes(privateText));
    assert.ok(!entry.answer.includes(privateText));
    assert.ok(!persistedText.includes(privateText));
    assert.ok(!context.text.includes(privateText));
  }
  assert.ok(entry.prompt.includes('Explain this public example.'));
  assert.ok(entry.answer.includes('Public result.'));
});

test('private reasoning and provider payload redaction survive deltas split inside their contents', async t => {
  const { history, storage, restart } = fixture(t);
  const reasoning = await history.beginTurn(workspace, input('Public reasoning example'));
  history.appendText(workspace, reasoning.turnId, '<think>private-reasoning-start');
  await history.flush();
  history.appendText(workspace, reasoning.turnId, ' private-reasoning-finish</think>Public result.');
  await history.finishTurn(workspace, reasoning.turnId, 'completed');
  const provider = await history.beginTurn(workspace, input('Public provider example'));
  history.appendText(workspace, provider.turnId, 'Visible diagnostic.\n{"failed_generation":"private-provider-start');
  await history.flush();
  history.appendText(workspace, provider.turnId, ' private-provider-finish"}');
  await history.finishTurn(workspace, provider.turnId, 'completed');
  const snapshot = await restart().snapshot(workspace);
  const saved = storage.writes.flatMap(write => write.json === undefined ? [] : [write.json]).join('\n');
  const context = history.conversationContext(workspace).text;
  for (const marker of ['private-reasoning-start', 'private-reasoning-finish', 'private-provider-start', 'private-provider-finish']) {
    assert.ok(!JSON.stringify(snapshot).includes(marker));
    assert.ok(!saved.includes(marker));
    assert.ok(!context.includes(marker));
  }
  assert.ok(turn(snapshot, reasoning.turnId).answer.includes('Public result.'));
  assert.ok(turn(snapshot, provider.turnId).answer.includes('Visible diagnostic.'));
});

test('prompt and streamed answer character limits retain a visible truncation flag', async t => {
  const { history, restart } = fixture(t);
  assert.equal(HISTORY_LIMITS.promptCharacters, 8000);
  assert.equal(HISTORY_LIMITS.answerCharacters, 32000);
  const ids = await history.beginTurn(workspace, input('p'.repeat(HISTORY_LIMITS.promptCharacters + 500)));
  history.appendText(workspace, ids.turnId, 'a'.repeat(HISTORY_LIMITS.answerCharacters - 10));
  history.appendText(workspace, ids.turnId, 'b'.repeat(1000));
  await history.finishTurn(workspace, ids.turnId, 'completed');
  const entry = turn(await restart().snapshot(workspace), ids.turnId);
  assert.ok(entry.prompt.length <= HISTORY_LIMITS.promptCharacters);
  assert.ok(entry.answer.length <= HISTORY_LIMITS.answerCharacters);
  assert.equal(entry.truncated, true);
  assert.ok(entry.prompt.startsWith('pppp'));
  assert.ok(entry.answer.startsWith('aaaa'));
});

test('oldest turns and chats are pruned at the declared limits while the newest remain selected', async t => {
  const { history, restart } = fixture(t);
  assert.equal(HISTORY_LIMITS.sessions, 20);
  assert.equal(HISTORY_LIMITS.turns, 30);
  const turns: HistoryIds[] = [];
  for (let index = 0; index < HISTORY_LIMITS.turns + 2; index += 1) turns.push(await completed(history, `Bounded turn ${index}`, `Answer ${index}`));
  const bounded = await history.snapshot(workspace);
  assert.equal(bounded.sessions[0]!.turns.length, HISTORY_LIMITS.turns);
  assert.ok(!bounded.sessions[0]!.turns.some(entry => entry.id === turns[0]!.turnId || entry.id === turns[1]!.turnId));
  assert.ok(bounded.sessions[0]!.turns.some(entry => entry.id === turns.at(-1)!.turnId));

  const sessions = [turns[0]!.sessionId];
  for (let index = 1; index < HISTORY_LIMITS.sessions + 2; index += 1) {
    await history.newSession(workspace);
    sessions.push((await completed(history, `Bounded chat ${index}`, `Chat answer ${index}`)).sessionId);
  }
  const restored = await restart().snapshot(workspace);
  assert.equal(restored.sessions.length, HISTORY_LIMITS.sessions);
  assert.equal(restored.selectedId, sessions.at(-1));
  assert.ok(!restored.sessions.some(session => session.id === sessions[0] || session.id === sessions[1]));
  assert.ok(restored.sessions.some(session => session.id === sessions.at(-1)));
});

test('UTF-8 serialized workspace bytes stay bounded independently of chat and character counts', async t => {
  const { history, storage, restart } = fixture(t);
  assert.equal(HISTORY_LIMITS.workspaceBytes, 524288);
  let latest!: HistoryIds;
  for (let session = 0; session < 2; session += 1) {
    if (session) await history.newSession(workspace);
    for (let index = 0; index < 4; index += 1) latest = await completed(history, `Large UTF-8 result ${session}-${index}`, '界'.repeat(HISTORY_LIMITS.answerCharacters));
  }
  for (const write of storage.writes) if (write.json !== undefined) assert.ok(Buffer.byteLength(write.json, 'utf8') <= HISTORY_LIMITS.workspaceBytes);
  const restored = await restart().snapshot(workspace);
  assert.ok(restored.sessions.length <= HISTORY_LIMITS.sessions);
  assert.ok(restored.sessions.every(session => session.turns.length <= HISTORY_LIMITS.turns));
  assert.ok(restored.sessions.flatMap(session => session.turns).length < 8);
  assert.equal(restored.selectedId, latest.sessionId);
  assert.ok(turn(restored, latest.turnId).answer.startsWith('界'));
});

test('continuity uses only the selected chat last four completed pairs and excludes all unfinished states', async t => {
  const { history, restart } = fixture(t);
  const completedIds: HistoryIds[] = [];
  for (let index = 0; index < 6; index += 1) completedIds.push(await completed(history, `Completed prompt marker ${index}`, `Completed answer marker ${index}`));
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const ids = await history.beginTurn(workspace, input(`Excluded ${status} prompt`));
    history.appendText(workspace, ids.turnId, `Excluded ${status} answer`);
    await history.finishTurn(workspace, ids.turnId, status);
  }
  const running = await history.beginTurn(workspace, input('Excluded running prompt'));
  history.appendText(workspace, running.turnId, 'Excluded running answer');
  await history.flush();
  const context = history.conversationContext(workspace);
  assert.ok(context.text.length <= 3000);
  assert.match(context.text, /untrusted/i);
  assert.match(context.text, /prior|previous/i);
  assert.match(context.text, /permission/i);
  assert.match(context.text, /fresh|source|evidence/i);
  for (let index = 0; index < 6; index += 1) {
    assert.equal(context.text.includes(`Completed prompt marker ${index}`), index >= 2);
    assert.equal(context.text.includes(`Completed answer marker ${index}`), index >= 2);
  }
  assert.ok(!context.text.includes('Excluded'));
  assert.ok(context.items.every(item => item.type === 'workspace' && item.estimatedTokens > 0));
  assert.ok(Object.keys(context).every(key => ['text', 'items', 'sections'].includes(key)));

  await history.newSession(workspace);
  assert.equal(history.conversationContext(workspace).text, '');
  assert.deepEqual(history.conversationContext(workspace).items, []);
  await completed(history, 'Other selected chat prompt', 'Other selected chat answer.');
  assert.ok(!history.conversationContext(workspace).text.includes('Completed prompt marker'));
  await history.selectSession(workspace, completedIds[0]!.sessionId);
  assert.ok(history.conversationContext(workspace).text.includes('Completed prompt marker 5'));
  assert.ok(!history.conversationContext(workspace).text.includes('Other selected chat'));
  const reconstructed = restart();
  await reconstructed.snapshot(workspace);
  assert.equal(reconstructed.conversationContext(workspace).text, context.text);
  await reconstructed.snapshot(otherWorkspace);
  assert.equal(reconstructed.conversationContext(otherWorkspace).text, '');
  assert.deepEqual(reconstructed.conversationContext(otherWorkspace).items, []);
});

test('continuity counts labels inside the 3,000-character bound for long completed pairs', async t => {
  const { history } = fixture(t);
  for (let index = 0; index < 5; index += 1) {
    await completed(history, `Long prompt ${index}: ${'p'.repeat(HISTORY_LIMITS.promptCharacters - 100)}`, `Long answer ${index}: ${'a'.repeat(HISTORY_LIMITS.answerCharacters - 100)}`);
  }
  const context = history.conversationContext(workspace);
  assert.ok(context.text.length > 0 && context.text.length <= 3000);
  assert.ok(context.text.includes('Long prompt 4:'));
  assert.ok(context.text.includes('Long answer 4:'));
  assert.ok(!context.text.includes('Long prompt 0:'));
  assert.match(context.text, /untrusted/i);
});
