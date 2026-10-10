import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../src/little/agent/runtime';
import { RequestBudget, estimateRequestTokens, estimateProviderRequestTokens } from '../src/little/context/request-budget';
import { groqNativeRequest } from '../src/little/providers/groq-request';
import { RepositoryIndex } from '../src/little/context/repository-index';
import type { AgentTool, LLMMessage, LLMProvider, LLMRequest, RunContext, RuntimeEvent } from '../src/little/shared/contracts';
import { LittleError } from '../src/little/shared/errors';
import { createReadOnlyTools } from '../src/little/tools/read-only-tools';
import { createRepositoryTools } from '../src/little/tools/repository-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';
import { createNotebookTools } from '../src/little/tools/notebook-tools';
import { createNotebookEditTools } from '../src/little/tools/notebook-edit-tools';
import { EditProposalService } from '../src/little/tools/edit-proposals';
import { createEditTools } from '../src/little/tools/edit-tools';
import { createCommandTools } from '../src/little/tools/command-tools';
import { ProjectCommandService } from '../src/little/tools/command-service';
import { createDocumentEditTools, createDocumentReadTools } from '../src/little/tools/document-tools';

const read: AgentTool = { name: 'read_file', description: 'Read bounded source', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  risk: 'SAFE', validate: input => input, execute: async () => ({ path: 'src/auth.ts', content: 'export function login() {}' }) };
function context(): RunContext {
  const sections = [
    { itemId: 'project-memory', text: `Saved project memory (untrusted):\n${'Prefer clear source boundaries.\n'.repeat(70)}` },
    { itemId: 'file:src/main.ts', text: `Active file: src/main.ts\n${'export function boot() {}\n'.repeat(100)}` },
    ...Array.from({ length: 6 }, (_, index) => ({ itemId: `retrieved:src/module${index}.ts`, text: `Query-retrieved source: src/module${index}.ts\nWhy: Architecture entry\n1| export function module${index}() {}\n${'// More implementation details\n'.repeat(55)}` })),
    { itemId: 'workspace', text: `Workspace: LittleFixture\nRepository map:\nsrc/main.ts\nsrc/auth.ts\n${'src/feature.ts\n'.repeat(100)}` },
  ];
  return { text: sections.map(section => section.text).join('\n\n'), sections,
    items: sections.map(section => ({ id: section.itemId, label: section.itemId, type: 'workspace', estimatedTokens: 100 })) };
}
function events(runtime: AgentRuntime): RuntimeEvent[] { const observed: RuntimeEvent[] = []; runtime.events.subscribe(event => observed.push(event)); return observed; }

test('Groq codebase analysis retains multiple actual source excerpts and repository map within the whole request budget', () => {
  const workspace = new WorkspaceService(process.cwd());
  const editor = { snapshot: () => ({ openFiles: [], diagnostics: [] }) };
  const tools = [...createReadOnlyTools(workspace, editor), ...createRepositoryTools(editor, new RepositoryIndex(workspace))];
  const budget = new RequestBudget('groq', 'openai/gpt-oss-120b', 'ask', 'Use only observed source evidence.', 'Analyse the codebase architecture.', context(), tools,
    { modelContextWindow: 131072, modelMaxOutputTokens: 800 });
  const prepared = budget.prepare(budget.initialMessages());
  assert.ok(estimateRequestTokens(prepared.request.messages, prepared.request.tools) + prepared.request.maxOutputTokens! <= 5500);
  assert.equal(prepared.request.maxOutputTokens, 800);
  const sent = prepared.request.messages[1]!.content;
  assert.match(sent, /Repository map/);
  assert.match(sent, /export function module0/);
  assert.match(sent, /export function module1/);
  assert.match(sent, /Context shortened/);
  assert.ok(prepared.items.some(item => item.id === 'workspace'));
  assert.ok(prepared.items.some(item => item.id === 'request-budget' && item.reason?.includes('Approximate request ceiling')));
  assert.ok(prepared.request.tools?.some(tool => tool.name === 'read_range'));
});

