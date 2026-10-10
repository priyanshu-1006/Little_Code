import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../src/little/agent/runtime';
import { collectContext } from '../src/little/context/collect-context';
import { GROQ_SECRET_KEY, GroqProvider } from '../src/little/providers/groq';
import type { EditorService, LLMEvent, LLMProvider, LLMRequest, RuntimeEvent, SecretStore } from '../src/little/shared/contracts';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';
import { EditProposalService } from '../src/little/tools/edit-proposals';
import { createEditTools } from '../src/little/tools/edit-tools';
import { ProjectCommandService } from '../src/little/tools/command-service';
import { createCommandTools } from '../src/little/tools/command-tools';

interface WireMessage { role: string; content: string; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
interface WireRequest { model: string; messages: WireMessage[]; tools: { function: { name: string } }[] }
const hostApiKey = 'gsk_HostCredential1234567890';
const sourceApiKey = 'gsk_SourceCredential1234567890';
const envSecret = 'private-environment-value-never-for-models';
const source = [
  `const developmentApiKey = "${sourceApiKey}";`,
  'export type Session = { token: string; expiresAt: number };',
  'export function validateSession(session: Session, now = Date.now()) {',
  '  return session.token.length > 0 && session.expiresAt > now;',
  '}',
].join('\n');
const secretStore: SecretStore = {
  get: async key => { assert.equal(key, GROQ_SECRET_KEY); return hostApiKey; },
  store: async () => { assert.fail('an agent run cannot change credentials'); },
  delete: async () => { assert.fail('an agent run cannot remove credentials'); },
};

function completion(delta: unknown, finishReason: 'stop' | 'tool_calls'): Response {
  const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n` +
    'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":10}}\n\n' + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(payload);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.subarray(offset, offset + 17));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
function toolCompletion(id: string, name: string, input: unknown): Response {
  return completion({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls');
}
async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else snapshot[path.relative(root, absolute)] = (await fs.readFile(absolute)).toString('base64');
    }
  }
  await visit(root);
  return snapshot;
}

test('real provider, workspace tools, and runtime discover search/read evidence without writes or secret disclosure', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'little-integration-'));
  t.after(async () => {
    // Cleanup applies only to the exact temporary fixture created by this test.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('little-integration-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), source);
  await fs.writeFile(path.join(root, '.env'), `UNRECOGNIZED_VALUE=${envSecret}\nGROQ_API_KEY=${hostApiKey}`);
  await fs.writeFile(path.join(root, '.gitignore'), 'private-notes.txt\n');
  await fs.writeFile(path.join(root, 'private-notes.txt'), 'validateSession private note');
  const before = await snapshotFiles(root);
  const workspace = new WorkspaceService(root);
  const editor: EditorService = { snapshot: () => ({
    activeFile: 'src/auth.ts', activeContent: source, selection: source.split('\n')[0],
    openFiles: ['src/auth.ts', '.env', 'private-notes.txt'], diagnostics: [
      'src/auth.ts:3 Session validation is defined here.',
      `.env:1 Invalid environment value: ${envSecret}`,
      'private-notes.txt:1 Sensitive ignored diagnostic value.',
    ],
  }) };
  const requests: WireRequest[] = [];
  const provider = new GroqProvider(secretStore, async (url, options) => {
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${hostApiKey}`);
    if (String(url).endsWith('/models')) {
      return Response.json({ data: [{ id: 'fixture-chat-model', name: 'Fixture Chat Model', context_window: 32768 }] });
    }
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.ok(options?.signal instanceof AbortSignal);
    const serialized = String(options?.body);
    for (const secret of [hostApiKey, sourceApiKey, envSecret]) assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('.env'), false);
    assert.equal(serialized.includes('private-notes.txt'), false);
    const wire = JSON.parse(serialized) as WireRequest;
    assert.equal(wire.model, 'fixture-chat-model');
    assert.ok(wire.tools.some(tool => tool.function.name === 'search_text'));
    assert.ok(wire.tools.some(tool => tool.function.name === 'read_range'));
    assert.equal(wire.tools.some(tool => /write|terminal|shell/.test(tool.function.name)), false);
    requests.push(wire);
    if (requests.length === 1) {
      assert.match(wire.messages[1]?.content ?? '', /Active file: src\/auth.ts/);
      assert.match(wire.messages[1]?.content ?? '', /\[REDACTED\]/);
      return toolCompletion('search-auth', 'search_text', { query: 'validateSession' });
    }
    if (requests.length === 2) {
      const feedback = wire.messages.at(-1);
      assert.equal(feedback?.role, 'tool');
      assert.equal(feedback?.tool_call_id, 'search-auth');
      assert.match(feedback?.content ?? '', /src\/auth.ts/);
      assert.match(feedback?.content ?? '', /validateSession/);
      assert.equal(wire.messages.at(-2)?.tool_calls?.[0]?.function.name, 'search_text');
      return toolCompletion('read-auth', 'read_range', { path: 'src/auth.ts', startLine: 1, endLine: 5 });
    }
    assert.equal(requests.length, 3);
    const feedback = wire.messages.at(-1);
    assert.equal(feedback?.role, 'tool');
    assert.equal(feedback?.tool_call_id, 'read-auth');
    assert.match(feedback?.content ?? '', /session.expiresAt > now/);
    assert.match(feedback?.content ?? '', /\[REDACTED\]/);
    return completion({ content: 'Session validation is in src/auth.ts:3–5. It checks for a non-empty token and an expiration time later than now.' }, 'stop');
  });
  const models = await provider.listModels();
  assert.deepEqual(models, [{ id: 'fixture-chat-model', name: 'Fixture Chat Model', contextWindow: 32768, capabilities: { streaming: true, tools: 'unknown' } }]);
  const runtime = new AgentRuntime(provider, createReadOnlyTools(workspace, editor), signal => collectContext(workspace, editor, signal));
  const events: RuntimeEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  await runtime.run({ prompt: 'Where is session validation implemented and what does it check?', mode: 'ask', model: models[0]?.id ?? '' });
  assert.equal(requests.length, 3);
  assert.equal(runtime.busy, false);
  assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.equal(events.some(event => event.type === 'agent.failed' || event.type === 'tool.failed'), false);
  assert.deepEqual(events.filter(event => event.type === 'tool.completed').map(event => event.name), ['search_text', 'read_range']);
  assert.ok(events.some(event => event.type === 'agent.text.delta' && event.text.includes('src/auth.ts:3–5')));
  assert.equal(events.filter(event => event.type === 'agent.usage').length, 3);
  for (const secret of [hostApiKey, sourceApiKey, envSecret]) assert.equal(JSON.stringify(events).includes(secret), false);
  assert.deepEqual(await snapshotFiles(root), before);

  // Opening a sensitive document cannot bypass the same policy used by tool reads.
  const privateEditor: EditorService = { snapshot: () => ({
    activeFile: '.env', activeContent: envSecret, selection: envSecret, openFiles: ['.env'], diagnostics: [
      `.env:1 Invalid environment value: ${envSecret}`,
      'src/auth.ts:3 Session validation is defined here.',
    ],
  }) };
  const privateContext = await collectContext(workspace, privateEditor, new AbortController().signal);
  assert.equal(privateContext.text.includes('.env'), false);
  assert.equal(privateContext.text.includes(envSecret), false);
  assert.equal(privateContext.items.some(item => item.type === 'file' || item.type === 'selection'), false);
  assert.match(privateContext.text, /Session validation is defined here/);
  const diagnosticTool = createReadOnlyTools(workspace, privateEditor).find(tool => tool.name === 'get_diagnostics');
  assert.ok(diagnosticTool);
  const diagnostics = JSON.stringify(await diagnosticTool.execute({}, { signal: new AbortController().signal }));
  assert.equal(diagnostics.includes('.env'), false);
  assert.equal(diagnostics.includes(envSecret), false);
  assert.match(diagnostics, /src\/auth.ts/);
});

