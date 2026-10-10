import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AgentRuntime } from '../little/agent/runtime';
import type { EditorService, LLMProvider, ModelInfo, ProviderId, RuntimeEvent, SecretStore } from '../little/shared/contracts';
import { LittleError, normalizeError } from '../little/shared/errors';
import { GroqProvider, GROQ_SECRET_KEY } from '../little/providers/groq';
import { WorkspaceService } from '../little/tools/workspace-service';
import { createReadOnlyTools } from '../little/tools/read-only-tools';
import { createNotebookTools } from '../little/tools/notebook-tools';
import { createDocumentReadTools } from '../little/tools/document-tools';
import { ChatHistoryStore } from '../little/history/chat-history';
import { collectContext } from '../little/context/collect-context';
import { ClientMessageSchema, type HostMessage } from '../little/ui/protocol';
import { LittleWelcome } from './welcome';
import { EditReviewHost } from './edit-review';
import { CommandReviewHost } from './command-review';
import { RepositoryHost } from './repository-host';
import { createRepositoryTools } from '../little/tools/repository-tools';
import { OllamaProvider, validateOllamaEndpoint } from '../little/providers/ollama';
import { ProjectFeaturesHost } from './project-features';
import { redactSecrets } from '../little/context/redact-secrets';
import { GitReviewHost } from './git-review';
import { createGitTools } from '../little/tools/git-tools';
import { runReviewTeam } from '../little/agent/review-team';
import { z } from 'zod';
import { BrowserReviewHost } from './browser-review';

class HostSecrets implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  get(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  store(key: string, value: string): Promise<void> { return Promise.resolve(this.secrets.store(key, value)); }
  delete(key: string): Promise<void> { return Promise.resolve(this.secrets.delete(key)); }
}
let lastWorkspaceUri: string | undefined;
function currentWorkspace(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  const active = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (active) lastWorkspaceUri = active.uri.toString();
  return active || vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === lastWorkspaceUri) || vscode.workspace.workspaceFolders?.[0];
}
async function toggleAppearance(): Promise<void> {
  const kind = vscode.window.activeColorTheme.kind;
  const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  await vscode.workspace.getConfiguration('workbench').update('colorTheme',
    light ? 'Little Dark / Neo Aurora' : 'Little Light / Paper Aurora', vscode.ConfigurationTarget.Global);
}
function editorService(folder: vscode.WorkspaceFolder): EditorService {
  const relative = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) return undefined;
    return vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
  };
  return { snapshot() {
    const editor = vscode.window.activeTextEditor;
    const activeFile = editor ? relative(editor.document.uri) : undefined;
    return {
      activeFile,
      activeContent: activeFile && editor ? editor.document.getText().slice(0, 12_000) : undefined,
      selection: activeFile && editor ? editor.document.getText(editor.selection).slice(0, 6000) : undefined,
      openFiles: vscode.workspace.textDocuments.map(document => relative(document.uri)).filter((value): value is string => !!value).slice(0, 30),
      diagnostics: vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => {
        const path = relative(uri);
        return path ? diagnostics.slice(0, 10).map(diagnostic => `${path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message.slice(0, 300)}`) : [];
      }).slice(0, 30),
    };
  } };
}

class LittlePanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private runtime?: AgentRuntime;
  private models: ModelInfo[] = [];
  private modelsProvider?: ProviderId;
  private observedProviderSettings: string;
  private snapshotRevision = 0;
  private history: RuntimeEvent[] = [];
  private readonly chats: ChatHistoryStore;
  private historyFolderKey?: string;
  private chatRun?: { workspace: string; sessionId: string; turnId: string; runId?: string };
  private changingChat = false;
  private discovery?: AbortController;
  private discoveryTask?: { signature: string; promise: Promise<void> };
  private discoveryState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private providerError?: { code: string; message: string; retryAt?: number };
  private credentialRevision = 0;
  private readonly cooldowns = new Map<string, number>();
  private disposed = false;
  private starting = false;
  private startController?: AbortController;
  private runFolderKey?: string;
  private runProviderSignature?: string;
  private runModel?: string;
  private readonly editReview: EditReviewHost;
  private readonly commandReview: CommandReviewHost;
  private readonly repositories: RepositoryHost;
  private readonly secrets: HostSecrets;
  private readonly groq: GroqProvider;
  private readonly features: ProjectFeaturesHost;
  private readonly gitReview: GitReviewHost;
  private readonly browserReview: BrowserReviewHost;
  private readonly log: vscode.OutputChannel;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.observedProviderSettings = this.providerSignature();
    this.secrets = new HostSecrets(context.secrets);
    this.groq = new GroqProvider(this.secrets);
    this.log = vscode.window.createOutputChannel('Little Code');
    this.chats = new ChatHistoryStore({ get: key => context.workspaceState.get(key), update: (key, value) => context.workspaceState.update(key, value) }, { onSaveError: workspace => this.historySaveFailed(workspace) });
    this.editReview = new EditReviewHost(context, event => this.recordEvent(event), () => this.starting || (this.runtime?.busy ?? false), currentWorkspace);
    this.commandReview = new CommandReviewHost(event => this.recordEvent(event));
    this.gitReview = new GitReviewHost(currentWorkspace, () => this.starting || (this.runtime?.busy ?? false) || this.features.busyEditing);
    this.browserReview = new BrowserReviewHost(context, currentWorkspace, () => this.starting || (this.runtime?.busy ?? false) || this.features.busyEditing, event => this.recordEvent(event));
    this.repositories = new RepositoryHost(currentWorkspace, status => this.send({ type: 'repository', status }));
    this.features = new ProjectFeaturesHost(context, currentWorkspace, () => this.starting || (this.runtime?.busy ?? false),
      (folder, features) => { if (currentWorkspace()?.uri.toString() === folder.uri.toString()) this.send({ type: 'features', workspace: folder.name, features }); },
      () => this.providerId() === 'ollama' ? 'Ollama runtime' : 'Groq Cloud', event => this.recordEvent(event));
    const stopChangedProject = () => { if (this.runFolderKey && this.runFolderKey !== currentWorkspace()?.uri.toString()) { this.startController?.abort(); this.runtime?.cancel(); } };
    const refreshProject = () => { stopChangedProject(); void this.snapshot(); const folder = currentWorkspace(); if (folder?.uri.scheme === 'file') void this.repositories.refresh(folder).catch(error => this.report(error)); };
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refreshProject),
      vscode.workspace.onDidGrantWorkspaceTrust(refreshProject),
      vscode.workspace.onDidChangeConfiguration(change => {
        if (change.affectsConfiguration('little.provider') || change.affectsConfiguration('little.ollamaEndpoint')) {
          const signature = this.providerSignature(); if (signature === this.observedProviderSettings) return;
          this.observedProviderSettings = signature;
          this.invalidateModels();
          this.startController?.abort(); this.runtime?.cancel(); void this.snapshot();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => { stopChangedProject(); void this.snapshot(); const folder = currentWorkspace(); if (folder?.uri.scheme === 'file' && this.repositories.status(folder).state === 'idle') void this.repositories.refresh(folder).catch(error => this.report(error)); }));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const fonts = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'fonts');
    const app = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'app');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, fonts, app] };
    const nonce = randomBytes(24).toString('base64');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const fontStyles = view.webview.asWebviewUri(vscode.Uri.joinPath(fonts, 'fonts.css'));
    const logo = view.webview.asWebviewUri(vscode.Uri.joinPath(app, 'little-logo.png'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src ${view.webview.cspSource}; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${fontStyles}"><link rel="stylesheet" href="${style}"><title>Little Agent</title></head><body><div id="root" data-logo="${logo}"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const messages = view.webview.onDidReceiveMessage((data: unknown) => {
      void this.receive(data).catch(error => this.report(error));
    });
    const closed = view.onDidDispose(() => {
      messages.dispose();
      closed.dispose();
      if (this.view === view) this.view = undefined;
    });
  }
  private send(message: HostMessage): void {
    if (!this.disposed) void this.view?.webview.postMessage(message);
  }
  private setting<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('little').inspect<T>(key)?.globalValue ?? fallback; }
  private providerId(): ProviderId { return this.setting<string>('provider', 'groq') === 'ollama' ? 'ollama' : 'groq'; }
  private providerSignature(): string { return `${this.providerId()}:${this.providerId() === 'ollama' ? this.setting('ollamaEndpoint', 'http://127.0.0.1:11434') : this.credentialRevision}`; }
  private invalidateModels(): void {
    this.discovery?.abort(); this.discovery = undefined; this.discoveryTask = undefined;
    this.models = []; this.modelsProvider = undefined; this.discoveryState = 'idle'; this.providerError = undefined;
  }
  private cooldown(model: string): number { const until = this.cooldowns.get(`${this.providerSignature()}:${model}`) ?? 0; return until > Date.now() ? until : 0; }
  private noteCooldown(model: string, delay?: number, signature = this.providerSignature()): void {
    if (delay === undefined || !Number.isFinite(delay) || delay <= 0) return;
    for (const [key, until] of this.cooldowns) if (until <= Date.now()) this.cooldowns.delete(key);
    if (this.cooldowns.size >= 100) this.cooldowns.delete(this.cooldowns.keys().next().value!);
    const key = `${signature}:${model}`;
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, Date.now() + Math.min(delay, 24 * 60 * 60 * 1000)));
  }
  private modelKey(provider = this.providerId()): string { return provider === 'ollama' ? 'ollamaModel' : 'model'; }
  private provider(): LLMProvider { return this.providerId() === 'ollama' ? new OllamaProvider(this.setting('ollamaEndpoint', 'http://127.0.0.1:11434')) : this.groq; }
  private async snapshot(): Promise<void> {
    const revision = ++this.snapshotRevision;
    const signature = this.providerSignature();
    const provider = this.providerId();
    const endpoint = this.setting('ollamaEndpoint', 'http://127.0.0.1:11434');
    const selectedModel = this.setting(this.modelKey(provider), '');
    const models = this.modelsProvider === provider ? this.models : [];
    const configured = provider === 'ollama' ? models.length > 0 : !!(await this.secrets.get(GROQ_SECRET_KEY));
    const folder = currentWorkspace();
    const chatHistory = folder?.uri.scheme === 'file' ? await this.chatSnapshot(folder.uri.toString()) : undefined;
    let features;
    try { features = await this.features.snapshot(folder); } catch (error) { features = { memory: { entries: [], error: normalizeError(error).message }, mcp: [] }; }
    if (currentWorkspace()?.uri.toString() !== folder?.uri.toString() || signature !== this.providerSignature() || revision !== this.snapshotRevision) return;
    this.send({ type: 'snapshot', configured, models, discovery: this.discoveryState, providerError: this.providerError, cooldownUntil: this.cooldown(selectedModel),
      provider, endpoint, features, selectedModel,
      workspace: folder?.name ?? '', chatHistory,
      events: folder?.uri.toString() === this.historyFolderKey && chatHistory?.selectedId === this.chatRun?.sessionId ? this.history : [], busy: this.starting || (this.runtime?.busy ?? false),
      repository: folder?.uri.scheme === 'file' ? this.repositories.status(folder) : undefined });
  }
  private recordEvent(event: RuntimeEvent): void {
    const chat = this.chatRun;
    if (event.type === 'agent.started' && chat && !chat.runId) chat.runId = event.runId;
    if (chat?.runId === event.runId) {
      if (event.type === 'agent.text.delta') this.chats.appendText(chat.workspace, chat.turnId, event.text);
      if (event.type === 'agent.completed' || event.type === 'agent.failed' || event.type === 'agent.cancelled') {
        const status = event.type === 'agent.completed' ? 'completed' : event.type === 'agent.failed' ? 'failed' : 'cancelled';
        void this.chats.finishTurn(chat.workspace, chat.turnId, status).then(() => this.publishChats(chat.workspace)).catch(() => this.historySaveFailed(chat.workspace));
      }
    }
    if (event.type === 'agent.failed' && event.code === 'PROVIDER_RATE_LIMITED' && this.runModel && this.runProviderSignature) this.noteCooldown(this.runModel, event.retryAfterMs, this.runProviderSignature);
    const previous = this.history.at(-1);
    if (event.type === 'agent.text.delta' && previous?.type === 'agent.text.delta' && previous.runId === event.runId) previous.text += event.text;
    else this.history.push(structuredClone(event));
    if (this.history.length > 1000) this.history.splice(1, this.history.length - 1000);
    if (currentWorkspace()?.uri.toString() === this.historyFolderKey) this.send({ type: 'event', event });
    if (event.type === 'agent.state.changed') this.log.appendLine(JSON.stringify({ category: 'agent', runId: event.runId, state: event.state }));
    if (event.type === 'agent.failed') this.log.appendLine(JSON.stringify({ category: 'agent', runId: event.runId,
      code: event.code, message: event.message, model: this.runModel,
      ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
      ...(event.diagnostic === undefined ? {} : { diagnostic: event.diagnostic }) }));
  }
  private async chatSnapshot(workspace: string) {
    const history = await this.chats.snapshot(workspace);
    if (this.chatRun?.workspace === workspace && this.chatRun.sessionId === history.selectedId) history.activeTurnId = this.chatRun.turnId;
    return history;
  }
  private async publishChats(workspace: string): Promise<void> {
    const history = await this.chatSnapshot(workspace);
    if (currentWorkspace()?.uri.toString() === workspace) this.send({ type: 'chatHistory', history });
  }
  private historySaveFailed(workspace: string): void {
    if (!this.disposed) this.log.appendLine(JSON.stringify({ category: 'history', state: 'save_failed' }));
    void this.publishChats(workspace);
  }
  async restoreSavedCheckpoint(): Promise<void> {
    if (this.runtime?.busy || this.starting) throw new LittleError('PERMISSION_DENIED', 'Stop the current Little run before restoring a checkpoint.');
    const folder = currentWorkspace();
    if (!folder || folder.uri.scheme !== 'file') throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'Open the local project whose changes you want to restore.');
    await this.editReview.restoreSaved(new WorkspaceService(folder.uri.fsPath), folder);
  }
  async reviewGit(): Promise<void> { await this.gitReview.show(); }
  async configureBrowser(): Promise<void> { await this.browserReview.configure(); }
  async inspectBrowser(): Promise<void> { await this.browserReview.show(); }
  private report(error: unknown): void {
    const normalized = normalizeError(error);
    this.send({ type: 'error', code: normalized.code, message: normalized.message, retryAfterMs: normalized.retryAfterMs });
  }
  async isConfigured(): Promise<boolean> {
    // The Home connection tile explicitly configures Groq; its status refers to that saved key.
    return !!(await this.secrets.get(GROQ_SECRET_KEY));
  }
  async configure(): Promise<void> {
    if (this.runtime?.busy || this.starting || this.features.busyEditing) { void vscode.window.showInformationMessage('Finish the current run or settings action before changing credentials.'); return; }
    const key = await vscode.window.showInputBox({ title: 'Connect Little Code to Groq', prompt: 'Little Code encrypts your API key in system storage. Project context is sent to Groq Cloud when you submit an AI request.', password: true, ignoreFocusOut: true,
      validateInput: value => value.trim().length < 10 ? 'Enter your Groq API key.' : undefined });
    if (!key || this.disposed) return;
    if (this.runtime?.busy || this.starting || this.features.busyEditing) { void vscode.window.showInformationMessage('Finish the current run or settings action before changing credentials.'); return; }
    await this.secrets.store(GROQ_SECRET_KEY, key.trim());
    this.groq.resetRequestLimits();
    this.credentialRevision++;
    await vscode.workspace.getConfiguration('little').update('provider', 'groq', vscode.ConfigurationTarget.Global);
    this.observedProviderSettings = this.providerSignature();
    this.invalidateModels();
    await this.snapshot();
    await this.refreshModels();
  }
  async removeKey(): Promise<void> {
    this.startController?.abort();
    this.runtime?.cancel();
    this.discovery?.abort();
    await this.secrets.delete(GROQ_SECRET_KEY);
    this.groq.resetRequestLimits();
    this.credentialRevision++;
    if (this.providerId() === 'groq') this.invalidateModels();
    await this.snapshot();
  }
  async configureOllama(): Promise<void> {
    if (this.runtime?.busy || this.starting || this.features.busyEditing) throw new LittleError('PERMISSION_DENIED', 'Finish the current run or settings action first.');
    const config = vscode.workspace.getConfiguration('little');
    const endpoint = await vscode.window.showInputBox({ title: 'Connect Little Code to Ollama', value: this.setting('ollamaEndpoint', 'http://127.0.0.1:11434'), prompt: 'Use a running loopback Ollama endpoint. No API key is required; installed models are discovered.', ignoreFocusOut: true,
      validateInput: value => { try { validateOllamaEndpoint(value); return; } catch { return 'Use a loopback origin without credentials, path, query, or fragment.'; } } });
    if (endpoint === undefined || this.disposed || this.runtime?.busy || this.starting || this.features.busyEditing) return;
    await config.update('ollamaEndpoint', validateOllamaEndpoint(endpoint), vscode.ConfigurationTarget.Global);
    await this.selectProvider('ollama');
  }
  private async selectProvider(provider: ProviderId): Promise<void> {
    if (this.runtime?.busy || this.starting || this.features.busyEditing) throw new LittleError('PERMISSION_DENIED', 'Finish the current run or settings action first.');
    this.invalidateModels();
    await vscode.workspace.getConfiguration('little').update('provider', provider, vscode.ConfigurationTarget.Global);
    this.observedProviderSettings = this.providerSignature();
    await this.snapshot();
    if (provider === 'ollama' || await this.secrets.get(GROQ_SECRET_KEY)) await this.refreshModels();
  }
  private async configurePreferences(): Promise<void> {
    if (this.runtime?.busy || this.starting || this.features.busyEditing) throw new LittleError('PERMISSION_DENIED', 'Finish the current run first.');
    const config = vscode.workspace.getConfiguration('little');
    const value = await vscode.window.showInputBox({ title: 'Your Little Code preferences', prompt: 'Optional personal conventions for all projects. Tool approvals remain required.', value: this.setting('userPreferences', ''), ignoreFocusOut: true, validateInput: text => text.length > 1500 ? 'Keep preferences within 1,500 characters.' : undefined });
    if (value !== undefined && !this.disposed && !this.runtime?.busy && !this.starting) await config.update('userPreferences', redactSecrets(value.trim()), vscode.ConfigurationTarget.Global);
  }
  private async refreshModels(): Promise<void> {
    if (this.runtime?.busy || this.starting) throw new LittleError('PERMISSION_DENIED', 'Wait for the current run before discovering models.');
    const signature = this.providerSignature();
    if (this.discoveryTask?.signature === signature) return this.discoveryTask.promise;
    const discoveryWait = this.cooldown('models') - Date.now();
    if (discoveryWait > 0) throw new LittleError('PROVIDER_RATE_LIMITED', `Model discovery is cooling down. Try again in ${Math.ceil(discoveryWait / 1000)} seconds.`, discoveryWait);
    this.discovery?.abort();
    const providerId = this.providerId();
    const provider = this.provider();
    const controller = new AbortController();
    this.discovery = controller;
    this.discoveryState = 'loading'; this.providerError = undefined;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const promise = (async () => { try {
      await this.snapshot();
      const models = (await provider.listModels(controller.signal)).filter(model => model.capabilities.streaming && model.capabilities.tools !== false);
      if (controller.signal.aborted || this.disposed || this.discovery !== controller || this.providerSignature() !== signature) return;
      this.models = models;
      this.modelsProvider = providerId;
      this.discoveryState = 'ready';
      const config = vscode.workspace.getConfiguration('little');
      const selected = this.setting(this.modelKey(providerId), '');
      if (!models.some(model => model.id === selected)) await config.update(this.modelKey(providerId), models.find(model => model.capabilities.tools === true)?.id ?? models[0]?.id ?? '', vscode.ConfigurationTarget.Global);
      if (!models.length) this.providerError = { code: 'MODEL_UNAVAILABLE', message: providerId === 'groq' ? 'Groq returned no compatible chat models for this key. Check account access, then refresh.' : 'No installed local models were found. Install a model in Ollama, then discover again.' };
      await this.snapshot();
    } catch (error) {
      if (this.discovery === controller && !this.disposed && this.providerSignature() === signature) {
        const normalized = controller.signal.aborted ? new LittleError('PROVIDER_UNAVAILABLE', 'Model discovery timed out. Check your connection and refresh models.') : normalizeError(error);
        this.discoveryState = 'failed';
        if (normalized.code === 'PROVIDER_RATE_LIMITED') this.noteCooldown('models', normalized.retryAfterMs);
        this.providerError = { code: normalized.code, message: normalized.message, retryAt: this.cooldown('models') || undefined };
        if (normalized.code === 'PROVIDER_AUTH_FAILED') { this.models = []; this.modelsProvider = undefined; }
        this.report(normalized); await this.snapshot();
      }
    } finally {
      clearTimeout(timeout);
      if (this.discovery === controller) { this.discovery = undefined; this.discoveryTask = undefined; }
    } })();
    this.discoveryTask = { signature, promise }; await promise;
  }
  private async receive(data: unknown): Promise<void> {
    const parsed = ClientMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'ready') {
      await this.snapshot();
      const folder = currentWorkspace();
      if (folder?.uri.scheme === 'file') void this.repositories.refresh(folder).catch(error => this.report(error));
      if (!this.models.length && (this.providerId() === 'ollama' || await this.secrets.get(GROQ_SECRET_KEY))) await this.refreshModels();
    } else if (message.type === 'openProject') {
      const folders = await vscode.window.showOpenDialog({ title: 'Open a Project in Little Code', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Open Project' });
      if (folders?.[0]) await vscode.commands.executeCommand('vscode.openFolder', folders[0], { forceNewWindow: false });
    } else if (message.type === 'toggleAppearance') await toggleAppearance();
    else if (message.type === 'newChat' || message.type === 'selectChat' || message.type === 'clearChatHistory') {
      if (this.starting || this.runtime?.busy || this.changingChat) throw new LittleError('PERMISSION_DENIED', 'Finish the current run before changing saved chats.');
      const folder = currentWorkspace();
      if (!folder || folder.uri.scheme !== 'file') throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'Open a local project to view its saved chats.');
      this.changingChat = true;
      try {
        if (message.type === 'clearChatHistory') {
          const decision = await vscode.window.showWarningMessage('Delete all saved Little chats for this project? This removes local conversation text; project memory and checkpoints stay separate.', { modal: true }, 'Delete chat history');
          if (decision !== 'Delete chat history') return;
        }
        if (this.disposed || currentWorkspace()?.uri.toString() !== folder.uri.toString() || this.starting || this.runtime?.busy) throw new LittleError('AGENT_CANCELLED', 'The active project or run changed before the chat action.');
        const workspace = folder.uri.toString();
        if (message.type === 'newChat') await this.chats.newSession(workspace);
        else if (message.type === 'selectChat') await this.chats.selectSession(workspace, message.id);
        else await this.chats.clearWorkspace(workspace);
        this.history = []; this.historyFolderKey = workspace; this.chatRun = undefined;
      } finally { this.changingChat = false; await this.snapshot(); }
    }
    else if (message.type === 'configure') await this.configure();
    else if (message.type === 'removeKey') await this.removeKey();
    else if (message.type === 'refreshModels') await this.refreshModels();
    else if (message.type === 'selectProvider') await this.selectProvider(message.provider);
    else if (message.type === 'configureOllama') await this.configureOllama();
    else if (message.type === 'configurePreferences') await this.configurePreferences();
    else if (message.type === 'addMemory') await this.features.editMemory();
    else if (message.type === 'editMemory') await this.features.editMemory(message.id);
    else if (message.type === 'removeMemory') await this.features.removeMemory(message.id);
    else if (message.type === 'addMcpServer') await this.features.addServer();
    else if (message.type === 'connectMcpServer') await this.features.connect(message.id);
    else if (message.type === 'disconnectMcpServer') await this.features.disconnect(message.id);
    else if (message.type === 'removeMcpServer') await this.features.disconnect(message.id, true);
    else if (message.type === 'reviewGit') await this.reviewGit();
    else if (message.type === 'browseCheckpoints') await this.restoreSavedCheckpoint();
    else if (message.type === 'configureBrowser') await this.configureBrowser();
    else if (message.type === 'inspectBrowser') await this.inspectBrowser();
    else if (message.type === 'refreshRepository') {
      if (this.starting || this.runtime?.busy) throw new LittleError('PERMISSION_DENIED', 'Wait for the current run before refreshing the repository map.');
      const folder = currentWorkspace();
      if (!folder || folder.uri.scheme !== 'file') throw new LittleError('WORKSPACE_BOUNDARY_VIOLATION', 'Open a local project to index it.');
      await this.repositories.refresh(folder);
    }
    else if (message.type === 'cancel') { this.startController?.abort(); this.runtime?.cancel(); }
    else if (message.type === 'reviewEdits') await this.editReview.review(message.proposalId);
    else if (message.type === 'decideEdits') await this.editReview.decide(message.proposalId, message.decision);
    else if (message.type === 'decideCommand') await this.commandReview.decide(message.commandId, message.decision);
    else if (message.type === 'restoreCheckpoint') {
      if (this.runtime?.busy || this.starting) throw new LittleError('PERMISSION_DENIED', 'Wait for the current run to finish before restoring changes.');
      try { await this.editReview.restore(message.checkpointId); } finally { await this.snapshot(); }
    }
    else if (message.type === 'selectModel') {
      if (this.modelsProvider !== this.providerId() || !this.models.some(model => model.id === message.model) || this.runtime?.busy || this.starting) return;
      await vscode.workspace.getConfiguration('little').update(this.modelKey(), message.model, vscode.ConfigurationTarget.Global);
      await this.snapshot();
    } else if (message.type === 'start') {
      if (this.runtime?.busy || this.starting || this.changingChat || this.editReview.busy || this.commandReview.busy || this.features.busyEditing || this.browserReview.busy) throw new LittleError('PERMISSION_DENIED', 'Wait for the current run, command, or settings action to finish.');
      const folder = currentWorkspace();
      if (!folder || folder.uri.scheme !== 'file') {
        this.send({ type: 'error', code: 'WORKSPACE_BOUNDARY_VIOLATION', message: 'Open a local repository folder to start Little.' }); return;
      }
      if (!vscode.workspace.isTrusted) {
        this.send({ type: 'error', code: 'PERMISSION_DENIED', message: 'Trust this workspace before starting an AI run.' }); return;
      }
      const model = this.setting(this.modelKey(), '');
      const modelInfo = this.models.find(item => item.id === model);
      const wait = this.cooldown(model) - Date.now();
      if (wait > 0) throw new LittleError('PROVIDER_RATE_LIMITED', `This model is cooling down after Groq's rate limit. Try again in ${Math.ceil(wait / 1000)} seconds, or choose another discovered chat model.`, wait);
      if (this.modelsProvider !== this.providerId() || !this.models.some(item => item.id === model)) {
        this.send({ type: 'error', code: 'MODEL_UNAVAILABLE', message: 'Discover and select a chat model before starting.' }); return;
      }
      if (modelInfo?.capabilities.tools === false) throw new LittleError('MODEL_UNAVAILABLE', 'This model does not support Little’s repository tools. Select a discovered tool-capable chat model.');
      const workspace = new WorkspaceService(folder.uri.fsPath);
      const editor = editorService(folder);
      const providerSignature = this.providerSignature();
      const selectedProvider = this.providerId();
      const provider = this.provider();
      this.starting = true;
      this.runFolderKey = folder.uri.toString();
      this.runProviderSignature = providerSignature; this.runModel = model;
      const startController = new AbortController();
      this.startController = startController;
      let unsubscribe: (() => void) | undefined;
      let repositoryLease: { dispose(): void } | undefined;
      try {
        const saved = await this.chats.beginTurn(folder.uri.toString(), { prompt: message.prompt, mode: message.mode, model, provider: selectedProvider });
        this.chatRun = { workspace: folder.uri.toString(), ...saved };
        this.history = []; this.historyFolderKey = folder.uri.toString();
        await this.publishChats(folder.uri.toString());
        const lease = await this.repositories.prepare(folder, startController.signal);
        repositoryLease = lease;
        startController.signal.throwIfAborted();
        if (this.disposed || !vscode.workspace.isTrusted || currentWorkspace()?.uri.toString() !== folder.uri.toString() || this.providerSignature() !== providerSignature) throw new LittleError('AGENT_CANCELLED', 'The active project, provider or workspace trust changed while preparing this run.');
        const index = lease.index;
        const tools = createReadOnlyTools(workspace, editor);
        tools.push(...createNotebookTools(workspace));
        tools.push(...createDocumentReadTools(workspace));
        tools.push(...createGitTools(workspace));
        tools.push(...createRepositoryTools(editor, index, status => this.repositories.progress(folder, status)));
        tools.push(...this.features.tools(folder));
        if (message.mode === 'edit' || message.mode === 'agent') tools.push(...await this.editReview.tools(workspace, folder));
        if (message.mode === 'agent') tools.push(...this.commandReview.tools(workspace));
        startController.signal.throwIfAborted();
        if (this.disposed) return;
        if (message.mode === 'agent') tools.push(this.browserReview.tool(folder, provider.id === 'ollama' ? 'Ollama runtime' : 'Groq Cloud'));
        const context = async (signal: AbortSignal) => collectContext(workspace, editor, signal, { query: message.prompt, index, conversation: this.chats.conversationContext(folder.uri.toString()), memory: await this.features.memoryContext(folder, message.prompt, signal), preferences: this.setting('userPreferences', ''), onIndexProgress: status => this.repositories.progress(folder, status) });
        if (message.mode === 'agent') {
          const schema = z.object({ prompt: z.string().trim().min(1).max(8000) }).strict(); let used = false;
          const reviewers = createReadOnlyTools(workspace, editor);
          reviewers.push(...createNotebookTools(workspace));
          reviewers.push(...createDocumentReadTools(workspace));
          tools.push({ name: 'delegate_reviews', description: 'Once per run, request two isolated read-only architecture and verification reviews using the selected provider/model. These reviews do not edit or execute checks and add up to two bounded model sessions.', risk: 'SAFE', parameters: z.toJSONSchema(schema, { io: 'input' }),
            validate(input) { const result = schema.safeParse(input); if (!result.success) throw new LittleError('TOOL_VALIDATION_FAILED', 'Supply a bounded review request.'); return result.data; },
            execute: async (input, toolContext) => {
              if (used) throw new LittleError('AGENT_LOOP_LIMIT', 'The two-review team is limited to once per run.'); used = true;
              const result = await runReviewTeam({ provider, tools: reviewers, context: await context(toolContext.signal), prompt: schema.parse(input).prompt, model, signal: toolContext.signal, workspaceRoot: workspace.root,
                modelContextWindow: modelInfo?.contextWindow, modelMaxOutputTokens: modelInfo?.maxOutputTokens,
                onProgress: review => { if (toolContext.runId) this.recordEvent({ type: 'review.updated', runId: toolContext.runId, ...review }); } });
              for (const review of result.reviews) if (toolContext.runId) this.recordEvent({ type: 'review.updated', runId: toolContext.runId, ...review });
              return result;
            } });
        }
        const runtime = new AgentRuntime(provider, tools, context, { workspaceRoot: workspace.root, timeoutMs: message.mode === 'edit' || message.mode === 'agent' ? 900_000 : 180_000,
          modelContextWindow: modelInfo?.contextWindow, modelMaxOutputTokens: modelInfo?.maxOutputTokens });
        this.runtime = runtime;
        this.history = [];
        unsubscribe = runtime.events.subscribe(event => this.recordEvent(event));
        this.starting = false;
        await runtime.run({ prompt: message.prompt, mode: message.mode, model });
      } catch (error) {
        const chat = this.chatRun;
        if (chat?.workspace === folder.uri.toString()) await this.chats.finishTurn(chat.workspace, chat.turnId, startController.signal.aborted ? 'cancelled' : 'failed').catch(() => this.historySaveFailed(chat.workspace));
        throw error;
      } finally {
        await this.chats.flush().catch(() => this.historySaveFailed(folder.uri.toString()));
        this.starting = false;
        if (this.startController === startController) this.startController = undefined;
        this.runFolderKey = undefined;
        this.runProviderSignature = undefined; this.runModel = undefined;
        repositoryLease?.dispose();
        unsubscribe?.(); await this.snapshot();
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.startController?.abort();
    this.runtime?.cancel();
    void this.chats.flush().catch(() => {});
    this.discovery?.abort();
    this.editReview.dispose();
    this.commandReview.dispose();
    this.repositories.dispose();
    this.features.dispose();
    this.gitReview.dispose();
    this.browserReview.dispose();
    this.log.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const panel = new LittlePanel(context);
  const welcome = new LittleWelcome(context, () => panel.configure(), () => panel.isConfigured(), () => panel.configureOllama());
  const nativeDesktop = vscode.env.appName === 'Little Code';
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(sparkle) Little';
  status.tooltip = 'Little Code · Ask, Plan, Edit, and controlled Agent';
  status.command = 'little.openAgent';
  status.show();
  context.subscriptions.push(panel, welcome, status,
    vscode.window.registerWebviewViewProvider('little.agent', panel),
    vscode.commands.registerCommand('little.openAgent', () => vscode.commands.executeCommand(
      nativeDesktop ? 'little.workbench.openAgent' : 'little.agent.focus',
    )),
    vscode.commands.registerCommand('little.openWelcome', () => welcome.show()),
    vscode.commands.registerCommand('little.toggleAppearance', toggleAppearance),
    vscode.commands.registerCommand('little.configureGroq', () => panel.configure().catch(error => vscode.window.showErrorMessage(normalizeError(error).message))),
    vscode.commands.registerCommand('little.configureOllama', () => panel.configureOllama().catch(error => vscode.window.showErrorMessage(normalizeError(error).message))),
    vscode.commands.registerCommand('little.removeGroqKey', () => panel.removeKey()),
    vscode.commands.registerCommand('little.restoreCheckpoint', () => panel.restoreSavedCheckpoint().catch(error => vscode.window.showErrorMessage(normalizeError(error).message))),
    vscode.commands.registerCommand('little.reviewGit', () => panel.reviewGit().catch(error => vscode.window.showErrorMessage(normalizeError(error).message))),
    vscode.commands.registerCommand('little.configureBrowser', () => panel.configureBrowser().catch(error => vscode.window.showErrorMessage(normalizeError(error).message))),
    vscode.commands.registerCommand('little.inspectBrowser', () => panel.inspectBrowser().catch(error => vscode.window.showErrorMessage(normalizeError(error).message))),
  );
  if (nativeDesktop && !vscode.window.tabGroups.all.some(group => group.tabs.length > 0)) {
    welcome.show();
  }
}