test('model context and actual observed account TPM tighten input and output reserves together', () => {
  const budget = new RequestBudget('groq', 'small-context', 'ask', 'Use evidence.', 'Explain architecture.', context(), [read],
    { modelContextWindow: 3000, modelMaxOutputTokens: 400 }, { tokensPerMinute: 2500 });
  const prepared = budget.prepare(budget.initialMessages(), { tokensPerMinute: 2500 });
  assert.ok(prepared.estimatedTokens <= 2250);
  assert.equal(prepared.request.maxOutputTokens, 400);
  assert.equal(prepared.request.messages[1]!.content.endsWith('Explain architecture.'), true);
});

test('GPT OSS reserves 2048 completion tokens and budgets the exact native schemas and canonical tool history inside 5500', () => {
  const budget = new RequestBudget('groq', 'openai/gpt-oss-120b', 'ask', 'Use observed evidence.', 'Analyse architecture.', context(), [read]);
  const history: LLMMessage[] = [...budget.initialMessages(),
    { role: 'assistant', content: '', toolCalls: [{ id: 'read-actual', name: 'read_file', arguments: '{"path":"src/auth.ts"}' }] },
    { role: 'tool', toolCallId: 'read-actual', content: JSON.stringify({ path: 'src/auth.ts', content: 'CURRENT SOURCE\n' + 'source line\n'.repeat(350) }) }];
  const prepared = budget.prepare(history);
  const body = groqNativeRequest(prepared.request);
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  assert.equal(prepared.request.maxOutputTokens, 2048);
  assert.equal(prepared.estimatedTokens, Math.ceil(bytes / 3) + 64 + prepared.request.tools!.length * 8 + 2048);
  assert.equal(estimateProviderRequestTokens('groq', prepared.request.model, prepared.request.messages, prepared.request.tools, 2048) + 2048, prepared.estimatedTokens);
  assert.ok(prepared.estimatedTokens <= 5500);
  assert.equal(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'read-actual'), true);
  assert.equal(body.messages.find(message => message.role === 'assistant')?.tool_calls?.[0]?.id, 'read-actual');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.stream, true);
  assert.match(JSON.stringify(body.messages), /CURRENT SOURCE/);
  assert.ok(prepared.items.some(item => item.reason?.includes('2048 response tokens')));
  assert.equal(history.at(-1)?.role, 'tool');
});

test('native GPT OSS budgeting preserves dictionary and empty-object schemas without structured compiler restrictions', () => {
  const dictionary = { ...read, name: 'mcp_dictionary', parameters: { type: 'object', additionalProperties: { type: 'string' } } };
  const empty = { ...read, name: 'get_workspace_info', parameters: { type: 'object', properties: {}, additionalProperties: false } };
  const original = structuredClone([dictionary.parameters, empty.parameters]);
  const budget = new RequestBudget('groq', 'openai/gpt-oss-20b', 'ask', 'Use evidence.', 'Analyse codebase.', { text: '', items: [] }, [read, dictionary, empty]);
  const prepared = budget.prepare(budget.initialMessages());
  assert.deepEqual(prepared.request.tools?.map(tool => tool.name), ['read_file', 'mcp_dictionary', 'get_workspace_info']);
  assert.deepEqual([dictionary.parameters, empty.parameters], original);
  assert.doesNotMatch(prepared.request.messages[0]!.content, /structured|incompatible/);
  const edit = new RequestBudget('groq', 'openai/gpt-oss-120b', 'edit', 'Use review.', 'Edit source.', { text: '', items: [] },
    [read, { ...dictionary, name: 'propose_file_edits' }]);
  assert.ok(edit.tools.some(tool => tool.name === 'propose_file_edits'));
});

