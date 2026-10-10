import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';
import { startApp, stopApp, readAgent, openSettings, fillComposer, nativeInput, click, waitFor, evaluate, screenshot, profileRoot, fixtureRoot, evidenceRoot, ownedProcess } from './smoke-features.mjs';

const reportPath = path.join(projectRoot, 'desktop', 'logs', 'native-file-tools-smoke.json');
const progressPath = path.join(profileRoot, 'file-tools-progress.json');
const deadlineMs = 900_000, model = 'little-file-tools-native:latest';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function checkpointProgress(report) {
  const file = reportPath.replace(/\.json$/, '.in-progress.json');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2)); await rename(`${file}.tmp`, file);
}
const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { smokeMetadata: 'PRESERVED_NOTEBOOK' }, cells: [
  { cell_type: 'markdown', source: '# Heading\n', metadata: { tags: ['intro'] }, attachments: { 'a.png': { 'image/png': 'PRIVATE_ATTACHMENT' } } },
  { cell_type: 'code', source: 'value = 1\n', metadata: { tags: ['changed'] }, id: 'changed-cell', execution_count: 7, outputs: [{ output_type: 'stream', name: 'stdout', text: 'PRIVATE_CHANGED_OUTPUT' }] },
  { cell_type: 'code', source: 'untouched = 42\n', metadata: { tags: ['untouched'] }, id: 'untouched-cell', execution_count: 8, outputs: [{ output_type: 'stream', name: 'stdout', text: 'PRIVATE_UNCHANGED_OUTPUT' }] },
] };
const notebookBytes = Buffer.from('\uFEFF' + JSON.stringify(notebook) + '\r\n');
const call = (name, args) => ({ name, args });
const plan = call('update_plan', { steps: ['Inspect the current file or creation parent.', 'Request each native reviewed file operation.', 'Inspect observed results without executing commands or notebook cells.'] });
const createText = call('propose_file_edits', { edits: [{ kind: 'create', path: 'sample.ts', content: 'export const value = 1;\r\n' }] });
const editText = call('propose_file_edits', { edits: [{ kind: 'replace', path: 'sample.ts', replacements: [{ search: 'value = 1', replacement: 'value = 2' }] }] });
const deleteText = call('propose_file_edits', { edits: [{ kind: 'delete', path: 'sample.ts' }] });
const docs = ['brief.docx', 'slides.pptx', 'paper.pdf'];
const docCreate = docs.map(file => call('propose_document', { path: file, format: path.extname(file).slice(1), action: 'create', content: file.endsWith('pptx') ? 'Native title\nNative original\n---\nSecond title\nUnchanged second slide' : 'Native original\nUnchanged second paragraph' }));
const docEdit = docs.map(file => call('propose_document', file.endsWith('pdf') ? { path: file, format: 'pdf', action: 'append_text', content: 'Native appended page' }
  : { path: file, format: path.extname(file).slice(1), action: 'replace_text', replacements: [{ search: 'Native original', replacement: 'Native changed' }] }));
const docReads = docs.map(file => call('read_document', { path: file }));
const docInspect = docs.map(file => call('inspect_file', { path: file }));
const docDelete = call('propose_file_edits', { edits: docs.map(file => ({ kind: 'delete', path: file })) });
const notebookRead = call('read_notebook', { path: 'lesson.ipynb', startCell: 1, endCell: 3 });
const notebookPatch = call('propose_notebook_edits', { path: 'lesson.ipynb', action: 'edit', edits: [{ operation: 'patch', cell: 2, search: 'value = 1', replacement: 'value = 10' }] });
const notebookDeleteCell = call('propose_notebook_edits', { path: 'lesson.ipynb', action: 'edit', edits: [{ operation: 'delete', cell: 1, expectedSource: '# Heading\n' }] });
const notebookCreate = call('propose_notebook_edits', { path: 'created.ipynb', action: 'create', edits: [{ operation: 'insert', cell: 1, cellType: 'markdown', source: '# Created native notebook' }, { operation: 'insert', cell: 2, cellType: 'code', source: 'answer = 42\n' }] });
let activeCase;

