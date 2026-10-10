import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { REVIEW_TEAM_LIMITS, runReviewTeam, type ReviewRole } from '../src/little/agent/review-team';
import type { AgentTool, LLMEvent, LLMProvider, LLMRequest, RunContext } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';

function context(): RunContext { return { text: 'ORIGINAL_CONTEXT: auth module has an exported function.', items: [{ id: 'workspace', label: 'Fixture workspace', type: 'workspace', estimatedTokens: 12 }] }; }
function role(request: LLMRequest): ReviewRole { return request.messages.some(message => message.role === 'user' && message.content.includes('architecture reviewer')) ? 'architecture' : 'verification'; }
function provider(stream: (request: LLMRequest, signal?: AbortSignal) => AsyncIterable<LLMEvent>): LLMProvider { return { id: 'review-fixture', listModels: async () => [], stream }; }
function safeTool(name = 'read_context', execute: AgentTool['execute'] = async () => ({ inspected: true })): AgentTool {
  return { name, description: 'Read bounded local context', parameters: { type: 'object' }, risk: 'SAFE', validate: input => input, execute };
}
async function workspaceFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'little-review-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('little-review-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'auth.ts'), 'export function freshlyInspectedAuth() {}\nconst apiKey = "gsk_abcdefghijklmnopqrstuvwxyz0123456789";');
  return { root, workspace: new WorkspaceService(root) };
}

test('two actual runtimes review in parallel with fresh local reads and isolated context and conversation state', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const tools = createReadOnlyTools(workspace, { snapshot: () => ({ openFiles: [], diagnostics: [] }) });
  const reads: string[] = [];
  const originalRead = tools.find(tool => tool.name === 'read_file');
  assert.ok(originalRead);
  const execute = originalRead.execute.bind(originalRead);
  originalRead.execute = async (input, execution) => { reads.push(execution.runId ?? ''); return execute(input, execution); };
  const supplied = context();
  let active = 0;
  let peak = 0;
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const initialMessages = new Map<ReviewRole, string>();
  const fixture = provider(async function* (request) {
    const reviewer = role(request);
    active++; peak = Math.max(peak, active);
    try {
      if (!request.messages.some(message => message.role === 'tool')) {
        initialMessages.set(reviewer, JSON.stringify(request.messages));
        if (reviewer === 'architecture') request.messages[0]!.content += '\nARCHITECTURE_ONLY_MUTATION';
        arrived++;
        if (arrived === 2) release();
        await barrier;
        yield { type: 'tool_call', call: { id: `inspect_${reviewer}`, name: 'read_file', arguments: '{"path":"auth.ts"}' } };
        yield { type: 'done', reason: 'tool_calls' };
      } else {
        const observation = request.messages.find(message => message.role === 'tool')?.content ?? '';
        assert.ok(observation.includes('freshlyInspectedAuth'));
        assert.ok(!observation.includes('gsk_abcdefghijklmnopqrstuvwxyz0123456789'));
        yield { type: 'text', text: `${reviewer} inspected freshlyInspectedAuth.` };
        yield { type: 'done', reason: 'stop' };
      }
    } finally { active--; }
  });
  const progress: { role: ReviewRole; state: string }[] = [];
  const result = await runReviewTeam({ provider: { ...fixture, id: 'ollama' }, tools, context: supplied, prompt: 'Review auth architecture and failure cases.', model: 'fixture', signal: new AbortController().signal,
    onProgress(review) { progress.push(review); supplied.text = 'CHANGED_PARENT_CONTEXT'; supplied.items[0]!.label = 'CHANGED_PARENT_LABEL'; } });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(reads.length, 2);
  assert.equal(new Set(reads).size, 2);
  assert.deepEqual(result.reviews.map(review => [review.role, review.state]), [['architecture', 'completed'], ['verification', 'completed']]);
  assert.ok(result.reviews.every(review => review.text.includes('freshlyInspectedAuth')));
  assert.ok(result.reviews[1]?.text.includes('No commands or checks were executed.'));
  for (const messages of initialMessages.values()) { assert.ok(messages.includes('ORIGINAL_CONTEXT')); assert.ok(!messages.includes('CHANGED_PARENT_CONTEXT')); }
  assert.ok(!initialMessages.get('verification')?.includes('ARCHITECTURE_ONLY_MUTATION'));
  assert.deepEqual(progress.filter(review => review.state === 'running').map(review => review.role), ['architecture', 'verification']);
  assert.equal(progress.filter(review => review.state === 'completed').length, 2);
});