test('every Groq model budgets the actual UTF-8 native body and fixed framing for tool and plain requests', () => {
  const messages: LLMMessage[] = [{ role: 'system', content: 'Use source evidence.' },
    { role: 'user', content: '分析 café 🌍\n"quoted source" C:\\repo\\module' }];
  for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant', 'future-model']) {
    for (const definitions of [[], [read]]) {
      const body = groqNativeRequest({ model, messages, tools: definitions, maxOutputTokens: 2048 });
      const serialized = JSON.stringify(body);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      assert.ok(bytes > serialized.length, 'UTF-8 source bytes must be counted rather than JavaScript characters.');
      assert.equal(estimateProviderRequestTokens('groq', model, messages, definitions, 2048), Math.ceil(bytes / 3) + 64 + definitions.length * 8);
    }
  }
});

test('large optional integration schemas are omitted without mutating their literal definitions', () => {
  const optional: AgentTool = { ...read, name: 'mcp_private_integration', description: 'Invoke external service', parameters: { type: 'object', properties:
    Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`field${index}`, { type: 'string', description: 'Example description '.repeat(30) }])) } };
  const original = JSON.stringify(optional.parameters);
  const budget = new RequestBudget('groq', 'model', 'ask', 'Use evidence.', 'Analyse codebase.', context(), [read, optional]);
  assert.deepEqual(budget.tools.map(tool => tool.name), ['read_file']);
  assert.equal(JSON.stringify(optional.parameters), original);
  const prepared = budget.prepare(budget.initialMessages());
  assert.ok(prepared.items.some(item => item.reason?.includes('optional tool definitions omitted')));
});

test('history compaction retains actual rejected/applied outcomes and complete tool exchanges without replay or literal argument edits', () => {
  const tools = [read, { ...read, name: 'run_command' }, { ...read, name: 'propose_file_edits' }];
  const budget = new RequestBudget('groq', 'model', 'ask', 'Use actual tool outcomes; respect rejection.', 'Continue investigation.', context(), tools);
  const history: LLMMessage[] = [...budget.initialMessages(),
    { role: 'assistant', content: '', toolCalls: [{ id: 'rejected', name: 'run_command', arguments: JSON.stringify({ program: 'npm', args: ['test'], purpose: 'x'.repeat(12000) }) }] },
    { role: 'tool', toolCallId: 'rejected', content: JSON.stringify({ status: 'rejected', exitCode: null, output: 'User declined.', truncated: false }) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'applied', name: 'propose_file_edits', arguments: JSON.stringify({ edits: [{ path: 'src/auth.ts', content: 'x'.repeat(10000) }] }) }] },
    { role: 'tool', toolCallId: 'applied', content: JSON.stringify({ status: 'applied', files: [{ path: 'src/auth.ts', kind: 'replace' }], verification: 'No checks were run.' }) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: '{"path":"src/auth.ts"}' }] },
    { role: 'tool', toolCallId: 'read', content: '{"path":"src/auth.ts","content":"currentSource"}' },
  ];
  const original = structuredClone(history);
  const prepared = budget.prepare(history);
  assert.deepEqual(history, original);
  const sent = JSON.stringify(prepared.request.messages);
  assert.match(sent, /Earlier completed tool exchanges/);
  assert.match(sent, /rejected/);
  assert.match(sent, /applied/);
  assert.match(sent, /No checks were run/);
  const calls = prepared.request.messages.flatMap(message => message.toolCalls ?? []);
  const results = prepared.request.messages.filter(message => message.role === 'tool');
  assert.equal(calls.length, results.length);
  for (const call of calls) {
    assert.ok(results.some(result => result.toolCallId === call.id));
    assert.equal(call.arguments, original.flatMap(message => message.toolCalls ?? []).find(item => item.id === call.id)!.arguments);
  }
  assert.ok(prepared.items.some(item => item.reason?.includes('no actions replayed')));
  history.push({ role: 'assistant', content: '', toolCalls: [{ id: 'later', name: 'read_file', arguments: JSON.stringify({ path: 'src/later.ts', note: 'x'.repeat(10000) }) }] },
    { role: 'tool', toolCallId: 'later', content: '{"path":"src/later.ts","content":"laterObservedSource"}' });
  const next = budget.prepare(history);
  const nextSent = JSON.stringify(next.request.messages);
  assert.equal(nextSent.match(/Earlier completed tool exchanges/g)?.length, 1);
  assert.equal(nextSent.match(/status\\":\\"rejected/g)?.length, 1);
  assert.equal(nextSent.match(/status\\":\\"applied/g)?.length, 1);
});

