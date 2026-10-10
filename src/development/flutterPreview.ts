import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { redactSecrets } from '../little/context/redact-secrets';
import { discoverFlutterSdk, flutterCommand, FlutterMachineDecoder, FlutterProcessCleanup, flutterWebUrl, parseFlutterDevices, validFlutterId, validateFlutterEntrypoint, validateFlutterProject, type FlutterDevice, type FlutterMessage, type FlutterSdk } from './flutterProtocol';

const SDK_DOCS = 'https://docs.flutter.dev/get-started/install';
const DEVICE_DOCS = 'https://docs.flutter.dev/platform-integration/android/setup';
type Method = Parameters<typeof flutterCommand>[1];
const abortError = () => new Error('Flutter operation cancelled.');
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(abortError()); };
  signal.addEventListener('abort', abort, { once: true });
});

function environment(sdk: FlutterSdk): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FLUTTER_ROOT: sdk.root };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)|(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
  return env;
}

/** Owns one direct SDK process. No batch script or shell receives project arguments. */
class FlutterProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completed: Promise<{ code: number | null; output: string }>;
  readonly closed: Promise<void>;
  private readonly decoder = new FlutterMachineDecoder();
  private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(message: FlutterMessage) => void>();
  private nextId = 1;
  private bytes = 0;
  private collected = '';
  private exited = false;
  private stopping?: Promise<void>;
  private readonly cleanup: FlutterProcessCleanup;

  constructor(sdk: FlutterSdk, cwd: string, args: string[], private readonly log: (text: string) => void, signal: AbortSignal, private readonly machine = false, outputLimit = 256 * 1024) {
    signal.throwIfAborted();
    this.child = spawn(sdk.executable, [...sdk.prefixArgs, ...args], { cwd, env: environment(sdk), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', () => { this.exited = true; resolve(); }));
    this.cleanup = new FlutterProcessCleanup({ platform: process.platform, isClosed: () => this.exited, closed: this.closed, terminate: async signal => {
      const pid = this.child.pid;
      if (!pid || this.exited) return;
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }, error => {
          if (error) { this.log(`Flutter tree termination failed: ${redactSecrets(error.message).slice(0, 1000)}`); reject(error); }
          else resolve();
        }));
      } else {
        process.kill(-pid, signal ?? 'SIGKILL');
      }
    } });
    this.completed = new Promise((resolve, reject) => {
      const abort = () => { this.requestStop(); };
      signal.addEventListener('abort', abort, { once: true });
      const finish = () => {
        signal.removeEventListener('abort', abort);
        for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Flutter process ended before its response.')); }
        this.requests.clear();
      };
      this.child.on('error', error => { reject(new Error(`Flutter process error: ${redactSecrets(error.message)}`)); });
      this.child.once('close', code => { finish(); resolve({ code, output: this.collected }); });
      const consume = (chunk: string, stdout: boolean) => {
        const size = Buffer.byteLength(chunk);
        this.bytes += size;
        if (this.bytes > outputLimit) { if (this.bytes - size <= outputLimit) { this.log('Flutter output limit reached. Stopping the owned process.'); this.requestStop(); } return; }
        if (!machine) this.collected += chunk;
        try {
          if (!stdout || !machine) this.log(chunk);
          else for (const { line, messages } of this.decoder.push(chunk)) {
            if (!messages) { if (line) this.log(line); continue; }
            for (const message of messages) {
              const pending = typeof message.id === 'number' && this.requests.get(message.id);
              if (pending) {
                clearTimeout(pending.timer); this.requests.delete(message.id as number);
                if (message.error !== undefined) pending.reject(new Error(`Flutter rejected the request: ${redactSecrets(JSON.stringify(message.error).slice(0, 1000))}`));
                else pending.resolve(message.result);
              }
              if (message.event === 'app.log' && typeof message.params?.log === 'string') this.log(message.params.log);
              if ((message.event === 'daemon.log' || message.event === 'daemon.logMessage') && typeof (message.params?.log ?? message.params?.message) === 'string') this.log(String(message.params?.log ?? message.params?.message));
              for (const listener of this.listeners) listener(message);
            }
          }
        } catch (error) { this.log(error instanceof Error ? error.message : 'Invalid Flutter machine output.'); this.requestStop(); }
      };
      this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => consume(chunk, true));
      this.child.stderr.on('data', (chunk: string) => consume(chunk, false));
      if (signal.aborted) abort();
    });
    // Callers also observe completion; attaching here prevents an early spawn
    // error from becoming an unhandled rejection while a picker is open.
    void this.completed.catch(() => {});
  }

  listen(listener: (message: FlutterMessage) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  request(method: Method, params?: Record<string, unknown>, timeout = 20_000): Promise<unknown> {
    if (!this.machine || this.exited || this.stopping) return Promise.reject(new Error('Flutter session is not running.'));
    const id = this.nextId++;
    const command = flutterCommand(id, method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('Flutter command timed out. Inspect Little Flutter output.')); }, timeout);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(command, error => { if (error) { clearTimeout(timer); this.requests.delete(id); reject(error); } });
    });
  }

  waitFor(predicate: (message: FlutterMessage) => boolean, signal: AbortSignal, timeout = 420_000): Promise<FlutterMessage> {
    return new Promise((resolve, reject) => {
      if (this.exited || signal.aborted) { reject(abortError()); return; }
      const subscription = this.listen(message => { if (predicate(message)) { cleanup(); resolve(message); } });
      const abort = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Flutter did not become ready in time. Inspect Little Flutter output and run flutter doctor.')); }, timeout);
      const cleanup = () => { clearTimeout(timer); subscription.dispose(); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      void this.completed.then(() => { cleanup(); reject(new Error('Flutter exited before the app became ready.')); }, error => { cleanup(); reject(error); });
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const pending = this.cleanup.stop().then(() => {
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    });
    this.stopping = pending;
    void pending.finally(() => { if (this.stopping === pending) this.stopping = undefined; }).catch(() => {});
    return pending;
  }

  private requestStop(): void {
    void this.stop().catch(error => this.log(error instanceof Error ? error.message : 'Flutter stop could not be confirmed.'));
  }
}

interface PreviewSession { process: FlutterProcess; controller: AbortController; project: string; device: FlutterDevice; appId?: string; ready: boolean }

class FlutterPreview implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Little Flutter');
  private readonly owned = new Set<FlutterProcess>();
  private readonly commands: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
  private readonly reload = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 44);
  private readonly restart = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 43);
  private readonly stopButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 42);
  private session?: PreviewSession;
  private starting?: AbortController;
  private disposed = false;
  private outputDisposed = false;
  private stopping?: Promise<void>;
  private outputCharacters = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.text = '$(device-mobile) Flutter'; this.status.command = 'little.flutterPreview'; this.status.tooltip = 'Run a real Flutter project on a device or in the web preview'; this.status.show();
    this.reload.text = '$(debug-restart) Reload'; this.reload.command = 'little.flutterHotReload'; this.reload.tooltip = 'Flutter hot reload';
    this.restart.text = '$(refresh) Restart'; this.restart.command = 'little.flutterRestart'; this.restart.tooltip = 'Flutter hot restart';
    this.stopButton.text = '$(debug-stop) Stop Flutter'; this.stopButton.command = 'little.flutterStop';
    this.commands.push(
      vscode.commands.registerCommand('little.flutterPreview', (target?: vscode.Uri) => this.guard(() => this.start(target))),
      vscode.commands.registerCommand('little.flutterHotReload', () => this.guard(() => this.reloadApp(false))),
      vscode.commands.registerCommand('little.flutterRestart', () => this.guard(() => this.reloadApp(true))),
      vscode.commands.registerCommand('little.flutterStop', () => this.guard(() => this.stop())),
    );
  }

  private log(text: string): void {
    if (this.outputDisposed) return;
    const safe = redactSecrets(text).slice(0, 16_000);
    if (this.outputCharacters + safe.length > 128_000) { this.output.clear(); this.outputCharacters = 0; this.output.appendLine('Earlier Flutter output was trimmed.'); }
    this.outputCharacters += safe.length; this.output.appendLine(safe.trimEnd());
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) {
      if (this.disposed) return;
      const message = redactSecrets(error instanceof Error ? error.message : 'Flutter preview failed.');
      this.log(message);
      if (/cancelled|aborted/i.test(message)) return;
      const selection = await vscode.window.showErrorMessage(message, 'Show output', 'Flutter setup');
      if (selection === 'Show output') this.output.show(true);
      if (selection === 'Flutter setup') await vscode.env.openExternal(vscode.Uri.parse(SDK_DOCS));
    }
  }

  private own(sdk: FlutterSdk, project: string, args: string[], signal: AbortSignal, machine = false): FlutterProcess {
    if (!vscode.workspace.isTrusted || this.disposed || signal.aborted) throw abortError();
    const process = new FlutterProcess(sdk, project, args, text => this.log(text), signal, machine, machine ? 4 * 1024 * 1024 : 256 * 1024);
    this.owned.add(process);
    void process.closed.then(() => { this.owned.delete(process); });
    return process;
  }

  private async discover(sdk: FlutterSdk, project: string, signal: AbortSignal): Promise<FlutterDevice[]> {
    const process = this.own(sdk, project, ['devices', '--machine', '--device-timeout', '10'], signal);
    const timer = setTimeout(() => { void process.stop().catch(error => this.log(error instanceof Error ? error.message : 'Flutter discovery stop could not be confirmed.')); }, 25_000);
    try {
      const result = await process.completed;
      signal.throwIfAborted();
      if (result.code !== 0) throw new Error('Flutter device discovery failed. Run flutter doctor and inspect Little Flutter output.');
      return parseFlutterDevices(result.output);
    } finally { clearTimeout(timer); }
  }

  private async project(target?: vscode.Uri): Promise<{ root: string; project: string } | undefined> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running Flutter.');
    if (target) {
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (target.scheme !== 'file' || folder?.uri.scheme !== 'file') throw new Error('Choose a Flutter project folder inside the open local workspace.');
      const project = await validateFlutterProject(folder.uri.fsPath, target.fsPath);
      return { root: folder.uri.fsPath, project };
    }
    const pubspecs = await vscode.workspace.findFiles('**/pubspec.yaml', '**/{node_modules,.git,.dart_tool,build,.upstream}/**', 40);
    const choices: { label: string; description: string; root: string; project: string }[] = [];
    for (const uri of pubspecs) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (uri.scheme !== 'file' || folder?.uri.scheme !== 'file') continue;
      try {
        const project = await validateFlutterProject(folder.uri.fsPath, path.dirname(uri.fsPath));
        choices.push({ label: path.basename(project), description: vscode.workspace.asRelativePath(uri, true), root: folder.uri.fsPath, project });
      } catch { /* Ordinary Dart packages and excluded/linked projects are omitted. */ }
    }
    if (!choices.length) throw new Error('Open a Flutter app folder containing pubspec.yaml with a Flutter SDK dependency. Create or open a Flutter project first.');
    const previous = this.context.workspaceState.get<string>('little.flutter.lastProject');
    choices.sort((a, b) => Number(b.project === previous) - Number(a.project === previous));
    const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: 'Little Flutter · Choose a project', matchOnDescription: true });
    if (selected) await this.context.workspaceState.update('little.flutter.lastProject', selected.project);
    return selected;
  }

  private async start(target?: vscode.Uri): Promise<void> {
    if (this.starting) { this.output.show(true); return; }
    if (!this.session && this.owned.size) throw new Error('An earlier owned Flutter process has not stopped. Use Little: Stop Flutter Preview and confirm it exits before starting another preview.');
    if (this.session) {
      const choice = await vscode.window.showQuickPick([{ label: 'Hot reload', action: () => this.reloadApp(false) }, { label: 'Hot restart', action: () => this.reloadApp(true) }, { label: 'Stop preview', action: () => this.stop() }], { title: 'Little Flutter · Preview controls' });
      await choice?.action(); return;
    }
    const controller = new AbortController(); this.starting = controller;
    this.stopButton.show();
    let succeeded = false;
    try {
      const selected = await this.project(target);
      if (!selected || controller.signal.aborted) return;
      const configuredPath = vscode.workspace.getConfiguration('little').inspect<string>('flutter.sdkPath')?.globalValue;
      const sdk = await discoverFlutterSdk({ configuredPath });
      const confirmed = await vscode.window.showWarningMessage('Discover Flutter devices for this project?', { modal: true, detail: `Project: ${selected.project}\nSDK: ${sdk.root}\nRuns installed Flutter device discovery; emulator discovery uses its machine daemon. No SDK installation is performed.` }, 'Discover devices');
      if (confirmed !== 'Discover devices' || controller.signal.aborted) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Little Flutter preview', cancellable: true }, async (progress, token) => {
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          progress.report({ message: 'Discovering real devices…' });
          const devices = await this.discover(sdk, selected.project, controller.signal);
          const options = [{ label: '$(browser) Web preview inside Little Code', description: 'Loopback web-server · browser debugging is limited', device: { id: 'web-server', name: 'Web preview', platform: 'web', emulator: false } as FlutterDevice }, ...devices.map(device => ({ label: `$(device-mobile) ${device.name}`, description: `${device.platform} · ${device.id}`, device })), { label: '$(vm) Launch an existing emulator', description: 'Uses emulators already configured in your SDK', device: undefined }];
          const choice = await vscode.window.showQuickPick(options, { title: 'Little Flutter · Select a real target', matchOnDescription: true });
          if (!choice) return;
          controller.signal.throwIfAborted();
          let device = choice.device;
          if (!device) {
            const daemon = this.own(sdk, selected.project, ['daemon'], controller.signal, true);
            const connected = daemon.waitFor(message => message.event === 'daemon.connected', controller.signal, 20_000);
            await connected;
            const emulators = parseFlutterDevices(JSON.stringify(await daemon.request('emulator.getEmulators')));
            const emulator = await vscode.window.showQuickPick(emulators.map(value => ({ label: value.name, description: value.id, device: value })), { title: 'Little Flutter · Choose an installed emulator' });
            if (!emulator) { if (!emulators.length) throw new Error(`No configured emulator is available. Configure a device using ${DEVICE_DOCS}.`); return; }
            const launch = await vscode.window.showWarningMessage(`Launch ${emulator.device.name}?`, { modal: true, detail: 'Starts the installed emulator through Flutter’s machine protocol. Little Code retains the owning daemon until Stop or app disposal; no device images are installed.' }, 'Launch emulator');
            if (launch !== 'Launch emulator') return;
            await daemon.request('emulator.launch', { emulatorId: emulator.device.id }, 60_000);
            progress.report({ message: 'Waiting for the emulator to appear…' });
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline && !device) {
              controller.signal.throwIfAborted();
              const observed = await this.discover(sdk, selected.project, controller.signal);
              device = observed.find(value => value.emulatorId === emulator.device.id);
              if (!device) {
                const fresh = observed.filter(value => value.emulator && !devices.some(before => before.id === value.id));
                if (fresh.length) device = (await vscode.window.showQuickPick(fresh.map(value => ({ label: value.name, description: value.id, device: value })), { title: 'Choose the newly running emulator target' }))?.device;
              }
              if (!device) await sleep(2000, controller.signal);
            }
            if (!device) throw new Error('The emulator did not become available. Inspect Flutter output and Android SDK setup.');
          }
          const project = await validateFlutterProject(selected.root, selected.project);
          await validateFlutterEntrypoint(project);
          // Flutter chooses an unused port when --web-port is omitted; the
          // machine event supplies the actual URL after compilation.
          const args = ['run', '--machine', '-d', device.id, ...(device.id === 'web-server' ? ['--web-hostname', '127.0.0.1'] : [])];
          const launch = await vscode.window.showWarningMessage(`Run Flutter on ${device.name}?`, { modal: true, detail: `Project: ${project}\nflutter ${args.join(' ')}\nBuilds and executes your app with user permissions. Flutter may resolve project dependencies and fetch platform artifacts. Web preview binds to loopback only.` }, 'Run Flutter');
          if (launch !== 'Run Flutter') return;
          controller.signal.throwIfAborted();
          await validateFlutterProject(selected.root, project);
          await validateFlutterEntrypoint(project);
          const running = this.own(sdk, project, args, controller.signal, true);
          const session: PreviewSession = { process: running, controller, project, device, ready: false };
          this.session = session;
          this.output.show(true); this.status.text = '$(loading~spin) Flutter starting';
          running.listen(message => { if (message.event === 'app.start' && validFlutterId(message.params?.appId)) session.appId = message.params.appId; });
          progress.report({ message: 'Building and starting the actual Flutter app…' });
          const ready = await running.waitFor(message => device.id === 'web-server' ? message.event === 'app.webLaunchUrl' : message.event === 'app.started', controller.signal);
          if (validFlutterId(ready.params?.appId)) session.appId = ready.params.appId;
          if (device.id === 'web-server') {
            const url = flutterWebUrl(ready.params?.url);
            if (!url) throw new Error('Flutter returned an invalid or non-loopback web preview URL.');
            const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
            await response.body?.cancel();
            if (!response.ok) throw new Error('The Flutter web server has not returned a ready page. Inspect Flutter output.');
            await vscode.commands.executeCommand('simpleBrowser.api.open', url, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
          }
          controller.signal.throwIfAborted();
          session.ready = true; succeeded = true;
          await vscode.commands.executeCommand('setContext', 'little.flutterRunning', true);
          this.status.text = `$(device-mobile) Flutter · ${device.name}`;
          this.reload.show(); this.restart.show();
          void running.completed.then(() => { if (this.session === session) void this.guard(() => this.stop()); }, error => { this.log(error instanceof Error ? error.message : 'Flutter ended.'); if (this.session === session) void this.guard(() => this.stop()); });
        } finally { cancellation.dispose(); }
      });
    } finally {
      this.starting = undefined;
      if (!succeeded) await this.stop();
    }
  }

  private async reloadApp(fullRestart: boolean): Promise<void> {
    const session = this.session;
    if (!session?.ready || !session.appId) throw new Error('A running Flutter application is required before reload or restart.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running Flutter commands.');
    const action = fullRestart ? 'Hot restart' : 'Hot reload';
    if (await vscode.window.showWarningMessage(`${action} the Flutter app?`, { modal: true, detail: `Runs the current saved code in ${session.project}.` }, action) !== action || this.session !== session) return;
    const result = await session.process.request('app.restart', { appId: session.appId, fullRestart, reason: 'manual', pause: false, debounce: true }, 60_000);
    if (!result || typeof result !== 'object' || !('code' in result) || result.code !== 0) throw new Error(`${action} failed or is unsupported by this target. Inspect Little Flutter output.`);
    this.log(`${action} completed on ${session.device.name}.`);
  }

  private async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const pending = this.stopOwned();
    this.stopping = pending;
    try { await pending; } finally { if (this.stopping === pending) this.stopping = undefined; }
  }

  private async stopOwned(): Promise<void> {
    this.starting?.abort();
    const session = this.session;
    if (session) session.ready = false;
    if (session?.appId) await session.process.request('app.stop', { appId: session.appId }, 3000).catch(() => {});
    session?.controller.abort();
    const results = await Promise.allSettled([...this.owned].map(process => process.stop()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure || this.owned.size) {
      if (!this.disposed) {
        this.status.text = '$(warning) Flutter stop needs attention'; this.stopButton.show();
        await vscode.commands.executeCommand('setContext', 'little.flutterRunning', true);
      }
      throw failure?.reason ?? new Error('Flutter process stop could not be confirmed. Retry Stop before starting another preview.');
    }
    if (this.session === session) this.session = undefined;
    if (!this.disposed) {
      this.reload.hide(); this.restart.hide(); this.stopButton.hide();
      this.status.text = '$(device-mobile) Flutter';
      await vscode.commands.executeCommand('setContext', 'little.flutterRunning', false);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.starting?.abort(); this.session?.controller.abort();
    for (const command of this.commands) command.dispose();
    this.status.dispose(); this.reload.dispose(); this.restart.dispose(); this.stopButton.dispose();
    void this.stop().then(() => { this.outputDisposed = true; this.output.dispose(); }, error => {
      this.log(error instanceof Error ? error.message : 'Flutter shutdown could not be confirmed.');
      void vscode.window.showErrorMessage('Flutter shutdown could not be confirmed. Inspect Little Flutter output and stop the owned process before starting another preview.');
      // Preserve the output and ownership receipt until the actual child closes.
      void Promise.all([...this.owned].map(process => process.closed)).then(() => { this.outputDisposed = true; this.output.dispose(); });
    });
  }
}

export function registerFlutterPreview(context: vscode.ExtensionContext): vscode.Disposable {
  return new FlutterPreview(context);
}
