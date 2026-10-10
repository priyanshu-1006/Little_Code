import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { BrowserClient, validateBrowserEndpoint, validateBrowserPage } from '../src/little/browser/browser-client.ts';
import { projectRoot } from './desktop-paths.mjs';

// Run with: node --import tsx scripts/smoke-browser.mjs
// Only this script's generated Chrome profile and local HTTP fixtures are accessed.
const runFile = promisify(execFile);
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileRoot = path.join(projectRoot, 'desktop', 'profile', `browser-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`);
const reportPath = path.join(projectRoot, 'desktop', 'logs', 'browser-smoke.json');
const screenshotPath = path.join(projectRoot, 'desktop', 'screenshots', 'browser-preview.png');
const deadlineMs = 85_000;
const fixtureHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Little Browser Acceptance</title>
<style>body{margin:48px;background:#101827;color:#eef3ff;font:20px system-ui}h1{color:#77d8c8}.hidden{display:none}form{margin-top:24px}</style></head>
<body><h1>Little browser preview</h1><p>Rendered local application content is visible.</p>
<div hidden>HIDDEN_ATTRIBUTE_CANARY</div><div class="hidden">HIDDEN_STYLE_CANARY</div><div aria-hidden="true">ARIA_HIDDEN_CANARY</div>
<form><label>FORM_TEXT_CANARY<input value="INPUT_VALUE_CANARY"></label><input type="password" value="PASSWORD_VALUE_CANARY">
<textarea>TEXTAREA_VALUE_CANARY</textarea><select><option>SELECT_VALUE_CANARY</option></select></form>
<div contenteditable="true">EDITABLE_TEXT_CANARY</div><script>const ignored = 'SCRIPT_TEXT_CANARY';</script></body></html>`;
const secretCanaries = ['HIDDEN_ATTRIBUTE_CANARY', 'HIDDEN_STYLE_CANARY', 'ARIA_HIDDEN_CANARY', 'FORM_TEXT_CANARY', 'INPUT_VALUE_CANARY', 'PASSWORD_VALUE_CANARY', 'TEXTAREA_VALUE_CANARY', 'SELECT_VALUE_CANARY', 'EDITABLE_TEXT_CANARY', 'SCRIPT_TEXT_CANARY'];

function samePath(first, second) { return typeof first === 'string' && path.resolve(first).replaceAll('\\', '/').toLowerCase() === path.resolve(second).replaceAll('\\', '/').toLowerCase(); }
async function processDetails(pid, timeoutMs = 4_000) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$browserSmokeProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $browserSmokeProcess) { 'null' } else { @{ path=$browserSmokeProcess.ExecutablePath; commandLine=$browserSmokeProcess.CommandLine } | ConvertTo-Json -Compress }`],
  { windowsHide: true, timeout: timeoutMs, maxBuffer: 16_000 });
  return JSON.parse(stdout.trim());
}
function assertProcessIdentity(details, executable) {
  assert.ok(details, 'The owned Chrome process exited.');
  assert.ok(samePath(details.path, executable), 'Chrome PID ownership changed: executable mismatch.');
  assert.ok(typeof details.commandLine === 'string' && details.commandLine.includes(`--user-data-dir=${profileRoot}`), 'Chrome PID ownership changed: isolated profile mismatch.');
}
async function assertOwnedProcess(pid, executable) {
  const details = await processDetails(pid);
  assertProcessIdentity(details, executable);
  return details;
}
async function jsonAt(endpoint, route) {
  const response = await fetch(new URL(route, endpoint), { signal: AbortSignal.timeout(1_500), redirect: 'error', credentials: 'omit', cache: 'no-store' });
  assert.equal(response.ok, true, `Owned debugging request failed: ${route}`);
  const body = await response.text();
  assert.ok(Buffer.byteLength(body) <= 64 * 1024, 'Owned debugging metadata exceeded its test bound.');
  return JSON.parse(body);
}
async function pageTargets(endpoint) {
  // Enumeration is restricted to TEST CODE, after authenticating our unique Chrome process.
  const targets = await jsonAt(endpoint, '/json/list');
  assert.ok(Array.isArray(targets));
  return targets.filter(target => target.type === 'page').map(target => ({ id: target.id, url: target.url }));
}
async function assertOriginalOnly(endpoint, original) {
  const deadline = Date.now() + 3_000;
  let pages;
  do {
    pages = await pageTargets(endpoint);
    if (pages.length === 1 && pages[0].id === original.id && pages[0].url === 'about:blank') return pages;
    await delay(80);
  } while (Date.now() < deadline);
  assert.deepEqual(pages, [original], 'BrowserClient leaked an owned target or altered the original blank tab.');
  return pages;
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function main() {
  assert.ok(process.argv.slice(2).every(argument => ['--help', '--dry-run'].includes(argument)), 'Unknown smoke argument.');
  if (process.argv.includes('--help')) { console.log('Usage: node --import tsx scripts/smoke-browser.mjs [--dry-run]\nVerifies BrowserClient against an owned isolated headless Chrome and local fixtures. No user browser tabs, models, or API keys are accessed.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ chromeExecutable, profileRoot, reportPath, screenshotPath, deadlineMs, launchesProcesses: false }, null, 2)); return; }
  assert.equal(process.platform, 'win32');
  assert.equal(typeof WebSocket, 'function');
  await access(chromeExecutable);
  const executable = await realpath(chromeExecutable);
  const startedAt = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, deadlineMs - 10_000);
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const report = { success: false, assertionsPassed: false, cleanupConfirmed: false, executable, profileRoot, reportPath, screenshotPath,
    startedAt: new Date(startedAt).toISOString(), assertions: {} };
  let child;
  let childExited = false;
  let profileCreated = false;
  let client;
  let launchError;
  let stderr = '';
  let endpoint;
  let original;
  let activeTargets;
  let fixtureError;
  let secondOriginRequests = 0;
  let resolveSlowRequest;
  const slowRequest = new Promise(resolve => { resolveSlowRequest = resolve; });
  const secondary = createServer((_request, response) => { secondOriginRequests++; response.end('DIFFERENT_ORIGIN_UNEXPECTED'); });
  let secondaryOrigin;
  const primary = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: `${secondaryOrigin}/different-origin` }); response.end(); return; }
    if (request.url === '/slow') { resolveSlowRequest(); return; }
    if (request.url !== '/app') { response.writeHead(204); response.end(); return; }
    void (async () => {
      activeTargets = await pageTargets(endpoint);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(fixtureHtml);
    })().catch(error => { fixtureError = error.message; response.writeHead(500); response.end('Fixture failed.'); });
  });
  try {
    await mkdir(path.dirname(profileRoot), { recursive: true });
    await mkdir(profileRoot); // Refuse any collision rather than reusing a profile.
    profileCreated = true;
    await mkdir(path.dirname(reportPath), { recursive: true });
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    secondaryOrigin = await listen(secondary);
    const appOrigin = await listen(primary);
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|VSCODE_DEV|CHROME_CRASHPAD_PIPE_NAME)$/i.test(key) || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete environment[key];
    // Chromium's test-only switch avoids launching a crash-reporting service for this profile.
    // https://github.com/chromium/chromium/blob/main/chrome/common/chrome_switches.h
    child = spawn(executable, [`--user-data-dir=${profileRoot}`, '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-networking', '--disable-extensions', '--disable-crashpad-for-testing', '--no-first-run', '--no-default-browser-check', 'about:blank'],
      { windowsHide: true, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', error => { launchError = error; });
    child.once('exit', () => { childExited = true; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    assert.ok(child.pid, 'Chrome did not produce an owned PID.');
    report.pid = child.pid;
    const startupDeadline = Date.now() + 15_000;
    let activePort;
    while (Date.now() < startupDeadline && !controller.signal.aborted) {
      if (launchError) throw launchError;
      if (childExited) throw new Error('Owned Chrome exited before publishing its debugging endpoint.');
      try { activePort = await readFile(path.join(profileRoot, 'DevToolsActivePort'), 'utf8'); break; } catch { await delay(100); }
    }
    assert.ok(activePort, 'Owned Chrome did not publish DevToolsActivePort within its startup deadline.');
    const [port, socketPath] = activePort.trim().split(/\r?\n/);
    assert.match(port, /^[0-9]{1,5}$/);
    assert.ok(Number(port) > 0 && Number(port) <= 65_535);
    assert.match(socketPath, /^\/devtools\/browser\/[A-Za-z0-9-]+$/);
    endpoint = validateBrowserEndpoint(`http://127.0.0.1:${port}`);
    const ownership = await assertOwnedProcess(child.pid, executable);
    report.verifiedProcessPath = ownership.path;
    const version = await jsonAt(endpoint, '/json/version');
    assert.equal(version.webSocketDebuggerUrl, `ws://127.0.0.1:${port}${socketPath}`, 'The debugging endpoint differs from our profile-owned DevToolsActivePort.');
    report.endpoint = endpoint;
    report.browserVersion = version.Browser;
    report.assertions.ownedPidProfileAndDebugEndpointVerified = true;
    const initialPages = await pageTargets(endpoint);
    assert.equal(initialPages.length, 1, 'Owned Chrome should start with one isolated blank page.');
    [original] = initialPages;
    assert.equal(original.url, 'about:blank');
    report.originalTarget = original;
    client = new BrowserClient(endpoint);
    const snapshot = await client.snapshot(validateBrowserPage(`${appOrigin}/app`), controller.signal);
    assert.equal(fixtureError, undefined);
    assert.equal(snapshot.url, `${appOrigin}/app`);
    assert.equal(snapshot.title, 'Little Browser Acceptance');
    assert.ok(snapshot.text.includes('Little browser preview'));
    assert.ok(snapshot.text.includes('Rendered local application content is visible.'));
    for (const canary of secretCanaries) assert.ok(!snapshot.text.includes(canary), `DOM extraction exposed ${canary}.`);
    assert.equal(snapshot.truncated, false);
    assert.equal(activeTargets.length, 2, 'Inspection should have exactly one fresh page beside the original tab.');
    assert.ok(activeTargets.some(target => target.id === original.id && target.url === 'about:blank'));
    assert.ok(activeTargets.some(target => target.id !== original.id));
    report.inspectionTargets = activeTargets;
    report.assertions.realRenderedTitleAndText = true;
    report.assertions.formHiddenPasswordAndEditableTextExcluded = true;
    report.assertions.freshInspectionTargetCreated = true;
    assert.match(snapshot.screenshot ?? '', /^data:image\/png;base64,/);
    const png = Buffer.from(snapshot.screenshot.slice('data:image/png;base64,'.length), 'base64');
    assert.ok(png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    await writeFile(screenshotPath, png);
    report.screenshot = { bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    report.snapshot = { url: snapshot.url, title: snapshot.title, text: snapshot.text, truncated: snapshot.truncated };
    report.assertions.actualChromiumPngSaved = true;
    await assertOriginalOnly(endpoint, original);
    report.assertions.successTargetClosedOriginalPreserved = true;
    await assert.rejects(client.snapshot(`${appOrigin}/redirect`, controller.signal), error => error?.code === 'PERMISSION_DENIED');
    await delay(150);
    assert.equal(secondOriginRequests, 0, 'Cross-origin document redirect reached the second server before being blocked.');
    report.secondOriginRequests = secondOriginRequests;
    report.assertions.crossOriginRedirectBlockedBeforeRequest = true;
    await assertOriginalOnly(endpoint, original);
    report.assertions.rejectedTargetClosedOriginalPreserved = true;
    const cancelled = new AbortController();
    const cancelOnDeadline = () => cancelled.abort();
    controller.signal.addEventListener('abort', cancelOnDeadline, { once: true });
    try {
      controller.signal.throwIfAborted();
      const pending = client.snapshot(`${appOrigin}/slow`, AbortSignal.any([controller.signal, cancelled.signal]));
      const rejected = assert.rejects(pending, error => error?.code === 'AGENT_CANCELLED');
      await Promise.race([slowRequest, delay(4_000).then(() => { throw new Error('Cancellation fixture was not reached.'); })]);
      cancelled.abort();
      await rejected;
    } finally { cancelled.abort(); controller.signal.removeEventListener('abort', cancelOnDeadline); }
    await assertOriginalOnly(endpoint, original);
    controller.signal.throwIfAborted();
    report.assertions.pendingCancellationClosesOnlyOwnedTarget = true;
    report.assertionsPassed = Object.values(report.assertions).every(Boolean);
    console.log('Real Chrome rendered text, PNG, fresh-tab cleanup, cancellation, and redirect protection verified.');
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
    console.error(`Browser smoke failed: ${error.message}`);
  } finally {
    client?.dispose();
    controller.abort();
    await Promise.all([closeServer(primary), closeServer(secondary)]);
    let cleanupError;
    const cleanupDeadline = Math.min(startedAt + deadlineMs, Date.now() + 10_000);
    const cleanupTimeout = limit => {
      const remaining = Math.min(limit, cleanupDeadline - Date.now());
      if (remaining <= 0) throw new Error('Owned Chrome cleanup reached its deadline.');
      return remaining;
    };
    if (child?.pid) {
      try {
        const details = await processDetails(child.pid, cleanupTimeout(3_000));
        if (details) {
          assertProcessIdentity(details, executable);
          await runFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: cleanupTimeout(3_000), maxBuffer: 16_000 });
        }
      } catch (error) { cleanupError = error.message; }
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          if (!(await processDetails(child.pid, cleanupTimeout(3_000)))) { report.cleanupConfirmed = true; break; }
          await delay(100);
        }
      } catch (error) { cleanupError = error.message; }
    } else report.cleanupConfirmed = true;
    report.ownedChromeExited = report.cleanupConfirmed;
    child?.stderr?.destroy(); child?.unref();
    report.success = report.assertionsPassed && report.cleanupConfirmed;
    if (!report.cleanupConfirmed) { report.cleanupError = cleanupError ?? 'Could not confirm owned Chrome exited.'; process.exitCode = 1; }
    report.stderr = stderr;
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAt;
    clearTimeout(timer);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (profileCreated) await writeFile(path.join(profileRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
    console.log(`Browser smoke evidence: ${reportPath}`);
  }
}
main().catch(error => { console.error(`Browser smoke could not start: ${error.message}`); process.exitCode = 1; });