test('EDIT preserves its proposal tool or fails preflight clearly instead of silently losing edit capability', () => {
  const proposal: AgentTool = { ...read, name: 'propose_file_edits', risk: 'WORKSPACE_WRITE', parameters: { type: 'object', description: 'x'.repeat(18000) } };
  assert.throws(() => new RequestBudget('groq', 'model', 'edit', 'Inspect first, then propose a reviewed edit.', 'Fix authentication.', context(), [read, proposal]),
    error => error instanceof LittleError && error.code === 'CONTEXT_LIMIT');
  const normal = { ...proposal, parameters: { type: 'object', properties: { edits: { type: 'array' } }, required: ['edits'] } };
  const budget = new RequestBudget('groq', 'model', 'edit', 'Inspect first, then propose a reviewed edit.', 'Fix authentication.', context(), [read, normal]);
  assert.ok(budget.tools.some(tool => tool.name === 'propose_file_edits'));
});

test('large observations remain explicitly bounded while their command status and exit code are preserved', () => {
  const budget = new RequestBudget('groq', 'model', 'ask', 'Use evidence.', 'Summarize observed output.', { text: '', items: [] }, [read]);
  const history: LLMMessage[] = [...budget.initialMessages(), { role: 'assistant', content: '', toolCalls: [{ id: 'check', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'check', content: JSON.stringify({ status: 'exited', exitCode: 1, truncated: false, output: 'Assertion failed.\n'.repeat(1000) }) }];
  const prepared = budget.prepare(history);
  const output = JSON.parse(prepared.request.messages.find(message => message.role === 'tool')!.content);
  assert.equal(output.observationTruncated, true);
  assert.equal(output.metadata.status, 'exited');
  assert.equal(output.metadata.exitCode, 1);
  assert.equal(output.metadata.truncated, false);
  assert.match(output.preview, /Assertion failed/);
  assert.ok(prepared.estimatedTokens <= 5500);
});

test('the latest fresh source observation takes precedence over initial repository context when both cannot fit', () => {
  const budget = new RequestBudget('groq', 'model', 'ask', 'Use only observed source evidence. '.repeat(140), 'Analyse the current implementation.', context(), [read]);
  const history: LLMMessage[] = [...budget.initialMessages(),
    { role: 'assistant', content: '', toolCalls: [{ id: 'fresh', name: 'read_file', arguments: '{"path":"src/current.ts"}' }] },
    { role: 'tool', toolCallId: 'fresh', content: JSON.stringify({ path: 'src/current.ts', content: 'NEWLY_OBSERVED_IMPLEMENTATION\n' + 'const currentCode = true;\n'.repeat(500) }) }];
  const prepared = budget.prepare(history);
  const observation = prepared.request.messages.find(message => message.role === 'tool');
  assert.equal(observation?.toolCallId, 'fresh');
  assert.match(observation?.content ?? '', /NEWLY_OBSERVED_IMPLEMENTATION/);
  assert.ok(prepared.estimatedTokens <= 5500);
  assert.ok(prepared.request.messages[1]!.content.length < history[1]!.content.length);
});

test('oversized mandatory user requests fail before provider access instead of silently shortening the request', async () => {
  let requests = 0;
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], async *stream() { requests++; yield { type: 'done', reason: 'stop' }; } };
  const runtime = new AgentRuntime(provider, [read], async () => context());
  const observed = events(runtime);
  await runtime.run({ mode: 'ask', model: 'model', prompt: '請分析'.repeat(3000) });
  assert.equal(requests, 0);
  assert.ok(observed.some(event => event.type === 'agent.failed' && event.code === 'CONTEXT_LIMIT'));
});

