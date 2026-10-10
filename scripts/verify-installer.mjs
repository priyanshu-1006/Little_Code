import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { packagedRoot, projectRoot, sourceRoot } from './desktop-paths.mjs';

const arguments_ = process.argv.slice(2);
const help = 'Usage: node scripts/verify-installer.mjs --report="desktop/releases/<owned-build-id>/installer-report.json" [--native-report="desktop/logs/native-build-tools-smoke-<receipt>.json"] [--cleanup-report="desktop/logs/native-build-tools-cleanup-<receipt>.json"]\nRead-only verification of the installer and every staged/current packaged input; writes only a new ignored independent-verification.json beside the report. Never extracts/runs setup, installs tools or deletes files. Native smoke assertions are bound only to matching unchanged bundle signatures. Separate cleanup reconciliation proves absence of the original root PID, not its original exit status or the entire process tree.';
if (arguments_.length === 1 && arguments_[0] === '--help') { console.log(help); process.exit(0); }
const inputs = new Map();
for (const argument of arguments_) {
  const match = /^--(report|native-report|cleanup-report)=(.+)$/u.exec(argument);
  if (!match || inputs.has(match[1]) || match[2].length > 4096 || /[\0\r\n]/u.test(match[2])) throw new Error(help);
  inputs.set(match[1], match[2]);
}
if (!inputs.has('report')) throw new Error(help);
const input = inputs.get('report');
const releasesRoot = path.join(projectRoot, 'desktop', 'releases');
const reportPath = path.resolve(projectRoot, input);
const buildDirectory = path.dirname(reportPath);
const buildId = path.basename(buildDirectory);
assert.equal(path.basename(reportPath), 'installer-report.json');
assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/u.test(buildId), 'Report must belong to an owned installer build.');
assert.ok(samePath(path.dirname(buildDirectory), releasesRoot), 'Report must be directly inside desktop/releases/<owned-build-id>.');
const stagingDirectory = path.join(projectRoot, 'desktop', 'installer', 'staging', buildId);
const verificationPath = path.join(buildDirectory, 'independent-verification.json');
const shaPattern = /^[a-f0-9]{64}$/u;
const excluded = 'resources/app/node-compile-cache';
const extensionPrefix = 'resources/app/extensions/little-code/';
const nativeBundlePaths = ['package.json', 'dist/extension.cjs', 'dist/webview.js', 'dist/webview.css'].map(file => extensionPrefix + file);
const logsRoot = path.join(projectRoot, 'desktop', 'logs');
function evidencePath(input, kind) {
  const filename = path.resolve(projectRoot, input);
  assert.ok(samePath(path.dirname(filename), logsRoot), `${kind} evidence must be directly inside ignored desktop/logs.`);
  const pattern = kind === 'native' ? /^native-build-tools-smoke(?:-[a-z0-9-]{1,100})?\.json$/u : /^native-build-tools-cleanup(?:-[a-z0-9-]{1,100})?\.json$/u;
  assert.ok(pattern.test(path.basename(filename)), `${kind} evidence must have its designated receipt filename.`);
  return filename;
}
const nativePath = evidencePath(inputs.get('native-report') ?? 'desktop/logs/native-build-tools-smoke.json', 'native');
const cleanupPath = inputs.has('cleanup-report') ? evidencePath(inputs.get('cleanup-report'), 'cleanup') : undefined;

function samePath(left, right) {
  const first = path.resolve(left), second = path.resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}
