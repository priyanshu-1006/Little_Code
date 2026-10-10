import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';

const runFile = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const profileRoot = path.join(projectRoot, 'desktop', 'profile', `command-host-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`);
const reportPath = path.join(projectRoot, 'desktop', 'logs', 'native-command-host-smoke.json');
const deadlineMs = 85000;

function samePath(first, second) { return path.resolve(first).replaceAll('\\', '/').toLowerCase() === path.resolve(second).replaceAll('\\', '/').toLowerCase(); }
class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.deadline = Infinity;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned DevTools connection closed.')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Owned DevTools connection timed out.')); }, 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Owned DevTools connection failed.')); }, { once: true });
    });
    return new DevToolsClient(socket);
  }
  send(method, params = {}, sessionId, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('Owned DevTools is closed.')); return; }
      const remaining = Math.min(timeoutMs, this.deadline - Date.now());
      if (remaining <= 0) { reject(new Error('Native command smoke deadline reached.')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, remaining);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function ownedProcess(pid, expectedPath) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($null -eq $p) { throw 'Owned smoke process exited.' }; @{ path=$p.ExecutablePath; commandLine=$p.CommandLine } | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 4000, maxBuffer: 16000 });
  const process = JSON.parse(stdout.trim());
  assert.ok(samePath(process.path, expectedPath), 'Owned process executable does not match the packaged app.');
  assert.ok(process.commandLine.includes(profileRoot), 'Owned process no longer has this smoke profile.');
  return process.path;
}
async function evaluate(client, expression, sessionId) {
  const response = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (response.exceptionDetails) throw new Error('Owned workbench evaluation failed.');
  return response.result?.value;
}
const dialogExpression = `(() => {
  const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(dialog => dialog.getBoundingClientRect().height > 0);
  return dialogs.map(dialog => ({ text: dialog.textContent.replace(/\\s+/g, ' ').trim(),
    buttons: [...dialog.querySelectorAll('button,[role="button"]')].filter(button => button.getBoundingClientRect().height > 0).map(button => button.textContent.replace(/\\s+/g, ' ').trim()) }));
})()`;
function clickExpression(script) {
  assert.ok(['marker.cjs', 'late-marker.cjs'].includes(script));
  return `(() => {
    const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(dialog => dialog.getBoundingClientRect().height > 0 && dialog.textContent.includes('Run this project command?') && dialog.textContent.includes(${JSON.stringify(script)}));
    if (dialogs.length !== 1) return false;
    const buttons = [...dialogs[0].querySelectorAll('button,[role="button"]')].filter(button => button.getBoundingClientRect().height > 0 && button.textContent.replace(/\\s+/g, ' ').trim() === 'Run command');
    if (buttons.length !== 1) return false;
    buttons[0].click(); return true;
  })()`;
}
async function fixtureFiles() {
  const extension = path.join(profileRoot, 'smoke-extension');
  const fixtureProject = path.join(profileRoot, 'fixture-project');
  const testEntry = path.join(extension, 'test-entry.cjs');
  await mkdir(extension, { recursive: true });
  await mkdir(fixtureProject, { recursive: true });
  await mkdir(path.join(profileRoot, 'user-data', 'User'), { recursive: true });
  await writeFile(path.join(extension, 'package.json'), JSON.stringify({ name: 'little-native-command-host-smoke', publisher: 'little-code-local-tests', version: '0.0.0', engines: { vscode: '^1.96.0' }, activationEvents: ['*'], main: './extension.cjs' }));
  // Upstream test mode intentionally refuses dialogs, so use ordinary extension activation.
  await writeFile(path.join(extension, 'extension.cjs'), 'exports.activate = () => { void require("./test-entry.cjs").run().catch(error => console.error("Native command host fixture failed:", error)); };\n');
  await writeFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
  await writeFile(path.join(fixtureProject, 'marker.cjs'), 'require("node:fs").writeFileSync("allowed-marker.txt", "LITTLE_COMMAND_HOST_OK"); console.log("LITTLE_COMMAND_HOST_OK");\n');
  await writeFile(path.join(fixtureProject, 'pending-marker.cjs'), 'require("node:fs").writeFileSync("pending-marker.txt", "UNEXPECTED");\n');
  await writeFile(path.join(fixtureProject, 'late-marker.cjs'), 'const fs = require("node:fs"); fs.writeFileSync("running-marker.txt", "STARTED"); console.log("LITTLE_RUNNING_COMMAND_STARTED"); setTimeout(() => fs.writeFileSync("late-marker.txt", "UNEXPECTED"), 1800); setTimeout(() => process.exit(0), 4000);\n');
  await build({ entryPoints: [path.join(projectRoot, 'tests', 'fixtures', 'command-host-smoke.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'], outfile: testEntry });
  return { extension, fixtureProject, testEntry };
}
async function main() {
  assert.ok(process.argv.slice(2).every(argument => ['--help', '--dry-run'].includes(argument)), 'Unknown smoke argument.');
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/smoke-command-host.mjs [--dry-run]\nTests real native command review in only the packaged Little Code app with an isolated generated fixture profile. No provider or API key is used.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ executable: packagedExecutable, profileRoot, reportPath, deadlineMs, launchesProcesses: false }, null, 2)); return; }
  assert.equal(process.platform, 'win32');
  assert.equal(typeof WebSocket, 'function');
  await access(packagedExecutable);
  const expected = await realpath(packagedExecutable);
  assert.ok(samePath(expected, path.join(await realpath(packagedRoot), 'Little Code.exe')), 'The packaged executable resolves outside its expected directory.');
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  await mkdir(path.dirname(reportPath), { recursive: true });
  const fixture = await fixtureFiles();
  const port = await unusedPort();
  const environment = { ...process.env, NODE_ENV: 'production', LITTLE_COMMAND_HOST_SMOKE_PROFILE: profileRoot };
  for (const key of Object.keys(environment)) if (/^(?:ELECTRON_RUN_AS_NODE|VSCODE_DEV|NODE_OPTIONS|NODE_PATH)$/i.test(key) || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete environment[key];
  const args = ['--new-window', `--user-data-dir=${path.join(profileRoot, 'user-data')}`, `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--skip-release-notes', '--skip-welcome', '--disable-workspace-trust',
    `--extensionDevelopmentPath=${fixture.extension}`, fixture.fixtureProject];
  const child = spawn(packagedExecutable, args, { cwd: packagedRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let launchError;
  let output = '';
  let stderr = '';
  child.once('error', error => { launchError = error; });
  child.once('exit', () => { exited = true; });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32000); });
  let client;
  let endpoint;
  let rendererSession;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const report = { success: false, executable: expected, profileRoot, reportPath, pid: child.pid, port,
    startedAt: new Date(startedAt).toISOString(), modalObservations: [], clickedPhases: [], assertions: {} };
  const clicked = new Set();
  try {
    if (launchError) throw launchError;
    assert.ok(child.pid, 'Packaged app did not produce an owned process ID.');
    report.verifiedProcessPath = await ownedProcess(child.pid, expected);
    // Reserve twenty seconds of the total budget for authenticated process shutdown.
    while (Date.now() < deadline - 20000) {
      if (cancelled) throw new Error('Native command host smoke cancelled.');
      if (launchError) throw launchError;
      let progress;
      try { progress = JSON.parse(await readFile(path.join(profileRoot, 'progress.json'), 'utf8')); } catch { /* The extension host may still be starting or writing. */ }
      if (progress) {
        report.progress = progress;
        report.assertions = progress.assertions ?? {};
        if (progress.phase === 'failed') throw new Error(progress.error ?? 'Native fixture failed.');
        if (progress.phase === 'complete') { report.success = progress.success === true && Object.values(report.assertions).every(Boolean) && clicked.size === 2; break; }
      }
      if (exited) throw new Error('Owned packaged app exited before command review verification completed.');
      if (!client) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
          const version = await response.json();
          endpoint = stderr.match(new RegExp(`DevTools listening on (ws://127\\.0\\.0\\.1:${port}/devtools/browser/[a-f0-9-]+)`))?.[1];
          if (endpoint) {
            assert.equal(version.webSocketDebuggerUrl, endpoint, 'DevTools does not match the endpoint published by our child stderr.');
            await ownedProcess(child.pid, expected);
            client = await DevToolsClient.connect(endpoint);
            client.deadline = deadline - 20000;
            report.verifiedDebugEndpointFromChild = endpoint;
          }
        } catch (error) {
          if (endpoint) throw error;
        }
      }
      if (client && !rendererSession) {
        const { targetInfos } = await client.send('Target.getTargets');
        const workbenches = targetInfos.filter(target => target.type === 'page' && /\/vs\/code\/electron-browser\/workbench\/workbench\.html/.test(target.url));
        assert.ok(workbenches.length <= 1, 'Owned test app exposed ambiguous native workbenches.');
        if (workbenches.length === 1) {
          const attached = await client.send('Target.attachToTarget', { targetId: workbenches[0].targetId, flatten: true });
          rendererSession = attached.sessionId;
          await client.send('Runtime.enable', {}, rendererSession);
          report.workbenchTarget = { id: workbenches[0].targetId, url: workbenches[0].url };
        }
      }
      if (rendererSession && progress && ['allow-modal', 'dispose-modal'].includes(progress.phase) && !clicked.has(progress.phase)) {
        const dialogs = await evaluate(client, dialogExpression, rendererSession);
        const matching = dialogs.filter(dialog => dialog.text.includes('Run this project command?') && dialog.text.includes(progress.script) && dialog.buttons.includes('Run command'));
        if (matching.length === 1) {
          report.modalObservations.push({ phase: progress.phase, dialog: matching[0], observedAt: new Date().toISOString() });
          // Recheck ownership before the single input, then revalidate exact modal text in the click expression.
          await ownedProcess(child.pid, expected);
          assert.equal(await evaluate(client, clickExpression(progress.script), rendererSession), true, 'The observed owned command modal disappeared before input.');
          clicked.add(progress.phase);
          report.clickedPhases = [...clicked];
          console.log(`Confirmed native Run command modal for isolated ${progress.script}.`);
        }
      }
      await delay(100);
    }
    assert.equal(report.success, true, `Native command host verification did not complete: ${report.progress?.phase ?? 'no extension progress'}.`);
    report.assertions.actualNativeModalsConfirmed = clicked.size === 2;
    console.log('Native command rejection, Allow once, pending cancellation, and executing host disposal verified.');
  } catch (error) {
    report.error = error.message;
    process.exitCode = cancelled ? 130 : 1;
    console.error(`Native command host smoke failed: ${error.message}`);
  } finally {
    // Never enumerate or close another desktop instance; cleanup is restricted to our authenticated child.
    if (client && !exited) {
      client.deadline = Date.now() + 2500;
      try { await ownedProcess(child.pid, expected); await client.send('Browser.close', {}, undefined, 2000); } catch { /* Owned child cleanup below remains scoped. */ }
    }
    client?.close();
    for (let attempt = 0; !exited && attempt < 5; attempt++) await delay(150);
    let cleanupDiagnostic;
    if (!exited && child.pid) {
      try {
        await ownedProcess(child.pid, expected);
        await runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
      } catch (error) {
        // taskkill can report vanished descendants while successfully stopping its owned parent.
        cleanupDiagnostic = error.message;
      }
    }
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    const { stdout: absence } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `$nativeSmokeProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; if ($nativeSmokeProcess) { if ($nativeSmokeProcess.ExecutablePath -ine ${literal(expected)} -or -not $nativeSmokeProcess.CommandLine.Contains(${literal(profileRoot)})) { throw 'Smoke PID ownership changed; refusing cleanup.' }; Stop-Process -Id ${child.pid} -Force -ErrorAction Stop; try { Wait-Process -Id ${child.pid} -Timeout 2 -ErrorAction Stop } catch {} }; $nativeSmokeRemaining = Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; Write-Output ($null -eq $nativeSmokeRemaining); exit 0`],
    { windowsHide: true, timeout: 5000 }).catch(error => { cleanupDiagnostic = error.message; return { stdout: 'False' }; });
    report.assertionsPassed = report.success;
    report.cleanupConfirmed = absence.trim() === 'True';
    report.testProcessExited = report.cleanupConfirmed;
    report.success = report.assertionsPassed && report.cleanupConfirmed;
    if (!report.cleanupConfirmed) { report.cleanupError = cleanupDiagnostic ?? 'Could not confirm the owned smoke process exited.'; process.exitCode = 1; }
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    report.stdout = output; report.stderr = stderr;
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native command host evidence: ${reportPath}`);
  }
}
main().catch(error => { console.error(`Native command host smoke could not start: ${error.message}`); process.exitCode = 1; });
