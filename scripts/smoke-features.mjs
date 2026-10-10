import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';

const runFile = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const profileRoot = path.join(projectRoot, 'desktop', 'profile', `features-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`);
const fixtureRoot = path.join(profileRoot, 'feature-project');
const evidenceRoot = path.join(projectRoot, 'desktop', 'screenshots');
const reportPath = path.join(evidenceRoot, 'features.json');
const model = 'little-feature-smoke:latest';
const memoryTitle = 'Feature smoke convention';
const memoryContent = 'Feature smoke convention: keep deterministic loopback tests local.';
const serverName = 'Feature smoke MCP';
const answer = 'LITTLE_FEATURE_SMOKE_OK — the local provider received the saved project convention.';
const gitExecutable = 'C:\\Program Files\\Git\\cmd\\git.exe';
const gitChange = 'export const reviewSmoke = "LITTLE_GIT_REVIEW_CHANGED";';
const reviewTexts = { architecture: 'LITTLE_ARCHITECTURE_REVIEW_OK — app.ts exposes one small source module. Review the added constant before changing dependencies.', verification: 'LITTLE_VERIFICATION_REVIEW_OK — inspect the added source constant and consider a focused assertion. These are suggested checks, not executed results.' };
const deadlineMs = 600000;
const includeBrowser = process.argv.includes('--browser');
let cancelled = false;

function samePath(first, second) { return path.resolve(first).replaceAll('\\', '/').toLowerCase() === path.resolve(second).replaceAll('\\', '/').toLowerCase(); }
function literal(value) { return `'${value.replaceAll("'", "''")}'`; }

