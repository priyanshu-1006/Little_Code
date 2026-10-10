import path from 'node:path';
import {access} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {sourceRoot} from './desktop-paths.mjs';
import {applyLittleWorkbenchPatch} from '../desktop/patches/little-workbench.mjs';

// Resource-only changes use the same copy pipeline as the full native bundle build.
await applyLittleWorkbenchPatch(sourceRoot, {checkOnly: true});
await access(path.join(sourceRoot, 'out-vscode', 'main.js'));
const {copyResources} = await import(pathToFileURL(path.join(sourceRoot, 'build', 'next', 'resources.ts')));
await copyResources(path.join(sourceRoot, 'src'), path.join(sourceRoot, 'out-vscode'), 'desktop', false);
console.log('Refreshed pinned native desktop resources; compiled JavaScript was preserved.');
