import * as path from 'node:path';
import type { RepositoryStatus } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { WORKSPACE_LIMITS, type InventoryFile, type WorkspaceInventory, type WorkspaceService } from '../tools/workspace-service';
import { redactSecrets } from './redact-secrets';
import { extractNotebookSource } from '../tools/notebook-source';

export interface IndexedFile {
  path: string;
  language: string;
  bytes: number;
  modifiedMs: number;
  symbols: { name: string; kind: 'function' | 'class' | 'interface' | 'type' | 'variable'; line: number }[];
  imports: string[];
  terms: string[];
}
export interface IndexSnapshot {
  files: IndexedFile[];
  generation: number;
  truncated: boolean;
  stats: { files: number; processed: number; symbols: number; reused: number; updatedAt: number };
}
export const REPOSITORY_INDEX_LIMITS = Object.freeze({ files: 2000, symbols: 120, imports: 80, terms: 300, termChars: 50, importChars: 256, readBytes: 8 * 1024 * 1024 });
type Symbol = IndexedFile['symbols'][number];
interface CachedFile { fingerprint: string; file: IndexedFile; truncated: boolean; retryable: boolean }
const LANGUAGES: Record<string, string> = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.ipynb': 'notebook' };
export const AUTO_NOTEBOOK_BYTES = 1024 * 1024;
const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const STOP_TERMS = new Set('abstract and as async await boolean break case catch class const continue crate declare default def do else enum export extern false fn for from function if impl import in interface let mod mut new none null or pass private protected pub public raise readonly require return self static string struct super switch this throw trait true try type typeof undefined unsafe use var void while with yield redacted'.split(' '));

function aborted(signal: AbortSignal): void { if (signal.aborted) throw new LittleError('AGENT_CANCELLED', 'Repository indexing stopped.'); }
function fingerprint(file: InventoryFile): string { return `${file.bytes}:${file.modifiedMs}:${file.createdMs}:${file.ino}:${file.dev}`; }
function changed(): LittleError { return new LittleError('AGENT_CANCELLED', 'The repository changed during indexing. Refresh the index again.'); }
function freezeFile(file: IndexedFile): IndexedFile {
  return Object.freeze({ ...file,
    symbols: Object.freeze(file.symbols.map(symbol => Object.freeze({ ...symbol }))) as unknown as Symbol[],
    imports: Object.freeze([...file.imports]) as unknown as string[], terms: Object.freeze([...file.terms]) as unknown as string[],
  });
}
function freezeSnapshot(snapshot: IndexSnapshot): IndexSnapshot {
  return Object.freeze({ ...snapshot, files: Object.freeze(snapshot.files.map(freezeFile)) as unknown as IndexedFile[], stats: Object.freeze({ ...snapshot.stats }) });
}
function validInventory(inventory: WorkspaceInventory): void {
  if (inventory.files.length > REPOSITORY_INDEX_LIMITS.files) throw new LittleError('CONTEXT_LIMIT', 'The workspace inventory exceeded the index limit.');
  const seen = new Set<string>();
  for (const file of inventory.files) {
    if (!file.path || file.path.length > 4096 || path.isAbsolute(file.path) || /[\u0000-\u001f\\]/.test(file.path) || file.path.split('/').some(part => !part || part === '..' || part === '.') ||
        seen.has(file.path) || !Number.isSafeInteger(file.bytes) || ![file.bytes, file.modifiedMs, file.createdMs, file.ino, file.dev].every(value => Number.isFinite(value) && value >= 0)) {
      throw new LittleError('TOOL_FAILED', 'The workspace inventory contained invalid file metadata.');
    }
    seen.add(file.path);
  }
}

