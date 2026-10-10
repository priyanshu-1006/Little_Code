import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LANGUAGE_CATALOG, discoverProjectPython, discoverRuntime, runtimeSearchDirectories, selectLanguage, validateRuntimeExecutable } from '../src/development/languageCatalog';
import { createCustomRunPlan, createMsysInitializationPlan, createRunPlan, describeRunPlan, executeRunSequence, inspectMsysKeyring, observeOwnedProcess, runnerEnvironment, stopOwnedProcess, validateProgramArguments, type OwnedProcessObservation } from '../src/development/languageRunner';

const language = (id: string) => {
  const result = LANGUAGE_CATALOG.find(item => item.id === id);
  assert.ok(result);
  return result;
};

test('file extension selects the correct runner while framework JSX is refused', () => {
  assert.equal(selectLanguage('plaintext', '/tmp/app.py')?.id, 'python');
  assert.equal(selectLanguage('javascript', '/tmp/app.cpp')?.id, 'cpp');
  assert.equal(selectLanguage('typescriptreact', '/tmp/app.tsx'), undefined);
  assert.equal(selectLanguage('javascriptreact', '/tmp/app.jsx'), undefined);
  assert.equal(selectLanguage('json', '/tmp/package.json'), undefined);
});

test('compile commands keep paths and arguments as literal argv and outputs private', () => {
  const file = 'C:\\work space\\strange & $(whoami); name.cpp';
  const directory = 'C:\\private storage\\run-abcd';
  const plan = createRunPlan(language('cpp'), file, 'C:\\msys64\\ucrt64\\bin\\g++.exe', directory, ['hello & goodbye', '--thing=$(bad)', 'space value'], 'win32');
  assert.deepEqual(plan.steps[0]?.args, ['-std=c++17', '-Wall', '-Wextra', file, '-o', 'C:\\private storage\\run-abcd\\program.exe']);
  assert.equal(plan.steps[1]?.executable, 'C:\\private storage\\run-abcd\\program.exe');
  assert.deepEqual(plan.steps[1]?.args, ['hello & goodbye', '--thing=$(bad)', 'space value']);
  assert.equal(plan.cwd, 'C:\\work space');
  assert.match(describeRunPlan(plan), /does not sandbox source code/u);
});

test('compiler failure prevents a stale or partially generated binary from running', async () => {
  const plan = createRunPlan(language('c'), '/tmp/main.c', '/usr/bin/gcc', '/private/run-abcd', [], 'linux');
  const attempted: string[] = [];
  const result = await executeRunSequence(plan, async command => { attempted.push(command.label); return 2; });
  assert.deepEqual(attempted, ['Compile C']);
  assert.deepEqual(result, { exitCode: 2, completedSteps: 1 });
});

test('compile success runs once and propagates the program exit code', async () => {
  const plan = createRunPlan(language('rust'), '/tmp/bad-name.rs', '/usr/bin/rustc', '/private/run-abcd', [], 'linux');
  const attempted: string[] = [];
  const result = await executeRunSequence(plan, async command => { attempted.push(command.label); return attempted.length === 1 ? 0 : 7; });
  assert.deepEqual(attempted, ['Compile Rust', 'Run compiled program']);
  assert.deepEqual(result, { exitCode: 7, completedSteps: 2 });
  assert.deepEqual(plan.steps[0]?.args.slice(0, 2), ['--crate-name', 'little_file']);
});

test('cancellation between compiler and launch prevents program execution', async () => {
  const plan = createRunPlan(language('cpp'), '/tmp/main.cpp', '/usr/bin/g++', '/private/run-abcd', [], 'linux');
  let cancelled = false;
  let calls = 0;
  const result = await executeRunSequence(plan, async () => { calls++; cancelled = true; return 0; }, () => cancelled);
  assert.equal(calls, 1);
  assert.deepEqual(result, { exitCode: 130, completedSteps: 1 });
});

