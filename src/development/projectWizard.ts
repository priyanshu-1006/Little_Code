import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { redactSecrets } from '../little/context/redact-secrets';
import { discoverFlutterSdk } from './flutterProtocol';
import { PROJECT_FRAMEWORKS, createProjectPlan, inspectProjectDestination, inspectProjectPythonEnvironment, prepareProjectDestination, recheckProjectDestination, validateProjectName, writeStarterFiles, type ProjectFramework, type ProjectLanguage, type ProjectOptions, type ProjectPlan, type ScaffoldStep } from './projectTemplates';

const execFileAsync = promisify(execFile);
interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number }
interface PreparedTool { executable: string; prefixArgs: readonly string[]; identities: readonly { path: string; source: string; fingerprint: Fingerprint }[]; version?: string; revalidate?: () => Promise<void> }
const sameFile = (left: Fingerprint, right: Fingerprint): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;

async function fileIdentity(candidate: string): Promise<{ path: string; source: string; fingerprint: Fingerprint }> {
  const resolved = await fs.realpath(candidate); const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('The selected toolchain executable is not a regular file.');
  return { path: resolved, source: path.resolve(candidate), fingerprint: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } };
}
async function pathExecutable(names: readonly string[]): Promise<string> {
  for (const directoryInput of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = directoryInput.replace(/^"|"$/g, ''); if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try { const checked = await fileIdentity(candidate); if (process.platform !== 'win32') await fs.access(checked.path, fs.constants.X_OK); return checked.path; }
      catch { /* An executable must exist in an explicit absolute PATH directory. */ }
    }
  }
  throw new Error(`${names[0]!.replace(/\.exe$/, '')} is not installed on PATH. Install its official runtime, reopen Little Code, and try again.`);
}
function cleanEnvironment(nodePath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$|PYTHONHOME$|PYTHONPATH$|PYTHONSTARTUP$)|(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete env[name];
  // Keep standard PATH/SDK/proxy settings. No provider SecretStorage value is passed to these processes.
  if (nodePath) env.PATH = path.dirname(nodePath) + path.delimiter + (env.PATH ?? '');
  env.CI = '1'; env.FORCE_COLOR = '0'; env.NG_CLI_ANALYTICS = 'false'; env.NEXT_TELEMETRY_DISABLED = '1';
  return env;
}
async function version(executable: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(executable, [...args], { shell: false, windowsHide: true, env: cleanEnvironment(), timeout: 10000, maxBuffer: 8192 });
  return redactSecrets((result.stdout + result.stderr).trim());
}
function checkNodeVersion(value: string, framework: ProjectOptions['frameworkId']): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value); if (!match) throw new Error('Could not verify the installed Node.js version.');
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  const atLeast = (requiredMajor: number, requiredMinor: number, requiredPatch = 0): boolean => major > requiredMajor || (major === requiredMajor && (minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch)));
  if (framework === 'angular' && !((major === 22 && atLeast(22, 22, 3)) || (major === 24 && atLeast(24, 15)) || major >= 26)) throw new Error('The pinned Angular CLI requires Node.js 22.22.3+, 24.15+, or 26+. Install a supported Node.js release and reopen Little Code.');
  if (['react', 'vue', 'vite'].includes(framework) && !((major === 20 && atLeast(20, 19)) || atLeast(22, 12))) throw new Error('The pinned Vite creator requires Node.js 20.19+ or 22.12+. Install a supported Node.js release and reopen Little Code.');
  const minimumMinor = framework === 'next' ? 9 : framework === 'nest' ? 11 : 0;
  if (!atLeast(20, minimumMinor)) throw new Error(`This creator requires Node.js 20.${minimumMinor}+; install a supported Node.js release and reopen Little Code.`);
}
async function prepareNpm(framework: ProjectOptions['frameworkId']): Promise<PreparedTool> {
  const node = await pathExecutable(process.platform === 'win32' ? ['node.exe'] : ['node']);
  const nodeVersion = await version(node, ['--version']); checkNodeVersion(nodeVersion, framework);
  const directories = [path.dirname(node), ...(process.env.PATH ?? '').split(path.delimiter).map(directory => directory.replace(/^"|"$/g, '')).filter(directory => path.isAbsolute(directory))];
  const candidates = directories.flatMap(directory => [path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(directory, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js')]);
  // Resolve npm's JS entrypoint, not a cmd/bat shim or a shell command string.
  for (const candidate of candidates) {
    try {
      const cli = await fileIdentity(candidate); const nodeIdentity = await fileIdentity(node);
      const npmVersion = await version(node, [cli.path, '--version']);
      if (!/^\d+\.\d+\.\d+/.test(npmVersion)) continue;
      return { executable: nodeIdentity.path, prefixArgs: Object.freeze([cli.path]), identities: Object.freeze([nodeIdentity, cli]), version: `Node ${nodeVersion} · npm ${npmVersion}` };
    } catch { /* Try the next conventional official npm installation layout. */ }
  }
  throw new Error('npm’s JavaScript CLI was not found beside Node.js or on PATH. Install Node.js with npm, then reopen Little Code.');
}
async function preparePython(): Promise<PreparedTool> {
  // Prefer the Windows launcher so an unconfigured Microsoft Store alias cannot hide an installed Python.
  for (const name of process.platform === 'win32' ? ['py.exe', 'python.exe', 'python3.exe'] : ['python3', 'python']) {
    try {
      const executable = await pathExecutable([name]);
      const prefixArgs = process.platform === 'win32' && name === 'py.exe' ? ['-3'] : [];
      const pythonVersion = await version(executable, [...prefixArgs, '--version']);
      const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(pythonVersion);
      if (!match || Number(match[1]) !== 3 || Number(match[2]) < 10) continue;
      return { executable, prefixArgs: Object.freeze(prefixArgs), identities: Object.freeze([await fileIdentity(executable)]), version: pythonVersion };
    } catch { /* Missing launcher, unconfigured Store alias, or an older Python: try the next explicit interpreter. */ }
  }
  throw new Error('Python starters require an installed Python 3.10+ runtime. Django installs a version compatible with your Python. Install Python and reopen Little Code.');
}
async function prepareFlutter(): Promise<PreparedTool> {
  const sdk = await discoverFlutterSdk({ configuredPath: vscode.workspace.getConfiguration('little').inspect<string>('flutter.sdkPath')?.globalValue, env: process.env, platform: process.platform });
  const identities = [await fileIdentity(sdk.executable)];
  for (const prefix of sdk.prefixArgs) {
    const file = prefix.startsWith('--packages=') ? prefix.slice('--packages='.length) : prefix;
    if (path.isAbsolute(file)) identities.push(await fileIdentity(file));
  }
  return { executable: identities[0]!.path, prefixArgs: Object.freeze([...sdk.prefixArgs]), identities: Object.freeze(identities), version: `Flutter SDK: ${sdk.root}` };
}
async function recheckTool(tool: PreparedTool): Promise<void> {
  await tool.revalidate?.();
  for (const stored of tool.identities) { const current = await fileIdentity(stored.source); if (current.path !== stored.path || !sameFile(current.fingerprint, stored.fingerprint)) throw new Error('The toolchain changed after review. Restart the project wizard.'); }
}
const safeOutput = (value: string): string => redactSecrets(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

class ProjectWizardHost implements vscode.Disposable {
  private busy = false; private disposed = false; private controller?: AbortController;
  private readonly output = vscode.window.createOutputChannel('Little Project Builder');
  private readonly registrations: vscode.Disposable[];
  constructor(private readonly source: string) {
    this.registrations = [vscode.commands.registerCommand('little.createProject', (target?: vscode.Uri) => this.create(target))];
  }
  private assertTrusted(folder: vscode.WorkspaceFolder, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.disposed || !vscode.workspace.isTrusted || folder.uri.scheme !== 'file' || !vscode.workspace.workspaceFolders?.some(current => current.uri.toString() === folder.uri.toString())) throw new Error('Open and trust this local workspace before creating a project.');
  }
  private async targetFolder(target?: vscode.Uri): Promise<{ folder: vscode.WorkspaceFolder; parent: string } | undefined> {
    if (target !== undefined) {
      if (!(target instanceof vscode.Uri)) throw new Error('Choose a local Explorer folder or run Create Project from the command menu.');
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (!folder || target.scheme !== 'file') throw new Error('Right-click a local folder inside the trusted workspace.');
      this.assertTrusted(folder); return { folder, parent: target.fsPath };
    }
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file') ?? [];
    if (!folders.length) throw new Error('Open a local folder first, then choose Create Project or right-click a folder in Explorer.');
    const picked = folders.length === 1 ? { folder: folders[0]!, parent: folders[0]!.uri.fsPath } : await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder, parent: folder.uri.fsPath })), { title: 'Little Project Builder · Parent folder', placeHolder: 'The new project will be created inside this workspace folder.' });
    if (!picked) return; this.assertTrusted(picked.folder); return picked;
  }
  private async chooseOptions(framework: ProjectFramework, parent: string): Promise<{ options: ProjectOptions; mode: 'new' | 'empty' } | undefined> {
    const chosen = await vscode.window.showQuickPick(framework.templates.map(template => ({ label: template.label, description: template.description, template })), { title: `Little Project Builder · ${framework.label} template`, ignoreFocusOut: true });
    if (!chosen) return;
    let language: ProjectLanguage = chosen.template.languages[0]!;
    if (chosen.template.languages.length > 1) {
      const picked = await vscode.window.showQuickPick(chosen.template.languages.map(language => ({ label: language === 'typescript' ? 'TypeScript' : 'JavaScript', description: language === 'typescript' ? 'Types and editor checks' : 'Plain JavaScript', language })), { title: 'Little Project Builder · Language', ignoreFocusOut: true });
      if (!picked) return; language = picked.language;
    }
    const location = await vscode.window.showQuickPick([{ label: 'Create a new subfolder', description: parent, mode: 'new' as const }, { label: 'Use this empty folder', description: 'Available only when the selected folder contains no files, including hidden files.', mode: 'empty' as const }], { title: 'Little Project Builder · Destination', placeHolder: 'Existing files are never overwritten.', ignoreFocusOut: true });
    if (!location) return;
    const identifier = framework.id === 'python' || framework.id === 'flutter';
    let name = location.mode === 'empty' ? path.basename(parent) : identifier ? 'my_app' : 'my-app';
    if (location.mode === 'new' || identifier) {
      const input = await vscode.window.showInputBox({ title: 'Little Project Builder · Project name', value: name, prompt: location.mode === 'new' ? `Create a new project folder inside ${parent}.` : 'Choose the Python or Dart package name for this empty folder.', ignoreFocusOut: true, validateInput: value => validateProjectName(value, framework.id) });
      if (input === undefined) return; name = input;
    }
    const nameError = validateProjectName(name, framework.id); if (nameError) throw new Error(`The selected folder name cannot be used by ${framework.label}. ${nameError} Create a named subfolder instead.`);
    let tailwind: boolean | undefined; let flutterPlatforms: string[] | undefined;
    if (framework.id === 'next') {
      const picked = await vscode.window.showQuickPick([{ label: 'Tailwind CSS', value: true }, { label: 'Plain CSS', value: false }], { title: 'Little Project Builder · Styles', ignoreFocusOut: true });
      if (!picked) return; tailwind = picked.value;
    }
    if (framework.id === 'flutter' && chosen.template.id !== 'package') {
      const picked = await vscode.window.showQuickPick(['android', 'ios', 'web', 'windows', 'macos', 'linux'].map(platform => ({ label: platform, picked: ['android', 'ios', 'web'].includes(platform) })), { title: 'Little Project Builder · Flutter platforms', placeHolder: 'Generate platform projects. Building them still requires each platform’s SDK and supported host OS.', canPickMany: true, ignoreFocusOut: true });
      if (!picked) return; if (!picked.length) throw new Error('Choose at least one Flutter platform.'); flutterPlatforms = picked.map(item => item.label);
    }
    return { options: { frameworkId: framework.id, templateId: chosen.template.id, language, name, ...(tailwind !== undefined ? { tailwind } : {}), ...(flutterPlatforms ? { flutterPlatforms } : {}) }, mode: location.mode };
  }
  private async runTask(step: ScaffoldStep, tool: PreparedTool, folder: vscode.WorkspaceFolder, cwd: string, check: () => Promise<void>, controller: AbortController): Promise<void> {
    const id = randomBytes(12).toString('hex');
    const write = new vscode.EventEmitter<string>(); const close = new vscode.EventEmitter<number>();
    let child: ChildProcess | undefined; let finished = false; let started = false; let stopping: Promise<void> | undefined; let execution: vscode.TaskExecution | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined; let forced: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8'); let pendingLine = ''; let droppingLine = false; let received = 0;
    const emit = (line: string): void => { const clean = safeOutput(line); this.output.appendLine(clean); write.fire(clean.replace(/\r?\n/g, '\r\n') + '\r\n'); };
    const collect = (chunk: Buffer): void => {
      if (finished) return;
      received += chunk.length;
      if (received > 8 * 1024 * 1024) { emit('Output limit reached. Stopping the owned project task.'); controller.abort(); return; }
      for (const piece of decoder.write(chunk).split(/(?<=\n)/)) {
        if (!droppingLine) pendingLine += piece;
        if (pendingLine.length > 16384) { emit('[Long output line omitted]'); pendingLine = ''; droppingLine = true; }
        if (piece.endsWith('\n')) { if (!droppingLine) emit(pendingLine.trimEnd()); pendingLine = ''; droppingLine = false; }
      }
    };
    let resolveRun!: () => void; let rejectRun!: (error: unknown) => void;
    const result = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    // A native task may finish while executeTask is still resolving its handle.
    void result.catch(() => undefined);
    const finish = (code: number, error?: Error): void => {
      if (finished) return; finished = true;
      if (timer) clearTimeout(timer); if (forced) clearTimeout(forced);
      controller.signal.removeEventListener('abort', abort);
      pendingLine += decoder.end(); if (pendingLine && !droppingLine) emit(pendingLine.trimEnd());
      emit(error ? error.message : `${step.label} completed (exit ${code}).`); close.fire(code);
      if (code === 0 && !error) resolveRun(); else rejectRun(error ?? new Error(`${step.label} failed with exit ${code}. Open Little Project Builder output for details.`));
    };
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      if (finished) return Promise.resolve();
      if (!child?.pid) { finish(130, new Error('Project creation was cancelled. Generated files are kept for inspection.')); return Promise.resolve(); }
      const pid = child.pid;
      stopping = (async () => {
        let confirmed = true;
        try {
          if (process.platform === 'win32') await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], { windowsHide: true, shell: false, timeout: 5000 });
          else { try { process.kill(-pid, 'SIGKILL'); } catch { child?.kill('SIGKILL'); confirmed = false; } }
        } catch { confirmed = false; }
        if (!confirmed && !finished) emit('Could not confirm every child process stopped. Inspect the project’s processes before retrying.');
        if (!finished) forced = setTimeout(() => finish(130, new Error('Could not confirm the project task exited. Inspect its processes before retrying.')), 5000);
      })();
      return stopping;
    };
    const abort = (): void => { void stop(); };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event, onDidClose: close.event,
      open: () => {
        if (started || finished) return; started = true;
        void (async () => {
          try {
            this.assertTrusted(folder, controller.signal); await check(); await recheckTool(tool); this.assertTrusted(folder, controller.signal);
            emit(`> ${step.program} ${step.args.join(' ')}\nFolder: ${cwd}`);
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) { await stop(); return; }
            child = spawn(tool.executable, [...tool.prefixArgs, ...step.args], { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: cleanEnvironment(step.program === 'npm' ? tool.executable : undefined), stdio: ['ignore', 'pipe', 'pipe'] });
            timer = setTimeout(() => { emit('Project task timed out. Stopping its owned process tree.'); controller.abort(); }, 20 * 60 * 1000);
            child.stdout?.on('data', collect); child.stderr?.on('data', collect);
            child.once('error', () => finish(1, new Error('The project toolchain could not start. Check its installation and the task output.')));
            child.once('close', code => { void (async () => { await stopping; if (controller.signal.aborted) finish(130, new Error('Project creation was cancelled. Generated files are kept for inspection.')); else finish(code ?? 1); })(); });
          } catch (error) { finish(1, error instanceof Error ? error : new Error('The project task could not start.')); }
        })();
      },
      close: () => { if (!finished) { controller.abort(); void stop(); } },
    };
    const task = new vscode.Task({ type: 'little-project', id }, folder, `${step.label} · ${path.basename(cwd)}`, this.source, new vscode.CustomExecution(async () => pty));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: false, focus: false, showReuseMessage: false };
    const workspaceChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => { if (!vscode.workspace.workspaceFolders?.some(current => current.uri.toString() === folder.uri.toString())) controller.abort(); });
    try {
      this.assertTrusted(folder, controller.signal);
      execution = await vscode.tasks.executeTask(task);
      if (controller.signal.aborted) { execution.terminate(); await stop(); }
      await result;
    } catch (error) { execution?.terminate(); await stop(); throw error; }
    finally { workspaceChanged.dispose(); write.dispose(); close.dispose(); }
  }
  async create(target?: vscode.Uri): Promise<void> {
    if (this.busy || this.disposed) { void vscode.window.showInformationMessage('Finish the current Little project creation first.'); return; }
    this.busy = true; let destinationPath: string | undefined;
    const controller = new AbortController(); this.controller = controller;
    try {
      const selected = await this.targetFolder(target); if (!selected) return;
      const picked = await vscode.window.showQuickPick(PROJECT_FRAMEWORKS.map(framework => ({ label: framework.label, description: framework.description, framework })), { title: 'Little Project Builder · Framework', placeHolder: 'Official web and mobile generators, or a Python starter.', ignoreFocusOut: true });
      if (!picked) return;
      const selectedOptions = await this.chooseOptions(picked.framework, selected.parent); if (!selectedOptions) return;
      const plan: ProjectPlan = createProjectPlan(selectedOptions.options);
      const destination = await inspectProjectDestination(selected.folder.uri.fsPath, selected.parent, plan.options.name, selectedOptions.mode);
      this.assertTrusted(selected.folder, controller.signal);
      const tools = new Map<ScaffoldStep['program'], PreparedTool>();
      if (plan.steps.some(step => step.program === 'npm')) tools.set('npm', await prepareNpm(plan.options.frameworkId));
      if (plan.steps.some(step => step.program === 'python')) tools.set('python', await preparePython());
      if (plan.steps.some(step => step.program === 'flutter')) tools.set('flutter', await prepareFlutter());
      const detail = `${plan.framework.label} · ${plan.options.language} · ${plan.options.templateId}\nDestination: ${destination.target}\n\n${[...tools.values()].map(tool => tool.version).filter(Boolean).join('\n')}\n\nSteps:\n${plan.steps.map((step, index) => `${index + 1}. ${step.program} ${step.args.join(' ')}`).join('\n')}${plan.files.length ? `\nStarter files: ${plan.files.map(file => file.path).join(', ')}` : ''}\n\nEach command has its own Run step confirmation. Packages and generators run with your user permissions and may access the network. Cancelling keeps generated files. Existing files are never overwritten by the wizard.`;
      const confirmed = await vscode.window.showWarningMessage('Create this Little Code project?', { modal: true, detail }, 'Create project');
      if (confirmed !== 'Create project') return;
      this.assertTrusted(selected.folder, controller.signal);
      const targetIdentity = await prepareProjectDestination(destination); destinationPath = destination.target;
      await writeStarterFiles(destination, targetIdentity, plan.files);
      this.output.show(true); this.output.appendLine(`\nLittle Project Builder: ${plan.framework.label} → ${destination.target}`);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${plan.options.name}`, cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          if (token.isCancellationRequested) controller.abort();
          for (const [index, step] of plan.steps.entries()) {
            this.assertTrusted(selected.folder, controller.signal);
            const check = async (): Promise<void> => { this.assertTrusted(selected.folder, controller.signal); await recheckProjectDestination(destination, targetIdentity, index === 0 && plan.files.length === 0); };
            await check();
            let tool = tools.get(step.program);
            if (step.program === 'venv-python') {
              const environment = await inspectProjectPythonEnvironment(destination.target);
              const checked = await fileIdentity(environment.executable); tool = { executable: environment.executable, prefixArgs: [], identities: [checked, await fileIdentity(environment.configuration)], revalidate: () => environment.recheck() };
            }
            if (!tool) throw new Error('This project toolchain is unavailable.');
            await recheckTool(tool);
            const approved = await vscode.window.showWarningMessage(`${index + 1}/${plan.steps.length}: ${step.label}?`, { modal: true, detail: `${step.program} ${step.args.join(' ')}\n\nFolder: ${destination.target}\n${step.purpose}\n\n${step.network ? 'This step accesses package registries and may execute downloaded package code. ' : ''}The command runs with your user permissions. No global framework install is requested. You can cancel from the progress notification or stop this Little task.` }, 'Run step');
            if (approved !== 'Run step') { controller.abort(); throw new Error('Project creation was cancelled. Generated files are kept for inspection.'); }
            await check(); this.assertTrusted(selected.folder, controller.signal);
            progress.report({ message: step.label, increment: 100 / plan.steps.length });
            await this.runTask(step, tool, selected.folder, destination.target, check, controller);
          }
        } finally { cancellation.dispose(); }
      });
      this.assertTrusted(selected.folder, controller.signal);
      this.output.appendLine(`\nReady: ${destination.target}\nNext: ${plan.next.join('\n')}`);
      const action = await vscode.window.showInformationMessage(`${plan.framework.label} project is ready. ${plan.next[0]}`, 'Open project', 'View setup output');
      if (action === 'Open project') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination.target), { forceNewWindow: true });
      else if (action === 'View setup output') this.output.show();
    } catch (error) {
      const message = safeOutput(error instanceof Error ? error.message : 'Project creation could not complete.');
      this.output.appendLine(message);
      if (!this.disposed) {
        const action = await vscode.window.showWarningMessage(`${message}${destinationPath ? ` Partial project files are retained in ${destinationPath}.` : ''}`, 'View setup output');
        if (action === 'View setup output') this.output.show();
      }
    } finally { if (this.controller === controller) this.controller = undefined; this.busy = false; }
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); for (const registration of this.registrations) registration.dispose(); this.output.dispose(); }
}

/** Adds Little: Create Project. Pass an Explorer folder URI or let the user pick a workspace root. */
export function registerProjectWizard(context: vscode.ExtensionContext): vscode.Disposable { return new ProjectWizardHost(context.extension.packageJSON.displayName ?? 'Little Code'); }
