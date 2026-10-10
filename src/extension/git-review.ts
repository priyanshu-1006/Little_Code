import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { GitService } from '../little/git/git-service';
import { WorkspaceService } from '../little/tools/workspace-service';
import { LittleError } from '../little/shared/errors';

/** Human Git review opens bounded, read-only patch documents. Git mutations remain native user actions. */
export class GitReviewHost implements vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly registration: vscode.Disposable;
  private controller?: AbortController;
  private disposed = false;
  constructor(private readonly current: () => vscode.WorkspaceFolder | undefined, private readonly busy: () => boolean) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider('little-git-review', { provideTextDocumentContent: uri => this.documents.get(uri.path) ?? 'This review has expired. Open Git review again.' });
  }
  async show(): Promise<void> {
    if (this.disposed || this.busy() || this.controller) throw new LittleError('PERMISSION_DENIED', 'Finish the current run or Git review first.');
    const folder = this.current();
    if (!folder || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new LittleError('PERMISSION_DENIED', 'Open and trust a local Git project first.');
    const controller = new AbortController(); this.controller = controller;
    try {
      const service = new GitService(new WorkspaceService(folder.uri.fsPath));
      const status = await service.status(controller.signal);
      if (!status.available) { void vscode.window.showInformationMessage('This folder is not an available Git worktree root. Open its repository root to review changes.'); return; }
      if (!status.changes.length) { void vscode.window.showInformationMessage('No current permitted Git changes to review. Deleted, ignored, linked and private paths may be omitted.'); return; }
      const choice = await vscode.window.showQuickPick(status.changes.flatMap(change => {
        const staged = change.index !== ' ' && change.index !== '?';
        const working = change.worktree !== ' ' || change.index === '?';
        return [...(staged ? [{ label: change.path, description: 'Staged', staged: true }] : []), ...(working ? [{ label: change.path, description: change.index === '?' ? 'Untracked' : 'Working tree', staged: false }] : [])];
      }), { title: `Little Git review · ${status.branch || 'detached'}${status.truncated ? ' · limited list' : ''}`, placeHolder: 'Choose a change to inspect. This review does not stage or commit.' });
      if (!choice || this.disposed || this.busy() || !vscode.workspace.isTrusted || this.current()?.uri.toString() !== folder.uri.toString()) return;
      const diff = await service.diff(choice.label, choice.staged, controller.signal);
      controller.signal.throwIfAborted();
      const id = `/${randomBytes(16).toString('hex')}/${choice.staged ? 'staged' : 'worktree'}.diff`;
      if (this.documents.size >= 8) this.documents.delete(this.documents.keys().next().value!);
      this.documents.set(id, `${diff.truncated ? '# Limited diff: omitted content or paths.\n' : ''}${diff.text || '# No current diff for this file.\n'}`);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'little-git-review', path: id }));
      await vscode.window.showTextDocument(document, { preview: true });
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.registration.dispose(); this.documents.clear(); }
}
