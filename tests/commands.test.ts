import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectCommandService, validateCommand, type CommandGrant } from '../src/little/tools/command-service';
import { createCommandTools } from '../src/little/tools/command-tools';
import { WorkspaceService } from '../src/little/tools/workspace-service';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'little-command-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('little-command-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const service = new ProjectCommandService(new WorkspaceService(root));
  const controller = new AbortController();
  const command = (args: string[], timeoutMs = 3000) => ({ program: 'node', args, cwd: '.', purpose: 'Verify the temporary fixture', timeoutMs });
  return { root, service, controller, command };
}

test('structured command validation rejects shell injection, out-of-project arguments, eval, and sensitive actions', () => {
  for (const args of [['test', '&&', 'evil'], ['test;evil'], ['test', '%SECRET%'], ['test', '$(evil)'], ['test', '^evil'], ['test', '!evil!'], ['test', '..\\outside'], ['test', 'C:\\outside'], ['test', '/outside'], ['test', '--prefix=../outside'], ['test', '--prefix=/outside'], ['test', '--prefix=C:outside'], ['install', 'package'], ['run', 'deploy'], ['run', 'publish']]) {
    assert.throws(() => validateCommand({ program: 'npm', args, cwd: '.', purpose: 'check' }), Error, JSON.stringify(args));
  }
  assert.throws(() => validateCommand({ program: 'node', args: ['-e', 'bad'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'node', args: ['-eprocess.exitCode=1'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'node', args: ['--inspect'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'python', args: ['-c', 'bad'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'git', args: ['push'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'npm', args: ['test', '--api-key=private-value'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'npm', args: ['test', '--api-key', 'private-value'], purpose: 'check' }));
  assert.throws(() => validateCommand({ program: 'npm', args: ['test', 'gsk_CredentialValue123456789'], purpose: 'check' }));
  assert.equal(validateCommand({ program: 'npm', args: ['test'], purpose: 'Do not repeat gsk_CredentialValue123456789' }).purpose.includes('gsk_'), false);
  assert.throws(() => validateCommand({ program: 'npm', args: ['test'], cwd: '../outside', purpose: 'check' }));
  assert.deepEqual(validateCommand({ program: 'npm', args: ['run', 'typecheck'], purpose: 'check' }).args, ['run', 'typecheck']);
});

test('forged, copied, replayed, and cross-proposal grants cannot launch a process', async t => {
  const { root, service, controller, command } = await fixture(t);
  await fs.writeFile(path.join(root, 'check.cjs'), "require('fs').writeFileSync('launched.txt', 'yes');");
  const proposal = await service.stage(command(['check.cjs']), controller.signal);
  const other = await service.stage(command(['check.cjs']), controller.signal);
  await assert.rejects(service.execute(proposal, { approval: 'allow-once' } as CommandGrant, controller.signal), /host-owned/);
  const grant = service.approve(proposal);
  await assert.rejects(service.execute(other, grant, controller.signal), /host-owned/);
  await assert.rejects(service.execute(proposal, JSON.parse(JSON.stringify(grant)) as CommandGrant, controller.signal), /host-owned/);
  const result = await service.execute(proposal, grant, controller.signal);
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(path.join(root, 'launched.txt'), 'utf8'), 'yes');
  await assert.rejects(service.execute(proposal, grant, controller.signal), /host-owned/);
});

test('tool waits for explicit host approval and rejection produces no process side effects', async t => {
  const { root, service, controller, command } = await fixture(t);
  await fs.writeFile(path.join(root, 'check.cjs'), "require('fs').writeFileSync('launched.txt', 'yes');");
  let resolveReview: ((value: { status: 'rejected'; exitCode: null; output: string; truncated: boolean; durationMs: number }) => void) | undefined;
  const tool = createCommandTools(service, async () => new Promise(resolve => { resolveReview = resolve; }))[0]!;
  const running = tool.execute(command(['check.cjs']), { signal: controller.signal, runId: 'test-run' });
  for (let retry = 0; !resolveReview && retry < 30; retry++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(resolveReview);
  await assert.rejects(fs.access(path.join(root, 'launched.txt')));
  resolveReview({ status: 'rejected', exitCode: null, output: '', truncated: false, durationMs: 0 });
  assert.equal((await running as { status: string }).status, 'rejected');
  await assert.rejects(fs.access(path.join(root, 'launched.txt')));
});

test('real command captures both streams, nonzero exit, cwd, and redacts credentials before exposure', async t => {
  const { root, service, controller, command } = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'check.cjs'), "console.log('CWD=' + require('path').basename(process.cwd())); console.log('gsk_SecretCredential123456789'); console.error('expected failure'); process.exitCode = 7;");
  const proposal = await service.stage({ ...command(['check.cjs']), cwd: 'src' }, controller.signal);
  const result = await service.execute(proposal, service.approve(proposal), controller.signal);
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 7);
  assert.match(result.output, /CWD=src/); assert.match(result.output, /expected failure/); assert.match(result.output, /REDACTED/);
  assert.doesNotMatch(result.output, /gsk_SecretCredential/);
});

test('Windows npm shim safely runs an actual temporary package script', async t => {
  const { root, service, controller } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node check.cjs' } }));
  await fs.writeFile(path.join(root, 'check.cjs'), "console.log('NPM_PROJECT_CHECK_OK');");
  const proposal = await service.stage({ program: 'npm', args: ['test'], cwd: '.', purpose: 'Run temporary package tests', timeoutMs: 10000 }, controller.signal);
  const result = await service.execute(proposal, service.approve(proposal), controller.signal);
  assert.equal(result.status, 'exited', result.output); assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /NPM_PROJECT_CHECK_OK/);
});

test('timeout, cancellation, and excessive output terminate the owned process tree', async t => {
  const { root, service, command } = await fixture(t);
  await fs.writeFile(path.join(root, 'wait.cjs'), "const fs=require('fs'); console.log('WAITING'); setTimeout(()=>fs.writeFileSync('late.txt','bad'), 4000); setInterval(()=>{},1000);");
  const timedSignal = new AbortController();
  const timed = await service.stage(command(['wait.cjs'], 1000), timedSignal.signal);
  assert.equal((await service.execute(timed, service.approve(timed), timedSignal.signal)).status, 'timed_out');
  const cancelSignal = new AbortController();
  const cancelled = await service.stage(command(['wait.cjs']), cancelSignal.signal);
  const cancelledRun = service.execute(cancelled, service.approve(cancelled), cancelSignal.signal);
  const timer = setTimeout(() => cancelSignal.abort(), 500);
  const result = await cancelledRun; clearTimeout(timer);
  assert.equal(result.status, 'cancelled');
  await fs.writeFile(path.join(root, 'flood.cjs'), "process.stdout.write('x'.repeat(200000)); setInterval(()=>{},1000);");
  const floodSignal = new AbortController();
  const flood = await service.stage(command(['flood.cjs']), floodSignal.signal);
  const flooded = await service.execute(flood, service.approve(flood), floodSignal.signal);
  assert.equal(flooded.status, 'output_limit'); assert.equal(flooded.truncated, true); assert.ok(flooded.output.length <= 16000);
  await new Promise(resolve => setTimeout(resolve, 2700));
  await assert.rejects(fs.access(path.join(root, 'late.txt')));
});

test('command cwd respects ignore rules and symlinks leaving the project', async t => {
  const { root, service, controller, command } = await fixture(t);
  await fs.mkdir(path.join(root, 'ignored'));
  await fs.writeFile(path.join(root, '.littleignore'), 'ignored/\n');
  await assert.rejects(service.stage({ ...command(['check.cjs']), cwd: 'ignored' }, controller.signal), /ignore/);
  await fs.symlink(tmpdir(), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.stage({ ...command(['check.cjs']), cwd: 'outside' }, controller.signal), /outside/);
});

test('cancelled proposals and replaced command folders invalidate prior approvals', async t => {
  const { root, service, controller, command } = await fixture(t);
  const cancelled = await service.stage(command(['check.cjs']), controller.signal);
  const grant = service.approve(cancelled);
  controller.abort();
  assert.throws(() => service.approve(cancelled), /expired/);
  await assert.rejects(service.execute(cancelled, grant, new AbortController().signal), /host-owned/);
  await fs.mkdir(path.join(root, 'src'));
  const signal = new AbortController().signal;
  const staged = await service.stage({ ...command(['check.cjs']), cwd: 'src' }, signal);
  const stagedGrant = service.approve(staged);
  await fs.rename(path.join(root, 'src'), path.join(root, 'old-src'));
  await fs.mkdir(path.join(root, 'src'));
  await assert.rejects(service.execute(staged, stagedGrant, signal), /folder changed/);
});

test('cancelling a real parent and descendant prevents the child delayed file write', async t => {
  const { root, service, controller, command } = await fixture(t);
  await fs.writeFile(path.join(root, 'descendant.cjs'), "require('fs').writeFileSync('descendant-started.txt','yes'); setTimeout(()=>require('fs').writeFileSync('descendant-late.txt','bad'), 2200); setInterval(()=>{},1000);");
  await fs.writeFile(path.join(root, 'parent.cjs'), "require('child_process').spawn(process.execPath,['descendant.cjs'],{stdio:'ignore',windowsHide:true}); setInterval(()=>{},1000);");
  const proposal = await service.stage(command(['parent.cjs'], 5000), controller.signal);
  const running = service.execute(proposal, service.approve(proposal), controller.signal);
  let started = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await fs.access(path.join(root, 'descendant-started.txt')); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(started, true, 'The descendant must actually start before cancellation.');
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled', result.output);
  await new Promise(resolve => setTimeout(resolve, 2400));
  await assert.rejects(fs.access(path.join(root, 'descendant-late.txt')));
});