test('Agent integration observes a real failed Node check, reviews a bounded repair, and verifies the rerun', async t => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'little-integration-agent-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith('little-integration-agent-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const root = path.join(temporary, 'workspace');
  const checkpoints = path.join(temporary, 'checkpoints');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(checkpoints);
  const before = 'exports.valid = (session, now) => session.expiresAt < now;\n';
  const after = before.replace('< now', '> now');
  const script = 'const assert = require("node:assert/strict");\nconst { valid } = require("./src/session.js");\nassert.equal(valid({ expiresAt: 200 }, 100), true);\nconsole.log("Session expiration check passed.");\n';
  await fs.writeFile(path.join(root, 'src', 'session.js'), before);
  await fs.writeFile(path.join(root, 'verify.cjs'), script);
  await fs.writeFile(path.join(root, '.env'), envSecret);
  const workspace = new WorkspaceService(root);
  const editor: EditorService = { snapshot: () => ({ openFiles: [], diagnostics: [] }) };
  const editService = new EditProposalService(workspace, checkpoints);
  const commands = new ProjectCommandService(workspace);
  let diffReviews = 0;
  let commandDecisions = 0;
  const tools = [
    ...createReadOnlyTools(workspace, editor),
    ...createEditTools(editService, async (proposal, context) => {
      // A deterministic host-decision fixture, not a native UI approval.
      diffReviews++;
      assert.match(proposal.changes[0]?.diff ?? '', /-exports.valid/);
      assert.equal(await fs.readFile(path.join(root, 'src', 'session.js'), 'utf8'), before);
      return editService.apply(editService.accept(proposal.id), context.signal);
    }, () => undefined),
    ...createCommandTools(commands, async (proposal, context) => {
      // Each command receives a fresh, authentic one-use grant from the host fixture.
      commandDecisions++;
      return commands.execute(proposal, commands.approve(proposal), context.signal);
    }),
  ];
  const action = (id: string, name: string, input: unknown): LLMEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(input) } });
  const check = { program: 'node', args: ['verify.cjs'], cwd: '.', purpose: 'Check session expiration', timeoutMs: 5000 };
  const turns: LLMEvent[][] = [
    [action('inspect', 'read_file', { path: 'src/session.js' }), action('plan', 'update_plan', { steps: ['Inspect expiration logic.', 'Run the focused session check.', 'Review a repair if needed and rerun the check.'] })],
    [action('failed-check', 'run_command', check)],
    [action('review-repair', 'propose_file_edits', { edits: [{ kind: 'replace', path: 'src/session.js', replacements: [{ search: '< now', replacement: '> now' }] }] })],
    [action('successful-check', 'run_command', check)],
    [{ type: 'text', text: 'Repaired the expiration comparison in src/session.js:1. The approved Node check exited with code 0 after the repair.' }],
  ];
  const requests: LLMRequest[] = [];
  let turn = 0;
  const provider: LLMProvider = { id: 'agent-fixture', async listModels() { return []; }, async *stream(request) {
    requests.push(structuredClone(request));
    const events = turns[turn++];
    assert.ok(events, 'the runtime must finish within the deterministic fixture');
    yield* events;
    yield { type: 'done', reason: events.some(event => event.type === 'tool_call') ? 'tool_calls' : 'stop' };
  } };
  const runtime = new AgentRuntime(provider, tools, signal => collectContext(workspace, editor, signal));
  const events: RuntimeEvent[] = [];
  runtime.events.subscribe(event => events.push(event));
  await runtime.run({ mode: 'agent', model: 'fixture', prompt: 'Fix session expiration and run its focused check.' });
  assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.equal(events.some(event => event.type === 'agent.failed'), false);
  assert.equal(commandDecisions, 2);
  assert.equal(diffReviews, 1);
  const failedFeedback = JSON.parse(requests[2]?.messages.at(-1)?.content ?? '{}') as { status: string; exitCode: number; output: string };
  assert.equal(failedFeedback.status, 'exited');
  assert.notEqual(failedFeedback.exitCode, 0);
  assert.match(failedFeedback.output, /AssertionError/);
  const successFeedback = JSON.parse(requests[4]?.messages.at(-1)?.content ?? '{}') as { status: string; exitCode: number; output: string };
  assert.equal(successFeedback.status, 'exited');
  assert.equal(successFeedback.exitCode, 0);
  assert.match(successFeedback.output, /Session expiration check passed/);
  const summary = events.find(event => event.type === 'agent.verification');
  assert.ok(summary?.type === 'agent.verification');
  assert.equal(summary.status, 'passed');
  assert.equal(summary.outstandingEdits, false);
  assert.equal(summary.checks[0]?.command, 'node verify.cjs');
  assert.equal(summary.checks[0]?.passed, true);
  assert.equal(await fs.readFile(path.join(root, 'src', 'session.js'), 'utf8'), after);
  assert.equal(await fs.readFile(path.join(root, 'verify.cjs'), 'utf8'), script);
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), envSecret);
  assert.equal(JSON.stringify(requests).includes(envSecret), false);
  assert.equal(JSON.stringify(events).includes(envSecret), false);
  assert.ok((await fs.readdir(checkpoints)).length > 0);
});
