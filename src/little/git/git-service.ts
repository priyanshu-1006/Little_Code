import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { redactSecrets } from '../context/redact-secrets';
import { LittleError } from '../shared/errors';
import { assertNotAborted, type InventoryFile, type WorkspaceService } from '../tools/workspace-service';

export const GIT_REVIEW_LIMITS = Object.freeze({ changes: 200, diffChars: 20_000, capturedBytes: 64 * 1024, timeoutMs: 8_000, filterDrivers: 64 });
export interface GitChange { path: string; originalPath?: string; index: string; worktree: string }
export interface GitStatus { available: boolean; branch: string; changes: GitChange[]; truncated: boolean }
export interface GitDiff { path: string; text: string; truncated: boolean }
interface GitRoot { path: string; dev: number; ino: number; executable: string; environment: NodeJS.ProcessEnv }
interface CommandOutput { code: number | null; text: string; truncated: boolean }
const EMPTY_STATUS: GitStatus = { available: false, branch: '', changes: [], truncated: false };
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const CONFIG = [
  'core.fsmonitor=false', 'core.preloadIndex=false', 'core.untrackedCache=false',
  `core.hooksPath=${NULL_FILE}`, 'core.pager=', `core.attributesFile=${NULL_FILE}`,
  'core.quotePath=false', 'core.safecrlf=false', 'core.alternateRefsCommand=',
  'diff.external=', 'diff.ignoreSubmodules=all', 'submodule.recurse=false', 'protocol.allow=never',
];

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function samePath(left: string, right: string): boolean { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function failed(message: string): LittleError { return new LittleError('TOOL_FAILED', message); }
function validRelative(value: string): boolean {
  return !!value && value.length <= 4_096 && !path.isAbsolute(value) && !/[\\:\u0000-\u001f]/.test(value) && !value.split('/').some(segment => !segment || segment === '.' || segment === '..');
}
function fixedPrefix(extraConfig: string[] = []): string[] {
  return ['--no-pager', '--no-optional-locks', '--literal-pathspecs', ...[...CONFIG, ...extraConfig].flatMap(value => ['-c', value])];
}

/** Protected Git review only. The service has no write/commit command API. */
export class GitService {
  constructor(private readonly workspace: WorkspaceService) {}

  private async root(signal: AbortSignal): Promise<GitRoot | undefined> {
    assertNotAborted(signal);
    const target = await this.workspace.resolvePath('.', signal);
    const stat = await fs.stat(target.absolutePath);
    const search = (process.env.PATH ?? '').split(path.delimiter).map(directory => directory.replace(/^"|"$/g, ''))
      .filter(directory => path.isAbsolute(directory) && !within(target.absolutePath, directory) && !within(this.workspace.root, directory));
    let executable: string | undefined;
    for (const directory of search) {
      assertNotAborted(signal);
      try {
        const candidate = await fs.realpath(path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
        if (!within(target.absolutePath, candidate) && !within(this.workspace.root, candidate) && (await fs.stat(candidate)).isFile()) { executable = candidate; break; }
      } catch { assertNotAborted(signal); }
    }
    if (!executable) return undefined;
    const environment: NodeJS.ProcessEnv = {
      PATH: search.join(path.delimiter), LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: NULL_FILE, GIT_CONFIG_GLOBAL: NULL_FILE,
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
      GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1',
    };
    // A small native-runtime allowlist excludes inherited Git redirects, preload variables, and secrets.
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
    return { path: target.absolutePath, dev: stat.dev, ino: stat.ino, executable, environment };
  }

  private async verifyRoot(root: GitRoot, signal: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    const current = await this.workspace.resolvePath('.', signal);
    const stat = await fs.stat(current.absolutePath);
    if (!samePath(current.absolutePath, root.path) || stat.dev !== root.dev || stat.ino !== root.ino) throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'The workspace root changed during Git review.');
  }

  private async run(root: GitRoot, args: string[], signal: AbortSignal): Promise<CommandOutput> {
    await this.verifyRoot(root, signal);
    assertNotAborted(signal);
    const child = childProcess.spawn(root.executable, args, { cwd: root.path, env: root.environment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let captured = 0;
    const output: Buffer[] = [];
    let reason: 'cancelled' | 'timeout' | 'limit' | undefined;
    let termination: Promise<void> | undefined;
    let launchError = false;
    const stop = (why: 'cancelled' | 'timeout' | 'limit') => {
      reason ??= why;
      if (termination || !child.pid) return;
      termination = (async () => {
        if (process.platform === 'win32') {
          await new Promise<void>(resolve => childProcess.execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 2_000, env: root.environment }, () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
          }));
        } else {
          try { process.kill(-child.pid!, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }
      })();
    };
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), GIT_REVIEW_LIMITS.timeoutMs);
    const capture = (chunk: Buffer, stdout: boolean) => {
      const remaining = Math.max(0, GIT_REVIEW_LIMITS.capturedBytes - captured);
      if (stdout && remaining) output.push(chunk.subarray(0, remaining));
      captured += chunk.length;
      if (captured > GIT_REVIEW_LIMITS.capturedBytes) stop('limit');
    };
    child.stdout?.on('data', chunk => capture(Buffer.from(chunk), true));
    child.stderr?.on('data', chunk => capture(Buffer.from(chunk), false));
    child.on('error', () => { launchError = true; });
    try {
      const code = await new Promise<number | null>(resolve => child.once('close', resolve));
      await termination;
      assertNotAborted(signal);
      if (reason === 'cancelled') throw new LittleError('AGENT_CANCELLED', 'Git review stopped.');
      if (reason === 'timeout') throw failed('Git review timed out. Retry after repository activity settles.');
      if (launchError) throw failed('The installed Git program could not start.');
      await this.verifyRoot(root, signal);
      return { code, text: Buffer.concat(output).toString('utf8'), truncated: reason === 'limit' };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  private async prepare(signal: AbortSignal): Promise<{ root: GitRoot; prefix: string[] } | undefined> {
    const root = await this.root(signal);
    if (!root) return undefined;
    const discovered = await this.run(root, [...fixedPrefix(), 'rev-parse', '--show-toplevel'], signal);
    if (discovered.code !== 0 || discovered.truncated) return undefined;
    let worktree: string;
    try { worktree = await fs.realpath(discovered.text.trim()); }
    catch { return undefined; }
    if (!samePath(worktree, root.path)) return undefined;
    // Status can run clean/process attribute filters while checking worktree content.
    const filters = await this.run(root, [...fixedPrefix(), 'config', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], signal);
    if (filters.truncated) throw new LittleError('CONTEXT_LIMIT', 'Git filter configuration exceeds the protected review limit.');
    if (filters.code !== 0 && filters.code !== 1) throw failed('Git filter configuration could not be inspected safely.');
    const drivers = new Set<string>();
    for (const key of filters.text.split('\u0000').filter(Boolean)) {
      if (!/^filter\.[A-Za-z0-9_.-]{1,128}\.(?:clean|smudge|process|required)$/.test(key)) throw new LittleError('PERMISSION_DENIED', 'A Git filter name cannot be safely neutralized for read-only review.');
      drivers.add(key.replace(/\.(?:clean|smudge|process|required)$/, ''));
    }
    if (drivers.size > GIT_REVIEW_LIMITS.filterDrivers) throw new LittleError('CONTEXT_LIMIT', 'Too many Git filter drivers for protected review.');
    const disabled = [...drivers].flatMap(driver => [`${driver}.clean=`, `${driver}.smudge=`, `${driver}.process=`, `${driver}.required=false`]);
    return { root, prefix: fixedPrefix(disabled) };
  }

  private async permitted(file: InventoryFile, signal: AbortSignal): Promise<boolean> {
    if (!validRelative(file.path)) return false;
    try {
      const target = await this.workspace.resolvePath(file.path, signal);
      const stat = await fs.lstat(target.absolutePath);
      return !target.isDirectory && target.relativePath === file.path && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.ino === file.ino && stat.dev === file.dev;
    } catch (error) {
      assertNotAborted(signal);
      if (error instanceof LittleError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async status(signal: AbortSignal): Promise<GitStatus> {
    const prepared = await this.prepare(signal);
    if (!prepared) return { ...EMPTY_STATUS, changes: [] };
    const inventory = await this.workspace.inventory(signal);
    const allowed = new Map(inventory.files.map(file => [file.path, file]));
    const result = await this.run(prepared.root, [...prepared.prefix, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=all', '--renames'], signal);
    if (result.code !== 0 && !result.truncated) throw failed('Git status could not be read safely.');
    const records = result.text.split('\u0000');
    // A capped output may end in the middle of a pathname; never include that last record.
    if (!result.text.endsWith('\u0000')) records.pop();
    let branch = '';
    const changes: GitChange[] = [];
    let truncated = result.truncated || inventory.truncated;
    for (let index = 0; index < records.length; index++) {
      assertNotAborted(signal);
      const record = records[index] ?? '';
      if (record.startsWith('## ')) {
        branch = redactSecrets(record.slice(3).replace(/^No commits yet on |^Initial commit on /, '').split('...')[0] ?? '').slice(0, 256);
        continue;
      }
      if (!/^[ MADRCU?!]{2} /.test(record)) continue;
      const status = record.slice(0, 2);
      const file = allowed.get(record.slice(3));
      const renamed = status.includes('R') || status.includes('C');
      const original = renamed ? records[++index] : undefined;
      if (!file || !await this.permitted(file, signal)) continue;
      if (changes.length >= GIT_REVIEW_LIMITS.changes) { truncated = true; break; }
      const originalFile = original ? allowed.get(original) : undefined;
      // Deleted paths and absent rename sources have no fresh policy-authorized inventory record.
      const originalPath = originalFile && await this.permitted(originalFile, signal) ? originalFile.path : undefined;
      changes.push({ path: file.path, ...(originalPath ? { originalPath } : {}), index: status[0]!, worktree: status[1]! });
    }
    await this.verifyRoot(prepared.root, signal);
    return { available: true, branch, changes, truncated };
  }

  async diff(input: string, staged: boolean, signal: AbortSignal): Promise<GitDiff> {
    if (typeof input !== 'string' || typeof staged !== 'boolean') throw new LittleError('TOOL_VALIDATION_FAILED', 'Git diff needs a workspace file path and a staged boolean.');
    const target = await this.workspace.resolvePath(input, signal);
    const prepared = await this.prepare(signal);
    if (!prepared) throw new LittleError('PERMISSION_DENIED', 'Git review requires the workspace folder to be the exact Git worktree root.');
    const inventory = await this.workspace.inventory(signal);
    const file = inventory.files.find(candidate => candidate.path === target.relativePath);
    if (!file || !await this.permitted(file, signal)) throw new LittleError('PERMISSION_DENIED', 'Git diffs are limited to allowed regular workspace files without links.');
    const tracked = await this.run(prepared.root, [...prepared.prefix, 'ls-files', '--error-unmatch', '--', file.path], signal);
    if (tracked.truncated || (tracked.code !== 0 && tracked.code !== 1)) throw failed('Git could not safely determine whether the file is tracked.');
    const untracked = !staged && tracked.code === 1;
    const options = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--ignore-submodules=all', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3'];
    if (staged) options.push('--cached');
    if (untracked) options.push('--no-index');
    const result = await this.run(prepared.root, [...prepared.prefix, ...options, '--', ...(untracked ? [NULL_FILE] : []), file.path], signal);
    if (result.code !== 0 && !(untracked && result.code === 1) && !result.truncated) throw failed('Git diff could not be read safely.');
    if (!await this.permitted(file, signal)) throw new LittleError('PERMISSION_DENIED', 'The file policy or identity changed during Git review.');
    const current = await fs.lstat(target.absolutePath);
    if (current.size !== file.bytes || current.mtimeMs !== file.modifiedMs || current.ctimeMs !== file.createdMs) throw failed('The file changed during Git review. Request a fresh diff.');
    const text = redactSecrets(result.text);
    return { path: file.path, text: text.slice(0, GIT_REVIEW_LIMITS.diffChars), truncated: result.truncated || text.length > GIT_REVIEW_LIMITS.diffChars };
  }
}
