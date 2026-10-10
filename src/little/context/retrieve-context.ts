import * as path from 'node:path';
import type { EditorSnapshot } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { assertNotAborted, type WorkspaceService } from '../tools/workspace-service';
import { AUTO_NOTEBOOK_BYTES, type IndexedFile, type IndexSnapshot } from './repository-index';
import { extractNotebookSource } from '../tools/notebook-source';
import { redactSecrets } from './redact-secrets';

export const RETRIEVAL_LIMITS = Object.freeze({ maxCandidates: 12, maxFiles: 6, maxQueryChars: 4000, maxQueryTerms: 24, maxReasons: 6, maxExcerptChars: 1600, maxExcerptLines: 32, maxRankFiles: 2000 });
export const DEFAULT_RETRIEVAL_WEIGHTS = Object.freeze({ pathReference: 18, pathTerm: 5, symbolReference: 12, symbolTerm: 7, identifierTerm: 2, active: 6, open: 2, diagnostic: 8, importNeighbor: 5 });
export type RetrievalWeights = { [Key in keyof typeof DEFAULT_RETRIEVAL_WEIGHTS]: number };
export interface RetrievalOptions { limit?: number; weights?: Partial<RetrievalWeights> }
export interface RankedRepositoryFile { path: string; score: number; reasons: string[] }
export interface RetrievedSource extends RankedRepositoryFile { excerpt: string }

const STOP_WORDS = new Set('a an and are as at be can change code could do does explain file files find for from function give help how i implement implemented implementation in is it its let lets look me my need of on or our please project repository repo should show tell that the this to us use want what where which with would you your redacted'.split(' '));
const OVERVIEW_WORDS = new Set('about analyse analyze analysing analyzing analysed analyzed analysis architecture architectural application applications app apps backend back-end brief briefly codebase codebases complete component components connect connected connections data database databases dependencies dependency describe detail detailed details entire everything flow folder folders frontend front-end full general high level high-level layout monorepo module modules organisation organization overall overview package packages pattern patterns relationship relationships service services stack structure structured summarize summarise summary system systems tech technical technologies technology thoroughly understand understanding whole workspace works working'.split(' '));
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'composer.json', 'build.gradle', 'build.gradle.kts', 'deno.json', 'deno.jsonc']);
const WORKSPACE_CONFIGS = new Set(['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json', 'go.work', 'cargo.toml']);
const UNSAFE_NAMES = /^(?:\.env.*|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|\.netrc|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const GENERATED = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'generated', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.py', '.ipynb'];
const comparePaths = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function relative(input: string | undefined): string | undefined {
  if (!input || input.length > 4096 || /[\u0000-\u001f]/.test(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input)) return;
  const parts = input.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || UNSAFE_NAMES.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part) || GENERATED.has(part.toLowerCase()) || part.toLowerCase().startsWith('.little-edit-'))) return;
  return parts.join('/');
}

