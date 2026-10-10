import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../src/little/agent/runtime';
import { fileWorkflow } from '../src/little/agent/file-instructions';
import { LittleError } from '../src/little/shared/errors';
import type { AgentTool, LLMEvent, LLMProvider, LLMRequest, RuntimeEvent } from '../src/little/shared/contracts';

const context = async () => ({ text: 'Initial context is not a fresh file-tool observation.', items: [] });
const text = (value: string): LLMEvent => ({ type: 'text', text: value });
const call = (id: string, name: string, input: unknown): LLMEvent => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(input) } });
const plan = call('plan', 'update_plan', { steps: ['Inspect the requested target.', 'Review the change and report its observed outcome.'] });
function fixture(turns: LLMEvent[][], requests: LLMRequest[] = []): LLMProvider {
  return { id: 'fixture', listModels: async () => [], async *stream(request) {
    const events = turns[requests.length] ?? [text('Unexpected generation.')];
    requests.push(structuredClone(request));
    yield* events;
    yield { type: 'done', reason: events.some(event => event.type === 'tool_call') ? 'tool_calls' : 'stop' };
  } };
}
function tool(name: string, execute: AgentTool['execute'], risk: AgentTool['risk'] = 'SAFE'): AgentTool {
  return { name, description: name, parameters: { type: 'object' }, risk, validate: input => input, execute };
}
function capture(runtime: AgentRuntime): RuntimeEvent[] {
  const events: RuntimeEvent[] = []; runtime.events.subscribe(event => events.push(event)); return events;
}
function answer(events: RuntimeEvent[]): string {
  return events.filter(event => event.type === 'agent.text.delta').map(event => event.text).join('');
}