async function key(app, name, code, keyCode, modifiers = 0) {
  await waitFor(app.findAgent, 'Current native file-tool surfaces', app.client.deadline, 15_000);
  await ownedProcess(app.child.pid, app.expected);
  for (const type of ['keyDown', 'keyUp']) await app.client.send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, modifiers }, app.renderer.sessionId);
}
async function progress() { try { return JSON.parse(await readFile(progressPath, 'utf8')); } catch { return undefined; } }
async function phase(expected, deadline) {
  return waitFor(async () => { const value = await progress(); if (value?.phase === 'failed') throw new Error(value.error); return value?.phase === expected ? value : undefined; }, `Native file fixture ${expected}`, deadline, 30_000);
}
async function command(app, title, expected, deadline) {
  await key(app, 'p', 'KeyP', 80, 10);
  await waitFor(() => evaluate(app.client, `(() => {const input=document.querySelector('.quick-input-widget input');if(!input||!input.getBoundingClientRect().height)return false;input.focus();return true;})()`, app.renderer), 'Native fixture command palette', deadline);
  await key(app, 'a', 'KeyA', 65, 2);
  await app.client.send('Input.insertText', { text: `>${title}` }, app.renderer.sessionId);
  await waitFor(() => evaluate(app.client, `(() => {const widget=document.querySelector('.quick-input-widget');return widget?.querySelector('input')?.value===${JSON.stringify(`>${title}`)}&&[...widget.querySelectorAll('.monaco-list-row')].filter(row=>row.getBoundingClientRect().height&&row.textContent.includes(${JSON.stringify(title)})).length===1;})()`, app.renderer), 'Exact fixture command result', deadline);
  await key(app, 'Enter', 'Enter', 13);
  return phase(expected, deadline);
}
async function closeTrustEditor(app, trusted, deadline, report) {
  const state = trusted ? 'You trust this folder' : 'You are in Restricted Mode';
  await waitFor(async () => {
    await app.findAgent();
    return evaluate(app.client, `(() => {const modal=document.querySelector('.monaco-modal-editor-block');return !!modal&&modal.textContent.includes('Workspace Trust')&&modal.textContent.includes(${JSON.stringify(state)});})()`, app.renderer);
  }, `Native Workspace Trust ${trusted ? 'grant' : 'restriction'}`, deadline);
  await screenshot(app, trusted ? 'file-tools-trust-granted' : 'file-tools-trust-restricted', report);
  const selector = '.monaco-modal-editor-block .modal-editor-action-container .action-label.codicon-close';
  await waitFor(() => evaluate(app.client, `document.querySelectorAll(${JSON.stringify(selector)}).length===1`, app.renderer), 'Owned Workspace Trust close control', deadline);
  await click(app, selector, undefined, app.renderer);
  await waitFor(() => evaluate(app.client, "!document.querySelector('.monaco-modal-editor-block')", app.renderer), 'Native Workspace Trust editor closed', deadline);
}
async function events(app) { await app.findAgent(); return (await evaluate(app.client, 'window.__littleFileSmokeEvents ?? []', app.agent)) ?? []; }
async function observe(app) {
  await app.findAgent();
  assert.equal(await evaluate(app.client, `(() => {window.__littleFileSmokeEvents=[];if(!window.__littleFileSmokeListener){window.__littleFileSmokeListener=true;window.addEventListener('message',message=>{if(message.data?.type==='event')window.__littleFileSmokeEvents.push(message.data.event);});}return true;})()`, app.agent), true);
}
async function provider(report) {
  const server = createServer((request, response) => { void (async () => {
    assert.equal(request.headers.authorization, undefined, 'Credentials must never reach the local scripted fixture.');
    if (request.method === 'GET' && request.url === '/api/tags') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models: [{ name: model, model, size: 1024 }] })); return; }
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/chat');
    let text = ''; for await (const chunk of request) { text += String(chunk); assert.ok(text.length < 4 * 1024 * 1024); }
    const native = JSON.parse(text), current = activeCase;
    assert.ok(current, 'No UI run has authorized a scripted provider response.');
    assert.equal(native.model, model); assert.equal(native.stream, true); assert.equal(native.think, false);
    assert.equal(/PRIVATE_(?:ATTACHMENT|CHANGED_OUTPUT|UNCHANGED_OUTPUT)/.test(text), false, 'Private notebook outputs/attachments reached the local provider.');
    assert.ok(native.messages.some(message => message.role === 'user' && message.content.includes(current.marker)));
    const offered = native.tools?.map(tool => tool.function.name) ?? [];
    const observations = native.messages.filter(message => message.role === 'tool').map(message => ({ name: message.tool_name, output: JSON.parse(message.content) }));
    current.posts++;
    report.providerRequests.push({ case: current.id, post: current.posts, offered, observations });
    let calls;
    if (current.posts === 1) { assert.equal(observations.length, 0); calls = current.initial; }
    else if (current.posts === 2) {
      assert.equal(observations.length, current.initial.length);
      for (let i = 0; i < observations.length; i++) {
        const observed = observations[i], issued = current.initial[i];
        assert.equal(observed.name, issued.name);
        if (/^propose_/.test(issued.name)) {
          if (current.dirty) assert.equal(observed.output.error?.code, 'PERMISSION_DENIED');
          else assert.equal(observed.output.status, current.decision === 'reject' ? 'rejected' : 'applied');
        } else {
          assert.equal(observed.output.error, undefined, `Read/plan failed: ${issued.name}`);
          if (issued.name === 'read_notebook') {
            assert.equal(observed.output.outputsIncluded, false); assert.equal(observed.output.metadataIncluded, false);
            assert.ok(observed.output.content.includes('lesson.ipynb#cell'));
          }
        }
      }
      current.observedResults = true; calls = current.after;
    } else {
      assert.equal(current.posts, 3); assert.ok(current.after.length);
      assert.equal(observations.length, current.initial.length + current.after.length);
      for (const observed of observations.slice(-current.after.length)) {
        assert.equal(observed.output.error, undefined);
        assert.equal(observed.output.content.includes('PRIVATE_'), false, 'Notebook saved outputs/attachments entered a source observation.');
        if (current.id === 'documents-create') assert.ok(observed.output.content.includes('Native original'));
        if (current.id === 'documents-edit') {
          assert.ok(observed.output.content.includes(observed.output.path.endsWith('pdf') ? 'Native appended page' : 'Native changed'));
          if (observed.output.path.endsWith('pdf')) assert.ok(observed.output.content.includes('Native original'));
        }
        if (current.id === 'text-edit') assert.ok(observed.output.content.includes('value = 2'));
        if (current.id === 'notebook-patch') assert.ok(observed.output.content.includes('value = 10') && observed.output.content.includes('untouched = 42'));
        if (current.id === 'notebook-create') assert.ok(observed.output.content.includes('Created native notebook') && observed.output.content.includes('answer = 42'));
      }
      current.observedAfterReads = true;
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    if (calls?.length) {
      assert.ok(calls.every(issued => offered.includes(issued.name)), `Required file tools omitted: ${calls.map(issued => issued.name).filter(name => !offered.includes(name)).join(', ')}`);
      response.end(JSON.stringify({ model, done: true, done_reason: 'tool_calls', message: { role: 'assistant', content: 'Native smoke requests the inspected, planned file operation.', tool_calls: calls.map((issued, index) => ({ function: { index, name: issued.name, arguments: issued.args } })) } }) + '\n');
    } else response.end(JSON.stringify({ model, done: true, done_reason: 'stop', message: { role: 'assistant', content: `${current.id}: ${current.dirty ? 'Denied by the dirty notebook guard; no changes were applied.' : current.decision === 'reject' ? 'The proposals were rejected; no changes were applied.' : 'The observed file tool results are recorded. No commands or notebook cells were executed.'}` } }) + '\n');
  })().catch(error => { report.providerError = error.message; if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
async function runCase(app, report, deadline, id, prompt, readers, proposals, decision = 'accept', after = [], dirty = false) {
  report.phase = id; await checkpointProgress(report);
  // Keep diagnostic case labels out of task semantics (e.g. "text-delete" can
  // mean deletion of file content). Only the actual request informs routing.
  const marker = `LITTLE_NATIVE_CASE_${digest(Buffer.from(id)).slice(0, 12)}`;
  const current = { id, marker, prompt, initial: [...readers, plan, ...proposals], after, decision, dirty, posts: 0 };
  activeCase = current;
  await observe(app);
  await click(app, '.mode-picker button', 'Agent');
  await fillComposer(app, `${marker}: ${prompt}`, deadline); await click(app, '.send-button');
  if (!dirty) for (const [index, proposal] of proposals.entries()) {
    const expectedPaths = proposal.args.path ? [proposal.args.path] : proposal.args.edits.map(edit => edit.path);
    const card = await waitFor(() => evaluate(app.client, `(() => {const cards=[...document.querySelectorAll('.edit-pending')];if(cards.length!==1||cards[0].querySelector('.review-button')?.disabled)return null;const files=[...cards[0].querySelectorAll('.edit-files li')].map(row=>({path:row.querySelector('span')?.textContent,kind:row.querySelector('small')?.textContent}));return JSON.stringify(files.map(file=>file.path))===${JSON.stringify(JSON.stringify(expectedPaths))}?{text:cards[0].textContent,files}:null;})()`, app.agent), `Actual native review card ${id}/${index}`, deadline, 45_000);
    const deleting = proposal.args.edits?.some(edit => edit.kind === 'delete');
    if (deleting) assert.equal(card.files.every(file => file.kind === 'Delete'), true, 'The production UI must label deletion explicitly.');
    report.reviews.push({ case: id, index, decision, card });
    if (decision === 'cancel') { await click(app, '.stop-button'); break; }
    await click(app, '.edit-pending .review-button', 'Review diff');
    await waitFor(() => evaluate(app.client, `!![...document.querySelectorAll('.monaco-diff-editor')].find(editor=>editor.getBoundingClientRect().height>0)`, app.renderer), 'Actual native diff editor', deadline);
    if (index === 0) await screenshot(app, `file-tools-${id}-review`, report);
    const reviewModal = await evaluate(app.client, "(() => {const modal=document.querySelector('.monaco-modal-editor-block');return !!modal?.querySelector('.monaco-diff-editor')&&modal.textContent.includes('Little proposed change');})()", app.renderer);
    if (reviewModal) {
      await click(app, '.monaco-modal-editor-block .modal-editor-action-container .action-label.codicon-close', undefined, app.renderer);
      await waitFor(() => evaluate(app.client, "!document.querySelector('.monaco-modal-editor-block')", app.renderer), 'Native review editor closed after inspection', deadline);
    }
    await click(app, '.edit-pending .edit-decision button', decision === 'reject' ? 'Reject' : 'Accept changes');
  }
  const observed = await waitFor(async () => {
    if (report.providerError) throw new Error(report.providerError);
    const entries = await events(app), start = entries.find(event => event.type === 'agent.started');
    if (!start) return undefined;
    const end = entries.find(event => event.runId === start.runId && ['agent.completed', 'agent.cancelled', 'agent.failed'].includes(event.type));
    if (end?.type === 'agent.failed') throw new Error(`${id}: ${end.code}: ${end.message}`);
    return end ? entries : undefined;
  }, `Observed production run outcome ${id}`, deadline, 60_000);
  const starts = observed.filter(event => event.type === 'tool.started').map(event => event.call.name);
  assert.deepEqual(starts.slice(0, current.initial.length), current.initial.map(issued => issued.name));
  const planIndex = observed.findIndex(event => event.type === 'agent.plan.updated'), mutationIndex = observed.findIndex(event => event.type === 'tool.started' && /^propose_/.test(event.call.name));
  assert.ok(planIndex >= 0 && mutationIndex > planIndex);
  assert.ok(observed.filter(event => event.type === 'tool.started').every(event => event.call.arguments === ''), 'Raw write bytes must not enter UI events.');
  if (decision === 'cancel') assert.ok(observed.some(event => event.type === 'agent.cancelled'));
  else assert.equal(current.observedResults, true, 'The scripted provider must receive the actual host operation result.');
  if (after.length) assert.equal(current.observedAfterReads, true);
  report.cases.push({ id, posts: current.posts, decision, events: observed });
  await checkpointProgress(report); console.log(`Native file case ${id} passed with real host events and ${current.posts} provider observations.`);
  activeCase = undefined;
  await waitFor(async () => (await readAgent(app))?.promptEnabled, 'Composer after completed native run', deadline);
}
const dialogs = String.raw`(() => [...document.querySelectorAll('.monaco-dialog-box')].filter(dialog=>dialog.getBoundingClientRect().height).map(dialog=>({text:dialog.textContent.replace(/\s+/g,' ').trim(),buttons:[...dialog.querySelectorAll('button,[role="button"]')].filter(button=>button.getBoundingClientRect().height).map(button=>button.textContent.replace(/\s+/g,' ').trim())})))()`;
async function restore(app, report, deadline, files, before, fromPicker = false) {
  const open = async () => {
    if (fromPicker) {
      await click(app, '.repository-card button', 'Saved checkpoints');
      await waitFor(() => evaluate(app.client, `(() => {const widget=document.querySelector('.quick-input-widget');return widget?.getBoundingClientRect().height&&widget.textContent.includes('Restore a Little checkpoint')&&[...widget.querySelectorAll('.monaco-list-row')].some(row=>row.textContent.includes(${JSON.stringify(files[0])}));})()`, app.renderer), 'Native saved checkpoint selection', deadline);
      await ownedProcess(app.child.pid, app.expected);
      assert.equal(await evaluate(app.client, `(() => {const rows=[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].filter(row=>row.getBoundingClientRect().height&&row.textContent.includes(${JSON.stringify(files[0])}));if(!rows.length)return false;rows[0].click();return true;})()`, app.renderer), true);
    } else await click(app, '.checkpoint-controls button', 'Restore changes');
  };
  const confirm = async button => {
    const value = await waitFor(async () => { const all = await evaluate(app.client, dialogs, app.renderer); return all?.find(dialog => dialog.text.includes('Restore this Little checkpoint?') && files.every(file => dialog.text.includes(file)) && dialog.buttons.includes(button)); }, 'Actual checkpoint Restore/Cancel confirmation', deadline);
    report.modals.push({ files, button, ...value });
    await screenshot(app, `file-tools-restore-${files[0]}-${button === 'Cancel' ? 'cancel' : 'confirm'}`, report);
    await click(app, '.monaco-dialog-box button,.monaco-dialog-box [role="button"]', button, app.renderer);
  };
  const present = async () => Promise.all(files.map(async file => { try { return await readFile(path.join(fixtureRoot, file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }));
  const cancelled = await present();
  await open(); await confirm('Cancel'); assert.deepEqual(await present(), cancelled);
  await open(); await confirm('Restore checkpoint');
  await waitFor(async () => (await present()).every((bytes, index) => bytes?.equals(before[index])), 'Exact native checkpoint original bytes', deadline);
  report.restores.push({ files, exactHashes: before.map(digest), cancelledPreserved: true, confirmedExact: true });
}
async function fixtureFiles(report) {
  const extension = path.join(profileRoot, 'file-tools-smoke-extension'), production = path.join(packagedRoot, 'resources', 'app', 'extensions', 'little-code');
  const updated = JSON.parse(await readFile(path.join(projectRoot, 'desktop', 'logs', 'agent-update.json'), 'utf8')); assert.equal(updated.success, true);
  await Promise.all([mkdir(extension, { recursive: true }), mkdir(fixtureRoot, { recursive: true }), mkdir(evidenceRoot, { recursive: true }), mkdir(path.join(profileRoot, 'user-data', 'User'), { recursive: true })]);
  const files = {};
  for (const file of Object.keys(updated.files)) {
    assert.ok(file === 'package.json' || file.startsWith('dist/'));
    assert.equal(path.relative(production, path.join(production, file)).replaceAll('\\', '/'), file);
    const bytes = await readFile(path.join(production, file)); files[file] = digest(bytes); assert.equal(files[file], updated.files[file].sha256);
  }
  for (const required of ['dist/extension.cjs', 'dist/webview.js', 'dist/webview.css', 'dist/document-pdf-worker.cjs', 'dist/pdf/pdf.mjs']) assert.ok(files[required], `Package latest document assets before running: ${required}`);
  const bundle = await readFile(path.join(production, 'dist/extension.cjs'), 'utf8');
  for (const required of ['propose_notebook_edits', 'propose_document', 'read_document', 'inspect_file', 'regular-file deletion', 'notebookDocuments']) assert.ok(bundle.includes(required), `The packaged file tool bundle is stale: ${required}`);
  await cp(path.join(production, 'dist'), path.join(extension, 'dist'), { recursive: true }); await cp(path.join(production, 'resources'), path.join(extension, 'resources'), { recursive: true });
  for (const [file, expected] of Object.entries(files).filter(([file]) => file !== 'package.json')) assert.equal(digest(await readFile(path.join(extension, file))), expected);
  const manifest = JSON.parse(await readFile(path.join(production, 'package.json'), 'utf8'));
  manifest.name = 'little-native-file-tools-smoke'; manifest.publisher = 'little-code-local-tests'; manifest.main = './fixture.cjs'; manifest.activationEvents = ['*'];
  manifest.capabilities = { ...manifest.capabilities, untrustedWorkspaces: { supported: true } };
  manifest.contributes.notebooks = [...(manifest.contributes.notebooks ?? []), { type: 'little-file-smoke-notebook', displayName: 'Disposable file-tool smoke notebook', selector: [{ filenamePattern: '*.ipynb' }] }];
  manifest.contributes.commands.push(...[['makeDirty', 'File tools smoke: Make dirty notebook'], ['revertDirty', 'File tools smoke: Revert dirty notebook'], ['observeTrust', 'File tools smoke: Observe workspace trust'], ['manageTrust', 'File tools smoke: Manage native trust']].map(([id, title]) => ({ command: `littleFileSmoke.${id}`, title })));
  await writeFile(path.join(extension, 'package.json'), JSON.stringify(manifest));
  await build({ entryPoints: [path.join(projectRoot, 'tests/fixtures/file-tools-native-smoke.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'fixture.cjs') });
  await writeFile(path.join(fixtureRoot, 'README.md'), '# Isolated native file tools smoke\n'); await writeFile(path.join(fixtureRoot, 'lesson.ipynb'), notebookBytes);
  await writeFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never' }));
  const sources = {};
  for (const file of ['src/little/tools/edit-proposals.ts', 'src/extension/edit-review.ts', 'src/extension/extension.ts', 'src/little/tools/workspace-service.ts', 'src/little/tools/notebook-edit-tools.ts', 'src/little/tools/document-tools.ts', 'src/little/tools/document-ooxml.ts', 'src/little/tools/document-pdf.ts', 'src/little/tools/document-pdf-worker.ts', 'src/little/tools/document-pdf-generation.ts', 'scripts/smoke-features.mjs', 'scripts/smoke-file-tools.mjs', 'tests/fixtures/file-tools-native-smoke.ts']) sources[file] = digest(await readFile(path.join(projectRoot, file)));
  report.productionBundle = { updatedAt: updated.updatedAt, files, copiedUnchanged: true, originalExtensionDisabled: true, fixtureAddsOnlyEditorCommandsAndSerializer: true, sources };
  return extension;
}
async function main() {
  assert.ok(process.argv.slice(2).every(argument => ['--help', '--dry-run'].includes(argument)));
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/smoke-file-tools.mjs [--dry-run]\nExercises the unchanged packaged production file tools and review UI through local scripted Ollama in one isolated owned app instance.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ executable: packagedExecutable, profileRoot, reportPath, deadlineMs, launchesProcesses: false }, null, 2)); return; }
  assert.equal(process.platform, 'win32');
  const started = Date.now(), deadline = started + deadlineMs;
  const report = { success: false, startedAt: new Date(started).toISOString(), profileRoot, assertions: {}, launches: [], screenshots: [], cases: [], reviews: [], restores: [], modals: [], providerRequests: [] };
  let app, local;
  try {
    report.phase = 'fixture-bundle-validation';
    const extension = await fixtureFiles(report); local = await provider(report); report.localProvider = local.url;
    report.sharedDataDirectory = path.join(profileRoot, 'shared-data');
    report.phase = 'owned-app-startup'; await checkpointProgress(report);
    app = await startApp(await realpath(packagedExecutable), deadline, report, [`--extensionDevelopmentPath=${extension}`, '--disable-extension=priyanshu-chaurasia.little-code', `--shared-data-dir=${report.sharedDataDirectory}`], { enableWorkspaceTrust: true });
    const ready = await phase('ready', deadline); Object.assign(report.assertions, ready.assertions);
    report.phase = 'native-ollama-settings'; await checkpointProgress(report);
    await openSettings(app, deadline); await click(app, '.provider-choice button', 'Ollama · local');
    await waitFor(async () => (await readAgent(app))?.provider === 'Ollama · local', 'Native local provider switch', deadline, 35_000);
    report.phase = 'native-ollama-endpoint'; await checkpointProgress(report);
    await click(app, '.project-settings button', 'Configure Ollama'); await nativeInput(app, 'Connect Little Code to Ollama', local.url, deadline);
    await waitFor(async () => { const state = await readAgent(app); return state?.endpoint === local.url && state.models.includes(model) && state.promptEnabled; }, 'Production model discovery', deadline);
    report.phase = 'native-workspace-trust'; await checkpointProgress(report);
    if (ready.trusted) {
      await command(app, 'File tools smoke: Manage native trust', 'trust-ui', deadline);
      await click(app, '.workspace-trust-buttons [role="button"],.workspace-trust-buttons button,.workspace-trust-buttons a', "Don't Trust", app.renderer);
      await closeTrustEditor(app, false, deadline, report);
    }
    const restricted = await command(app, 'File tools smoke: Observe workspace trust', 'trust-observed', deadline); assert.equal(restricted.trusted, false);
    await fillComposer(app, 'LITTLE_NATIVE_RESTRICTED: Create sample.ts', deadline); await click(app, '.send-button');
    await waitFor(async () => (await readAgent(app))?.error?.includes('Trust this workspace before starting an AI run.'), 'Production untrusted run denial', deadline);
    assert.equal(report.providerRequests.length, 0); await assert.rejects(stat(path.join(fixtureRoot, 'sample.ts')), { code: 'ENOENT' });
    report.assertions.realUntrustedWorkspaceDeniedBeforeProvider = true; await screenshot(app, 'file-tools-untrusted', report);
    await command(app, 'File tools smoke: Manage native trust', 'trust-ui', deadline);
    await click(app, '.workspace-trust-buttons [role="button"],.workspace-trust-buttons button,.workspace-trust-buttons a', 'Trust', app.renderer);
    await closeTrustEditor(app, true, deadline, report);
    assert.equal((await command(app, 'File tools smoke: Observe workspace trust', 'trust-observed', deadline)).trusted, true);
    report.assertions.nativeTrustGranted = true;
    await checkpointProgress(report); console.log('Actual restricted-workspace denial and native Trust grant passed.');
    if ((await readAgent(app))?.settings) await click(app, 'button[aria-label="Little settings"]');
    await runCase(app, report, deadline, 'text-cancel', 'Create sample.ts in the workspace root.', [call('list_directory', { path: '.' })], [createText], 'cancel');
    await assert.rejects(stat(path.join(fixtureRoot, 'sample.ts')), { code: 'ENOENT' });
    await runCase(app, report, deadline, 'text-create', 'Create sample.ts in the workspace root.', [call('list_directory', { path: '.' })], [createText]);
    assert.equal(await readFile(path.join(fixtureRoot, 'sample.ts'), 'utf8'), 'export const value = 1;\r\n');
    await runCase(app, report, deadline, 'text-edit', 'Edit sample.ts to increment its value.', [call('read_file', { path: 'sample.ts' })], [editText], 'accept', [call('read_file', { path: 'sample.ts' })]);
    const changedText = await readFile(path.join(fixtureRoot, 'sample.ts')); assert.equal(changedText.toString(), 'export const value = 2;\r\n');
    await runCase(app, report, deadline, 'text-delete-reject', 'Delete sample.ts.', [call('inspect_file', { path: 'sample.ts' })], [deleteText], 'reject');
    assert.deepEqual(await readFile(path.join(fixtureRoot, 'sample.ts')), changedText);
    await runCase(app, report, deadline, 'text-delete', 'Delete sample.ts.', [call('inspect_file', { path: 'sample.ts' })], [deleteText]);
    await assert.rejects(stat(path.join(fixtureRoot, 'sample.ts')), { code: 'ENOENT' }); await restore(app, report, deadline, ['sample.ts'], [changedText]);
    report.assertions.nativeTextCreateEditDeleteCancelRejectRestore = true;
    await runCase(app, report, deadline, 'documents-create', 'Create brief.docx, slides.pptx and paper.pdf with native original text.', [call('list_directory', { path: '.' })], docCreate, 'accept', docReads);
    const docBefore = await Promise.all(docs.map(file => readFile(path.join(fixtureRoot, file))));
    await runCase(app, report, deadline, 'documents-edit-reject', 'Edit brief.docx and slides.pptx and append text to paper.pdf.', docReads, docEdit, 'reject');
    for (const [index, file] of docs.entries()) assert.deepEqual(await readFile(path.join(fixtureRoot, file)), docBefore[index]);
    await runCase(app, report, deadline, 'documents-edit', 'Edit brief.docx and slides.pptx and append text to paper.pdf.', docReads, docEdit, 'accept', docReads);
    const docAfter = await Promise.all(docs.map(file => readFile(path.join(fixtureRoot, file))));
    assert.ok(docAfter.every((bytes, index) => !bytes.equals(docBefore[index])));
    // Restore each edit while its committed inode is still current. A later
    // deletion/restore correctly invalidates that older checkpoint fingerprint.
    for (const file of [...docs].reverse()) await restore(app, report, deadline, [file], [docBefore[docs.indexOf(file)]], true);
    await runCase(app, report, deadline, 'documents-delete', 'Delete brief.docx, slides.pptx and paper.pdf.', docInspect, [docDelete]);
    for (const file of docs) await assert.rejects(stat(path.join(fixtureRoot, file)), { code: 'ENOENT' });
    await restore(app, report, deadline, docs, docBefore);
    report.assertions.nativeDocumentsCreateReadEditAppendRejectDeleteByteRestore = true;
    Object.assign(report.assertions, (await command(app, 'File tools smoke: Make dirty notebook', 'dirty-ready', deadline)).assertions);
    await runCase(app, report, deadline, 'notebook-dirty', 'Edit lesson.ipynb with the inspected cell patch.', [notebookRead], [notebookPatch], 'accept', [], true);
    assert.deepEqual(await readFile(path.join(fixtureRoot, 'lesson.ipynb')), notebookBytes);
    report.assertions.nativeDirtyNotebookDeniedBeforeReview = true;
    Object.assign(report.assertions, (await command(app, 'File tools smoke: Revert dirty notebook', 'clean-ready', deadline)).assertions);
    await runCase(app, report, deadline, 'notebook-reject', 'Edit lesson.ipynb with the inspected cell patch.', [notebookRead], [notebookPatch], 'reject');
    assert.deepEqual(await readFile(path.join(fixtureRoot, 'lesson.ipynb')), notebookBytes);
    await runCase(app, report, deadline, 'notebook-patch', 'Edit lesson.ipynb with the inspected cell patch.', [notebookRead], [notebookPatch], 'accept', [notebookRead]);
    let changed = JSON.parse(await readFile(path.join(fixtureRoot, 'lesson.ipynb'), 'utf8'));
    assert.equal(changed.cells[1].source, 'value = 10\n'); assert.deepEqual(changed.cells[1].outputs, []); assert.equal(changed.cells[1].execution_count, null);
    assert.deepEqual(changed.cells[2], notebook.cells[2]); assert.deepEqual(changed.cells[0], notebook.cells[0]); assert.deepEqual(changed.metadata, notebook.metadata);
    await restore(app, report, deadline, ['lesson.ipynb'], [notebookBytes]);
    await runCase(app, report, deadline, 'notebook-delete-cell', 'Edit lesson.ipynb to delete its first source cell.', [notebookRead], [notebookDeleteCell]);
    changed = JSON.parse(await readFile(path.join(fixtureRoot, 'lesson.ipynb'), 'utf8')); assert.equal(changed.cells.length, 2);
    assert.deepEqual(changed.cells[0], notebook.cells[1]); assert.deepEqual(changed.cells[1], notebook.cells[2]); assert.deepEqual(changed.metadata, notebook.metadata);
    await restore(app, report, deadline, ['lesson.ipynb'], [notebookBytes]);
    await runCase(app, report, deadline, 'notebook-create', 'Create created.ipynb in the workspace root.', [call('list_directory', { path: '.' })], [notebookCreate], 'accept', [call('read_notebook', { path: 'created.ipynb' })]);
    const created = await readFile(path.join(fixtureRoot, 'created.ipynb'));
    await runCase(app, report, deadline, 'notebook-delete-file', 'Delete created.ipynb.', [call('inspect_file', { path: 'created.ipynb' })], [call('propose_file_edits', { edits: [{ kind: 'delete', path: 'created.ipynb' }] })]);
    await restore(app, report, deadline, ['created.ipynb'], [created]);
    report.assertions.nativeNotebookReadCreatePatchCellDeleteFileDeleteUntouchedOutputsAndRestore = true;
    report.assertions.actualToolStartedEventsAndPostResultObservations = report.cases.every(item => item.events.some(event => event.type === 'tool.started'));
    report.assertions.privateNotebookOutputsAndAttachmentsNeverSent = !report.providerError;
    report.assertions.allReviewGatesUsedProductionUI = report.reviews.length >= 15 && report.modals.length >= 10;
    await screenshot(app, 'file-tools-complete', report); assert.ok(Object.values(report.assertions).every(Boolean)); report.success = true;
    console.log('Actual packaged file tools, native review, trust/dirty guards, document/notebook operations and byte-exact recovery passed.');
  } catch (error) {
    report.error = error.message; app ??= error.smokeApp; report.progress = await progress(); process.exitCode = 1;
    console.error(`Native file tool smoke failed in ${report.phase}: ${error.message}`);
    if (app?.client && !app.exited) try { await screenshot(app, 'file-tools-failed', report); } catch { /* Keep the original failure. */ }
  } finally {
    report.assertionsPassed = report.success;
    try { await stopApp(app, report); } catch (error) { report.cleanupError = error.message; report.success = false; process.exitCode = 1; }
    await local?.close();
    report.cleanupConfirmed = report.launches.length > 0 && report.launches.every(item => item.cleanupConfirmed === true);
    if (!report.cleanupConfirmed) { report.success = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
    await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n'); await rename(`${reportPath}.tmp`, reportPath);
    console.log(`Native file tool evidence: ${reportPath}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
