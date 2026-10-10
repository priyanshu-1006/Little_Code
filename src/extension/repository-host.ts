import * as vscode from 'vscode';
import { RepositoryIndex } from '../little/context/repository-index';
import type { RepositoryStatus } from '../little/shared/contracts';
import { LittleError, normalizeError } from '../little/shared/errors';
import { WorkspaceService } from '../little/tools/workspace-service';

interface Entry {
  folder: vscode.WorkspaceFolder; index: RepositoryIndex; status: RepositoryStatus;
  watcher: vscode.FileSystemWatcher; controller?: AbortController; work?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
  held: number; dirty: boolean; closed: boolean;
  lastEmission: number;
}
const ignoredWatcherPath = /(?:^|\/)(?:\.upstream|\.git|node_modules|vendor|dist|build|out|coverage|generated|\.next|\.cache|\.venv)(?:\/|$)/i;

/** In-memory project maps with local file watchers. Every model query still refreshes policy and source. */
export class RepositoryHost implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly current: () => vscode.WorkspaceFolder | undefined, private readonly emit: (status: RepositoryStatus) => void) {}

  private key(folder: vscode.WorkspaceFolder): string { return folder.uri.toString(); }
  private publish(entry: Entry, status: RepositoryStatus): void {
    if (entry.closed || this.disposed) return;
    const previousState = entry.status.state;
    entry.status = { ...status, workspace: entry.folder.name };
    if (status.state === 'indexing' && previousState === 'indexing' && Date.now() - entry.lastEmission < 75) return;
    if (this.current()?.uri.toString() === this.key(entry.folder)) { entry.lastEmission = Date.now(); this.emit(entry.status); }
  }
  private entry(folder: vscode.WorkspaceFolder): Entry {
    const key = this.key(folder);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.disposed || folder.uri.scheme !== 'file') throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'Open a local project to build its repository map.');
    const index = new RepositoryIndex(new WorkspaceService(folder.uri.fsPath));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    const entry: Entry = { folder, index, watcher, held: 0, dirty: false, closed: false, lastEmission: 0, status: { state: 'idle', workspace: folder.name, files: 0, processed: 0, symbols: 0, reused: 0, truncated: false, generation: 0 } };
    const dirty = (uri: vscode.Uri) => {
      const relative = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
      if (ignoredWatcherPath.test(relative) || this.disposed || entry.closed) return;
      entry.dirty = true;
      index.invalidate(/(?:^|\/)(?:\.gitignore|\.littleignore)$/.test(relative) ? undefined : [relative]);
      entry.controller?.abort();
      this.publish(entry, { ...entry.status, state: 'idle', message: 'Project changed. The next scan refreshes its local map.' });
      this.schedule(entry);
    };
    watcher.onDidChange(dirty); watcher.onDidCreate(dirty); watcher.onDidDelete(dirty);
    this.entries.set(key, entry);
    // Retain at most three project maps; no source index is written into a repository.
    if (this.entries.size > 3) {
      const oldest = [...this.entries.entries()].find(([candidate, value]) => candidate !== key && !value.held);
      if (oldest && oldest[0] !== key) { this.close(oldest[1]); this.entries.delete(oldest[0]); }
    }
    return entry;
  }
  status(folder: vscode.WorkspaceFolder): RepositoryStatus { return { ...this.entry(folder).status }; }
  index(folder: vscode.WorkspaceFolder): RepositoryIndex { return this.entry(folder).index; }
  progress(folder: vscode.WorkspaceFolder, status: RepositoryStatus): void { this.publish(this.entry(folder), status); }

  private schedule(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.closed || this.disposed || entry.held) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.refresh(entry.folder).catch(() => undefined); }, 600);
  }

  async refresh(folder: vscode.WorkspaceFolder): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      const entry = this.entry(folder);
      this.publish(entry, { ...entry.status, state: 'idle', message: 'Trust this project to build its local index.' }); return;
    }
    const entry = this.entry(folder);
    if (entry.held) return;
    if (entry.work) return entry.work;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    entry.dirty = false;
    const controller = new AbortController();
    entry.controller = controller;
    const work = (async () => {
      try { await entry.index.refresh(controller.signal, status => this.publish(entry, status)); }
      catch (error) {
        if (controller.signal.aborted) this.publish(entry, { ...entry.status, state: 'idle', message: 'Scan stopped. Refresh to build the current project map.' });
        else this.publish(entry, { ...entry.status, state: 'failed', message: normalizeError(error).message });
      } finally { if (entry.controller === controller) entry.controller = undefined; }
    })();
    entry.work = work;
    try { await work; } finally {
      if (entry.work === work) entry.work = undefined;
      if (entry.dirty) this.schedule(entry);
    }
  }
  async prepare(folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<{ index: RepositoryIndex; dispose(): void }> {
    const entry = this.entry(folder);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    signal.throwIfAborted();
    entry.held++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; entry.held--;
      if (entry.dirty) this.schedule(entry);
    };
    try {
      if (entry.work) {
        const abort = () => entry.controller?.abort();
        signal.addEventListener('abort', abort, { once: true });
        try { await entry.work; } finally { signal.removeEventListener('abort', abort); }
      }
      signal.throwIfAborted();
      return { index: entry.index, dispose: release };
    } catch (error) {
      release(); throw error;
    }
  }
  private close(entry: Entry): void {
    entry.closed = true;
    entry.controller?.abort();
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.dispose();
  }
  dispose(): void { this.disposed = true; for (const entry of this.entries.values()) this.close(entry); this.entries.clear(); }
}