test('an omitted allowed tool cannot bypass the offered request schema budget', async () => {
  let executions = 0;
  const optional = { ...read, name: 'large_optional', parameters: { description: 'x'.repeat(18000) }, execute: async () => { executions++; return {}; } };
  let requests = 0;
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], async *stream(request) {
    requests++;
    if (requests === 1) { yield { type: 'tool_call', call: { id: 'omitted', name: 'large_optional', arguments: '{}' } }; yield { type: 'done', reason: 'tool_calls' }; }
    else { assert.match(request.messages.at(-1)!.content, /not offered/); yield { type: 'text', text: 'The optional tool is unavailable in this request.' }; yield { type: 'done', reason: 'stop' }; }
  } };
  const runtime = new AgentRuntime(provider, [read, optional], async () => ({ text: '', items: [] }));
  await runtime.run({ mode: 'ask', model: 'model', prompt: 'Analyse source.' });
  assert.equal(executions, 0);
  assert.equal(requests, 2);
});

test('provider header pacing waits before the next request and starts no failed-request retry or duplicate tool action', async () => {
  let calls = 0, executions = 0, reset = 0;
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], requestLimits() {
    return reset > Date.now() ? { tokensPerMinute: 6000, remainingTokens: 0, resetAfterMs: reset - Date.now() } : { tokensPerMinute: 6000 };
  }, async *stream(request) {
    requests.push(request); calls++;
    if (calls === 1) { reset = Date.now() + 25; yield { type: 'tool_call', call: { id: 'once', name: 'read_file', arguments: '{"path":"src/auth.ts"}' } }; yield { type: 'done', reason: 'tool_calls' }; }
    else { assert.ok(Date.now() >= reset); yield { type: 'text', text: 'Source was inspected once.' }; yield { type: 'done', reason: 'stop' }; }
  } };
  const runtime = new AgentRuntime(provider, [{ ...read, execute: async () => { executions++; return { content: 'login' }; } }], async () => ({ text: '', items: [] }));
  const observed = events(runtime);
  await runtime.run({ mode: 'ask', model: 'model', prompt: 'Inspect login.' });
  assert.equal(calls, 2); assert.equal(executions, 1);
  assert.ok(observed.some(event => event.type === 'agent.provider.wait'));
  assert.equal(observed.at(-1)?.type, 'agent.completed');
  assert.ok(requests.every(request => estimateRequestTokens(request.messages, request.tools) + request.maxOutputTokens! <= 5400));
});

test('Stop cancels a provider allowance wait before any generation starts', async () => {
  let calls = 0;
  let waiting!: () => void;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], requestLimits: () => ({ remainingTokens: 0, resetAfterMs: 30000 }),
    async *stream() { calls++; yield { type: 'done', reason: 'stop' }; } };
  const runtime = new AgentRuntime(provider, [read], async () => ({ text: '', items: [] }));
  const observed = events(runtime);
  runtime.events.subscribe(event => { if (event.type === 'agent.provider.wait') waiting(); });
  const run = runtime.run({ mode: 'ask', model: 'model', prompt: 'Inspect.' });
  await started; runtime.cancel(); await run;
  assert.equal(calls, 0);
  assert.equal(observed.at(-1)?.type, 'agent.cancelled');
});

test('quota pacing rereads header state after a wait when another allowance is still exhausted', async () => {
  let calls = 0, tokenReset = 0, requestReset = 0;
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], requestLimits() {
    if (!tokenReset) { tokenReset = Date.now() + 30; requestReset = Date.now() + 65; }
    if (Date.now() < tokenReset) return { remainingTokens: 0, resetAfterMs: tokenReset - Date.now() };
    if (Date.now() < requestReset) return { requestsRemaining: 0, requestsResetAfterMs: requestReset - Date.now() };
    return {};
  }, async *stream() {
    calls++; assert.ok(Date.now() >= requestReset);
    yield { type: 'text', text: 'Both observed allowances are available.' }; yield { type: 'done', reason: 'stop' };
  } };
  const runtime = new AgentRuntime(provider, [read], async () => ({ text: '', items: [] }));
  const observed = events(runtime);
  await runtime.run({ mode: 'ask', model: 'model', prompt: 'Inspect source.' });
  assert.equal(calls, 1);
  assert.equal(observed.filter(event => event.type === 'agent.provider.wait').length, 2);
  assert.equal(observed.at(-1)?.type, 'agent.completed');
});

