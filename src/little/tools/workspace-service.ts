import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { redactSecrets } from '../context/redact-secrets';
import { extractNotebookSource } from './notebook-source';
import { LittleError } from '../shared/errors';

export const WORKSPACE_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxNotebookBytes: 8 * 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxReadChars: 20_000,
  maxRangeLines: 400,
  maxDirectoryEntries: 200,
  maxDirectoryChars: 8_000,
  maxSearchResults: 100,
  maxSearchChars: 16_000,
  maxSearchBytes: 8 * 1024 * 1024,
  maxVisitedEntries: 5_000,
  maxDepth: 24,
  maxIgnoreBytes: 64 * 1024,
});

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'generated',
  '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
]);
const SECRET_NAMES = /^(?:\.env.*|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const PRIVATE_KEY_EXTENSION = /\.(?:pem|key|p12|pfx|keystore)$/i;

interface WorkspaceSession {
  root: string;
  signal?: AbortSignal;
  ignoreRules: Map<string, Promise<Ignore>>;
}
export interface ResolvedWorkspacePath { absolutePath: string; relativePath: string; isDirectory: boolean }
export interface DirectoryEntry { name: string; path: string; type: 'directory' | 'file' }
export interface FileContent { path: string; content: string; truncated: boolean; bytesRead: number; totalBytes: number }
/** Host-only input to format parsers. Never serialize bytes as a model observation. */
export interface BinaryFileContent { path: string; bytes: Buffer; totalBytes: number }
export interface InventoryFile { path: string; bytes: number; modifiedMs: number; createdMs: number; ino: number; dev: number }
export interface WorkspaceInventory { files: InventoryFile[]; truncated: boolean; visitedEntries: number }
interface SearchState { visitedEntries: number; truncated: boolean; seenDirectories: Set<string> }

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LittleError('AGENT_CANCELLED', 'Run stopped.');
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function posixPath(value: string): string { return value.split(path.sep).join('/'); }
function blockedPath(relativePath: string): boolean {
  return relativePath.split('/').some((part) => SECRET_NAMES.test(part) || PRIVATE_KEY_EXTENSION.test(part) || EXCLUDED_DIRECTORIES.has(part.toLowerCase()));
}
function validationError(message: string): never { throw new LittleError('TOOL_VALIDATION_FAILED', message); }
function isPolicyError(error: unknown): boolean {
  return error instanceof LittleError && (error.code === 'PERMISSION_DENIED' || error.code === 'WORKSPACE_BOUNDARY_VIOLATION');
}

/** All filesystem access is constrained here, including editor-supplied absolute paths. */
export class WorkspaceService {
  readonly root: string;

  constructor(root: string) { this.root = path.resolve(root); }

  private async session(signal?: AbortSignal): Promise<WorkspaceSession> {
    assertNotAborted(signal);
    const root = await fs.realpath(this.root);
    const stat = await fs.stat(root);
    assertNotAborted(signal);
    if (!stat.isDirectory()) throw new LittleError('TOOL_FAILED', 'The workspace root is not a directory.');
    return { root, signal, ignoreRules: new Map() };
  }

  private async rules(directory: string, session: WorkspaceSession): Promise<Ignore> {
    const cached = session.ignoreRules.get(directory);
    if (cached) return cached;
    const loading = (async () => {
      const matcher = ignore();
      for (const name of ['.gitignore', '.littleignore']) {
        assertNotAborted(session.signal);
        const file = path.join(session.root, directory, name);
        try {
          const real = await fs.realpath(file);
          if (!within(session.root, real) || blockedPath(posixPath(path.relative(session.root, real)))) continue;
          const stat = await fs.stat(real);
          if (!stat.isFile() || stat.size > WORKSPACE_LIMITS.maxIgnoreBytes) continue;
          const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const buffer = Buffer.alloc(WORKSPACE_LIMITS.maxIgnoreBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            assertNotAborted(session.signal);
            if (bytesRead <= WORKSPACE_LIMITS.maxIgnoreBytes) matcher.add(buffer.subarray(0, bytesRead).toString('utf8'));
          } finally { await handle.close(); }
        } catch (error) {
          assertNotAborted(session.signal);
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return matcher;
    })();
    session.ignoreRules.set(directory, loading);
    return loading;
  }

  private async ignored(relativePath: string, isDirectory: boolean, session: WorkspaceSession): Promise<boolean> {
    if (!relativePath || relativePath === '.') return false;
    const segments = relativePath.split('/');
    // Test each parent first: Git cannot re-include a child of an excluded directory.
    for (let end = 1; end <= segments.length; end++) {
      assertNotAborted(session.signal);
      let excluded = false;
      for (let base = 0; base < end; base++) {
        const directory = segments.slice(0, base).join('/');
        const localPath = segments.slice(base, end).join('/') + (end < segments.length || isDirectory ? '/' : '');
        const decision = (await this.rules(directory, session)).test(localPath);
        if (decision.ignored) excluded = true;
        else if (decision.unignored) excluded = false;
      }
      if (excluded) return true;
    }
    return false;
  }

  private async resolve(input: string, session: WorkspaceSession): Promise<ResolvedWorkspacePath> {
    assertNotAborted(session.signal);
    if (typeof input !== 'string' || input.length > 4_096 || /[\u0000-\u001f]/.test(input)) validationError('A valid workspace path is required.');
    if (/^[A-Za-z]:[^\\/]/.test(input) || (process.platform !== 'win32' && /^[A-Za-z]:/.test(input))) {
      throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'The path must stay inside the workspace.');
    }
    const normalized = input.replace(/[\\/]/g, path.sep);
    const lexical = path.resolve(this.root, normalized || '.');
    if (!within(this.root, lexical)) throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'The path must stay inside the workspace.');
    const requestedRelative = posixPath(path.relative(this.root, lexical));
    if (blockedPath(requestedRelative)) throw new LittleError('PERMISSION_DENIED', 'Sensitive and generated paths are excluded from model context.');
    const absolutePath = await fs.realpath(lexical);
    assertNotAborted(session.signal);
    if (!within(session.root, absolutePath)) throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'A symbolic link points outside the workspace.');
    const relativePath = posixPath(path.relative(session.root, absolutePath));
    if (blockedPath(relativePath)) throw new LittleError('PERMISSION_DENIED', 'Sensitive and generated paths are excluded from model context.');
    const stat = await fs.stat(absolutePath);
    if (await this.ignored(requestedRelative, stat.isDirectory(), session) || await this.ignored(relativePath, stat.isDirectory(), session)) {
      throw new LittleError('PERMISSION_DENIED', 'The path is excluded by workspace ignore rules.');
    }
    assertNotAborted(session.signal);
    return { absolutePath, relativePath: relativePath || '.', isDirectory: stat.isDirectory() };
  }

  async resolvePath(input: string, signal?: AbortSignal): Promise<ResolvedWorkspacePath> {
    return this.resolve(input, await this.session(signal));
  }

  async info(signal?: AbortSignal) {
    assertNotAborted(signal);
    const listing = await this.listDirectory('.', signal);
    return { name: path.basename(this.root), root: this.root, entries: listing.entries, truncated: listing.truncated, limits: WORKSPACE_LIMITS };
  }

  async listDirectory(input = '.', signal?: AbortSignal): Promise<{ path: string; entries: DirectoryEntry[]; truncated: boolean }> {
    const session = await this.session(signal);
    const directory = await this.resolve(input, session);
    if (!directory.isDirectory) throw new LittleError('TOOL_FAILED', 'The requested path is not a directory.');
    const entries: DirectoryEntry[] = [];
    let visited = 0;
    let resultChars = 0;
    let truncated = false;
    const handle = await fs.opendir(directory.absolutePath);
    for await (const entry of handle) {
      assertNotAborted(signal);
      if (++visited > WORKSPACE_LIMITS.maxVisitedEntries || entries.length >= WORKSPACE_LIMITS.maxDirectoryEntries) { truncated = true; break; }
      try {
        const target = await this.resolve(path.join(directory.relativePath, entry.name), session);
        if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (resultChars + entry.name.length + target.relativePath.length > WORKSPACE_LIMITS.maxDirectoryChars) { truncated = true; break; }
        entries.push({ name: entry.name, path: target.relativePath, type: target.isDirectory ? 'directory' : 'file' });
        resultChars += entry.name.length + target.relativePath.length;
      } catch (error) {
        if (!isPolicyError(error) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    assertNotAborted(signal);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { path: directory.relativePath, entries, truncated };
  }

  private async readBytes(target: ResolvedWorkspacePath, session: WorkspaceSession, maxBytes: number): Promise<Buffer> {
    assertNotAborted(session.signal);
    const before = await fs.stat(target.absolutePath);
    if (!before.isFile()) throw new LittleError('TOOL_FAILED', 'The requested path is not a regular file.');
    if (before.size > maxBytes) throw new LittleError('CONTEXT_LIMIT', 'The file exceeds the safe context size. Read a smaller source file.');
    const handle = await fs.open(target.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      // Reject a swapped file before reading any data from its open handle.
      const current = await fs.realpath(target.absolutePath);
      if (current !== target.absolutePath || !within(session.root, current) || opened.ino !== before.ino || opened.dev !== before.dev) {
        throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'The file changed while its workspace boundary was being checked.');
      }
      if (!opened.isFile() || opened.size > maxBytes) throw new LittleError('CONTEXT_LIMIT', 'The file exceeds the safe context size.');
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
      let bytes = 0;
      while (bytes < buffer.length) {
        assertNotAborted(session.signal);
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        assertNotAborted(session.signal);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
      }
      if (bytes > maxBytes) throw new LittleError('CONTEXT_LIMIT', 'The file exceeds the safe context size.');
      const after = await handle.stat();
      const checked = await this.resolve(target.relativePath, await this.session(session.signal));
      const currentPath = await fs.stat(checked.absolutePath);
      if (checked.absolutePath !== target.absolutePath || after.ino !== opened.ino || after.dev !== opened.dev ||
          currentPath.ino !== opened.ino || currentPath.dev !== opened.dev || currentPath.mtimeMs !== opened.mtimeMs ||
          after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes !== after.size) {
        throw new LittleError('TOOL_FAILED', 'The file changed while it was being read. Read it again before acting.');
      }
      return buffer.subarray(0, bytes);
    } finally { await handle.close(); }
  }

  private async readText(target: ResolvedWorkspacePath, session: WorkspaceSession, maxBytes: number = WORKSPACE_LIMITS.maxFileBytes): Promise<{ text: string; bytes: number }> {
    const bytes = await this.readBytes(target, session, maxBytes);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new LittleError('TOOL_FAILED', 'This file needs a format reader. Use read_document for DOCX, PPTX or PDF; ordinary read_file accepts UTF-8 text.'); }
    if (text.includes('\u0000')) throw new LittleError('TOOL_FAILED', 'This binary file needs a supported format reader. Use read_document for DOCX, PPTX or PDF.');
    return { text, bytes: bytes.length };
  }

  /** Complete protected binary input for document parsers; this method is not an agent tool. */
  async readBinaryFile(input: string, signal?: AbortSignal, maxBytes: number = WORKSPACE_LIMITS.maxDocumentBytes): Promise<BinaryFileContent> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WORKSPACE_LIMITS.maxDocumentBytes) validationError('The document read budget is invalid.');
    const session = await this.session(signal);
    const target = await this.resolve(input, session);
    const bytes = await this.readBytes(target, session, maxBytes);
    assertNotAborted(signal);
    return { path: target.relativePath, bytes, totalBytes: bytes.length };
  }

  async inspectFile(input: string, signal?: AbortSignal) {
    const file = await this.readBinaryFile(input, signal);
    const extension = path.extname(file.path).toLowerCase();
    const format = extension === '.ipynb' ? 'notebook' : ['.docx', '.pptx', '.pdf'].includes(extension) ? 'document' : 'other';
    return { path: file.path, bytes: file.totalBytes, extension, sha256: createHash('sha256').update(file.bytes).digest('hex'),
      contentIncluded: false, suggestedReader: format === 'notebook' ? 'read_notebook' : format === 'document' ? 'read_document' : 'read_file (UTF-8 text only)',
      message: 'Metadata confirms this regular file exists. It does not establish its content. Use a supported reader before making content claims.' };
  }

  async readFile(input: string, signal?: AbortSignal): Promise<FileContent> {
    const session = await this.session(signal);
    const target = await this.resolve(input, session);
    if (/\.(?:docx|pptx|pdf)$/i.test(target.relativePath)) {
      const { readDocument } = await import('./document-tools');
      return readDocument(this, target.relativePath, {}, signal);
    }
    if (path.extname(target.relativePath).toLowerCase() === '.ipynb') {
      const json = await this.readText(target, session, WORKSPACE_LIMITS.maxNotebookBytes);
      const notebook = extractNotebookSource(json.text, target.relativePath, {}, signal);
      return { path: target.relativePath, content: notebook.content, truncated: notebook.truncated, bytesRead: json.bytes, totalBytes: json.bytes };
    }
    const result = await this.readText(target, session);
    const text = redactSecrets(result.text);
    assertNotAborted(signal);
    return { path: target.relativePath, content: text.slice(0, WORKSPACE_LIMITS.maxReadChars), truncated: text.length > WORKSPACE_LIMITS.maxReadChars, bytesRead: result.bytes, totalBytes: result.bytes };
  }

  /** Internal complete JSON input for the notebook parser; never offer raw output to a model. */
  async readNotebookFile(input: string, signal?: AbortSignal, maxBytes: number = WORKSPACE_LIMITS.maxNotebookBytes): Promise<FileContent> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WORKSPACE_LIMITS.maxNotebookBytes) validationError('The notebook read budget is invalid.');
    const session = await this.session(signal);
    const target = await this.resolve(input, session);
    if (path.extname(target.relativePath).toLowerCase() !== '.ipynb') validationError('A notebook path ending in .ipynb is required.');
    const result = await this.readText(target, session, maxBytes);
    assertNotAborted(signal);
    // JSON source must be parsed before redaction, which can otherwise corrupt its syntax.
    return { path: target.relativePath, content: result.text, truncated: false, bytesRead: result.bytes, totalBytes: result.bytes };
  }

  async readRange(input: string, startLine: number, endLine: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine + 1 > WORKSPACE_LIMITS.maxRangeLines) {
      validationError(`Line ranges must be positive, ordered, and at most ${WORKSPACE_LIMITS.maxRangeLines} lines.`);
    }
    const session = await this.session(signal);
    const target = await this.resolve(input, session);
    if (path.extname(target.relativePath).toLowerCase() === '.ipynb') validationError('Notebook citations use cell source lines. Use read_notebook with startCell/endCell instead of JSON line ranges.');
    const result = await this.readText(target, session);
    // Redact before selecting lines, so a range cannot expose the middle of a private key.
    const lines = redactSecrets(result.text).split(/\r?\n/);
    const selected = lines.slice(startLine - 1, endLine).join('\n');
    assertNotAborted(signal);
    return { path: target.relativePath, startLine, endLine: Math.min(endLine, lines.length), content: selected.slice(0, WORKSPACE_LIMITS.maxReadChars), totalLines: lines.length, truncated: selected.length > WORKSPACE_LIMITS.maxReadChars };
  }

  private async *walk(directory: ResolvedWorkspacePath, session: WorkspaceSession, state: SearchState, depth = 0, skipLinks = false): AsyncGenerator<ResolvedWorkspacePath> {
    assertNotAborted(session.signal);
    if (!directory.isDirectory) { yield directory; return; }
    if (depth > WORKSPACE_LIMITS.maxDepth) { state.truncated = true; return; }
    if (state.seenDirectories.has(directory.absolutePath)) return;
    state.seenDirectories.add(directory.absolutePath);
    const handle = await fs.opendir(directory.absolutePath);
    for await (const entry of handle) {
      assertNotAborted(session.signal);
      if (++state.visitedEntries > WORKSPACE_LIMITS.maxVisitedEntries) { state.truncated = true; return; }
      if (skipLinks && entry.isSymbolicLink()) continue;
      let target: ResolvedWorkspacePath;
      try { target = await this.resolve(path.join(directory.relativePath, entry.name), session); }
      catch (error) {
        if (isPolicyError(error) || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (target.isDirectory) yield* this.walk(target, session, state, depth + 1, skipLinks);
      else if (entry.isFile() || entry.isSymbolicLink()) yield target;
      if (state.visitedEntries > WORKSPACE_LIMITS.maxVisitedEntries) return;
    }
  }

  /** Fresh policy-filtered inventory shares one ignore session and never traverses links. */
  async inventory(signal?: AbortSignal): Promise<WorkspaceInventory> {
    const session = await this.session(signal);
    const state: SearchState = { visitedEntries: 0, truncated: false, seenDirectories: new Set() };
    const root = await this.resolve('.', session);
    const files: InventoryFile[] = [];
    for await (const file of this.walk(root, session, state, 0, true)) {
      assertNotAborted(signal);
      if (files.length >= 2000) { state.truncated = true; break; }
      try {
        const stat = await fs.lstat(file.absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) continue;
        files.push({ path: file.relativePath, bytes: stat.size, modifiedMs: stat.mtimeMs, createdMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev });
      } catch (error) {
        assertNotAborted(signal);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    assertNotAborted(signal);
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return { files, truncated: state.truncated, visitedEntries: state.visitedEntries };
  }

  async searchFiles(query: string, signal?: AbortSignal) {
    if (typeof query !== 'string' || query.length > 128) validationError('File queries must be at most 128 characters.');
    const session = await this.session(signal);
    const state: SearchState = { visitedEntries: 0, truncated: false, seenDirectories: new Set() };
    const matches: string[] = [];
    let resultChars = 0;
    const root = await this.resolve('.', session);
    for await (const file of this.walk(root, session, state)) {
      assertNotAborted(signal);
      if (!file.relativePath.toLowerCase().includes(query.toLowerCase())) continue;
      if (matches.length >= WORKSPACE_LIMITS.maxSearchResults || resultChars + file.relativePath.length > WORKSPACE_LIMITS.maxSearchChars) { state.truncated = true; break; }
      matches.push(file.relativePath);
      resultChars += file.relativePath.length;
    }
    assertNotAborted(signal);
    return { matches, truncated: state.truncated, visitedEntries: state.visitedEntries };
  }

  async searchText(query: string, input = '.', signal?: AbortSignal, caseSensitive = false) {
    if (typeof query !== 'string' || query.length < 1 || query.length > 256) validationError('Text queries must contain 1 to 256 characters.');
    const session = await this.session(signal);
    const state: SearchState = { visitedEntries: 0, truncated: false, seenDirectories: new Set() };
    const matches: { path: string; line: number; text: string }[] = [];
    let scannedBytes = 0;
    let notebooksSkipped = 0;
    let resultChars = 0;
    const needle = caseSensitive ? query : query.toLowerCase();
    for await (const file of this.walk(await this.resolve(input, session), session, state)) {
      assertNotAborted(signal);
      if (path.extname(file.relativePath).toLowerCase() === '.ipynb') { notebooksSkipped++; continue; }
      let result: { text: string; bytes: number };
      try { result = await this.readText(file, session); }
      catch (error) {
        if (error instanceof LittleError && (error.code === 'CONTEXT_LIMIT' || error.code === 'TOOL_FAILED')) continue;
        throw error;
      }
      scannedBytes += result.bytes;
      if (scannedBytes > WORKSPACE_LIMITS.maxSearchBytes) { state.truncated = true; break; }
      const lines = redactSecrets(result.text).split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        assertNotAborted(signal);
        const line = lines[index] ?? '';
        const haystack = caseSensitive ? line : line.toLowerCase();
        const found = haystack.indexOf(needle);
        if (found < 0) continue;
        const previewStart = Math.max(0, found - 120);
        const text = line.slice(previewStart, previewStart + 500);
        if (matches.length >= WORKSPACE_LIMITS.maxSearchResults || resultChars + file.relativePath.length + text.length > WORKSPACE_LIMITS.maxSearchChars) { state.truncated = true; break; }
        matches.push({ path: file.relativePath, line: index + 1, text });
        resultChars += file.relativePath.length + text.length;
      }
      if (state.truncated) break;
    }
    assertNotAborted(signal);
    return { matches, truncated: state.truncated || notebooksSkipped > 0, notebooksSkipped, scannedBytes, visitedEntries: state.visitedEntries,
      ...(notebooksSkipped ? { note: 'Notebook JSON is excluded from text search. Use read_notebook for source cells.' } : {}) };
  }
}
