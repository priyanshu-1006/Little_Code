import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchainRoot = path.join(projectRoot, 'desktop', 'toolchain');
const provenancePath = path.join(toolchainRoot, 'spectre-package.json');
const propsPath = path.join(toolchainRoot, 'little-spectre.props');

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function hasRequiredLibraries(directory) {
  return (await Promise.all(['libcmt.lib', 'msvcprt.lib', 'vcruntime.lib'].map(file => exists(path.join(directory, file))))).every(Boolean);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function powershellLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

/** Supply genuine Microsoft v142 Spectre libraries through a workspace MSBuild import. */
export async function ensureSpectreLibraries(environment) {
  if (process.platform !== 'win32') return undefined;
  const version = environment.VCToolsVersion?.trim();
  if (version !== '14.29.30133' || !environment.VCToolsInstallDir) return undefined;
  if (await hasRequiredLibraries(path.join(environment.VCToolsInstallDir, 'lib', 'spectre', 'x64'))) return undefined;

  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const payload = provenance.payload;
  if (new URL(payload.url).hostname !== 'download.visualstudio.microsoft.com' || !/^[a-f0-9]{64}$/.test(payload.sha256)) {
    throw new Error('Invalid Microsoft Spectre package provenance.');
  }
  const downloadDirectory = path.join(toolchainRoot, 'downloads');
  const archive = path.join(downloadDirectory, payload.fileName);
  const extractedRoot = path.join(toolchainRoot, 'msvc-v142-spectre');
  const libraryDirectory = path.join(extractedRoot, 'Contents', 'VC', 'Tools', 'MSVC', version, 'lib', 'spectre', 'x64');
  await mkdir(downloadDirectory, { recursive: true });

  if (!(await exists(archive))) {
    console.log('Downloading official Microsoft v142 Spectre libraries into the project...');
    const response = await fetch(payload.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Spectre library download failed: HTTP ${response.status}.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }));
  }
  if ((await stat(archive)).size !== payload.size || (await sha256(archive)) !== payload.sha256) {
    throw new Error('Microsoft Spectre package checksum or size mismatch. Extraction refused.');
  }

  if (!(await hasRequiredLibraries(libraryDirectory))) {
    if (await exists(extractedRoot)) throw new Error('Spectre extraction is incomplete. Remove only desktop/toolchain/msvc-v142-spectre and retry.');
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${powershellLiteral(archive)}, ${powershellLiteral(extractedRoot)})`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Microsoft Spectre package extraction failed: ${code}.`)));
    });
  }
  if (!(await hasRequiredLibraries(libraryDirectory))) throw new Error('Required genuine Microsoft Spectre libraries are missing after extraction.');
  await access(propsPath);
  console.log('Using verified Microsoft v142 Spectre libraries from desktop/toolchain.');
  return propsPath;
}
