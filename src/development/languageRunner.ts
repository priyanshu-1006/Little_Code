import type * as vscode from 'vscode';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { LANGUAGE_CATALOG, discoverProjectPython, discoverRuntime, runtimeSearchDirectories, selectLanguage, validateRuntimeExecutable, type LanguageDefinition } from './languageCatalog';

export interface RunnerCommand { label: string; executable: string; args: string[] }
export interface RunPlan {
  label: string;
  file: string;
  cwd: string;
  buildDirectory: string;
  steps: RunnerCommand[];
  env: Record<string, string>;
  note?: string;
}
export interface CustomRuntime { executable: string; args: string[] }

export interface OwnedProcessObservation {
  readonly pid: number | undefined;
  isClosed(): boolean;
  hasExited(): boolean;
  waitForClose(timeoutMs: number): Promise<boolean>;
}
export interface OwnedProcessStopResult { closed: boolean; treeStopped: boolean; message?: string }
export interface OwnedProcessStopOptions {
  platform?: NodeJS.Platform;
  termGraceMs?: number;
  killGraceMs?: number;
  killWindowsTree?: (pid: number) => Promise<void>;
  signalPosixGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
}

/** Child exit and child close differ when descendants still hold its stdio open. */
export function observeOwnedProcess(child: ChildProcessWithoutNullStreams): OwnedProcessObservation {
  let closed = false;
  const completion = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  return Object.freeze({ pid: child.pid, isClosed: () => closed, hasExited: () => child.exitCode !== null || child.signalCode !== null,
    waitForClose(timeoutMs: number): Promise<boolean> {
      if (closed) return Promise.resolve(true);
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        void completion.then(() => { clearTimeout(timer); resolve(true); });
      });
    },
  });
}

/** Targets only a still-owned live child/group; success requires its actual close event. */
export async function stopOwnedProcess(observation: OwnedProcessObservation, options: OwnedProcessStopOptions = {}): Promise<OwnedProcessStopResult> {
  const platform = options.platform ?? process.platform;
  const termGrace = options.termGraceMs ?? 1200, killGrace = options.killGraceMs ?? 5000;
  if (observation.isClosed()) return { closed: true, treeStopped: true };
  // Never submit a PID that belongs to an already-exited process: it may have been reused.
  if (observation.hasExited() || !observation.pid) {
    const closed = await observation.waitForClose(killGrace);
    return closed ? { closed, treeStopped: true } : { closed: false, treeStopped: false, message: 'The runtime exited or failed to start, but its streams did not close. Descendants may still be running; inspect the task processes.' };
  }
  const pid = observation.pid;
  if (platform === 'win32') {
    let failure: string | undefined;
    try {
      if (options.killWindowsTree) await options.killWindowsTree(pid);
      else await new Promise<void>((resolve, reject) => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, timeout: killGrace }, error => error ? reject(error) : resolve()));
    } catch (error) { failure = errorMessage(error); }
    const closed = await observation.waitForClose(killGrace);
    if (!closed || failure) return { closed, treeStopped: false, message: `Could not confirm the owned runtime tree stopped (PID ${pid}).${failure ? ` Windows termination failed: ${failure}` : ' No child close event was observed.'} Inspect its processes before retrying the run.` };
    return { closed: true, treeStopped: true };
  }
  const signalGroup = options.signalPosixGroup ?? ((pid: number, signal: 'SIGTERM' | 'SIGKILL') => { process.kill(-pid, signal); });
  let failure: string | undefined;
  try { signalGroup(pid, 'SIGTERM'); } catch (error) { failure = errorMessage(error); }
  if (await observation.waitForClose(termGrace)) return { closed: true, treeStopped: !failure, ...(failure ? { message: `The runtime closed, but its process-group termination could not be confirmed: ${failure}` } : {}) };
  if (!observation.isClosed() && !observation.hasExited()) {
    try { signalGroup(pid, 'SIGKILL'); failure = undefined; } catch (error) { failure = errorMessage(error); }
  }
  const closed = await observation.waitForClose(killGrace);
  if (!closed || failure) return { closed, treeStopped: false, message: `Could not confirm the owned runtime group stopped (PID ${pid}).${failure ? ` Termination failed: ${failure}` : ' No child close event was observed.'} Inspect its processes before retrying the run.` };
  return { closed: true, treeStopped: true };
}