function localPath(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\0\r\n\\:]/u.test(value), 'Manifest file path is invalid.');
  assert.ok(!path.posix.isAbsolute(value) && value.split('/').every(segment => !!segment && segment !== '.' && segment !== '..'), 'Manifest file path must stay inside its payload.');
  return value;
}
function expectedPath(value, expected, label) {
  assert.ok(typeof value === 'string' && !/[\0\r\n]/u.test(value) && samePath(value, expected), `${label} must match its designated workspace path.`);
}
async function direct(filename, kind = 'file', maximum = Infinity) {
  const relative = path.relative(projectRoot, filename);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Verification input must stay inside this workspace.');
  let cursor = projectRoot;
  const rootInfo = await lstat(cursor);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Workspace root must be a direct directory.');
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const metadata = await lstat(cursor);
    assert.ok(!metadata.isSymbolicLink(), `Linked/reparse verification path rejected: ${path.relative(projectRoot, cursor)}`);
  }
  assert.ok(samePath(await realpath(filename), filename), 'Verification input resolves to a different path.');
  const metadata = await lstat(filename);
  assert.ok(kind === 'directory' ? metadata.isDirectory() : metadata.isFile(), `Expected regular ${kind}: ${path.relative(projectRoot, filename)}`);
  assert.ok(metadata.size <= maximum, 'Verification input exceeds its size bound.');
  return metadata;
}
async function json(filename, maximum = 20 * 1024 * 1024) {
  await direct(filename, 'file', maximum);
  return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/u, ''));
}
function identity(metadata) { return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.birthtimeMs].join(':'); }
async function hash(filename) {
  const before = await direct(filename);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  const after = await direct(filename);
  assert.equal(identity(after), identity(before), `File changed during verification: ${path.relative(projectRoot, filename)}`);
  return digest.digest('hex');
}
async function inventory(root, excludeGenerated = false) {
  await direct(root, 'directory');
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory)).sort()) {
      const filename = path.join(directory, entry);
      const relative = path.relative(root, filename).split(path.sep).join('/');
      if (excludeGenerated && (relative === excluded || relative.startsWith(`${excluded}/`))) continue;
      localPath(relative);
      const metadata = await lstat(filename);
      assert.ok(!metadata.isSymbolicLink(), `Linked payload rejected: ${relative}`);
      if (metadata.isDirectory()) await visit(filename);
      else {
        assert.ok(metadata.isFile(), `Non-file payload rejected: ${relative}`);
        assert.ok(files.length < 50_000 && metadata.size < 2 * 1024 ** 3, 'Payload exceeds verification bounds.');
        files.push({ path: relative, bytes: metadata.size, identity: identity(metadata) });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function validateSignature(signature) {
  localPath(signature.path);
  assert.ok(shaPattern.test(signature.sha256), 'Expected SHA-256 signature is invalid.');
}
function peCertificate(bytes) {
  assert.ok(bytes.length >= 512 && bytes.toString('ascii', 0, 2) === 'MZ', 'Installer is not a Windows PE executable.');
  const header = bytes.readUInt32LE(0x3c);
  assert.ok(header + 264 <= bytes.length && bytes.toString('ascii', header, header + 4) === 'PE\0\0', 'Installer PE header is invalid.');
  const optional = header + 24;
  const magic = bytes.readUInt16LE(optional);
  assert.ok(magic === 0x10b || magic === 0x20b, 'Installer PE optional header is invalid.');
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  return { fileOffset: bytes.readUInt32LE(security), bytes: bytes.readUInt32LE(security + 4) };
}
async function windowsMetadata(artifact) {
  if (process.platform !== 'win32') return { authenticodeStatus: 'not_checked', reason: 'Windows PowerShell signature/version probe is available on Windows only.' };
  const modernShell = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  let powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if ((await lstat(modernShell)).isFile()) powershell = modernShell; } catch (error) { if (error.code !== 'ENOENT') return { authenticodeStatus: 'not_checked', reason: `Windows metadata shell discovery failed: ${error.code ?? error.name}` }; }
  const encodedPath = Buffer.from(artifact, 'utf8').toString('base64');
  const script = `$file = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sig = Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop; $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file); @{ authenticodeStatus=[string]$sig.Status; peFileVersion=[string]$version.FileVersion; productVersion=[string]$version.ProductVersion } | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 32000 });
    const result = JSON.parse(stdout.trim());
    assert.ok(['Valid', 'NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError', 'NotSupportedFileFormat', 'Incompatible'].includes(result.authenticodeStatus) && typeof result.peFileVersion === 'string' && result.peFileVersion.trim().length > 0, 'Windows metadata probe returned an empty or invalid response.');
    return { ...result, metadataShell: powershell };
  } catch (error) {
    return { authenticodeStatus: 'not_checked', reason: `Optional Windows metadata probe failed: ${error.code ?? error.name ?? 'unknown error'}` };
  }
}

function originalNativeResult(native) {
  return { success: native.success ?? null, assertionsPassed: native.assertionsPassed ?? null,
    cleanupConfirmed: native.cleanupConfirmed ?? null, testProcessExited: native.testProcessExited ?? null,
    processExitCode: native.processExitCode ?? native.exitCode ?? null,
    error: native.error ?? null, cleanupError: native.cleanupError ?? null };
}
function validateCleanupReceipt(cleanup, native, nativeSha256) {
  assert.equal(cleanup.formatVersion, 1);
  expectedPath(cleanup.nativeReport, nativePath, 'Cleanup native receipt');
  assert.equal(cleanup.nativeReportSha256, nativeSha256, 'Cleanup record must bind the exact preserved native receipt bytes.');
  assert.ok(Number.isSafeInteger(native.pid) && native.pid > 0 && native.pid <= 0x7fffffff, 'Native receipt must identify its original root PID.');
  assert.equal(cleanup.pid, native.pid, 'Cleanup PID differs from the native receipt.');
  expectedPath(native.executable, path.join(packagedRoot, 'Little Code.exe'), 'Native executable');
  expectedPath(native.verifiedProcessPath, native.executable, 'Native inspected process executable');
  expectedPath(cleanup.executable, native.executable, 'Cleanup executable');
  assert.ok(typeof native.profileRoot === 'string' && samePath(path.dirname(native.profileRoot), path.join(projectRoot, 'desktop', 'profile')) && /^build-tools-\d{10,16}-\d{1,10}-[a-f0-9]{8,32}$/u.test(path.basename(native.profileRoot)), 'Native profile must identify a dedicated owned build-tools smoke profile.');
  expectedPath(cleanup.profileRoot, native.profileRoot, 'Cleanup profile');
  const checkedAt = Date.parse(cleanup.checkedAt), finishedAt = Date.parse(native.finishedAt), startedAt = Date.parse(native.startedAt);
  assert.ok(typeof cleanup.checkedAt === 'string' && Number.isFinite(checkedAt) && Number.isFinite(finishedAt) && Number.isFinite(startedAt) && finishedAt >= startedAt && checkedAt >= finishedAt && checkedAt <= Date.now() + 5 * 60_000, 'Cleanup observation must be dated after the recorded native attempt.');
  assert.equal(cleanup.method, 'Get-CimInstance Win32_Process');
  assert.equal(cleanup.filter, `ProcessId = ${native.pid}`);
  assert.equal(cleanup.errorAction, 'Stop');
  assert.equal(cleanup.querySucceeded, true);
  assert.equal(cleanup.matchCount, 0);
  assert.equal(cleanup.independentlyAbsent, true);
  assert.equal(native.success, false, 'Reconciliation is only for an originally failed cleanup receipt.');
  assert.equal(native.cleanupConfirmed, false);
  assert.equal(native.testProcessExited, false);
  assert.equal(native.assertionsPassed, true);
  assert.equal(native.packagedBundlesUnchanged, true);
  assert.ok(!native.error, 'A functional native error cannot be repaired by a process-absence receipt.');
  const assertions = native.assertions && typeof native.assertions === 'object' ? Object.entries(native.assertions) : [];
  assert.ok(assertions.length > 0 && assertions.every(([, value]) => value === true), 'Every recorded native functional assertion must pass.');
}

// Read evidence before the expensive payload pass; preserve both receipts without rewriting either one.
let nativeEvidence, nativeSha256, nativeLoadError, cleanupEvidence, cleanupSha256;
try {
  await direct(nativePath, 'file', 2 * 1024 * 1024);
  nativeSha256 = await hash(nativePath);
  nativeEvidence = await json(nativePath, 2 * 1024 * 1024);
  assert.equal(await hash(nativePath), nativeSha256, 'Native receipt changed while reading it.');
} catch (error) {
  if (inputs.has('native-report') || cleanupPath) throw error;
  nativeLoadError = error;
}
if (cleanupPath) {
  await direct(cleanupPath, 'file', 1024 * 1024);
  cleanupSha256 = await hash(cleanupPath);
  cleanupEvidence = await json(cleanupPath, 1024 * 1024);
  assert.equal(await hash(cleanupPath), cleanupSha256, 'Cleanup receipt changed while reading it.');
  validateCleanupReceipt(cleanupEvidence, nativeEvidence, nativeSha256);
}

const report = await json(reportPath);
const installerReportSha256 = await hash(reportPath);
assert.equal(report.success, true); assert.equal(report.compilerExitCode, 0);
assert.equal(report.installTarget, 'user');
expectedPath(report.source, packagedRoot, 'Packaged source');
expectedPath(report.stagingDirectory, stagingDirectory, 'Staging directory');
const rootPackage = await json(path.join(projectRoot, 'package.json'), 1024 * 1024);
assert.equal(report.littleVersion, rootPackage.version, 'Installer report must match the current product version.');
assert.ok(/^\d+\.\d+\.\d+$/u.test(report.littleVersion) && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(report.codeossVersion));
const artifact = path.join(buildDirectory, `LittleCode-${report.littleVersion}-CodeOSS-${report.codeossVersion}-win32-x64-UserSetup.exe`);
expectedPath(report.artifact, artifact, 'Installer artifact');
const artifactMetadata = await direct(artifact, 'file', 2 * 1024 ** 3 - 1);
assert.ok(artifactMetadata.size > 0 && artifactMetadata.size === report.bytes && shaPattern.test(report.sha256));
const installerSha256 = await hash(artifact);
assert.equal(installerSha256, report.sha256, 'Installer SHA-256 differs from the compiler report.');
assert.ok(typeof report.payloadManifest === 'string' && samePath(path.dirname(report.payloadManifest), buildDirectory));
assert.ok(/^payload-manifest(?:\.resume-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8})?\.json$/u.test(path.basename(report.payloadManifest)));
const manifestPath = path.resolve(report.payloadManifest);
await direct(manifestPath, 'file', 20 * 1024 * 1024);
const manifestSha256 = await hash(manifestPath);
assert.equal(manifestSha256, report.payloadManifestSha256, 'Payload manifest SHA-256 differs from the compiler report.');
const manifest = await json(manifestPath);
assert.equal(manifest.formatVersion, 1);
for (const key of ['source', 'littleVersion', 'codeossVersion', 'codeossCommit', 'appId', 'installTarget', 'compiler', 'sourceSignatures', 'brandingSignatures', 'ignoredGeneratedDirectories']) assert.deepEqual(manifest[key], report[key], `Payload/report provenance mismatch: ${key}`);
assert.deepEqual(report.ignoredGeneratedDirectories, [excluded], 'Only the known runtime-generated compile cache may be excluded.');
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 50_000);
const expectedFiles = new Map(); const normalizedFiles = new Set();
for (const file of manifest.files) {
  validateSignature(file);
  assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes < 2 * 1024 ** 3);
  const normalized = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
  assert.ok(!normalizedFiles.has(normalized), 'Payload manifest has duplicate/case-aliased files.');
  normalizedFiles.add(normalized); expectedFiles.set(file.path, file);
}
const [sourceFiles, stagedFiles] = await Promise.all([inventory(packagedRoot, true), inventory(stagingDirectory)]);
assert.ok(sourceFiles.reduce((sum, file) => sum + file.bytes, 0) <= 10 * 1024 ** 3 && stagedFiles.reduce((sum, file) => sum + file.bytes, 0) <= 10 * 1024 ** 3, 'Total application payload exceeds the 10 GiB verification bound.');
const expectedNames = [...expectedFiles.keys()].sort();
assert.deepEqual(sourceFiles.map(file => file.path), expectedNames, 'Current packaged file inventory differs from the manifest.');
assert.deepEqual(stagedFiles.map(file => file.path), expectedNames, 'Staged file inventory differs from the manifest.');
assert.equal(report.files, expectedFiles.size);
assert.equal(sourceFiles.reduce((sum, file) => sum + file.bytes, 0), report.payloadBytes, 'Current packaged byte count changed.');
const sourceHashes = new Map(), stagedHashes = new Map(), fileEvidence = [];
for (const [index, file] of stagedFiles.entries()) {
  const expected = expectedFiles.get(file.path);
  assert.equal(file.bytes, expected.bytes, `Staged size mismatch: ${file.path}`);
  const stagedSha256 = await hash(path.join(stagingDirectory, ...file.path.split('/')));
  const sourceSha256 = await hash(path.join(packagedRoot, ...file.path.split('/')));
  assert.equal(stagedSha256, expected.sha256, `Staged SHA-256 mismatch: ${file.path}`);
  if (file.path !== 'resources/app/product.json') {
    assert.equal(sourceFiles[index].bytes, expected.bytes, `Packaged size mismatch: ${file.path}`);
    assert.equal(sourceSha256, expected.sha256, `Packaged SHA-256 mismatch: ${file.path}`);
  }
  sourceHashes.set(file.path, sourceSha256); stagedHashes.set(file.path, stagedSha256);
  fileEvidence.push({ path: file.path, bytes: file.bytes, sourceSha256, stagedSha256 });
  if ((index + 1) % 500 === 0) console.log(`Independently verified ${index + 1}/${stagedFiles.length} staged and packaged input files.`);
}
const sourceProduct = await json(path.join(packagedRoot, 'resources', 'app', 'product.json'));
const stagedProductPath = path.join(stagingDirectory, 'resources', 'app', 'product.json');
assert.equal(await readFile(stagedProductPath, 'utf8'), `${JSON.stringify({ ...sourceProduct, target: 'user' }, null, '\t')}\n`, 'product.json differs beyond the documented per-user target/serialization transform.');
assert.equal(sourceProduct.applicationName, 'little-code'); assert.equal(sourceProduct.nameShort, 'Little Code'); assert.equal(sourceProduct.enableTelemetry, false);
assert.equal(sourceProduct.commit, report.codeossCommit);
const sourceExtension = await json(path.join(packagedRoot, ...`${extensionPrefix}package.json`.split('/')));
const stagedExtension = await json(path.join(stagingDirectory, ...`${extensionPrefix}package.json`.split('/')));
assert.equal(sourceExtension.version, rootPackage.version); assert.equal(stagedExtension.version, rootPackage.version);
const appPackage = await json(path.join(packagedRoot, 'resources', 'app', 'package.json'));
assert.equal(appPackage.version, report.codeossVersion);
assert.ok(Array.isArray(report.sourceSignatures));
for (const signature of report.sourceSignatures) { validateSignature(signature); assert.equal(sourceHashes.get(signature.path), signature.sha256, `Source critical signature differs: ${signature.path}`); }
for (const file of nativeBundlePaths) assert.ok(report.sourceSignatures.some(signature => signature.path === file), `Missing critical signature: ${file}`);
assert.ok(Array.isArray(manifest.stagedSignatures));
for (const signature of manifest.stagedSignatures) { validateSignature(signature); assert.equal(stagedHashes.get(signature.path), signature.sha256, `Staged critical signature differs: ${signature.path}`); }
const compilerPath = path.join(sourceRoot, 'node_modules', 'innosetup', 'bin', 'ISCC.exe');
expectedPath(report.compiler?.path, compilerPath, 'Inno Setup compiler');
assert.equal(await hash(compilerPath), report.compiler.sha256, 'Current compiler differs from build provenance.');
const compilerPackage = await json(path.join(sourceRoot, 'node_modules', 'innosetup', 'package.json'));
const upstreamLock = await json(path.join(sourceRoot, 'package-lock.json'));
const compilerLock = upstreamLock.packages?.['node_modules/innosetup'];
assert.equal(compilerPackage.version, report.compiler.version); assert.equal(compilerLock?.version, report.compiler.version);
assert.equal(compilerLock?.integrity, report.compiler.npmIntegrity);
assert.ok(compilerLock?.resolved?.startsWith('https://registry.npmjs.org/innosetup/'));
assert.equal(await hash(path.join(projectRoot, 'desktop', 'installer', 'little-code.iss')), report.templateSha256, 'Installer template changed after build.');
assert.ok(Array.isArray(report.brandingSignatures) && report.brandingSignatures.length === 3);
assert.deepEqual(report.brandingSignatures.map(asset => asset.name).sort(), ['code.ico', 'inno-big-100.bmp', 'inno-small-100.bmp']);
for (const asset of report.brandingSignatures) {
  assert.ok(shaPattern.test(asset.sha256));
  assert.equal(await hash(path.join(buildDirectory, 'installer-assets', asset.name)), asset.sha256);
  assert.equal(await hash(path.join(projectRoot, 'resources', 'app', asset.name)), asset.sha256);
}
assert.ok(typeof report.compileLog === 'string' && samePath(path.dirname(report.compileLog), buildDirectory));
assert.ok(/^compile(?:\.resume-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8})?\.log$/u.test(path.basename(report.compileLog)));
await direct(report.compileLog, 'file', 8 * 1024 * 1024);
const compileLogSha256 = await hash(report.compileLog);
const updaterPath = path.join(projectRoot, 'desktop', 'logs', 'agent-update.json');
const updater = await json(updaterPath);
assert.equal(updater.success, true); expectedPath(updater.executable, path.join(packagedRoot, 'Little Code.exe'), 'Updater executable');
expectedPath(updater.extension, path.join(packagedRoot, ...extensionPrefix.split('/')), 'Updater extension');
assert.ok(updater.files && typeof updater.files === 'object' && Object.keys(updater.files).length >= 5 && Object.keys(updater.files).length <= 5000);
const agentAssets = [];
for (const [name, evidence] of Object.entries(updater.files)) {
  const local = extensionPrefix + localPath(name);
  assert.ok(shaPattern.test(evidence.sha256) && Number.isSafeInteger(evidence.bytes) && evidence.bytes >= 0);
  assert.equal(expectedFiles.get(local)?.bytes, evidence.bytes, `Updater asset size differs: ${name}`);
  assert.equal(stagedHashes.get(local), evidence.sha256, `Updater/staged asset differs: ${name}`);
  assert.equal(sourceHashes.get(local), evidence.sha256, `Updater/packaged asset differs: ${name}`);
  agentAssets.push({ path: name, bytes: evidence.bytes, sha256: evidence.sha256 });
}
for (const name of ['package.json', 'dist/extension.cjs', 'dist/webview.js', 'dist/webview.css', 'dist/document-pdf-worker.cjs']) assert.ok(updater.files[name], `Updater lacks required asset: ${name}`);
const header = Buffer.alloc(64 * 1024), handle = await open(artifact, 'r');
let read;
try { read = await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
const certificateTable = peCertificate(header.subarray(0, read.bytesRead));
assert.equal(report.unsigned, certificateTable.bytes === 0, 'PE signing table differs from compiler report.');
assert.ok(certificateTable.fileOffset + certificateTable.bytes <= artifactMetadata.size, 'PE certificate table is outside installer bounds.');
const metadata = await windowsMetadata(artifact);
if (metadata.peFileVersion) assert.equal(metadata.peFileVersion.trim(), `${rootPackage.version}.0`, 'Installer PE file version must match the current product version.');
if (metadata.authenticodeStatus !== 'not_checked' && report.unsigned) assert.equal(metadata.authenticodeStatus, 'NotSigned', 'Installer signature status differs from unsigned provenance.');
let nativeBuildTools = { status: 'not_available', boundToVerifiedBundles: false, reason: 'No native build-tools report is present.' };
if (nativeEvidence) {
  const native = nativeEvidence;
  nativeBuildTools = { status: 'present_unbound', boundToVerifiedBundles: false, report: nativePath, sha256: nativeSha256, originalResult: originalNativeResult(native), reason: 'Native report does not prove matching, unchanged packaged bundles and successful cleanup.' };
  const signatures = native.packagedBundleSignatures;
  const matching = Array.isArray(signatures) && nativeBundlePaths.every(local => signatures.some(signature => signature.path === local && signature.sha256 === stagedHashes.get(local) && signature.bytes === expectedFiles.get(local)?.bytes));
  const assertions = native.assertions && typeof native.assertions === 'object' ? Object.entries(native.assertions) : [];
  const functionalMatch = matching && native.packagedBundlesUnchanged === true && native.assertionsPassed === true && assertions.length > 0 && assertions.every(([, value]) => value === true) && typeof native.executable === 'string' && samePath(native.executable, path.join(packagedRoot, 'Little Code.exe'));
  if (functionalMatch && ((native.success === true && native.cleanupConfirmed === true) || cleanupEvidence)) {
    nativeBuildTools = { status: cleanupEvidence ? 'functional_pass_cleanup_reconciled' : 'verified_for_matching_bundles', boundToVerifiedBundles: true, report: nativePath, sha256: nativeSha256,
      originalResult: originalNativeResult(native), assertions: assertions.length, finishedAt: native.finishedAt, packagedBundleSignatures: signatures,
      limitations: 'Owned fixture verifies native menus and reviewed Node execution; no framework/SDK installation, Flutter runtime or generated installer lifecycle was executed.' };
    if (cleanupEvidence) nativeBuildTools.cleanupReconciliation = { ...cleanupEvidence, report: cleanupPath, sha256: cleanupSha256,
      scope: 'A later successful exact-PID query found the original root process absent. This does not prove original exit code 0, absence of every descendant, or a clean original smoke-script exit.' };
  }
  if (cleanupEvidence) assert.equal(nativeBuildTools.boundToVerifiedBundles, true, 'Reconciled native receipt does not match the verified installer bundle bytes.');
  assert.equal(await hash(nativePath), nativeSha256, 'Preserved native receipt changed during verification.');
} else if (nativeLoadError?.code !== 'ENOENT') {
  nativeBuildTools = { status: 'unavailable_or_invalid', boundToVerifiedBundles: false, reason: nativeLoadError?.message ?? 'Native report unavailable.' };
}
if (cleanupEvidence) assert.equal(await hash(cleanupPath), cleanupSha256, 'Cleanup receipt changed during verification.');
assert.deepEqual(await inventory(packagedRoot, true), sourceFiles, 'Packaged input identity changed during full verification.');
assert.deepEqual(await inventory(stagingDirectory), stagedFiles, 'Staged input identity changed during full verification.');
assert.equal(identity(await direct(artifact)), identity(artifactMetadata), 'Installer changed during verification.');
assert.equal(await hash(reportPath), installerReportSha256, 'Installer report changed during verification.');
const proof = { formatVersion: 3, checkedAt: new Date().toISOString(), success: true, artifact, bytes: artifactMetadata.size, sha256: installerSha256,
  littleVersion: rootPackage.version, codeossVersion: report.codeossVersion, payloadManifest: manifestPath, payloadManifestSha256: manifestSha256,
  installerReportSha256, files: expectedFiles.size, payloadBytes: stagedFiles.reduce((sum, file) => sum + file.bytes, 0), sourcePayloadBytes: report.payloadBytes,
  fullPayloadVerified: true, fullPackagedSourceVerified: true, allDocumentAssetsVerified: true, reparsePoints: 0, compilerExitCode: report.compilerExitCode,
  completedAt: report.completedAt, unsigned: certificateTable.bytes === 0, certificateTable, ...metadata, compileLogSha256,
  installationSmokeTest: 'not_run', installerExecuted: false, verificationScope: 'Installer checksum/PE metadata and every recorded staged/current packaged build input; compressed installer contents were not extracted.',
  productTransformation: 'Only target=user plus the build script’s documented JSON serialization; exact bytes checked.',
  agentUpdateSha256: await hash(updaterPath), agentAssets, nativeBuildTools, criticalFiles: fileEvidence.filter(file => nativeBundlePaths.includes(file.path) || ['Little Code.exe', 'resources/app/product.json', 'resources/app/package.json'].includes(file.path)), payload: fileEvidence,
  releaseUse: 'Development setup; signing, full dependency/license review and installed lifecycle validation remain release gates.' };
await direct(buildDirectory, 'directory');
try { await lstat(verificationPath); throw new Error('Independent verification already exists; this read-only verifier does not replace prior evidence. Use a new owned build.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(verificationPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ success: true, verification: verificationPath, version: proof.littleVersion, files: proof.files, agentAssets: agentAssets.length, sha256: proof.sha256, nativeBuildTools: nativeBuildTools.status, installerExecuted: false }, null, 2));
