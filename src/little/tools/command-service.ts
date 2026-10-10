import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { CommandResult, ProjectCommand, ToolRisk } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { classifyCommand } from '../permissions/command-risk';
import { redactSecrets } from '../context/redact-secrets';
import type { WorkspaceService } from './workspace-service';

export const CommandSchema = z.object({
  program: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3', 'pytest', 'cargo', 'go', 'dotnet', 'tsc', 'git']),
  args: z.array(z.string().min(1).max(512)).min(1).max(32),
  cwd: z.string().min(1).max(4096).default('.'),
  purpose: z.string().trim().min(1).max(500),
  timeoutMs: z.number().int().min(1000).max(120000).default(60000),
}).strict();

export interface CommandProposal { readonly id: string; readonly command: ProjectCommand; readonly risk: ToolRisk }
export interface CommandGrant { readonly approval: 'allow-once' }
interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number }
interface StoredCommand { proposal: CommandProposal; cwd: string; cwdIdentity: Fingerprint; rootIdentity: Fingerprint; executable: string; fingerprint: Fingerprint; signal: AbortSignal; abort: () => void }
const TOKEN = /^[A-Za-z0-9_./:@=,+\\-]+$/;
const OUTPUT_BYTES = 64 * 1024;
const OUTPUT_CHARS = 16000;

/** Arguments are separate tokens. This milestone excludes shells, eval, and higher-risk actions. */
export function validateCommand(input: unknown): ProjectCommand {
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Choose a supported development program, bounded arguments, relative folder, reason, and timeout.');
  const command = parsed.data;
  if (command.args.some(arg => redactSecrets(arg) !== arg || /^--?[\w-]*(?:api[-_]?key|token|secret|password|credential|authorization)[\w-]*$/i.test(arg.split('=')[0]!))) throw new LittleError('PERMISSION_DENIED', 'Credential values and credential flags are unavailable in agent commands.');
  if (command.args.some(arg => !TOKEN.test(arg) || /(?:^|[=/\\])\.\.(?:[\\/]|$)|(?:^|=)(?:[A-Za-z]:|[\\/])|(?:https?:|file:)/i.test(arg))) {
    throw new LittleError('PERMISSION_DENIED', 'Shell syntax, absolute paths, URLs, and parent paths are unavailable in agent commands.');
  }
  if (path.isAbsolute(command.cwd) || /(^|[\\/])\.\.($|[\\/])|^[A-Za-z]:|[\u0000-\u001f]/.test(command.cwd)) {
    throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'Command folders must stay inside the project.');
  }
  const first = command.args[0]!;
  if ((['npm', 'pnpm', 'yarn', 'bun'].includes(command.program) && !['test', 'run'].includes(first))
    || (command.program === 'node' && command.args.some(arg => arg.startsWith('-') && !/^(?:--test(?:-[a-z-]+)?(?:=[A-Za-z0-9_./:@=,+\\-]+)?|--no-warnings|--enable-source-maps)$/.test(arg)))
    || (['python', 'python3'].includes(command.program) && (first !== '-m' || command.args[1] !== 'pytest'))
    || (command.program === 'cargo' && !['test', 'check', 'build', 'clippy', 'fmt'].includes(first))
    || (command.program === 'go' && !['test', 'build', 'vet', 'fmt'].includes(first))
    || (command.program === 'dotnet' && !['test', 'build', 'format'].includes(first))
    || (command.program === 'git' && !['status', 'diff'].includes(first))) {
    throw new LittleError('PERMISSION_DENIED', 'This command action is unavailable. Agent execution currently supports project checks and local scripts.');
  }
  const risk = classifyCommand(`${command.program} ${command.args.join(' ')}`);
  if (risk === 'SENSITIVE' || risk === 'DANGEROUS') throw new LittleError('PERMISSION_DENIED', 'Package installation, credentials, network changes, and destructive commands are unavailable in this milestone.');
  // Approval binds to a private immutable copy, never the model/webview payload.
  return Object.freeze({ ...command, purpose: redactSecrets(command.purpose), args: Object.freeze([...command.args]) as unknown as string[] });
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:ELECTRON_|VSCODE_|NODE_OPTIONS$|NODE_PATH$)|(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete environment[key];
  }
  return environment;
}

async function executableFor(program: string): Promise<string> {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  const search = (process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory.replace(/^"|"$/g, '')));
  for (const directory of search) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), program + extension);
      try {
        const real = await fs.realpath(candidate);
        const stat = await fs.stat(real);
        if (stat.isFile()) { await fs.access(real, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return real; }
      } catch { /* Try the next explicit PATH location. */ }
    }
  }
  throw new LittleError('TOOL_FAILED', `${program} is not installed on PATH. Install the project toolchain and retry.`);
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Working-directory boundaries constrain launch location; commands retain the user's OS permissions. */
export class ProjectCommandService {
  private readonly pending = new Map<string, StoredCommand>();
  private readonly grants = new WeakMap<CommandGrant, string>();
  constructor(private readonly workspace: WorkspaceService) {}

