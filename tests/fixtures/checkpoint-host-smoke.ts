import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';

/** A disposable extension activates the unchanged packaged production bundle. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const profile = path.dirname(context.extensionUri.fsPath);
  assert.match(path.basename(profile), /^features-\d+-\d+-[a-f0-9]{12}$/);
  const runtime = JSON.parse(await fs.readFile(path.join(context.extensionUri.fsPath, 'fixture-runtime.json'), 'utf8')) as { node: string; source: string };
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder && folder.uri.scheme === 'file' && folder.name === 'feature-project');
  assert.equal(path.relative(path.join(profile, 'feature-project'), folder.uri.fsPath), '');
  const progressPath = path.join(profile, 'checkpoint-progress.json');
  const assertions: Record<string, boolean> = {};
  let checkpointId = '', workerPid: number | undefined;
  const progress = async (phase: string, details: Record<string, unknown> = {}) => {
    const temporary = `${progressPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ phase, assertions, checkpointId, workerPid, hostPid: process.pid, ...details }, null, 2)}\n`);
    await fs.rename(temporary, progressPath);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const production = require(path.join(context.extensionUri.fsPath, 'dist', 'extension.cjs')) as { activate(context: vscode.ExtensionContext): void };
  production.activate(context);
  const dirtyUri = vscode.Uri.joinPath(folder.uri, 'dirty.ts');
  const command = (id: string, action: () => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
    try { await action(); } catch (error) { await progress('failed', { error: error instanceof Error ? error.message : String(error) }); throw error; }
  }));
  command('littleCheckpointSmoke.makeDirty', async () => {
    const document = await vscode.workspace.openTextDocument(dirtyUri);
    await vscode.window.showTextDocument(document, { preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(dirtyUri, new vscode.Position(0, 0), '// LITTLE_UNSAVED_BUFFER\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    assertions.realDirtyBufferCreated = true;
    await progress('dirty-ready');
  });
  command('littleCheckpointSmoke.revertDirty', async () => {
    const document = await vscode.workspace.openTextDocument(dirtyUri);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.equal(document.isDirty, false);
    assertions.realDirtyBufferReverted = true;
    await progress('clean-ready');
  });
  command('littleCheckpointSmoke.ignoreFiles', async () => {
    await fs.writeFile(vscode.Uri.joinPath(folder.uri, '.littleignore').fsPath, 'app.ts\ndirty.ts\n');
    await progress('policy-ready');
  });
  command('littleCheckpointSmoke.clearIgnore', async () => {
    await fs.writeFile(vscode.Uri.joinPath(folder.uri, '.littleignore').fsPath, '');
    await progress('policy-cleared');
  });
  try {
    assert.equal(vscode.workspace.isTrusted, true);
    assert.equal(await context.secrets.get('little.groq.apiKey'), undefined);
    assertions.noGroqCredentialPresent = true;
    const key = createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 24);
    const storage = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'checkpoints', key).fsPath;
    await fs.mkdir(storage, { recursive: true });
    const script = `
      import { createRequire } from 'node:module';
      import * as path from 'node:path';
      import { EditProposalService } from ${JSON.stringify(pathToFileURL(path.join(runtime.source, 'src/little/tools/edit-proposals.ts')).href)};
      import { WorkspaceService } from ${JSON.stringify(pathToFileURL(path.join(runtime.source, 'src/little/tools/workspace-service.ts')).href)};
      const io = createRequire(import.meta.url)('node:fs/promises'), move = io.rename;
      io.rename = async (from, to) => { await move(from, to); if (path.basename(from) === 'app.ts' && path.basename(to) === 'displaced') process.exit(72); };
      const service = new EditProposalService(new WorkspaceService(${JSON.stringify(folder.uri.fsPath)}), ${JSON.stringify(storage)});
      const proposal = await service.stage(['dirty.ts','app.ts'].map(path => ({kind:'replace',path,replacements:[{search:'before',replacement:'after'}]})));
      await service.apply(service.accept(proposal.id));
      throw new Error('Owned checkpoint worker did not reach the filesystem crash boundary.');
    `;
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) if (/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name) || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete environment[name];
    const worker = spawn(runtime.node, ['--import', 'tsx', '--input-type=module', '--eval', script], { cwd: runtime.source, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    workerPid = worker.pid;
    let output = '';
    worker.stdout.on('data', value => { output += String(value); });
    worker.stderr.on('data', value => { output += String(value); });
    const timeout = setTimeout(() => worker.kill(), 15_000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
      assert.equal(exit, 72, output);
    } finally { clearTimeout(timeout); }
    assertions.ownedCrashWorkerExited = true;
    const ids = (await fs.readdir(storage)).filter(id => /^[a-f0-9]{32}$/.test(id));
    assert.equal(ids.length, 1);
    checkpointId = ids[0]!;
    const manifest = JSON.parse(await fs.readFile(path.join(storage, checkpointId, 'manifest.json'), 'utf8')) as { version: number; state: string; entries: { path: string; applied: boolean; intent?: { operation: string; phase: string } }[] };
    assert.equal(manifest.version, 2);
    assert.equal(manifest.state, 'prepared');
    assert.equal(manifest.entries[0]!.applied, true);
    assert.equal(manifest.entries[1]!.applied, false);
    assert.equal(manifest.entries[1]!.intent?.phase, 'prepared');
    await assert.rejects(fs.stat(vscode.Uri.joinPath(folder.uri, 'app.ts').fsPath), { code: 'ENOENT' });
    assertions.genuineInterruptedTransactionPrepared = true;
    await progress('ready', { storage, manifest });
    await vscode.commands.executeCommand('little.openAgent');
  } catch (error) {
    await progress('failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