export type MsysKeyringStatus = 'files-present' | 'uninitialized' | 'incomplete';
export async function inspectMsysKeyring(installationRoot: string): Promise<MsysKeyringStatus> {
  const directory = path.join(installationRoot, 'etc', 'pacman.d', 'gnupg');
  let metadata;
  try { metadata = await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'uninitialized'; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return 'incomplete';
  const nonemptyFile = async (name: string) => {
    try { const file = await lstat(path.join(directory, name)); return file.isFile() && !file.isSymbolicLink() && file.size > 0; }
    catch { return false; }
  };
  const ring = await nonemptyFile('pubring.gpg') || await nonemptyFile('pubring.kbx');
  return ring && await nonemptyFile('trustdb.gpg') ? 'files-present' : 'incomplete';
}

export function createMsysInitializationPlan(bash: string): RunPlan {
  validateRuntimeExecutable(bash, 'win32');
  const installationRoot = path.win32.dirname(path.win32.dirname(path.win32.dirname(bash)));
  if (path.win32.basename(bash).toLowerCase() !== 'bash.exe' || path.win32.basename(path.win32.dirname(bash)).toLowerCase() !== 'bin' || path.win32.basename(path.win32.dirname(path.win32.dirname(bash))).toLowerCase() !== 'usr') throw new Error('MSYS2 initialization needs its installed usr/bin/bash.exe.');
  return { label: 'MSYS2 first-login initialization', file: bash, cwd: installationRoot, buildDirectory: '', env: { MSYSTEM: 'UCRT64', CHERE_INVOKING: '1' }, steps: [{ label: 'Initialize MSYS2 using its installed login scripts', executable: bash, args: ['--login', '-c', 'true'] }], note: 'This separately reviewed login starts the installed MSYS2 profile/post-install scripts, including first-run package-signing key initialization. It may write MSYS2/user configuration and contact key servers. The command is the fixed literal true; no file name or project text is interpolated. It does not install GCC. Existing login/profile scripts also run.' };
}

export function validateProgramArguments(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(argument => typeof argument !== 'string' || argument.length > 8192 || argument.includes('\0'))) {
    throw new Error('Runner arguments must be an array of at most 100 strings without NUL characters (maximum 8192 characters each).');
  }
  return [...value] as string[];
}

function validateFilePath(file: string, platform: NodeJS.Platform): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(file) || /[\0\r\n]/u.test(file)) throw new Error('Run a saved file with an absolute path without control characters.');
}

export function createRunPlan(language: LanguageDefinition, file: string, executable: string, buildDirectory: string, programArguments: string[] = [], platform: NodeJS.Platform = process.platform): RunPlan {
  validateFilePath(file, platform);
  validateFilePath(buildDirectory, platform);
  validateRuntimeExecutable(executable, platform);
  const args = validateProgramArguments(programArguments);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const binary = paths.join(buildDirectory, platform === 'win32' ? 'program.exe' : 'program');
  const command = (label: string, arguments_: string[]): RunnerCommand => ({ label, executable, args: arguments_ });
  const runBinary = { label: 'Run compiled program', executable: binary, args };
  const env: Record<string, string> = {};
  let steps: RunnerCommand[];
  switch (language.kind) {
    case 'c': steps = [command('Compile C', ['-std=c17', '-Wall', '-Wextra', file, '-o', binary]), runBinary]; break;
    case 'cpp': steps = [command('Compile C++', ['-std=c++17', '-Wall', '-Wextra', file, '-o', binary]), runBinary]; break;
    case 'rust': steps = [command('Compile Rust', ['--crate-name', 'little_file', file, '-o', binary]), runBinary]; break;
    case 'swift': steps = [command('Compile Swift', ['-module-name', 'LittleFile', file, '-o', binary]), runBinary]; break;
    case 'kotlin':
      if (paths.extname(file).toLowerCase() !== '.kts') throw new Error('The single-file Kotlin runner supports .kts scripts. Use a Gradle/project task for .kt applications.');
      steps = [command('Run Kotlin script', ['-script', file, '--', ...args])]; break;
    default:
      switch (language.id) {
        case 'javascript': case 'typescript': steps = [command('Run with Node.js', ['--', file, ...args])]; break;
        case 'python':
          env.PYTHONUNBUFFERED = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
          steps = [command('Run Python', [...(/^py(?:\.exe)?$/iu.test(paths.basename(executable)) ? ['-3'] : []), '-u', file, ...args])]; break;
        case 'csharp': steps = [command('Build and run C# (.NET 10+)', ['run', '--file', file, '--artifacts-path', buildDirectory, '--no-launch-profile', '--disable-build-servers', '--', ...args])]; break;
        case 'go':
          env.GOCACHE = paths.join(buildDirectory, 'go-cache');
          steps = [command('Compile Go', ['build', '-o', binary, file]), runBinary]; break;
        case 'dart': steps = [command('Run Dart', ['run', file, ...args])]; break;
        case 'php': steps = [command('Run PHP', ['-f', file, '--', ...args])]; break;
        case 'powershell': steps = [command('Run PowerShell file', ['-NoLogo', '-NoProfile', '-File', file, ...args])]; break;
        case 'r': steps = [command('Run R script', ['--vanilla', file, ...args])]; break;
        default: steps = [command(`Run ${language.label}`, [file, ...args])];
      }
  }
  return { label: language.label, file, cwd: paths.dirname(file), buildDirectory, steps, env, note: language.note };
}

