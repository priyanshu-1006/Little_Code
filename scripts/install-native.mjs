import { spawn } from 'node:child_process';
import { nativeEnvironment } from './native-environment.mjs';
import { sourceRoot } from './desktop-paths.mjs';

const environment = { ...await nativeEnvironment(), npm_command: 'ci' };
async function run(command, args, shell = false) {
  const child = spawn(command, args, { cwd: sourceRoot, env: environment, shell, windowsHide: true, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Native dependency step exited with ${code}.`)));
  });
}
try {
  // Prepare pinned headers and upstream compatibility overlays before addon scripts.
  await run(process.execPath, ['build/npm/preinstall.ts']);
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--prefer-offline', '--foreground-scripts', '--no-audit', '--no-fund'], process.platform === 'win32');
} catch (error) { console.error(error.message); process.exitCode = 1; }
