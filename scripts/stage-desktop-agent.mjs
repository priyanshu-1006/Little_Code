import { access, cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sourceRoot } from './desktop-paths.mjs';

/** Little bundles its dependencies, so its staged built-in needs no native extension compilation. */
export async function stageDesktopAgent() {
  const source = path.join(sourceRoot, 'extensions', 'little-code');
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (manifest.name !== 'little-code' || manifest.publisher !== 'priyanshu-chaurasia') throw new Error('Unexpected Little built-in manifest.');
  await access(path.join(source, 'dist', 'extension.cjs'));
  await access(path.join(source, 'dist', 'webview.js'));
  const target = path.join(sourceRoot, '.build', 'extensions', 'little-code');
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  return target;
}
