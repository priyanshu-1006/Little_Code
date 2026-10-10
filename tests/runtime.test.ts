import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/little/agent/runtime';
import type { AgentTool, CommandResult, LLMEvent, LLMProvider, LLMRequest, RuntimeEvent } from '../src/little/shared/contracts';
import { EventBus } from '../src/little/events/event-bus';
import { GroqProvider } from '../src/little/providers/groq';

function provider(turns: LLMEvent[][], requests: LLMRequest[] = []): LLMProvider {
  let index = 0;
  return { id: 'fixture', async listModels() { return []; }, async *stream(request) {
    requests.push(structuredClone(request));
    const events = turns[index++] ?? [{ type: 'text', text: 'Done.' } satisfies LLMEvent];
    yield* events;
    if (!events.some(event => event.type === 'done')) yield { type: 'done', reason: events.some(event => event.type === 'tool_call') ? 'tool_calls' : 'stop' };
  } };
}
const read: AgentTool = {
  name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, risk: 'SAFE',
  validate: value => value,
  async execute() { return { content: 'export function login() {}' }; },
};
const context = async () => ({ text: 'src/auth.ts', items: [] });
const call = (id: string, name = 'read_file'): LLMEvent => ({ type: 'tool_call', call: { id, name, arguments: '{"path":"src/auth.ts"}' } });
function capture(runtime: AgentRuntime): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  return events;
}

test('repository question performs structured tool loop and sends observations back', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(provider([[call('read-1')], [{ type: 'text', text: 'Authentication is in src/auth.ts.' }]], requests), [read], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'discovered-model', prompt: 'Where is authentication?' });
  assert.equal(runtime.busy, false);
  assert.equal(requests.length, 2);
  const observation = requests[1]?.messages.find(message => message.role === 'tool');
  assert.equal(observation?.toolCallId, 'read-1');
  assert.match(observation?.content ?? '', /login/);
  assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.ok(events.some(event => event.type === 'tool.completed'));
});

test('a native SSE Groq stream failure stops the run before tools and an explicit new run can recover', async () => {
  let requests = 0;
  let executed = 0;
  const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  const tool = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/auth.ts"}' } }] }, finish_reason: null }] };
  const groq = new GroqProvider({ get: async () => 'fake-fixture-key', store: async () => undefined, delete: async () => undefined }, async () => {
    requests++;
    let text: string;
    if (requests === 1) text = frame(tool) + frame({ error: { code: 'tool_use_failed', message: 'PRIVATE_PROVIDER_ECHO', failed_generation: 'PRIVATE_SOURCE' } });
    else if (requests === 2) text = frame(tool) + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
    else text = frame({ choices: [{ index: 0, delta: { content: 'Authentication is in src/auth.ts.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const runtime = new AgentRuntime(groq, [{ ...read, async execute() { executed++; return { content: 'export function login() {}' }; } }], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'llama-3.3-70b-versatile', prompt: 'Where is authentication?' });
  const failed = events.find(event => event.type === 'agent.failed');
  assert.ok(failed?.type === 'agent.failed');
  assert.deepEqual(failed.diagnostic, { provider: 'groq', phase: 'stream', category: 'tool_call' });
  assert.equal(failed.code, 'PROVIDER_PROTOCOL_ERROR');
  assert.equal(events.some(event => event.type === 'agent.completed' || event.type === 'tool.started'), false);
  assert.equal(JSON.stringify(events).includes('PRIVATE_'), false);
  assert.equal(executed, 0);
  assert.equal(requests, 1, 'A failed generation must not replay automatically.');
  assert.equal(runtime.busy, false);
  await runtime.run({ mode: 'ask', model: 'llama-3.3-70b-versatile', prompt: 'Where is authentication?' });
  assert.equal(requests, 3);
  assert.equal(executed, 1);
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('ASK denies a write even when the model requests an undisclosed tool', async () => {
  let executed = false;
  const write: AgentTool = { ...read, name: 'write_file', risk: 'WORKSPACE_WRITE', async execute() { executed = true; } };
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(provider([[call('write-1', 'write_file')], [{ type: 'text', text: 'Writes are unavailable.' }]], requests), [read, write], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'test', prompt: 'Write a file' });
  assert.equal(executed, false);
  assert.deepEqual(requests[0]?.tools?.map(tool => tool.name), ['read_file']);
  assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'PERMISSION_DENIED'));
});

test('repeated identical calls stop after two observations', async () => {
  const runtime = new AgentRuntime(provider([[call('a')], [call('b')], [call('c')]]), [read], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'plan', model: 'test', prompt: 'Plan a change' });
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'AGENT_LOOP_LIMIT'));
  assert.equal(events.filter(event => event.type === 'tool.completed').length, 2);
});

test('iteration budget prevents an unbounded provider loop', async () => {
  const runtime = new AgentRuntime(provider([[call('a')]]), [read], context, { maxIterations: 1 });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'test', prompt: 'Inspect' });
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'AGENT_LOOP_LIMIT'));
});

