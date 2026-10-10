import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyLittleWorkbenchPatch } from '../desktop/patches/little-workbench.mjs';
import { projectRoot, sourceRoot } from './desktop-paths.mjs';

await import('./setup-codeoss.mjs');
const branding = JSON.parse(await readFile(path.join(projectRoot, 'desktop', 'branding', 'manifest.json'), 'utf8'));
branding.assetCopies.push({ source: 'resources/app/little-logo.png', target: 'src/vs/workbench/contrib/little/browser/media/little-logo.png' });
for (const icon of await readdir(path.join(projectRoot, 'desktop', 'patches', 'native', 'media', 'icons'))) {
  if (!icon.endsWith('.svg')) continue;
  branding.assetCopies.push({ source: `desktop/patches/native/media/icons/${icon}`, target: `src/vs/workbench/contrib/little/browser/media/icons/${icon}` });
}
for (const font of await readdir(path.join(projectRoot, 'resources', 'fonts'))) {
  if (!/\.(woff2|ttf|css|txt|json)$/.test(font)) continue;
  branding.assetCopies.push({ source: `resources/fonts/${font}`, target: `src/vs/workbench/contrib/little/browser/media/fonts/${font}` });
  branding.assetCopies.push({ source: `resources/fonts/${font}`, target: `resources/fonts/${font}` });
}
const planned = new Map();
for (const patch of branding.textPatches) {
  const target = path.join(sourceRoot, patch.path);
  const current = planned.get(target) ?? await readFile(target, 'utf8');
  if (current.includes(patch.replace)) continue;
  if (current.split(patch.find).length !== 2) throw new Error(`Branding anchor changed in ${patch.path}. Source was preserved.`);
  planned.set(target, current.replace(patch.find, patch.replace));
}
for (const asset of branding.assetCopies) await access(path.join(projectRoot, asset.source));
await applyLittleWorkbenchPatch(sourceRoot, { checkOnly: true });
const productPath = path.join(sourceRoot, 'product.json');
const product = JSON.parse(await readFile(productPath, 'utf8'));
Object.assign(product, branding.productOverrides);
for (const key of branding.productDeletes) delete product[key];
await writeFile(productPath, `${JSON.stringify(product, null, '\t')}\n`);
for (const [target, content] of planned) await writeFile(target, content);
for (const asset of branding.assetCopies) {
  const target = path.join(sourceRoot, asset.target);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(projectRoot, asset.source), target);
}
const patchResult = await applyLittleWorkbenchPatch(sourceRoot);
console.log(`Little desktop prepared: ${branding.assetCopies.length} assets, ${patchResult.changed} workbench files updated.`);
