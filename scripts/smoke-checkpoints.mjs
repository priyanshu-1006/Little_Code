import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { packagedExecutable, packagedRoot, projectRoot } from './desktop-paths.mjs';
import { startApp, stopApp, readAgent, click, waitFor, evaluate, screenshot, profileRoot, fixtureRoot, evidenceRoot, ownedProcess } from './smoke-features.mjs';

const reportPath = path.join(projectRoot, 'desktop', 'logs', 'native-checkpoint-recovery-smoke.json');
const progressPath = path.join(profileRoot, 'checkpoint-progress.json');
const original = Buffer.from('\uFEFFexport const checkpoint = "before";\r\n// exact native bytes\r\n');
const dirtyOriginal = Buffer.from('export const nativeDirty = "before";\r\n');
const deadlineMs = 360_000;

async function key(app, keyName, code, keyCode, modifiers = 0) {
  await ownedProcess(app.child.pid, app.expected);
  for (const type of ['keyDown', 'keyUp']) await app.client.send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }, app.renderer.sessionId);
}
async function readProgress() { try { return JSON.parse(await readFile(progressPath, 'utf8')); } catch { return undefined; } }
async function phase(expected, deadline) {
  return waitFor(async () => {
    const progress = await readProgress();
    if (progress?.phase === 'failed') throw new Error(progress.error);
    return progress?.phase === expected ? progress : undefined;
  }, `Native checkpoint fixture ${expected}`, deadline, 30_000);
}
async function command(app, title, expected, deadline) {
  await key(app, 'p', 'KeyP', 80, 10);
  await waitFor(() => evaluate(app.client, `(() => {const input=document.querySelector('.quick-input-widget input');if(!input||input.getBoundingClientRect().height===0)return false;input.focus();return true;})()`, app.renderer), 'Visible native command palette input', deadline);
  await key(app, 'a', 'KeyA', 65, 2);
  await app.client.send('Input.insertText', { text: `>${title}` }, app.renderer.sessionId);
  await waitFor(() => evaluate(app.client, `(() => {const widget=document.querySelector('.quick-input-widget');if(widget?.querySelector('input')?.value!==${JSON.stringify(`>${title}`)})return false;const rows=[...widget.querySelectorAll('.monaco-list-row')].filter(row=>row.getBoundingClientRect().height>0&&row.textContent.includes(${JSON.stringify(title)}));return rows.length===1;})()`, app.renderer), 'Exact native fixture command result', deadline);
  await key(app, 'Enter', 'Enter', 13);
  return phase(expected, deadline);
}
const dialogsExpression = `(() => [...document.querySelectorAll('.monaco-dialog-box')].filter(dialog=>dialog.getBoundingClientRect().height>0).map(dialog=>({text:dialog.textContent.replace(/\\s+/g,' ').trim(),buttons:[...dialog.querySelectorAll('button,[role="button"]')].filter(button=>button.getBoundingClientRect().height>0).map(button=>button.textContent.replace(/\\s+/g,' ').trim())})))()`;
async function modal(app, button, deadline, report, label) {
  const observed = await waitFor(async () => {
    const dialogs = await evaluate(app.client, dialogsExpression, app.renderer);
    return dialogs?.find(dialog => dialog.text.includes('Restore this Little checkpoint?') && dialog.text.includes('app.ts') && dialog.text.includes('dirty.ts') && dialog.buttons.includes(button));
  }, 'Actual native checkpoint confirmation', deadline);
  report.modals.push({ label, ...observed });
  await screenshot(app, `checkpoints-${label}`, report);
  await click(app, '.monaco-dialog-box button,.monaco-dialog-box [role="button"]', button, app.renderer);
}
async function picker(app, deadline, report, label, empty = false) {
  await click(app, '.repository-card button', 'Saved checkpoints');
  const observed = await waitFor(async () => {
    const state = await evaluate(app.client, `(() => {const widget=document.querySelector('.quick-input-widget');if(!widget||widget.getBoundingClientRect().height===0||!widget.textContent.includes('Restore a Little checkpoint'))return null;return {text:widget.textContent.replace(/\\s+/g,' ').trim(),placeholder:widget.querySelector('input')?.placeholder,rows:[...widget.querySelectorAll('.monaco-list-row')].filter(row=>row.getBoundingClientRect().height>0).map(row=>row.textContent.replace(/\\s+/g,' ').trim())};})()`, app.renderer);
    return state && (empty ? state.placeholder?.includes('No recoverable checkpoints') && state.rows.length === 0 : state.rows.length === 1 && state.rows[0].includes('Interrupted edit')) ? state : undefined;
  }, 'Actual native checkpoint picker', deadline);
  report.pickers.push({ label, ...observed });
  if (empty) {
    assert.equal(observed.rows.length, 0);
    assert.ok(observed.placeholder?.includes('No recoverable checkpoints'));
    await key(app, 'Escape', 'Escape', 27);
  } else {
    assert.equal(observed.rows.length, 1);
    assert.ok(observed.rows[0].includes('Interrupted edit') && observed.rows[0].includes('app.ts') && observed.rows[0].includes('dirty.ts'));
    await screenshot(app, `checkpoints-picker-${label}`, report);
    await key(app, 'Enter', 'Enter', 13);
  }
}
async function preserved() {
  await assert.rejects(stat(path.join(fixtureRoot, 'app.ts')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(fixtureRoot, 'dirty.ts')), Buffer.from(dirtyOriginal.toString().replace('before', 'after')));
}
async function visibleError(app, phrase, deadline) {
  return waitFor(async () => {
    const native = await evaluate(app.client, `document.querySelector('.notifications-list-container')?.textContent ?? ''`, app.renderer);
    const agent = (await readAgent(app))?.error;
    return `${native ?? ''}\n${agent ?? ''}`.includes(phrase) ? `${native ?? ''}\n${agent ?? ''}` : undefined;
  }, `Visible checkpoint rejection: ${phrase}`, deadline);
}

