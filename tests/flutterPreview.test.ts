import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { decodeFlutterMessages, discoverFlutterSdk, flutterCommand, FlutterMachineDecoder, FlutterProcessCleanup, flutterWebUrl, hasFlutterPubspec, parseFlutterDevices, validateFlutterEntrypoint, validateFlutterProject } from '../src/development/flutterProtocol';

const pubspec = 'name: sample_app\ndependencies:\n  flutter:\n    sdk: flutter\n';
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'little-flutter-test-'));
  t.after(async () => {
    const checked = path.resolve(root);
    assert.equal(path.dirname(checked), path.resolve(tmpdir()));
    assert(path.basename(checked).startsWith('little-flutter-test-'));
    await fs.rm(checked, { recursive: true, force: true });
  });
  return root;
}

test('Flutter device discovery accepts actual pretty JSON, omits unsupported targets, duplicates and switch injection', () => {
  const devices = parseFlutterDevices('SDK ready\n' + JSON.stringify([
    { id: 'emulator-5554', name: 'Pixel 8', targetPlatform: 'android-x64', emulator: true, emulatorId: 'Pixel_8_API_35', isSupported: true },
    { id: 'chrome', name: 'Chrome', targetPlatform: 'web-javascript', emulator: false },
    { id: 'chrome', name: 'Duplicate' },
    { id: 'unsupported', name: 'Unsupported', isSupported: false },
    { id: '--help', name: 'Switch' },
    { id: 'id;evil', name: 'Shell composition' },
  ], null, 2));
  assert.deepEqual(devices.map(device => device.id), ['emulator-5554', 'chrome']);
  assert.equal(devices[0]!.emulatorId, 'Pixel_8_API_35');
  assert.equal(devices[0]!.platform, 'android-x64');
});

test('Missing or over-budget discovery is an error rather than a fabricated device list', () => {
  assert.throws(() => parseFlutterDevices('No authorized devices found.'), /machine-readable/);
  assert.throws(() => parseFlutterDevices('x'.repeat(256 * 1024 + 1)), /limit/);
  assert.throws(() => parseFlutterDevices(JSON.stringify(Array.from({ length: 101 }, (_, id) => ({ id: String(id), name: 'Device' })))), /Invalid/);
  assert.deepEqual(parseFlutterDevices('[]'), []);
});

test('Flutter machine decoder preserves split UTF-8, partial frames, ordinary logs and CRLF', () => {
  const decoder = new FlutterMachineDecoder();
  const payload = Buffer.from('Building…\r\n[{"event":"app.log","params":{"appId":"app-1","log":"日本"}}]\n[{"id":2,"result":{"code":0}}]\n');
  const split = payload.indexOf(Buffer.from('日本')) + 1;
  const observations = [...decoder.push(payload.subarray(0, split)), ...decoder.push(payload.subarray(split, payload.length - 2))];
  assert.equal(observations[0]!.line, 'Building…');
  assert.equal(observations[0]!.messages, null);
  assert.equal(observations[1]!.messages?.[0]?.params?.log, '日本');
  assert.equal(observations.length, 2, 'An incomplete response must stay buffered.');
  const final = decoder.push(payload.subarray(payload.length - 2));
  assert.equal(final[0]!.messages?.[0]?.id, 2);
});

test('Malformed machine output cannot authorize a message and oversized unfinished lines fail boundedly', () => {
  assert.equal(decodeFlutterMessages('[not json]'), null);
  assert.equal(decodeFlutterMessages('[{"event":"app.start","params":[]} ]'), null);
  assert.equal(decodeFlutterMessages('[{"event":"<script>"}]'), null);
  assert.equal(decodeFlutterMessages('{"event":"app.started"}'), null);
  assert.throws(() => new FlutterMachineDecoder().push('x'.repeat(64 * 1024 + 1)), /limit/);
  assert.throws(() => decodeFlutterMessages('x'.repeat(64 * 1024 + 1)), /limit/);
});

test('Readiness accepts real webLaunchUrl events without guessing a localhost URL from log text', () => {
  const messages = decodeFlutterMessages('[{"event":"app.webLaunchUrl","params":{"url":"http://127.0.0.1:54321/","launched":false}}]');
  assert.equal(messages?.[0]?.event, 'app.webLaunchUrl');
  assert.equal(flutterWebUrl(messages?.[0]?.params?.url), 'http://127.0.0.1:54321/');
  assert.equal(decodeFlutterMessages('App is available at http://127.0.0.1:54321'), null);
});