test('long quota resets and actual HTTP 429 failures surface retry timing without automatic generation retries', async () => {
  let calls = 0;
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], requestLimits: () => ({ requestsRemaining: 0, requestsResetAfterMs: 70000 }),
    async *stream() { calls++; yield { type: 'done', reason: 'stop' }; } };
  const runtime = new AgentRuntime(provider, [read], async () => ({ text: '', items: [] }));
  const observed = events(runtime);
  await runtime.run({ mode: 'ask', model: 'model', prompt: 'Inspect.' });
  assert.equal(calls, 0);
  const quotaFailure = observed.find(event => event.type === 'agent.failed');
  assert.ok(quotaFailure?.type === 'agent.failed'); assert.equal(quotaFailure.retryAfterMs, 70000);
  const failedProvider: LLMProvider = { ...provider, requestLimits: () => undefined,
    async *stream() { calls++; throw new LittleError('PROVIDER_RATE_LIMITED', 'Quota exhausted.', 15000); yield { type: 'done', reason: 'stop' }; } };
  const failedRuntime = new AgentRuntime(failedProvider, [read], async () => ({ text: '', items: [] }));
  const failures = events(failedRuntime);
  await failedRuntime.run({ mode: 'ask', model: 'model', prompt: 'Inspect.' });
  assert.equal(calls, 1);
  const failure = failures.find(event => event.type === 'agent.failed');
  assert.ok(failure?.type === 'agent.failed'); assert.equal(failure.retryAfterMs, 15000);
});

test('format readers and reviewed proposal schemas stay mandatory under Groq tool-budget pressure', () => {
  const optional = Array.from({ length: 15 }, (_, index): AgentTool => ({ ...read, name: `mcp_optional_${index}`,
    description: 'Optional unrelated integration. '.repeat(100) }));
  for (const [path, reader, proposal] of [
    ['lesson.ipynb', 'read_notebook', 'propose_notebook_edits'],
    ['report.docx', 'read_document', 'propose_document'],
    ['slides.pptx', 'read_document', 'propose_document'],
    ['report.pdf', 'read_document', 'propose_document'],
  ]) {
    const tools = [read, ...optional, { ...read, name: reader! },
      { ...read, name: proposal!, risk: 'WORKSPACE_WRITE' as const }];
    const budget = new RequestBudget('groq', 'openai/gpt-oss-120b', 'edit', 'Inspect first; respect native review.', `Edit ${path}.`, context(), tools);
    const prepared = budget.prepare(budget.initialMessages());
    assert.ok(prepared.request.tools?.some(tool => tool.name === reader), path);
    assert.ok(prepared.request.tools?.some(tool => tool.name === proposal), path);
    assert.equal(prepared.request.maxOutputTokens, 2048);
    assert.ok(prepared.estimatedTokens <= 5500);
    assert.ok(prepared.request.tools!.filter(tool => tool.name.startsWith('mcp_optional_')).length < optional.length);
  }
  const oversized = { ...read, name: 'read_notebook', description: 'x'.repeat(20000) };
  assert.throws(() => new RequestBudget('groq', 'openai/gpt-oss-120b', 'ask', 'Read source.', 'Read lesson.ipynb.', context(), [read, oversized]),
    error => error instanceof LittleError && error.code === 'CONTEXT_LIMIT', 'A required reader must fail clearly rather than be omitted.');
});

