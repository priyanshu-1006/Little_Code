import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ignore from 'ignore';
import { redactSecrets } from '../context/redact-secrets';
import { LittleError, type LittleErrorCode } from '../shared/errors';
import { assertNotAborted, WORKSPACE_LIMITS, WorkspaceService } from './workspace-service';

export const EDIT_PROPOSAL_LIMITS = Object.freeze({ maxFiles: 8, maxReplacements: 32, maxFileBytes: WORKSPACE_LIMITS.maxFileBytes, maxTotalBytes: 1024 * 1024, maxBinaryFileBytes: 16 * 1024 * 1024, maxBinaryTotalBytes: 32 * 1024 * 1024, maxReviewChars: 16_384, maxDiffChars: 16_000, maxPending: 8 });
export type WorkspaceEdit =
  | { kind: 'replace'; path: string; replacements: readonly { search: string; replacement: string }[] }
  | { kind: 'create'; path: string; content: string }
  | { kind: 'delete'; path: string };
/** Internal format adapters provide bytes and source-derived summaries, never model base64. */
export interface WorkspaceBinaryEdit {
  kind: 'binary'; path: string; operation: 'create' | 'replace'; content: Uint8Array; expectedHash: string | null;
  preview: { original: string | null; proposed: string };
}
export interface EditChange {
  readonly path: string; readonly kind: 'replace' | 'create' | 'delete'; readonly beforeHash: string | null; readonly afterHash: string | null;
  readonly beforeBytes: number; readonly afterBytes: number; readonly diff: string; readonly diffTruncated: boolean;
}
export interface EditProposal { readonly id: string; readonly changes: readonly EditChange[] }
/** Private host material for native diff documents. Never send this through model tools. */
export interface EditPreview { readonly path: string; readonly original: string | null; readonly proposed: string }
/** Only accept() can mint a grant recognized by this service; JSON lookalikes fail. */
export interface HostEditAcceptance { readonly proposalId: string; readonly accepted: true }
export interface EditRecovery { restored: string[]; conflicts: { path: string; reason: string; recoveryPath?: string }[]; cleanupPaths?: string[] }
export interface CheckpointSummary { readonly id: string; readonly state: 'prepared' | 'applied' | 'rolled-back' | 'partial'; readonly interrupted: boolean; readonly paths: readonly string[]; readonly modifiedMs: number }
export interface EditApplyResult {
  proposalId: string; checkpointId: string; status: 'applied' | 'failed' | 'cancelled'; changes: readonly EditChange[];
  recovery?: EditRecovery; error?: { code: LittleErrorCode; message: string };
  cleanupPaths?: readonly string[];
}

interface Identity { dev: string; ino: string }
interface Fingerprint extends Identity { hash: string; size: number; modified: string; mode: number }
interface Snapshot { absolute: string; relative: string; bytes?: Buffer; fingerprint?: Fingerprint; mode: number }
interface StagedEdit { snapshot: Snapshot; after?: Buffer; change: EditChange; hostPreview?: EditPreview }
interface Pending { proposal: EditProposal; edits: StagedEdit[]; root: string; identity: Identity; storage: string; storageIdentity: Identity; accepted: boolean; signal?: AbortSignal; onAbort?: () => void }
interface MutationIntent { operation: 'apply' | 'restore'; phase: 'prepared' | 'installing'; scratch: string; identity: Identity; expected?: Fingerprint; desired?: Fingerprint }
interface CheckpointEntry { path: string; beforeHash: string | null; afterHash: string | null; mode: number; applied: boolean; afterIdentity?: Fingerprint; intent?: MutationIntent }
interface Checkpoint { version: 1 | 2; id: string; proposalId: string; root: string; identity: Identity; state: 'prepared' | 'applied' | 'rolled-back' | 'partial'; entries: CheckpointEntry[] }

const BLOCKED_NAMES = /^(?:\.env.*|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const BLOCKED_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore)$/i;
const EXCLUDED = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'generated', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__']);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: BigIntStats): Identity => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const fingerprint = (bytes: Buffer, stat: BigIntStats): Fingerprint => ({ ...identity(stat), hash: digest(bytes), size: bytes.length, modified: stat.mtimeNs.toString(), mode: Number(stat.mode & 0o777n) });
const sameFile = (a: Fingerprint | undefined, b: Fingerprint | undefined) => a === undefined ? b === undefined : b !== undefined && sameIdentity(a, b) && a.hash === b.hash && a.size === b.size && a.modified === b.modified && a.mode === b.mode;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function fail(code: LittleErrorCode, message: string): never { throw new LittleError(code, message); }
function inside(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); }

