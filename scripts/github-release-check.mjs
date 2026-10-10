import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  return index === -1 ? [arg, true] : [arg.slice(0, index), arg.slice(index + 1)];
}));
const input = options.get('--installer'), expected = options.get('--sha256');
if (typeof input !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
  console.error('Usage: node scripts/github-release-check.mjs --installer="desktop/releases/<build>/LittleCode-<version>-CodeOSS-<upstream>-win32-x64-UserSetup.exe" --sha256=<verified-SHA256>');
  process.exit(2);
}
const directory = path.join(root, 'desktop', 'releases');
const installer = path.resolve(root, input);
const relative = path.relative(directory, installer);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Installer must be inside this repository’s desktop/releases folder.');
let cursor = directory;
for (const part of ['.', ...relative.split(path.sep)]) {
  cursor = path.resolve(cursor, part);
  if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Installer path must not contain symbolic links.');
}
if (await realpath(installer) !== installer) throw new Error('Installer resolves to a different path.');
const stat = await lstat(installer);
if (!stat.isFile() || stat.size < 1 || stat.size >= 2 * 1024 ** 3) throw new Error('Release asset must be a regular file under 2 GiB.');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!path.basename(installer).startsWith(`LittleCode-${manifest.version}-`) || !installer.endsWith('-win32-x64-UserSetup.exe')) throw new Error('Installer filename must match the current Windows x64 product version.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const actual = hash.digest('hex');
if (actual !== expected.toLowerCase()) throw new Error('Installer checksum does not match the independently verified release checksum.');
console.log(JSON.stringify({ success: true, version: manifest.version, asset: path.basename(installer), bytes: stat.size, sha256: actual, distribution: 'GitHub Release asset; never commit this installer.', limitation: 'Checksum/size/version preflight only. Native acceptance and signing status must be reviewed separately.' }, null, 2));
