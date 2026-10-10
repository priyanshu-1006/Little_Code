import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { GitService, GIT_REVIEW_LIMITS } from '../src/little/git/git-service';
import { LittleError } from '../src/little/shared/errors';
import { WorkspaceService } from '../src/little/tools/workspace-service';

const execFile = promisify(childProcess.execFile);
async function git(root: string, args: string[]) {
  return execFile('git', ['-c', 'user.name=Little Test', '-c', 'user.email=little-test@example.invalid', ...args], { cwd: root, windowsHide: true, timeout: 10_000 });
}
async function fixture(t: TestContext, files: Record<string, string> = { 'src/auth.ts': 'export const authentication = true;\n' }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'little-code-git-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), parent);
    assert.ok(relative.startsWith('little-code-git-') && !relative.includes(path.sep));
    await fs.rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, 'workspace');
  await fs.mkdir(root);
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--allow-empty', '-m', 'Temporary fixture baseline']);
  const workspace = new WorkspaceService(root);
  return { parent, root, workspace, service: new GitService(workspace) };
}
function code(expected: LittleError['code']) { return (error: unknown) => error instanceof LittleError && error.code === expected; }

test('status exposes permitted tracked, staged, and untracked changes without modifying the index', async (t) => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, 'src/auth.ts'), 'export const authentication = false;\n');
  await fs.writeFile(path.join(root, 'src/staged.ts'), 'export const staged = true;\n');
  await fs.writeFile(path.join(root, 'untracked.ts'), 'export const untracked = true;\n');
  await git(root, ['add', '--', 'src/staged.ts']);
  const index = await fs.readFile(path.join(root, '.git', 'index'));
  const status = await service.status(new AbortController().signal);
  assert.equal(status.available, true);
  assert.equal(status.branch, 'main');
  assert.ok(status.changes.some(change => change.path === 'src/auth.ts' && change.worktree === 'M'));
  assert.ok(status.changes.some(change => change.path === 'src/staged.ts' && change.index === 'A'));
  assert.ok(status.changes.some(change => change.path === 'untracked.ts' && change.index === '?' && change.worktree === '?'));
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), index);
});

test('unstaged, staged, and untracked diffs are bounded source patches', async (t) => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, 'src/auth.ts'), 'export const authentication = false;\n');
  const unstaged = await service.diff('src/auth.ts', false, new AbortController().signal);
  assert.ok(unstaged.text.includes('-export const authentication = true;'));
  assert.ok(unstaged.text.includes('+export const authentication = false;'));
  await git(root, ['add', '--', 'src/auth.ts']);
  const staged = await service.diff('src/auth.ts', true, new AbortController().signal);
  assert.ok(staged.text.includes('+export const authentication = false;'));
  await fs.writeFile(path.join(root, 'new.ts'), 'export const newFile = true;\n');
  const untracked = await service.diff('new.ts', false, new AbortController().signal);
  assert.ok(untracked.text.includes('+export const newFile = true;'));
  assert.equal(untracked.path, 'new.ts');
});

test('staged renames expose the permitted target and omit missing rename-source metadata', async (t) => {
  const { root, service } = await fixture(t);
  await git(root, ['mv', '--', 'src/auth.ts', 'src/authentication.ts']);
  const status = await service.status(new AbortController().signal);
  const rename = status.changes.find(change => change.path === 'src/authentication.ts');
  assert.ok(rename);
  assert.equal(rename.index, 'R');
  assert.equal(rename.originalPath, undefined);
  const diff = await service.diff('src/authentication.ts', true, new AbortController().signal);
  assert.ok(diff.text.includes('export const authentication = true;'));
});

