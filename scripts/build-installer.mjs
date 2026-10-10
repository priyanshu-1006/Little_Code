import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { packagedRoot, projectRoot, sourceRoot } from './desktop-paths.mjs';

// Compile setup with the existing pinned compiler; never execute the generated installer,
// install system tools, edit the registry, fetch network resources or launch the application.
// A full build snapshots the already-built bundle. --check writes a no-staging preflight log.
const args = process.argv.slice(2);
const resumeArgument = args.find(argument => argument.startsWith('--resume='));
const resumeId = resumeArgument?.slice('--resume='.length);
if (args.some(argument => !['--check', '--help'].includes(argument) && argument !== resumeArgument) ||
  (resumeId !== undefined && (args.length !== 1 || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(resumeId)))) {
  throw new Error('Use node scripts/build-installer.mjs [--check | --resume=<owned-build-id>].');
}
if (args.includes('--help')) {
  console.log('Build Little Code Windows x64 per-user setup from the current packaged app.\nUse --check for no-staging preflight and a saved report. --resume=<owned-build-id> verifies and retries a preserved failed build without re-staging. Compilation never runs the resulting installer.');
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('The pinned Inno Setup compiler runs on Windows.');
const compiler = path.join(sourceRoot, 'node_modules', 'innosetup', 'bin', 'ISCC.exe');
const template = path.join(projectRoot, 'desktop', 'installer', 'little-code.iss');
const brandingDir = path.join(projectRoot, 'resources', 'app');
const outputRoot = path.join(projectRoot, 'desktop', 'releases');
const stagingRoot = path.join(projectRoot, 'desktop', 'installer', 'staging');
const logsRoot = path.join(projectRoot, 'desktop', 'logs');
const ignored = new Set(['resources/app/node-compile-cache']);
const brandingFiles = ['code.ico', 'inno-big-100.bmp', 'inno-small-100.bmp'];
const criticalPaths = ['Little Code.exe', 'resources/app/product.json', 'resources/app/package.json',
  'resources/app/extensions/little-code/package.json', 'resources/app/extensions/little-code/dist/extension.cjs',
  'resources/app/extensions/little-code/dist/webview.js', 'resources/app/extensions/little-code/dist/webview.css',
  'resources/app/LICENSE.txt', 'resources/app/ThirdPartyNotices.txt', 'LICENSES.chromium.html'];

async function hash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
function relative(filename) { return filename.split(path.sep).join('/'); }
function samePath(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function inside(root, filename) {
  const segment = path.relative(root, filename);
  if (!segment || segment.startsWith('..') || path.isAbsolute(segment)) throw new Error(`Output must stay inside its designated directory: ${filename}`);
}
function define(value) {
  if (typeof value !== 'string' || !value || /["\r\n\u0000]/.test(value)) throw new Error('Installer metadata must be a bounded single-line string.');
  return value;
}
async function inventory(root, withHashes = false, excludeGenerated = true) {
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory)).sort();
    for (const name of entries) {
      const filename = path.join(directory, name);
      const local = relative(path.relative(root, filename));
      if (excludeGenerated && [...ignored].some(prefix => local === prefix || local.startsWith(`${prefix}/`))) continue;
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error(`Linked payload is unavailable in this installer: ${local}`);
      if (info.isDirectory()) await visit(filename);
      else if (info.isFile()) {
        if (files.length >= 50_000) throw new Error('Installer payload exceeded 50,000 files.');
        files.push({ path: local, bytes: info.size, modifiedMs: info.mtimeMs, ...(withHashes ? { sha256: await hash(filename) } : {}) });
        if (withHashes && files.length % 500 === 0) console.log(`Verified hashes for ${files.length} staged files.`);
      } else throw new Error(`Unsupported installer payload: ${local}`);
    }
  }
  await visit(root);
  return files;
}
async function snapshot(source, target, files) {
  for (const file of files) {
    const destination = path.join(target, ...file.path.split('/'));
    inside(target, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    // COPYFILE_EXCL avoids replacing any existing staged data; every build owns a fresh directory.
    await copyFile(path.join(source, ...file.path.split('/')), destination, fsConstants.COPYFILE_EXCL);
  }
}
async function signatures(root) {
  return Promise.all(criticalPaths.map(async local => ({ path: local, sha256: await hash(path.join(root, ...local.split('/'))) })));
}
function unsignedPe(bytes) {
  if (bytes.length < 512 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Compiler did not produce a Windows executable.');
  const header = bytes.readUInt32LE(0x3c);
  if (header + 264 > bytes.length || bytes.toString('ascii', header, header + 4) !== 'PE\u0000\u0000') throw new Error('Installer PE header is invalid.');
  const optional = header + 24;
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unsupported installer PE optional header.');
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  return bytes.readUInt32LE(security + 4) === 0;
}

await access(compiler);
const realBundle = await realpath(packagedRoot);
if (!samePath(realBundle, packagedRoot)) throw new Error('The app bundle must be a direct workspace directory.');
const [product, appPackage, littlePackage, compilerPackage, upstreamLock, templateSource] = await Promise.all([
  readFile(path.join(packagedRoot, 'resources', 'app', 'product.json'), 'utf8').then(JSON.parse),
  readFile(path.join(packagedRoot, 'resources', 'app', 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(packagedRoot, 'resources', 'app', 'extensions', 'little-code', 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(sourceRoot, 'node_modules', 'innosetup', 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(sourceRoot, 'package-lock.json'), 'utf8').then(JSON.parse), readFile(template, 'utf8'),
]);
const lock = upstreamLock.packages['node_modules/innosetup'];
if (compilerPackage.version !== lock?.version || !lock.integrity || !lock.resolved?.startsWith('https://registry.npmjs.org/innosetup/')) {
  throw new Error('Inno Setup must match the pinned upstream dependency metadata.');
}
if (product.nameShort !== 'Little Code' || product.applicationName !== 'little-code' || product.enableTelemetry !== false ||
  product.win32AppUserModelId !== 'PriyanshuChaurasia.LittleCode' || !/^\{\{[0-9A-F-]{36}\}$/i.test(product.win32x64UserAppId)) {
  throw new Error('The bundle does not have the expected separate Little Code identity.');
}
if (!/^\d+\.\d+\.\d+$/.test(littlePackage.version) || !/^\d+\.\d+\.\d+(?:-\w+)?$/.test(appPackage.version)) throw new Error('Installer versions are invalid.');
if (/^\[Registry\]/m.test(templateSource) || /^\[Run\]/m.test(templateSource) || /PrivilegesRequired\s*=\s*admin/i.test(templateSource)) {
  throw new Error('This installer must retain its per-user scope and have no shell or launch hooks.');
}
const sourceSignatures = await signatures(packagedRoot);
const sourceFiles = await inventory(packagedRoot);
const payloadBytes = sourceFiles.reduce((sum, file) => sum + file.bytes, 0);
const storage = await statfs(projectRoot);
if (Number(storage.bavail) * Number(storage.bsize) < payloadBytes * 2 + 256 * 1024 * 1024) throw new Error('Not enough workspace disk space to stage and compile the app.');
const preflight = { checkedAt: new Date().toISOString(), success: true, source: packagedRoot, files: sourceFiles.length, payloadBytes,
  name: product.nameLong, littleVersion: littlePackage.version, codeossVersion: appPackage.version, codeossCommit: product.commit,
  appId: product.win32x64UserAppId, installTarget: 'user', compiler: { path: compiler, version: compilerPackage.version,
    sha256: await hash(compiler), npmIntegrity: lock.integrity }, sourceSignatures, templateSha256: await hash(template),
  brandingSignatures: await Promise.all(brandingFiles.map(async name => ({ name, sha256: await hash(path.join(brandingDir, name)) }))),
  ignoredGeneratedDirectories: [...ignored] };
await mkdir(logsRoot, { recursive: true });
await writeFile(path.join(logsRoot, 'installer-preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
console.log(`Installer preflight: ${sourceFiles.length} files, ${(payloadBytes / 1024 / 1024).toFixed(1)} MiB; Little Code ${littlePackage.version}, Code-OSS ${appPackage.version}.`);
if (args.includes('--check')) process.exit(0);

await mkdir(outputRoot, { recursive: true });
await mkdir(stagingRoot, { recursive: true });
if (!samePath(await realpath(outputRoot), outputRoot) || !samePath(await realpath(stagingRoot), stagingRoot)) throw new Error('Installer output directories must not be linked.');
const buildId = resumeId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
const staged = path.join(stagingRoot, buildId);
const output = path.join(outputRoot, buildId);
inside(stagingRoot, staged); inside(outputRoot, output);
const preparedBrandingDir = path.join(output, 'installer-assets');
const outputName = `LittleCode-${littlePackage.version}-CodeOSS-${appPackage.version}-win32-x64-UserSetup`;
const artifact = path.join(output, `${outputName}.exe`);
const retryId = resumeId ? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}` : undefined;
const payloadManifest = path.join(output, retryId ? `payload-manifest.resume-${retryId}.json` : 'payload-manifest.json');
let retryProvenance;
if (resumeId) {
  if (!samePath(await realpath(staged), staged) || !samePath(await realpath(output), output) ||
    !samePath(await realpath(preparedBrandingDir), preparedBrandingDir)) throw new Error('Preserved build directories must not be linked.');
  const existingArtifact = await lstat(artifact).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existingArtifact) throw new Error('A completed installer already exists. A compiler retry must not replace it.');
  const initialManifest = path.join(output, 'payload-manifest.json');
  if ((await lstat(initialManifest)).size > 20 * 1024 * 1024) throw new Error('Preserved payload manifest exceeds the expected bound.');
  const original = JSON.parse(await readFile(initialManifest, 'utf8'));
  for (const key of ['formatVersion', 'source', 'name', 'littleVersion', 'codeossVersion', 'codeossCommit', 'appId', 'installTarget',
    'compiler', 'sourceSignatures', 'brandingSignatures', 'ignoredGeneratedDirectories']) {
    if (JSON.stringify(original[key]) !== JSON.stringify(key === 'formatVersion' ? 1 : preflight[key])) {
      throw new Error(`The preserved build no longer matches the frozen package provenance: ${key}`);
    }
  }
  console.log(`Verifying preserved payload before compiler retry: ${staged}`);
  const stagedFiles = await inventory(staged, true, false);
  const fileEvidence = stagedFiles.map(({ modifiedMs: _modified, ...file }) => file);
  if (JSON.stringify(fileEvidence) !== JSON.stringify(original.files)) throw new Error('Preserved staged payload changed; compiler retry refused.');
  if (sourceFiles.length !== stagedFiles.length) throw new Error('Frozen source file inventory changed; compiler retry refused.');
  const expectedFiles = new Map(stagedFiles.map(file => [file.path, file]));
  let verifiedSourceFiles = 0;
  for (const file of sourceFiles) {
    const expected = expectedFiles.get(file.path);
    if (!expected) throw new Error('Frozen source file paths changed; compiler retry refused.');
    // product.json is intentionally staged with target=user; its original bytes are checked in sourceSignatures.
    if (file.path !== 'resources/app/product.json' && (file.bytes !== expected.bytes ||
      await hash(path.join(packagedRoot, ...file.path.split('/'))) !== expected.sha256)) {
      throw new Error(`Frozen source changed after staging: ${file.path}`);
    }
    if (++verifiedSourceFiles % 500 === 0) console.log(`Verified hashes for ${verifiedSourceFiles} frozen source files.`);
  }
  for (const asset of preflight.brandingSignatures) {
    if (await hash(path.join(preparedBrandingDir, asset.name)) !== asset.sha256) throw new Error('Preserved installer branding changed; compiler retry refused.');
  }
  const initialCompileLog = path.join(output, 'compile.log');
  await access(initialCompileLog);
  retryProvenance = { initialCompileLog, initialPayloadManifest: initialManifest,
    initialPayloadManifestSha256: await hash(initialManifest), previousTemplateSha256: original.templateSha256, resumedAt: new Date().toISOString() };
  const payload = { ...original, ...preflight, ...retryProvenance, stagedSignatures: await signatures(staged), files: fileEvidence };
  await writeFile(payloadManifest, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
} else {
  await mkdir(staged); await mkdir(output); await mkdir(preparedBrandingDir);
  for (const asset of preflight.brandingSignatures) {
    const destination = path.join(preparedBrandingDir, asset.name);
    await copyFile(path.join(brandingDir, asset.name), destination, fsConstants.COPYFILE_EXCL);
    if (await hash(destination) !== asset.sha256) throw new Error('Installer branding changed during staging. Rebuild after the asset update is finished.');
  }
  console.log(`Staging immutable payload: ${staged}`);
  await snapshot(packagedRoot, staged, sourceFiles);
  const afterFiles = await inventory(packagedRoot);
  const afterSignatures = await signatures(packagedRoot);
  if (JSON.stringify(afterFiles) !== JSON.stringify(sourceFiles) || JSON.stringify(sourceSignatures) !== JSON.stringify(afterSignatures)) {
    throw new Error('The packaged app changed while staging. Preserve this snapshot and rebuild after the app update is finished.');
  }
  const stagedProduct = path.join(staged, 'resources', 'app', 'product.json');
  await writeFile(stagedProduct, `${JSON.stringify({ ...product, target: 'user' }, null, '\t')}\n`);
  const stagedFiles = await inventory(staged, true, false);
  const payload = { formatVersion: 1, createdAt: new Date().toISOString(), ...preflight,
    stagedSignatures: await signatures(staged), files: stagedFiles.map(({ modifiedMs: _modified, ...file }) => file) };
  await writeFile(payloadManifest, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
}
const definitions = { AppId: product.win32x64UserAppId, NameLong: product.nameLong, LittleVersion: littlePackage.version,
  DirName: product.win32DirName, ExeBasename: product.nameShort, AppMutex: product.win32MutexName, AppUserId: product.win32AppUserModelId,
  SourceDir: staged, BrandingDir: preparedBrandingDir, OutputDir: output, OutputName: outputName };
const buildLog = path.join(output, retryId ? `compile.resume-${retryId}.log` : 'compile.log');
if (await hash(template) !== preflight.templateSha256) throw new Error('Installer template changed before compilation.');
let compilerOutput = '';
const child = spawn(compiler, ['/Qp', ...Object.entries(definitions).map(([key, value]) => `/D${key}=${define(value)}`), template],
  { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
try { if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Priority is best effort; compiler process ownership is unchanged. */ }
console.log(`Inno Setup compiler started (PID ${child.pid ?? 'pending'}) with a staged payload.`);
child.stdout.on('data', data => { compilerOutput += data.toString(); });
child.stderr.on('data', data => { compilerOutput += data.toString(); });
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
await writeFile(buildLog, compilerOutput, { flag: 'wx' });
if (exitCode !== 0) throw new Error(`Inno Setup exited ${exitCode}. Inspect ${buildLog}; staged sources were preserved.`);
if (await hash(template) !== preflight.templateSha256) throw new Error('Installer template changed during compilation; preserve this build for inspection.');
const artifactInfo = await lstat(artifact);
const artifactHandle = await open(artifact, 'r');
const headerBytes = Buffer.alloc(64 * 1024);
let bytesRead;
try { ({ bytesRead } = await artifactHandle.read(headerBytes)); } finally { await artifactHandle.close(); }
const report = { ...preflight, completedAt: new Date().toISOString(), success: true, artifact,
  bytes: artifactInfo.size, sha256: await hash(artifact), unsigned: unsignedPe(headerBytes.subarray(0, bytesRead)), payloadManifest,
  payloadManifestSha256: await hash(payloadManifest), compileLog: buildLog, stagingDirectory: staged, compilerExitCode: exitCode,
  ...(retryProvenance ? { compilerRetry: retryProvenance } : {}),
  installationSmokeTest: 'not_run', releaseSigning: 'not_configured', updateService: 'not_configured',
  installBehavior: { perUser: true, startMenuShortcut: true, desktopShortcut: 'optional', modifiesPath: false,
    registersFileAssociations: false, installsServices: false, launchesApplication: false, forceClosesApplications: false,
    preservesUserProfileOnUninstall: true } };
await writeFile(path.join(output, 'installer-report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${report.sha256}  ${path.basename(artifact)}\n${report.payloadManifestSha256}  ${path.basename(payloadManifest)}\n`);
await writeFile(path.join(logsRoot, 'installer-build.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Built ${artifact}\nSHA-256 ${report.sha256}\nInstallation was not executed; setup is unsigned.`);
