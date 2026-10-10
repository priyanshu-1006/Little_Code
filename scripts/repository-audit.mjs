import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only publication check. Reports locations and rule names, never matched values.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const staged = args.has('--staged');
const git = (arguments_, input) => spawnSync('git', arguments_, {
  cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const gitRoot = git(['rev-parse', '--show-toplevel']);
if (gitRoot.status !== 0 || path.resolve(gitRoot.stdout.trim()) !== root) {
  const report = { success: false, errors: [{ rule: 'repository-not-initialized', path: '.', guidance: 'Run git init -b main in this folder before auditing.' }] };
  console.log(json ? JSON.stringify(report, null, 2) : report.errors[0].guidance);
  process.exit(2);
}
const inventory = git(['ls-files', '-z', '--cached', ...(staged ? [] : ['--others', '--exclude-standard'])]);
if (inventory.status !== 0) throw new Error('Could not read the Git file inventory.');
const files = [...new Set(inventory.stdout.split('\0').filter(Boolean))].sort();
const errors = [], warnings = [], sizes = [];
const add = (list, file, rule, line) => list.push({ path: file, rule, ...(line ? { line } : {}) });
const privatePath = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials\.json|service-account[^/]*\.json|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(?:pem|key|p12|pfx|jks|vscdb|lnk))$/i;
const forbiddenPath = /^(?:\.upstream|node_modules|dist|coverage|desktop\/(?:logs|profile|cache|screenshots|release|releases|site-publish)|desktop\/installer\/staging|website\/dist)(?:\/|$)|(?:^|\/)(?:\.git|\.aws|\.azure|\.ssh|\.codex|\.agents|\.vercel)(?:\/|$)/;
const secretRules = [
  ['provider-token', /\b(?:gsk_[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}/g],
  ['credential-in-url', /https?:\/\/[^\s/<>"'`]+:[^\s/<>"'`]+@/g],
];
// Narrow, explicit redaction fixtures; this does not exempt all tests from scanning.
const synthetic = /^(?:gsk_(?:abcdefghijklmnop012345|abcdefghijklmnopqrstuvwxyz0123456789|(?:a{20,}|v{20,}|z{20,})|NATIVE_LOCAL_FIXTURE_ONLY_NOT_A_REAL_KEY_000000|PRIVATE_DO_NOT_DISPLAY|HostCredential1234567890|SourceCredential1234567890|LeakedCredential1234567890123456|SecretCredential123456789|CredentialValue123456789|PrivateProviderBodyAndPassword|PrivateNetworkDiagnostic|PrivateStreamDiagnostic)|sk-1234567890abcdefghijklmnop)$/;
const syntheticUrl = /^https?:\/\/(?:(?:user|u):(?:password|private-password|pass|p|secret)|alice:UniquePrivatePassword)@$/;
let scannedText = 0, knownFixtureMatches = 0, totalBytes = 0;
for (const file of files) {
  const normalized = file.replaceAll('\\', '/');
  if (forbiddenPath.test(normalized) || normalized.startsWith('desktop/toolchain/') && !['desktop/toolchain/little-spectre.props', 'desktop/toolchain/spectre-package.json'].includes(normalized)) {
    add(errors, file, 'generated-or-private-path');
    continue;
  }
  if (privatePath.test(normalized) && !/^\.env(?:\.[^/]*)?\.example$|^\.env\.example$/.test(normalized)) add(errors, file, 'credential-or-machine-file');
  if (normalized.includes('/.openai/') || normalized.startsWith('.openai/')) add(errors, file, 'local-hosting-state');
  const absolute = path.resolve(root, file);
  if (path.relative(root, absolute).startsWith('..') || path.isAbsolute(path.relative(root, absolute))) {
    add(errors, file, 'path-outside-repository'); continue;
  }
  let bytes;
  if (staged) {
    const content = spawnSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 128 * 1024 * 1024, shell: false });
    if (content.status !== 0) { add(errors, file, 'unreadable-index-entry'); continue; }
    bytes = content.stdout;
  } else {
    let stat;
    try { stat = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) { add(errors, file, 'symlink-not-reviewed'); continue; }
    if (!stat.isFile()) { add(errors, file, 'non-file-entry'); continue; }
    if (!path.relative(root, await realpath(absolute)).startsWith('..')) {
      if (stat.size > 100 * 1024 * 1024) { add(errors, file, 'github-100-MiB-limit'); sizes.push({ path: file, bytes: stat.size }); totalBytes += stat.size; continue; }
      bytes = await readFile(absolute);
    } else { add(errors, file, 'resolved-path-outside-repository'); continue; }
  }
  totalBytes += bytes.length;
  sizes.push({ path: file, bytes: bytes.length });
  if (bytes.length > 100 * 1024 * 1024) add(errors, file, 'github-100-MiB-limit');
  else if (bytes.length > 50 * 1024 * 1024) add(warnings, file, 'github-50-MiB-warning');
  if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) continue;
  const text = bytes.toString('utf8');
  scannedText++;
  for (const [rule, regex] of secretRules) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const fixture = normalized.startsWith('tests/') || /^scripts\/smoke-[^/]+\.mjs$/.test(normalized) || normalized === 'scripts/repository-audit.mjs';
      if (fixture && (synthetic.test(match[0]) || rule === 'credential-in-url' && syntheticUrl.test(match[0]))) { knownFixtureMatches++; continue; }
      add(errors, file, rule, text.slice(0, match.index).split('\n').length);
    }
  }
  if (/(?<![A-Za-z])C:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)(?!fixture(?:\\\\|\\|\/)|test(?:\\\\|\\|\/))/i.test(text)) add(warnings, file, 'machine-specific-user-path');
}
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (manifest.version !== lock.version || manifest.version !== lock.packages?.['']?.version) add(errors, 'package-lock.json', 'package-version-mismatch');
if (!files.some(file => /^licen[cs]e(?:\.[^/]+)?$/i.test(file))) add(warnings, '.', 'project-license-not-selected');
const guardPaths = ['.upstream/VSCode-win32-x64/Little Code.exe', 'node_modules/package.json', 'dist/extension.cjs', 'desktop/profile/private/state.vscdb', 'desktop/logs/probe.json', 'desktop/screenshots/user.png', 'desktop/releases/version/Setup.exe', 'desktop/installer/staging/build/file', 'desktop/site-publish/.git/config', 'website/dist/index.html', 'website/.openai/hosting.json', '.openai/project.json', '.vercel/project.json', '.env', 'private.pem', 'LittleCode.lnk'];
const ignored = git(['check-ignore', '--no-index', '--stdin', '-z'], guardPaths.join('\0') + '\0');
const ignoredSet = new Set(ignored.stdout.split('\0').filter(Boolean));
for (const file of guardPaths) if (!ignoredSet.has(file)) add(errors, file, 'ignore-protection-missing');
const remotes = git(['remote']);
const report = {
  success: errors.length === 0 && (!args.has('--strict') || warnings.length === 0),
  scope: staged ? 'staged-index' : 'tracked-and-unignored-working-files',
  fileCount: files.length, totalBytes, scannedTextFiles: scannedText, syntheticFixtureMatches: knownFixtureMatches,
  largestFiles: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 8),
  git: { branch: git(['symbolic-ref', '--short', 'HEAD']).stdout.trim(), remoteNames: remotes.stdout.trim().split('\n').filter(Boolean), authorNameConfigured: git(['config', 'user.name']).status === 0, authorEmailConfigured: git(['config', 'user.email']).status === 0 },
  errors, warnings,
  limitation: 'Heuristic preflight, not a complete secret or licensing review. No file values or remote URLs are printed. Existing Git history is outside this working-file check.',
};
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Repository audit ${report.success ? 'passed' : 'failed'}: ${report.fileCount} candidate files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB.`);
  for (const entry of errors) console.log(`ERROR ${entry.path}${entry.line ? `:${entry.line}` : ''} — ${entry.rule}`);
  for (const entry of warnings) console.log(`NOTE ${entry.path} — ${entry.rule}`);
  console.log(report.limitation);
}
process.exitCode = report.success ? 0 : 1;
