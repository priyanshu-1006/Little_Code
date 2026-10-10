import { build, context } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PDF parsing uses local ESM assets in a bounded Node worker, never a CDN or Office runtime.
const pdfRoot = path.join(projectRoot, 'node_modules', 'pdfjs-dist');
const pdfDestination = path.join(projectRoot, 'dist', 'pdf');
await mkdir(pdfDestination, { recursive: true });
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) await cp(path.join(pdfRoot, 'legacy', 'build', file), path.join(pdfDestination, file));
for (const directory of ['cmaps', 'standard_fonts']) await cp(path.join(pdfRoot, directory), path.join(pdfDestination, directory), { recursive: true });
await cp(path.join(pdfRoot, 'LICENSE'), path.join(pdfDestination, 'LICENSE'));
const licenses = path.join(projectRoot, 'dist', 'document-licenses');
await mkdir(licenses, { recursive: true });
const visited = new Set();
const notices = [];
async function includeLicense(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const directory = path.join(projectRoot, 'node_modules', name);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory)).filter(file => /^(?:licen[cs]e|notice)(?:\.[a-z]+)?$/i.test(file));
  const target = path.join(licenses, name.replaceAll('/', '__'));
  await mkdir(target, { recursive: true });
  for (const file of files) await cp(path.join(directory, file), path.join(target, file));
  notices.push({ name, version: manifest.version, license: manifest.license, files });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await includeLicense(dependency);
}
for (const dependency of ['fflate', 'fast-xml-parser', 'pdf-lib', 'pdfjs-dist', '@thednp/dommatrix']) await includeLicense(dependency);
await writeFile(path.join(licenses, 'packages.json'), JSON.stringify(notices, null, 2) + '\n');
const options = [
  { entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node22' },
  { entryPoints: ['src/little/tools/document-pdf-worker.ts'], outfile: 'dist/document-pdf-worker.cjs', platform: 'node', format: 'cjs', target: 'node22' },
  { entryPoints: ['src/little/ui/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' } }
].map(item => ({ ...item, bundle: true, minify: true, sourcemap: true, logLevel: 'info' }));
if (process.argv.includes('--watch')) {
  const contexts = await Promise.all(options.map(item => context(item)));
  await Promise.all(contexts.map(item => item.watch()));
  console.log('Watching Little Code. Press F5 in the extension workspace.');
} else {
  await Promise.all(options.map(item => build(item)));
}
