import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSpectreLibraries } from './setup-native-toolchain.mjs';

let cached;
async function prepareLibraries(environment) {
  const configured = { ...environment, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  const props = await ensureSpectreLibraries(configured);
  if (props) {
    if (configured.ForceImportBeforeCppTargets && configured.ForceImportBeforeCppTargets !== props) configured.LittlePreviousForceImportBeforeCppTargets = configured.ForceImportBeforeCppTargets;
    configured.ForceImportBeforeCppTargets = props;
  }
  return configured;
}
/** Import the installed C++ developer environment without changing global settings. */
export async function nativeEnvironment() {
  if (cached) return cached;
  if (process.platform !== 'win32') return process.env;
  if (process.env.VCINSTALLDIR && process.env.VSCMD_VER) return cached = await prepareLibraries(process.env);
  const candidates = [];
  for (const year of ['2022', '2019']) {
    if (process.env[`vs${year}_install`]) candidates.push(path.join(process.env[`vs${year}_install`], 'Common7', 'Tools', 'VsDevCmd.bat'));
    for (const directory of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
        candidates.push(path.join(directory, 'Microsoft Visual Studio', year, edition, 'Common7', 'Tools', 'VsDevCmd.bat'));
      }
    }
  }
  let developerCommand;
  for (const candidate of candidates) {
    try { await access(candidate); developerCommand = candidate; break; } catch { /* try next installed edition */ }
  }
  if (!developerCommand) return process.env;
  console.log('Loading the installed Windows C++ build environment...');
  const child = spawn('cmd.exe', ['/d', '/c', `call "${developerCommand}" -no_logo -arch=x64 -host_arch=x64 >nul && set`], {
    env: { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1' }, windowsHide: true,
    windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Windows C++ developer environment initialization failed.')));
  });
  cached = { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1' };
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) cached[line.slice(0, separator)] = line.slice(separator + 1);
  }
  cached = await prepareLibraries(cached);
  return cached;
}
