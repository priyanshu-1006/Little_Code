import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';

const runFile = promisify(execFile);
const profileRoot = path.join(projectRoot, 'desktop', 'profile', `smoke-${Date.now()}-${process.pid}`);
const repositorySmoke = process.argv.includes('--repository');
const fixtureRoot = path.join(profileRoot, 'repository-fixture');
const screenshotPath = path.join(projectRoot, 'desktop', 'screenshots', repositorySmoke ? 'repository-index.png' : 'first-launch.png');
const reportPath = path.join(projectRoot, 'desktop', 'screenshots', repositorySmoke ? 'repository-index.json' : 'first-launch.json');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Minimal CDP transport; no browser, UI, or application is simulated. */
class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.deadline = Infinity;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`DevTools disconnected during ${pending.method}.`));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('DevTools connection timed out.')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('DevTools connection failed.')); }, { once: true });
    });
    return new DevToolsClient(socket);
  }

  send(method, params = {}, sessionId, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('DevTools is closed.')); return; }
      const remaining = Math.min(timeoutMs, this.deadline - Date.now());
      if (remaining <= 0) { reject(new Error('Desktop verification deadline reached.')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, remaining);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() { this.socket.close(); }
}

function argumentsFor(port) {
  return [
    '--new-window',
    `--user-data-dir=${path.join(profileRoot, 'user-data')}`,
    `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--skip-release-notes',
    '--disable-extension=vscode.vscode-api-tests',
    ...(repositorySmoke ? ['--disable-workspace-trust', fixtureRoot] : []),
  ];
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Loopback port could not be reserved.');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function shellRead(command) {
  const result = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

function samePath(first, second) {
  return path.resolve(first).replaceAll('\\', '/').toLowerCase() === path.resolve(second).replaceAll('\\', '/').toLowerCase();
}

const nativeExpression = `(() => {
  const auxiliary = document.querySelector('.part.auxiliarybar');
  const bounds = auxiliary?.getBoundingClientRect();
  return {
    title: document.title,
    location: location.href,
    littleWorkbench: document.body?.classList.contains('little-code') === true,
    nativeWorkbench: !!document.querySelector('.monaco-workbench'),
    agentSidebar: !!bounds && bounds.width >= 170 && bounds.height > 0 && bounds.left >= innerWidth / 2,
    sidebarText: (auxiliary?.textContent ?? '').slice(0, 500),
    interLoaded: [...document.fonts].some(font => /Inter/.test(font.family) && font.status === 'loaded'),
    uiFontFamily: document.querySelector('.monaco-workbench') ? getComputedStyle(document.querySelector('.monaco-workbench')).fontFamily : '',
  };
})()`;

const surfaceExpression = `(() => {
  const home = document.querySelector('main.little-home');
  const agent = document.querySelector('main.agent-shell');
  if (!home && !agent) return null;
  return {
    home: !!home,
    heading: document.querySelector('#home-title')?.textContent?.replace(/\\s+/g, ' ').trim(),
    openProject: !!document.querySelector('[data-action="openProject"]'),
    groqStatus: document.querySelector('#provider-status')?.textContent,
    workspaceStatus: document.querySelector('#workspace-status')?.textContent,
    agent: !!agent,
    modes: [...document.querySelectorAll('.mode-picker button')].map(button => button.textContent.trim()),
    connectGroq: [...document.querySelectorAll('button')].some(button => button.textContent.includes('Connect Groq')),
    modelDisabled: document.querySelector('#little-model')?.disabled,
    logoLoaded: !!home && [...document.querySelectorAll('.hero-mark img')].some(image => image.complete && image.naturalWidth > 0),
    fontsLoaded: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family),
    repository: agent && document.querySelector('.repository-card') ? {
      state: document.querySelector('.repository-card').dataset.repositoryState,
      generation: Number(document.querySelector('.repository-card').dataset.repositoryGeneration),
      files: Number(document.querySelector('.repository-card').dataset.repositoryFiles),
      symbols: Number(document.querySelector('.repository-card').dataset.repositorySymbols),
      reused: Number(document.querySelector('.repository-card').dataset.repositoryReused),
      text: document.querySelector('.repository-card').textContent,
      refreshEnabled: !document.querySelector('[aria-label="Refresh project index"]')?.disabled,
      visible: (() => { const card = document.querySelector('.repository-card').getBoundingClientRect(); const area = document.querySelector('.conversation').getBoundingClientRect(); return card.height > 0 && card.top >= area.top && card.bottom <= area.bottom; })(),
    } : undefined,
  };
})()`;

const bootstrapExpression = `(() => ({
  readyState: document.readyState,
  body: document.body?.outerHTML.slice(0, 2000),
  scripts: [...document.scripts].map(script => ({src: script.src, type: script.type})),
  resources: performance.getEntriesByType('resource').map(resource => ({name: resource.name, duration: resource.duration, size: resource.transferSize})),
  preloadAvailable: typeof window.vscode,
}))()`;

async function evaluate(client, expression, sessionId, contextId) {
  const response = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
    ...(contextId === undefined ? {} : { contextId }),
  }, sessionId);
  if (response.exceptionDetails) return undefined;
  return response.result?.value;
}

function inspectEvidence(native, surfaces) {
  const home = surfaces.find(surface => surface?.home);
  const agent = surfaces.find(surface => surface?.agent);
  return {
    nativeWorkbench: !!native?.nativeWorkbench && !!native?.littleWorkbench && /Little Code/i.test(native.title),
    rightAgentSidebar: !!native?.agentSidebar && /Little/i.test(native.sidebarText),
    littleHome: !!home?.openProject && !!home?.logoLoaded && /Build with Little/i.test(home.heading ?? ''),
    isolatedProvider: /not connected/i.test(home?.groqStatus ?? '') && home?.workspaceStatus === (repositorySmoke ? 'Project · repository-fixture' : 'No project open'),
    littleAgent: !!agent?.connectGroq && agent.modelDisabled === true && ['Ask', 'Plan', 'Edit', 'Agent'].every(mode => agent.modes.includes(mode)),
    bundledFonts: native?.interLoaded === true && /Inter/.test(native?.uiFontFamily ?? '') && ['Inter', 'Space Grotesk'].every(family => home?.fontsLoaded?.some(font => font.includes(family))),
    ...(repositorySmoke ? { localRepositoryReady: agent?.repository?.state === 'ready' && agent.repository.files === 3 && agent.repository.symbols === 2 && agent.repository.refreshEnabled && agent.repository.visible } : {}),
  };
}

async function verifyRepository(client, agent, deadline, report) {
  const read = async () => (await evaluate(client, surfaceExpression, agent.sessionId, agent.contextId))?.repository;
  const waitFor = async (predicate, description) => {
    const until = Math.min(deadline, Date.now() + 15000);
    let status;
    while (Date.now() < until) { status = await read(); if (status && predicate(status)) return status; await delay(200); }
    throw new Error(`${description}: ${JSON.stringify(status)}`);
  };
  const before = await read();
  assert(before?.state === 'ready', 'Actual Little index did not become ready.');
  assert(await evaluate(client, `(() => { const button = document.querySelector('[aria-label="Refresh project index"]'); if (!button || button.disabled) return false; button.click(); return true; })()`, agent.sessionId, agent.contextId), 'Actual index refresh control was unavailable.');
  report.repositoryRefresh = await waitFor(status => status.state === 'ready' && status.generation > before.generation && status.reused === 3, 'Refresh did not reuse unchanged metadata');
  await writeFile(path.join(fixtureRoot, 'src', 'extra.ts'), 'export function additionalSession() { return true; }\n');
  report.repositoryWatchCreate = await waitFor(status => status.state === 'ready' && status.generation > report.repositoryRefresh.generation && status.files === 4 && status.symbols === 3, 'Native watcher did not index the new source');
  await writeFile(path.join(fixtureRoot, '.littleignore'), 'private.ts\nsrc/extra.ts\n');
  report.repositoryWatchIgnore = await waitFor(status => status.state === 'ready' && status.generation > report.repositoryWatchCreate.generation && status.files === 3 && status.symbols === 2, 'Native watcher did not apply updated ignore policy');
  report.repositoryAssertions = { keyFreeIndex: before.files === 3 && before.symbols === 2, unchangedMetadataReused: report.repositoryRefresh.reused === 3, newSourceIndexed: report.repositoryWatchCreate.files === 4, updatedIgnoresApplied: report.repositoryWatchIgnore.files === 3 };
  console.log('Actual project index, refresh reuse, new-file watcher, and updated ignore policy verified without an API key.');
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/smoke-desktop.mjs [--dry-run] [--repository]\nLaunches only the packaged Little Code app with a new isolated profile, verifies native UI and optional generated-project indexing, captures a screenshot, then closes that test instance.');
    return;
  }
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ executable: packagedExecutable, arguments: argumentsFor('<unused loopback port>'), screenshotPath, reportPath, launched: false }, null, 2));
    return;
  }
  assert.equal(process.platform, 'win32', 'This smoke check targets the Windows desktop package.');
  assert.equal(typeof WebSocket, 'function', 'Use the pinned Node runtime with built-in WebSocket support.');
  await access(packagedExecutable);
  const expectedPath = await realpath(packagedExecutable);
  await mkdir(profileRoot, { recursive: true });
  if (repositorySmoke) {
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'generated'), { recursive: true });
    for (const [file, source] of Object.entries({
      'src/auth.ts': 'import { session } from "./session";\nexport function authenticateUser() { return session; }\n',
      'src/session.ts': 'export const session = true;\n',
      '.littleignore': 'private.ts\n',
      '.env': 'GROQ_API_KEY=local-smoke-private-marker\n',
      'private.ts': 'export function PrivateCredential() {}\n',
      'generated/client.ts': 'export function GeneratedPrivate() {}\n',
    })) await writeFile(path.join(fixtureRoot, file), source);
  }
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  const port = await unusedLoopbackPort();
  const environment = { ...process.env, NODE_ENV: 'production' };
  delete environment.VSCODE_DEV;
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(packagedExecutable, argumentsFor(port), {
    cwd: packagedRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let launchError;
  let exited = false;
  let output = '';
  child.once('error', error => { launchError = error; });
  child.once('exit', () => { exited = true; });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    output = (output + chunk.toString()).slice(-12000);
  });
  let client;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const startedAt = Date.now();
  const diagnostic = process.argv.includes('--diagnose');
  const deadline = startedAt + (diagnostic ? 45000 : 145000);
  const report = { executable: expectedPath, profileRoot, pid: child.pid, port, startedAt: new Date(startedAt).toISOString(), assertions: {}, diagnostics: [], success: false };
  let rendererSession;
  try {
    if (launchError) throw launchError;
    assert(child.pid, 'The packaged app did not produce a process ID.');
    const observedPath = await shellRead(`(Get-Process -Id ${child.pid} -ErrorAction Stop).Path`);
    assert(samePath(observedPath, expectedPath), `Spawned process path did not match the package: ${observedPath}`);
    report.verifiedProcessPath = observedPath;
    console.log(`Verifying real desktop process ${child.pid}: ${observedPath}`);
    let version;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (exited) throw new Error('The packaged app exited before exposing its native workbench.');
      if (cancelled) throw new Error('Desktop smoke check cancelled.');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) { version = await response.json(); if (version.webSocketDebuggerUrl) break; }
      } catch { /* Chromium may still be starting. */ }
      await delay(300);
    }
    assert(version?.webSocketDebuggerUrl, 'The packaged app did not expose DevTools before the deadline.');
    // The Windows network provider may omit loopback listeners. Bind this connection
    // to the unique debugger URL received directly from our owned child's stderr.
    const endpoint = output.match(new RegExp(`DevTools listening on (ws://127\\.0\\.0\\.1:${port}/devtools/browser/[a-f0-9-]+)`))?.[1];
    assert(endpoint && endpoint === version.webSocketDebuggerUrl, 'DevTools endpoint does not match the owned app process; refusing to inspect or close it.');
    assert(!exited && samePath(await shellRead(`(Get-Process -Id ${child.pid} -ErrorAction Stop).Path`), expectedPath), 'The verified Little Code process is no longer running.');
    report.verifiedDebugEndpointFromChild = endpoint;
    client = await DevToolsClient.connect(version.webSocketDebuggerUrl);
    client.deadline = deadline;
    const sessions = new Map();
    const contexts = new Map();
    client.listeners.add(message => {
      if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded', 'Network.loadingFailed'].includes(message.method)) {
        report.diagnostics.push({method: message.method, sessionId: message.sessionId, params: message.params});
        if (report.diagnostics.length > 300) report.diagnostics.shift();
        if (message.method === 'Runtime.exceptionThrown' || (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error')) console.log(`Renderer diagnostic: ${JSON.stringify(message.params).slice(0, 4000)}`);
      }
      if (message.method === 'Runtime.executionContextCreated' && message.sessionId) {
        const existing = contexts.get(message.sessionId) ?? new Map();
        existing.set(message.params.context.id, message.params.context);
        contexts.set(message.sessionId, existing);
      } else if (message.method === 'Runtime.executionContextDestroyed' && message.sessionId) {
        contexts.get(message.sessionId)?.delete(message.params.executionContextId);
      } else if (message.method === 'Runtime.executionContextsCleared' && message.sessionId) {
        contexts.delete(message.sessionId);
      } else if (message.method === 'Target.detachedFromTarget') {
        contexts.delete(message.params.sessionId);
        for (const [targetId, session] of sessions) if (session.id === message.params.sessionId) sessions.delete(targetId);
      }
    });
    let lastProgress = 0;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (exited) throw new Error('Little Code exited during native UI verification.');
      if (cancelled) throw new Error('Desktop smoke check cancelled.');
      const { targetInfos } = await client.send('Target.getTargets');
      report.targets = targetInfos.map(target => ({id: target.targetId, type: target.type, title: target.title, url: target.url}));
      for (const target of targetInfos.filter(target => ['page', 'iframe'].includes(target.type))) {
        const existing = sessions.get(target.targetId);
        if (existing) {
          existing.target = target;
          if (/\/vs\/code\/electron-browser\/workbench\/workbench\.html/.test(target.url) && rendererSession !== existing.id) {
            rendererSession = existing.id;
            await client.send('Page.enable', {}, existing.id);
          }
          continue;
        }
        try {
          const { sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          sessions.set(target.targetId, { id: sessionId, target });
          await client.send('Runtime.enable', {}, sessionId);
          await client.send('Log.enable', {}, sessionId);
          if (diagnostic) await client.send('Network.enable', {}, sessionId);
          if (/\/vs\/code\/electron-browser\/workbench\/workbench\.html/.test(target.url)) {
            rendererSession = sessionId;
            await client.send('Page.enable', {}, sessionId);
          }
        } catch { /* Webviews may navigate while their actual content is mounted. */ }
      }
      const native = rendererSession ? await evaluate(client, nativeExpression, rendererSession).catch(() => undefined) : undefined;
      const readings = [];
      for (const session of sessions.values()) {
        const sessionContexts = contexts.get(session.id);
        const contextIds = sessionContexts?.size ? [...sessionContexts.keys()] : [undefined];
        for (const contextId of contextIds) readings.push(evaluate(client, surfaceExpression, session.id, contextId)
          .then(surface => ({surface, sessionId: session.id, contextId})).catch(() => undefined));
      }
      const observed = (await Promise.all(readings)).filter(reading => reading?.surface);
      const surfaces = observed.map(reading => reading.surface);
      report.assertions = inspectEvidence(native, surfaces);
      report.native = native;
      report.surfaces = surfaces;
      if (diagnostic && rendererSession) report.bootstrap = await evaluate(client, bootstrapExpression, rendererSession).catch(() => undefined);
      if (Object.values(report.assertions).every(Boolean)) {
        await delay(500);
        const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, rendererSession, 10000);
        await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
        report.screenshot = screenshotPath;
        const home = observed.find(reading => reading.surface.home);
        assert(home, 'The native Little Home execution context disappeared.');
        assert(await evaluate(client, `(() => { const button = document.querySelector('[data-action="configure"]'); if (!button) return false; button.click(); return true; })()`, home.sessionId, home.contextId), 'Little Home could not invoke Groq setup.');
        const dialogDeadline = Math.min(deadline, Date.now() + 10000);
        while (Date.now() < dialogDeadline) {
          report.nativeGroqSetup = await evaluate(client, `(() => { const widget = document.querySelector('.quick-input-widget'); return !!widget && widget.getBoundingClientRect().height > 0 && !!widget.querySelector('input[type="password"]') && /Connect Little Code to Groq/.test(widget.textContent); })()`, rendererSession);
          if (report.nativeGroqSetup) break;
          await delay(150);
        }
        assert(report.nativeGroqSetup, 'Connect Groq did not open the native masked API-key dialog.');
        await client.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}, rendererSession);
        await client.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}, rendererSession);
        const cancellationDeadline = Math.min(deadline, Date.now() + 2500);
        while (Date.now() < cancellationDeadline) {
          const hidden = await evaluate(client, `(() => { const widget = document.querySelector('.quick-input-widget'); return !widget || widget.getBoundingClientRect().height === 0; })()`, rendererSession);
          const settled = await evaluate(client, `(() => { const button = document.querySelector('[data-action="configure"]'); return !!button && !button.disabled && /not connected/i.test(document.querySelector('#provider-status')?.textContent ?? ''); })()`, home.sessionId, home.contextId);
          report.nativeGroqSetupCancelled = hidden && settled;
          if (report.nativeGroqSetupCancelled) break;
          await delay(150);
        }
        assert(report.nativeGroqSetupCancelled, 'The empty key dialog did not cancel and settle back to disconnected Home.');
        if (repositorySmoke) {
          const agent = observed.find(reading => reading.surface.agent);
          assert(agent, 'The actual Little Agent execution context disappeared.');
          await verifyRepository(client, agent, deadline, report);
          const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, rendererSession, 10000);
          await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
        }
        report.success = true;
        console.log(`Native workbench, right agent, Little home, isolated Groq state, Ask/Plan/Edit/Agent UI, and native masked-key setup verified.\nReal-app screenshot: ${screenshotPath}`);
        break;
      }
      if (Date.now() - lastProgress > 15000) {
        console.log(`Waiting for real Little UI: ${JSON.stringify(report.assertions)} (${sessions.size} renderer targets).`);
        report.processOutput = output;
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        lastProgress = Date.now();
      }
      await delay(500);
    }
    assert(report.success, `Desktop UI did not become ready: ${JSON.stringify(report.assertions)}`);
  } catch (error) {
    report.error = error.message;
    report.processOutput = output;
    process.exitCode = cancelled ? 130 : 1;
    console.error(`Desktop smoke check failed: ${error.message}`);
    if (client && rendererSession) {
      try {
        client.deadline = Date.now() + 4500;
        const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, rendererSession, 4000);
        await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
        report.screenshot = screenshotPath;
      } catch { /* Evidence includes native startup logs even if rendering failed. */ }
    }
  } finally {
    if (client) {
      client.deadline = Date.now() + 3500;
      await client.send('Browser.close', {}, undefined, 3000).catch(() => undefined);
      client.close();
    }
    for (let attempt = 0; !exited && attempt < 10; attempt++) await delay(300);
    if (!exited && child.pid) {
      await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }).catch(error => {
        report.cleanupError = error.message;
        process.exitCode = 1;
      });
    }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAt;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Desktop smoke evidence: ${reportPath}`);
  }
}

main().catch(error => { console.error(`Desktop smoke check could not start: ${error.message}`); process.exitCode = 1; });