function relativePath(input: string): string {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\u0000-\u001f]/.test(input)) fail('TOOL_VALIDATION_FAILED', 'A nonempty relative file path is required.');
  if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Edit paths must be relative to the workspace.');
  const segments = input.replaceAll('\\', '/').split('/');
  if (segments.some(segment => segment === '..')) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Edit paths cannot contain traversal.');
  if (segments.length > WORKSPACE_LIMITS.maxDepth || segments.some(segment => !segment || segment === '.' || /[:<>"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) fail('TOOL_VALIDATION_FAILED', 'The file path has an unsupported or ambiguous component.');
  if (segments.some(segment => BLOCKED_NAMES.test(segment) || BLOCKED_EXTENSIONS.test(segment) || EXCLUDED.has(segment.toLowerCase()) || segment.toLowerCase().startsWith('.little-edit-') || ['.gitignore', '.littleignore'].includes(segment.toLowerCase()))) fail('PERMISSION_DENIED', 'Sensitive, generated, ignore policy, and edit recovery paths cannot be modified.');
  return segments.join('/');
}

function textBytes(value: string): Buffer {
  if (typeof value !== 'string' || value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > EDIT_PROPOSAL_LIMITS.maxFileBytes || Buffer.from(value, 'utf8').toString('utf8') !== value) fail('TOOL_VALIDATION_FAILED', 'Edits require bounded valid UTF-8 text without NUL characters.');
  return Buffer.from(value, 'utf8');
}
function text(bytes: Buffer): string {
  try { const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (value.includes('\u0000')) throw new Error('Binary'); return value; }
  catch { return fail('TOOL_VALIDATION_FAILED', 'Only UTF-8 text files can be edited.'); }
}
function diff(before: Buffer | undefined, after: Buffer | undefined, relative: string, budget: number) {
  const oldLines = redactSecrets(before ? text(before) : '').split(/\r?\n/);
  const newLines = after ? redactSecrets(text(after)).split(/\r?\n/) : [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  const body = `--- ${before ? `a/${relative}` : '/dev/null'}\n+++ ${after ? `b/${relative}` : '/dev/null'}\n@@ -${start + 1},${endOld - start} +${start + 1},${endNew - start} @@\n${oldLines.slice(start, endOld).map(line => `-${line}`).join('\n')}\n${newLines.slice(start, endNew).map(line => `+${line}`).join('\n')}`;
  return { diff: body.slice(0, budget), diffTruncated: body.length > budget };
}

function parseCheckpoint(value: unknown): Checkpoint {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const validIdentity = (item: unknown): item is Identity => record(item) && typeof item.dev === 'string' && /^\d{1,30}$/.test(item.dev) && typeof item.ino === 'string' && /^\d{1,30}$/.test(item.ino);
  const validHash = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  const validFingerprint = (item: unknown): item is Fingerprint => validIdentity(item) && record(item) && validHash(item.hash) && typeof item.size === 'number' && Number.isInteger(item.size) && item.size >= 0 && item.size <= EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes && typeof item.modified === 'string' && /^-?\d{1,30}$/.test(item.modified) && typeof item.mode === 'number' && Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o777;
  if (!record(value) || (value.version !== 1 && value.version !== 2) || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id) || typeof value.proposalId !== 'string' || !/^[a-f0-9]{32}$/.test(value.proposalId) || typeof value.root !== 'string' || !validIdentity(value.identity) || !['prepared', 'applied', 'rolled-back', 'partial'].includes(String(value.state)) || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > EDIT_PROPOSAL_LIMITS.maxFiles) fail('TOOL_VALIDATION_FAILED', 'Invalid checkpoint metadata.');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.path !== 'string' || (entry.afterHash !== null && !validHash(entry.afterHash)) || (entry.beforeHash !== null && !validHash(entry.beforeHash)) || (entry.beforeHash === null && entry.afterHash === null) || (value.version === 1 && entry.afterHash === null) || typeof entry.mode !== 'number' || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || typeof entry.applied !== 'boolean' || (entry.afterIdentity !== undefined && !validFingerprint(entry.afterIdentity))) fail('TOOL_VALIDATION_FAILED', 'Invalid checkpoint entry metadata.');
    const relative = relativePath(entry.path);
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (relative !== entry.path || seen.has(key) || (entry.applied && entry.afterHash !== null && !entry.afterIdentity) || (entry.afterHash === null && entry.afterIdentity !== undefined)) fail('TOOL_VALIDATION_FAILED', 'Ambiguous checkpoint entry metadata.');
    if (entry.intent !== undefined) {
      const intent = entry.intent;
      if (value.version !== 2 || !record(intent) || !['apply', 'restore'].includes(String(intent.operation)) || !['prepared', 'installing'].includes(String(intent.phase)) || typeof intent.scratch !== 'string' || !/^\.little-edit-[a-f0-9]{32}$/.test(intent.scratch) || !validIdentity(intent.identity) || (intent.expected !== undefined && !validFingerprint(intent.expected)) || (intent.desired !== undefined && !validFingerprint(intent.desired))) fail('TOOL_VALIDATION_FAILED', 'Invalid checkpoint mutation journal.');
      const expected = intent.expected as Fingerprint | undefined, desired = intent.desired as Fingerprint | undefined;
      if (intent.operation === 'apply' ? (expected?.hash ?? null) !== entry.beforeHash || (desired?.hash ?? null) !== entry.afterHash : (expected?.hash ?? null) !== entry.afterHash || (desired?.hash ?? null) !== entry.beforeHash) fail('TOOL_VALIDATION_FAILED', 'Checkpoint mutation journal hashes do not match the edit.');
    }
    seen.add(key);
  }
  return value as unknown as Checkpoint;
}

/**
 * A host-controlled edit building block, deliberately absent from the agent tool router.
 * Call accept() only after a trusted host UI accepts the immutable proposal. Checkpoint
 * storage must already exist outside the workspace. New files need an existing parent.
 * Per-file installation uses exclusive hard links, never an overwriting rename. Portable
 * Node cannot lock other processes' open handles or mutable ancestor directories; the
 * host must serialize its own saves. This is not a hostile-process filesystem sandbox.
 */
export class EditProposalService {
  private readonly pending = new Map<string, Pending>();
  private readonly grants = new WeakMap<HostEditAcceptance, string>();
  private readonly checkpointIdentities = new Map<string, Identity>();
  private mutating = false;

  constructor(private readonly workspace: WorkspaceService, private readonly checkpointDirectory: string) {}

  private async roots(signal?: AbortSignal) {
    assertNotAborted(signal);
    const root = await fs.realpath(this.workspace.root);
    const rootStat = await fs.stat(root, { bigint: true });
    const storage = await fs.realpath(this.checkpointDirectory);
    const storageStat = await fs.lstat(storage, { bigint: true });
    const requestedStorage = await fs.lstat(this.checkpointDirectory);
    if (!rootStat.isDirectory() || !storageStat.isDirectory() || requestedStorage.isSymbolicLink() || path.relative(path.resolve(this.checkpointDirectory), storage) !== '' || inside(root, storage)) fail('TOOL_VALIDATION_FAILED', 'Private checkpoint storage must be an unaliased directory outside the workspace.');
    assertNotAborted(signal);
    return { root, identity: identity(rootStat), storage, storageIdentity: identity(storageStat) };
  }

