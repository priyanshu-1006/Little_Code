import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';
import { startApp, stopApp, readAgent, openSettings, fillComposer, click, waitFor, evaluate, screenshot, profileRoot, fixtureRoot, evidenceRoot } from './smoke-features.mjs';

const reportPath = path.join(projectRoot, 'desktop', 'logs', 'native-groq-smoke.json');
const fixtureName = `little-native-groq-smoke-${sha(Buffer.from(profileRoot)).slice(0, 12)}`;
const fixturePublisher = 'little-code-local-tests';
const primaryModel = 'openai/gpt-oss-120b';
const alternateModel = 'openai/gpt-oss-20b';
const fakeKey = 'gsk_NATIVE_LOCAL_FIXTURE_ONLY_NOT_A_REAL_KEY_000000';
const prompt = 'Analyse the codebase architecture, entry points, authentication and storage boundaries. Cite the relevant source files.';
const completionText = 'LITTLE_NATIVE_GROQ_ANALYSIS_OK — src/main.ts enters the app; src/auth.ts controls login and src/storage.ts stores records. These conclusions come from the inspected fixture source; no checks were executed.';
const privateFailedGeneration = 'PRIVATE_FAILED_GENERATION_NATIVE_GROQ_FIXTURE_DO_NOT_RENDER';
const privateStreamOrganization = 'PRIVATE_JSON_GROQ_FIXTURE_ORGANIZATION';
const privateStreamEcho = 'PRIVATE_JSON_PROVIDER_ECHO_NOT_FOR_UI';
const streamErrorRequestId = 'req_01jbd6g2qdfw2adyrt2az8hz4w';
const expectedAssertionCount = 30;
const deadlineMs = 540000;