export function createCustomRunPlan(languageId: string, runtime: unknown, file: string, buildDirectory: string, programArguments: string[] = [], platform: NodeJS.Platform = process.platform): RunPlan {
  if (!runtime || typeof runtime !== 'object' || !('executable' in runtime) || typeof runtime.executable !== 'string' || !('args' in runtime)) {
    throw new Error('Custom runtime needs an absolute executable path and an args array using ${file}.');
  }
  validateRuntimeExecutable(runtime.executable, platform);
  validateFilePath(file, platform); validateFilePath(buildDirectory, platform);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const templates = validateProgramArguments(runtime.args);
  if (!templates.includes('${file}') || templates.some(argument => /\$\{(?:file|dir)\}/u.test(argument) && argument !== '${file}' && argument !== '${dir}')) throw new Error('Custom runtime args must include ${file} as a whole argument; paths cannot be embedded in command strings.');
  const runtimeName = paths.basename(runtime.executable).replace(/\.exe$/iu, '').toLowerCase();
  if (runtimeName === 'cmd' || (['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell'].includes(runtimeName) && templates.some(argument => /^(?:-c|-command|-encodedcommand|\/c|\/k)$/iu.test(argument)))) throw new Error('Custom runtimes execute source files, not shell command strings. Pass the file to an interpreter’s file mode.');
  const args = templates.map(argument => argument.replaceAll('${file}', file).replaceAll('${dir}', paths.dirname(file)));
  return { label: `${languageId} (custom)`, file, cwd: paths.dirname(file), buildDirectory, steps: [{ label: 'Run configured interpreter', executable: runtime.executable, args: [...args, ...validateProgramArguments(programArguments)] }], env: {} };
}

export interface SequenceResult { exitCode: number; completedSteps: number }
/** No later step is attempted after a compilation error, cancellation, or launch failure. */
export async function executeRunSequence(plan: RunPlan, execute: (command: RunnerCommand) => Promise<number>, cancelled: () => boolean = () => false): Promise<SequenceResult> {
  let completedSteps = 0;
  for (const command of plan.steps) {
    if (cancelled()) return { exitCode: 130, completedSteps };
    let exitCode: number;
    try { exitCode = await execute(command); } catch { return { exitCode: 1, completedSteps }; }
    completedSteps++;
    if (exitCode !== 0) return { exitCode, completedSteps };
  }
  return { exitCode: cancelled() ? 130 : 0, completedSteps };
}

/** Display only: this representation is never submitted to a shell. */
export function describeRunPlan(plan: RunPlan): string {
  return [`Working directory: ${plan.cwd}`, ...plan.steps.map(command => `${command.label}:\n  ${JSON.stringify(command.executable)} ${command.args.map(argument => JSON.stringify(argument)).join(' ')}`), plan.note ?? '', 'Your program and imported code run with your user permissions and can access files/network. Little Code does not sandbox source code.'].filter(Boolean).join('\n\n');
}

export function runnerEnvironment(plan: RunPlan, inherited: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), ...plan.env };
  const pathValue = inherited.PATH ?? inherited.Path ?? inherited.path ?? '';
  // Windows environment keys are case-insensitive. Remove duplicate PATH keys
  // before inserting the compiler location used by native MinGW DLL loading.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  env.PATH = `${paths.dirname(plan.steps[0]?.executable ?? plan.file)}${platform === 'win32' ? ';' : ':'}${pathValue}`;
  return env;
}

