import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Ordinary activation of the unchanged packaged extension; no file tool is replaced. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const profile = path.dirname(context.extensionUri.fsPath);
  assert.match(path.basename(profile), /^features-\d+-\d+-[a-f0-9]{12}$/);
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder && folder.uri.scheme === 'file' && folder.name === 'feature-project');
  assert.equal(path.relative(path.join(profile, 'feature-project'), folder.uri.fsPath), '');
  const progressPath = path.join(profile, 'file-tools-progress.json');
  const assertions: Record<string, boolean> = {};
  const progress = async (phase: string, details: Record<string, unknown> = {}) => {
    await fs.writeFile(`${progressPath}.tmp`, JSON.stringify({ phase, assertions, trusted: vscode.workspace.isTrusted, hostPid: process.pid, ...details }));
    await fs.rename(`${progressPath}.tmp`, progressPath);
  };
  // A disposable notebook serializer exposes a real file-backed NotebookDocument.
  // It is used only to dirty/revert the editor, never by Little's file tools.
  context.subscriptions.push(vscode.workspace.registerNotebookSerializer('little-file-smoke-notebook', {
    deserializeNotebook(bytes) {
      const raw = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')) as { cells: { cell_type: string; source: string | string[]; metadata: Record<string, unknown> }[]; metadata: Record<string, unknown> };
      const cells = raw.cells.map(cell => {
        const data = new vscode.NotebookCellData(cell.cell_type === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
          Array.isArray(cell.source) ? cell.source.join('') : cell.source, cell.cell_type === 'code' ? 'python' : 'markdown');
        data.metadata = cell.metadata; return data;
      });
      const notebook = new vscode.NotebookData(cells); notebook.metadata = raw.metadata; return notebook;
    },
    serializeNotebook() { throw new Error('Smoke notebook buffers must be reverted; this serializer never writes fixture files.'); },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const production = require(path.join(context.extensionUri.fsPath, 'dist', 'extension.cjs')) as { activate(context: vscode.ExtensionContext): void };
  production.activate(context);
  const uri = vscode.Uri.joinPath(folder.uri, 'lesson.ipynb');
  const command = (id: string, action: () => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
    try { await action(); } catch (error) { await progress('failed', { error: error instanceof Error ? error.message : String(error) }); throw error; }
  }));
  command('littleFileSmoke.makeDirty', async () => {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'little-file-smoke-notebook');
    const document = vscode.workspace.notebookDocuments.find(item => item.uri.toString() === uri.toString());
    assert.ok(document && document.cellCount > 0);
    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, [vscode.NotebookEdit.updateCellMetadata(0, { ...document.cellAt(0).metadata, smokeUnsaved: true })]);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);
    assertions.realDirtyNotebookCreated = true;
    await progress('dirty-ready');
  });
  command('littleFileSmoke.revertDirty', async () => {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'little-file-smoke-notebook');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    const document = vscode.workspace.notebookDocuments.find(item => item.uri.toString() === uri.toString());
    assert.ok(document && !document.isDirty);
    assertions.realDirtyNotebookReverted = true;
    await progress('clean-ready');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('little.openAgent');
  });
  command('littleFileSmoke.observeTrust', () => progress('trust-observed'));
  command('littleFileSmoke.manageTrust', async () => {
    await vscode.commands.executeCommand('workbench.trust.manage');
    await progress('trust-ui');
  });
  assert.equal(await context.secrets.get('little.groq.apiKey'), undefined);
  assertions.noPrivateCredential = true;
  await progress('ready');
  await vscode.commands.executeCommand('little.openAgent');
}