test('child registries omit writes, execution, sensitive actions, MCP, and recursive delegation tools', async () => {
  let privilegedCalls = 0;
  const blocked = (name: string, risk: AgentTool['risk']): AgentTool => ({ ...safeTool(name, async () => { privilegedCalls++; return 'should not run'; }), risk });
  const tools = [safeTool(), blocked('edit_file', 'WORKSPACE_WRITE'), blocked('run_command', 'EXECUTION'), blocked('sensitive', 'SENSITIVE'), blocked('dangerous', 'DANGEROUS'), blocked('delegate_reviews', 'SAFE'), blocked('mcp__remote__read', 'SAFE')];
  const advertised: string[][] = [];
  const fixture = provider(async function* (request) {
    advertised.push(request.tools?.map(tool => tool.name) ?? []);
    if (!request.messages.some(message => message.role === 'tool')) {
      yield { type: 'tool_call', call: { id: `blocked_${role(request)}`, name: role(request) === 'architecture' ? 'delegate_reviews' : 'mcp__remote__read', arguments: '{}' } };
      yield { type: 'done', reason: 'tool_calls' };
    } else {
      const feedback = request.messages.find(message => message.role === 'tool')?.content ?? '';
      assert.ok(/error|failed|unknown|registered/i.test(feedback));
      yield { type: 'text', text: 'The requested tool is unavailable; this is a read-only review.' };
      yield { type: 'done', reason: 'stop' };
    }
  });
  const result = await runReviewTeam({ provider: fixture, tools, context: context(), prompt: 'Review safely.', model: 'fixture', signal: new AbortController().signal });
  assert.equal(privilegedCalls, 0);
  assert.ok(advertised.every(names => names.length === 1 && names[0] === 'read_context'));
  assert.ok(result.reviews.every(review => review.state === 'completed'));
});

test('changing a tool risk after registration cannot grant a read-only worker execution privileges', async () => {
  let executed = 0;
  const read = safeTool('read_context', async () => { executed++; return {}; });
  const fixture = provider(async function* (request) {
    if (!request.messages.some(message => message.role === 'tool')) {
      yield { type: 'tool_call', call: { id: `inspect_${role(request)}`, name: 'read_context', arguments: '{}' } };
      yield { type: 'done', reason: 'tool_calls' };
    } else { yield { type: 'text', text: 'The tool was denied.' }; yield { type: 'done', reason: 'stop' }; }
  });
  const result = await runReviewTeam({ provider: fixture, tools: [read], context: context(), prompt: 'Review safely.', model: 'fixture', signal: new AbortController().signal,
    onProgress(review) { if (review.state === 'running') read.risk = 'EXECUTION'; } });
  assert.equal(executed, 0);
  assert.ok(result.reviews.every(review => review.state === 'completed'));
});

test('external cancellation stops both workers and awaits their provider cleanup without claiming completion', async () => {
  let waiting = 0;
  let settled = 0;
  let announce!: () => void;
  const bothWaiting = new Promise<void>(resolve => { announce = resolve; });
  const controller = new AbortController();
  const fixture = provider(async function* (_request, signal) {
    assert.ok(signal);
    let abort!: () => void;
    try {
      yield { type: 'text', text: 'Partial inspection.' };
      await new Promise<void>((_resolve, reject) => {
        abort = () => reject(new LittleError('AGENT_CANCELLED', 'Worker stopped.'));
        signal.addEventListener('abort', abort, { once: true });
        waiting++;
        if (waiting === 2) announce();
        if (signal.aborted) abort();
      });
      yield { type: 'done', reason: 'stop' };
    } finally { signal.removeEventListener('abort', abort); settled++; }
  });
  const pending = runReviewTeam({ provider: fixture, tools: [], context: context(), prompt: 'Review.', model: 'fixture', signal: controller.signal });
  await bothWaiting;
  controller.abort();
  const result = await pending;
  assert.equal(settled, 2);
  assert.deepEqual(result.reviews.map(review => review.state), ['cancelled', 'cancelled']);
  assert.ok(result.reviews.every(review => review.text.includes('Partial inspection.') && review.error?.includes('cancelled')));
});