test('cancel propagates through context and emits cancelled without completion', async () => {
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const runtime = new AgentRuntime(provider([]), [read], async signal => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    return context();
  });
  const events = capture(runtime);
  const run = runtime.run({ mode: 'ask', model: 'test', prompt: 'Inspect' });
  await waiting;
  runtime.cancel();
  await run;
  assert.equal(events.at(-1)?.type, 'agent.cancelled');
  assert.equal(events.some(event => event.type === 'agent.completed'), false);
  assert.equal(runtime.busy, false);
});

test('invalid tool arguments become observations and repeated failure stops', async () => {
  const invalid = { ...read, validate() { throw new Error('Bad input including a secret'); } };
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(provider([[call('a')], [call('b')], [call('c')]], requests), [invalid], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'test', prompt: 'Inspect' });
  assert.equal(events.at(-1)?.type, 'agent.failed');
  assert.equal(JSON.stringify(events).includes('including a secret'), false);
  assert.match(requests[1]?.messages.at(-1)?.content ?? '', /TOOL_VALIDATION_FAILED/);
});

test('context budget fails before sending oversized repository content', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(provider([], requests), [read], context, { maxContextChars: 5 });
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'test', prompt: 'Inspect' });
  assert.equal(requests.length, 0);
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'CONTEXT_LIMIT'));
});

test('a failing event subscriber does not break other consumers', () => {
  const bus = new EventBus();
  let delivered = false;
  bus.subscribe(() => { throw new Error('Closed UI'); });
  const unsubscribe = bus.subscribe(() => { delivered = true; });
  bus.emit({ type: 'agent.completed', runId: 'test' });
  assert.equal(delivered, true);
  delivered = false;
  unsubscribe();
  bus.emit({ type: 'agent.completed', runId: 'test' });
  assert.equal(delivered, false);
});

test('truncated output fails even when it contains text', async () => {
  const runtime = new AgentRuntime(provider([[{ type: 'text', text: 'Partial answer' }, { type: 'done', reason: 'length' }]]), [read], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'test', prompt: 'Inspect' });
  assert.equal(events.some(event => event.type === 'agent.completed'), false);
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'CONTEXT_LIMIT'));
});

test('provider EOF without completion never claims success', async () => {
  const incomplete: LLMProvider = { id: 'incomplete', async listModels() { return []; }, async *stream() { yield { type: 'text', text: 'Unverified answer' }; } };
  const runtime = new AgentRuntime(incomplete, [read], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'ask', model: 'test', prompt: 'Inspect' });
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'PROVIDER_PROTOCOL_ERROR'));
});

const action = (id: string, name: string, input: unknown): LLMEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(input) } });
const plan = (id = 'plan'): LLMEvent => action(id, 'update_plan', { steps: ['Inspect session validation.', 'Review a focused repair.', 'Run approved tests and report their results.'] });
const commandInput = { program: 'npm', args: ['test'], cwd: '.', purpose: 'Verify session validation', timeoutMs: 1000 };
const commandResult = (exitCode: number): CommandResult => ({ status: 'exited', exitCode, output: exitCode ? 'Session expiration assertion failed.' : 'Session tests passed.', truncated: false, durationMs: 12 });
const commandTool = (execute: AgentTool['execute']): AgentTool => ({
  name: 'run_command', description: 'Wait for host Allow once before running a project command.', risk: 'EXECUTION', parameters: { type: 'object' },
  validate: value => value, execute,
});
const proposalTool = (execute: AgentTool['execute']): AgentTool => ({
  name: 'propose_file_edits', description: 'Review a diff before applying a proposal.', risk: 'WORKSPACE_WRITE', parameters: { type: 'object' },
  validate: value => value, execute,
});
const finalAnswer: LLMEvent = { type: 'text', text: 'Updated the session check; observed verification is described below.' };
function verification(events: RuntimeEvent[]) {
  const summary = events.find(event => event.type === 'agent.verification');
  assert.ok(summary?.type === 'agent.verification');
  return summary;
}

