import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { packagedExecutable, projectRoot, sourceRoot } from './desktop-paths.mjs';
import { nativeEnvironment } from './native-environment.mjs';
import { stageDesktopAgent } from './stage-desktop-agent.mjs';

await mkdir(path.join(projectRoot, 'desktop', 'logs'), { recursive: true });
const log = createWriteStream(path.join(projectRoot, 'desktop', 'logs', 'build.log'), { flags: 'a' });
async function run(args, cwd) {
  console.log(`\nBuilding Little Code: npm ${args.join(' ')}`);
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, env: cwd === sourceRoot ? await nativeEnvironment() : process.env, shell: process.platform === 'win32', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited with ${code}`)));
  });
}
try {
  await run(['run', 'desktop:prepare'], projectRoot);
  await stageDesktopAgent();
  if (!process.argv.includes('--installed')) {
    const install = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'install-native.mjs')], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [install.stdout, install.stderr]) stream.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
    await new Promise((resolve, reject) => {
      install.once('error', reject);
      install.once('close', code => code === 0 ? resolve() : reject(new Error('Native dependency installation failed.')));
    });
  }
  const packageOnly = process.argv.includes('--package-only');
  if (packageOnly) {
    await access(path.join(sourceRoot, 'out-vscode', 'main.js'));
    await access(path.join(sourceRoot, 'out-vscode', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.js'));
    await access(path.join(sourceRoot, '.build', 'extensions', 'little-code', 'package.json'));
    await import('./refresh-desktop-resources.mjs');
  } else await run(['run', 'download-builtin-extensions'], sourceRoot);
  await run(['run', 'gulp', '--', packageOnly ? 'vscode-win32-x64-ci' : 'vscode-win32-x64'], sourceRoot);
  await access(packagedExecutable);
  const packagedApp = path.join(path.dirname(packagedExecutable), 'resources', 'app');
  await access(path.join(packagedApp, 'out', 'main.js'));
  await access(path.join(packagedApp, 'extensions', 'little-code', 'package.json'));
  if (process.platform === 'win32') {
    const shortcut = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts', 'create-shortcut.ps1'), '-ExecutablePath', packagedExecutable, '-ShortcutPath', path.join(projectRoot, 'LittleCode.lnk')], { windowsHide: true, stdio: 'inherit', shell: false });
    await new Promise((resolve, reject) => {
      shortcut.on('error', reject);
      shortcut.on('close', code => code === 0 ? resolve() : reject(new Error('Creating the Little Code shortcut failed.')));
    });
  }
  console.log(`\nLittle Code desktop is ready: ${packagedExecutable}\nDouble-click Start Little Code.cmd or the packaged Little Code.exe.`);
} catch (error) {
  console.error(`\nDesktop build stopped: ${error.message}\nSee desktop/logs/build.log.`);
  process.exitCode = 1;
} finally { log.end(); await finished(log); }
