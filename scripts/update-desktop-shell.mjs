import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packagedExecutable, packagedRoot, projectRoot, sourceRoot } from './desktop-paths.mjs';

// Refresh compiled shell files without deleting the application or touching running processes.
// The mapping and metadata follow the pinned build/gulpfile.vscode.ts packageTask.
const commit = '2a59476c9bfcb90b3ddc372c36762471b7dfad1c';
const source = path.join(sourceRoot, 'out-vscode');
const destination = path.join(packagedRoot, 'resources', 'app', 'out');
const productPath = path.join(packagedRoot, 'resources', 'app', 'product.json');
const reportPath = path.join(projectRoot, 'desktop', 'logs', 'native-shell-update.json');
const checksumPaths = [
  'vs/base/parts/sandbox/electron-browser/preload.js',
  'vs/workbench/workbench.desktop.main.js',
  'vs/workbench/workbench.desktop.main.css',
  'vs/workbench/api/node/extensionHostProcess.js',
  'vs/code/electron-browser/workbench/workbench.html',
  'vs/code/electron-browser/workbench/workbench.js',
  'vs/sessions/sessions.desktop.main.js',
  'vs/sessions/sessions.desktop.main.css',
  'vs/sessions/electron-browser/sessions.html',
  'vs/sessions/electron-browser/sessions.js',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = value => value.replaceAll('\\', '/');
const report = { success: false, sourceCommit: commit, source, destination, files: [] };

async function guardedRoot(root, expected) {
  if (normalized(path.relative(await realpath(projectRoot), await realpath(root))) !== expected) {
    throw new Error(`Unexpected build path: ${expected}`);
  }
}

async function inventory(root, relative = '', result = []) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = normalized(path.join(relative, entry.name));
    if (entry.isSymbolicLink()) throw new Error(`Linked build resource: ${name}`);
    if (entry.isDirectory()) await inventory(root, name, result);
    else if (entry.isFile()) {
      if (result.length >= 2000) throw new Error('Unexpected native build resource count.');
      const bytes = await readFile(path.join(root, name));
      result.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    } else throw new Error(`Unexpected build resource: ${name}`);
  }
  return result;
}

async function checkedParent(target) {
  const relative = path.relative(packagedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Update escaped application.');
  let cursor = packagedRoot;
  for (const segment of path.dirname(relative).split(path.sep)) {
    if (segment === '.') continue;
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked or invalid destination directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(cursor);
    }
  }
  const resolved = await realpath(path.dirname(target));
  if (path.relative(await realpath(packagedRoot), resolved) !== path.dirname(relative)) {
    throw new Error('Destination directory changed during update.');
  }
}

async function atomicWrite(target, bytes) {
  await checkedParent(target);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid destination resource.');
    if (hash(await readFile(target)) === hash(bytes)) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.little-update-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    if (hash(await readFile(temporary)) !== hash(bytes)) throw new Error('Temporary resource differs.');
    await checkedParent(target);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return true;
}

try {
  await guardedRoot(sourceRoot, '.upstream/codeoss');
  await guardedRoot(source, '.upstream/codeoss/out-vscode');
  await guardedRoot(packagedRoot, '.upstream/VSCode-win32-x64');
  await guardedRoot(destination, '.upstream/VSCode-win32-x64/resources/app/out');
  const sourceCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (sourceCommit !== commit) throw new Error('Native source revision changed.');
  const build = JSON.parse(await readFile(path.join(projectRoot, 'desktop', 'logs', 'native-shell-build.json'), 'utf8'));
  if (build.sourceCommit !== commit || build.exitCode !== 0 || build.bundles !== 25 || !build.command.includes('--nls')) {
    throw new Error('A successful native build with indexed NLS is required.');
  }
  const current = JSON.parse(await readFile(productPath, 'utf8'));
  const branded = JSON.parse(await readFile(path.join(sourceRoot, 'product.json'), 'utf8'));
  if (current.applicationName !== 'little-code' || branded.applicationName !== 'little-code' || current.commit !== commit) {
    throw new Error('Unexpected application identity or packaged revision.');
  }
  const executableHash = hash(await readFile(packagedExecutable));
  const files = await inventory(source);
  const names = new Set(files.map(file => file.path));
  for (const name of [...checksumPaths, 'main.js', 'mainImpl.js', 'nls.keys.json', 'nls.messages.json', 'vs/code/electron-browser/workbench/little-chrome.css']) {
    if (!names.has(name)) throw new Error(`Native resource missing: ${name}`);
  }
  const { computeNLSMetadataHash } = await import(pathToFileURL(path.join(sourceRoot, 'build', 'lib', 'nlsMetadata.ts')).href);
  const nlsMetadataHash = computeNLSMetadataHash(source, commit);
  const checksums = {};
  for (const name of checksumPaths) {
    checksums[name] = createHash('sha256').update(await readFile(path.join(source, name))).digest('base64').replace(/=+$/, '');
    if (checksums[name] !== build.checksums?.[name]) throw new Error(`Build evidence differs: ${name}`);
  }
  if (nlsMetadataHash !== build.nls?.metadataHash || build.nls?.indexed !== true) throw new Error('NLS build evidence differs.');
  const product = { ...branded };
  for (const key of ['version', 'copilotVersions', 'agentSdks', 'dictationRuntime', 'target']) {
    if (Object.hasOwn(current, key)) product[key] = current[key];
  }
  Object.assign(product, { commit, nlsMetadataHash, date: (await readFile(path.join(source, 'date'), 'utf8')).trim(), checksums });
  const order = name => name === 'main.js' || name === 'mainImpl.js' ? 3 : name.endsWith('.js') ? 2 : 1;
  files.sort((a, b) => order(a.path) - order(b.path) || a.path.localeCompare(b.path));
  for (const file of files) {
    const bytes = await readFile(path.join(source, file.path));
    if (hash(bytes) !== file.sha256) throw new Error(`Build changed during update: ${file.path}`);
    const changed = await atomicWrite(path.join(destination, file.path), bytes);
    report.files.push({ ...file, changed });
  }
  for (const file of files) {
    if (hash(await readFile(path.join(source, file.path))) !== file.sha256 || hash(await readFile(path.join(destination, file.path))) !== file.sha256) {
      throw new Error(`Native resource verification failed: ${file.path}`);
    }
  }
  if (hash(await readFile(packagedExecutable)) !== executableHash) throw new Error('Executable changed during native update.');
  await atomicWrite(productPath, Buffer.from(JSON.stringify(product, null, 2) + '\n'));
  if (computeNLSMetadataHash(destination, commit) !== nlsMetadataHash) throw new Error('Packaged NLS differs.');
  for (const [name, expected] of Object.entries(checksums)) {
    if (createHash('sha256').update(await readFile(path.join(destination, name))).digest('base64').replace(/=+$/, '') !== expected) {
      throw new Error(`Packaged checksum differs: ${name}`);
    }
  }
  Object.assign(report, {
    success: true, updatedAt: new Date().toISOString(), resources: files.length,
    changedResources: report.files.filter(file => file.changed).length,
    executableSha256: executableHash, executableUnchanged: true, nlsMetadataHash, checksums,
    productSha256: hash(await readFile(productPath)),
  });
  console.log(`Little Code native shell updated: ${report.changedResources}/${files.length} resources; runtime preserved. Fully close and reopen LittleCode.lnk to load it.`);
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}