async function fixtureFiles(report) {
  const extension = path.join(profileRoot, 'checkpoint-smoke-extension');
  const production = path.join(packagedRoot, 'resources', 'app', 'extensions', 'little-code');
  const packageReport = JSON.parse(await readFile(path.join(projectRoot, 'desktop', 'logs', 'agent-update.json'), 'utf8'));
  assert.equal(packageReport.success, true);
  await mkdir(extension, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(path.join(profileRoot, 'user-data', 'User'), { recursive: true });
  const files = {};
  for (const filename of ['package.json', 'dist/extension.cjs', 'dist/webview.js', 'dist/webview.css']) {
    const bytes = await readFile(path.join(production, filename));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, packageReport.files[filename].sha256, 'Packaged checkpoint UI changed during fixture setup.');
    files[filename] = sha256;
  }
  const productionText = await readFile(path.join(production, 'dist/extension.cjs'), 'utf8');
  assert.ok(productionText.includes('Interrupted edit') && productionText.includes('Restore this Little checkpoint?'), 'Package the current production checkpoint picker before running this smoke.');
  await cp(path.join(production, 'dist'), path.join(extension, 'dist'), { recursive: true });
  await cp(path.join(production, 'resources'), path.join(extension, 'resources'), { recursive: true });
  for (const [filename, expected] of Object.entries(files).filter(([filename]) => filename !== 'package.json')) assert.equal(createHash('sha256').update(await readFile(path.join(extension, filename))).digest('hex'), expected);
  const manifest = JSON.parse(await readFile(path.join(production, 'package.json'), 'utf8'));
  manifest.name = 'little-native-checkpoint-smoke'; manifest.publisher = 'little-code-local-tests'; manifest.main = './fixture.cjs'; manifest.activationEvents = ['*'];
  manifest.contributes.commands.push(...[
    ['makeDirty', 'Checkpoint smoke: Make dirty buffer'], ['revertDirty', 'Checkpoint smoke: Revert dirty buffer'],
    ['ignoreFiles', 'Checkpoint smoke: Ignore affected files'], ['clearIgnore', 'Checkpoint smoke: Clear ignore policy'],
  ].map(([id, title]) => ({ command: `littleCheckpointSmoke.${id}`, title })));
  await writeFile(path.join(extension, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(extension, 'fixture-runtime.json'), JSON.stringify({ node: process.execPath, source: projectRoot }));
  await build({ entryPoints: [path.join(projectRoot, 'tests', 'fixtures', 'checkpoint-host-smoke.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'fixture.cjs') });
  await writeFile(path.join(fixtureRoot, 'README.md'), '# Native checkpoint recovery smoke\n');
  await writeFile(path.join(fixtureRoot, 'app.ts'), original);
  await writeFile(path.join(fixtureRoot, 'dirty.ts'), dirtyOriginal);
  await writeFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false }));
  report.productionBundle = { updatedAt: packageReport.updatedAt, files, copiedUnchanged: true, originalExtensionDisabled: true };
  return extension;
}

async function main() {
  assert.ok(process.argv.slice(2).every(argument => ['--help', '--dry-run'].includes(argument)));
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/smoke-checkpoints.mjs [--dry-run]\nTests actual packaged checkpoint UI in an isolated profile without a provider or API key.'); return; }
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ executable: packagedExecutable, reportPath, profileRoot, launchesProcesses: false }, null, 2)); return; }
  assert.equal(process.platform, 'win32');
  const startedAt = Date.now(), deadline = startedAt + deadlineMs;
  const report = { success: false, startedAt: new Date(startedAt).toISOString(), profileRoot, noProviderOrKeyUsed: true, assertions: {}, launches: [], screenshots: [], pickers: [], modals: [] };
  let app;
  try {
    const extension = await fixtureFiles(report);
    const expected = await realpath(packagedExecutable);
    app = await startApp(expected, deadline, report, [`--extensionDevelopmentPath=${extension}`, '--disable-extension=priyanshu-chaurasia.little-code']);
    const ready = await phase('ready', deadline);
    report.fixture = ready;
    Object.assign(report.assertions, ready.assertions);
    await preserved();
    report.assertions.initialInterruptedStateObserved = true;

    await command(app, 'Checkpoint smoke: Make dirty buffer', 'dirty-ready', deadline);
    await picker(app, deadline, report, 'dirty');
    report.errors = [await visibleError(app, 'Save the affected editor files', deadline)];
    assert.equal((await evaluate(app.client, dialogsExpression, app.renderer)).length, 0);
    await preserved();
    report.assertions.nativePickerFoundInterruptedRecord = true;
    report.assertions.dirtyBufferRejectedBeforeApproval = true;
    Object.assign(report.assertions, (await command(app, 'Checkpoint smoke: Revert dirty buffer', 'clean-ready', deadline)).assertions);

    await command(app, 'Checkpoint smoke: Ignore affected files', 'policy-ready', deadline);
    await picker(app, deadline, report, 'policy');
    await modal(app, 'Restore checkpoint', deadline, report, 'policy');
    report.errors.push(await visibleError(app, 'Restore preserved later changes', deadline));
    await preserved();
    report.assertions.refreshedIgnorePolicyPreserved = true;
    await command(app, 'Checkpoint smoke: Clear ignore policy', 'policy-cleared', deadline);

    await picker(app, deadline, report, 'cancel');
    await modal(app, 'Cancel', deadline, report, 'cancel');
    await preserved();
    report.assertions.nativeCancelPreservedInterruptedState = true;

    await picker(app, deadline, report, 'confirm');
    await modal(app, 'Restore checkpoint', deadline, report, 'confirm');
    await waitFor(async () => {
      try { return (await readFile(path.join(fixtureRoot, 'app.ts'))).equals(original) && (await readFile(path.join(fixtureRoot, 'dirty.ts'))).equals(dirtyOriginal); } catch { return false; }
    }, 'Exact bytes recovered after actual native confirmation', deadline);
    report.assertions.nativeConfirmedExactBytesRestored = true;
    const manifest = JSON.parse(await readFile(path.join(ready.storage, ready.checkpointId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'rolled-back');
    assert.equal(manifest.entries.some(entry => entry.applied || entry.intent), false);
    report.assertions.durableManifestRecordedRollback = true;
    await picker(app, deadline, report, 'finished', true);
    report.assertions.completedCheckpointNoLongerOffered = true;
    await screenshot(app, 'checkpoints-restored', report);
    assert.ok(Object.values(report.assertions).every(Boolean));
    report.success = true;
    console.log('Native interrupted checkpoint discovery, dirty/policy safeguards, Cancel, and exact-byte recovery passed.');
  } catch (error) {
    report.error = error.message;
    if (!app && error.smokeApp) app = error.smokeApp;
    report.progress = await readProgress();
    process.exitCode = 1;
    console.error(`Native checkpoint smoke failed: ${error.message}`);
    if (app?.client && !app.exited) try { await screenshot(app, 'checkpoints-failed', report); } catch { /* Preserve the primary diagnostic. */ }
  } finally {
    try { await stopApp(app, report); } catch (error) { report.cleanupError = error.message; report.success = false; process.exitCode = 1; }
    report.cleanupConfirmed = report.launches.length > 0 && report.launches.every(launch => launch.cleanupConfirmed === true);
    if (!report.cleanupConfirmed) { report.success = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - startedAt;
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`); await rename(`${reportPath}.tmp`, reportPath);
    console.log(`Native checkpoint smoke evidence: ${reportPath}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
