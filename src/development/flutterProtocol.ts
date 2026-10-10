import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface FlutterSdk { readonly root: string; readonly executable: string; readonly prefixArgs: readonly string[] }
export interface FlutterDevice { readonly id: string; readonly name: string; readonly platform: string; readonly emulator: boolean; readonly emulatorId?: string }
export interface FlutterMessage { id?: number | string; event?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

export interface FlutterCleanupTarget {
  readonly platform: NodeJS.Platform;
  readonly isClosed: () => boolean;
  /** Resolves only from the owned child's close event, never a kill return. */
  readonly closed: Promise<void>;
  /** Windows terminates the owned tree; POSIX targets its owned process group. */
  readonly terminate: (signal?: 'SIGTERM' | 'SIGKILL') => Promise<void>;
  readonly graceMs?: number;
  readonly closeMs?: number;
}

/** A signal request is not an exit receipt. Failed cleanup can be retried. */
export class FlutterProcessCleanup {
  private pending?: Promise<void>;
  constructor(private readonly target: FlutterCleanupTarget) {}

  private async observe(milliseconds: number): Promise<boolean> {
    if (this.target.isClosed()) return true;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      void this.target.closed.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
    return this.target.isClosed();
  }

  stop(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.perform();
    this.pending = pending;
    // Release failed as well as successful attempts. The owner retains the
    // target until its actual close event and can explicitly retry Stop.
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }

  private async perform(): Promise<void> {
    if (this.target.isClosed()) return;
    let failure: unknown;
    if (this.target.platform === 'win32') {
      try { await this.target.terminate(); } catch (error) { failure = error; }
    } else {
      try { await this.target.terminate('SIGTERM'); } catch (error) { failure = error; }
      if (await this.observe(this.target.graceMs ?? 1200)) return;
      try { await this.target.terminate('SIGKILL'); } catch (error) { failure = error; }
    }
    if (await this.observe(this.target.closeMs ?? 5000)) return;
    throw new Error('Flutter process stop could not be confirmed. The owned process is retained; retry Stop and inspect its output or processes before starting another preview.', failure ? { cause: failure } : undefined);
  }
}
const MAX_OUTPUT = 256 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const validFlutterId = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);