test('launch errors prevent later steps and produce a failure', async () => {
  const plan = createRunPlan(language('cpp'), '/tmp/main.cpp', '/usr/bin/g++', '/private/run-abcd', [], 'linux');
  const result = await executeRunSequence(plan, async () => { throw new Error('missing compiler'); });
  assert.deepEqual(result, { exitCode: 1, completedSteps: 0 });
});

test('Python launcher and interpreter variants receive correct flags', () => {
  const python = createRunPlan(language('python'), 'C:\\work\\app.py', 'C:\\tools\\python.exe', 'C:\\private\\run', ['--name'], 'win32');
  const launcher = createRunPlan(language('python'), 'C:\\work\\app.py', 'C:\\Windows\\py.exe', 'C:\\private\\run', [], 'win32');
  assert.deepEqual(python.steps[0]?.args, ['-u', 'C:\\work\\app.py', '--name']);
  assert.deepEqual(launcher.steps[0]?.args, ['-3', '-u', 'C:\\work\\app.py']);
  assert.equal(python.env.PYTHONDONTWRITEBYTECODE, '1');
});

test('MinGW runtime DLL directory is propagated with one Windows PATH key', () => {
  const plan = createRunPlan(language('cpp'), 'C:\\source\\main.cpp', 'C:\\msys64\\ucrt64\\bin\\g++.exe', 'C:\\private\\run', [], 'win32');
  const environment = runnerEnvironment(plan, { Path: 'C:\\Windows;C:\\tools', EMPTY: undefined, KEEP: 'value' }, 'win32');
  assert.equal(environment.PATH, 'C:\\msys64\\ucrt64\\bin;C:\\Windows;C:\\tools');
  assert.equal(environment.Path, undefined);
  assert.equal(environment.EMPTY, undefined);
  assert.equal(environment.KEEP, 'value');
});

test('C# uses explicit file mode and private SDK artifacts', () => {
  const plan = createRunPlan(language('csharp'), '/tmp/app.cs', '/usr/bin/dotnet', '/private/run', ['argument'], 'linux');
  assert.deepEqual(plan.steps[0]?.args, ['run', '--file', '/tmp/app.cs', '--artifacts-path', '/private/run', '--no-launch-profile', '--disable-build-servers', '--', 'argument']);
  assert.match(plan.note ?? '', /\.NET 10/u);
});

test('Go compiles to private output before running and uses a private build cache', () => {
  const plan = createRunPlan(language('go'), '/tmp/main.go', '/usr/bin/go', '/private/run', [], 'linux');
  assert.deepEqual(plan.steps[0]?.args, ['build', '-o', '/private/run/program', '/tmp/main.go']);
  assert.equal(plan.steps[1]?.executable, '/private/run/program');
  assert.equal(plan.env.GOCACHE, '/private/run/go-cache');
});

test('Windows discovers UCRT64 MinGW even when it has not been added to PATH', async () => {
  const checked: string[] = [];
  const discovered = await discoverRuntime(language('cpp'), {
    platform: 'win32', env: { PATH: 'C:\\tools;.;', SystemDrive: 'C:' },
    exists: async file => { checked.push(file); return file === 'C:\\msys64\\ucrt64\\bin\\g++.exe'; },
  });
  assert.equal(discovered, 'C:\\msys64\\ucrt64\\bin\\g++.exe');
  assert.ok(checked.every(file => path.win32.isAbsolute(file)));
  assert.ok(checked.every(file => file.endsWith('.exe')));
});

test('C/C++ discovery falls back to Clang and excludes relative PATH entries', async () => {
  const discovered = await discoverRuntime(language('c'), {
    platform: 'linux', env: { PATH: ':.:relative:/opt/bin' },
    exists: async file => file === '/opt/bin/clang',
  });
  assert.equal(discovered, '/opt/bin/clang');
  assert.deepEqual(runtimeSearchDirectories({ platform: 'linux', env: { PATH: ':.:relative:/usr/bin:/usr/bin' } }), ['/usr/bin']);
});

