import { access, cp, readFile, realpath, mkdir, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';
import { stageDesktopAgent } from './stage-desktop-agent.mjs';

// Rebuild the isolated agent bundles; retain the verified native editor/runtime binaries.
await import('./build.mjs');
await import('./setup-codeoss.mjs');
await access(packagedExecutable);
const productPath = path.join(packagedRoot, 'resources', 'app', 'product.json');
const product = JSON.parse(await readFile(productPath, 'utf8'));
if (product.applicationName !== 'little-code') throw new Error('Refusing to update a different desktop application.');
const destination = path.join(packagedRoot, 'resources', 'app', 'extensions', 'little-code');
const resolved = await realpath(destination);
if (path.relative(await realpath(packagedRoot), resolved).replaceAll('\\', '/') !== 'resources/app/extensions/little-code') throw new Error('Unexpected packaged agent path.');
const source = await stageDesktopAgent();
await cp(source, destination, { recursive: true });
const files = {};
async function assetFiles(relative) {
  const directory = path.join(source, relative);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    const stat = await lstat(path.join(source, child));
    if (stat.isSymbolicLink()) throw new Error('Linked document parser assets are not permitted.');
    if (stat.isDirectory()) result.push(...await assetFiles(child));
    else if (stat.isFile()) result.push(child);
    else throw new Error('Document parser assets must be regular files.');
  }
  return result;
}
const parserAssets = [...await assetFiles('dist/pdf'), ...await assetFiles('dist/document-licenses')];
for (const file of ['package.json', 'dist/extension.cjs', 'dist/webview.js', 'dist/webview.css', 'dist/document-pdf-worker.cjs', ...parserAssets]) {
  const bytes = await readFile(path.join(destination, file));
  const original = await readFile(path.join(source, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== createHash('sha256').update(original).digest('hex')) throw new Error(`Packaged agent differs: ${file}`);
  files[file] = { bytes: bytes.length, sha256 };
}
const report = { success: true, updatedAt: new Date().toISOString(), executable: packagedExecutable, extension: destination, files };
await mkdir(path.join(projectRoot, 'desktop', 'logs'), { recursive: true });
await writeFile(path.join(projectRoot, 'desktop', 'logs', 'agent-update.json'), JSON.stringify(report, null, 2));
console.log('Little Code agent updated in the standalone application. Reload Window or reopen LittleCode.lnk to load the new bundles.');