test('deletion reserves metadata and generic review; creation reserves a target-parent listing', () => {
  const tools = [read, { ...read, name: 'inspect_file', description: 'Inspect exact-byte metadata. '.repeat(110) },
    { ...read, name: 'list_directory', description: 'Inspect the actual parent. '.repeat(110) },
    { ...read, name: 'propose_file_edits', risk: 'WORKSPACE_WRITE' as const },
    { ...read, name: 'propose_notebook_edits', risk: 'WORKSPACE_WRITE' as const, description: 'x'.repeat(18000) },
    { ...read, name: 'propose_document', risk: 'WORKSPACE_WRITE' as const, description: 'x'.repeat(18000) }];
  const deletion = new RequestBudget('groq', 'openai/gpt-oss-120b', 'edit', 'Inspect then review.', 'Delete report.docx.', { text: '', items: [] }, tools);
  assert.ok(deletion.tools.some(tool => tool.name === 'inspect_file'));
  assert.ok(deletion.tools.some(tool => tool.name === 'propose_file_edits'));
  assert.equal(deletion.tools.some(tool => ['propose_document', 'propose_notebook_edits'].includes(tool.name)), false);
  const creation = new RequestBudget('groq', 'openai/gpt-oss-120b', 'edit', 'Inspect then review.', 'Create src/new.ts.', { text: '', items: [] }, tools);
  assert.ok(creation.tools.some(tool => tool.name === 'list_directory'));
  assert.ok(creation.prepare(creation.initialMessages()).estimatedTokens <= 5500);
});

test('the actual notebook and command schemas fit complete Agent read/plan/review exchanges inside the native 5500-token ceiling', async () => {
  const workspace = new WorkspaceService(process.cwd());
  const service = new EditProposalService(workspace, 'unused-budget-fixture');
  const tools = [...createReadOnlyTools(workspace, { snapshot: () => ({ openFiles: [], diagnostics: [] }) }),
    ...createNotebookTools(workspace), ...createNotebookEditTools(workspace, service, async () => ({ status: 'rejected' }), () => {}),
    ...createEditTools(service, async () => ({ status: 'rejected' }), () => {}),
    ...createCommandTools(new ProjectCommandService(workspace), async () => ({ status: 'rejected', exitCode: null, output: '', truncated: false, durationMs: 0 }))];
  // Exercise the real schemas without staging or changing any file. Native approval remains host-owned.
  const fixtures = tools.map(tool => tool.name === 'read_notebook' ? { ...tool,
    execute: async () => ({ path: 'lesson.ipynb', content: 'Cell 1, lines 1-1\n1| result = 1', truncated: false }) } : tool.name === 'propose_notebook_edits' ? { ...tool,
    execute: async () => ({ status: 'rejected', files: [{ path: 'lesson.ipynb' }] }) } : tool);
  const turns = [
    { id: 'read', name: 'read_notebook', input: { path: 'lesson.ipynb', startCell: 1, endCell: 1 } },
    { id: 'plan', name: 'update_plan', input: { steps: ['Inspect the cell.', 'Review an exact source patch.'] } },
    { id: 'proposal', name: 'propose_notebook_edits', input: { path: 'lesson.ipynb', action: 'edit', edits: [{ operation: 'patch', cell: 1, search: 'result = 1', replacement: 'result = 2' }] } },
  ];
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = { id: 'groq', listModels: async () => [], async *stream(request) {
    const turn = turns[requests.length]; requests.push(structuredClone(request));
    if (turn) { yield { type: 'tool_call', call: { id: turn.id, name: turn.name, arguments: JSON.stringify(turn.input) } }; yield { type: 'done', reason: 'tool_calls' }; }
    else { yield { type: 'text', text: 'The proposal was rejected. No changes were applied and no cells ran.' }; yield { type: 'done', reason: 'stop' }; }
  } };
  const runtime = new AgentRuntime(provider, fixtures, async () => ({ text: '', items: [] }));
  const observed = events(runtime);
  await runtime.run({ prompt: 'Edit lesson.ipynb Cell 1 to assign result = 2.', mode: 'agent', model: 'openai/gpt-oss-120b' });
  assert.equal(observed.at(-1)?.type, 'agent.completed', JSON.stringify(observed.filter(event => event.type === 'agent.failed')));
  assert.equal(requests.length, 4);
  for (const request of requests) {
    const names = request.tools?.map(tool => tool.name);
    for (const name of ['read_notebook', 'propose_notebook_edits', 'update_plan', 'run_command']) assert.ok(names?.includes(name), name);
    assert.equal(names?.includes('propose_file_edits'), false, 'Generic proposal is optional for a format-only mutation.');
    assert.equal(request.maxOutputTokens, 2048);
    assert.ok(estimateProviderRequestTokens('groq', request.model, request.messages, request.tools, request.maxOutputTokens) + 2048 <= 5500);
  }
});