  async stage(input: unknown, signal: AbortSignal): Promise<CommandProposal> {
    signal.throwIfAborted();
    const command = validateCommand(input);
    const target = await this.workspace.resolvePath(command.cwd, signal);
    if (!target.isDirectory) throw new LittleError('TOOL_VALIDATION_FAILED', 'The command folder must be a project directory.');
    const executable = await executableFor(command.program);
    signal.throwIfAborted();
    const fingerprint = await fs.stat(executable);
    const cwdIdentity = await fs.stat(target.absolutePath);
    const rootIdentity = await fs.stat(this.workspace.root);
    const proposal = Object.freeze({ id: randomBytes(16).toString('hex'), command: Object.freeze({ ...command, cwd: target.relativePath }), risk: classifyCommand(`${command.program} ${command.args.join(' ')}`) });
    const abort = () => this.discard(proposal.id);
    this.pending.set(proposal.id, { proposal, cwd: target.absolutePath, cwdIdentity, rootIdentity, executable, fingerprint, signal, abort });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { this.discard(proposal.id); signal.throwIfAborted(); }
    return proposal;
  }

  approve(proposal: CommandProposal): CommandGrant {
    if (this.pending.get(proposal.id)?.proposal !== proposal) throw new LittleError('PERMISSION_DENIED', 'This command approval expired.');
    const grant = Object.freeze({ approval: 'allow-once' as const });
    this.grants.set(grant, proposal.id);
    return grant;
  }
  discard(id: string): void {
    const stored = this.pending.get(id);
    stored?.signal.removeEventListener('abort', stored.abort);
    this.pending.delete(id);
  }

  async execute(proposal: CommandProposal, grant: CommandGrant, signal: AbortSignal): Promise<CommandResult> {
    const stored = this.pending.get(proposal.id);
    if (!stored || stored.proposal !== proposal || stored.signal !== signal || this.grants.get(grant) !== proposal.id) throw new LittleError('PERMISSION_DENIED', 'A current host-owned Allow once approval is required.');
    this.grants.delete(grant);
    this.discard(proposal.id);
    signal.throwIfAborted();
    const cwd = await this.workspace.resolvePath(proposal.command.cwd, signal);
    const currentCwd = await fs.stat(cwd.absolutePath);
    const currentRoot = await fs.stat(this.workspace.root);
    if (cwd.absolutePath !== stored.cwd || currentCwd.dev !== stored.cwdIdentity.dev || currentCwd.ino !== stored.cwdIdentity.ino
      || currentRoot.dev !== stored.rootIdentity.dev || currentRoot.ino !== stored.rootIdentity.ino
      || !sameFingerprint(await fs.stat(stored.executable), stored.fingerprint)) throw new LittleError('PERMISSION_DENIED', 'The command executable or folder changed. Request fresh approval.');
    const args = proposal.command.args;
    let executable = stored.executable;
    let launchArgs = [...args];
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
      // cmd shims are common for npm/tsc. Reject every expansion/composition character in their path.
      if (/["%\^!&|<>\r\n]/.test(executable)) throw new LittleError('PERMISSION_DENIED', 'The toolchain path contains unsupported shell characters.');
      launchArgs = ['/d', '/s', '/c', `""${executable}" ${args.map(arg => `"${arg}"`).join(' ')}"`];
      executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    }
    const started = Date.now();
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(executable, launchArgs, { cwd: stored.cwd, env: cleanEnvironment(), shell: false, windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32' && /cmd\.exe$/i.test(executable), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stopReason: CommandResult['status'] | undefined;
      let stoppedTree: Promise<boolean> = Promise.resolve(true);
      let finished = false;
      let forcedTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); if (forcedTimer) clearTimeout(forcedTimer); signal.removeEventListener('abort', abort); };
      const finish = (status: CommandResult['status'], code: number | null) => {
        if (finished) return;
        finished = true; cleanup();
        const decoded = Buffer.concat(chunks).toString('utf8');
        const redacted = redactSecrets(decoded).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        resolve({ status, exitCode: status === 'exited' ? code : null, output: redacted.slice(0, OUTPUT_CHARS), truncated: bytes > OUTPUT_BYTES || redacted.length > OUTPUT_CHARS,
          durationMs: Date.now() - started });
      };
      const stop = (reason: CommandResult['status']) => {
        if (finished || stopReason) return;
        stopReason = reason;
        if (child.pid) {
          if (process.platform === 'win32') {
            stoppedTree = new Promise(resolveStop => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, error => resolveStop(!error)));
          } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); stoppedTree = Promise.resolve(false); } }
        }
        forcedTimer = setTimeout(() => { if (!finished) { cleanup(); finished = true; reject(new LittleError('TOOL_FAILED', 'Could not confirm the stopped command exited. Check the project processes before retrying.')); } }, 5000);
      };
      const collect = (chunk: Buffer) => {
        if (finished) return;
        const remaining = OUTPUT_BYTES - bytes;
        bytes += chunk.length;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        if (bytes > OUTPUT_BYTES) stop('output_limit');
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timed_out'), proposal.command.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.once('error', () => finish('failed', null));
      child.once('close', code => {
        if (!stopReason) finish(code === null ? 'failed' : 'exited', code);
        else void stoppedTree.then(confirmed => {
          if (!confirmed) chunks.push(Buffer.from('\nCould not confirm the complete process tree stopped. Check project processes.'));
          finish(confirmed ? stopReason! : 'failed', null);
        });
      });
    });
  }
}
