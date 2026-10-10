import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, '.upstream', 'codeoss');
const lock = JSON.parse(await readFile(path.join(root, 'codeoss.lock.json'), 'utf8'));
function git(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed.`);
  return result.stdout.trim();
}
let exists = false;
try { await access(upstream); exists = true; } catch { /* initial checkout */ }
if (!exists) {
  await mkdir(path.dirname(upstream), { recursive: true });
  git(['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--branch', lock.tag, '--single-branch', lock.repository, upstream]);
}
if (git(['rev-parse', 'HEAD'], upstream) !== lock.commit) {
  throw new Error('Upstream commit differs from codeoss.lock.json. Use a separate checkout; existing files were preserved.');
}
git(['config', 'core.longpaths', 'true'], upstream);
if (git(['ls-files', '--deleted'], upstream)) throw new Error('Upstream checkout has missing tracked files. Restore the missing files explicitly before setup; no source was overwritten.');
// Keep application identity separate from installed VS Code and Code-OSS profiles.
const productPath = path.join(upstream, 'product.json');
const product = JSON.parse(await readFile(productPath, 'utf8'));
const identity = name => {
  const bytes = createHash('sha1').update(`dev.littlecode.desktop/${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex').toUpperCase();
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};
Object.assign(product, {
  nameShort: 'Little Code', nameLong: 'Little Code', applicationName: 'little-code',
  dataFolderName: '.little-code', sharedDataFolderName: '.little-code-shared', win32DirName: 'Little Code', win32NameVersion: 'Little Code',
  win32AppUserModelId: 'PriyanshuChaurasia.LittleCode', darwinBundleIdentifier: 'dev.littlecode.desktop',
  win32MutexName: 'littlecode', win32RegValueName: 'LittleCode', win32ShellNameShort: 'Little Code',
  serverApplicationName: 'little-code-server', serverDataFolderName: '.little-code-server',
  tunnelApplicationName: 'little-code-tunnel', urlProtocol: 'little-code',
  win32TunnelServiceMutex: 'littlecode-tunnelservice', win32TunnelMutex: 'littlecode-tunnel',
  linuxDesktopName: 'dev.littlecode.desktop',
  darwinProfileUUID: identity('profile'), darwinProfilePayloadUUID: identity('profile-payload'),
  linuxIconName: 'little-code', quality: 'stable',
});
for (const target of ['x64', 'arm64', 'x64User', 'arm64User']) product[`win32${target}AppId`] = '{{' + identity(target) + '}';
for (const key of ['reportIssueUrl', 'defaultChatAgent', 'trustedExtensionAuthAccess', 'builtInExtensionsEnabledWithAutoUpdates', 'voiceWsUrl', 'extensionsGallery', 'telemetryEndpoint', 'aiConfig', 'agentSessionsWelcomePage']) delete product[key];
product.enableTelemetry = false;
await writeFile(productPath, `${JSON.stringify(product, null, '\t')}\n`);
const extension = path.join(upstream, 'extensions', 'little-code');
await mkdir(extension, { recursive: true });
// Build Little before setup. Bundles include runtime dependencies.
await access(path.join(root, 'dist', 'extension.cjs'));
await cp(path.join(root, 'dist'), path.join(extension, 'dist'), { recursive: true });
await cp(path.join(root, 'resources'), path.join(extension, 'resources'), { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
manifest.contributes.configurationDefaults = {
  ...manifest.contributes.configurationDefaults,
  'workbench.colorTheme': 'Little Dark / Neo Aurora',
  'workbench.startupEditor': 'none',
  'chat.disableAIFeatures': true,
  'editor.fontFamily': "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
};
delete manifest.scripts;
delete manifest.dependencies;
delete manifest.devDependencies;
await writeFile(path.join(extension, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const requiredNode = (await readFile(path.join(upstream, '.nvmrc'), 'utf8')).trim();
console.log(`Prepared Little Code on Code-OSS ${lock.tag} (${lock.commit}).`);
console.log(`Native build requires Node ${requiredNode} or newer in the same major, plus the pinned Windows C++ prerequisites.`);
console.log(`Source: ${upstream}`);
console.log('Run npm run desktop:build to compile the standalone Little Code application.');