test('actual DOCX/PPTX replacement and PDF creation/append schemas fit Agent review exchanges within 5500/2048', async () => {
  const workspace = new WorkspaceService(process.cwd());
  const service = new EditProposalService(workspace, 'unused-document-budget-fixture');
  const registry = [...createReadOnlyTools(workspace, { snapshot: () => ({ openFiles: [], diagnostics: [] }) }),
    ...createNotebookTools(workspace), ...createNotebookEditTools(workspace, service, async () => ({ status: 'rejected' }), () => {}),
    ...createDocumentReadTools(workspace), ...createDocumentEditTools(workspace, service, async () => ({ status: 'rejected' }), () => {}),
    ...createEditTools(service, async () => ({ status: 'rejected' }), () => {}),
    ...createCommandTools(new ProjectCommandService(workspace), async () => ({ status: 'rejected', exitCode: null, output: '', truncated: false, durationMs: 0 }))];
  for (const [format, action] of [['docx', 'replace_text'], ['pptx', 'replace_text'], ['pdf', 'create'], ['pdf', 'append_text']]) {
    const path = `report.${format}`;
    const fixtures = registry.map(tool => ['read_document', 'list_directory'].includes(tool.name) ? { ...tool,
      execute: async () => tool.name === 'list_directory' ? { path: '.', entries: [] } : { path, content: 'Original text.', citations: [{ unit: 1 }] } } :
      tool.name === 'propose_document' ? { ...tool, execute: async () => ({ status: 'rejected', files: [{ path }] }) } : tool);
    const turns = [
      { id: 'inspect', name: action === 'create' ? 'list_directory' : 'read_document', input: { path: action === 'create' ? '.' : path } },
      { id: 'plan', name: 'update_plan', input: { steps: ['Inspect the target.', 'Review the exact document operation.'] } },
      { id: 'proposal', name: 'propose_document', input: { path, format, action,
        ...(action === 'replace_text' ? { replacements: [{ search: 'Original text.', replacement: 'Revised text.' }] } : { content: 'Summary text.' }) } },
    ];
    const requests: LLMRequest[] = [];
    const provider: LLMProvider = { id: 'groq', listModels: async () => [], async *stream(request) {
      const turn = turns[requests.length]; requests.push(structuredClone(request));
      if (turn) { yield { type: 'tool_call', call: { id: turn.id, name: turn.name, arguments: JSON.stringify(turn.input) } }; yield { type: 'done', reason: 'tool_calls' }; }
      else { yield { type: 'text', text: 'The proposal was rejected. No changes were applied.' }; yield { type: 'done', reason: 'stop' }; }
    } };
    const prompt = `${action === 'create' ? 'Create' : action === 'append_text' ? 'Append a summary to' : 'Replace text in'} ${path}.`;
    const runtime = new AgentRuntime(provider, fixtures, async () => ({ text: '', items: [] })); const observed = events(runtime);
    await runtime.run({ prompt, mode: 'agent', model: 'openai/gpt-oss-120b' });
    assert.equal(observed.at(-1)?.type, 'agent.completed', JSON.stringify(observed.filter(event => event.type === 'agent.failed')));
    assert.equal(requests.length, 4);
    for (const request of requests) {
      for (const name of ['propose_document', 'update_plan', 'run_command', action === 'create' ? 'list_directory' : 'read_document']) assert.ok(request.tools?.some(tool => tool.name === name));
      assert.equal(request.maxOutputTokens, 2048);
      assert.ok(estimateProviderRequestTokens('groq', request.model, request.messages, request.tools, request.maxOutputTokens) + 2048 <= 5500);
    }
  }
});
