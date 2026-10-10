import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PROJECT_CREATORS, PROJECT_FRAMEWORKS, createProjectPlan, inspectProjectDestination, inspectProjectPythonEnvironment, prepareProjectDestination, recheckProjectDestination, validateProjectName, writeStarterFiles, type ProjectOptions } from '../src/development/projectTemplates';

async function fixture(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'little-project-wizard-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('little-project-wizard-'));
    await fs.rm(root, { force: true, recursive: true });
  });
  return root;
}

test('curated generators cover every supported template/language without execution or shell payloads', () => {
  let combinations = 0;
  for (const framework of PROJECT_FRAMEWORKS) {
    for (const template of framework.templates) {
      for (const language of template.languages) {
        const plan = createProjectPlan({ frameworkId: framework.id, templateId: template.id, language, name: ['python', 'flutter'].includes(framework.id) ? 'sample_app' : 'sample-app' });
        assert.equal(plan.framework, framework);
        assert.ok(plan.steps.length >= 1);
        assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.steps)); assert.ok(Object.isFrozen(plan.options));
        for (const step of plan.steps) {
          assert.ok(Object.isFrozen(step.args));
          assert.ok(step.args.every(argument => !/[\r\n;&|`$%"<>^!]/.test(argument)), `${framework.id}: ${step.args.join(' ')}`);
          assert.ok(!step.args.includes('-g') && !step.args.includes('--global'));
        }
        combinations++;
      }
    }
  }
  assert.ok(combinations >= 40, `Only ${combinations} combinations were covered.`);
  for (const creator of Object.values(PROJECT_CREATORS)) assert.match(creator, /@\d+\.\d+\.\d+$/);
});

test('unsafe names, uncurated templates, and forged options cannot become process arguments', () => {
  const base: ProjectOptions = { frameworkId: 'react', templateId: 'standard', language: 'typescript', name: 'safe-app' };
  for (const name of ['../outside', 'a/b', 'a\\b', '--force', '.', '..', 'a && calc', 'app;curl', '%PATH%', '$(curl)', '`curl`', 'a"b', 'a\nother', 'a b', 'CON', 'con', 'aux', 'lpt1', 'C:outside', 'a.'.repeat(30)]) {
    assert.ok(validateProjectName(name, 'react'), name);
    assert.throws(() => createProjectPlan({ ...base, name }), Error, name);
  }
  assert.throws(() => createProjectPlan({ ...base, templateId: '--template=evil' }));
  assert.throws(() => createProjectPlan({ ...base, frameworkId: 'unknown' as ProjectOptions['frameworkId'] }));
  assert.throws(() => createProjectPlan({ ...base, language: 'python' }));
  assert.throws(() => createProjectPlan({ ...base, flutterPlatforms: ['web'] }));
  assert.throws(() => createProjectPlan({ ...base, tailwind: true }));
  assert.throws(() => createProjectPlan({ frameworkId: 'flutter', templateId: 'app', language: 'dart', name: 'sample_app', flutterPlatforms: ['web', 'web'] }));
  assert.throws(() => createProjectPlan({ frameworkId: 'flutter', templateId: 'app', language: 'dart', name: 'sample_app', flutterPlatforms: ['web;evil'] }));
  for (const name of ['my-app', 'django', 'typing', 'class']) assert.ok(validateProjectName(name, 'python'), name);
  for (const name of ['my-app', 'flutter', 'dart', 'class']) assert.ok(validateProjectName(name, 'flutter'), name);
  assert.equal(validateProjectName('sample_app', 'python'), undefined);
  assert.equal(validateProjectName('sample-app', 'next'), undefined);
});

test('official generator arguments bind choices and separate scaffolding from dependency installation', () => {
  const plan = createProjectPlan({ frameworkId: 'react', templateId: 'compiler', language: 'typescript', name: 'sample-app' });
  assert.deepEqual(plan.steps[0]!.args.slice(-4), ['.', '--template', 'react-compiler-ts', '--no-interactive']);
  assert.equal(plan.steps[0]!.args[2], `--package=${PROJECT_CREATORS.vite}`);
  assert.deepEqual(plan.steps[1]!.args, ['install', '--prefix=.', '--workspaces=false', '--global=false', '--no-audit', '--no-fund']);
  const next = createProjectPlan({ frameworkId: 'next', templateId: 'pages', language: 'javascript', name: 'sample-app', tailwind: true });
  assert.ok(next.steps[0]!.args.includes('--no-app')); assert.ok(next.steps[0]!.args.includes('--javascript')); assert.ok(next.steps[0]!.args.includes('--tailwind')); assert.ok(next.steps[0]!.args.includes('--skip-install'));
  const expo = createProjectPlan({ frameworkId: 'react-native', templateId: 'blank', language: 'typescript', name: 'sample-app' });
  assert.equal(expo.steps[0]!.args.at(-1), 'blank-typescript'); assert.ok(expo.steps[0]!.args.includes('--no-install'));
  const django = createProjectPlan({ frameworkId: 'python', templateId: 'django', language: 'python', name: 'sample_app' });
  assert.deepEqual(django.steps.map(step => step.program), ['python', 'venv-python', 'venv-python']);
  assert.deepEqual(django.steps[0]!.args, ['-I', '-m', 'venv', '.venv']);
  assert.ok(django.steps[1]!.args.includes('--isolated')); assert.ok(django.steps[1]!.args.includes('--require-virtualenv'));
  assert.deepEqual(django.steps[2]!.args, ['-m', 'django', 'startproject', 'sample_app', '.']);
  const flutter = createProjectPlan({ frameworkId: 'flutter', templateId: 'empty', language: 'dart', name: 'sample_app', flutterPlatforms: ['web', 'android'] });
  assert.ok(flutter.steps[0]!.args.includes('--empty')); assert.ok(flutter.steps[0]!.args.includes('--no-pub')); assert.equal(flutter.steps[0]!.args.at(-1), 'web,android');
  assert.deepEqual(flutter.steps[1]!.args, ['pub', 'get']);
});

test('private Python environment preserves its launch path and invalidates replaced environment metadata', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.venv', 'Scripts'), { recursive: true });
  const executable = path.join(root, '.venv', 'Scripts', 'python.exe');
  await fs.writeFile(executable, 'fixture interpreter'); await fs.writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'home = fixture\n');
  const environment = await inspectProjectPythonEnvironment(root, 'win32');
  assert.equal(environment.executable, executable); await environment.recheck();
  await fs.writeFile(environment.configuration, 'home = changed fixture\n'); await assert.rejects(environment.recheck(), /virtual environment changed/);
});

test('private Python environment allows its normal interpreter symlink without launching the global resolved path', { skip: process.platform === 'win32' ? 'POSIX virtualenv uses a file symlink; Windows does not grant file-symlink creation to this test process.' : false }, async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.venv', 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, '.venv', 'pyvenv.cfg'), 'home = fixture\n');
  const executable = path.join(root, '.venv', 'bin', 'python');
  await fs.symlink(process.execPath, executable, 'file');
  const environment = await inspectProjectPythonEnvironment(root, 'linux');
  assert.equal(environment.executable, executable); assert.notEqual(environment.executable, await fs.realpath(executable));
  await environment.recheck();
  await fs.unlink(executable); await fs.writeFile(executable, 'replaced fixture interpreter'); await assert.rejects(environment.recheck(), /virtual environment changed/);
});

test('inspection and cancelled/rejected selection have no filesystem side effects; new folders reserve atomically', async t => {
  const root = await fixture(t);
  const destination = await inspectProjectDestination(root, root, 'sample-app');
  assert.deepEqual(await fs.readdir(root), []);
  await recheckProjectDestination(destination);
  assert.deepEqual(await fs.readdir(root), []);
  const identity = await prepareProjectDestination(destination);
  assert.deepEqual(await fs.readdir(destination.target), []);
  await recheckProjectDestination(destination, identity, true);
  await assert.rejects(prepareProjectDestination(destination), /now exists/);
  await assert.rejects(inspectProjectDestination(root, root, 'sample-app'), /already exists/);
});

test('existing folders and files, including hidden files, are preserved and never overwritten', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'sample-app')); await fs.writeFile(path.join(root, 'sample-app', 'important.txt'), 'keep');
  await assert.rejects(inspectProjectDestination(root, root, 'sample-app'), /already exists/);
  await assert.rejects(inspectProjectDestination(root, path.join(root, 'sample-app'), 'sample-app', 'empty'), /not empty/);
  assert.equal(await fs.readFile(path.join(root, 'sample-app', 'important.txt'), 'utf8'), 'keep');
  await fs.mkdir(path.join(root, 'empty')); await fs.writeFile(path.join(root, 'empty', '.hidden'), 'keep hidden');
  await assert.rejects(inspectProjectDestination(root, path.join(root, 'empty'), 'empty', 'empty'), /not empty/);
  await fs.writeFile(path.join(root, 'file-target'), 'keep file');
  await assert.rejects(inspectProjectDestination(root, root, 'file-target'), /already exists/);
});

test('empty selected folder is reused only while its original identity and emptiness remain valid', async t => {
  const root = await fixture(t); const target = path.join(root, 'empty'); await fs.mkdir(target);
  const destination = await inspectProjectDestination(root, target, 'empty', 'empty');
  await fs.writeFile(path.join(target, 'arrived.txt'), 'keep');
  await assert.rejects(prepareProjectDestination(destination), /no longer empty/);
  assert.equal(await fs.readFile(path.join(target, 'arrived.txt'), 'utf8'), 'keep');
  await fs.rm(path.join(target, 'arrived.txt'));
  const current = await inspectProjectDestination(root, target, 'empty', 'empty');
  const identity = await prepareProjectDestination(current);
  assert.equal(current.target, target); await recheckProjectDestination(current, identity, true);
});

test('outside parents, file parents, traversal names, symlinks and junctions fail before creation', async t => {
  const root = await fixture(t); const outside = await fs.mkdtemp(path.join(tmpdir(), 'little-project-wizard-outside-'));
  t.after(async () => { assert.equal(path.dirname(outside), tmpdir()); assert.ok(path.basename(outside).startsWith('little-project-wizard-outside-')); await fs.rm(outside, { recursive: true, force: true }); });
  await assert.rejects(inspectProjectDestination(root, outside, 'sample-app'), /inside the trusted/);
  await assert.rejects(inspectProjectDestination(root, root, '../outside'), /safe project name/);
  await fs.writeFile(path.join(root, 'file'), 'keep'); await assert.rejects(inspectProjectDestination(root, path.join(root, 'file'), 'sample-app'), /real local directories/);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectProjectDestination(root, path.join(root, 'linked'), 'sample-app'), /symbolic links or junctions/);
  await fs.mkdir(path.join(outside, 'nested'));
  await assert.rejects(inspectProjectDestination(root, path.join(root, 'linked', 'nested'), 'sample-app'), /symbolic links or junctions/);
  assert.deepEqual(await fs.readdir(outside), ['nested']);
});

test('replaced parents and destination races expire the reviewed selection', async t => {
  const root = await fixture(t); const parent = path.join(root, 'parent'); await fs.mkdir(parent);
  const staged = await inspectProjectDestination(root, parent, 'sample-app');
  await fs.rename(parent, path.join(root, 'previous-parent')); await fs.mkdir(parent);
  await assert.rejects(prepareProjectDestination(staged), /folder changed/);
  const fresh = await inspectProjectDestination(root, parent, 'sample-app');
  await fs.mkdir(fresh.target); await fs.writeFile(path.join(fresh.target, 'keep.txt'), 'keep');
  await assert.rejects(prepareProjectDestination(fresh), /now exists/);
  assert.equal(await fs.readFile(path.join(fresh.target, 'keep.txt'), 'utf8'), 'keep');
});

test('boilerplate uses exclusive writes and rejects arbitrary file paths', async t => {
  const root = await fixture(t); const destination = await inspectProjectDestination(root, root, 'sample_app'); const identity = await prepareProjectDestination(destination);
  const plan = createProjectPlan({ frameworkId: 'python', templateId: 'flask', language: 'python', name: 'sample_app' });
  await writeStarterFiles(destination, identity, plan.files);
  assert.match(await fs.readFile(path.join(destination.target, 'app.py'), 'utf8'), /Flask/);
  assert.equal(await fs.readFile(path.join(destination.target, 'requirements.txt'), 'utf8'), 'Flask\n');
  await assert.rejects(writeStarterFiles(destination, identity, [{ path: 'app.py', content: 'overwrite' }]), /EEXIST/);
  assert.match(await fs.readFile(path.join(destination.target, 'app.py'), 'utf8'), /Flask/);
  await assert.rejects(writeStarterFiles(destination, identity, [{ path: '../outside.py', content: 'bad' }]), /outside the curated/);
  await assert.rejects(fs.access(path.join(root, 'outside.py')));
  await fs.rename(destination.target, path.join(root, 'old-project')); await fs.mkdir(destination.target);
  await assert.rejects(writeStarterFiles(destination, identity, [{ path: 'main.py', content: 'bad' }]), /project folder changed/);
  assert.deepEqual(await fs.readdir(destination.target), []);
});
