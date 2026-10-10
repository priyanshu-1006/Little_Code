import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';

/** Exercises bundled commands in an owned fixture profile; never installs a framework or SDK. */
export async function run(): Promise<void> {
  const profile = process.env.LITTLE_BUILD_TOOLS_SMOKE_PROFILE;
  assert.ok(profile && path.isAbsolute(profile));
  assert.match(path.basename(profile), /^build-tools-\d+-\d+-[a-f0-9]{12}$/);
  const project = path.join(profile, 'fixture-project');
  const assertions: Record<string, boolean> = {};
  const progress = async (phase: string, details: Record<string, unknown> = {}) => {
    await fs.writeFile(path.join(profile, 'progress.json'), JSON.stringify({ phase, assertions, ...details, updatedAt: new Date().toISOString() }, null, 2));
  };
  const exists = (name: string) => fs.access(path.join(project, name)).then(() => true, () => false);
  try {
    await progress('fixture-entry');
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder?.uri.scheme === 'file' && vscode.workspace.isTrusted);
    assert.equal((await fs.realpath(folder.uri.fsPath)).toLowerCase(), (await fs.realpath(project)).toLowerCase());
    await progress('extension-host-ready');
    const extension = vscode.extensions.getExtension('priyanshu-chaurasia.little-code');
    assert.ok(extension, 'The real bundled Little extension must be present.');
    await extension.activate();
    const commands = new Set(await vscode.commands.getCommands());
    assertions.bundledCommandsRegistered = ['little.createProject', 'little.runFile', 'little.inspectRuntimes', 'little.setupCppToolchain', 'little.flutterPreview', 'little.flutterHotReload', 'little.flutterRestart', 'little.flutterStop', 'little.openBuildTools'].every(command => commands.has(command));
    assert.ok(assertions.bundledCommandsRegistered);
    const manifest = extension.packageJSON as { contributes: { menus: Record<string, Array<{command: string}>> } };
    assertions.explorerFolderWizardContributed = manifest.contributes.menus['explorer/context']?.some(item => item.command === 'little.createProject') === true;
    assertions.editorRunControlContributed = manifest.contributes.menus['editor/title']?.some(item => item.command === 'little.runFile') === true;
    assert.ok(assertions.explorerFolderWizardContributed && assertions.editorRunControlContributed);

    const before = (await fs.readdir(project)).sort();
    const wizard = vscode.commands.executeCommand('little.createProject', folder.uri);
    await progress('wizard-picker');
    await wizard;
    assertions.wizardCancellationPreservesFolder = JSON.stringify((await fs.readdir(project)).sort()) === JSON.stringify(before);
    assert.ok(assertions.wizardCancellationPreservesFolder);

    const rejected = vscode.commands.executeCommand('little.runFile', vscode.Uri.file(path.join(project, 'reject.cjs')));
    await progress('reject-modal', { script: 'reject.cjs', button: 'Cancel' });
    await rejected;
    await delay(200);
    assertions.nativeRunRejectionNoExecution = !await exists('rejected-marker.txt');
    assert.ok(assertions.nativeRunRejectionNoExecution);

    const allowed = vscode.commands.executeCommand('little.runFile', vscode.Uri.file(path.join(project, 'allowed.cjs')));
    await progress('allow-modal', { script: 'allowed.cjs', button: 'Compile / run' });
    await allowed;
    const deadline = Date.now() + 12000;
    while (!await exists('allowed-marker.txt') && Date.now() < deadline) await delay(50);
    assert.equal(await fs.readFile(path.join(project, 'allowed-marker.txt'), 'utf8'), 'LITTLE_BUILD_TOOLS_OK');
    assertions.nativeReviewedTaskRunsNode = true;

    const changed = vscode.commands.executeCommand('little.runFile', vscode.Uri.file(path.join(project, 'changed.cjs')));
    await progress('changed-modal', { script: 'changed.cjs', button: 'Compile / run' });
    const readinessDeadline = Date.now() + 10000;
    while (!await fs.access(path.join(profile, 'change-source.ready')).then(() => true, () => false) && Date.now() < readinessDeadline) await delay(40);
    await fs.appendFile(path.join(project, 'changed.cjs'), '\n// changed after the run review was prepared\n');
    await fs.writeFile(path.join(profile, 'change-source.done'), 'changed');
    await changed;
    await delay(300);
    assertions.changedSourceIsNotExecuted = !await exists('changed-marker.txt');
    assert.ok(assertions.changedSourceIsNotExecuted);
    await progress('complete', { success: true });
  } catch (error) {
    await progress('failed', { success: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