test('Web preview rejects public hosts, deceptive loopback names, credentials, non-HTTP schemes and invalid ports', () => {
  for (const url of ['https://127.0.0.1:8000', 'http://example.com:8000', 'http://127.0.0.1.example.com:8000', 'http://127.0.0.1@evil.example:8000', 'http://user:secret@localhost:8000', 'file:///local.html', 'javascript:alert(1)', 'http://localhost:0', 'http://localhost', 'http://localhost:8000/#script']) assert.equal(flutterWebUrl(url), undefined, url);
  assert.equal(flutterWebUrl('http://localhost:8010/'), 'http://localhost:8010/');
  assert.equal(flutterWebUrl('http://[::1]:8010/'), 'http://[::1]:8010/');
});

test('Hot reload, hot restart and stop serialize the actual Flutter protocol with required app identity', () => {
  const reload = JSON.parse(flutterCommand(3, 'app.restart', { appId: 'app-1', fullRestart: false, reason: 'manual' }));
  const restart = JSON.parse(flutterCommand(4, 'app.restart', { appId: 'app-1', fullRestart: true }));
  assert.equal(reload[0].params.fullRestart, false);
  assert.equal(restart[0].params.fullRestart, true);
  assert.equal(JSON.parse(flutterCommand(5, 'app.stop', { appId: 'app-1' }))[0].method, 'app.stop');
  assert.throws(() => flutterCommand(6, 'app.stop'), /not ready/);
  assert.throws(() => flutterCommand(7, 'emulator.launch', { emulatorId: '--create' }), /identity/);
  assert.throws(() => flutterCommand(0, 'emulator.getEmulators'), /identity/);
});

test('Flutter project detection distinguishes SDK dependencies from an ordinary Dart dependency or comments', () => {
  assert(hasFlutterPubspec(pubspec));
  assert(hasFlutterPubspec('dependencies:\n  flutter: # supplied SDK\n    sdk: flutter\n'));
  assert(hasFlutterPubspec('dependencies:\n  flutter: { sdk: flutter }\n'));
  assert(!hasFlutterPubspec('dependencies:\n  flutter: ^1.0.0\n'));
  assert(!hasFlutterPubspec('# dependencies:\n#  flutter:\n#    sdk: flutter\n'));
  assert(!hasFlutterPubspec('x'.repeat(256 * 1024 + 1)));
});

test('Project validation permits a nested real Flutter app and rejects outside-workspace or ordinary Dart packages', async t => {
  const temporary = await fixture(t);
  const workspace = path.join(temporary, 'workspace');
  const app = path.join(workspace, 'apps', 'sample_app');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'pubspec.yaml'), pubspec);
  assert.equal(await validateFlutterProject(workspace, app), await fs.realpath(app));
  await assert.rejects(validateFlutterProject(workspace, temporary), /inside/);
  await fs.writeFile(path.join(app, 'pubspec.yaml'), 'name: ordinary_dart\ndependencies:\n  http: ^1.0.0\n');
  await assert.rejects(validateFlutterProject(workspace, app), /Flutter SDK dependency/);
});

test('Project validation never follows a linked folder outside the workspace', async t => {
  const temporary = await fixture(t);
  const workspace = path.join(temporary, 'workspace');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(workspace); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'pubspec.yaml'), pubspec);
  const linked = path.join(workspace, 'linked');
  try { await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('This Windows sandbox cannot create junction fixtures.'); return; }
    throw error;
  }
  await assert.rejects(validateFlutterProject(workspace, linked), /Linked/);
});

