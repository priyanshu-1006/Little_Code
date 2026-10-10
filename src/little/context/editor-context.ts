import type { EditorService } from '../shared/contracts';
import { LittleError } from '../shared/errors';
import { assertNotAborted, WORKSPACE_LIMITS, type WorkspaceService } from '../tools/workspace-service';
import { redactSecrets } from './redact-secrets';
import { extractNotebookSource } from '../tools/notebook-source';

export const EDITOR_CONTEXT_LIMITS = Object.freeze({ activeChars: 10_000, selectionChars: 4_000, diagnosticChars: 4_000, maxDiagnostics: 30, maxOpenFiles: 20 });

export async function getActiveFileContext(workspace: WorkspaceService, editor: EditorService, signal: AbortSignal) {
  assertNotAborted(signal);
  const snapshot = editor.snapshot();
  if (!snapshot.activeFile) return { path: null, content: '', truncated: false };
  const target = await workspace.resolvePath(snapshot.activeFile, signal);
  if (target.relativePath.toLowerCase().endsWith('.ipynb')) {
    const notebook = snapshot.activeContent === undefined ? await workspace.readFile(snapshot.activeFile, signal)
      : extractNotebookSource(snapshot.activeContent, target.relativePath, {}, signal);
    return { path: target.relativePath, content: notebook.content.slice(0, EDITOR_CONTEXT_LIMITS.activeChars),
      truncated: notebook.truncated || notebook.content.length > EDITOR_CONTEXT_LIMITS.activeChars };
  }
  const raw = snapshot.activeContent ?? (await workspace.readFile(snapshot.activeFile, signal)).content;
  const text = redactSecrets(raw.slice(0, WORKSPACE_LIMITS.maxFileBytes));
  assertNotAborted(signal);
  return { path: target.relativePath, content: text.slice(0, EDITOR_CONTEXT_LIMITS.activeChars), truncated: raw.length > EDITOR_CONTEXT_LIMITS.activeChars };
}

export async function getSelectionContext(workspace: WorkspaceService, editor: EditorService, signal: AbortSignal) {
  assertNotAborted(signal);
  const snapshot = editor.snapshot();
  if (!snapshot.activeFile || !snapshot.selection) return { path: null, selection: '', truncated: false };
  const target = await workspace.resolvePath(snapshot.activeFile, signal);
  if (target.relativePath.toLowerCase().endsWith('.ipynb')) return { path: null, selection: '', truncated: true,
    note: 'Notebook JSON selection omitted. Inspect notebook source cells with read_notebook.' };
  const text = redactSecrets(snapshot.selection.slice(0, WORKSPACE_LIMITS.maxFileBytes));
  assertNotAborted(signal);
  return { path: target.relativePath, selection: text.slice(0, EDITOR_CONTEXT_LIMITS.selectionChars), truncated: snapshot.selection.length > EDITOR_CONTEXT_LIMITS.selectionChars };
}

export async function getDiagnosticsContext(workspace: WorkspaceService, editor: EditorService, signal: AbortSignal) {
  assertNotAborted(signal);
  const all = editor.snapshot().diagnostics;
  const diagnostics: string[] = [];
  let remaining: number = EDITOR_CONTEXT_LIMITS.diagnosticChars;
  for (const diagnostic of all.slice(0, EDITOR_CONTEXT_LIMITS.maxDiagnostics)) {
    assertNotAborted(signal);
    if (remaining === 0) break;
    // Until diagnostics have a structured source contract, reject ambiguous provenance.
    const location = /^(.+?):(\d+)(?::(\d+))?(?::|\s)\s*([\s\S]*)$/.exec(diagnostic.slice(0, WORKSPACE_LIMITS.maxFileBytes));
    if (!location?.[1]) continue;
    try {
      const source = await workspace.resolvePath(location[1], signal);
      if (source.relativePath.toLowerCase().endsWith('.ipynb')) continue;
      const text = redactSecrets(`${source.relativePath}:${location[2]}${location[3] ? `:${location[3]}` : ''}: ${location[4] ?? ''}`).slice(0, Math.min(600, remaining));
      diagnostics.push(text);
      remaining -= text.length;
    } catch (error) {
      if (error instanceof LittleError && error.code === 'AGENT_CANCELLED') throw error;
      if (!(error instanceof LittleError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  assertNotAborted(signal);
  return { diagnostics, truncated: all.length > diagnostics.length || remaining === 0 };
}