function samePath(first, second) { return path.resolve(first).replaceAll('\\', '/').toLowerCase() === path.resolve(second).replaceAll('\\', '/').toLowerCase(); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function observations(messages) { return messages.filter(message => message.role === 'tool'); }
function completion(response, decision, inputTokens, outputTokens) {
  const tool = decision.kind !== 'answer';
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_owned_read', type: 'function',
    function: { name: decision.name, arguments: typeof decision.arguments === 'string' ? decision.arguments : JSON.stringify(decision.arguments) } }] }
    : { role: 'assistant', content: decision.answer, reasoning: 'PRIVATE_REASONING_FIXTURE_DO_NOT_RENDER' };
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], x_groq: { id: streamErrorRequestId } })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function transport(report) {
  let modelsMode = 'ready';
  let completionMode = 'limited';
  let awaitingFreshRead = false;
  const failures = [];
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(Buffer.byteLength(body, 'utf8') < 100000, 'Native request body exceeded the fixture safety bound.'); }
      assert.equal(request.headers.authorization, `Bearer ${fakeKey}`, 'Only the fake key entered through native SecretStorage is accepted.');
      if (request.method === 'GET' && request.url === '/openai/v1/models') {
        report.transport.modelRequests++;
        if (modelsMode === 'failed') { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'local transient fixture failure' } })); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [
          { id: 'canopylabs/orpheus-v1-english', active: true, context_window: 4000 },
          { id: 'whisper-large-v3', active: true }, { id: 'whisper-large-v3-turbo', active: true },
          { id: 'meta-llama/llama-prompt-guard-2-22m', active: true }, { id: 'openai/gpt-oss-safeguard-20b', active: true },
          { id: 'groq/compound', active: true }, { id: 'declared-no-tools', active: true, supports_tool_calling: false },
          { id: primaryModel, active: true, context_window: 131072, max_completion_tokens: 65536 },
          { id: alternateModel, active: true, context_window: 131072, max_completion_tokens: 65536 },
          { id: 'future-chat-model', active: true, context_window: 32768 },
        ] })); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/openai/v1/chat/completions');
      const parsed = JSON.parse(body);
      assert.ok([primaryModel, alternateModel].includes(parsed.model));
      assert.equal(parsed.stream, true); assert.equal(parsed.include_reasoning, false); assert.equal(parsed.reasoning_effort, 'low');
      assert.equal(parsed.reasoning_format, undefined); assert.equal(parsed.max_completion_tokens, 2048);
      assert.equal(parsed.response_format, undefined);
      assert.equal(parsed.tool_choice, 'auto'); assert.equal(parsed.parallel_tool_calls, false);
      assert.deepEqual(parsed.stream_options, { include_usage: true });
      const tools = parsed.tools.map(tool => { assert.equal(tool.type, 'function'); return tool.function; });
      assert.ok(tools.some(tool => tool.name === 'read_file'));
      assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length);
      const readTool = tools.find(tool => tool.name === 'read_file');
      assert.equal(readTool.parameters.type, 'object');
      assert.equal(readTool.parameters.properties.path.type, 'string');
      assert.deepEqual(readTool.parameters.required, ['path']);
      assert.equal(readTool.parameters.additionalProperties, false);
      assert.ok(!body.includes('_little_empty'), 'Native no-argument tools use their original empty object schema.');
      assert.ok(parsed.messages.every(message => ['system', 'user', 'assistant', 'tool'].includes(message.role) && typeof message.content === 'string'));
      assert.ok(body.includes('Analyse the codebase architecture'));
      assert.ok(!body.includes(fakeKey));
      assert.ok(Buffer.byteLength(body, 'utf8') < 17000, 'Actual Groq wire body must remain small despite the large repository fixture.');
      const estimatedTokens = Math.ceil(Buffer.byteLength(body, 'utf8') / 3) + 64 + tools.length * 8 + parsed.max_completion_tokens;
      assert.ok(estimatedTokens <= 5500, 'Actual messages, schemas, and output reserve must fit the Groq request contract.');
      const captured = { model: parsed.model, bodyBytes: Buffer.byteLength(body, 'utf8'), estimatedTokens, maxOutputTokens: parsed.max_completion_tokens,
        toolNames: tools.map(tool => tool.name), userPromptIncluded: true, privateReasoningExcluded: parsed.include_reasoning === false,
        actionTransport: 'native-functions', parallelToolCalls: false, responseSchemaAbsent: true,
        toolObservations: observations(parsed.messages).length,
        sourcePaths: [...new Set([...body.matchAll(/src\/(?:main|auth|storage|routes|controller|view)\.ts/g)].map(match => match[0]))],
        contextShortened: body.includes('Context shortened'), messages: parsed.messages.length, phase: completionMode };
      requests.push({ ...captured, wire: parsed }); report.transport.completions.push(captured);
      if (completionMode === 'limited') {
        assert.equal(parsed.model, primaryModel);
        response.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '120', 'x-ratelimit-limit-tokens': '8000',
          'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '120s' });
        response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for model openai/gpt-oss-120b in organization PRIVATE_GROQ_FIXTURE_ORGANIZATION on tokens per minute (TPM): Limit 8000, Used 7700, Requested 4800. Please try again in 120s. api_key=PRIVATE_PROVIDER_ECHO_NOT_FOR_UI' } }));
        return;
      }
      assert.equal(parsed.model, alternateModel);
      if (completionMode === 'invalid-call') {
        assert.equal(observations(parsed.messages).length, 0, 'A malformed native tool call must be a fresh request.');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': streamErrorRequestId });
        // The streamed function arguments are incomplete JSON. Production must
        // validate the complete buffered call before exposing any executable event.
        completion(response, { kind: 'tool', name: 'read_file', arguments: '{' }, 1100, 40);
        return;
      }
      if (completionMode === 'tool-error') {
        assert.equal(observations(parsed.messages).length, 0, 'A streamed provider error must be a fresh request with no tool observation.');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ error: { code: 'tool_use_failed', type: 'invalid_request_error',
          message: 'Failed to call a function. See failed_generation for details.',
          failed_generation: `<function=read_file>{"path":"src/main.ts","private":"${privateFailedGeneration}"}</function>` }, x_groq: { id: streamErrorRequestId } })}\n\n`);
        return;
      }
      if (completionMode === 'stream-limited') {
        assert.equal(observations(parsed.messages).length, 0, 'A streamed rate limit must be a fresh request.');
        // Deliberately omit HTTP429 and retry/quota headers: JSON-body evidence
        // alone must classify this error and establish the model's cooldown.
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ error: { code: 'rate_limit_exceeded', type: 'tokens',
          message: `Rate limit reached for model ${alternateModel} in organization ${privateStreamOrganization} on tokens per minute (TPM): Limit 8000, Used 7700, Requested 4800. Please try again in 120s. api_key=${privateStreamEcho}` }, x_groq: { id: streamErrorRequestId } })}\n\n`);
        return;
      }
      assert.equal(completionMode, 'success');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '7000', 'x-ratelimit-reset-tokens': '1s', 'x-ratelimit-remaining-requests': '100', 'x-ratelimit-reset-requests': '1h' });
      const observed = observations(parsed.messages);
      assert.ok(!awaitingFreshRead || observed.length === 1,
        'The first successful follow-up must preserve the latest freshly executed read_file observation; a summary without source evidence is insufficient.');
      if (!observed.length) {
        awaitingFreshRead = true;
        completion(response, { kind: 'tool', name: 'read_file', arguments: { path: 'src/main.ts' } }, 1100, 40);
      } else {
        assert.equal(observed.length, 1, 'One locally executed action must produce exactly one native role=tool observation.');
        assert.equal(observed[0].tool_call_id, 'call_owned_read');
        assert.ok(observed[0].content.includes('LITTLE_GROQ_FIXTURE_ENTRY'), 'The real workspace read result must reach the provider as a native tool observation.');
        assert.ok(parsed.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === observed[0].tool_call_id && call.function.name === 'read_file')));
        awaitingFreshRead = false;
        report.assertions.actualWorkspaceToolResult = true;
        completion(response, { kind: 'answer', answer: completionText }, 1250, 90);
      }
    })().catch(error => { failures.push(error.message); if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Native Groq fixture assertion failed.' } })); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, failures,
    failModels() { modelsMode = 'failed'; }, restoreModels() { modelsMode = 'ready'; }, allowCompletions() { completionMode = 'success'; awaitingFreshRead = false; },
    failInvalidCall() { completionMode = 'invalid-call'; }, failToolCall() { completionMode = 'tool-error'; }, limitStreamResponse() { completionMode = 'stream-limited'; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function fixtureFiles(endpoint, report) {
  const extensionRoot = path.join(profileRoot, 'groq-test-extension');
  const productionRoot = path.join(packagedRoot, 'resources', 'app', 'extensions', 'little-code');
  const update = JSON.parse(await readFile(path.join(projectRoot, 'desktop', 'logs', 'agent-update.json'), 'utf8'));
  assert.equal(update.success, true);
  assert.ok(samePath(update.extension, productionRoot));
  const manifest = JSON.parse(await readFile(path.join(productionRoot, 'package.json'), 'utf8'));
  await mkdir(extensionRoot, { recursive: true }); await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
  for (const relative of ['dist/extension.cjs', 'dist/webview.js', 'dist/webview.css']) {
    const bytes = await readFile(path.join(productionRoot, relative));
    assert.equal(sha(bytes), update.files[relative].sha256, `Packaged ${relative} must match the completed update report.`);
    assert.equal(sha(bytes), sha(await readFile(path.join(projectRoot, relative))), `Packaged ${relative} must match the latest source build.`);
    report.productionArtifacts[relative] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  await cp(path.join(productionRoot, 'dist'), path.join(extensionRoot, 'dist'), { recursive: true, errorOnExist: true });
  await cp(path.join(productionRoot, 'resources'), path.join(extensionRoot, 'resources'), { recursive: true, errorOnExist: true });
  await cp(path.join(projectRoot, 'tests', 'fixtures', 'groq-native-smoke.cjs'), path.join(extensionRoot, 'fixture.cjs'));
  await writeFile(path.join(extensionRoot, 'package.json'), `${JSON.stringify({ ...manifest, name: fixtureName, publisher: fixturePublisher, version: '0.0.0',
    main: './fixture.cjs', activationEvents: ['*'], scripts: undefined, dependencies: undefined, devDependencies: undefined }, null, 2)}\n`);
  await writeFile(path.join(extensionRoot, 'fixture-config.json'), JSON.stringify({ endpoint }));
  await mkdir(path.join(profileRoot, 'user-data', 'User'), { recursive: true });
  await writeFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), JSON.stringify({
    'window.dialogStyle': 'custom', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'little.provider': 'groq', 'little.model': primaryModel,
  }));
  const sourceFiles = {
    'main.ts': 'import { login } from "./auth";\nimport { store } from "./storage";\nexport const LITTLE_GROQ_FIXTURE_ENTRY = "native entry";\nexport function startApplication() { return store(login("fixture-user")); }\n',
    'auth.ts': 'export function login(user: string) { return { user, authenticated: !!user }; }\n',
    'storage.ts': 'export function store(record: unknown) { return { stored: true, record }; }\n',
    'routes.ts': 'import { startApplication } from "./main";\nexport function route() { return startApplication(); }\n',
    'controller.ts': 'import { route } from "./routes";\nexport function controlRequest() { return route(); }\n',
    'view.ts': 'export function renderView() { return "Native Groq coding fixture"; }\n',
  };
  for (const [name, source] of Object.entries(sourceFiles)) await writeFile(path.join(fixtureRoot, 'src', name), source +
    `// Codebase architecture module ${name}; authentication entry storage boundaries.\n`.repeat(700));
  await writeFile(path.join(fixtureRoot, 'README.md'), '# Native Groq fixture\nThe application architecture enters src/main.ts and separates authentication from storage.\n');
  report.fixture = { extensionId: `${fixturePublisher}.${fixtureName}`, extensionRoot, fixtureRoot, updateTime: update.updatedAt,
    transport: endpoint, fakeKeyOnly: true, bundledProductionDisabled: true };
  return extensionRoot;
}

async function passwordInput(app, deadline) {
  await waitFor(() => evaluate(app.client, `(() => {const widget=document.querySelector('.quick-input-widget');if(!widget||!widget.textContent.includes('Connect Little Code to Groq')||!widget.getBoundingClientRect().height)return false;const input=widget.querySelector('input[type="password"]');if(!input||!input.getBoundingClientRect().height)return false;input.focus();return true;})()`, app.renderer), 'Actual native Groq password dialog', deadline);
  for (const type of ['keyDown', 'keyUp']) await app.client.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, app.renderer.sessionId);
  await app.client.send('Input.insertText', { text: fakeKey }, app.renderer.sessionId);
  assert.equal(await evaluate(app.client, `document.querySelector('.quick-input-widget input[type="password"]')?.value===${JSON.stringify(fakeKey)}`, app.renderer), true);
  for (const type of ['keyDown', 'keyUp']) await app.client.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, app.renderer.sessionId);
  await waitFor(() => evaluate(app.client, `(() => {const widget=document.querySelector('.quick-input-widget');return !widget||widget.getBoundingClientRect().height===0;})()`, app.renderer), 'Accepted native Groq password dialog', deadline);
}