test('SDK discovery uses warmed Dart and snapshot argv, including paths containing spaces, without invoking anything', async t => {
  const temporary = await fixture(t);
  const sdk = path.join(temporary, 'Flutter SDK with spaces');
  const dart = path.join(sdk, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
  const snapshot = path.join(sdk, 'bin', 'cache', 'flutter_tools.snapshot');
  const packages = path.join(sdk, 'packages', 'flutter_tools', '.dart_tool', 'package_config.json');
  await fs.mkdir(path.dirname(dart), { recursive: true });
  await fs.mkdir(path.dirname(packages), { recursive: true });
  await fs.writeFile(dart, 'non-executable fixture'); await fs.writeFile(snapshot, 'snapshot fixture');
  await fs.writeFile(packages, '{"configVersion":2,"packages":[]}');
  const discovered = await discoverFlutterSdk({ configuredPath: sdk, env: {}, platform: 'win32' });
  assert.equal(discovered.executable, dart);
  assert.deepEqual(discovered.prefixArgs, [`--packages=${packages}`, snapshot]);
  assert(Object.isFrozen(discovered) && Object.isFrozen(discovered.prefixArgs));
  assert(!discovered.executable.endsWith('.bat'));
});

test('A preview entry point must be a regular main.dart app source, not a package or linked library', async t => {
  const temporary = await fixture(t);
  const app = path.join(temporary, 'app');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(app); await fs.mkdir(outside);
  await assert.rejects(validateFlutterEntrypoint(app), /lib\/main.dart/);
  await fs.mkdir(path.join(app, 'lib'));
  await fs.writeFile(path.join(app, 'lib', 'main.dart'), 'void main() {}');
  await validateFlutterEntrypoint(app);
  await fs.rename(path.join(app, 'lib'), path.join(app, 'old-lib'));
  await fs.writeFile(path.join(outside, 'main.dart'), 'void main() {}');
  try { await fs.symlink(outside, path.join(app, 'lib'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('This Windows sandbox cannot create junction fixtures.'); return; }
    throw error;
  }
  await assert.rejects(validateFlutterEntrypoint(app), /regular lib\/main.dart/);
});

test('An explicit uninitialized SDK produces setup guidance instead of falling back or initializing a different SDK', async t => {
  const temporary = await fixture(t);
  const sdk = path.join(temporary, 'uninitialized');
  await fs.mkdir(sdk);
  await assert.rejects(discoverFlutterSdk({ configuredPath: sdk, env: {}, platform: 'win32' }), /run flutter doctor yourself.*does not install/s);
});

test('A snapshot without the installed Flutter tool package configuration is not a warmed SDK', async t => {
  const temporary = await fixture(t);
  const dart = path.join(temporary, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
  await fs.mkdir(path.dirname(dart), { recursive: true });
  await fs.writeFile(dart, 'non-executable fixture');
  await fs.writeFile(path.join(temporary, 'bin', 'cache', 'flutter_tools.snapshot'), 'snapshot fixture');
  await assert.rejects(discoverFlutterSdk({ configuredPath: temporary, env: {}, platform: 'win32' }), /uninitialized/);
  await assert.rejects(fs.stat(path.join(temporary, 'packages')), { code: 'ENOENT' });
});

test('A successful Windows tree-kill request without an observed close is not a successful Flutter stop', async () => {
  let attempts = 0;
  const cleanup = new FlutterProcessCleanup({ platform: 'win32', isClosed: () => false, closed: new Promise(() => {}), terminate: async () => { attempts++; }, closeMs: 1 });
  await assert.rejects(cleanup.stop(), /stop could not be confirmed.*retained.*retry Stop/i);
  assert.equal(attempts, 1);
});

test('Windows taskkill failure retains its cause and can be retried until actual closure is observed', async () => {
  let hasClosed = false, attempts = 0;
  let confirmClose!: () => void;
  const closed = new Promise<void>(resolve => { confirmClose = resolve; });
  const denied = new Error('Access denied by fixture tree termination.');
  const cleanup = new FlutterProcessCleanup({ platform: 'win32', isClosed: () => hasClosed, closed, closeMs: 1, terminate: async () => {
    if (++attempts === 1) throw denied;
    hasClosed = true; confirmClose();
  } });
  await assert.rejects(cleanup.stop(), error => error instanceof Error && error.cause === denied && /retained/.test(error.message));
  assert.equal(hasClosed, false);
  await cleanup.stop();
  assert.equal(attempts, 2, 'A failed promise must not permanently suppress a second stop attempt.');
  assert.equal(hasClosed, true);
});

test('POSIX Flutter cleanup escalates TERM to KILL and succeeds only after the owned close event', async () => {
  const signals: (string | undefined)[] = [];
  let hasClosed = false;
  let confirmClose!: () => void;
  const closed = new Promise<void>(resolve => { confirmClose = resolve; });
  const cleanup = new FlutterProcessCleanup({ platform: 'linux', isClosed: () => hasClosed, closed, graceMs: 1, closeMs: 1, terminate: async signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') { hasClosed = true; confirmClose(); }
  } });
  await cleanup.stop();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(hasClosed, true);
});

test('POSIX signal failures and missing closure remain a failure rather than clearing an active preview', async () => {
  const signals: (string | undefined)[] = [];
  const failure = new Error('Fixture process group permission failure.');
  const cleanup = new FlutterProcessCleanup({ platform: 'linux', isClosed: () => false, closed: new Promise(() => {}), graceMs: 1, closeMs: 1, terminate: async signal => { signals.push(signal); throw failure; } });
  await assert.rejects(cleanup.stop(), error => error instanceof Error && error.cause === failure);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('Concurrent Flutter stop calls share an attempt and an already closed target is never signalled', async () => {
  let hasClosed = false, attempts = 0;
  let confirmClose!: () => void, releaseKill!: () => void;
  const closed = new Promise<void>(resolve => { confirmClose = resolve; });
  const kill = new Promise<void>(resolve => { releaseKill = resolve; });
  const cleanup = new FlutterProcessCleanup({ platform: 'win32', isClosed: () => hasClosed, closed, closeMs: 10, terminate: async () => { attempts++; await kill; } });
  const first = cleanup.stop(), second = cleanup.stop();
  assert.equal(first, second);
  assert.equal(attempts, 1);
  hasClosed = true; confirmClose(); releaseKill();
  await first;
  await cleanup.stop();
  assert.equal(attempts, 1, 'Confirmed closed children must not receive another process-tree signal.');
});