test('absolute runtime overrides win and invalid or missing overrides fail clearly', async () => {
  const runtime = await discoverRuntime(language('python'), { platform: 'linux', env: { PATH: '/usr/bin' }, overrides: { python: '/venv/bin/python' }, exists: async file => file === '/venv/bin/python' });
  assert.equal(runtime, '/venv/bin/python');
  await assert.rejects(discoverRuntime(language('python'), { platform: 'linux', overrides: { python: './python' } }), /absolute/u);
  await assert.rejects(discoverRuntime(language('python'), { platform: 'linux', overrides: { python: '/missing/python' }, exists: async () => false }), /missing/u);
  assert.throws(() => validateRuntimeExecutable('C:\\tools\\python.cmd', 'win32'), /native \.exe/u);
  assert.throws(() => validateRuntimeExecutable('/usr/bin/python\nother', 'linux'), /control characters/u);
});

test('custom interpreters substitute paths in argv without a shell command', () => {
  const file = '/tmp/source & $(unsafe).custom';
  const plan = createCustomRunPlan('custom', { executable: '/opt/runtime', args: ['--source', '${file}', '--directory', '${dir}'] }, file, '/private/run', ['arg; value'], 'linux');
  assert.deepEqual(plan.steps[0]?.args, ['--source', file, '--directory', '/tmp', 'arg; value']);
  assert.throws(() => createCustomRunPlan('custom', { executable: '/opt/runtime', args: ['-c', 'something'] }, file, '/private/run', [], 'linux'), /include \$\{file\}/u);
  assert.throws(() => createCustomRunPlan('custom', { executable: '/bin/bash', args: ['-c', '${file}'] }, file, '/private/run', [], 'linux'), /shell command strings/u);
  assert.throws(() => createCustomRunPlan('custom', { executable: '/opt/runtime', args: ['--source=${file}'] }, file, '/private/run', [], 'linux'), /whole argument/u);
  assert.throws(() => validateProgramArguments(['bad\0value']), /NUL/u);
  assert.throws(() => validateProgramArguments('one command string'), /array/u);
  assert.throws(() => createRunPlan(language('kotlin'), '/tmp/Main.kt', '/usr/bin/kotlinc', '/private/run', [], 'linux'), /\.kts/u);
});

