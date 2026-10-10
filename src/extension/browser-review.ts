import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BrowserClient, validateBrowserEndpoint, validateBrowserPage } from '../little/browser/browser-client';
import type { AgentTool, RuntimeEvent } from '../little/shared/contracts';
import { LittleError } from '../little/shared/errors';
import { assertNotAborted } from '../little/tools/workspace-service';

/** Approved local preview snapshots. The client creates/closes its own tab; screenshots stay in native private preview. */
export class BrowserReviewHost implements vscode.Disposable {
  private disposed = false;
  private controller?: AbortController;
  private client?: BrowserClient;
  constructor(private readonly context: vscode.ExtensionContext, private readonly current: () => vscode.WorkspaceFolder | undefined,
    private readonly running: () => boolean, private readonly event: (event: RuntimeEvent) => void) {}
  get busy(): boolean { return !!this.controller; }
  private endpoint(): string { return validateBrowserEndpoint(vscode.workspace.getConfiguration('little').inspect<string>('browserEndpoint')?.globalValue ?? 'http://127.0.0.1:9222'); }
  async configure(): Promise<void> {
    if (this.disposed || this.running() || this.busy) throw new LittleError('PERMISSION_DENIED', 'Finish the current run or preview first.');
    const value = await vscode.window.showInputBox({ title: 'Local browser preview endpoint', value: this.endpoint(), prompt: 'Use an already-running isolated Chrome/Edge debug profile. Little creates one temporary preview tab and never selects your existing tabs.', ignoreFocusOut: true,
      validateInput: value => { try { validateBrowserEndpoint(value); return; } catch { return 'Use a loopback HTTP origin without credentials, path, query or fragment.'; } } });
    if (value !== undefined && !this.disposed && !this.running() && !this.busy) await vscode.workspace.getConfiguration('little').update('browserEndpoint', validateBrowserEndpoint(value), vscode.ConfigurationTarget.Global);
  }
  private async inspect(url: string, folder: vscode.WorkspaceFolder, signal: AbortSignal, provider?: string, runId?: string): Promise<unknown> {
    assertNotAborted(signal);
    const endpoint = this.endpoint(); const target = validateBrowserPage(url);
    if (runId) this.event({ type: 'agent.state.changed', runId, state: 'waiting_for_permission' });
    const choice = vscode.window.showWarningMessage('Inspect this local app in a temporary browser tab?', { modal: true, detail: `${target}\n\nBrowser endpoint: ${endpoint}\nLittle will open and close its own tab, read rendered page text, and capture a native screenshot. It cannot select existing tabs, supply arbitrary scripts, or click controls. The page may load network resources or cause its own side effects.${provider ? `\nRedacted page text will be included in this ${provider} run; screenshots stay in the native preview.` : ''}` }, 'Inspect app');
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => { cancel = () => reject(new LittleError('AGENT_CANCELLED', 'Browser approval stopped.')); signal.addEventListener('abort', cancel, { once: true }); });
    let approval;
    try { if (signal.aborted) cancel(); approval = await Promise.race([choice, stopped]); }
    finally { signal.removeEventListener('abort', cancel); }
    assertNotAborted(signal);
    if (approval !== 'Inspect app') return { status: 'rejected', message: 'The local app was not inspected.' };
    if (this.disposed || !vscode.workspace.isTrusted || this.current()?.uri.toString() !== folder.uri.toString() || endpoint !== this.endpoint()) throw new LittleError('PERMISSION_DENIED', 'The project, browser endpoint or trust changed. Request another preview.');
    if (runId) this.event({ type: 'agent.state.changed', runId, state: 'executing' });
    const client = new BrowserClient(endpoint); this.client = client;
    try {
      const result = await client.snapshot(target, signal);
      assertNotAborted(signal);
      let preview = false;
      if (result.screenshot && this.context.storageUri) {
        try {
          const root = this.context.storageUri.fsPath;
          await fs.mkdir(root, { recursive: true });
          if ((await fs.lstat(root)).isSymbolicLink() || path.resolve(await fs.realpath(root)).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Private preview directory changed.');
          const uri = vscode.Uri.joinPath(this.context.storageUri, `local-preview-${randomBytes(16).toString('hex')}.png`);
          const bytes = Buffer.from(result.screenshot.slice('data:image/png;base64,'.length), 'base64');
          const handle = await fs.open(uri.fsPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(bytes); } finally { await handle.close(); }
          assertNotAborted(signal);
          await vscode.commands.executeCommand('vscode.open', uri, { preview: true, preserveFocus: true }); preview = true;
          const saved = await fs.readdir(root);
          const previous = await Promise.all(saved.filter(name => /^local-preview-[a-f0-9]{32}\.png$/.test(name)).map(async name => { const target = path.join(root, name); const stat = await fs.lstat(target); return { target, stat }; }));
          const retained = previous.filter(file => file.stat.isFile() && !file.stat.isSymbolicLink() && file.stat.nlink === 1).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
          for (const file of retained.slice(8)) if (file.target !== uri.fsPath && path.dirname(file.target) === root && path.resolve(await fs.realpath(root)).toLowerCase() === path.resolve(root).toLowerCase()) await fs.unlink(file.target);
        } catch { assertNotAborted(signal); }
      }
      return { status: 'inspected', url: result.url, title: result.title, text: result.text, truncated: result.truncated, screenshot: preview ? 'Native preview opened; image not sent to model.' : 'Native screenshot preview unavailable.' };
    } finally { client.dispose(); if (this.client === client) this.client = undefined; }
  }
  async show(): Promise<void> {
    if (this.disposed || this.running() || this.busy) throw new LittleError('PERMISSION_DENIED', 'Finish the current run or preview first.');
    const folder = this.current(); if (!folder || folder.uri.scheme !== 'file' || !vscode.workspace.isTrusted) throw new LittleError('PERMISSION_DENIED', 'Open and trust a local project first.');
    const controller = new AbortController(); this.controller = controller;
    try {
      const url = await vscode.window.showInputBox({ title: 'Inspect a local app', value: 'http://127.0.0.1:3000/', prompt: 'A locally served app URL. Document navigation stays within this origin.', ignoreFocusOut: true,
        validateInput: value => { try { validateBrowserPage(value); return; } catch { return 'Use a loopback HTTP(S) app URL without credentials or fragments.'; } } });
      if (url === undefined || this.disposed || this.running()) return;
      const result = await this.inspect(url, folder, controller.signal) as { status: string; title?: string; text?: string };
      if (result.status === 'inspected') {
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: `${result.title ?? 'Local app'}\n${validateBrowserPage(url)}\n\n${result.text ?? ''}` });
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
  tool(folder: vscode.WorkspaceFolder, provider: string): AgentTool {
    const schema = z.object({ url: z.string().min(1).max(2048) }).strict();
    return { name: 'inspect_local_app', description: 'After native approval, inspect rendered text of one locally served app in a new temporary browser tab. No clicks or arbitrary scripts. Screenshot stays in native preview. Requires a configured running loopback Chrome/Edge debug endpoint.', risk: 'EXECUTION', parameters: z.toJSONSchema(schema, { io: 'input' }),
      validate(input) { const parsed = schema.safeParse(input); if (!parsed.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Provide a local app URL.'); return { url: validateBrowserPage(parsed.data.url) }; },
      execute: (input, context) => this.inspect(schema.parse(input).url, folder, context.signal, provider, context.runId) };
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.client?.dispose(); }
}