test('an ungrounded notebook answer is withheld and corrected once through an advertised fresh reader', async () => {
  const requests: LLMRequest[] = [];
  let reads = 0;
  const runtime = new AgentRuntime(fixture([
    [text('The notebook certainly trains a perfect model.')],
    [call('read', 'read_notebook', { path: 'lesson.ipynb' })],
    [text('lesson.ipynb Cell 1 contains the observed import.')],
  ], requests), [tool('read_notebook', async () => { reads++; return { path: 'lesson.ipynb', content: 'Cell 1, lines 1-1\n1| import math' }; })], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Read and explain lesson.ipynb.', mode: 'ask', model: 'fixture' });
  assert.equal(reads, 1);
  assert.equal(requests.length, 3);
  assert.match(requests[1]!.messages[0]!.content, /Required continuation/);
  assert.ok(requests[0]!.tools?.some(definition => definition.name === 'read_notebook'));
  assert.doesNotMatch(JSON.stringify(requests[1]!.messages), /perfect model/);
  assert.equal(answer(events), 'lesson.ipynb Cell 1 contains the observed import.');
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('a second ungrounded answer fails without publishing either claim or silently completing', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(fixture([[text('I inspected report.docx.')], [text('It contains an executive summary.')]], requests),
    [tool('read_document', async () => ({ path: 'report.docx', content: 'Actual source' }))], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Read report.docx.', mode: 'ask', model: 'fixture' });
  assert.equal(requests.length, 2);
  assert.equal(answer(events), '');
  assert.ok(events.some(event => event.type === 'agent.failed' && event.code === 'TOOL_FAILED'));
  assert.equal(events.some(event => event.type === 'agent.completed'), false);
});

test('actual document text and original unit citations ground DOCX, PPTX and PDF inspection', async () => {
  for (const extension of ['docx', 'pptx', 'pdf']) {
    const path = `report.${extension}`;
    const runtime = new AgentRuntime(fixture([[call('read', 'read_document', { path })], [text(`${path} unit 1: source text.`)]]),
      [tool('read_document', async () => ({ path, content: 'unit 1: source text.', units: [{ number: 1, text: 'source text.' }] }))], context);
    const events = capture(runtime);
    await runtime.run({ prompt: `Summarize ${path}.`, mode: 'ask', model: 'fixture' });
    assert.equal(events.at(-1)?.type, 'agent.completed');
    assert.match(answer(events), /unit 1/);
  }
});

test('a reader returning a different path cannot satisfy the requested file evidence', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(fixture([[call('wrong', 'read_file', { path: 'wanted.ts' })], [text('wanted.ts is correct.')], [text('wanted.ts is correct.')]], requests),
    [tool('read_file', async () => ({ path: 'other.ts', content: 'Different source' }))], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Inspect wanted.ts.', mode: 'ask', model: 'fixture' });
  assert.equal(requests.length, 3);
  assert.equal(answer(events), '');
  assert.equal(events.at(-1)?.type, 'agent.failed');
});

test('all explicitly named files need relevant evidence before the final answer is accepted', async () => {
  const runtime = new AgentRuntime(fixture([
    [call('first', 'read_file', { path: 'a.ts' })], [text('Both files look correct.')],
    [call('second', 'read_file', { path: 'b.ts' })], [text('a.ts and b.ts contain the observed exports.')],
  ]), [tool('read_file', async input => ({ path: (input as { path: string }).path, content: 'export const value = 1;' }))], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Compare a.ts and b.ts.', mode: 'ask', model: 'fixture' });
  assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.doesNotMatch(answer(events), /look correct/);
});

test('creation requires the actual parent listing, then a plan and reviewed outcome even in an empty project', async () => {
  let reviews = 0;
  const requests: LLMRequest[] = [];
  const input = { edits: [{ path: 'src/new.ts', kind: 'create', content: 'export const created = true;' }] };
  const runtime = new AgentRuntime(fixture([
    [call('wrong-parent', 'list_directory', { path: '.' }), plan],
    [call('premature', 'propose_file_edits', input)],
    [call('parent', 'list_directory', { path: 'src' })],
    [call('review', 'propose_file_edits', input)],
    [text('The proposal was rejected. No files were created.')],
  ], requests), [tool('list_directory', async input => ({ path: (input as { path: string }).path, entries: [] })),
    tool('propose_file_edits', async () => { reviews++; return { status: 'rejected', files: [{ path: 'src/new.ts', kind: 'create' }] }; }, 'WORKSPACE_WRITE')], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Create src/new.ts.', mode: 'agent', model: 'fixture' });
  assert.equal(reviews, 1);
  assert.equal(requests.length, 5, 'A rejected proposal resolves the request without another corrective proposal.');
  assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'PERMISSION_DENIED'));
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('root creation can use workspace metadata while metadata cannot satisfy existing-file edits', async () => {
  for (const edit of [false, true]) {
    let reviews = 0;
    const runtime = new AgentRuntime(fixture([
      [call('workspace', 'get_workspace_info', {})],
      [call('proposal', 'propose_file_edits', { edits: [{ path: 'file.ts', kind: edit ? 'replace' : 'create', content: 'text' }] })],
      [text(edit ? 'Cannot edit without reading its contents.' : 'Created file.ts through the reviewed proposal.')],
    ]), [tool('get_workspace_info', async () => ({ name: 'empty', entries: [] })),
      tool('propose_file_edits', async () => { reviews++; return { status: 'applied', files: [{ path: 'file.ts' }] }; }, 'WORKSPACE_WRITE')], context);
    const events = capture(runtime);
    await runtime.run({ prompt: `${edit ? 'Edit' : 'Create'} file.ts.`, mode: 'edit', model: 'fixture' });
    assert.equal(reviews, edit ? 0 : 1);
    assert.equal(events.at(-1)?.type, 'agent.completed');
  }
});

test('exact-byte metadata supports reviewed binary deletion but never file reading or editing', async () => {
  const metadata = tool('inspect_file', async input => ({ path: (input as { path: string }).path, bytes: 42, sha256: 'a'.repeat(64), contentIncluded: false }));
  let reviews = 0;
  const runtime = new AgentRuntime(fixture([
    [call('metadata', 'inspect_file', { path: 'image.png' }), plan],
    [call('delete', 'propose_file_edits', { edits: [{ path: 'image.png', kind: 'delete' }] })],
    [text('Deleted image.png through the approved proposal; its contents were not read.')],
  ]), [metadata, tool('propose_file_edits', async () => { reviews++; return { status: 'applied', files: [{ path: 'image.png', kind: 'delete' }] }; }, 'WORKSPACE_WRITE')], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Delete image.png.', mode: 'agent', model: 'fixture' });
  assert.equal(reviews, 1); assert.equal(events.at(-1)?.type, 'agent.completed');
  const inspect = new AgentRuntime(fixture([[call('metadata', 'inspect_file', { path: 'source.ts' })], [text('source.ts is correct.')], [text('source.ts is correct.')]]), [metadata], context);
  const inspectEvents = capture(inspect);
  await inspect.run({ prompt: 'Read source.ts.', mode: 'ask', model: 'fixture' });
  assert.equal(inspectEvents.at(-1)?.type, 'agent.failed');
});

test('a rejected proposal cannot become a completion claim or be resubmitted by its correction', async () => {
  let reviews = 0;
  const requests: LLMRequest[] = [];
  const input = { path: 'lesson.ipynb', action: 'edit', operations: [] };
  const runtime = new AgentRuntime(fixture([
    [call('read', 'read_notebook', { path: 'lesson.ipynb' })],
    [call('review', 'propose_notebook_edits', input)], [text('Updated lesson.ipynb successfully.')],
    [call('bypass', 'propose_notebook_edits', input)], [text('The proposal was rejected; no changes were applied.')],
  ], requests), [tool('read_notebook', async () => ({ path: 'lesson.ipynb', content: '' })),
    tool('propose_notebook_edits', async () => { reviews++; return { status: 'rejected', files: [{ path: 'lesson.ipynb' }] }; }, 'WORKSPACE_WRITE')], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Edit lesson.ipynb.', mode: 'edit', model: 'fixture' });
  assert.equal(reviews, 1);
  assert.equal(requests.length, 5);
  assert.match(requests[3]!.messages[0]!.content, /not applied/);
  assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'PERMISSION_DENIED'));
  assert.doesNotMatch(answer(events), /successfully/);
  assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('general knowledge, tool capability questions, unidentified-target clarification and honest unsupported disclosures remain valid', async () => {
  for (const [prompt, response] of [
    ['Explain Node.js modules.', 'Node modules organize reusable JavaScript.'],
    ['How do I create a DOCX?', 'Use a document authoring library.'],
    ['Can you read files?', 'I can use advertised workspace read tools.'],
    ['Read a file.', 'Which workspace file should I read?'],
    ['Read image.png.', 'Image content reading is unsupported by these tools.'],
  ]) {
    const requests: LLMRequest[] = [];
    const runtime = new AgentRuntime(fixture([[text(response!)]], requests), [], context);
    const events = capture(runtime);
    await runtime.run({ prompt: prompt!, mode: 'ask', model: 'fixture' });
    assert.equal(requests.length, 1, prompt); assert.equal(events.at(-1)?.type, 'agent.completed', prompt);
  }
});

test('unavailable or failed readers allow honest limitations without replaying a failed generation', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(fixture([[call('read', 'read_file', { path: 'secret.ts' })], [text('Cannot read secret.ts because access was denied.')]], requests),
    [tool('read_file', async () => { throw new LittleError('PERMISSION_DENIED', 'Access denied.'); })], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Read secret.ts.', mode: 'ask', model: 'fixture' });
  assert.equal(requests.length, 2); assert.equal(events.at(-1)?.type, 'agent.completed');
  let generations = 0;
  const failure: LLMProvider = { id: 'fixture', listModels: async () => [], async *stream() {
    generations++; throw new LittleError('PROVIDER_PROTOCOL_ERROR', 'Generation failed.'); yield text('unreachable');
  } };
  const failed = new AgentRuntime(failure, [], context); const failedEvents = capture(failed);
  await failed.run({ prompt: 'Read report.pdf.', mode: 'ask', model: 'fixture' });
  assert.equal(generations, 1); assert.equal(failedEvents.at(-1)?.type, 'agent.failed');
});

test('Stop cancels the bounded corrective continuation and publishes no ungrounded answer', async () => {
  let requests = 0, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const provider: LLMProvider = { id: 'fixture', listModels: async () => [], async *stream(_request, signal) {
    if (++requests === 1) { yield text('I read file.ts.'); yield { type: 'done', reason: 'stop' }; return; }
    started();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
  } };
  const runtime = new AgentRuntime(provider, [tool('read_file', async () => ({ path: 'file.ts', content: 'text' }))], context);
  const events = capture(runtime);
  const run = runtime.run({ prompt: 'Read file.ts.', mode: 'ask', model: 'fixture' });
  await waiting; runtime.cancel(); await run;
  assert.equal(requests, 2); assert.equal(answer(events), ''); assert.equal(events.at(-1)?.type, 'agent.cancelled');
});

test('prompt routing reserves metadata only for deletion and does not mistake add/fix operations for creation', () => {
  assert.equal(fileWorkflow('Add validation to auth.ts.', 'agent').createOnly, false);
  assert.deepEqual(fileWorkflow('Delete lesson.ipynb.', 'agent').proposals, ['propose_file_edits']);
  assert.deepEqual(fileWorkflow('Delete report.docx.', 'agent').readers, ['inspect_file']);
  assert.equal(fileWorkflow('Read and delete image.png.', 'agent').unsupported, true);
  assert.equal(fileWorkflow('Explain https://example.com/API behavior.', 'ask').explicit, false);
  assert.equal(fileWorkflow('Read foo.py and do not edit it.', 'agent').requestedMutation, false);
  assert.equal(fileWorkflow('Inspect foo.py without changing it.', 'agent').requestedMutation, false);
  assert.equal(fileWorkflow('Read Dockerfile.', 'ask').explicit, true);
  assert.equal(fileWorkflow('Append a summary to report.pdf.', 'agent').mutate, true);
  assert.equal(fileWorkflow('Delete Cell 1 in lesson.ipynb.', 'agent').deleteOnly, false);
  assert.deepEqual(fileWorkflow('Delete Cell 1 in lesson.ipynb.', 'agent').proposals, ['propose_notebook_edits']);
  assert.deepEqual(fileWorkflow('What is in README.md?', 'ask').paths, ['readme.md']);
  assert.equal(fileWorkflow('What is in lesson.ipynb?', 'ask').explicit, true);
  assert.equal(fileWorkflow('How does JSON.parse work?', 'ask').explicit, false);
});

test('metadata-only requests use bounded metadata while keeping file contents private', async () => {
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(fixture([[call('meta', 'get_workspace_info', {})], [text('The workspace has one top-level entry.')]], requests),
    [tool('get_workspace_info', async () => ({ name: 'fixture', entries: [{ name: 'file.ts' }] }))], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Inspect workspace metadata.', mode: 'ask', model: 'fixture' });
  assert.equal(requests.length, 2); assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('an unsupported PDF replacement is disclosed after actual inspection without inventing or executing a writer', async () => {
  let writes = 0;
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(fixture([[call('read', 'read_document', { path: 'report.pdf' })],
    [text('Cannot replace the existing PDF layout. Appending text pages is supported, but no file changes were made.')]], requests),
  [tool('read_document', async () => ({ path: 'report.pdf', content: 'Page 1: original headline' })),
    tool('propose_document', async () => { writes++; return { status: 'applied', path: 'report.pdf' }; }, 'WORKSPACE_WRITE')], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Replace the headline in report.pdf.', mode: 'edit', model: 'fixture' });
  assert.equal(writes, 0); assert.equal(requests.length, 2); assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('read-only modes cannot accept an unperformed mutation claim even after a successful read', async () => {
  const runtime = new AgentRuntime(fixture([[call('read', 'read_file', { path: 'file.ts' })], [text('Updated file.ts.')],
    [text('The mutation requires EDIT or AGENT. No files were updated.')]]), [tool('read_file', async () => ({ path: 'file.ts', content: 'const value = 1;' }))], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Edit file.ts.', mode: 'ask', model: 'fixture' });
  assert.doesNotMatch(answer(events), /^Updated/); assert.equal(events.at(-1)?.type, 'agent.completed');
});

test('fixed native validation guidance reaches the next tool step while raw arguments and secrets stay out of UI events', async () => {
  const requests: LLMRequest[] = [];
  const secret = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
  let reads = 0;
  const reader: AgentTool = { ...tool('read_range', async () => { reads++; return { path: 'file.ts', content: '1| export const value = 1;' }; }),
    validate(input) {
      if ((input as { endLine: number }).endLine > 400) throw new LittleError('TOOL_VALIDATION_FAILED', `Read at most 400 source lines. ${secret}`);
      return input;
    } };
  const runtime = new AgentRuntime(fixture([
    [call('invalid', 'read_range', { path: 'file.ts', startLine: 1, endLine: 9999, raw: 'PRIVATE_RAW_ARGUMENT' })],
    [call('valid', 'read_range', { path: 'file.ts', startLine: 1, endLine: 1 })], [text('file.ts:1 exports the observed value.')],
  ], requests), [reader], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Read file.ts.', mode: 'ask', model: 'fixture' });
  assert.equal(reads, 1); assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.match(requests[1]!.messages.at(-1)!.content, /Read at most 400 source lines/);
  assert.ok(events.some(event => event.type === 'tool.failed' && event.code === 'TOOL_VALIDATION_FAILED' && event.message.includes('400')));
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(events).includes('PRIVATE_RAW_ARGUMENT'), false);
});

test('absolute paths inside the selected root match relative reads and reviewed outcomes without accepting sibling roots', async () => {
  const root = 'C:/Users/fixture/repo';
  const requests: LLMRequest[] = [];
  const runtime = new AgentRuntime(fixture([
    [call('read', 'read_document', { path: 'C:\\Users\\fixture\\repo\\report.docx' })],
    [call('proposal', 'propose_document', { path: 'report.docx', action: 'replace_text' })],
    [text('Updated report.docx through the approved proposal.')],
  ], requests), [tool('read_document', async () => ({ path: 'report.docx', content: 'Original text.' })),
    tool('propose_document', async () => ({ status: 'applied', files: [{ path: 'report.docx' }] }), 'WORKSPACE_WRITE')], context, { workspaceRoot: root });
  const events = capture(runtime);
  await runtime.run({ prompt: 'Edit C:\\Users\\fixture\\repo\\report.docx.', mode: 'edit', model: 'fixture' });
  assert.equal(requests.length, 3); assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.deepEqual(fileWorkflow('Read "C:\\Users\\fixture\\repo\\report.docx".', 'ask', root).paths, ['report.docx']);
  assert.equal(fileWorkflow('Read C:\\Users\\fixture\\repo-extra\\report.docx.', 'ask', root).unsupported, true);
  assert.equal(fileWorkflow('Delete C:\\Users\\fixture\\other\\image.png.', 'agent', root).unsupported, true);
});

test('filenames never supply mutation verbs, metadata intent or cell/slide operation nouns', () => {
  for (const prompt of ['Read scripts/update.ts.', 'Read edit.py.', 'Read replace.pdf.', 'Read metadata.ts.']) {
    const workflow = fileWorkflow(prompt, 'agent');
    assert.equal(workflow.explicit, true, prompt);
    assert.equal(workflow.requestedMutation, false, prompt);
    assert.equal(workflow.metadataOnly, false, prompt);
  }
  const deletion = fileWorkflow('Delete brief.docx, slides.pptx and source/code.ts.', 'agent');
  assert.equal(deletion.deleteOnly, true);
  assert.deepEqual(deletion.readers, ['inspect_file']);
  assert.deepEqual(deletion.proposals, ['propose_file_edits']);
  const cell = fileWorkflow('Delete Cell 1 in lesson.ipynb.', 'agent');
  assert.equal(cell.deleteOnly, false);
  assert.deepEqual(cell.readers, ['read_notebook']);
  assert.deepEqual(cell.proposals, ['propose_notebook_edits']);
  const readThenDelete = fileWorkflow('Read slides.pptx and delete it.', 'agent');
  assert.equal(readThenDelete.deleteOnly, false);
  assert.deepEqual(readThenDelete.readers, ['read_document']);
  const rooted = fileWorkflow('Delete "C:\\repo\\code\\slides.pptx".', 'agent', 'C:/repo');
  assert.equal(rooted.deleteOnly, true);
  assert.deepEqual(rooted.paths, ['code/slides.pptx']);
});

test('whole-file document/code deletion reaches review with matching metadata and no content read', async () => {
  const paths = ['brief.docx', 'slides.pptx', 'paper.pdf', 'source/code.ts'];
  let reviews = 0;
  const runtime = new AgentRuntime(fixture([
    ...paths.map((path, index) => [call(`metadata-${index}`, 'inspect_file', { path })]),
    [plan], [call('delete', 'propose_file_edits', { edits: paths.map(path => ({ path, kind: 'delete' })) })],
    [text('Deleted the four requested files through the approved proposal. Their contents were not read.')],
  ]), [tool('inspect_file', async input => ({ path: (input as { path: string }).path, bytes: 42, sha256: 'a'.repeat(64), contentIncluded: false })),
    tool('read_document', async () => { assert.fail('Deletion metadata must not require a document content read.'); }),
    tool('read_file', async () => { assert.fail('Deletion metadata must not require a source content read.'); }),
    tool('propose_file_edits', async () => { reviews++; return { status: 'applied', files: paths.map(path => ({ path, kind: 'delete' })) }; }, 'WORKSPACE_WRITE')], context);
  const events = capture(runtime);
  await runtime.run({ prompt: 'Delete brief.docx, slides.pptx, paper.pdf and source/code.ts.', mode: 'agent', model: 'fixture' });
  assert.equal(reviews, 1);
  assert.equal(events.at(-1)?.type, 'agent.completed');
  assert.equal(events.some(event => event.type === 'tool.failed'), false);
});