export async function discoverFlutterSdk({ configuredPath, env = process.env, platform = process.platform }: { configuredPath?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<FlutterSdk> {
  const candidates = configuredPath ? [configuredPath] : [env.FLUTTER_ROOT, ...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map(directory => path.dirname(directory.replace(/^"|"$/g, '')))];
  for (const candidate of [...new Set(candidates.filter((value): value is string => !!value))]) {
    if (!path.isAbsolute(candidate) || candidate.includes('\0')) continue;
    try {
      const root = await fs.realpath(candidate);
      const executable = path.join(root, 'bin', 'cache', 'dart-sdk', 'bin', platform === 'win32' ? 'dart.exe' : 'dart');
      const snapshot = path.join(root, 'bin', 'cache', 'flutter_tools.snapshot');
      const packages = path.join(root, 'packages', 'flutter_tools', '.dart_tool', 'package_config.json');
      for (const file of [executable, snapshot, packages]) {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('Uninitialized SDK.');
        const real = await fs.realpath(file);
        if (!real.startsWith(root + path.sep)) throw new Error('SDK file escapes its installation.');
      }
      if (platform !== 'win32') await fs.access(executable, fs.constants.X_OK);
      // Match Flutter's launcher argv without its batch/bootstrap shell. A warm
      // tool package configuration is required; discovery never initializes it.
      return Object.freeze({ root, executable, prefixArgs: Object.freeze([`--packages=${packages}`, snapshot]) });
    } catch { /* Only an already-initialized installed SDK is eligible. */ }
  }
  throw new Error('Flutter SDK was not found or its cache is uninitialized. Install Flutter from docs.flutter.dev/get-started/install, run flutter doctor yourself, then set little.flutter.sdkPath to its SDK folder. Little Code does not install or initialize SDKs automatically.');
}

export function hasFlutterPubspec(source: string): boolean {
  if (Buffer.byteLength(source) > MAX_OUTPUT || source.includes('\0')) return false;
  const clean = source.replace(/^\s*#.*$/gm, '');
  return /(?:^|\n)[ \t]+flutter[ \t]*:[ \t]*(?:(?:#.*)?\r?\n[ \t]+sdk[ \t]*:[ \t]*flutter\b|\{\s*sdk\s*:\s*flutter\s*\})/.test(clean);
}

export async function validateFlutterProject(workspaceRoot: string, directory: string): Promise<string> {
  const root = await fs.realpath(workspaceRoot);
  const absolute = path.resolve(directory);
  const relative = path.relative(path.resolve(workspaceRoot), absolute);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Choose a Flutter project inside the open workspace.');
  let current = path.resolve(workspaceRoot);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Linked project directories are unavailable.');
  }
  const project = await fs.realpath(absolute);
  if (project !== root && !project.startsWith(root + path.sep)) throw new Error('The Flutter project escapes its workspace.');
  const manifest = path.join(project, 'pubspec.yaml');
  const stat = await fs.lstat(manifest);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_OUTPUT) throw new Error('Choose a regular bounded pubspec.yaml.');
  if (!hasFlutterPubspec(await fs.readFile(manifest, 'utf8'))) throw new Error('This pubspec.yaml does not declare the Flutter SDK dependency.');
  return project;
}

/** The default run target must be a real source file inside the chosen app. */
export async function validateFlutterEntrypoint(project: string): Promise<void> {
  const realProject = await fs.realpath(project);
  try {
    const library = path.join(realProject, 'lib');
    const libraryStat = await fs.lstat(library);
    const entrypoint = path.join(library, 'main.dart');
    const entryStat = await fs.lstat(entrypoint);
    if (libraryStat.isSymbolicLink() || !libraryStat.isDirectory() || entryStat.isSymbolicLink() || !entryStat.isFile()
      || !(await fs.realpath(entrypoint)).startsWith(realProject + path.sep)) throw new Error('Linked entry point.');
  } catch {
    throw new Error('This project requires a regular lib/main.dart application entry point inside its app folder. Open a Flutter app rather than a package or linked source folder.');
  }
}

export function parseFlutterDevices(output: string): FlutterDevice[] {
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error('Flutter device output exceeded its limit.');
  const start = output.indexOf('['), end = output.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('Flutter did not return a machine-readable device list.');
  const data: unknown = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(data) || data.length > 100) throw new Error('Invalid Flutter device list.');
  const seen = new Set<string>();
  return data.flatMap(value => {
    if (!record(value) || !validFlutterId(value.id) || typeof value.name !== 'string' || value.name.length > 200 || value.isSupported === false || seen.has(value.id)) return [];
    seen.add(value.id);
    return [{ id: value.id, name: value.name.replace(/[\u0000-\u001f]/g, ' '), platform: typeof value.targetPlatform === 'string' ? value.targetPlatform.slice(0, 80) : typeof value.platform === 'string' ? value.platform.slice(0, 80) : 'device', emulator: value.emulator === true, ...(validFlutterId(value.emulatorId) ? { emulatorId: value.emulatorId } : {}) }];
  });
}

export function decodeFlutterMessages(line: string): FlutterMessage[] | null {
  if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Flutter machine line exceeded its limit.');
  if (!line.trimStart().startsWith('[')) return null;
  let data: unknown;
  try { data = JSON.parse(line); } catch { return null; }
  if (!Array.isArray(data) || data.length > 32) return null;
  const messages = data.filter((value): value is FlutterMessage => record(value)
    && (typeof value.event === 'string' && /^[a-zA-Z][a-zA-Z.]{0,80}$/.test(value.event) || typeof value.id === 'number' && Number.isSafeInteger(value.id) || typeof value.id === 'string' && value.id.length <= 100)
    && (value.params === undefined || record(value.params)));
  return messages.length === data.length ? messages : null;
}

/** Flutter sends newline-delimited JSON arrays, interleaved with ordinary logs. */
export class FlutterMachineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  push(chunk: Buffer | string): { line: string; messages: FlutterMessage[] | null }[] {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    if (Buffer.byteLength(this.pending) > 64 * 1024) throw new Error('Flutter machine line exceeded its limit.');
    return lines.map(line => ({ line: line.replace(/\r$/, ''), messages: decodeFlutterMessages(line.replace(/\r$/, '')) }));
  }
}

export function flutterCommand(id: number, method: 'app.restart' | 'app.stop' | 'emulator.getEmulators' | 'emulator.launch', params?: Record<string, unknown>): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid Flutter request identity.');
  if (method === 'app.restart' || method === 'app.stop') {
    if (!validFlutterId(params?.appId)) throw new Error('Flutter application is not ready.');
  } else if (method === 'emulator.launch' && !validFlutterId(params?.emulatorId)) throw new Error('Invalid Flutter emulator identity.');
  return JSON.stringify([{ id, method, ...(params ? { params } : {}) }]) + '\n';
}

export function flutterWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !url.port || Number(url.port) < 1 || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}
