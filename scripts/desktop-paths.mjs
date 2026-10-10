import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sourceRoot = path.join(projectRoot, '.upstream', 'codeoss');
export const nativeExecutable = path.join(sourceRoot, '.build', 'electron', 'Little Code.exe');
export const packagedRoot = path.join(projectRoot, '.upstream', 'VSCode-win32-x64');
export const packagedExecutable = path.join(packagedRoot, 'Little Code.exe');