  private async noLinks(root: string, relative: string, allowMissingLeaf: boolean, signal?: AbortSignal, ownedLink?: Fingerprint): Promise<void> {
    const segments = relative.split('/');
    let target = root;
    for (let i = 0; i < segments.length; i++) {
      assertNotAborted(signal);
      target = path.join(target, segments[i]!);
      let stat;
      try { stat = await fs.lstat(target, { bigint: true }); }
      catch (error) { if (allowMissingLeaf && i === segments.length - 1 && isMissing(error)) return; throw error; }
      if (stat.isSymbolicLink()) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Edits cannot follow symbolic links or directory junctions.');
      if (i < segments.length - 1 && !stat.isDirectory()) fail('TOOL_VALIDATION_FAILED', 'A parent component is not a directory.');
      if (i === segments.length - 1 && stat.isFile() && stat.nlink > 1n && !(stat.nlink === 2n && ownedLink && sameIdentity(identity(stat), ownedLink))) fail('PERMISSION_DENIED', 'Hard-linked files cannot be edited.');
    }
  }

  private async ignored(root: string, relative: string, signal?: AbortSignal): Promise<boolean> {
    const segments = relative.split('/');
    const rules = new Map<string, ReturnType<typeof ignore>>();
    for (let end = 1; end <= segments.length; end++) {
      let excluded = false;
      for (let base = 0; base < end; base++) {
        const directory = segments.slice(0, base).join('/');
        let matcher = rules.get(directory);
        if (!matcher) {
          matcher = ignore();
          for (const name of ['.gitignore', '.littleignore']) {
            const rulePath = [directory, name].filter(Boolean).join('/');
            try {
              await this.noLinks(root, rulePath, false, signal);
              const data = await this.read(path.join(root, rulePath), WORKSPACE_LIMITS.maxIgnoreBytes, signal);
              matcher.add(text(data.bytes));
            } catch (error) { if (!isMissing(error)) throw error; }
          }
          rules.set(directory, matcher);
        }
        const decision = matcher.test(segments.slice(base, end).join('/') + (end < segments.length ? '/' : ''));
        if (decision.ignored) excluded = true;
        else if (decision.unignored) excluded = false;
      }
      if (excluded) return true;
    }
    return false;
  }