/** Mask comments and literals while preserving offsets/newlines. This is a bounded heuristic, not an AST or LSP. */
function maskedSource(source: string, language: string): { code: string; imports: string; literalStarts: Set<number> } {
  const code = source.split('');
  const imports = source.split('');
  const literalStarts = new Set<number>();
  const mask = (start: number, end: number, comment: boolean): void => {
    for (let index = start; index < end; index++) {
      if (source[index] !== '\n' && source[index] !== '\r') { code[index] = ' '; if (comment) imports[index] = ' '; }
    }
  };
  // Work in UTF-16 offsets, matching JavaScript regex/string offsets (including non-ASCII source).
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if ((language === 'python' && character === '#') || (language !== 'python' && source.startsWith('//', index))) {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      mask(index, stop, true); index = stop; continue;
    }
    if (language !== 'python' && source.startsWith('/*', index)) {
      let depth = 1;
      let end = index + 2;
      while (end < source.length && depth) {
        if (language === 'rust' && source.startsWith('/*', end)) { depth++; end += 2; }
        else if (source.startsWith('*/', end)) { depth--; end += 2; }
        else end++;
      }
      mask(index, end, true); index = end; continue;
    }
    if (language === 'rust' && character === 'r') {
      const raw = /^r(#{0,16})"/.exec(source.slice(index, index + 20));
      if (raw) {
        literalStarts.add(index + raw[0].length - 1);
        const end = source.indexOf(`"${raw[1] ?? ''}`, index + raw[0].length);
        const stop = end < 0 ? source.length : end + 1 + (raw[1]?.length ?? 0);
        mask(index, stop, false); index = stop; continue;
      }
    }
    if (character === '"' || character === "'" || (character === '`' && language !== 'python')) {
      // Rust lifetime annotations are identifiers, not character literals.
      const lifetime = language === 'rust' && character === "'" ? /^'[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index)) : null;
      if (lifetime && source[index + lifetime[0].length] !== "'") { index += lifetime[0].length; continue; }
      literalStarts.add(index);
      const triple = language === 'python' && source.startsWith(character.repeat(3), index);
      const quote = triple ? character.repeat(3) : character;
      let end = index + quote.length;
      while (end < source.length) {
        if (source.startsWith(quote, end)) { end += quote.length; break; }
        if (source[end] === '\\' && character !== '`') end += 2;
        else end++;
      }
      mask(index, Math.min(end, source.length), false); index = end; continue;
    }
    index++;
  }
  return { code: code.join(''), imports: imports.join(''), literalStarts };
}
function extract(source: string, language: string): { symbols: Symbol[]; imports: string[]; terms: string[]; truncated: boolean } {
  const safe = redactSecrets(source);
  const masked = maskedSource(safe, language);
  const symbols: Symbol[] = [];
  const imports = new Set<string>();
  const terms = new Set<string>();
  let truncated = false;
  const addSymbol = (name: string | undefined, kind: Symbol['kind'], line: number): void => {
    if (!name || name.length > 128) { if (name) truncated = true; return; }
    if (symbols.length >= REPOSITORY_INDEX_LIMITS.symbols) { truncated = true; return; }
    symbols.push({ name, kind, line });
  };
  const addImport = (value: string | undefined): void => {
    if (!value) return;
    const dependency = value.trim();
    // Static module identifiers only: no URL credentials, query strings, controls, or redaction placeholders.
    if (!dependency || dependency.length > REPOSITORY_INDEX_LIMITS.importChars || !/^[A-Za-z0-9_@~./:-]+$/.test(dependency) || /^(?:[a-z][a-z0-9+.-]*:(?!:)|\/)/i.test(dependency) || /redacted/i.test(dependency)) return;
    if (imports.size >= REPOSITORY_INDEX_LIMITS.imports && !imports.has(dependency)) { truncated = true; return; }
    imports.add(dependency);
  };
  const lines = masked.code.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (language === 'javascript' || language === 'typescript') {
      const declaration = new RegExp(`^\\s*(?:(?:export|default|declare|abstract|async)\\s+)*(function\\s*\\*?|class|interface|type|enum|const|let|var)\\s+(${IDENTIFIER})`).exec(line);
      if (!declaration) continue;
      const keyword = declaration[1]?.trim();
      const kind: Symbol['kind'] = keyword?.startsWith('function') ? 'function' : keyword === 'class' || keyword === 'interface' ? keyword : keyword === 'type' || keyword === 'enum' ? 'type' : /=>/.test(line.slice(declaration[0].length)) ? 'function' : 'variable';
      addSymbol(declaration[2], kind, index + 1);
    } else if (language === 'python') {
      const declaration = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (declaration) addSymbol(declaration[2], declaration[1] === 'def' ? 'function' : 'class', index + 1);
      else { const variable = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line); if (variable) addSymbol(variable[1], 'variable', index + 1); }
    } else if (language === 'go') {
      const fn = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[|\()/.exec(line);
      const declaration = /^\s*(type|const|var)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (fn) addSymbol(fn[1], 'function', index + 1);
      else if (declaration) addSymbol(declaration[2], declaration[1] === 'type' ? 'type' : 'variable', index + 1);
    } else if (language === 'rust') {
      const declaration = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|extern)\s+)*(fn|struct|enum|trait|type|const|static|union)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (declaration) addSymbol(declaration[2], declaration[1] === 'fn' ? 'function' : declaration[1] === 'struct' ? 'class' : declaration[1] === 'trait' ? 'interface' : ['enum', 'type', 'union'].includes(declaration[1] ?? '') ? 'type' : 'variable', index + 1);
    }
  }
  if (language === 'javascript' || language === 'typescript') {
    for (const match of masked.imports.matchAll(/\b(?:import|export)\s+(?:[^;"']*?\bfrom\s*)?["']([^"'\r\n]+)["']|\b(?:require|import)\s*\(\s*["']([^"'\r\n]+)["']\s*\)/g)) {
      const keyword = /^(?:import|export|require)/.exec(match[0])?.[0] ?? '';
      const quoteOffset = match.index + match[0].search(/["']/);
      if (keyword && masked.code.slice(match.index, match.index + keyword.length) === keyword && masked.literalStarts.has(quoteOffset)) addImport(match[1] ?? match[2]);
    }
  } else if (language === 'python') {
    for (const line of lines) {
      const from = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/.exec(line);
      if (from) addImport(from[1]);
      const dependencies = /^\s*import\s+(.+)$/.exec(line)?.[1];
      if (dependencies) for (const dependency of dependencies.split(',')) addImport(/^\s*([A-Za-z_][A-Za-z0-9_.]*)/.exec(dependency)?.[1]);
    }
  } else if (language === 'go') {
    let block = false;
    let offset = 0;
    const importLines = masked.imports.split('\n');
    const codeLines = masked.code.split('\n');
    for (let index = 0; index < importLines.length; index++) {
      const line = importLines[index] ?? '';
      const codeLine = codeLines[index] ?? '';
      if (/^\s*import\s*\(/.test(codeLine)) block = true;
      else if (block && /^\s*\)/.test(codeLine)) block = false;
      else if (block || /^\s*import\s+/.test(codeLine)) {
        const literal = /["`]([^"`\r\n]+)["`]/.exec(line);
        if (literal && masked.literalStarts.has(offset + literal.index)) addImport(literal[1]);
      }
      offset += line.length + 1;
    }
  } else if (language === 'rust') {
    for (const line of lines) {
      const use = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(line);
      const module = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/.exec(line);
      addImport(use?.[1]?.replace(/:+$/, '') ?? module?.[1]);
    }
  }
  for (const match of masked.code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const identifier = match[0].toLowerCase();
    if (identifier.length > REPOSITORY_INDEX_LIMITS.termChars) { truncated = true; continue; }
    if (identifier.length < 2 || STOP_TERMS.has(identifier) || terms.has(identifier)) continue;
    if (terms.size >= REPOSITORY_INDEX_LIMITS.terms) { truncated = true; continue; }
    terms.add(identifier);
  }
  return { symbols, imports: [...imports], terms: [...terms], truncated };
}

/** Incremental, metadata-only, bounded source heuristics. Every refresh rechecks workspace policy. */
export class RepositoryIndex {
  private cache = new Map<string, CachedFile>();
  private generation = 0;
  private revision = 0;
  private busy = false;
  private allDirty = false;
  private readonly dirty = new Set<string>();
  constructor(private readonly workspace: WorkspaceService) {}

  invalidate(paths?: readonly string[]): void {
    if (paths?.length === 0) return;
    this.revision++;
    if (!paths || this.allDirty) { this.allDirty = true; this.dirty.clear(); return; }
    for (const input of paths) {
      const relative = path.isAbsolute(input) ? path.relative(this.workspace.root, input) : input;
      const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
      if (!normalized.startsWith('../') && normalized !== '..' && !path.isAbsolute(normalized)) this.dirty.add(normalized);
    }
    if (this.dirty.size > REPOSITORY_INDEX_LIMITS.files * 2) { this.allDirty = true; this.dirty.clear(); }
  }

  async refresh(signal: AbortSignal, onProgress?: (status: RepositoryStatus) => void): Promise<IndexSnapshot> {
    aborted(signal);
    if (this.busy) throw new LittleError('PERMISSION_DENIED', 'Repository indexing is already active. Wait for it to finish.');
    this.busy = true;
    const revision = this.revision;
    let processed = 0;
    let reused = 0;
    let symbolCount = 0;
    let fileCount = 0;
    let truncated = false;
    const progress = (state: RepositoryStatus['state'], extra: Partial<RepositoryStatus> = {}): void => {
      try { onProgress?.(Object.freeze({ state, workspace: path.basename(this.workspace.root), files: fileCount, processed, reused, symbols: symbolCount, truncated, generation: this.generation, ...extra })); } catch { /* UI disposal must not interrupt indexing. */ }
    };
    const check = (): void => { aborted(signal); if (this.revision !== revision) throw changed(); };
    progress('indexing');
    try {
      const inventory = await this.workspace.inventory(signal);
      check(); validInventory(inventory);
      fileCount = inventory.files.length;
      truncated = inventory.truncated;
      const next = new Map<string, CachedFile>();
      let readBytes = 0;
      for (const metadata of inventory.files) {
        check();
        const identity = fingerprint(metadata);
        const cached = this.cache.get(metadata.path);
        if (!this.allDirty && !this.dirty.has(metadata.path) && cached?.fingerprint === identity && !cached.retryable) {
          next.set(metadata.path, cached); reused++; symbolCount += cached.file.symbols.length; truncated ||= cached.truncated;
          progress('indexing'); continue;
        }
        const language = LANGUAGES[path.posix.extname(metadata.path).toLowerCase()] ?? 'unknown';
        let file: IndexedFile = { path: metadata.path, language, bytes: metadata.bytes, modifiedMs: metadata.modifiedMs, symbols: [], imports: [], terms: [] };
        let omitted = false;
        let retryable = false;
        const maxReadBytes = language === 'notebook' ? AUTO_NOTEBOOK_BYTES : WORKSPACE_LIMITS.maxFileBytes;
        // Reserve the maximum possible workspace read, including its overflow detection byte.
        if (language === 'unknown' || metadata.bytes > maxReadBytes) omitted = true;
        else if (readBytes + maxReadBytes + 1 > REPOSITORY_INDEX_LIMITS.readBytes) { omitted = true; retryable = true; }
        else {
          try {
            const content = language === 'notebook' ? await this.workspace.readNotebookFile(metadata.path, signal, maxReadBytes) : await this.workspace.readFile(metadata.path, signal);
            check();
            if (content.bytesRead < 0 || content.bytesRead > maxReadBytes + 1) throw new LittleError('CONTEXT_LIMIT', 'The workspace read exceeded the index budget.');
            readBytes += content.bytesRead;
            const notebook = language === 'notebook' ? extractNotebookSource(content.content, content.path, {}, signal) : undefined;
            const extracted = extract(notebook?.content ?? content.content, language);
            file = { ...file, symbols: extracted.symbols, imports: extracted.imports, terms: extracted.terms };
            omitted = content.truncated || extracted.truncated || !!notebook?.truncated;
          } catch (error) {
            check();
            if (!(error instanceof LittleError) || !['TOOL_FAILED', 'CONTEXT_LIMIT'].includes(error.code)) throw error;
            // A binary/oversized read can consume the entire reserved buffer before failing.
            readBytes += maxReadBytes + 1;
            omitted = true;
          }
        }
        processed++;
        symbolCount += file.symbols.length;
        truncated ||= omitted;
        next.set(metadata.path, { fingerprint: identity, file: freezeFile(file), truncated: omitted, retryable });
        progress('indexing');
      }
      // Do not publish symbols from files or policies that changed while content was being inspected.
      const finalInventory = await this.workspace.inventory(signal);
      check(); validInventory(finalInventory);
      if (finalInventory.files.length !== inventory.files.length || finalInventory.files.some((file, index) => file.path !== inventory.files[index]?.path || fingerprint(file) !== fingerprint(inventory.files[index]!))) throw changed();
      truncated ||= finalInventory.truncated;
      const snapshot = freezeSnapshot({ files: [...next.values()].map(entry => entry.file), generation: this.generation + 1, truncated,
        stats: { files: next.size, processed, symbols: symbolCount, reused, updatedAt: Date.now() } });
      check();
      this.cache = next;
      this.generation = snapshot.generation;
      this.allDirty = false; this.dirty.clear();
      progress('ready', { generation: snapshot.generation, updatedAt: snapshot.stats.updatedAt });
      return snapshot;
    } catch (error) {
      if (signal.aborted || (error instanceof LittleError && error.code === 'AGENT_CANCELLED') || (error instanceof Error && error.name === 'AbortError')) {
        throw error instanceof LittleError ? error : new LittleError('AGENT_CANCELLED', 'Repository indexing stopped.');
      }
      progress('failed', { message: 'Repository indexing failed. Refresh the index to retry.' });
      throw error instanceof LittleError ? error : new LittleError('TOOL_FAILED', 'Repository indexing failed. Refresh the index to retry.');
    } finally { this.busy = false; }
  }
}