async function selectModel(app, model, deadline) {
  assert.equal(await evaluate(app.client, `(() => {const select=document.querySelector('#little-model');if(!select||select.disabled||![...select.options].some(option=>option.value===${JSON.stringify(model)}))return false;select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`, app.agent), true, 'Actual model selection UI must be available.');
  await waitFor(async () => (await readAgent(app))?.model === model, 'Selected native Groq model', deadline);
}

async function uiDetails(app) {
  await readAgent(app);
  return evaluate(app.client, `(() => ({model:document.querySelector('#little-model')?.value,modelDisabled:document.querySelector('#little-model')?.disabled,
    sendDisabled:document.querySelector('.send-button')?.disabled,discovery:document.querySelector('.provider-discovery-status')?.textContent,
    runState:[...document.querySelector('.agent-status')?.classList??[]].find(value=>['failed','completed','cancelled','blocked'].includes(value)),
    error:document.querySelector('.error-card')?.textContent,prompt:document.querySelector('#little-prompt')?.value,
    toolNames:[...document.querySelectorAll('.tool-card .tool-name')].map(element=>element.textContent),
    sendTitle:document.querySelector('.send-button')?.title,usage:document.querySelector('.usage-card')?.textContent,
    text:document.querySelector('main.agent-shell')?.textContent}))()`, app.agent);
}

async function historyDetails(app) {
  await readAgent(app);
  return evaluate(app.client, `(() => ({selected:document.querySelector('#little-chat')?.value,
    disabled:document.querySelector('#little-chat')?.disabled,
    pending:document.querySelector('.chat-history-bar')?.getAttribute('aria-busy')==='true',
    saveStatus:document.querySelector('.chat-save-status')?.textContent,
    options:[...document.querySelectorAll('#little-chat option')].map(option=>({value:option.value,label:option.textContent})),
    turns:[...document.querySelectorAll('.chat-turn[data-chat-turn]')].map(turn=>({id:turn.dataset.chatTurn,
      status:turn.querySelector('.chat-turn-meta .badge')?.textContent,
      prompt:turn.querySelector('.chat-prompt p')?.textContent,answer:turn.querySelector('.saved-answer-text')?.textContent??''})),
    currentPrompt:document.querySelector('.current-chat-prompt p')?.textContent,
    composer:document.querySelector('#little-prompt')?.value,
    currentCards:document.querySelectorAll('.response-card,.error-card,.current-chat-prompt').length,
    activityCards:document.querySelectorAll('.tool-card,.permission-card,.command-approval,.edit-proposal,.stop-button').length,
    historicalControls:document.querySelectorAll('.chat-turn button,.chat-turn input,.chat-turn select').length,
    readOnlyNote:document.querySelector('.chat-context-note')?.textContent}))()`, app.agent);
}

