import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nativeExecutable, packagedExecutable, packagedRoot, projectRoot, sourceRoot } from './desktop-paths.mjs';

const runFile = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const limitMs = 20000;
const reportPrefix = 'LITTLE_NATIVE_PTY_REPORT ';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function configuration(source) {
  const appRoot = path.join(packagedRoot, 'resources', 'app');
  return {
    source,
    executable: source ? nativeExecutable : packagedExecutable,
    moduleRoots: source ? [path.join(sourceRoot, 'node_modules', 'node-pty')] : [
      path.join(appRoot, 'node_modules.asar', 'node-pty'),
      path.join(appRoot, 'node_modules', 'node-pty'),
    ],
    reportPath: path.join(projectRoot, 'desktop', 'logs', `native-terminal-smoke${source ? '-source' : ''}.json`),
  };
}

function cleanEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (['electron_run_as_node', 'electron_no_asar', 'node_options', 'node_path', 'vscode_dev'].includes(key.toLowerCase())) {
      delete result[key];
    }
  }
  return result;
}

function commandFor(marker) {
  assert.match(marker, /^LITTLE_NATIVE_PTY_OK_[a-f0-9]{16}$/);
  // The marker is generated locally; the script accepts no shell command input.
  return ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', `[Console]::WriteLine('${marker}'); exit 0`];
}

async function checkExecutable(config) {
  assert.equal(process.platform, 'win32', 'This smoke check requires the Windows Little Code build.');
  await access(config.executable);
  const executable = await realpath(config.executable);
  const directory = await realpath(path.dirname(config.executable));
  assert(samePath(executable, path.join(directory, 'Little Code.exe')), 'Executable resolves outside the expected Little Code directory.');
  await access(powershell);
  if (config.source) await access(path.join(config.moduleRoots[0], 'package.json'));
  else {
    const archive = path.join(packagedRoot, 'resources', 'app', 'node_modules.asar');
    if (!existsSync(archive)) await access(path.join(config.moduleRoots[1], 'package.json'));
  }
  return executable;
}

/** This branch runs inside our Electron binary, so native modules use its actual ABI. */
async function runElectronChild(config, marker) {
  const startedAt = Date.now();
  let terminal;
  let subscriptions = [];
  const report = { success: false, marker, source: config.source, startedAt: new Date(startedAt).toISOString() };
  let exitCode = 1;
  try {
    const expected = await checkExecutable(config);
    report.executable = await realpath(process.execPath);
    assert(samePath(report.executable, expected), 'The child is not running the expected Little Code executable.');
    assert(process.versions.electron, 'The terminal test must execute in Electron, not system Node.');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    report.versions = { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, arch: process.arch };
    const require = createRequire(import.meta.url);
    const moduleRoot = config.moduleRoots.find(candidate => existsSync(path.join(candidate, 'package.json')));
    assert(moduleRoot, 'The real Little Code node-pty package is missing.');
    report.nodePtyEntry = require.resolve(moduleRoot);
    report.nodePtyVersion = require(path.join(moduleRoot, 'package.json')).version;
    const pty = require(moduleRoot);
    report.shell = powershell;
    report.shellArguments = commandFor(marker);
    report.output = '';
    report.dataEvents = 0;
    report.exitEvents = 0;
    const ptyStartedAt = Date.now();
    report.ptyStartedAt = new Date(ptyStartedAt).toISOString();
    // Removing ELECTRON_RUN_AS_NODE here limits it to this Electron child.
    terminal = pty.spawn(powershell, report.shellArguments, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: projectRoot,
      env: cleanEnvironment(process.env), useConptyDll: false,
    });
    report.ptyExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native terminal did not exit within 20 seconds.')), Math.max(1, limitMs - (Date.now() - startedAt)));
      const fail = error => { clearTimeout(timer); reject(error); };
      terminal.on('error', fail);
      subscriptions = [
        terminal.onData(data => {
          report.dataEvents++;
          report.output = `${report.output}${data}`.slice(-65536);
        }),
        terminal.onExit(event => {
          clearTimeout(timer);
          terminal.removeListener('error', fail);
          report.exitEvents++;
          resolve(event);
        }),
        { dispose: () => { clearTimeout(timer); terminal.removeListener('error', fail); } },
      ];
    });
    report.ptyPid = terminal.pid;
    report.ptyElapsedMs = Date.now() - ptyStartedAt;
    report.nativeModules = Object.keys(require.cache).filter(filename => /\.node$/i.test(filename));
    report.assertions = {
      ownElectronExecutable: samePath(report.executable, expected),
      nativeConptyLoaded: report.nativeModules.some(filename => /(?:\\|\/)conpty\.node$/i.test(filename)),
      actualDataReceived: report.dataEvents > 0,
      uniqueMarkerReceived: report.output.includes(marker),
      actualExitReceived: report.exitEvents === 1,
      terminalExitZero: report.ptyExit.exitCode === 0,
      withinTwentySeconds: Date.now() - startedAt < limitMs,
    };
    assert(Object.values(report.assertions).every(Boolean), `Native terminal assertions failed: ${JSON.stringify(report.assertions)}`);
    report.success = true;
    exitCode = 0;
  } catch (error) {
    report.error = error.message;
    if (terminal && report.exitEvents !== 1) {
      try { terminal.kill(); } catch { /* The parent's deadline still kills its own process tree. */ }
    }
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAt;
  }
  await new Promise(resolve => process.stdout.write(`${reportPrefix}${JSON.stringify(report)}\n`, resolve));
  // node-pty's drain worker may retain a handle briefly after the real onExit.
  process.exit(exitCode);
}