test('one failed review preserves the successful peer result and redacts failure diagnostics', async () => {
  const fixture = provider(async function* (request) {
    if (role(request) === 'architecture') { yield { type: 'text', text: 'Partial architectural evidence.' }; throw new LittleError('PROVIDER_UNAVAILABLE', 'Unavailable gsk_abcdefghijklmnopqrstuvwxyz0123456789'); }
    yield { type: 'text', text: 'Suggested check: cover expired sessions.' };
    yield { type: 'done', reason: 'stop' };
  });
  const result = await runReviewTeam({ provider: fixture, tools: [], context: context(), prompt: 'Review.', model: 'fixture', signal: new AbortController().signal });
  assert.equal(result.reviews[0]?.state, 'failed');
  assert.ok(result.reviews[0]?.text.includes('Partial architectural evidence.'));
  assert.ok(!JSON.stringify(result).includes('gsk_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.equal(result.reviews[1]?.state, 'completed');
  assert.ok(result.reviews[1]?.text.includes('No commands or checks were executed.'));
});

test('output bounds cancel oversized reviews and never label clipped text as completed', async () => {
  const fixture = provider(async function* () { yield { type: 'text', text: 'x'.repeat(REVIEW_TEAM_LIMITS.outputChars + 500) }; yield { type: 'done', reason: 'stop' }; });
  const result = await runReviewTeam({ provider: fixture, tools: [], context: context(), prompt: 'Review.', model: 'fixture', signal: new AbortController().signal });
  for (const review of result.reviews) { assert.equal(review.state, 'failed'); assert.ok(review.text.length <= REVIEW_TEAM_LIMITS.outputChars); assert.ok(review.error?.includes('output limit')); }
});

test('actual runtime iteration and usage budgets prevent unbounded worker loops', async () => {
  const calls = new Map<ReviewRole, number>();
  const looping = provider(async function* (request) {
    const reviewer = role(request);
    const count = (calls.get(reviewer) ?? 0) + 1;
    calls.set(reviewer, count);
    yield { type: 'tool_call', call: { id: `${reviewer}_${count}`, name: 'read_context', arguments: JSON.stringify({ iteration: count }) } };
    yield { type: 'done', reason: 'tool_calls' };
  });
  const bounded = await runReviewTeam({ provider: looping, tools: [safeTool()], context: context(), prompt: 'Review.', model: 'fixture', signal: new AbortController().signal });
  assert.ok(bounded.reviews.every(review => review.state === 'failed'));
  assert.deepEqual([...calls.values()], [REVIEW_TEAM_LIMITS.iterations, REVIEW_TEAM_LIMITS.iterations]);
  const costly = provider(async function* () { yield { type: 'usage', inputTokens: REVIEW_TEAM_LIMITS.usageTokens + 1, outputTokens: 0 }; yield { type: 'done', reason: 'stop' }; });
  const overBudget = await runReviewTeam({ provider: costly, tools: [], context: context(), prompt: 'Review.', model: 'fixture', signal: new AbortController().signal });
  assert.ok(overBudget.reviews.every(review => review.state === 'failed'));
});

test('incomplete provider completion stays failed and exceptions from progress observers do not break the pool', async () => {
  const fixture = provider(async function* () { yield { type: 'text', text: 'Incomplete evidence.' }; yield { type: 'done', reason: 'length' }; });
  const result = await runReviewTeam({ provider: fixture, tools: [], context: context(), prompt: 'Review.', model: 'fixture', signal: new AbortController().signal, onProgress() { throw new Error('disposed observer'); } });
  assert.ok(result.reviews.every(review => review.state === 'failed' && review.text.includes('Incomplete evidence.')));
});

test('pre-cancelled reviews never start workers and invalid requests fail before provider access', async () => {
  let calls = 0;
  const fixture = provider(async function* () { calls++; yield { type: 'done', reason: 'stop' }; });
  const controller = new AbortController();
  controller.abort();
  const result = await runReviewTeam({ provider: fixture, tools: [], context: context(), prompt: 'Review.', model: 'fixture', signal: controller.signal });
  assert.deepEqual(result.reviews.map(review => review.state), ['cancelled', 'cancelled']);
  await assert.rejects(runReviewTeam({ provider: fixture, tools: [], context: context(), prompt: 'x'.repeat(REVIEW_TEAM_LIMITS.promptChars + 1), model: 'fixture', signal: new AbortController().signal }), error => error instanceof LittleError && error.code === 'TOOL_VALIDATION_FAILED');
  assert.equal(calls, 0);
});

test('Groq reviews keep two isolated sessions but serialize and pace their shared provider allowance', async () => {
  let active = 0, peak = 0, reset = 0;
  const sequence: ReviewRole[] = [];
  const prompts: string[] = [];
  const progress: { role: ReviewRole; state: string }[] = [];
  const groq: LLMProvider = { id: 'groq', listModels: async () => [], requestLimits: () => reset > Date.now()
    ? { tokensPerMinute: 6000, remainingTokens: 0, resetAfterMs: reset - Date.now() } : { tokensPerMinute: 6000 },
    async *stream(request) {
      active++; peak = Math.max(peak, active);
      try {
        const reviewer = role(request);
        sequence.push(reviewer); prompts.push(request.messages[1]!.content);
        assert.equal(request.maxOutputTokens, 512);
        if (reviewer === 'verification') assert.ok(Date.now() >= reset);
        yield { type: 'text', text: `${reviewer}: inspected available context; suggested follow-up only.` };
        if (reviewer === 'architecture') reset = Date.now() + 30;
        yield { type: 'done', reason: 'stop' };
      } finally { active--; }
    } };
  const result = await runReviewTeam({ provider: groq, tools: [safeTool()], context: context(), prompt: 'Assess architecture and failure cases.', model: 'openai/gpt-oss-120b',
    modelMaxOutputTokens: 512, signal: new AbortController().signal, onProgress: review => progress.push(review) });
  assert.equal(peak, 1); assert.equal(active, 0);
  assert.deepEqual(sequence, ['architecture', 'verification']);
  assert.ok(prompts[0]?.includes('architecture reviewer'));
  assert.ok(!prompts[1]?.includes('architecture reviewer'));
  assert.deepEqual(result.reviews.map(review => review.state), ['completed', 'completed']);
  assert.deepEqual(progress[0], { role: 'verification', state: 'queued' });
  assert.ok(progress.findIndex(review => review.role === 'architecture' && review.state === 'completed') <
    progress.findIndex(review => review.role === 'verification' && review.state === 'running'));
  assert.ok(result.reviews[1]?.text.startsWith('Read-only verification review. No commands or checks were executed.'));
});

test('cancelling a Groq review joins the running worker and prevents the queued reviewer from generating', async () => {
  let calls = 0, cleaned = 0;
  let waiting!: () => void;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  const controller = new AbortController();
  const groq: LLMProvider = { id: 'groq', listModels: async () => [], async *stream(_request, signal) {
    calls++;
    try {
      yield { type: 'text', text: 'Partial architecture findings.' };
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new LittleError('AGENT_CANCELLED', 'Stopped review.'));
        signal!.addEventListener('abort', abort, { once: true });
        waiting();
      });
      yield { type: 'done', reason: 'stop' };
    } finally { cleaned++; }
  } };
  const running = runReviewTeam({ provider: groq, tools: [], context: context(), prompt: 'Review safely.', model: 'model', signal: controller.signal });
  await started; controller.abort();
  const result = await running;
  assert.equal(calls, 1); assert.equal(cleaned, 1);
  assert.deepEqual(result.reviews.map(review => review.state), ['cancelled', 'cancelled']);
});