/** Only the packaged app is inspected. The HTTP fixtures exercise its real provider and integration paths. */
class DevToolsClient {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Set(); this.deadline = Infinity;
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`)); else pending.resolve(message.result ?? {});
      } else if (message.method) for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned feature DevTools closed.')); } this.pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Owned feature DevTools timed out.')); }, 4000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Owned feature DevTools failed.')); }, { once: true });
    });
    return new DevToolsClient(socket);
  }
  send(method, params = {}, sessionId, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('Owned feature DevTools is closed.')); return; }
      const remaining = Math.min(timeoutMs, this.deadline - Date.now());
      if (remaining <= 0) { reject(new Error('Feature smoke deadline reached.')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, remaining);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function unusedPort() { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function ownedProcess(pid, expected, allowAbsent = false) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$featureSmokeProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $featureSmokeProcess) { Write-Output 'null'; exit 0 }; @{ path=$featureSmokeProcess.ExecutablePath; commandLine=$featureSmokeProcess.CommandLine } | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15000, maxBuffer: 16000 });
  const observed = JSON.parse(stdout.trim());
  if (!observed) { if (allowAbsent) return undefined; throw new Error('Owned feature process exited.'); }
  assert.ok(samePath(observed.path, expected), 'Feature smoke executable ownership changed.');
  assert.ok(observed.commandLine.includes(profileRoot), 'Feature smoke profile ownership changed.');
  return observed.path;
}
async function evaluate(client, expression, surface) {
  let response;
  client.lastReadFailure = undefined;
  try { response = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true,
    ...(surface?.contextId === undefined ? {} : { contextId: surface.contextId }) }, surface?.sessionId); }
  catch (error) {
    client.lastReadFailure = { sessionId: surface?.sessionId, contextId: surface?.contextId, message: error.message };
    if (/Session with given id not found/.test(error.message)) {
      client.invalidSessions ??= new Set();
      if (surface?.sessionId) client.invalidSessions.add(surface.sessionId);
      return undefined;
    }
    if (/Cannot find context|No session|Target closed/.test(error.message)) return undefined;
    throw error;
  }
  if (response.exceptionDetails) { client.lastReadFailure = { sessionId: surface?.sessionId, contextId: surface?.contextId, message: response.exceptionDetails.text ?? 'Runtime evaluation exception' }; return undefined; }
  return response.result?.value;
}
async function waitFor(read, description, deadline, timeout = 12000) {
  const until = Math.min(deadline, Date.now() + timeout); let last;
  while (Date.now() < until) { if (cancelled) throw new Error('Feature smoke cancelled.'); last = await read(); if (last) return last; await delay(150); }
  throw new Error(`${description} did not settle before its deadline${last === undefined ? '' : `: ${JSON.stringify(last)}`}.`);
}

const surfaceExpression = `(() => {
  if (!document.querySelector('main.agent-shell')) return null;
  return {
    workspace: document.querySelector('.workspace-chip')?.textContent?.trim(),
    settings: !!document.querySelector('.project-settings'),
    provider: document.querySelector('.provider-choice [aria-pressed="true"]')?.textContent?.trim(),
    endpoint: document.querySelector('.project-settings > .settings-endpoint')?.textContent,
    model: document.querySelector('#little-model')?.value,
    models: [...document.querySelectorAll('#little-model option')].map(option => option.value),
    promptEnabled: document.querySelector('#little-prompt')?.disabled === false,
    status: document.querySelector('.agent-status')?.textContent?.trim(),
    response: document.querySelector('.response-text')?.textContent,
    context: document.querySelector('.context-section')?.textContent,
    memory: [...document.querySelectorAll('.memory-note')].map(note => ({title: note.querySelector('strong')?.textContent, content: note.querySelector('p')?.textContent})),
    mcp: [...document.querySelectorAll('.mcp-server')].map(server => ({name: server.querySelector('strong')?.textContent, state: server.querySelector('.badge')?.textContent, tools: server.querySelector('small')?.textContent, url: server.querySelector('code')?.textContent})),
    reviews: [...document.querySelectorAll('.review-team article')].map(review => ({role: review.querySelector('strong')?.textContent, state: review.querySelector('.badge')?.textContent, text: review.querySelector('p')?.textContent})),
    error: document.querySelector('.error-card')?.textContent,
  };
})()`;

async function attachSurfaces(app, deadline) {
  const sessions = new Map(); const contexts = new Map();
  const forget = (targetId, surface) => {
    sessions.delete(targetId); contexts.delete(surface.sessionId);
    app.client.invalidSessions?.delete(surface.sessionId);
    if (app.renderer?.sessionId === surface.sessionId) app.renderer = undefined;
    if (app.agent?.sessionId === surface.sessionId) app.agent = undefined;
  };
  app.client.listeners.add(message => {
    if (message.method === 'Runtime.executionContextCreated' && message.sessionId) {
      const map = contexts.get(message.sessionId) ?? new Map(); map.set(message.params.context.id, message.params.context); contexts.set(message.sessionId, map);
    } else if (message.method === 'Runtime.executionContextDestroyed') contexts.get(message.sessionId)?.delete(message.params.executionContextId);
    else if (message.method === 'Runtime.executionContextsCleared') contexts.delete(message.sessionId);
    else if (message.method === 'Target.detachedFromTarget') {
      for (const [targetId, surface] of sessions) if (surface.sessionId === message.params.sessionId) forget(targetId, surface);
    } else if (message.method === 'Target.targetDestroyed') {
      const surface = sessions.get(message.params.targetId); if (surface) forget(message.params.targetId, surface);
    }
  });
  app.findAgent = async () => {
    let targetInfos;
    try { ({ targetInfos } = await app.client.send('Target.getTargets', {}, undefined, 15000)); }
    catch (error) {
      if (error.message === 'Target.getTargets timed out.') return undefined;
      throw error;
    }
    const activeTargets = new Set(targetInfos.filter(target => ['page', 'iframe'].includes(target.type)).map(target => target.targetId));
    for (const [targetId, surface] of sessions) if (!activeTargets.has(targetId) || app.client.invalidSessions?.has(surface.sessionId)) forget(targetId, surface);
    for (const target of targetInfos.filter(target => ['page', 'iframe'].includes(target.type))) {
      if (sessions.has(target.targetId)) continue;
      try {
        const { sessionId } = await app.client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined, 15000);
        sessions.set(target.targetId, { sessionId });
        await app.client.send('Runtime.enable', {}, sessionId);
        if (/\/vs\/code\/electron-browser\/workbench\/workbench\.html/.test(target.url)) { app.renderer = { sessionId }; await app.client.send('Page.enable', {}, sessionId); }
      } catch { /* Genuine webview targets can navigate during mount. */ }
    }
    if (!app.renderer) return undefined;
    for (const surface of sessions.values()) {
      const ids = contexts.get(surface.sessionId)?.size ? [...contexts.get(surface.sessionId).keys()] : [undefined];
      for (const contextId of ids) {
        const candidate = { ...surface, contextId };
        let reading;
        try { reading = await evaluate(app.client, surfaceExpression, candidate); }
        catch (error) {
          // A cold renderer can miss a read-only probe's timeout while mounting.
          // Keep readiness polling bounded; action timeouts remain fatal.
          if (error.message === 'Runtime.evaluate timed out.') continue;
          throw error;
        }
        if (reading?.workspace === 'feature-project') { app.agent = candidate; return reading; }
      }
    }
    return undefined;
  };
  return waitFor(app.findAgent, 'Real Little Agent project view', deadline, 120000);
}

async function readAgent(app) { return await app.findAgent(); }

async function click(app, selector, text, surface = app.agent) {
  const agentSurface = surface === app.agent, rendererSurface = surface === app.renderer;
  await ownedProcess(app.child.pid, app.expected);
  if (agentSurface || rendererSurface) { await waitFor(app.findAgent, 'Current native UI action surface', app.client.deadline, 15000); surface = agentSurface ? app.agent : app.renderer; }
  const expression = `(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(button => !button.disabled && ${text === undefined ? 'true' : `button.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)}`});
    if (buttons.length !== 1) return false;
    buttons[0].scrollIntoView({block: 'center'}); buttons[0].click(); return true;
  })()`;
  let result = await evaluate(app.client, expression, surface);
  const failure = app.client.lastReadFailure;
  // A rejected, missing CDP session never executed this action. Reattach once;
  // timeouts and other action failures must still stop the smoke.
  if (result === undefined && (agentSurface || rendererSurface) && failure?.sessionId === surface?.sessionId && failure.message.includes('Session with given id not found')) {
    await waitFor(app.findAgent, 'Reattached native UI action surface', app.client.deadline, 15000);
    surface = agentSurface ? app.agent : app.renderer;
    result = await evaluate(app.client, expression, surface);
  }
  assert.equal(result, true, `Actual UI control was unavailable or ambiguous: ${text ?? selector}${result === undefined && app.client.lastReadFailure ? ` (${app.client.lastReadFailure.message})` : ''}`);
}
async function key(app, keyName, code, keyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await app.client.send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }, app.renderer.sessionId);
}
async function fillFocused(app, text) {
  await key(app, 'a', 'KeyA', 65, 2);
  if (text) await app.client.send('Input.insertText', { text }, app.renderer.sessionId);
  else await key(app, 'Backspace', 'Backspace', 8);
}

async function fillComposer(app, text, deadline) {
  await app.findAgent();
  // Fill the visible browser textarea through its native DOM setter and normal input event.
  // React's actual onChange and submit handlers still control the provider request.
  const accepted = await evaluate(app.client, `(() => { const input=document.querySelector('#little-prompt'); if(!input||input.disabled)return false; input.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)}); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}})); return input.value===${JSON.stringify(text)}; })()`, app.agent);
  assert.equal(accepted, true, 'The visible composer did not accept its input.');
  await waitFor(() => evaluate(app.client, `document.querySelector('#little-prompt')?.value===${JSON.stringify(text)} && !!document.querySelector('.send-button:not(:disabled)')`, app.agent), 'Ready composer Send button', deadline, 5000);
}

async function nativeInput(app, title, value, deadline) {
  const expression = `(() => {
    const widget = document.querySelector('.quick-input-widget');
    if (!widget || widget.getBoundingClientRect().height === 0 || !widget.textContent.includes(${JSON.stringify(title)})) return false;
    const inputs = [...widget.querySelectorAll('input')].filter(input => input.getBoundingClientRect().height > 0 && input.type !== 'password');
    if (inputs.length !== 1) return false; inputs[0].focus(); return true;
  })()`;
  await waitFor(() => evaluate(app.client, expression, app.renderer), `Native ${title} input`, deadline);
  await fillFocused(app, value); await key(app, 'Enter', 'Enter', 13);
}
async function modal(app, title, buttonText, deadline, beforeClick) {
  const expression = `(() => {
    const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(dialog => dialog.getBoundingClientRect().height > 0 && dialog.textContent.includes(${JSON.stringify(title)}));
    if (dialogs.length !== 1) return false;
    return [...dialogs[0].querySelectorAll('button,[role="button"]')].filter(button => button.getBoundingClientRect().height > 0 && button.textContent.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(buttonText)}).length === 1;
  })()`;
  await waitFor(() => evaluate(app.client, expression, app.renderer), `Native ${title} approval`, deadline);
  if (beforeClick) await beforeClick();
  await click(app, '.monaco-dialog-box button,.monaco-dialog-box [role="button"]', buttonText, app.renderer);
}
async function screenshot(app, name, report) {
  const image = await app.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, app.renderer.sessionId, 8000);
  const file = path.join(evidenceRoot, `features.${name}.png`); await writeFile(file, Buffer.from(image.data, 'base64'));
  report.screenshots.push(file);
}
async function openSettings(app, deadline) {
  if (!(await readAgent(app))?.settings) await click(app, 'button[aria-label="Little settings"]');
  return waitFor(async () => { const state = await readAgent(app); return state?.settings ? state : undefined; }, 'Little settings', deadline);
}

async function startApp(expected, deadline, report, extraArgs = [], options = {}) {
  const port = await unusedPort();
  const environment = { ...process.env, NODE_ENV: 'production' };
  for (const keyName of Object.keys(environment)) if (/^(?:ELECTRON_RUN_AS_NODE|VSCODE_DEV|NODE_OPTIONS|NODE_PATH)$/i.test(keyName) || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(keyName)) delete environment[keyName];
  const args = ['--new-window', `--user-data-dir=${path.join(profileRoot, 'user-data')}`, `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--skip-release-notes',
    ...(options.enableWorkspaceTrust ? [] : ['--disable-workspace-trust']),
    ...(options.enableGit ? [] : ['--disable-extension=vscode.git']), ...extraArgs, fixtureRoot];
  const child = spawn(packagedExecutable, args, { cwd: packagedRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { child, expected, port, output: '', stderr: '', exited: false };
  child.once('error', error => { app.error = error; }); child.once('exit', () => { app.exited = true; });
  child.stdout.on('data', chunk => { app.output = (app.output + chunk.toString()).slice(-16000); });
  child.stderr.on('data', chunk => { app.stderr = (app.stderr + chunk.toString()).slice(-32000); });
  report.launches.push({ pid: child.pid, port, profileRoot });
  try {
    assert.ok(child.pid, 'Packaged app did not produce a process ID.');
    await ownedProcess(child.pid, expected);
    const endpoint = await waitFor(async () => {
      if (app.error) throw app.error; if (app.exited) throw new Error('Owned app exited before its debugger became ready.');
      const published = app.stderr.match(new RegExp(`DevTools listening on (ws://127\\.0\\.0\\.1:${port}/devtools/browser/[a-f0-9-]+)`))?.[1];
      if (!published) return undefined;
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      if (!response?.ok) return undefined;
      const version = await response.json(); assert.equal(version.webSocketDebuggerUrl, published, 'Debugger does not belong to our owned child.'); return published;
    }, 'Owned packaged app debugger', deadline, 30000);
    await ownedProcess(child.pid, expected);
    app.client = await DevToolsClient.connect(endpoint); app.client.deadline = deadline;
    report.launches.at(-1).verifiedEndpoint = endpoint;
    await attachSurfaces(app, deadline);
    return app;
  } catch (error) {
    error.smokeApp = app;
    try { await stopApp(app, report); } catch (cleanup) { error.message += ` Cleanup needs attention: ${cleanup.message}`; }
    throw error;
  }
}
async function stopApp(app, report) {
  if (!app) return;
  if (!app.child.pid) { app.client?.close(); return; }
  if (app.client && !app.exited) {
    app.client.deadline = Date.now() + 2500;
    try { await ownedProcess(app.child.pid, app.expected); await app.client.send('Browser.close', {}, undefined, 2000); } catch { /* Scoped child cleanup remains available. */ }
  }
  app.client?.close();
  for (let attempt = 0; !app.exited && attempt < 8; attempt++) await delay(150);
  if (!app.exited && app.child.pid) {
    if (await ownedProcess(app.child.pid, app.expected, true)) await runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(app.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => undefined);
  }
  const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$featureSmokeRemaining = Get-CimInstance Win32_Process -Filter 'ProcessId = ${app.child.pid}'; if ($featureSmokeRemaining) { if ($featureSmokeRemaining.ExecutablePath -ine ${literal(app.expected)} -or -not $featureSmokeRemaining.CommandLine.Contains(${literal(profileRoot)})) { throw 'Feature PID ownership changed.' }; Stop-Process -Id ${app.child.pid} -Force -ErrorAction Stop; try { Wait-Process -Id ${app.child.pid} -Timeout 2 -ErrorAction Stop } catch {} }; for ($featureSmokeAttempt = 0; $featureSmokeAttempt -lt 24; $featureSmokeAttempt++) { $featureSmokeRemaining = Get-CimInstance Win32_Process -Filter 'ProcessId = ${app.child.pid}'; if ($null -eq $featureSmokeRemaining) { break }; Start-Sleep -Milliseconds 150 }; Write-Output ($null -eq $featureSmokeRemaining)`],
  { windowsHide: true, timeout: 15000 });
  assert.equal(stdout.trim(), 'True', 'The owned feature test process did not exit.');
  const launch = report.launches.find(item => item.pid === app.child.pid); launch.cleanupConfirmed = true; launch.stdout = app.output; launch.stderr = app.stderr;
}

async function httpFixture(handler) {
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''; for await (const chunk of request) { body += String(chunk); if (body.length > 512000) throw new Error('Fixture input exceeded its bound.'); }
      assert.equal(request.headers.authorization, undefined, 'Credentials reached a local fixture.');
      await handler(request, response, body);
    })().catch(error => { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

async function fixtureGit(args) {
  const environment = { PATH: path.dirname(gitExecutable), LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_GLOBAL: 'NUL',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
  const config = ['core.hooksPath=NUL', 'core.fsmonitor=false', 'core.preloadIndex=false', 'core.untrackedCache=false', 'core.autocrlf=false', 'core.attributesFile=NUL',
    'commit.gpgsign=false', 'core.pager=', 'diff.external=', 'user.name=Little Code Feature Smoke', 'user.email=smoke@localhost.invalid'];
  const result = await runFile(gitExecutable, ['--no-pager', '--no-optional-locks', '--literal-pathspecs', ...config.flatMap(value => ['-c', value]), '-C', fixtureRoot, ...args],
    { env: environment, windowsHide: true, timeout: 12000, maxBuffer: 64000 });
  return result.stdout;
}
async function gitEvidence() {
  return { status: await fixtureGit(['status', '--porcelain=v1', '-z']), index: await fixtureGit(['ls-files', '--stage', '-z']), head: (await fixtureGit(['rev-parse', 'HEAD'])).trim(),
    indexHash: createHash('sha256').update(await readFile(path.join(fixtureRoot, '.git', 'index'))).digest('hex'), source: await readFile(path.join(fixtureRoot, 'app.ts'), 'utf8') };
}
async function verifyGitReview(app, deadline, report) {
  const before = await gitEvidence(); assert.ok(before.status.includes(' M app.ts')); assert.ok(before.source.includes(gitChange));
  await click(app, '.repository-card button', 'Review Git changes');
  await waitFor(() => evaluate(app.client, `(() => {
    const widget = document.querySelector('.quick-input-widget');
    return !!widget && widget.getBoundingClientRect().height > 0 && widget.textContent.includes('Little Git review') && widget.textContent.includes('app.ts') && widget.textContent.includes('Working tree');
  })()`, app.renderer), 'Native Git working-tree choice', deadline);
  await key(app, 'Enter', 'Enter', 13);
  const expression = `(() => {
    const tabs = [...document.querySelectorAll('.tab')].map(tab => ({name: tab.getAttribute('data-resource-name'), label: tab.getAttribute('aria-label'), title: tab.getAttribute('title')}));
    const editors = [...document.querySelectorAll('.monaco-editor')].filter(editor => editor.getBoundingClientRect().height > 0);
    const text = editors.map(editor => editor.querySelector('.view-lines')?.textContent ?? '').join('\\n').replace(/\\u00a0/g, ' ');
    return { tabs, text, readonlyNotice: document.body.textContent.includes('Cannot edit in read-only editor') };
  })()`;
  report.gitReview = await waitFor(async () => { const result = await evaluate(app.client, expression, app.renderer); return result?.text.includes('LITTLE_GIT_REVIEW_CHANGED') && result.tabs.some(tab => [tab.name, tab.label, tab.title].some(value => value?.includes('worktree.diff'))) ? result : undefined; }, 'Native read-only Git patch document', deadline);
  assert.equal(await evaluate(app.client, `(() => {
    const editors = [...document.querySelectorAll('.monaco-editor')].filter(editor => editor.getBoundingClientRect().height > 0 && editor.querySelector('.view-lines')?.textContent.includes('LITTLE_GIT_REVIEW_CHANGED'));
    if (editors.length !== 1) return false;
    const input = editors[0].querySelector('textarea.inputarea,.native-edit-context,[role="textbox"]');
    if (!input) return false; input.focus(); return true;
  })()`, app.renderer), true, 'Actual native Git patch editor input was unavailable.');
  await app.client.send('Input.insertText', { text: 'LITTLE_GIT_REVIEW_MUST_STAY_READONLY' }, app.renderer.sessionId);
  const readonly = await waitFor(async () => { const result = await evaluate(app.client, expression, app.renderer); return result?.readonlyNotice ? result : undefined; }, 'Native read-only editor feedback', deadline, 5000);
  assert.equal(readonly.text.includes('LITTLE_GIT_REVIEW_MUST_STAY_READONLY'), false);
  const after = await gitEvidence(); assert.deepEqual(after, before);
  report.git = { status: after.status, head: after.head, indexHash: after.indexHash, nativePatch: report.gitReview.text, readOnlyFeedback: true };
  report.assertions.nativeGitWorkingTreeReviewOpened = true; report.assertions.nativeGitDocumentReadOnly = true; report.assertions.gitReviewPreservedStatusIndexHeadAndSource = true;
  await screenshot(app, 'git', report); console.log('Genuine Git review opened the changed working-tree patch, rejected editing, and preserved status, index, HEAD, and source.');
}

async function startPreviewBrowser(deadline, report) {
  const executable = await realpath('C:/Program Files/Google/Chrome/Application/chrome.exe');
  const dataDirectory = path.join(profileRoot, 'native-browser'); await mkdir(dataDirectory, { recursive: true });
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (/^(?:ELECTRON_|NODE_OPTIONS$|NODE_PATH$|CHROME_CRASHPAD_PIPE_NAME$)/i.test(name)) delete environment[name];
  const child = spawn(executable, ['--headless=new', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${dataDirectory}`, 'about:blank'], { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const browser = { child, expected: executable, exited: false, output: '', stderr: '', client: undefined };
  report.launches.push({ kind: 'browser', pid: child.pid, profileRoot: dataDirectory, cleanupConfirmed: false });
  child.on('exit', () => { browser.exited = true; }); child.stdout.on('data', data => { browser.output = (browser.output + data).slice(-64000); }); child.stderr.on('data', data => { browser.stderr = (browser.stderr + data).slice(-64000); });
  let launchError; child.on('error', error => { launchError = error; });
  try {
    const endpoint = await waitFor(async () => {
      if (launchError) throw launchError; if (browser.exited) throw new Error('Owned Chrome exited before debugging was ready.');
      try { const lines = (await readFile(path.join(dataDirectory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); const port = Number(lines[0]); if (port > 0 && port <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(lines[1])) return { origin: `http://127.0.0.1:${port}`, socket: `ws://127.0.0.1:${port}${lines[1]}` }; } catch { return undefined; }
    }, 'Owned isolated browser debug endpoint', deadline, 20000);
    await ownedProcess(child.pid, executable); browser.client = await DevToolsClient.connect(endpoint.socket); browser.client.deadline = deadline; browser.endpoint = endpoint.origin;
    return browser;
  } catch (error) { error.browserApp = browser; throw error; }
}

async function verifyNativeBrowser(app, browser, deadline, report) {
  const local = await httpFixture(async (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Little Native Browser Preview</title><h1>LITTLE_NATIVE_BROWSER_PREVIEW</h1><p>Approved local page text.</p>'); });
  try {
    await openSettings(app, deadline); await click(app, '.project-settings > details:last-child > summary');
    await click(app, '.project-settings button', 'Configure browser'); await nativeInput(app, 'Local browser preview endpoint', browser.endpoint, deadline);
    await click(app, '.project-settings button', 'Inspect local app'); await nativeInput(app, 'Inspect a local app', `${local.url}/app`, deadline);
    await modal(app, 'Inspect this local app in a temporary browser tab?', 'Inspect app', deadline, () => screenshot(app, 'browser-approval', report));
    const visible = await waitFor(async () => {
      const result = await evaluate(app.client, String.raw`(() => { const text = [...document.querySelectorAll('.monaco-editor .view-lines')].map(node => node.textContent.replace(/\u00a0/g,' ')).join('\n'); const tabs = [...document.querySelectorAll('.tab')].map(tab => tab.getAttribute('data-resource-name') || tab.getAttribute('aria-label') || ''); return { text, tabs }; })()`, app.renderer);
      return result?.text.includes('LITTLE_NATIVE_BROWSER_PREVIEW') && result.tabs.some(name => /local-preview-[a-f0-9]{32}\.png/.test(name)) ? result : undefined;
    }, 'Native browser text and screenshot editors', deadline, 30000);
    assert.match(visible.text, /Approved local page text/);
    const targets = await fetch(`${browser.endpoint}/json/list`).then(response => response.json());
    assert.equal(targets.filter(target => target.type === 'page').length, 1); assert.equal(targets.find(target => target.type === 'page').url, 'about:blank');
    report.browser = { endpoint: browser.endpoint, localApp: local.url, nativeEditors: visible, remainingOwnedBrowserPage: 'about:blank' };
    report.assertions.nativeBrowserEndpointConfigured = true; report.assertions.nativeBrowserApprovalAndText = true; report.assertions.nativeBrowserScreenshotPreview = true; report.assertions.nativeBrowserTemporaryTabClosed = true;
    await screenshot(app, 'browser', report); console.log('Native browser configuration, exact approval, page text and PNG editors, and temporary-tab cleanup verified.');
  } finally { await local.close(); }
}

async function main() {
  assert.ok(process.argv.slice(2).every(argument => ['--help', '--dry-run', '--browser'].includes(argument)), 'Unknown feature smoke argument.');
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/smoke-features.mjs [--dry-run] [--browser]\nRuns the packaged Little Code app twice in one unique owned profile. Genuine UI actions configure local Ollama fixtures, save memory, approve MCP, inspect a Git patch, compare independent reviews, and verify persistence. --browser adds an owned isolated Chrome process and native consent/text/PNG checks. No API key or model download is used.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ executable: packagedExecutable, gitExecutable, profileRoot, reportPath, deadlineMs, launchesProcesses: false }, null, 2)); return; }
  assert.equal(process.platform, 'win32'); assert.equal(typeof WebSocket, 'function');
  await access(packagedExecutable); const expected = await realpath(packagedExecutable);
  assert.ok(samePath(expected, path.join(await realpath(packagedRoot), 'Little Code.exe')), 'Packaged executable resolves outside its expected directory.');
  const startedAt = Date.now(); const deadline = startedAt + deadlineMs;
  const report = { success: false, executable: expected, gitExecutable, builtinGitExtensionDisabledToPreventBackgroundIndexRefresh: true, profileRoot, startedAt: new Date(startedAt).toISOString(), assertions: {}, launches: [], screenshots: [], ollama: { tags: 0, chat: 0 }, mcp: { methods: [] }, reviews: { architecture: 0, verification: 0 } };
  await mkdir(evidenceRoot, { recursive: true }); await mkdir(path.join(profileRoot, 'user-data', 'User'), { recursive: true }); await mkdir(fixtureRoot, { recursive: true });
  await writeFile(path.join(fixtureRoot, 'README.md'), '# Feature smoke project\nDeterministic local UI integration coverage.\n');
  await writeFile(path.join(fixtureRoot, 'app.ts'), 'export const featureSmoke = true;\n');
  await access(gitExecutable); const emptyTemplate = path.join(profileRoot, 'empty-git-template'); await mkdir(emptyTemplate);
  await fixtureGit(['init', '--initial-branch=main', `--template=${emptyTemplate}`]);
  await fixtureGit(['add', '--', 'app.ts', 'README.md']); await fixtureGit(['commit', '--no-verify', '-m', 'Isolated feature smoke baseline']);
  await writeFile(path.join(fixtureRoot, 'app.ts'), `export const featureSmoke = true;\n${gitChange}\n`);
  await writeFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'window.restoreWindows': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
  let app; let ollama; let mcp; let browser;
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    ollama = await httpFixture(async (request, response, body) => {
      if (request.method === 'GET' && request.url === '/api/tags') { report.ollama.tags++; response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models: [{ name: model, model, size: 1024, details: { family: 'smoke' } }] })); return; }
      if (request.method === 'POST' && request.url === '/api/chat') {
        const native = JSON.parse(body); assert.equal(native.model, model); assert.equal(native.stream, true); assert.equal(native.think, false); assert.ok(Array.isArray(native.messages));
        report.ollama.chat++;
        const text = JSON.stringify(native.messages);
        const userContent = native.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
        const childRole = userContent.includes('You are the architecture reviewer in a bounded two-person repository review.') ? 'architecture'
          : userContent.includes('You are the verification reviewer in a bounded two-person repository review.') ? 'verification' : undefined;
        if (childRole) {
          const names = native.tools?.map(tool => tool.function.name) ?? [];
          assert.ok(names.includes('read_file'));
          assert.equal(names.some(name => /^mcp[_:.-]/i.test(name) || ['run_command', 'propose_file_edits', 'delegate_reviews', 'update_plan'].includes(name)), false);
          report.reviews[childRole]++; assert.equal(report.reviews[childRole], 1, 'A child review unexpectedly retried.');
          report.reviews.childToolNames = names;
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(`${JSON.stringify({ model, message: { role: 'assistant', content: reviewTexts[childRole] }, done: true, done_reason: 'stop' })}\n`); return;
        }
        if (userContent.includes('native review team smoke')) {
          const results = native.messages.filter(message => message.role === 'tool');
          if (!results.length) {
            assert.ok(native.tools.some(tool => tool.function.name === 'delegate_reviews'));
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(`${JSON.stringify({ model, done: true, done_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [
              { function: { index: 0, name: 'read_file', arguments: { path: 'app.ts' } } },
              { function: { index: 1, name: 'delegate_reviews', arguments: { prompt: 'native review team smoke: compare architecture and suggested verification for the added app.ts constant. Clearly identify source evidence and unexecuted checks.' } } },
            ] } })}\n`); return;
          }
          assert.ok(results.some(result => result.tool_name === 'read_file' && result.content.includes('LITTLE_GIT_REVIEW_CHANGED')));
          const delegated = results.find(result => result.tool_name === 'delegate_reviews'); assert.ok(delegated);
          const reviews = JSON.parse(delegated.content).reviews; assert.equal(reviews.length, 2);
          for (const role of ['architecture', 'verification']) { const review = reviews.find(item => item.role === role); assert.equal(review?.state, 'completed'); assert.ok(review.text.includes(reviewTexts[role])); }
          assert.ok(reviews.find(item => item.role === 'verification').text.includes('No commands or checks were executed.'));
          report.reviews.parentObservedBothResults = true;
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(`${JSON.stringify({ model, message: { role: 'assistant', content: 'LITTLE_REVIEW_TEAM_OK — both independent read-only perspectives finished; suggested checks were not executed.' }, done: true, done_reason: 'stop' })}\n`); return;
        }
        const integrationRun = text.includes('MCP smoke reject') ? 'reject' : text.includes('MCP smoke allow') ? 'allow' : undefined;
        if (integrationRun) {
          const remote = native.tools?.map(tool => tool.function).filter(tool => tool.name.startsWith('mcp_'));
          assert.equal(remote?.length, 1, 'The connected MCP tool was not uniquely exposed to Agent.');
          const results = native.messages.filter(message => message.role === 'tool');
          if (!results.length) {
            const names = native.tools.map(tool => tool.function.name); assert.ok(names.includes('read_file') && names.includes('update_plan'));
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(`${JSON.stringify({ model, done: true, done_reason: 'tool_calls', message: {
              role: 'assistant', content: '', tool_calls: [
                { function: { index: 0, name: 'read_file', arguments: { path: 'app.ts' } } },
                { function: { index: 1, name: 'update_plan', arguments: { steps: ['Inspect app.ts.', 'Request the local MCP echo with native approval.', 'Report only its observed result.'] } } },
                { function: { index: 2, name: remote[0].name, arguments: { text: `MCP smoke ${integrationRun}` } } },
              ],
            } })}\n`); return;
          }
          assert.ok(results.some(result => result.tool_name === 'read_file' && result.content.includes('featureSmoke')));
          assert.ok(results.some(result => result.tool_name === 'update_plan' && result.content.includes('published')));
          const remoteResult = results.find(result => result.tool_name === remote[0].name); assert.ok(remoteResult);
          if (integrationRun === 'reject') assert.equal(JSON.parse(remoteResult.content).status, 'rejected');
          else assert.ok(remoteResult.content.includes('LITTLE_MCP_TOOL_OK'));
          report.ollama[`mcp_${integrationRun}_observed`] = true;
          response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(`${JSON.stringify({ model, message: { role: 'assistant', content: `LITTLE_MCP_${integrationRun.toUpperCase()}_OK` }, done: true, done_reason: 'stop' })}\n`); return;
        }
        report.ollama.memoryIncluded = text.includes(memoryContent);
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({ model, message: { role: 'assistant', content: answer.slice(0, 29) }, done: false })}\n`);
        await delay(100);
        response.end(`${JSON.stringify({ model, message: { role: 'assistant', content: answer.slice(29) }, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 20 })}\n`); return;
      }
      response.writeHead(404).end();
    });
    mcp = await httpFixture(async (request, response, body) => {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/mcp');
      const message = JSON.parse(body); report.mcp.methods.push(message.method);
      assert.equal(request.headers['mcp-protocol-version'], '2026-07-28'); assert.equal(request.headers['mcp-method'], message.method);
      assert.equal(message.params?._meta?.['io.modelcontextprotocol/protocolVersion'], '2026-07-28'); assert.deepEqual(message.params?._meta?.['io.modelcontextprotocol/clientCapabilities'], {});
      assert.equal(request.headers['mcp-session-id'], undefined);
      const result = message.method === 'server/discover' ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
        : message.method === 'tools/list' ? { resultType: 'complete', tools: [{ name: 'smoke_echo', description: 'A harmless fixture tool still requiring approval.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 120 } }, required: ['text'], additionalProperties: false } }] }
          : message.method === 'tools/call' && message.params.name === 'smoke_echo' && message.params.arguments.text === 'MCP smoke allow' ? { resultType: 'complete', content: [{ type: 'text', text: 'LITTLE_MCP_TOOL_OK' }] }
          : undefined;
      if (message.method === 'tools/call') assert.equal(request.headers['mcp-name'], message.params.name);
      assert.ok(result, 'Unexpected MCP execution reached the fixture.'); response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    report.ollama.endpoint = ollama.url; report.mcp.endpoint = `${mcp.url}/mcp`;
    app = await startApp(expected, deadline, report);
    await verifyGitReview(app, deadline, report);
    await openSettings(app, deadline);
    await click(app, '.provider-choice button', 'Ollama · local');
    await waitFor(async () => (await readAgent(app))?.provider === 'Ollama · local', 'Local provider switch', deadline, 35000);
    await click(app, '.project-settings button', 'Configure Ollama');
    await nativeInput(app, 'Connect Little Code to Ollama', ollama.url, deadline);
    await waitFor(async () => { const state = await readAgent(app); return state?.endpoint === ollama.url && state.models.includes(model) && state.promptEnabled ? state : undefined; }, 'Real Ollama model discovery', deadline);
    assert.equal(await evaluate(app.client, `(() => { const control = document.querySelector('#little-model'); if (!control || control.disabled) return false; control.focus(); return true; })()`, app.agent), true);
    await key(app, 'Home', 'Home', 36); await key(app, 'ArrowDown', 'ArrowDown', 40); await key(app, 'Enter', 'Enter', 13);
    await waitFor(async () => (await readAgent(app))?.model === model, 'Fixture model selection', deadline);
    report.assertions.providerConfiguredByNativeInput = true; report.assertions.installedModelDiscoveredAndSelected = report.ollama.tags > 0;
    console.log('Actual Ollama provider switch, native endpoint dialog, discovery, and model selection verified.');

    await click(app, '.project-settings button', 'Add note');
    await nativeInput(app, 'Add project memory', memoryTitle, deadline); await nativeInput(app, 'Project memory content', memoryContent, deadline);
    await waitFor(() => evaluate(app.client, `(() => { const widget = document.querySelector('.quick-input-widget'); return !!widget && widget.getBoundingClientRect().height > 0 && widget.textContent.includes('Memory evidence type') && widget.textContent.includes('User convention'); })()`, app.renderer), 'Native evidence type choice', deadline);
    await key(app, 'Enter', 'Enter', 13); await nativeInput(app, 'Memory source', '', deadline);
    await modal(app, 'Save this project memory?', 'Save memory', deadline, () => screenshot(app, 'memory', report));
    await waitFor(async () => (await readAgent(app))?.memory.some(note => note.title === memoryTitle && note.content === memoryContent), 'Saved convention visible in settings', deadline);
    report.assertions.nativeMemoryReviewAndSave = true; await delay(200);

    assert.equal(await evaluate(app.client, `(() => { const input = document.querySelector('#little-prompt'); if (!input || input.disabled) return false; input.focus(); return true; })()`, app.agent), true);
    await fillComposer(app, 'Explain the feature smoke convention for this project.', deadline); await click(app, 'button[aria-label="Send question to Little"]');
    await waitFor(async () => { const state = await readAgent(app); return state?.response === answer && /Complete/.test(state.status ?? '') ? state : undefined; }, 'Native Ollama streaming run', deadline, 20000);
    report.assertions.localNativeChatStreamed = report.ollama.chat === 1; report.assertions.savedMemoryJoinedProviderContext = report.ollama.memoryIncluded === true;
    assert.ok(report.assertions.savedMemoryJoinedProviderContext, 'Saved project memory did not join the actual provider request.');
    await screenshot(app, 'provider', report); console.log('Actual local chat streamed and received the saved project memory context.');

    await openSettings(app, deadline); await click(app, '.project-settings button', 'Add MCP server');
    await nativeInput(app, 'Add MCP server', serverName, deadline); await nativeInput(app, 'MCP Streamable HTTP endpoint', `${mcp.url}/mcp`, deadline);
    await waitFor(async () => (await readAgent(app))?.mcp.some(server => server.name === serverName && server.state === 'disconnected'), 'Native MCP configuration', deadline);
    await delay(200); await click(app, '.mcp-server button', 'Connect'); await modal(app, `Connect MCP server “${serverName}”?`, 'Connect server', deadline);
    await waitFor(async () => (await readAgent(app))?.mcp.some(server => server.name === serverName && server.state === 'connected' && server.tools.startsWith('1 discovered tools')), 'Real MCP tool discovery', deadline);
    assert.deepEqual(report.mcp.methods, ['server/discover', 'tools/list']); report.assertions.nativeMcpConsentAndDiscovery = true;
    await screenshot(app, 'mcp', report);
    for (const phase of ['reject', 'allow']) {
      await delay(200); await click(app, '.mode-picker button', 'Agent');
      assert.equal(await evaluate(app.client, `(() => { const input = document.querySelector('#little-prompt'); if (!input || input.disabled) return false; input.focus(); return true; })()`, app.agent), true);
      await fillComposer(app, `MCP smoke ${phase}: inspect app.ts, publish a plan, then request the local MCP echo. Respect native permission.`, deadline);
      await click(app, 'button[aria-label="Start a supervised Agent run"]');
      await modal(app, `Run MCP tool “${serverName} / smoke_echo”?`, phase === 'reject' ? 'Cancel' : 'Allow once', deadline,
        () => screenshot(app, `mcp-${phase}-approval`, report));
      await waitFor(async () => { const state = await readAgent(app); return state?.response?.includes(`LITTLE_MCP_${phase.toUpperCase()}_OK`) && /Complete/.test(state.status ?? '') ? state : undefined; }, `Agent MCP ${phase} outcome`, deadline, 20000);
      const calls = report.mcp.methods.filter(method => method === 'tools/call').length;
      assert.equal(calls, phase === 'reject' ? 0 : 1);
      report.assertions[phase === 'reject' ? 'nativeMcpRejectionPreventedInvocation' : 'nativeMcpAllowOnceInvokedExactlyOneTool'] = report.ollama[`mcp_${phase}_observed`] === true;
    }
    console.log('Agent inspected source, published a visible plan, and used real native MCP rejection and Allow once; only the approved fixture tool was invoked.');
    await delay(200); await click(app, '.mcp-server button', 'Disconnect');
    await waitFor(async () => (await readAgent(app))?.mcp.some(server => server.name === serverName && server.state === 'disconnected'), 'MCP disconnect', deadline);
    report.assertions.nativeMcpDisconnect = true; console.log('Actual native MCP add, consent, current protocol tool discovery, and disconnect verified.');

    await delay(200); await click(app, '.mode-picker button', 'Agent');
    assert.equal(await evaluate(app.client, `(() => { const input = document.querySelector('#little-prompt'); if (!input || input.disabled) return false; input.focus(); return true; })()`, app.agent), true);
    await fillComposer(app, 'native review team smoke: inspect app.ts then delegate independent architecture and verification reviews. Show both perspectives and separate suggested checks from checks actually executed.', deadline);
    await click(app, 'button[aria-label="Start a supervised Agent run"]');
    const reviewed = await waitFor(async () => {
      const state = await readAgent(app);
      return state?.response?.includes('LITTLE_REVIEW_TEAM_OK') && /Complete/.test(state.status ?? '') && state.reviews.length === 2
        && state.reviews.every(review => review.state === 'completed') && state.reviews.some(review => review.role === 'Architecture reviewer' && review.text.includes('LITTLE_ARCHITECTURE_REVIEW_OK'))
        && state.reviews.some(review => review.role === 'Verification reviewer' && review.text.includes('LITTLE_VERIFICATION_REVIEW_OK') && review.text.includes('No commands or checks were executed.')) ? state : undefined;
    }, 'Actual independent review team cards', deadline, 30000);
    assert.equal(report.reviews.architecture, 1); assert.equal(report.reviews.verification, 1); assert.equal(report.reviews.parentObservedBothResults, true);
    report.reviews.cards = reviewed.reviews;
    report.assertions.nativeReviewTeamTwoIndependentSessions = true; report.assertions.nativeReviewTeamCompletedRoleCards = true; report.assertions.verificationReviewDidNotClaimExecutedChecks = true;
    assert.equal(await evaluate(app.client, `(() => { const reviews = document.querySelector('.review-team'); if (!reviews) return false; reviews.scrollIntoView({block: 'center'}); return true; })()`, app.agent), true);
    await screenshot(app, 'reviews', report); console.log('Actual Agent delegation completed two independent read-only model sessions and rendered both reviewer cards with the no-checks-executed notice.');

    if (includeBrowser) { browser = await startPreviewBrowser(deadline, report); await verifyNativeBrowser(app, browser, deadline, report); await stopApp(browser, report); browser = undefined; }
    await stopApp(app, report); app = undefined;
    const tagsBeforeRestart = report.ollama.tags; const mcpRequestsBeforeRestart = report.mcp.methods.length;
    app = await startApp(expected, deadline, report); await openSettings(app, deadline);
    const restored = await waitFor(async () => {
      const state = await readAgent(app);
      return state?.provider === 'Ollama · local' && state.endpoint === ollama.url && state.model === model && state.models.includes(model)
        && state.memory.some(note => note.title === memoryTitle && note.content === memoryContent)
        && state.mcp.some(server => server.name === serverName && server.url === `${mcp.url}/mcp` && server.state === 'disconnected') ? state : undefined;
    }, 'Saved provider, memory, and MCP configuration after actual restart', deadline, 20000);
    report.restored = restored; report.assertions.memoryPersistedAcrossRestart = true; report.assertions.providerAndModelPersistedAcrossRestart = report.ollama.tags > tagsBeforeRestart;
    report.assertions.mcpConfigPersistedWithoutAutoConnection = report.mcp.methods.length === mcpRequestsBeforeRestart; await screenshot(app, 'restart', report);
    assert.ok(Object.values(report.assertions).every(Boolean)); report.success = true;
    console.log('Saved project memory, provider, model, and disconnected MCP configuration survived an actual packaged-app restart.');
  } catch (error) {
    app ??= error.smokeApp;
    browser ??= error.browserApp;
    report.error = error.message; process.exitCode = 1; console.error(`Native feature smoke failed: ${error.message}`);
    if (app?.client && app.agent) report.failedSurface = await readAgent(app).catch(() => undefined);
    if (app?.client && app.renderer) { app.client.deadline = Date.now() + 4500; await screenshot(app, 'failed', report).catch(() => undefined); }
  } finally {
    try { await stopApp(browser, report); } catch (error) { report.browserCleanupError = error.message; report.success = false; process.exitCode = 1; }
    try { await stopApp(app, report); } catch (error) { report.cleanupError = error.message; report.success = false; process.exitCode = 1; }
    await ollama?.close(); await mcp?.close(); report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(`Native feature smoke evidence: ${reportPath}`);
  }
}
export { startApp, stopApp, readAgent, openSettings, fillComposer, nativeInput, click, waitFor, evaluate, screenshot, profileRoot, fixtureRoot, evidenceRoot, ownedProcess };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Native feature smoke could not start: ${error.message}`); process.exitCode = 1; });