function words(value: string): string[] {
  const originals = value.toLowerCase().match(/[\p{L}\p{N}_$-]+/gu) ?? [];
  const separated = value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_$-]/g, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set([...originals, ...separated].filter(word => word.length > 1 && word.length <= 64 && !STOP_WORDS.has(word)))];
}
function overviewIntent(query: string): boolean {
  const safe = redactSecrets(query.slice(0, RETRIEVAL_LIMITS.maxQueryChars));
  const structural = /\b(?:architecture|architectural|overview|structure|monorepo)\b/i.test(safe);
  const repository = /\b(?:codebase|repository|repo|project|workspace|application|app|system)\b/i.test(safe);
  const broadAction = /\b(?:about|analyse|analyze|analysis|describe|explain|summarize|summarise|summary|understand|understanding)\b/i.test(safe);
  // A named feature, symbol or path keeps lexical retrieval, including an actual About screen.
  return (structural || (repository && broadAction)) && words(safe).every(word => OVERVIEW_WORDS.has(word) || ['notebook', 'notebooks'].includes(word));
}
function queryWords(query: string): string[] {
  const terms = words(redactSecrets(query.slice(0, RETRIEVAL_LIMITS.maxQueryChars)));
  return (overviewIntent(query) ? terms.filter(term => !OVERVIEW_WORDS.has(term)) : terms).slice(0, RETRIEVAL_LIMITS.maxQueryTerms);
}
function matches(term: string, candidates: readonly string[]): boolean {
  return candidates.some(candidate => candidate === term || (Math.min(candidate.length, term.length) >= 4 && (candidate.startsWith(term) || term.startsWith(candidate))));
}
function weights(options: RetrievalOptions): RetrievalWeights {
  const values: RetrievalWeights = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...options.weights };
  if (Object.values(values).some(value => !Number.isFinite(value) || value < 0 || value > 1000)) throw new LittleError('TOOL_VALIDATION_FAILED', 'Retrieval weights must be finite numbers between 0 and 1000.');
  return values;
}

function importedTarget(file: IndexedFile, specifier: string, files: ReadonlyMap<string, IndexedFile>): string | undefined {
  if (!specifier.startsWith('.') || /[\u0000-\u001f]/.test(specifier)) return;
  const requested = relative(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier.replaceAll('\\', '/'))));
  if (!requested) return;
  const base = SOURCE_EXTENSIONS.some(extension => requested.endsWith(extension)) ? requested.slice(0, -path.posix.extname(requested).length) : requested;
  return [requested, ...SOURCE_EXTENSIONS.map(extension => base + extension), ...SOURCE_EXTENSIONS.map(extension => `${requested}/index${extension}`)].find(candidate => files.has(candidate));
}

interface OverviewRole { project: string; priority: number; reason: string }
function overviewRoots(files: readonly IndexedFile[]): string[] {
  return files.filter(file => MANIFESTS.has(path.posix.basename(file.path).toLowerCase()) && file.path.split('/').length <= 4).map(file => path.posix.dirname(file.path)).filter(directory => directory !== '.').sort((left, right) => right.length - left.length || comparePaths(left, right));
}
function overviewRole(file: string, projectRoots: readonly string[]): OverviewRole | undefined {
  if (file.toLowerCase().endsWith('.ipynb')) return { project: path.posix.dirname(file), priority: 8, reason: 'notebook source cells' };
  const lower = file.toLowerCase();
  const directory = path.posix.dirname(file);
  const name = path.posix.basename(lower);
  const depth = file.split('/').length;
  if (depth === 1 && /^readme(?:\.[a-z0-9]+)?$/.test(name)) return { project: '.', priority: 14, reason: 'root README' };
  if (depth === 1 && MANIFESTS.has(name)) return { project: '.', priority: 13, reason: 'root project manifest' };
  if (depth === 1 && WORKSPACE_CONFIGS.has(name)) return { project: '.', priority: 12, reason: 'workspace configuration' };
  if (/^(?:docs\/)?architecture\.(?:md|rst|txt)$/i.test(file)) return { project: '.', priority: 12, reason: 'architecture documentation' };
  if (depth <= 4 && MANIFESTS.has(name)) return { project: directory, priority: 8, reason: 'subproject manifest' };
  const project = projectRoots.find(root => file.startsWith(`${root}/`)) ?? '.';
  const local = (project === '.' ? file : file.slice(project.length + 1)).toLowerCase();
  if (/^(?:src\/)?(?:main|index|app|server|lib)\.(?:[mc]?[jt]sx?|py|go|rs)$/.test(local) || /^(?:src\/)?(?:app\/layout|pages\/_app)\.[jt]sx?$/.test(local) || /^(?:manage\.py|app\/__init__\.py)$/.test(local)) {
    return { project, priority: project === '.' ? 10 : 7, reason: 'shallow application entrypoint' };
  }
  if (/^(?:tsconfig\.json|(?:vite|next|nuxt|webpack)\.config\.[a-z]+|(?:docker-)?compose\.ya?ml|dockerfile)$/i.test(local)) return { project, priority: project === '.' ? 9 : 6, reason: 'project configuration' };
  if (project !== '.' && /^readme(?:\.[a-z0-9]+)?$/.test(local)) return { project, priority: 5, reason: 'subproject README' };
  return;
}