async function runParent(config) {
  const executable = await checkExecutable(config);
  const marker = `LITTLE_NATIVE_PTY_OK_${randomBytes(8).toString('hex')}`;
  const startedAt = Date.now();
  const env = { ...cleanEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' };
  const child = spawn(executable, [scriptPath, '--pty-child', marker, ...(config.source ? ['--source'] : [])], {
    cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let timer;
  let cancel;
  let report = { success: false, marker, source: config.source, executable, childPid: child.pid, startedAt: new Date(startedAt).toISOString() };
  child.stdout.on('data', data => { stdout = `${stdout}${data}`.slice(-262144); });
  child.stderr.on('data', data => { stderr = `${stderr}${data}`.slice(-65536); });
  child.once('exit', () => { exited = true; });
  try {
    const exit = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Little Code native terminal smoke check exceeded its 20-second deadline.')), limitMs);
      cancel = () => reject(new Error('Native terminal smoke check cancelled.'));
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      child.once('error', reject);
      child.once('close', (code, signal) => { exited = true; clearTimeout(timer); resolve({ code, signal }); });
    });
    report.childExit = exit;
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(reportPrefix));
    assert(line, `Electron did not produce native terminal evidence. ${stderr}`);
    const evidence = JSON.parse(line.slice(reportPrefix.length));
    assert.equal(evidence.marker, marker, 'Terminal evidence marker does not match this run.');
    assert(samePath(evidence.executable, executable), 'Reported Electron path differs from the owned child.');
    assert.equal(evidence.source, config.source);
    report.evidence = evidence;
    assert.equal(exit.code, 0, evidence.error || `Electron child exited with code ${exit.code}.`);
    assert.equal(evidence.success, true, evidence.error || 'The native PTY did not pass.');
    assert(evidence.assertions && Object.values(evidence.assertions).every(value => value === true));
    assert(Date.now() - startedAt < limitMs, 'Native terminal completed after the 20-second deadline.');
    report.success = true;
    console.log(`Native PowerShell PTY verified in ${path.basename(executable)}: marker received, real exit 0, Electron ${evidence.versions.electron}, ABI ${evidence.versions.modules}.`);
  } catch (error) {
    report.error = error.message;
    report.stderr = stderr;
    report.stdout = stdout;
    process.exitCode = 1;
    console.error(`Native terminal smoke check failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
    if (cancel) {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    if (!exited && child.pid) {
      // The only cleanup target is the child created by this test and its descendants.
      await runFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(error => {
        report.cleanupError = error.message;
        process.exitCode = 1;
      });
    }
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAt;
    await mkdir(path.dirname(config.reportPath), { recursive: true });
    await writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native terminal evidence: ${config.reportPath}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/smoke-terminal.mjs [--source] [--dry-run]\nVerifies the real Little Code Electron ABI, packaged node-pty, and one fixed PowerShell marker command.\n--source uses the owned prefetched Electron and upstream node-pty while packaging is in progress.\n--dry-run prints the intended paths without launching any process.');
    return;
  }
  const config = configuration(args.includes('--source'));
  if (args[0] === '--pty-child') {
    assert(args.length === (config.source ? 3 : 2), 'Invalid internal child arguments.');
    commandFor(args[1]);
    await runElectronChild(config, args[1]);
    return;
  }
  assert(args.every(argument => ['--source', '--dry-run'].includes(argument)), 'Unknown smoke check argument.');
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ ...config, shell: powershell, shellArguments: commandFor('LITTLE_NATIVE_PTY_OK_0000000000000000'), deadlineMs: limitMs, launchesProcesses: false }, null, 2));
    return;
  }
  await runParent(config);
}

main().catch(error => { console.error(`Native terminal smoke check could not start: ${error.message}`); process.exitCode = 1; });