test('Agent follows inspection and plan, reviewed repair, failed check feedback, and successful approved rerun', async () => {
  const order: string[] = [];
  const requests: LLMRequest[] = [];
  let reviews = 0;
  let approvals = 0;
  const inspected: AgentTool = { ...read, async execute() { order.push('inspect'); return { content: 'function validateSession() { return false; }' }; } };
  const edits = proposalTool(async () => {
    // This fixture stands in for the explicit host diff decision, which the model cannot call.
    reviews++;
    order.push(reviews === 1 ? 'review-edit' : 'review-repair');
    return { status: 'applied', files: [{ path: 'src/auth.ts', kind: 'replace' }] };
  });
  const command = commandTool(async () => { approvals++; order.push(approvals === 1 ? 'allow-check' : 'allow-rerun'); return commandResult(approvals === 1 ? 1 : 0); });
  const runtime = new AgentRuntime(provider([
    [call('read'), plan()],
    [action('edit', 'propose_file_edits', { edits: ['initial reviewed fix'] })],
    [action('check-1', 'run_command', commandInput)],
    [action('repair', 'propose_file_edits', { edits: ['repair after failed assertion'] })],
    [action('check-2', 'run_command', commandInput)],
    [finalAnswer],
  ], requests), [inspected, edits, command], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Fix and verify session expiration.' });
  assert.deepEqual(order, ['inspect', 'review-edit', 'allow-check', 'review-repair', 'allow-rerun']);
  assert.equal(reviews, 2);
  assert.equal(approvals, 2);
  assert.match(requests[3]?.messages.at(-1)?.content ?? '', /Session expiration assertion failed/);
  assert.ok(events.some(event => event.type === 'agent.plan.updated' && event.steps.length === 3));
  assert.equal(events.filter(event => event.type === 'agent.state.changed' && event.state === 'verifying').length, 2);
  assert.ok(events.some(event => event.type === 'agent.state.changed' && event.state === 'repairing'));
  assert.equal(events.filter(event => event.type === 'agent.state.changed' && event.state === 'reviewing').length, 2);
  assert.deepEqual(verification(events), {
    type: 'agent.verification', runId: verification(events).runId, status: 'passed', outstandingEdits: false,
    checks: [{ command: 'npm test', status: 'exited', exitCode: 0, passed: true, durationMs: 12 }],
  });
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('Agent denies privileged tools until both a source inspection and a visible plan exist', async () => {
  let edits = 0;
  let commands = 0;
  const runtime = new AgentRuntime(provider([
    [action('premature-edit', 'propose_file_edits', {})],
    [call('inspect'), action('premature-command', 'run_command', commandInput)],
    [plan(), action('reviewed-edit', 'propose_file_edits', {})], [finalAnswer],
  ]), [read, proposalTool(async () => { edits++; return { status: 'applied' }; }), commandTool(async () => { commands++; return commandResult(0); })], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Fix session expiration.' });
  assert.equal(edits, 1);
  assert.equal(commands, 0);
  assert.equal(events.filter(event => event.type === 'tool.failed' && event.code === 'PERMISSION_DENIED').length, 2);
  assert.equal(verification(events).status, 'not_run');
  assert.equal(verification(events).outstandingEdits, true);
});

test('a rejected command never becomes a passed verification claim even when model prose says otherwise', async () => {
  const runtime = new AgentRuntime(provider([
    [call('inspect'), plan()], [action('check', 'run_command', commandInput)],
    [{ type: 'text', text: 'All tests passed.' }],
  ]), [read, commandTool(async () => ({ status: 'rejected', exitCode: null, output: 'User declined execution.', truncated: false, durationMs: 0 }))], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Verify the project.' });
  assert.equal(verification(events).status, 'not_run');
  assert.equal(verification(events).checks[0]?.passed, false);
  assert.equal(verification(events).checks[0]?.exitCode, null);
  assert.ok(events.some(event => event.type === 'tool.completed' && event.summary === 'Command rejected; nothing executed.'));
  assert.equal(events.some(event => event.type === 'tool.completed' && event.summary === 'Approved command exited successfully.'), false);
});

test('an accepted edit invalidates a previous zero-exit check until verification is rerun', async () => {
  const runtime = new AgentRuntime(provider([
    [call('inspect'), plan()], [action('check', 'run_command', commandInput)],
    [action('later-edit', 'propose_file_edits', {})], [finalAnswer],
  ]), [read, proposalTool(async () => ({ status: 'applied' })), commandTool(async () => commandResult(0))], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Verify, then change the session check.' });
  const summary = verification(events);
  assert.equal(summary.status, 'not_run');
  assert.equal(summary.outstandingEdits, true);
  assert.equal(summary.checks[0]?.exitCode, 0);
  assert.equal(summary.checks[0]?.passed, false);
});

test('verification reruns stop after three attempts despite purpose changes or equivalent folder aliases', async () => {
  let executed = 0;
  const runtime = new AgentRuntime(provider([
    [call('inspect'), plan()],
    ...Array.from({ length: 4 }, (_, index) => [action(`check-${index}`, 'run_command', { ...commandInput, cwd: index % 2 ? './' : '.', purpose: `Attempt ${index}` })]),
    [finalAnswer],
  ]), [read, commandTool(async () => { executed++; return commandResult(1); })], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Verify this project.' });
  assert.equal(executed, 3);
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'AGENT_LOOP_LIMIT'));
  assert.equal(verification(events).status, 'failed');
  assert.equal(events.some(event => event.type === 'agent.completed'), false);
});

test('cancelling a command approval wait leaves no successful verification result', async () => {
  let proposed!: () => void;
  const waiting = new Promise<void>(resolve => { proposed = resolve; });
  const runtime = new AgentRuntime(provider([[call('inspect'), plan()], [action('check', 'run_command', commandInput)]]), [read,
    commandTool(async (_input, { signal }) => {
      proposed();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
      assert.fail('cancelled approval cannot launch');
    }),
  ], context);
  const events = capture(runtime);
  const running = runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Verify this project.' });
  await waiting;
  runtime.cancel();
  await running;
  assert.equal(events.at(-1)?.type, 'agent.cancelled');
  assert.equal(verification(events).status, 'not_run');
  assert.equal(verification(events).checks[0]?.status, 'cancelled');
  assert.equal(verification(events).checks[0]?.passed, false);
  assert.equal(runtime.busy, false);
});

test('Edit keeps command execution unavailable', async () => {
  let executed = false;
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(provider([[action('command', 'run_command', commandInput)], [finalAnswer]], requests), [read,
    commandTool(async () => { executed = true; return commandResult(0); }),
  ], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'edit', model: 'fixture', prompt: 'Fix this project.' });
  assert.equal(executed, false);
  assert.equal(requests[0]?.tools?.some(tool => tool.name === 'run_command' || tool.name === 'update_plan'), false);
  assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'PERMISSION_DENIED'));
});

test('an invalid or thrown rerun cannot reuse an earlier passed check', async () => {
  for (const malformed of [false, true]) {
    let executions = 0;
    const runtime = new AgentRuntime(provider([
      [call('inspect'), plan()], [action('first', 'run_command', commandInput)],
      [action('rerun', 'run_command', commandInput)], [finalAnswer],
    ]), [read, commandTool(async () => {
      if (++executions === 1) return commandResult(0);
      if (malformed) return { status: 'exited', exitCode: 0, output: 'incomplete result' };
      throw new Error('Failed to confirm process exit.');
    })], context);
    const events = capture(runtime);
    await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Run checks twice.' });
    assert.equal(verification(events).status, 'failed');
    assert.equal(verification(events).checks[0]?.passed, false);
    assert.equal(verification(events).checks[0]?.exitCode, null);
  }
});

test('truncated command output is not reported as a passed check', async () => {
  const runtime = new AgentRuntime(provider([[call('inspect'), plan()], [action('check', 'run_command', commandInput)], [finalAnswer]]),
    [read, commandTool(async () => ({ ...commandResult(0), truncated: true }))], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Verify this project.' });
  assert.equal(verification(events).status, 'failed');
  assert.equal(verification(events).checks[0]?.passed, false);
});

test('a failed accepted edit with recovery conflicts invalidates earlier verification', async () => {
  const runtime = new AgentRuntime(provider([
    [call('inspect'), plan()], [action('check', 'run_command', commandInput)],
    [action('partial-edit', 'propose_file_edits', {})], [finalAnswer],
  ]), [read, proposalTool(async () => ({ status: 'failed', recoveryConflicts: ['src/auth.ts'] })), commandTool(async () => commandResult(0))], context);
  const events = capture(runtime);
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Verify and change this file.' });
  assert.equal(verification(events).status, 'not_run');
  assert.equal(verification(events).checks[0]?.passed, false);
  assert.equal(verification(events).outstandingEdits, true);
});