/** Two root anchors, then one structural file per subproject before more files from the same app. */
function diverseOverview<T extends { path: string; score: number; overview?: OverviewRole }>(ranked: T[], limit: number): T[] {
  const selected: T[] = [];
  const groups = new Map<string, T[]>();
  for (const file of ranked) {
    if (!file.overview) continue;
    const group = groups.get(file.overview.project) ?? [];
    group.push(file); groups.set(file.overview.project, group);
  }
  const add = (file: T | undefined) => { if (file && selected.length < limit) selected.push(file); };
  const roots = groups.get('.') ?? [];
  add(roots.shift()); add(roots.shift());
  const projects = [...groups.entries()].filter(([name]) => name !== '.').sort(([left], [right]) => comparePaths(left, right)).map(([, files]) => files);
  while (selected.length < limit && projects.some(files => files.length)) {
    for (const files of projects) add(files.shift());
    if (selected.length < limit) add(roots.shift());
  }
  for (const file of roots) add(file);
  for (const file of ranked) if (!selected.some(item => item.path === file.path)) add(file);
  return selected;
}

/** Deterministic lexical heuristics, not embeddings or an AST dependency graph. Editor paths are relative. */
export function rankRepositoryFiles(snapshot: IndexSnapshot, query: string, editor: EditorSnapshot, options: RetrievalOptions = {}): RankedRepositoryFile[] {
  const scoring = weights(options);
  const limit = Math.max(0, Math.min(RETRIEVAL_LIMITS.maxCandidates, Math.floor(options.limit ?? RETRIEVAL_LIMITS.maxFiles)));
  if (!Number.isFinite(limit)) throw new LittleError('TOOL_VALIDATION_FAILED', 'A finite retrieval limit is required.');
  const terms = queryWords(query);
  const overview = overviewIntent(query);
  const normalizedQuery = redactSecrets(query.slice(0, RETRIEVAL_LIMITS.maxQueryChars)).toLowerCase().replaceAll('\\', '/');
  const files = snapshot.files.slice(0, RETRIEVAL_LIMITS.maxRankFiles).filter(file => relative(file.path) === file.path).sort((a, b) => comparePaths(a.path, b.path));
  const lookup = new Map(files.map(file => [file.path, file]));
  const projectRoots = overview ? overviewRoots(files) : [];
  const active = relative(editor.activeFile);
  const open = new Set(editor.openFiles.slice(0, 20).map(relative).filter((file): file is string => !!file));
  const diagnostic = new Set(editor.diagnostics.slice(0, 30).map(value => relative(/^(.+?):\d+(?::\d+)?(?::|\s)/.exec(value)?.[1])).filter((file): file is string => !!file));
  const ranked = files.map(file => {
    const reasons: string[] = [];
    const role = overview ? overviewRole(file.path, projectRoots) : undefined;
    let score = 0, queryScore = 0;
    const add = (amount: number, reason: string, lexical = false) => { if (amount <= 0) return; score += amount; if (lexical) queryScore += amount; reasons.push(reason.slice(0, 180)); };
    if (role) add(scoring.pathTerm * role.priority, `Repository overview: ${role.reason}`, true);
    if (normalizedQuery.includes(file.path.toLowerCase())) add(scoring.pathReference, 'Path explicitly referenced in the request', true);
    const pathMatches = terms.filter(term => matches(term, words(file.path)));
    if (pathMatches.length) add(scoring.pathTerm * pathMatches.length, `Path terms: ${pathMatches.slice(0, 4).join(', ')}`, true);
    const symbolNames = file.symbols.slice(0, 100).map(symbol => symbol.name);
    const exactSymbols = symbolNames.filter(name => terms.includes(name.toLowerCase()));
    if (exactSymbols.length) add(scoring.symbolReference * Math.min(exactSymbols.length, 4), `Symbol names: ${exactSymbols.slice(0, 3).join(', ')}`, true);
    const symbolMatches = terms.filter(term => matches(term, symbolNames.flatMap(words)));
    if (symbolMatches.length) add(scoring.symbolTerm * symbolMatches.length, `Symbol terms: ${symbolMatches.slice(0, 4).join(', ')}`, true);
    const identifierMatches = terms.filter(term => matches(term, file.terms.slice(0, 256).map(value => value.toLowerCase())));
    if (identifierMatches.length) add(scoring.identifierTerm * identifierMatches.length, `Indexed identifier terms: ${identifierMatches.slice(0, 4).join(', ')}`, true);
    if (file.path === active) add(scoring.active, 'Active editor file');
    if (open.has(file.path)) add(scoring.open, 'Open editor file');
    if (diagnostic.has(file.path)) add(scoring.diagnostic, 'Editor diagnostics in this file');
    return { path: file.path, score, queryScore, reasons, ...(role && scoring.pathTerm > 0 ? { overview: role } : {}) };
  });
  const order = (a: { score: number; path: string }, b: { score: number; path: string }) => b.score - a.score || comparePaths(a.path, b.path);
  const lexicalSeeds = ranked.filter(file => file.queryScore > 0).sort(order).slice(0, 4);
  const seeds = lexicalSeeds.length ? lexicalSeeds : ranked.filter(file => file.score > 0).sort(order).slice(0, 2);
  const links = new Map(files.map(file => [file.path, new Set(file.imports.slice(0, 80).map(specifier => importedTarget(file, specifier, lookup)).filter((target): target is string => !!target))]));
  for (const candidate of ranked) {
    for (const seed of seeds) {
      if (overview || candidate.path === seed.path || scoring.importNeighbor === 0) continue;
      if (links.get(seed.path)?.has(candidate.path) || links.get(candidate.path)?.has(seed.path)) {
        candidate.score += scoring.importNeighbor;
        candidate.reasons.push(`Relative import neighbor of ${seed.path}`.slice(0, 180));
      }
    }
  }
  const ordered = ranked.filter(file => file.score > 0 && (!overview || file.overview)).sort(order);
  return (overview ? diverseOverview(ordered, limit) : ordered.slice(0, limit)).map(({ path: file, score, reasons }) => ({ path: file, score, reasons: [...new Set(reasons)].slice(0, RETRIEVAL_LIMITS.maxReasons) }));
}

