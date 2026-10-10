import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../src/little/agent/runtime';
import type { LLMProvider, LLMRequest, RuntimeEvent } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { EditProposalService, type EditApplyResult, type EditProposal } from '../src/little/tools/edit-proposals';
import { createEditTools } from '../src/little/tools/edit-tools';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';
import { ClientMessageSchema } from '../src/little/ui/protocol';

const edits = { edits: [{ kind: 'replace', path: 'counter.ts', replacements: [{ search: 'count = 1', replacement: 'count = 2' }] }] };
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'little-edit-tools-'));
  t.after(async () => { assert.equal(path.dirname(base), path.resolve(tmpdir())); assert.ok(path.basename(base).startsWith('little-edit-tools-')); await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'repo'), storage = path.join(base, 'private');
  await fs.mkdir(root); await fs.mkdir(storage);
  await fs.writeFile(path.join(root, 'counter.ts'), 'export const count = 1;\n');
  const workspace = new WorkspaceService(root);
  const service = new EditProposalService(workspace, storage);
  const readTools = createReadOnlyTools(workspace, { snapshot: () => ({ openFiles: [], diagnostics: [] }) }).filter(tool => tool.name === 'read_file');
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = { id: 'scripted-test', async listModels() { return []; }, async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) { yield { type: 'tool_call', call: { id: 'read-call', name: 'read_file', arguments: '{"path":"counter.ts"}' } }; yield { type: 'done', reason: 'tool_calls' }; }
    else if (requests.length === 2) { yield { type: 'tool_call', call: { id: 'proposal-call', name: 'propose_file_edits', arguments: JSON.stringify(edits) } }; yield { type: 'done', reason: 'tool_calls' }; }
    else { yield { type: 'text', text: 'The proposal has been resolved. No tests ran.' }; yield { type: 'done', reason: 'stop' }; }
  } };
  return { root, storage, service, readTools, requests, provider, read: () => fs.readFile(path.join(root, 'counter.ts'), 'utf8') };
}

async function waitForProposal(waiting: Promise<EditProposal>, run: Promise<void>): Promise<EditProposal> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([waiting, run.then(() => { throw new Error('Runtime ended before proposing a reviewed edit.'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Reviewed edit was not proposed within the fixture deadline.')), 3000); })]);
  } finally { clearTimeout(timer!); }
}

test('Edit pauses without writes until host acceptance, then returns evidence and restores from durable checkpoint', async t => {
  const f = await fixture(t);
  let proposed!: (proposal: EditProposal) => void;
  const waiting = new Promise<EditProposal>(resolve => { proposed = resolve; });
  let accepted!: (result: EditApplyResult) => void;
  const tools = createEditTools(f.service, async (proposal, context) => {
    assert.ok(context.runId); proposed(proposal);
    return new Promise<EditApplyResult>((resolve, reject) => {
      accepted = resolve;
      context.signal.addEventListener('abort', () => reject(new LittleError('AGENT_CANCELLED', 'Stopped')), { once: true });
    });
  }, () => {});
  const runtime = new AgentRuntime(f.provider, [...f.readTools, ...tools], async () => ({ text: 'A counter project.', items: [] }));
  t.after(() => runtime.cancel());
  const run = runtime.run({ mode: 'edit', model: 'fixture-model', prompt: 'Increment the constant.' });
  const proposal = await waitForProposal(waiting, run);
  assert.equal(await f.read(), 'export const count = 1;\n');
  assert.deepEqual(await fs.readdir(f.storage), []);
  assert.equal(runtime.busy, true);
  assert.equal(f.service.preview(proposal.id)[0]?.proposed, 'export const count = 2;\n');
  const result = await f.service.apply(f.service.accept(proposal.id));
  accepted(result); await run;
  assert.equal(result.status, 'applied');
  assert.equal(await f.read(), 'export const count = 2;\n');
  const observation = f.requests[2]!.messages.find(message => message.role === 'tool' && message.toolCallId === 'proposal-call')!;
  assert.match(observation.content, /"status":"applied"/);
  assert.equal(observation.content.includes(f.storage), false);
  assert.equal(observation.content.includes('export const'), false);
  const reopened = new EditProposalService(new WorkspaceService(f.root), f.storage);
  assert.deepEqual((await reopened.rollback(result.checkpointId)).conflicts, []);
  assert.equal(await f.read(), 'export const count = 1;\n');
});

test('Ask and Plan cannot stage edits even if the provider fabricates a privileged call', async t => {
  for (const mode of ['ask', 'plan'] as const) {
    const f = await fixture(t);
    let reviewed = false;
    const tools = createEditTools(f.service, async () => { reviewed = true; return { status: 'rejected' }; }, () => {});
    const runtime = new AgentRuntime(f.provider, [...f.readTools, ...tools], async () => ({ text: '', items: [] }));
    const events: RuntimeEvent[] = []; runtime.events.subscribe(event => events.push(event));
    await runtime.run({ mode, model: 'fixture-model', prompt: 'Please change the counter.' });
    assert.equal(reviewed, false);
    assert.deepEqual(f.requests[0]!.tools?.map(tool => tool.name), ['read_file']);
    assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'PERMISSION_DENIED'));
    assert.equal(await f.read(), 'export const count = 1;\n');
  }
});

test('rejection and cancellation keep workspace bytes and invalidate a pending proposal', async t => {
  for (const action of ['reject', 'cancel'] as const) {
    const f = await fixture(t);
    let proposed!: (proposal: EditProposal) => void;
    const waiting = new Promise<EditProposal>(resolve => { proposed = resolve; });
    const tools = createEditTools(f.service, async (proposal, context) => {
      proposed(proposal);
      if (action === 'reject') return { status: 'rejected' };
      return new Promise<EditApplyResult>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new LittleError('AGENT_CANCELLED', 'Stopped')), { once: true }));
    }, () => {});
    const runtime = new AgentRuntime(f.provider, [...f.readTools, ...tools], async () => ({ text: '', items: [] }));
    t.after(() => runtime.cancel());
    const events: RuntimeEvent[] = []; runtime.events.subscribe(event => events.push(event));
    const run = runtime.run({ mode: 'edit', model: 'fixture-model', prompt: 'Change the counter.' });
    const proposal = await waitForProposal(waiting, run);
    if (action === 'cancel') runtime.cancel();
    await run;
    assert.equal(await f.read(), 'export const count = 1;\n');
    assert.deepEqual(await fs.readdir(f.storage), []);
    assert.throws(() => f.service.accept(proposal.id), /pending proposal/);
    assert.equal(events.at(-1)?.type, action === 'cancel' ? 'agent.cancelled' : 'agent.completed');
  }
});

test('dirty editor guard prevents staging and strict protocol rejects forged acceptance payloads', async t => {
  const f = await fixture(t);
  const tools = createEditTools(f.service, async () => ({ status: 'rejected' }), () => { throw new LittleError('PERMISSION_DENIED', 'Save first.'); });
  await assert.rejects(tools[0]!.execute(edits, { signal: new AbortController().signal }), /Save first/);
  assert.deepEqual(await fs.readdir(f.storage), []);
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideEdits', proposalId: 'a'.repeat(32), decision: 'accept' }).success, true);
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideEdits', proposalId: '../private', decision: 'accept' }).success, false);
  assert.equal(ClientMessageSchema.safeParse({ type: 'decideEdits', proposalId: 'a'.repeat(32), decision: 'accept', acceptance: { accepted: true } }).success, false);
});