test('workspace policy filters tracked secrets, ignored files, generated outputs, and deletions', async (t) => {
  const { root, service } = await fixture(t, {
    'safe.ts': 'safe content\n', '.env': 'PASSWORD=private-value\n',
    '.littleignore': 'private.ts\n', 'private.ts': 'private-value\n',
    'dist/generated.ts': 'private-value\n', 'deleted.ts': 'deleted content\n',
  });
  for (const name of ['safe.ts', '.env', 'private.ts', 'dist/generated.ts']) await fs.appendFile(path.join(root, name), 'modified\n');
  await fs.unlink(path.join(root, 'deleted.ts'));
  const status = await service.status(new AbortController().signal);
  assert.deepEqual(status.changes.map(change => change.path), ['safe.ts']);
  for (const name of ['.env', 'private.ts', 'dist/generated.ts']) await assert.rejects(service.diff(name, false, new AbortController().signal), code('PERMISSION_DENIED'));
});

test('diff redacts likely secrets and private-key blocks before returning content', async (t) => {
  const { root, service } = await fixture(t);
  const key = `gsk_${'a'.repeat(40)}`;
  await fs.writeFile(path.join(root, 'src/auth.ts'), `const apiKey = "${key}";\nconst password = "private-value";\nconst keyBlock = \`-----BEGIN PRIVATE KEY-----\nPRIVATEKEYBODY\n-----END PRIVATE KEY-----\`;\n`);
  const diff = await service.diff('src/auth.ts', false, new AbortController().signal);
  for (const secret of [key, 'private-value', 'PRIVATEKEYBODY']) assert.ok(!diff.text.includes(secret));
  assert.ok(diff.text.includes('[REDACTED'));
});

test('Git review requires an exact worktree root rather than a parent repository or bare folder', async (t) => {
  const { root, parent } = await fixture(t);
  const nested = new GitService(new WorkspaceService(path.join(root, 'src')));
  assert.equal((await nested.status(new AbortController().signal)).available, false);
  await assert.rejects(nested.diff('auth.ts', false, new AbortController().signal), code('PERMISSION_DENIED'));
  const plain = path.join(parent, 'plain');
  await fs.mkdir(plain);
  assert.equal((await new GitService(new WorkspaceService(plain)).status(new AbortController().signal)).available, false);
});

test('literal filenames cannot become Git options or pathspec expressions', async (t) => {
  const { root, service } = await fixture(t, { '--output=owned.ts': 'original\n', '[auth].ts': 'original\n', 'safe.ts': 'original\n' });
  await fs.writeFile(path.join(root, '--output=owned.ts'), 'modified\n');
  await fs.writeFile(path.join(root, '[auth].ts'), 'modified\n');
  assert.ok((await service.diff('--output=owned.ts', false, new AbortController().signal)).text.includes('+modified'));
  assert.ok((await service.diff('[auth].ts', false, new AbortController().signal)).text.includes('+modified'));
  assert.equal(await fs.readFile(path.join(root, 'safe.ts'), 'utf8'), 'original\n');
  await assert.rejects(service.diff('../outside.ts', false, new AbortController().signal), code('WORKSPACE_BOUNDARY_VIOLATION'));
});