/** Optional context files may disappear, become private, exceed a budget, or stop being text. */
export function skipContextFile(error: unknown, signal: AbortSignal): boolean {
  assertNotAborted(signal);
  if (error instanceof LittleError) return error.code !== 'AGENT_CANCELLED' && ['PERMISSION_DENIED', 'WORKSPACE_BOUNDARY_VIOLATION', 'CONTEXT_LIMIT', 'TOOL_FAILED', 'TOOL_VALIDATION_FAILED'].includes(error.code);
  return ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function excerpt(file: string, content: string, terms: readonly string[], firstLine: number, truncated: boolean, budget: number): string {
  const lines = content.split(/\r?\n/);
  const hits = lines.map((line, index) => ({ index, score: terms.filter(term => matches(term, words(line))).length })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const anchors = hits.length ? hits.slice(0, 3).map(hit => hit.index).sort((a, b) => a - b) : [0];
  const selected = new Set<number>();
  for (const anchor of anchors) for (let i = Math.max(0, anchor - 3); i <= Math.min(lines.length - 1, anchor + 5) && selected.size < RETRIEVAL_LIMITS.maxExcerptLines; i++) selected.add(i);
  const indices = [...selected].sort((a, b) => a - b);
  const parts: string[] = [];
  let length = 0, previous = -2;
  for (const index of indices) {
    const header = index !== previous + 1 ? `${parts.length ? '\n' : ''}${file}:${firstLine + index}\n` : '';
    const source = `${firstLine + index}| ${lines[index]}\n`;
    const available = budget - length - header.length - 32;
    if (available <= 0) break;
    const line = header + source.slice(0, available);
    parts.push(line); length += line.length; previous = index;
    if (source.length > available) break;
  }
  if (truncated || indices.length < lines.length || length >= budget - 32) parts.push('[Source excerpt bounded]\n');
  return parts.join('').slice(0, budget);
}

/** Ranking reads metadata only. Every included source is freshly read through current workspace policy. */
export async function retrieveRepositorySources(workspace: WorkspaceService, snapshot: IndexSnapshot, query: string, editor: EditorSnapshot, signal: AbortSignal): Promise<RetrievedSource[]> {
  assertNotAborted(signal);
  const overview = overviewIntent(query);
  const terms = overview ? ['name', 'workspaces', 'scripts', 'dependencies', 'main', 'exports', 'import', 'listen', 'createroot', 'architecture'] : queryWords(query);
  const selected: RetrievedSource[] = [];
  for (const candidate of rankRepositoryFiles(snapshot, query, editor, { limit: RETRIEVAL_LIMITS.maxCandidates })) {
    assertNotAborted(signal);
    // Overview diversity must survive a manifest becoming ignored or disappearing after indexing.
    if (selected.length >= (overview ? RETRIEVAL_LIMITS.maxCandidates : RETRIEVAL_LIMITS.maxFiles)) break;
    try {
      if (candidate.path.toLowerCase().endsWith('.ipynb')) {
        const json = await workspace.readNotebookFile(candidate.path, signal, AUTO_NOTEBOOK_BYTES);
        const notebook = extractNotebookSource(json.content, json.path, {}, signal);
        const body = notebook.content.slice(0, RETRIEVAL_LIMITS.maxExcerptChars - 100);
        if (notebook.cells.length && body.trim()) selected.push({ ...candidate, path: notebook.path,
          excerpt: `${body}\n[Notebook excerpt bounded; citations are cell/source lines. Use read_notebook for more.]` });
        continue;
      }
      const current = await workspace.readFile(candidate.path, signal);
      let content = current.content, firstLine = 1, truncated = current.truncated;
      const file = snapshot.files.find(item => item.path === candidate.path);
      const prefixLines = content.split(/\r?\n/).length;
      const distantSymbol = current.truncated ? file?.symbols.find(symbol => symbol.line > prefixLines && Number.isSafeInteger(symbol.line) && matches(symbol.name.toLowerCase(), terms)) : undefined;
      if (distantSymbol) {
        const range = await workspace.readRange(candidate.path, Math.max(1, distantSymbol.line - 3), distantSymbol.line + 12, signal);
        if (range.content) { content = range.content; firstLine = range.startLine; truncated = range.truncated || range.endLine < range.totalLines; }
      }
      assertNotAborted(signal);
      const body = excerpt(current.path, redactSecrets(content), terms, firstLine, truncated, RETRIEVAL_LIMITS.maxExcerptChars);
      if (body.trim()) selected.push({ ...candidate, path: current.path, excerpt: body });
    } catch (error) { if (!skipContextFile(error, signal)) throw error; }
  }
  if (!overview) return selected;
  const projectRoots = overviewRoots(snapshot.files.slice(0, RETRIEVAL_LIMITS.maxRankFiles).filter(file => relative(file.path) === file.path));
  return diverseOverview(selected.map(source => ({ source, path: source.path, score: source.score, overview: overviewRole(source.path, projectRoots) })), RETRIEVAL_LIMITS.maxFiles).map(item => item.source);
}