  private async read(absolute: string, limit: number, signal?: AbortSignal) {
    assertNotAborted(signal);
    const before = await fs.lstat(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) fail('WORKSPACE_BOUNDARY_VIOLATION', 'A regular file is required.');
    if (before.size > BigInt(limit)) fail('CONTEXT_LIMIT', 'The file exceeds the edit or checkpoint budget.');
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(identity(before), identity(opened))) fail('WORKSPACE_BOUNDARY_VIOLATION', 'The file changed during access checks.');
      if (opened.size > BigInt(limit)) fail('CONTEXT_LIMIT', 'The file exceeds the edit or checkpoint budget.');
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        assertNotAborted(signal);
        const next = await handle.read(bytes, count, bytes.length - count, count);
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      assertNotAborted(signal);
      if (count > limit) fail('CONTEXT_LIMIT', 'The file exceeds the edit or checkpoint budget.');
      if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || BigInt(count) !== after.size) fail('TOOL_FAILED', 'The file changed while being read.');
      return { bytes: bytes.subarray(0, count), fingerprint: fingerprint(bytes.subarray(0, count), after), mode: Number(after.mode & 0o777n) };
    } finally { await handle.close(); }
  }

  private async snapshot(root: string, input: string, signal?: AbortSignal, ownedLink?: Fingerprint, binary = false): Promise<Snapshot> {
    const relative = relativePath(input);
    await this.noLinks(root, relative, true, signal, ownedLink);
    const parent = path.posix.dirname(relative);
    const resolvedParent = await this.workspace.resolvePath(parent, signal);
    const expectedParent = path.join(root, parent);
    if (!resolvedParent.isDirectory || path.relative(expectedParent, resolvedParent.absolutePath) !== '') fail('WORKSPACE_BOUNDARY_VIOLATION', 'The parent directory moved or aliases another path.');
    if (await this.ignored(root, relative, signal)) fail('PERMISSION_DENIED', 'The edit path is excluded by workspace ignore rules.');
    const absolute = path.join(root, relative);
    try {
      const resolved = await this.workspace.resolvePath(relative, signal);
      if (resolved.isDirectory || path.relative(absolute, resolved.absolutePath) !== '') fail('TOOL_VALIDATION_FAILED', 'An unaliased regular file is required.');
      const current = await this.read(absolute, binary ? EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes : EDIT_PROPOSAL_LIMITS.maxFileBytes, signal);
      await this.noLinks(root, relative, false, signal, ownedLink);
      if (ownedLink && (await fs.lstat(absolute, { bigint: true })).nlink > 1n && !sameFile(ownedLink, current.fingerprint)) fail('TOOL_FAILED', 'The interrupted candidate has changed.');
      if (!binary) text(current.bytes);
      return { absolute, relative, ...current };
    } catch (error) { if (!isMissing(error)) throw error; return { absolute, relative, mode: 0o644 }; }
  }

  async stage(edits: readonly WorkspaceEdit[], signal?: AbortSignal): Promise<EditProposal> {
    assertNotAborted(signal);
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > EDIT_PROPOSAL_LIMITS.maxFiles || this.pending.size >= EDIT_PROPOSAL_LIMITS.maxPending) fail('TOOL_VALIDATION_FAILED', 'The proposal has too many files or pending proposals.');
    const roots = await this.roots(signal);
    const staged: StagedEdit[] = [];
    const seen = new Set<string>();
    let bytes = 0, textBudget = 0, diffBudget = EDIT_PROPOSAL_LIMITS.maxDiffChars;
    for (const edit of edits) {
      if (!edit || !['replace', 'create', 'delete'].includes(edit.kind)) fail('TOOL_VALIDATION_FAILED', 'Only literal replacements, new text files, and regular-file deletions are supported.');
      if (edit.kind !== 'delete' && /\.(?:ipynb|docx|pptx|pdf)$/i.test(edit.path)) fail('TOOL_VALIDATION_FAILED', 'Use the dedicated notebook or document tool to create or edit this format. Generic text edits can corrupt its structure.');
      const snapshot = await this.snapshot(roots.root, edit.path, signal, undefined, edit.kind === 'delete');
      const key = process.platform === 'win32' ? snapshot.relative.toLowerCase() : snapshot.relative;
      if (seen.has(key)) fail('TOOL_VALIDATION_FAILED', 'A file can appear only once in an edit proposal.');
      seen.add(key);
      let after: Buffer | undefined, hostPreview: EditPreview | undefined;
      if (edit.kind === 'create') {
        if (snapshot.bytes) fail('TOOL_VALIDATION_FAILED', 'A new file must not already exist.');
        after = textBytes(edit.content);
      } else if (edit.kind === 'delete') {
        if (!snapshot.bytes) fail('TOOL_VALIDATION_FAILED', 'Deletion requires an existing regular file.');
      } else {
        if (!snapshot.bytes || !Array.isArray(edit.replacements) || !edit.replacements.length || edit.replacements.length > EDIT_PROPOSAL_LIMITS.maxReplacements) fail('TOOL_VALIDATION_FAILED', 'Replacements require an existing text file and a bounded replacement list.');
        let content = text(snapshot.bytes);
        for (const replacement of edit.replacements) {
          assertNotAborted(signal);
          if (!replacement || !replacement.search) fail('TOOL_VALIDATION_FAILED', 'A replacement search must not be empty.');
          textBytes(replacement.search); textBytes(replacement.replacement);
          const index = content.indexOf(replacement.search);
          if (index < 0 || content.indexOf(replacement.search, index + 1) >= 0) fail('TOOL_VALIDATION_FAILED', 'Each literal replacement must match exactly once.');
          content = content.slice(0, index) + replacement.replacement + content.slice(index + replacement.search.length);
          textBytes(content);
        }
        after = textBytes(content);
        if (after.equals(snapshot.bytes)) fail('TOOL_VALIDATION_FAILED', 'A replacement must change the file.');
      }
      const cost = (snapshot.bytes?.length ?? 0) + (after?.length ?? 0);
      bytes += cost;
      if (edit.kind !== 'delete') textBudget += cost;
      if (textBudget > EDIT_PROPOSAL_LIMITS.maxTotalBytes || bytes > EDIT_PROPOSAL_LIMITS.maxBinaryTotalBytes) fail('CONTEXT_LIMIT', 'The proposal exceeds the total checkpoint budget.');
      let preview;
      try {
        if (edit.kind === 'delete' && snapshot.bytes!.length > EDIT_PROPOSAL_LIMITS.maxFileBytes) throw new LittleError('TOOL_VALIDATION_FAILED', 'Use a bounded byte summary for this deletion.');
        preview = diff(snapshot.bytes, after, snapshot.relative, diffBudget);
      } catch (error) {
        if (edit.kind !== 'delete' || !(error instanceof LittleError) || error.code !== 'TOOL_VALIDATION_FAILED') throw error;
        hostPreview = { path: snapshot.relative, original: `Regular file: ${snapshot.relative}\nBytes: ${snapshot.bytes!.length}\nSHA-256: ${snapshot.fingerprint!.hash}\n`, proposed: `DELETE ${snapshot.relative}\nThe exact original bytes will be saved in the private recovery checkpoint.\n` };
        preview = diff(Buffer.from(hostPreview.original!), Buffer.from(hostPreview.proposed), snapshot.relative, diffBudget);
      }
      diffBudget -= preview.diff.length;
      const change = Object.freeze({ path: snapshot.relative, kind: edit.kind, beforeHash: snapshot.fingerprint?.hash ?? null, afterHash: after ? digest(after) : null, beforeBytes: snapshot.bytes?.length ?? 0, afterBytes: after?.length ?? 0, ...preview });
      staged.push({ snapshot, after, change, hostPreview });
    }
    return this.register(staged, roots, signal);
  }

  /** Bytes are copied before staging, then bound to a fresh independently-read original. */
  async stageBinary(edits: readonly WorkspaceBinaryEdit[], signal?: AbortSignal): Promise<EditProposal> {
    assertNotAborted(signal);
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > EDIT_PROPOSAL_LIMITS.maxFiles || this.pending.size >= EDIT_PROPOSAL_LIMITS.maxPending) fail('TOOL_VALIDATION_FAILED', 'The byte proposal has too many files or pending proposals.');
    const normalized = edits.map(edit => {
      if (!edit || edit.kind !== 'binary' || !['create', 'replace'].includes(edit.operation) || !(edit.content instanceof Uint8Array) || edit.content.byteLength > EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes || !edit.preview || typeof edit.preview.proposed !== 'string' || edit.preview.proposed.length > EDIT_PROPOSAL_LIMITS.maxReviewChars || (edit.preview.original !== null && (typeof edit.preview.original !== 'string' || edit.preview.original.length > EDIT_PROPOSAL_LIMITS.maxReviewChars))) fail('TOOL_VALIDATION_FAILED', 'Format proposals require bounded bytes and source-derived review summaries.');
      if (edit.operation === 'create' ? edit.expectedHash !== null || edit.preview.original !== null : typeof edit.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(edit.expectedHash) || edit.preview.original === null) fail('TOOL_VALIDATION_FAILED', 'A format replacement must bind to the exact original hash; a creation requires an absent original.');
      return { ...edit, content: Buffer.from(edit.content), preview: { ...edit.preview } };
    });
    const roots = await this.roots(signal), staged: StagedEdit[] = [], seen = new Set<string>();
    let total = 0, diffBudget = EDIT_PROPOSAL_LIMITS.maxDiffChars;
    for (const edit of normalized) {
      const snapshot = await this.snapshot(roots.root, edit.path, signal, undefined, true);
      const key = process.platform === 'win32' ? snapshot.relative.toLowerCase() : snapshot.relative;
      if (seen.has(key)) fail('TOOL_VALIDATION_FAILED', 'A file can appear only once in a format proposal.');
      seen.add(key);
      if ((snapshot.fingerprint?.hash ?? null) !== edit.expectedHash || (edit.operation === 'replace' && !snapshot.bytes)) fail('TOOL_FAILED', 'The format input changed or its expected original was not found. Read it again before proposing changes.');
      if (snapshot.bytes?.equals(edit.content)) fail('TOOL_VALIDATION_FAILED', 'A format replacement must change the file.');
      total += (snapshot.bytes?.length ?? 0) + edit.content.length;
      if (total > EDIT_PROPOSAL_LIMITS.maxBinaryTotalBytes) fail('CONTEXT_LIMIT', 'The format proposal exceeds the aggregate byte checkpoint budget.');
      const afterHash = digest(edit.content);
      const describe = (bytes: number, hash: string | null, summary: string | null) => `File: ${snapshot.relative}\nBytes: ${bytes}\nSHA-256: ${hash ?? '[absent]'}\n\n${redactSecrets(summary ?? 'No existing file.')}\n`;
      const hostPreview = Object.freeze({ path: snapshot.relative, original: edit.operation === 'create' ? null : describe(snapshot.bytes!.length, edit.expectedHash, edit.preview.original), proposed: describe(edit.content.length, afterHash, edit.preview.proposed) });
      const preview = diff(hostPreview.original === null ? undefined : Buffer.from(hostPreview.original), Buffer.from(hostPreview.proposed), snapshot.relative, diffBudget);
      diffBudget -= preview.diff.length;
      const change: EditChange = Object.freeze({ path: snapshot.relative, kind: edit.operation, beforeHash: edit.expectedHash, afterHash, beforeBytes: snapshot.bytes?.length ?? 0, afterBytes: edit.content.length, ...preview });
      staged.push({ snapshot, after: edit.content, change, hostPreview });
    }
    return this.register(staged, roots, signal);
  }

  private register(staged: StagedEdit[], roots: Awaited<ReturnType<EditProposalService['roots']>>, signal?: AbortSignal): EditProposal {
    assertNotAborted(signal);
    if (this.pending.size >= EDIT_PROPOSAL_LIMITS.maxPending) fail('TOOL_VALIDATION_FAILED', 'The pending proposal limit was reached.');
    const proposal = Object.freeze({ id: randomUUID().replaceAll('-', ''), changes: Object.freeze(staged.map(edit => edit.change)) });
    const onAbort = () => this.discard(proposal.id);
    this.pending.set(proposal.id, { proposal, edits: staged, ...roots, accepted: false, signal, onAbort });
    signal?.addEventListener('abort', onAbort, { once: true });
    return proposal;
  }

  preview(proposalId: string): readonly EditPreview[] {
    const pending = this.pending.get(proposalId);
    if (!pending) fail('PERMISSION_DENIED', 'Only a pending proposal has a private host preview.');
    assertNotAborted(pending.signal);
    return Object.freeze(pending.edits.map(edit => Object.freeze(edit.hostPreview ?? { path: edit.snapshot.relative, original: edit.snapshot.bytes ? text(edit.snapshot.bytes) : null, proposed: edit.after ? text(edit.after) : '' })));
  }

  accept(proposalId: string): HostEditAcceptance {
    const pending = this.pending.get(proposalId);
    if (!pending || pending.accepted) fail('PERMISSION_DENIED', 'A pending proposal needs a fresh explicit host acceptance.');
    assertNotAborted(pending.signal);
    pending.accepted = true;
    const grant = Object.freeze({ proposalId, accepted: true as const });
    this.grants.set(grant, proposalId);
    return grant;
  }

  discard(proposalId: string): void {
    const pending = this.pending.get(proposalId);
    if (pending?.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
    this.pending.delete(proposalId);
  }

  private async save(file: string, bytes: Buffer, exclusive = true, mode = 0o600): Promise<void> {
    const handle = await fs.open(file, exclusive ? 'wx' : 'w', mode);
    try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
  }
  private async syncDirectory(directory: string): Promise<void> {
    // Directory fsync is available on POSIX. Windows flushes the file handles but
    // does not expose a portable directory flush through Node.
    let handle;
    try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
    catch (error) { if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error; }
    finally { await handle?.close(); }
  }
  private async checkpointStorage(directory: string): Promise<void> {
    const stat = await fs.lstat(directory, { bigint: true });
    const pinned = this.checkpointIdentities.get(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '' || (pinned && !sameIdentity(pinned, identity(stat)))) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Checkpoint storage moved or became a link.');
    this.checkpointIdentities.set(directory, identity(stat));
  }
  private async saveManifest(directory: string, checkpoint: Checkpoint) {
    await this.checkpointStorage(directory);
    const candidate = path.join(directory, `manifest-${randomUUID()}.tmp`);
    await this.save(candidate, Buffer.from(`${JSON.stringify(checkpoint)}\n`));
    await this.checkpointStorage(directory);
    await fs.rename(candidate, path.join(directory, 'manifest.json'));
    await this.syncDirectory(directory);
  }

  /** The intent is durable before the first workspace rename, including both inodes. */
  private async mutate(checkpoint: Checkpoint, directory: string, index: number, operation: MutationIntent['operation'], expected: Fingerprint | undefined, desired: Buffer | undefined, signal?: AbortSignal): Promise<{ fingerprint?: Fingerprint; cleanupPaths: string[] }> {
    const entry = checkpoint.entries[index]!, root = checkpoint.root, relative = entry.path;
    if (entry.intent) fail('TOOL_FAILED', 'An interrupted mutation needs recovery before another write.');
    const current = await this.snapshot(root, relative, signal, undefined, true);
    if (!sameFile(expected, current.fingerprint)) fail('TOOL_FAILED', `The file changed: ${relative}`);
    const scratchName = `.little-edit-${randomUUID().replaceAll('-', '')}`;
    const scratch = path.join(path.dirname(current.absolute), scratchName);
    await fs.mkdir(scratch, { mode: 0o700 });
    const candidate = path.join(scratch, 'candidate');
    const displaced = path.join(scratch, 'displaced');
    let journaled = false, installed = false, installedIdentity: Fingerprint | undefined;
    try {
      if (desired !== undefined) {
        await this.save(candidate, desired, true, entry.mode);
        installedIdentity = (await this.read(candidate, EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes, signal)).fingerprint;
      }
      await this.syncDirectory(scratch);
      checkpoint.version = 2;
      entry.intent = { operation, phase: 'prepared', scratch: scratchName, identity: identity(await fs.lstat(scratch, { bigint: true })), ...(expected ? { expected } : {}), ...(installedIdentity ? { desired: installedIdentity } : {}) };
      await this.saveManifest(directory, checkpoint);
      journaled = true;
      assertNotAborted(signal);
      const rechecked = await this.snapshot(root, relative, signal, undefined, true);
      if (!sameFile(expected, rechecked.fingerprint)) fail('TOOL_FAILED', `The file changed: ${relative}`);
      if (expected) {
        await fs.rename(current.absolute, displaced);
        await this.syncDirectory(path.dirname(current.absolute));
        if (!sameFile(expected, (await this.read(displaced, EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes, signal)).fingerprint)) fail('TOOL_FAILED', `The file changed during replacement: ${relative}`);
      }
      assertNotAborted(signal);
      await this.noLinks(root, relative, true, signal);
      if (desired !== undefined) {
        // Missing after this flush is ambiguous: the candidate might have been
        // installed and later deleted. Recovery must preserve that deletion.
        entry.intent.phase = 'installing';
        await this.saveManifest(directory, checkpoint);
        if ((await this.snapshot(root, relative, signal, undefined, true)).fingerprint) fail('TOOL_FAILED', `A file appeared during installation: ${relative}`);
        await fs.link(candidate, current.absolute); // Fails if a concurrent save created the path.
        installed = true;
        await fs.unlink(candidate);
      }
      await this.syncDirectory(path.dirname(current.absolute));
      // Retain displaced bytes until the manifest records the committed inode.
      return { fingerprint: installedIdentity, cleanupPaths: [] };
    } catch (error) {
      if (!journaled) {
        // Before the intent flush, no workspace file was touched.
        delete entry.intent;
        try { await fs.unlink(candidate); } catch { /* Preserve unknown cleanup failures. */ }
        try { await fs.rmdir(scratch); } catch { /* A safe orphan is inspectable. */ }
      }
      const failure = error instanceof LittleError ? error : new LittleError('TOOL_FAILED', `The file could not be changed: ${relative}`);
      let recoveryPath: string | undefined;
      try { if ((await fs.lstat(displaced)).isFile()) recoveryPath = displaced; } catch { /* No original was moved. */ }
      Object.assign(failure, { recoveryPath, installed, installedIdentity });
      throw failure;
    }
  }

  private async scratch(checkpoint: Checkpoint, entry: CheckpointEntry, signal?: AbortSignal) {
    const intent = entry.intent!;
    const directory = path.join(checkpoint.root, path.posix.dirname(entry.path), intent.scratch);
    try {
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity(stat), intent.identity)) fail('WORKSPACE_BOUNDARY_VIOLATION', 'The mutation recovery directory changed.');
    } catch (error) { if (isMissing(error)) return { directory }; throw error; }
    const readOwned = async (name: string, expected?: Fingerprint) => {
      const file = path.join(directory, name);
      try {
        const stat = await fs.lstat(file, { bigint: true });
        const value = await this.read(file, EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes, signal);
        if (!expected || !sameFile(expected, value.fingerprint) || stat.nlink > 2n) fail('TOOL_FAILED', 'Mutation recovery bytes or their identity changed.');
        return value.fingerprint;
      } catch (error) { if (isMissing(error)) return undefined; throw error; }
    };
    return { directory, candidate: await readOwned('candidate', intent.desired), displaced: await readOwned('displaced', intent.expected) };
  }

  private async finishIntent(checkpoint: Checkpoint, directory: string, entry: CheckpointEntry): Promise<string[]> {
    if (!entry.intent) return [];
    // An installed/restored inode is recorded before deleting the moved original.
    await this.saveManifest(directory, checkpoint);
    const owned = await this.scratch(checkpoint, entry);
    const cleanupPaths: string[] = [];
    for (const name of ['candidate', 'displaced'] as const) {
      if (!owned[name]) continue;
      const file = path.join(owned.directory, name);
      try { await fs.unlink(file); } catch { cleanupPaths.push(file); }
    }
    try { await fs.rmdir(owned.directory); } catch (error) { if (!isMissing(error)) cleanupPaths.push(owned.directory); }
    if (!cleanupPaths.length) {
      await this.syncDirectory(path.dirname(owned.directory));
      delete entry.intent;
      await this.saveManifest(directory, checkpoint);
    }
    return cleanupPaths;
  }

  /** Reconcile only recorded inodes. Identical bytes on a user's new inode conflict. */
  private async reconcileIntent(checkpoint: Checkpoint, directory: string, entry: CheckpointEntry, signal?: AbortSignal): Promise<boolean> {
    const intent = entry.intent!;
    const owned = await this.scratch(checkpoint, entry, signal);
    let ownedLink: Fingerprint | undefined;
    try {
      const target = identity(await fs.lstat(path.join(checkpoint.root, entry.path), { bigint: true }));
      if (owned.candidate && sameIdentity(target, owned.candidate)) ownedLink = owned.candidate;
      else if (owned.displaced && sameIdentity(target, owned.displaced)) ownedLink = owned.displaced;
    } catch (error) { if (!isMissing(error)) throw error; }
    const current = await this.snapshot(checkpoint.root, entry.path, signal, ownedLink, true);
    // A crash can occur between the exclusive link and removing its scratch name.
    // A third alias must never be treated as Little's own installation.
    for (const name of ['candidate', 'displaced'] as const) {
      if (!owned[name]) continue;
      const stat = await fs.lstat(path.join(owned.directory, name), { bigint: true });
      if (stat.nlink > 1n && !(stat.nlink === 2n && current.fingerprint && sameFile(owned[name], current.fingerprint))) fail('PERMISSION_DENIED', 'The mutation recovery file has an unrelated hard-link alias.');
    }
    let restored = false;
    if (sameFile(intent.desired, current.fingerprint) && (intent.desired !== undefined || (intent.operation === 'restore' ? owned.displaced || !entry.applied : owned.displaced || entry.applied))) {
      // Installation completed, but its next metadata flush may have been interrupted.
      entry.applied = intent.operation === 'apply';
      if (entry.applied) entry.afterIdentity = intent.desired;
      restored = intent.operation === 'restore';
    } else if (sameFile(intent.expected, current.fingerprint)) {
      entry.applied = intent.operation === 'restore';
      if (entry.applied) entry.afterIdentity = intent.expected;
    } else if (!current.fingerprint && intent.phase === 'prepared' && intent.expected && owned.displaced && intent.desired !== undefined) {
      // The original was moved and the candidate was not installed. Restore the
      // recorded displaced inode exclusively before proceeding with rollback.
      assertNotAborted(signal);
      await this.noLinks(checkpoint.root, entry.path, true, signal);
      await fs.link(path.join(owned.directory, 'displaced'), current.absolute);
      await this.syncDirectory(path.dirname(current.absolute));
      entry.applied = intent.operation === 'restore';
      if (entry.applied) entry.afterIdentity = intent.expected;
      restored = intent.operation === 'apply';
    } else {
      const failure = new LittleError('TOOL_FAILED', 'The interrupted edit conflicts with a later save, deletion, or missing recovery file.');
      Object.assign(failure, { recoveryPath: owned.displaced ? path.join(owned.directory, 'displaced') : undefined });
      throw failure;
    }
    const cleanupPaths = await this.finishIntent(checkpoint, directory, entry);
    if (cleanupPaths.length) {
      const failure = new LittleError('TOOL_FAILED', 'Temporary recovery files could not be removed; the recorded mutation remains available.');
      Object.assign(failure, { recoveryPath: cleanupPaths[0] });
      throw failure;
    }
    return restored;
  }

  async apply(acceptance: HostEditAcceptance, signal?: AbortSignal): Promise<EditApplyResult> {
    const id = this.grants.get(acceptance);
    const pending = id ? this.pending.get(id) : undefined;
    if (signal?.aborted && id) this.discard(id);
    assertNotAborted(signal);
    if (!pending || !id) fail('PERMISSION_DENIED', 'Applying changes requires an authentic explicit host acceptance.');
    signal = pending.signal && signal ? AbortSignal.any([pending.signal, signal]) : pending.signal ?? signal;
    assertNotAborted(signal);
    if (this.mutating) fail('TOOL_FAILED', 'Another edit or rollback is in progress.');
    this.grants.delete(acceptance);
    this.mutating = true;
    let checkpoint: Checkpoint | undefined;
    let directory: string | undefined;
    let changingPath: string | undefined;
    const cleanupPaths: string[] = [];
    try {
      const roots = await this.roots(signal);
      if (roots.root !== pending.root || !sameIdentity(roots.identity, pending.identity) || roots.storage !== pending.storage || !sameIdentity(roots.storageIdentity, pending.storageIdentity)) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Workspace or checkpoint storage changed after staging.');
      // Check every file before producing a checkpoint or touching any workspace file.
      for (const edit of pending.edits) {
        const current = await this.snapshot(roots.root, edit.snapshot.relative, signal, undefined, true);
        if (!sameFile(edit.snapshot.fingerprint, current.fingerprint)) fail('TOOL_FAILED', `The original changed after staging: ${edit.snapshot.relative}`);
      }
      checkpoint = { version: 2, id: randomUUID().replaceAll('-', ''), proposalId: id, root: roots.root, identity: roots.identity, state: 'prepared', entries: pending.edits.map(edit => ({ path: edit.snapshot.relative, beforeHash: edit.change.beforeHash, afterHash: edit.change.afterHash, mode: edit.snapshot.mode, applied: false })) };
      directory = path.join(roots.storage, checkpoint.id);
      await fs.mkdir(directory, { mode: 0o700 });
      for (let i = 0; i < pending.edits.length; i++) {
        assertNotAborted(signal);
        const original = pending.edits[i]!.snapshot.bytes;
        if (original) await this.save(path.join(directory, `original-${i}`), original);
      }
      await this.saveManifest(directory, checkpoint); // Original bytes are synced first.
      await this.syncDirectory(roots.storage);
      for (let i = 0; i < pending.edits.length; i++) {
        const edit = pending.edits[i]!, entry = checkpoint.entries[i]!;
        changingPath = entry.path;
        try {
          const result = await this.mutate(checkpoint, directory, i, 'apply', edit.snapshot.fingerprint, edit.after, signal);
          entry.afterIdentity = result.fingerprint;
          cleanupPaths.push(...result.cleanupPaths);
          entry.applied = true;
        } catch (error) {
          const failure = error as { installed?: boolean; installedIdentity?: Fingerprint };
          if (failure.installed) { entry.applied = true; entry.afterIdentity = failure.installedIdentity; }
          throw error;
        }
        cleanupPaths.push(...await this.finishIntent(checkpoint, directory, entry));
      }
      assertNotAborted(signal);
      checkpoint.state = 'applied';
      await this.saveManifest(directory, checkpoint);
      return { proposalId: id, checkpointId: checkpoint.id, status: 'applied', changes: pending.proposal.changes, ...(cleanupPaths.length ? { cleanupPaths } : {}) };
    } catch (error) {
      if (!checkpoint || !directory) throw error;
      const recovery = await this.restore(checkpoint, directory);
      const failure = error instanceof LittleError ? error : new LittleError('TOOL_FAILED', 'The edit transaction failed.');
      const recoveryPath = (error as { recoveryPath?: string }).recoveryPath;
      if (recoveryPath && changingPath) {
        const conflict = recovery.conflicts.find(item => item.path === changingPath);
        if (conflict) conflict.recoveryPath = recoveryPath;
        else if (!recovery.restored.includes(changingPath)) recovery.conflicts.push({ path: changingPath, reason: failure.message, recoveryPath });
        else cleanupPaths.push(recoveryPath);
      }
      return { proposalId: id, checkpointId: checkpoint.id, status: failure.code === 'AGENT_CANCELLED' ? 'cancelled' : 'failed', changes: pending.proposal.changes, recovery, error: { code: failure.code, message: failure.message }, ...(cleanupPaths.length ? { cleanupPaths } : {}) };
    } finally { this.discard(id); this.mutating = false; }
  }

  private async restore(checkpoint: Checkpoint, directory: string, signal?: AbortSignal): Promise<EditRecovery> {
    const result: EditRecovery = { restored: [], conflicts: [] };
    for (let i = checkpoint.entries.length - 1; i >= 0; i--) {
      assertNotAborted(signal);
      const entry = checkpoint.entries[i]!;
      try {
        if (!entry.applied && !entry.intent) continue;
        // Validate the private original before cleaning a crash's displaced inode.
        await this.checkpointStorage(directory);
        let original: Buffer | undefined;
        if (entry.beforeHash !== null) {
          const file = path.join(directory, `original-${i}`);
          if ((await fs.lstat(file, { bigint: true })).nlink !== 1n) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Checkpoint bytes cannot have hard-link aliases.');
          original = (await this.read(file, EDIT_PROPOSAL_LIMITS.maxBinaryFileBytes, signal)).bytes;
          if (digest(original) !== entry.beforeHash) fail('TOOL_FAILED', 'Checkpoint bytes failed their integrity check.');
        }
        if (entry.intent && await this.reconcileIntent(checkpoint, directory, entry, signal)) result.restored.push(entry.path);
        if (!entry.applied) continue;
        if (entry.afterHash === null ? entry.afterIdentity !== undefined : !entry.afterIdentity || entry.afterIdentity.hash !== entry.afterHash) fail('TOOL_FAILED', 'The file has changed since Little applied it.');
        const mutation = await this.mutate(checkpoint, directory, i, 'restore', entry.afterIdentity, original, signal);
        entry.applied = false;
        result.restored.push(entry.path);
        if (mutation.cleanupPaths.length) (result.cleanupPaths ??= []).push(...mutation.cleanupPaths);
        const cleanupPaths = await this.finishIntent(checkpoint, directory, entry);
        if (cleanupPaths.length) (result.cleanupPaths ??= []).push(...cleanupPaths);
      } catch (error) {
        if (error instanceof LittleError && error.code === 'AGENT_CANCELLED') throw error;
        result.conflicts.push({ path: entry.path, reason: error instanceof Error ? error.message : 'Restore failed.', recoveryPath: (error as { recoveryPath?: string }).recoveryPath });
      }
    }
    checkpoint.state = checkpoint.entries.some(entry => entry.applied || entry.intent) ? 'partial' : 'rolled-back';
    await this.saveManifest(directory, checkpoint);
    return result;
  }

  private async loadCheckpoint(checkpointId: string, roots: Awaited<ReturnType<EditProposalService['roots']>>, signal?: AbortSignal) {
    const directory = path.join(roots.storage, checkpointId);
    await this.checkpointStorage(directory);
    const manifest = path.join(directory, 'manifest.json');
    const stat = await fs.lstat(manifest, { bigint: true });
    if (stat.nlink !== 1n) fail('WORKSPACE_BOUNDARY_VIOLATION', 'Checkpoint metadata cannot have hard-link aliases.');
    const data = await this.read(manifest, 64 * 1024, signal);
    let parsed: unknown;
    try { parsed = JSON.parse(text(data.bytes)); } catch { fail('TOOL_VALIDATION_FAILED', 'Checkpoint metadata is not valid JSON.'); }
    const checkpoint = parseCheckpoint(parsed);
    if (checkpoint.id !== checkpointId || checkpoint.root !== roots.root || !sameIdentity(checkpoint.identity, roots.identity)) fail('WORKSPACE_BOUNDARY_VIOLATION', 'The checkpoint does not belong to this workspace.');
    return { checkpoint, directory, modifiedMs: Number(stat.mtimeMs) };
  }

  /** Read-only discovery includes a flushed intent whose applied flag is still false. */
  async listCheckpoints(signal?: AbortSignal): Promise<readonly CheckpointSummary[]> {
    const roots = await this.roots(signal);
    const entries: CheckpointSummary[] = [];
    const directory = await fs.opendir(roots.storage);
    let visited = 0;
    for await (const item of directory) {
      assertNotAborted(signal);
      if (++visited > 2_000 || entries.length >= 200) break;
      if (!/^[a-f0-9]{32}$/.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) continue;
      try {
        const { checkpoint, modifiedMs } = await this.loadCheckpoint(item.name, roots, signal);
        const paths = checkpoint.entries.filter(entry => entry.applied || entry.intent).map(entry => entry.path);
        if (paths.length) entries.push(Object.freeze({ id: checkpoint.id, state: checkpoint.state, interrupted: checkpoint.state === 'prepared' || checkpoint.entries.some(entry => Boolean(entry.intent)), paths: Object.freeze(paths), modifiedMs }));
      } catch (error) {
        assertNotAborted(signal);
        if (!(error instanceof LittleError) && !isMissing(error)) throw error;
        // Malformed or foreign records remain untouched and cannot enter the picker.
      }
    }
    return Object.freeze(entries.sort((a, b) => b.modifiedMs - a.modifiedMs));
  }

  async rollback(checkpointId: string, signal?: AbortSignal): Promise<EditRecovery> {
    assertNotAborted(signal);
    if (!/^[a-f0-9]{32}$/.test(checkpointId)) fail('TOOL_VALIDATION_FAILED', 'A valid checkpoint ID is required.');
    if (this.mutating) fail('TOOL_FAILED', 'Another edit or rollback is in progress.');
    this.mutating = true;
    try {
      const roots = await this.roots(signal);
      const { checkpoint, directory } = await this.loadCheckpoint(checkpointId, roots, signal);
      return await this.restore(checkpoint, directory, signal);
    } finally { this.mutating = false; }
  }
}