async function sourceIdentity(file: string): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024) throw new Error('Run a regular source file smaller than 32 MiB. Symbolic-link files are not run.');
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function registerLanguageRunner(context: vscode.ExtensionContext): vscode.Disposable {
  // Runtime import keeps the planning/discovery API testable outside the extension host.
  const api = createRequire(path.join(context.extensionPath, 'package.json'))('vscode') as typeof import('vscode');
  const disposables: vscode.Disposable[] = [];
  const running = new Set<vscode.TaskExecution>();
  interface TrackedRuntime { child: ChildProcessWithoutNullStreams; observation: OwnedProcessObservation; stopAttempt?: Promise<OwnedProcessStopResult>; lastStop?: OwnedProcessStopResult }
  const terminalProcesses = new Map<ChildProcessWithoutNullStreams, TrackedRuntime>();
  const log = api.window.createOutputChannel('Little Code Runtimes');
  let runnerDisposed = false;
  const stopProcess = (tracked: TrackedRuntime): Promise<OwnedProcessStopResult> => {
    if (tracked.stopAttempt) return tracked.stopAttempt;
    if (tracked.observation.isClosed() && tracked.lastStop?.treeStopped === false) return Promise.resolve({ ...tracked.lastStop, closed: true });
    const attempt = (async () => {
      const result = await stopOwnedProcess(tracked.observation);
      tracked.lastStop = result;
      if (!result.closed || !result.treeStopped) {
        const message = result.message ?? `Could not confirm runtime cleanup (PID ${tracked.observation.pid ?? 'unavailable'}).`;
        log.appendLine(message);
        if (!runnerDisposed) void api.window.showErrorMessage(message, ...(!tracked.observation.isClosed() ? ['Retry cleanup'] : []), 'Show runtime output').then(action => {
          if (action === 'Retry cleanup' && !tracked.observation.isClosed()) void stopProcess(tracked).catch(error => log.appendLine(`Runtime cleanup failed: ${errorMessage(error)}`));
          else if (action === 'Show runtime output') log.show(true);
        }, () => {});
      }
      return result;
    })();
    tracked.stopAttempt = attempt;
    // A failed stop may be retried while the original child remains owned.
    void attempt.finally(() => { if (tracked.stopAttempt === attempt) tracked.stopAttempt = undefined; }).catch(() => {});
    return attempt;
  };
  disposables.push({ dispose: () => {
    runnerDisposed = true;
    for (const execution of running) execution.terminate();
    void Promise.all([...terminalProcesses.values()].map(tracked => stopProcess(tracked))).then(results => {
      if (results.every(result => result.closed && result.treeStopped)) log.dispose();
      else log.appendLine('Runner shutdown could not confirm all owned process trees stopped. Retained process identities and build files need inspection.');
    }, error => log.appendLine(`Runner shutdown failed: ${errorMessage(error)}`));
  } });

  const configuration = (uri?: vscode.Uri) => api.workspace.getConfiguration('little.runner', uri);
  // Explicitly read application/user values. A project cannot redirect a runtime
  // through an out-of-scope value in .vscode/settings.json.
  const setting = <T>(key: string, fallback: T, uri?: vscode.Uri): T => configuration(uri).inspect<T>(key)?.globalValue ?? fallback;
  const runtimeOptions = (uri?: vscode.Uri) => ({ overrides: setting<Record<string, string>>('runtimePaths', {}, uri) });

  function terminalFor(plan: RunPlan, verify?: () => Promise<void>, cleanup?: () => Promise<void>): vscode.Pseudoterminal {
    const write = new api.EventEmitter<string>();
    const close = new api.EventEmitter<number>();
    let child: ChildProcessWithoutNullStreams | undefined;
    let cancelled = false;
    let disposed = false;
    let cleaning: Promise<void> | undefined;
    let inputLine = '';
    const owned: TrackedRuntime[] = [];
    const stop = () => {
      cancelled = true;
      const tracked = child && terminalProcesses.get(child);
      if (tracked) void stopProcess(tracked).catch(error => log.appendLine(`Runtime cleanup failed: ${errorMessage(error)}`));
    };
    const clean = (): Promise<void> => {
      cleaning ??= (async () => {
        for (const tracked of owned) if (tracked.stopAttempt) await tracked.stopAttempt;
        if (owned.some(tracked => !tracked.observation.isClosed() || tracked.lastStop?.treeStopped === false)) {
          log.appendLine(`Build files retained until runtime cleanup is verified: ${plan.buildDirectory}`);
          return;
        }
        await cleanup?.();
      })();
      return cleaning;
    };
    const print = (text: string) => { if (!disposed) write.fire(text.replace(/\r?\n/gu, '\r\n')); };
    const execute = (command: RunnerCommand): Promise<number> => new Promise(resolve => {
      print(`\n${command.label}\n${JSON.stringify(command.executable)} ${command.args.map(argument => JSON.stringify(argument)).join(' ')}\n\n`);
      let finished = false;
      const finish = (code: number) => { if (finished) return; finished = true; child = undefined; resolve(code); };
      // Prepend the real compiler directory so MinGW executables can load their runtime DLLs.
      const env = runnerEnvironment(plan);
      try {
        child = spawn(command.executable, command.args, { cwd: plan.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        const current = child;
        const tracked: TrackedRuntime = { child: current, observation: observeOwnedProcess(current) };
        owned.push(tracked); terminalProcesses.set(current, tracked);
        let launchFailed = false;
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => print(String(data)));
        child.stderr.on('data', data => print(String(data)));
        child.stdin.on('error', error => print(`\nProgram input closed: ${error.message}\n`));
        child.once('error', error => { launchFailed = true; print(`\nCould not launch runtime: ${error.message}\n`); });
        child.once('close', (code, signal) => { terminalProcesses.delete(current); finish(cancelled || signal ? 130 : launchFailed ? 1 : code ?? 1); });
      } catch (error) { print(`${errorMessage(error)}\n`); finish(1); }
    });
    return {
      onDidWrite: write.event, onDidClose: close.event,
      open: () => { void (async () => {
        try {
          await verify?.();
          if (cancelled) { close.fire(130); return; }
          print(`Little Code · ${plan.label}\nLine input is forwarded on Enter. Ctrl+C or Tasks: Terminate stops this task. Full-screen terminal applications need a normal project terminal.\n${plan.note ? `${plan.note}\n` : ''}`);
          const result = await executeRunSequence(plan, execute, () => cancelled);
          print(`\n${result.exitCode === 0 ? 'Completed' : cancelled ? 'Stopped' : 'Stopped after a failed step'} · exit ${result.exitCode}\n`);
          close.fire(result.exitCode);
        } catch (error) { print(`\n${errorMessage(error)}\n`); close.fire(1); }
        finally { await clean(); }
      })().catch(error => log.appendLine(`Runner task cleanup failed; build files were retained: ${errorMessage(error)}`)); },
      handleInput: input => {
        if (input.includes('\x03')) { stop(); print('\nStopping…\n'); return; }
        if (!child?.stdin.writable) return;
        if (input.includes('\x04')) { child.stdin.end(); return; }
        if (input.includes('\x1b')) return;
        for (const character of input.replaceAll('\r\n', '\r')) {
          if (character === '\r' || character === '\n') { child.stdin.write(`${inputLine}\n`); inputLine = ''; print('\n'); }
          else if (character === '\x7f' || character === '\b') { if (inputLine) { inputLine = [...inputLine].slice(0, -1).join(''); print('\b \b'); } }
          else if (character >= ' ' || character === '\t') { inputLine += character; print(character); }
        }
      },
      close: () => { disposed = true; stop(); if (!child) void clean().catch(error => log.appendLine(`Runner task cleanup failed; build files were retained: ${errorMessage(error)}`)); write.dispose(); close.dispose(); },
    };
  }

  async function startTask(plan: RunPlan, scope: vscode.WorkspaceFolder | vscode.TaskScope.Global, verify?: () => Promise<void>, cleanup?: () => Promise<void>, nativeConsole = false, waitForExit = false): Promise<number | undefined> {
    const first = plan.steps[0];
    if (!first) throw new Error('A runner task needs at least one execution step.');
    // Package managers need a real console for their interactive installer and
    // agreement prompts; each installation task contains exactly one argv step.
    const execution = nativeConsole
      ? new api.ProcessExecution(first.executable, first.args, { cwd: plan.cwd, env: runnerEnvironment(plan) })
      : new api.CustomExecution(async () => terminalFor(plan, verify, cleanup));
    const runId = randomUUID();
    const task = new api.Task({ type: 'little-runner', file: plan.file, littleRunId: runId }, scope, `Run ${path.basename(plan.file)}`, 'Little Code', execution, []);
    task.presentationOptions = { reveal: api.TaskRevealKind.Always, panel: api.TaskPanelKind.New, focus: true, clear: true, showReuseMessage: false };
    const listeners: vscode.Disposable[] = [];
    const completion = waitForExit ? new Promise<number | undefined>(resolve => {
      listeners.push(api.tasks.onDidEndTaskProcess(event => { if (event.execution.task.definition.littleRunId === runId) resolve(event.exitCode); }));
      listeners.push(api.tasks.onDidEndTask(event => { if (event.execution.task.definition.littleRunId === runId) resolve(undefined); }));
    }) : undefined;
    try {
      const taskExecution = await api.tasks.executeTask(task);
      running.add(taskExecution);
      return completion ? await completion : undefined;
    } finally { for (const listener of listeners) listener.dispose(); }
  }
  disposables.push(api.tasks.onDidEndTask(event => running.delete(event.execution)));

  async function missingRuntime(language: LanguageDefinition): Promise<void> {
    const setup = language.id === 'c' || language.id === 'cpp';
    const choice = await api.window.showErrorMessage(`${language.label} runtime was not found. Install it, or set little.runner.runtimePaths.${language.runtime} to its absolute executable path.`, ...(setup ? ['Set up C/C++ toolchain', 'Official runtime guide', 'Runner settings'] : ['Official runtime guide', 'Runner settings']));
    if (choice === 'Set up C/C++ toolchain') await api.commands.executeCommand('little.setupCppToolchain');
    else if (choice === 'Official runtime guide') await api.env.openExternal(api.Uri.parse(language.documentation));
    else if (choice === 'Runner settings') await api.commands.executeCommand('workbench.action.openSettings', 'little.runner');
  }

  disposables.push(api.commands.registerCommand('little.runFile', async (uri?: vscode.Uri) => {
    let buildDirectory: string | undefined;
    let handedOff = false;
    try {
      if (!api.workspace.isTrusted) { await api.window.showWarningMessage('Trust this workspace before running its code.'); return; }
      const document = uri?.scheme === 'file' ? await api.workspace.openTextDocument(uri) : api.window.activeTextEditor?.document;
      if (!document || document.isUntitled || document.uri.scheme !== 'file') { await api.window.showWarningMessage('Open and save a source file in your workspace before running it.'); return; }
      const folder = api.workspace.getWorkspaceFolder(document.uri);
      if (!folder) { await api.window.showWarningMessage('Open the source file’s folder as a workspace before running it.'); return; }
      if (document.isDirty) {
        if (await api.window.showWarningMessage('Save your changes before reviewing this run?', { modal: true }, 'Save and review') !== 'Save and review' || !await document.save()) return;
      }
      const file = document.uri.fsPath;
      const root = await realpath(folder.uri.fsPath);
      const actualFile = await realpath(file);
      const relative = path.relative(root, actualFile);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('The source file resolves outside its workspace.');
      const identity = await sourceIdentity(file);
      const language = selectLanguage(document.languageId, file);
      const custom = setting<Record<string, CustomRuntime>>('customRuntimes', {}, document.uri)[document.languageId];
      if (!language && !custom) {
        await api.window.showWarningMessage('This file does not have a single-file runner. JSX/TSX, notebooks and framework applications use their project tasks. Add an application-level little.runner.customRuntimes entry for another interpreter.', 'Runner settings').then(choice => choice === 'Runner settings' && api.commands.executeCommand('workbench.action.openSettings', 'little.runner'));
        return;
      }
      const options = runtimeOptions(document.uri);
      const projectPython = !custom && language?.id === 'python' && !options.overrides.python ? await discoverProjectPython(file, folder.uri.fsPath) : undefined;
      const executable = custom ? custom.executable : projectPython ?? await discoverRuntime(language!, options);
      if (!executable && language) { await missingRuntime(language); return; }
      const privateRoot = path.join(context.globalStorageUri.fsPath, 'runner-builds');
      await mkdir(privateRoot, { recursive: true });
      if ((await lstat(privateRoot)).isSymbolicLink()) throw new Error('Private runner storage may not be a symbolic link.');
      buildDirectory = await mkdtemp(path.join(privateRoot, 'run-'));
      const programArguments = validateProgramArguments(setting('arguments', [], document.uri));
      const plan = custom
        ? createCustomRunPlan(document.languageId, custom, file, buildDirectory, programArguments)
        : createRunPlan(language!, file, executable!, buildDirectory, programArguments);
      const choice = await api.window.showWarningMessage(`Run ${plan.label}: ${path.basename(file)}?`, { modal: true, detail: describeRunPlan(plan) }, 'Compile / run');
      if (choice !== 'Compile / run') return;
      const approvedBuild = buildDirectory;
      await startTask(plan, folder, async () => {
        if (!api.workspace.isTrusted || api.workspace.getWorkspaceFolder(document.uri)?.uri.toString() !== folder.uri.toString() || document.isDirty || await realpath(file) !== actualFile || await sourceIdentity(file) !== identity) throw new Error('The file or workspace trust changed after review. Save it and prepare a new run.');
      }, () => rm(approvedBuild, { recursive: true, force: true }));
      handedOff = true;
    } catch (error) { await api.window.showErrorMessage(`Little Code runner: ${errorMessage(error)}`); }
    finally { if (buildDirectory && !handedOff) await rm(buildDirectory, { recursive: true, force: true }); }
  }));

  disposables.push(api.commands.registerCommand('little.inspectRuntimes', async () => {
    log.clear(); log.show(true);
    log.appendLine('Little Code installed-runtime discovery (paths only; no executable is launched)');
    log.appendLine('Configure absolute runtime executable overrides in application-level little.runner.runtimePaths.');
    for (const language of LANGUAGE_CATALOG) {
      try {
        const executable = await discoverRuntime(language, runtimeOptions());
        log.appendLine(`${executable ? 'FOUND' : 'MISSING'}  ${language.label}: ${executable ?? `install ${language.runtime} · ${language.documentation}`}`);
        if (language.note) log.appendLine(`  ${language.note}`);
      } catch (error) { log.appendLine(`INVALID  ${language.label}: ${errorMessage(error)}`); }
    }
    log.appendLine('\nFOUND checks a regular executable path, not SDK version, installed packages or successful compilation.');
  }));

  disposables.push(api.commands.registerCommand('little.setupCppToolchain', async () => {
    try {
      if (process.platform !== 'win32') { await api.env.openExternal(api.Uri.parse('https://www.mingw-w64.org/downloads/')); return; }
      const pacmanDefinition: LanguageDefinition = { id: 'msys2', label: 'MSYS2 package manager', languageIds: [], extensions: [], runtime: 'pacman', candidates: ['pacman'], kind: 'script', documentation: 'https://www.msys2.org/' };
      // Pacman is resolved from known MSYS2 roots, never from arbitrary project directories.
      const directories = runtimeSearchDirectories({ env: { ...process.env, PATH: '', Path: '' } }).filter(directory => /[\\/]usr[\\/]bin$/iu.test(directory));
      const findPacman = async () => {
        const override = runtimeOptions().overrides.pacman;
        if (override) {
          const found = await discoverRuntime(pacmanDefinition, { overrides: { pacman: override } });
          if (found && !/[\\/]usr[\\/]bin[\\/]pacman\.exe$/iu.test(found)) throw new Error('The MSYS2 package manager override must point to its installed usr/bin/pacman.exe.');
          return found;
        }
        for (const directory of directories) {
          const found = await discoverRuntime(pacmanDefinition, { env: { PATH: directory } });
          if (found) return found;
        }
        return undefined;
      };
      let pacman = await findPacman();
      if (!pacman) {
        const wingetDefinition: LanguageDefinition = { id: 'winget', label: 'Windows Package Manager', languageIds: [], extensions: [], runtime: 'winget', candidates: ['winget'], kind: 'script', documentation: 'https://learn.microsoft.com/windows/package-manager/winget/' };
        const winget = await discoverRuntime(wingetDefinition);
        const choice = await api.window.showInformationMessage('Install MSYS2 first, initialize/update it using the official guide, then return here to install the UCRT64 GCC/MinGW compiler.', ...(winget ? ['Review MSYS2 installation', 'Open official MSYS2 guide'] : ['Open official MSYS2 guide']));
        if (choice === 'Open official MSYS2 guide') await api.env.openExternal(api.Uri.parse('https://www.msys2.org/'));
        else if (choice === 'Review MSYS2 installation' && winget) {
          const plan: RunPlan = { label: 'MSYS2 installation', file: winget, cwd: context.globalStorageUri.fsPath, buildDirectory: '', env: {}, steps: [{ label: 'Install MSYS2 using Windows Package Manager', executable: winget, args: ['install', '--id', 'MSYS2.MSYS2', '--exact', '--source', 'winget', '--interactive'] }], note: 'This downloads the MSYS2 installer referenced by the Microsoft community winget repository and starts its interactive installer. Review source/package agreements and installer prompts. After a successful installation, Little Code separately reviews any required first-login initialization and the GCC package installation. This step does not install GCC automatically. Update an existing MSYS2 installation using its official guide before adding packages.' };
          if (await api.window.showWarningMessage('Install MSYS2 on this computer?', { modal: true, detail: describeRunPlan(plan) }, 'Start reviewed installation') !== 'Start reviewed installation') return;
          await mkdir(plan.cwd, { recursive: true });
          if (await startTask(plan, api.TaskScope.Global, undefined, undefined, true, true) !== 0) { await api.window.showWarningMessage('MSYS2 installation did not finish successfully. Check its task terminal and retry setup when installation is complete.'); return; }
          pacman = await findPacman();
          if (!pacman) { await api.window.showWarningMessage('MSYS2 installed, but its package manager was not found in a known location. Set the application-level little.runner.runtimePaths.pacman to your installed usr/bin/pacman.exe, then run C/C++ setup again.', 'Runner settings').then(action => action === 'Runner settings' && api.commands.executeCommand('workbench.action.openSettings', 'little.runner')); return; }
        }
        if (!pacman) return;
      }
      const installationRoot = path.dirname(path.dirname(path.dirname(pacman)));
      const keyringStatus = await inspectMsysKeyring(installationRoot);
      if (keyringStatus === 'incomplete') {
        if (await api.window.showErrorMessage('MSYS2’s package-signing keyring folder exists but required keyring/trust files are missing or empty. Compiler installation is stopped. If the first MSYS2 shell is still initializing, let it finish and retry; otherwise follow the official keyring/update guide. Little Code will not delete the keyring or bypass signature verification.', 'Open official update guide') === 'Open official update guide') await api.env.openExternal(api.Uri.parse('https://www.msys2.org/docs/updating/'));
        return;
      }
      if (keyringStatus === 'uninitialized') {
        const bash = path.join(path.dirname(pacman), 'bash.exe');
        if (!(await lstat(bash)).isFile()) throw new Error('MSYS2 first-login initialization needs the installed usr/bin/bash.exe. Open MSYS2 UCRT64 once using its official launcher, then retry setup.');
        const initialization = createMsysInitializationPlan(bash);
        if (await api.window.showWarningMessage('Initialize MSYS2’s package-signing keyring?', { modal: true, detail: describeRunPlan(initialization) }, 'Start reviewed initialization') !== 'Start reviewed initialization') return;
        if (await startTask(initialization, api.TaskScope.Global, undefined, undefined, true, true) !== 0 || await inspectMsysKeyring(installationRoot) !== 'files-present') {
          if (await api.window.showErrorMessage('MSYS2 first-login initialization did not produce the required package keyring files. Compiler installation is stopped. Check the initialization task terminal and follow MSYS2’s official first-run/update guide.', 'Open official MSYS2 guide') === 'Open official MSYS2 guide') await api.env.openExternal(api.Uri.parse('https://www.msys2.org/'));
          return;
        }
      }
      const plan: RunPlan = {
        label: 'MSYS2 UCRT64 C/C++ toolchain installation', file: pacman, cwd: installationRoot, buildDirectory: '',
        steps: [{ label: 'Install the official UCRT64 GCC package (interactive confirmation)', executable: pacman, args: ['-S', '--needed', 'mingw-w64-ucrt-x86_64-gcc'] }],
        env: { MSYSTEM: 'UCRT64' },
        note: 'First update MSYS2 according to its official guide. This task downloads packages from your MSYS2-configured repositories and writes to your MSYS2 installation. Review the package list and answer pacman’s installation prompt. Administrator rights may be needed for your installation. Nothing is automatically accepted.',
      };
      if (await api.window.showWarningMessage('Install C/C++ compiler into MSYS2?', { modal: true, detail: describeRunPlan(plan) }, 'Start reviewed installation') !== 'Start reviewed installation') return;
      await startTask(plan, api.TaskScope.Global, undefined, undefined, true);
    } catch (error) { await api.window.showErrorMessage(`C/C++ setup: ${errorMessage(error)}`); }
  }));
  return api.Disposable.from(...disposables);
}