test('every built-in language has a real documented runner plan', () => {
  for (const definition of LANGUAGE_CATALOG) {
    const extension = definition.extensions[0];
    assert.ok(extension);
    const plan = createRunPlan(definition, `/owned/fixture${extension}`, `/runtimes/${definition.candidates[0]}`, '/private/run', [], 'linux');
    assert.ok(plan.steps.length >= 1);
    assert.ok(plan.steps.every(command => path.posix.isAbsolute(command.executable)));
    assert.match(definition.documentation, /^https:\/\//u);
  }
});

test('MSYS2 initialization argv contains only the installed login shell and fixed true command', () => {
  const plan = createMsysInitializationPlan('C:\\msys64\\usr\\bin\\bash.exe');
  assert.equal(plan.cwd, 'C:\\msys64');
  assert.deepEqual(plan.steps, [{ label: 'Initialize MSYS2 using its installed login scripts', executable: 'C:\\msys64\\usr\\bin\\bash.exe', args: ['--login', '-c', 'true'] }]);
  assert.equal(plan.env.MSYSTEM, 'UCRT64');
  assert.throws(() => createMsysInitializationPlan('C:\\arbitrary\\bash.exe'), /installed usr\/bin/u);
});

test('MSYS2 first-run inspection distinguishes missing, incomplete and present keyring files', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'little-msys-keyring-test-'));
  try {
    assert.equal(await inspectMsysKeyring(temporary), 'uninitialized');
    const directory = path.join(temporary, 'etc', 'pacman.d', 'gnupg');
    await mkdir(directory, { recursive: true });
    assert.equal(await inspectMsysKeyring(temporary), 'incomplete');
    await writeFile(path.join(directory, 'pubring.gpg'), 'owned fixture, not real keys');
    await writeFile(path.join(directory, 'trustdb.gpg'), '');
    assert.equal(await inspectMsysKeyring(temporary), 'incomplete');
    await writeFile(path.join(directory, 'trustdb.gpg'), 'owned fixture, not a trust database');
    assert.equal(await inspectMsysKeyring(temporary), 'files-present');
    await rm(path.join(directory, 'pubring.gpg'));
    await writeFile(path.join(directory, 'pubring.kbx'), 'owned fixture alternative keybox');
    assert.equal(await inspectMsysKeyring(temporary), 'files-present');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('Python discovery prefers the nearest project venv and never escapes its workspace', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'little-project-python-test-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    const directory = path.join(workspace, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(workspace, '.venv', 'pyvenv.cfg'), 'home = owned fixture\n');
    const executable = path.join(directory, process.platform === 'win32' ? 'python.exe' : 'python');
    await writeFile(executable, 'owned discovery fixture, never executed');
    if (process.platform !== 'win32') await chmod(executable, 0o700);
    assert.equal(await discoverProjectPython(path.join(workspace, 'src', 'app.py'), workspace), executable);
    assert.equal(await discoverProjectPython(path.join(temporary, 'outside', 'app.py'), workspace), undefined);
    await rm(path.join(workspace, '.venv', 'pyvenv.cfg'));
    assert.equal(await discoverProjectPython(path.join(workspace, 'src', 'app.py'), workspace), undefined);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('POSIX virtual environment executable symlinks retain their logical venv location', { skip: process.platform === 'win32' }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'little-python-symlink-test-'));
  try {
    const environment = path.join(temporary, '.venv');
    await mkdir(path.join(environment, 'bin'), { recursive: true });
    await writeFile(path.join(environment, 'pyvenv.cfg'), 'home = owned fixture\n');
    const target = path.join(temporary, 'system-python-fixture');
    await writeFile(target, 'owned fixture, never executed'); await chmod(target, 0o700);
    const executable = path.join(environment, 'bin', 'python');
    await symlink(target, executable);
    assert.equal(await discoverProjectPython(path.join(temporary, 'app.py'), temporary), executable);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('owned JavaScript fixture proves metacharacters and spaces are literal argv', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'little-language-runner-test-'));
  try {
    const sourceDirectory = path.join(temporary, 'folder & space');
    await mkdir(sourceDirectory);
    const file = path.join(sourceDirectory, 'source; name.js');
    const report = path.join(temporary, 'result.json');
    await writeFile(file, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n');
    const expected = ['$(whoami)', 'hello & goodbye', 'a; b', '`value`', '--strange=value'];
    const plan = createRunPlan(language('javascript'), file, process.execPath, path.join(temporary, 'private'), [report, ...expected]);
    const result = await executeRunSequence(plan, command => new Promise<number>((resolve, reject) => {
      const child = spawn(command.executable, command.args, { cwd: plan.cwd, shell: false, windowsHide: true });
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    }));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), expected);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('POSIX stop escalates from TERM to KILL and requires an observed child close', async () => {
  const signals: string[] = []; const waits: number[] = []; let closed = false;
  const observation: OwnedProcessObservation = { pid: 43210, isClosed: () => closed, hasExited: () => false, async waitForClose(timeout) { waits.push(timeout); if (waits.length === 2) closed = true; return closed; } };
  const result = await stopOwnedProcess(observation, { platform: 'linux', termGraceMs: 100, killGraceMs: 300, signalPosixGroup: (pid, signal) => { assert.equal(pid, 43210); signals.push(signal); } });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(waits, [100, 300]);
  assert.deepEqual(result, { closed: true, treeStopped: true });
});

test('Windows taskkill failure and a missing child close retain an unconfirmed cleanup result', async () => {
  const observation: OwnedProcessObservation = { pid: 43210, isClosed: () => false, hasExited: () => false, async waitForClose() { return false; } };
  let killed: number | undefined;
  const rejected = await stopOwnedProcess(observation, { platform: 'win32', killGraceMs: 100, killWindowsTree: async pid => { killed = pid; throw new Error('Access denied fixture'); } });
  assert.equal(killed, 43210); assert.equal(rejected.closed, false); assert.equal(rejected.treeStopped, false); assert.match(rejected.message!, /Access denied fixture/);
  const noClose = await stopOwnedProcess(observation, { platform: 'win32', killGraceMs: 100, killWindowsTree: async () => {} });
  assert.equal(noClose.closed, false); assert.equal(noClose.treeStopped, false); assert.match(noClose.message!, /No child close event/);
});

test('a close observed after Windows termination failure still reports its unconfirmed tree', async () => {
  const observation: OwnedProcessObservation = { pid: 43210, isClosed: () => false, hasExited: () => false, async waitForClose() { return true; } };
  const result = await stopOwnedProcess(observation, { platform: 'win32', killWindowsTree: async () => { throw new Error('Nonzero taskkill fixture'); } });
  assert.equal(result.closed, true); assert.equal(result.treeStopped, false); assert.match(result.message!, /Nonzero taskkill fixture/);
});

test('already closed or exited children are never targeted by a potentially reused PID', async () => {
  let calls = 0;
  const closed: OwnedProcessObservation = { pid: 43210, isClosed: () => true, hasExited: () => true, async waitForClose() { return true; } };
  assert.deepEqual(await stopOwnedProcess(closed, { platform: 'win32', killWindowsTree: async () => { calls++; } }), { closed: true, treeStopped: true });
  const exited: OwnedProcessObservation = { pid: 43210, isClosed: () => false, hasExited: () => true, async waitForClose() { return false; } };
  const result = await stopOwnedProcess(exited, { platform: 'win32', killWindowsTree: async () => { calls++; } });
  assert.equal(result.closed, false); assert.equal(result.treeStopped, false); assert.equal(calls, 0);
});

test('failed POSIX force termination cannot claim the runtime closed', async () => {
  const observation: OwnedProcessObservation = { pid: 43210, isClosed: () => false, hasExited: () => false, async waitForClose() { return false; } };
  const signals: string[] = [];
  const result = await stopOwnedProcess(observation, { platform: 'linux', signalPosixGroup: (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') throw new Error('Force termination denied fixture'); } });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(result.closed, false); assert.equal(result.treeStopped, false); assert.match(result.message!, /Force termination denied fixture/);
});

test('an actual owned Node process is stopped and observed closed', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("OWNED_READY\\n"); setInterval(()=>{}, 1000);'], { detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const observation = observeOwnedProcess(child);
  t.after(async () => { if (!observation.isClosed()) { const result = await stopOwnedProcess(observation, { termGraceMs: 50, killGraceMs: 2000 }); assert.equal(result.closed, true, result.message); } });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
  assert.equal(observation.isClosed(), false);
  const result = await stopOwnedProcess(observation, { termGraceMs: 100, killGraceMs: 3000 });
  assert.deepEqual(result, { closed: true, treeStopped: true }); assert.equal(observation.isClosed(), true);
});

test('a POSIX program ignoring TERM is force-stopped without leaving its owned process running', { skip: process.platform === 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("IGNORING_TERM\\n"); setInterval(()=>{}, 1000);'], { detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const observation = observeOwnedProcess(child);
  t.after(async () => { if (!observation.isClosed()) { const result = await stopOwnedProcess(observation, { termGraceMs: 50, killGraceMs: 2000 }); assert.equal(result.closed, true, result.message); } });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
  const result = await stopOwnedProcess(observation, { termGraceMs: 50, killGraceMs: 2000 });
  assert.deepEqual(result, { closed: true, treeStopped: true }); assert.equal(child.signalCode, 'SIGKILL');
});