async function selectChat(app, chatId, deadline) {
  await readAgent(app);
  assert.equal(await evaluate(app.client, `(() => {const select=document.querySelector('#little-chat');if(!select||select.disabled||![...select.options].some(option=>option.value===${JSON.stringify(chatId)}))return false;select.value=${JSON.stringify(chatId)};select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`, app.agent), true, 'The actual saved-chat picker must contain the requested isolated chat.');
  await waitFor(async () => { const state=await historyDetails(app);return state?.selected===chatId&&!state.pending&&!state.disabled?state:undefined; }, 'Selected saved native chat', deadline);
}

async function streamDiagnostics(report) {
  // Read only the generated profile's Little Code output channel. Avoid unrelated
  // renderer/extension logs and bound both the number of files and parsed bytes.
  const logs = path.join(profileRoot, 'user-data', 'logs');
  const dates = (await readdir(logs, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{8}T\d{6}$/.test(entry.name)).map(entry => entry.name).sort();
  const latest = dates.at(-1);
  if (!latest) return undefined;
  const exthost = path.join(logs, latest, 'window1', 'exthost');
  const outputs = (await readdir(exthost, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^output_logging_\d{8}T\d{6}$/.test(entry.name)).map(entry => entry.name).sort().slice(-4);
  const files = []; const records = [];
  for (const folder of outputs) {
    const target = path.join(exthost, folder, '1-Little Code.log');
    const stat = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!stat) continue;
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Native diagnostics must come from an ordinary isolated output file.');
    assert.ok(samePath(await realpath(target), target), 'Native diagnostics must not follow a linked output directory.');
    const file = await open(target, 'r');
    try {
      const opened = await file.stat();
      const length = Math.min(opened.size, 65536);
      const buffer = Buffer.alloc(length);
      const read = await file.read(buffer, 0, length, Math.max(0, opened.size - length));
      const text = buffer.subarray(0, read.bytesRead).toString('utf8');
      assert.ok(!/PRIVATE_|failed_generation|<function=read_file>/i.test(text) && !text.includes(fakeKey), 'Native output must omit private provider echoes, failed_generation, and credentials.');
      files.push({ path: path.relative(profileRoot, target).replaceAll('\\', '/'), tailBytes: read.bytesRead });
      const lines = text.split(/\r?\n/);
      if (opened.size > length) lines.shift();
      for (const line of lines.slice(-256)) {
        if (!line.trim() || line.length > 8192) continue;
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value && typeof value === 'object' && value.category === 'agent' && typeof value.code === 'string' && value.diagnostic?.provider === 'groq' && value.diagnostic.phase === 'stream') {
          records.push({ code: value.code, message: value.message, model: value.model, diagnostic: value.diagnostic });
        }
      }
    } finally { await file.close(); }
  }
  const invalidCall = records.find(record => record.code === 'PROVIDER_PROTOCOL_ERROR' && record.diagnostic.category === 'tool_call' && record.message?.includes('invalid or incomplete tool response'));
  const toolError = records.find(record => record.code === 'PROVIDER_PROTOCOL_ERROR' && record.diagnostic.category === 'tool_call' && record.message?.includes('valid tool call'));
  const rateLimit = records.find(record => record.code === 'PROVIDER_RATE_LIMITED' && record.diagnostic.category === 'rate_limit');
  if (!invalidCall || !toolError || !rateLimit) return undefined;
  for (const record of [invalidCall, toolError, rateLimit]) {
    assert.equal(record.model, alternateModel);
    assert.equal(record.diagnostic.requestId, streamErrorRequestId);
    assert.ok(Object.keys(record.diagnostic).every(key => ['provider', 'phase', 'category', 'status', 'requestId'].includes(key)), 'Native diagnostics must contain only the safe classifier metadata.');
  }
  report.streamDiagnostics = { files, errors: [invalidCall, toolError, rateLimit] };
  return report.streamDiagnostics;
}

async function startupDiagnostics(report) {
  if (!report.fixture) return;
  const stages = await readFile(path.join(report.fixture.extensionRoot, 'fixture-stages.json'), 'utf8').catch(() => undefined);
  report.startupDiagnostics = { stages: stages ? JSON.parse(stages) : [] };
  const logs = path.join(profileRoot, 'user-data', 'logs');
  const folders = (await readdir(logs, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name)).map(entry => entry.name).sort();
  const latest = folders.at(-1);
  if (!latest) return;
  for (const [label, relative] of Object.entries({ renderer: 'window1/renderer.log', extensionHost: 'window1/exthost/exthost.log' })) {
    const source = await readFile(path.join(logs, latest, relative), 'utf8').catch(() => '');
    report.startupDiagnostics[label] = source.split(/\r?\n/)
      .filter(line => /little-code-local-tests|Extension host|extension host|unresponsive|responsive|RemoteAgentHostProtocol|No default agent|CodeExpectedError/.test(line))
      .slice(-40).map(line => line.slice(0, 600));
  }
}

