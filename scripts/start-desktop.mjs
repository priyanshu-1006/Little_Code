import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { nativeExecutable, packagedExecutable, packagedRoot, sourceRoot } from './desktop-paths.mjs';

let executable = packagedExecutable;
let development = false;
try { await access(packagedExecutable); }
catch {
  try { await access(nativeExecutable); await access(path.join(sourceRoot, 'out', 'main.js')); }
  catch { console.error('The Little Code desktop build is missing. Run npm run desktop:build first.'); process.exit(1); }
  executable = nativeExecutable;
  development = true;
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if (development) { environment.VSCODE_DEV = '1'; environment.NODE_ENV = 'development'; }
else { delete environment.VSCODE_DEV; environment.NODE_ENV = 'production'; }

const child = spawn(executable, [...(development ? ['.'] : []), '--disable-extension=vscode.vscode-api-tests', ...process.argv.slice(2)], {
  cwd: development ? sourceRoot : packagedRoot,
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
  env: environment,
});
child.on('error', error => { console.error(`Little Code could not start: ${error.message}`); process.exitCode = 1; });
child.on('spawn', () => { console.log(`Opened Little Code: ${executable}`); child.unref(); });