test('configured external diff, textconv, clean/process filters, fsmonitor, and pager commands do not execute', async (t) => {
  const { parent, root, service } = await fixture(t, { 'src/auth.ts': 'original content\n', '.gitattributes': '*.ts filter=evil diff=evil\n' });
  const marker = path.join(parent, 'external-command-ran');
  const script = path.join(parent, 'external-command.cjs');
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.resume(); process.stdin.on('data', chunk => process.stdout.write(chunk));`);
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
  for (const key of ['diff.external', 'diff.evil.command', 'diff.evil.textconv', 'filter.evil.clean', 'filter.evil.process', 'core.fsmonitor', 'core.pager']) await git(root, ['config', key, command]);
  await git(root, ['config', 'filter.evil.required', 'true']);
  await fs.writeFile(path.join(root, 'src/auth.ts'), 'modified content\n');
  const status = await service.status(new AbortController().signal);
  assert.ok(status.changes.some(change => change.path === 'src/auth.ts'));
  assert.ok((await service.diff('src/auth.ts', false, new AbortController().signal)).text.includes('+modified content'));
  await assert.rejects(fs.stat(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('inherited Git redirects, external programs, preload variables, and secrets are excluded from children', async (t) => {
  const { root, service } = await fixture(t);
  await fs.writeFile(path.join(root, 'src/auth.ts'), 'modified content\n');
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXTERNAL_DIFF', 'GIT_EXEC_PATH', 'GIT_PAGER', 'LD_PRELOAD', 'NODE_OPTIONS', 'GROQ_API_KEY'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'hostile-inherited-value';
  t.after(() => { for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } });
  const spawn = childProcess.spawn.bind(childProcess);
  const environments: NodeJS.ProcessEnv[] = [];
  t.mock.method(childProcess, 'spawn', (program: string, args: string[], options: childProcess.SpawnOptions) => {
    environments.push(options.env!);
    assert.equal(options.shell, false);
    assert.ok(path.isAbsolute(program));
    return spawn(program, args, options);
  });
  assert.equal((await service.status(new AbortController().signal)).available, true);
  assert.ok(environments.length >= 3);
  for (const environment of environments) for (const name of names) assert.equal(environment[name], undefined, name);
});

test('regular-file inventory excludes hard links from status and diff', async (t) => {
  const { root, parent, service } = await fixture(t);
  await fs.link(path.join(root, 'src/auth.ts'), path.join(parent, 'linked-auth.ts'));
  await fs.appendFile(path.join(root, 'src/auth.ts'), 'modified\n');
  assert.ok(!(await service.status(new AbortController().signal)).changes.some(change => change.path === 'src/auth.ts'));
  await assert.rejects(service.diff('src/auth.ts', false, new AbortController().signal), code('PERMISSION_DENIED'));
});

test('status entry and raw/output diff budgets stop large Git responses', async (t) => {
  const { root, service } = await fixture(t);
  await Promise.all(Array.from({ length: GIT_REVIEW_LIMITS.changes + 10 }, async (_, index) => fs.writeFile(path.join(root, `file-${index}.ts`), 'untracked\n')));
  const status = await service.status(new AbortController().signal);
  assert.equal(status.changes.length, GIT_REVIEW_LIMITS.changes);
  assert.equal(status.truncated, true);
  await fs.writeFile(path.join(root, 'src/auth.ts'), `export const large = '${'x'.repeat(GIT_REVIEW_LIMITS.capturedBytes * 2)}';\n`);
  const diff = await service.diff('src/auth.ts', false, new AbortController().signal);
  assert.ok(diff.text.length <= GIT_REVIEW_LIMITS.diffChars);
  assert.equal(diff.truncated, true);
});

test('pre-aborted Git review rejects before process creation', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.status(AbortSignal.abort()), code('AGENT_CANCELLED'));
  await assert.rejects(service.diff('src/auth.ts', false, AbortSignal.abort()), code('AGENT_CANCELLED'));
});

test('cancellation terminates the owned process tree and propagates a structured cancellation', async (t) => {
  const { service } = await fixture(t);
  const controller = new AbortController();
  const spawn = childProcess.spawn.bind(childProcess);
  let descendant: number | undefined;
  let owned: childProcess.ChildProcess | undefined;
  t.mock.method(childProcess, 'spawn', (_program: string, _args: string[], options: childProcess.SpawnOptions) => {
    owned = spawn(process.execPath, ['-e', "const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(child.pid);setInterval(()=>{},1000);"], options);
    owned.stdout?.once('data', chunk => { descendant = Number(String(chunk).trim()); controller.abort(); });
    return owned;
  });
  const fallback = setTimeout(() => controller.abort(), 2_000);
  t.after(() => { clearTimeout(fallback); owned?.kill('SIGKILL'); });
  await assert.rejects(service.status(controller.signal), code('AGENT_CANCELLED'));
  assert.ok(owned);
  assert.ok(owned.exitCode !== null || owned.signalCode !== null);
  assert.ok(descendant && Number.isSafeInteger(descendant));
  assert.throws(() => process.kill(descendant!, 0));
});