async function main() {
  assert.ok(process.argv.slice(2).every(argument => ['--help', '--dry-run'].includes(argument)), 'Unknown native Groq smoke argument.');
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/smoke-groq.mjs [--dry-run]\nTests byte-identical packaged Groq UI/runtime through an owned loopback API fixture and fake native-entered key in an isolated development-extension namespace. No live provider key or account is accessed.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ executable: packagedExecutable, profileRoot, reportPath, deadlineMs, launchesProcesses: false }, null, 2)); return; }
  assert.equal(process.platform, 'win32'); await access(packagedExecutable);
  const expected = await realpath(packagedExecutable);
  assert.ok(samePath(expected, path.join(await realpath(packagedRoot), 'Little Code.exe')));
  const startedAt = Date.now(); const deadline = startedAt + deadlineMs;
  const report = { success: false, startedAt: new Date(startedAt).toISOString(), executable: expected, assertions: {}, launches: [], screenshots: [],
    productionArtifacts: {}, transport: { modelRequests: 0, completions: [] }, limitations: ['Provider responses and key are local fixtures; this proves native integration, not live Groq account quota or model quality.', 'Only the generated feature-project is inspected.', 'Native Groq function calls and SSE errors are exercised with deterministic local responses; real model tool selection quality is not measured.'] };
  let app; let fixture;
  await mkdir(path.dirname(reportPath), { recursive: true }); await mkdir(evidenceRoot, { recursive: true });
  try {
    fixture = await transport(report); const extension = await fixtureFiles(fixture.endpoint, report);
    app = await startApp(expected, deadline, report, [`--extensionDevelopmentPath=${extension}`, '--disable-extension=priyanshu-chaurasia.little-code']);
    const activation = JSON.parse(await readFile(path.join(extension, 'fixture-activation.json'), 'utf8'));
    assert.equal(activation.activated, true); assert.equal(activation.extensionId, report.fixture.extensionId);
    report.assertions.productionBundleActivatedInIsolatedNamespace = true;
    await openSettings(app, deadline); await click(app, '.project-settings button', 'Connect Groq'); await passwordInput(app, deadline);
    await waitFor(async () => {
      const state = await readAgent(app);
      const details = await uiDetails(app);
      report.modelDiscoveryReadiness = { requests: report.transport.modelRequests, models: state?.models.filter(Boolean),
        selected: state?.model, modelDisabled: details?.modelDisabled, promptEnabled: state?.promptEnabled, discovery: details?.discovery };
      // A saved unavailable model also appears in the selector before key storage/discovery.
      // Require the actual provider catalog and ready native UI rather than that placeholder.
      if (details?.error?.includes('PROVIDER_UNAVAILABLE') || state?.error) {
        throw new Error(`Initial native Groq discovery failed: ${details?.discovery ?? state.error}`);
      }
      return report.transport.modelRequests > 0 && state?.models.includes(primaryModel) && state.models.includes(alternateModel) &&
        state.models.includes('future-chat-model') && state.model === primaryModel && state.promptEnabled && details?.modelDisabled === false &&
        details.discovery?.includes('3 compatible') ? state : undefined;
    }, 'Configured native Groq catalog, ready UI, and retained GPT OSS120B selection', deadline, 30000);
    let state = await readAgent(app);
    assert.deepEqual(state.models.filter(Boolean), [alternateModel, primaryModel, 'future-chat-model']);
    report.assertions.nativeEncryptedFakeKeyAndDiscovery = true;
    report.assertions.chatOnlyModelsAnd120BRetained = true;
    report.assertions.toolsUnknownClearlyLabelled = (await uiDetails(app)).text.includes('tools unverified');
    assert.equal(report.assertions.toolsUnknownClearlyLabelled, true);
    await screenshot(app, 'groq-models', report);
    console.log('Native Groq: fake key entered through system storage; chat-only model discovery and saved GPT OSS120B selection verified.');

    fixture.failModels(); await click(app, '.project-settings button', 'Discover models');
    await waitFor(async () => { const details = await uiDetails(app); return details.error?.includes('PROVIDER_UNAVAILABLE') && details.discovery?.includes('server error') && !details.modelDisabled ? details : undefined; }, 'Failed refresh retains cached real models', deadline, 25000);
    assert.deepEqual((await readAgent(app)).models.filter(Boolean), [alternateModel, primaryModel, 'future-chat-model']);
    assert.equal((await readAgent(app)).model, primaryModel);
    report.assertions.failedRefreshPreservesUsableCatalog = true;
    assert.equal(report.transport.modelRequests, 4, 'One successful discovery and three bounded transient refresh attempts are expected.');
    fixture.restoreModels(); await click(app, '.project-settings button', 'Discover models');
    await waitFor(async () => (await uiDetails(app)).discovery?.includes('3 compatible'), 'Refreshed native catalog', deadline);
    console.log('Native Groq: failed refresh retained the usable model catalog; recovery refresh completed.');

    await click(app, 'button[aria-label="Little settings"]');
    await fillComposer(app, prompt, deadline); await click(app, '.send-button');
    await waitFor(async () => { const details = await uiDetails(app); return details?.runState === 'failed' && details.error?.includes('8,000 tokens per minute') ? details : undefined; }, 'Actual native429 quota details', deadline, 30000);
    let details = await uiDetails(app);
    assert.ok(details.error.includes('4,800 requested tokens')); assert.ok(details.error.includes('Retry in 2 minutes')); assert.ok(details.error.includes('PROVIDER_RATE_LIMITED'));
    assert.ok(details.sendDisabled); assert.ok(!details.text.includes('PRIVATE_GROQ_FIXTURE_ORGANIZATION')); assert.ok(!details.text.includes('PRIVATE_PROVIDER_ECHO_NOT_FOR_UI'));
    assert.equal(fixture.requests.length, 1);
    report.assertions.boundedAnalyseCodebaseRequest = fixture.requests[0].estimatedTokens <= 5500 && fixture.requests[0].sourcePaths.length >= 2;
    assert.equal(report.assertions.boundedAnalyseCodebaseRequest, true);
    report.assertions.native429DetailsCooldownAndRedaction = true;
    report.cooldownUi = { model: details.model, runState: details.runState, sendDisabled: details.sendDisabled,
      sendTitle: details.sendTitle, error: details.error };
    await evaluate(app.client, `document.querySelector('.error-card')?.scrollIntoView({block:'start'})`, app.agent);
    await screenshot(app, 'groq-cooldown', report);
    console.log('Native Groq: bounded codebase-analysis request, sanitized TPM/reset details, and model cooldown verified.');
    await click(app, '.error-card button', 'Prepare retry');
    details = await uiDetails(app); assert.equal(details.prompt, prompt); assert.equal(details.sendDisabled, true);
    await delay(800); assert.equal(fixture.requests.length, 1, 'Preparing a retry must not replay generation.');
    report.assertions.prepareRetryDoesNotReplayGeneration = true;

    fixture.allowCompletions(); await selectModel(app, alternateModel, deadline);
    await waitFor(async () => !(await uiDetails(app)).sendDisabled, 'Other discovered model remains usable during120B cooldown', deadline, 5000);
    report.assertions.otherModelUsableDuring120BCooldown = true;
    await click(app, '.send-button');
    await waitFor(async () => { const state = await readAgent(app); const details = await uiDetails(app); return details?.runState === 'completed' && state?.response?.includes(completionText) ? state : undefined; }, 'Native streamed answer after the actual workspace tool result', deadline, 30000);
    details = await uiDetails(app);
    assert.ok(!details.text.includes('PRIVATE_REASONING_FIXTURE_DO_NOT_RENDER')); assert.ok(details.text.includes('2,350') || details.text.includes('2350'));
    assert.ok(details.text.includes('130')); assert.equal(fixture.requests.length, 3); assert.deepEqual(fixture.failures, []);
    report.assertions.nativeWorkspaceAnalysisAndActualUsage = true;
    report.assertions.privateReasoningNeverRendered = true;
    report.analysisUi = { model: details.model, runState: details.runState, usage: details.usage,
      response: (await readAgent(app))?.response };
    await evaluate(app.client, `document.querySelector('.response-card')?.scrollIntoView({block:'start'})`, app.agent);
    await screenshot(app, 'groq-analysis', report);
    console.log('Native Groq: explicit alternate-model run returned native function calls with real workspace observations and reported usage.');
    await selectModel(app, primaryModel, deadline);
    await waitFor(async () => { const state = await uiDetails(app); return state.model === primaryModel && state.sendDisabled && state.sendTitle?.includes('Provider cooldown') ? state : undefined; }, 'Original model preserves its observed cooldown', deadline);
    report.assertions.originalModelCooldownSurvivesModelSwitch = true;

    fixture.failInvalidCall(); await selectModel(app, alternateModel, deadline);
    await fillComposer(app, prompt, deadline); await click(app, '.send-button');
    await waitFor(async () => { const details = await uiDetails(app); return details.runState === 'failed' && details.error?.includes('PROVIDER_PROTOCOL_ERROR') && details.error.includes('invalid or incomplete tool response') ? details : undefined; }, 'Malformed native function arguments have a safe explanation', deadline, 30000);
    details = await uiDetails(app);
    assert.ok(details.error.includes('No tool from this response was executed'));
    assert.ok(details.error.includes('Prepare a retry'));
    assert.ok(!details.text.includes(privateFailedGeneration)); assert.ok(!details.text.includes('failed_generation'));
    assert.ok(!details.text.includes('<function=read_file>'));
    assert.deepEqual(details.toolNames, [], 'Malformed function arguments must not emit a native workspace tool activity card.');
    assert.equal(fixture.requests.length, 4, 'An invalid call must not replay generation or send a workspace observation.');
    assert.equal(fixture.requests[3].phase, 'invalid-call');
    assert.equal(observations(fixture.requests[3].wire.messages).length, 0);
    report.assertions.nativeInvalidFunctionCallIsActionable = true;
    report.assertions.invalidFunctionCallNeverObserved = true;
    report.invalidCallUi = { model: details.model, runState: details.runState, error: details.error, toolNames: details.toolNames };
    await evaluate(app.client, `document.querySelector('.error-card')?.scrollIntoView({block:'start'})`, app.agent);
    await screenshot(app, 'groq-invalid-call', report);
    fixture.allowCompletions(); await click(app, '.error-card button', 'Prepare retry');
    await waitFor(async () => { const details = await uiDetails(app); return details.prompt === prompt && !details.sendDisabled ? details : undefined; }, 'Explicit tool-error retry restores a usable composer', deadline, 5000);
    await delay(800); assert.equal(fixture.requests.length, 4, 'Preparing tool-error recovery must not replay generation.');
    report.assertions.toolErrorPrepareRetryDoesNotReplay = true;
    await click(app, '.send-button');
    await waitFor(async () => { const state = await readAgent(app); const details = await uiDetails(app); return details.runState === 'completed' && state?.response?.includes(completionText) ? state : undefined; }, 'Explicit manual retry recovers after malformed native tool arguments', deadline, 30000);
    details = await uiDetails(app);
    assert.equal(fixture.requests.length, 6); assert.deepEqual(fixture.failures, []);
    assert.equal(fixture.requests[4].phase, 'success'); assert.equal(fixture.requests[5].phase, 'success');
    assert.equal(observations(fixture.requests[4].wire.messages).length, 0, 'The explicit retry must begin a new run without invalid-call observations.');
    assert.equal(observations(fixture.requests[5].wire.messages).length, 1);
    assert.ok(details.toolNames.some(name => name === 'read file'), 'Only the successful manually started retry should execute the native read_file tool.');
    assert.ok(!details.text.includes(privateFailedGeneration)); assert.ok(!details.text.includes('PRIVATE_REASONING_FIXTURE_DO_NOT_RENDER'));
    report.assertions.explicitManualRetryRecoversFromInvalidCall = true;
    report.nativeRecoveryUi = { model: details.model, runState: details.runState, response: (await readAgent(app))?.response, toolNames: details.toolNames };
    console.log('Native Groq: malformed native function arguments remained unexecuted; an explicit manual retry recovered.');

    fixture.failToolCall(); await fillComposer(app, prompt, deadline); await click(app, '.send-button');
    await waitFor(async () => { const details = await uiDetails(app); return details.runState === 'failed' && details.error?.includes('PROVIDER_PROTOCOL_ERROR') && details.error.includes('valid tool call') ? details : undefined; }, 'Native HTTP200 SSE tool_use_failed classification', deadline, 30000);
    details = await uiDetails(app);
    assert.ok(details.error.includes('No tool from this response was executed'));
    assert.ok(details.error.includes('Prepare a retry or choose another coding model'));
    assert.ok(!details.text.includes(privateFailedGeneration)); assert.ok(!details.text.includes('failed_generation'));
    assert.ok(!details.text.includes('<function=read_file>'));
    assert.deepEqual(details.toolNames, []); assert.equal(fixture.requests.length, 7); assert.equal(fixture.requests[6].phase, 'tool-error');
    assert.equal(observations(fixture.requests[6].wire.messages).length, 0);
    report.assertions.nativeStreamToolErrorIsActionable = true;
    report.assertions.failedGenerationNeverRendered = true;
    report.assertions.topLevelStreamErrorNeverExecutesTools = true;
    report.streamToolErrorUi = { model: details.model, runState: details.runState, error: details.error, toolNames: details.toolNames };
    await evaluate(app.client, `document.querySelector('.error-card')?.scrollIntoView({block:'start'})`, app.agent);
    await screenshot(app, 'groq-stream-tool-error', report);
    await click(app, '.error-card button', 'Prepare retry');
    await waitFor(async () => { const details = await uiDetails(app); return details.prompt === prompt && !details.sendDisabled ? details : undefined; }, 'Streamed provider error permits an explicit new request', deadline, 5000);
    await delay(800); assert.equal(fixture.requests.length, 7, 'Preparing a retry after a streamed error must not replay generation.');

    fixture.limitStreamResponse(); await click(app, '.send-button');
    await waitFor(async () => { const details = await uiDetails(app); return details.runState === 'failed' && details.error?.includes('PROVIDER_RATE_LIMITED') && details.error.includes('8,000 tokens per minute') ? details : undefined; }, 'Native HTTP200 streamed rate-limit classification and numeric TPM details', deadline, 30000);
    details = await uiDetails(app);
    assert.ok(details.error.includes('4,800 requested tokens')); assert.ok(details.error.includes('Retry in 2 minutes'));
    assert.ok(details.sendDisabled); assert.ok(details.sendTitle?.includes('Provider cooldown'));
    assert.ok(!details.text.includes(privateStreamOrganization)); assert.ok(!details.text.includes(privateStreamEcho));
    assert.deepEqual(details.toolNames, []); assert.equal(fixture.requests.length, 8); assert.equal(fixture.requests[7].phase, 'stream-limited');
    report.assertions.nativeStreamRateLimitDetailsAndRedaction = true;
    report.streamCooldownUi = { model: details.model, runState: details.runState, sendDisabled: details.sendDisabled, sendTitle: details.sendTitle, error: details.error };
    await evaluate(app.client, `document.querySelector('.error-card')?.scrollIntoView({block:'start'})`, app.agent);
    await screenshot(app, 'groq-stream-cooldown', report);
    await click(app, '.error-card button', 'Prepare retry');
    details = await uiDetails(app); assert.equal(details.prompt, prompt); assert.equal(details.sendDisabled, true);
    await delay(800); assert.equal(fixture.requests.length, 8, 'A streamed rate-limit retry must stay disabled and never automatically replay generation.');
    report.assertions.nativeStreamRateLimitCooldownNoReplay = true;
    report.assertions.noAutomaticGenerationReplay = fixture.requests.length === 8;
    report.transport.generationRequests = fixture.requests.length;
    report.transport.explicitUserRuns = 6;
    report.transport.phaseCounts = Object.fromEntries(['limited', 'success', 'invalid-call', 'tool-error', 'stream-limited'].map(phase => [phase, fixture.requests.filter(request => request.phase === phase).length]));
    assert.deepEqual(report.transport.phaseCounts, { limited: 1, success: 4, 'invalid-call': 1, 'tool-error': 1, 'stream-limited': 1 });
    report.assertions.gptOssRequestsUseNativeFunctions = fixture.requests.every(request => request.actionTransport === 'native-functions' && request.parallelToolCalls === false && request.responseSchemaAbsent && request.wire.stream === true && request.wire.response_format === undefined && request.wire.tool_choice === 'auto' && request.wire.parallel_tool_calls === false && request.wire.stream_options?.include_usage === true && request.wire.tools.every(tool => tool.type === 'function')) &&
      fixture.requests.some(request => request.model === primaryModel) && fixture.requests.some(request => request.model === alternateModel);
    assert.equal(report.assertions.gptOssRequestsUseNativeFunctions, true);
    assert.deepEqual(fixture.failures, []);
    await waitFor(() => streamDiagnostics(report), 'Native Little Code output contains safe SSE/tool-call classifier diagnostics', deadline, 10000);
    report.assertions.nativeStreamDiagnosticsAreSafe = true;
    console.log('Native Groq: streamed error classification established a real model cooldown; eight total requests came from six explicit runs and two tool follow-ups.');

    // Restart only after every observed cooldown assertion has finished. Cooldown
    // persistence is separate from read-only saved conversation restoration.
    const beforeRestart = await waitFor(async () => {
      const history = await historyDetails(app);
      return history?.selected && !history.pending && !history.disabled &&
        history.currentPrompt === prompt && history.turns.length === 5 &&
        history.saveStatus?.includes('Chats are saved locally') ? history : undefined;
    }, 'Six explicit native runs have finished saving to the selected isolated chat', deadline, 10000);
    const savedChatId = beforeRestart.selected;
    assert.equal(beforeRestart.turns.filter(turn => turn.status === 'Complete').length, 2);
    assert.equal(beforeRestart.turns.filter(turn => turn.status === 'Failed').length, 3);
    assert.ok(beforeRestart.turns.every(turn => turn.prompt === prompt));
    const generationRequestsBeforeRestart = fixture.requests.length;
    await stopApp(app, report); app = undefined;
    app = await startApp(expected, deadline, report, [`--extensionDevelopmentPath=${extension}`, '--disable-extension=priyanshu-chaurasia.little-code']);
    const restored = await waitFor(async () => {
      const history = await historyDetails(app);
      return history?.selected === savedChatId && !history.pending && !history.disabled &&
        history.turns.length === 6 ? history : undefined;
    }, 'Selected saved chat and six terminal turns restore after an owned app restart', deadline, 30000);
    assert.deepEqual(restored.turns.slice(0, 5), beforeRestart.turns);
    assert.equal(restored.turns.filter(turn => turn.status === 'Complete').length, 2);
    assert.equal(restored.turns.filter(turn => turn.status === 'Failed').length, 4);
    assert.ok(restored.turns.every(turn => turn.prompt === prompt));
    assert.ok(restored.turns.filter(turn => turn.status === 'Complete').every(turn => turn.answer === completionText));
    assert.ok(restored.turns.filter(turn => turn.status === 'Failed').every(turn => turn.answer === ''));
    report.assertions.savedChatSelectionAndTerminalHistorySurviveRestart = true;
    assert.equal(restored.currentCards, 0);
    assert.equal(restored.activityCards, 0);
    assert.equal(restored.historicalControls, 0);
    assert.match(restored.readOnlyNote ?? '', /Saved cards cannot execute actions/);
    report.assertions.restoredHistoryHasNoExecutableActivity = true;
    await delay(800);
    assert.equal(fixture.requests.length, generationRequestsBeforeRestart, 'Restarting the selected saved chat must not replay provider generation.');
    await screenshot(app, 'groq-history-restored', report);

    await click(app, '.new-chat-button', 'New chat');
    const newChat = await waitFor(async () => {
      const history = await historyDetails(app);
      return history?.selected && history.selected !== savedChatId && !history.pending && !history.disabled &&
        history.turns.length === 0 && history.currentCards === 0 && history.composer === '' ? history : undefined;
    }, 'New chat clears the displayed conversation and composer', deadline, 10000);
    assert.equal(newChat.activityCards, 0);
    assert.equal(newChat.historicalControls, 0);
    assert.ok(newChat.options.some(option => option.value === savedChatId));
    report.assertions.newChatClearsDisplayedHistory = true;

    await selectChat(app, savedChatId, deadline);
    const selectedAgain = await waitFor(async () => {
      const history = await historyDetails(app);
      return history?.selected === savedChatId && !history.pending && history.turns.length === 6 ? history : undefined;
    }, 'Selecting the old saved chat restores its read-only conversation cards', deadline, 10000);
    assert.deepEqual(selectedAgain.turns, restored.turns);
    assert.equal(selectedAgain.currentCards, 0);
    assert.equal(selectedAgain.activityCards, 0);
    assert.equal(selectedAgain.historicalControls, 0);
    assert.equal(selectedAgain.composer, '');
    report.assertions.reselectingSavedChatRestoresReadOnlyTurns = true;
    await delay(800);
    assert.equal(fixture.requests.length, generationRequestsBeforeRestart, 'History navigation must never recreate provider requests or tool observations.');
    assert.deepEqual(fixture.failures, []);
    report.assertions.historyNavigationNeverReplaysProviderRequests = true;
    report.historyUi = { savedChatId, newChatId: newChat.selected,
      turns: restored.turns.map(turn => ({ id: turn.id, status: turn.status, promptSaved: turn.prompt === prompt, answerSaved: turn.answer === completionText })),
      generationRequestsBeforeRestart, generationRequestsAfterNavigation: fixture.requests.length,
      currentCards: selectedAgain.currentCards, activityCards: selectedAgain.activityCards, historicalControls: selectedAgain.historicalControls };
    console.log('Native Groq: the selected saved chat survived an owned restart; completed and failed turns restored read-only, New chat cleared the display, and history navigation sent no generation requests.');
    assert.equal(Object.keys(report.assertions).length, expectedAssertionCount);
    assert.ok(Object.values(report.assertions).every(Boolean)); report.success = true;
  } catch (error) {
    process.exitCode = 1; report.error = error.message;
    if (!app && error.smokeApp) app = error.smokeApp;
    if (app?.client?.socket.readyState === WebSocket.OPEN) {
      try { report.lastAgent = await readAgent(app); report.lastUi = await uiDetails(app); await screenshot(app, 'groq-failure', report); } catch (capture) { report.captureError = capture.message; }
    } else if (app) { report.launchFailure = { stdout: app.output, stderr: app.stderr }; }
  } finally {
    try { if (!report.launches.find(launch => launch.pid === app?.child.pid)?.cleanupConfirmed) await stopApp(app, report); }
    catch (cleanup) { report.success = false; report.cleanupError = cleanup.message; process.exitCode = 1; }
    await startupDiagnostics(report).catch(error => { report.diagnosticsError = error.message; });
    if (fixture?.failures.length) report.transport.fixtureFailures = fixture.failures.map(message => message.slice(0, 1024));
    await fixture?.close(); report.assertionsPassed = Object.values(report.assertions).every(Boolean) && Object.keys(report.assertions).length === expectedAssertionCount;
    report.cleanupConfirmed = report.launches.length > 0 && report.launches.every(launch => launch.cleanupConfirmed);
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native Groq smoke evidence: ${reportPath}`);
    console.log(JSON.stringify({ success: report.success, assertionsPassed: report.assertionsPassed, cleanupConfirmed: report.cleanupConfirmed, error: report.error }, null, 2));
  }
}

main().catch(error => { console.error(`Native Groq smoke could not start: ${error.message}`); process.exitCode = 1; });
