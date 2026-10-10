import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { normalizeError } from '../little/shared/errors';
import { GROQ_SECRET_KEY } from '../little/providers/groq';

const WelcomeActionSchema = z.object({
  type: z.enum(['ready', 'openProject', 'openRecent', 'configure', 'configureOllama', 'agent', 'terminal', 'toggleAppearance', 'createProject', 'runFile', 'flutterPreview', 'buildTools']),
});

/** Little's home lives in the native editor area; all actions use host services. */
export class LittleWelcome implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private snapshotRevision = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configure: () => Promise<void>,
    private readonly isConfigured: () => Promise<boolean>,
    private readonly configureOllama: () => Promise<void>,
  ) {
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.snapshot();
    }));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(change => { if (change.affectsConfiguration('little.provider')) void this.snapshot(); }));
    this.subscriptions.push(context.secrets.onDidChange(change => {
      if (change.key === GROQ_SECRET_KEY) void this.snapshot();
    }));
  }

  show(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, preserveFocus);
      void this.snapshot();
      return;
    }
    const panel = vscode.window.createWebviewPanel('little.welcome', 'Little Code', {
      viewColumn: vscode.ViewColumn.One, preserveFocus,
    }, {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'resources'),
      ],
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'app', 'little-code-32.png');
    panel.webview.html = this.html(panel.webview);
    const messages = panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message).catch(error => {
        void panel.webview.postMessage({ type: 'error', message: normalizeError(error).message });
      });
    });
    const closed = panel.onDidDispose(() => {
      messages.dispose();
      closed.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
  }

  private async snapshot(): Promise<void> {
    const revision = ++this.snapshotRevision;
    const panel = this.panel;
    const configured = await this.isConfigured();
    if (panel && this.panel === panel && revision === this.snapshotRevision) {
      void panel.webview.postMessage({
        type: 'snapshot', configured, provider: vscode.workspace.getConfiguration('little').inspect<string>('provider')?.globalValue === 'ollama' ? 'ollama' : 'groq',
        workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      });
    }
  }

  private async receive(data: unknown): Promise<void> {
    const action = WelcomeActionSchema.safeParse(data);
    if (!action.success) return;
    switch (action.data.type) {
      case 'ready': await this.snapshot(); break;
      case 'openProject': {
        const folders = await vscode.window.showOpenDialog({
          title: 'Open a Project in Little Code',
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Open Project',
        });
        if (folders?.[0]) await vscode.commands.executeCommand('vscode.openFolder', folders[0], { forceNewWindow: false });
        break;
      }
      case 'openRecent': await vscode.commands.executeCommand('workbench.action.openRecent'); break;
      case 'configure': await this.configure(); await this.snapshot(); break;
      case 'configureOllama': await this.configureOllama(); await this.snapshot(); break;
      case 'agent': await vscode.commands.executeCommand('little.openAgent'); break;
      case 'terminal': await vscode.commands.executeCommand('workbench.action.terminal.new'); break;
      case 'createProject': await vscode.commands.executeCommand('little.createProject'); break;
      case 'runFile': await vscode.commands.executeCommand('little.runFile'); break;
      case 'flutterPreview': await vscode.commands.executeCommand('little.flutterPreview'); break;
      case 'buildTools': await vscode.commands.executeCommand('little.openBuildTools'); break;
      case 'toggleAppearance': await vscode.commands.executeCommand('little.toggleAppearance'); break;
    }
    void this.panel?.webview.postMessage({ type: 'done' });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const resource = (directory: string, name: string) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, directory, name),
    );
    const tokens = resource('dist', 'webview.css');
    const fonts = resource('resources/fonts', 'fonts.css');
    const styles = resource('resources', 'welcome.css');
    const logo = resource('resources/app', 'little-logo.png');
    const icons = {
      home: 'M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10',
      folder: 'M3 9V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Zm0 1h18',
      agent: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-1-2V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6',
      terminal: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 5 3 3-3 3m7 0h3',
      recent: 'M4 4v6h6M4 10a8 8 0 1 1 1 8m7-11v5l3 2',
      arrow: 'M5 12h14m-5-5 5 5-5 5M4 5v2',
      connect: 'm9 7 3 3m3-6 5 5M5 10l5 5m-3 3-3 3M7 7l10 10m-6-9 3-3 5 5-3 3M8 11l-3 3 5 5 3-3',
      local: 'M5 4h14a2 2 0 0 1 2 2v10H3V6a2 2 0 0 1 2-2ZM2 20h20M9 16v4m6-4v4',
      sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
      moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5ZM17 3v4m-2-2h4',
    };
    const icon = (name: keyof typeof icons, className = '') => `<svg class="home-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]}"></path></svg>`;
    const version = String(this.context.extension.packageJSON.version ?? '');
    const versionLabel = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ? version : 'development';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${fonts}"><link rel="stylesheet" href="${tokens}"><link rel="stylesheet" href="${styles}"><title>Little Code</title></head>
<body><main class="little-home">
  <aside class="home-nav" aria-label="Little navigation"><span class="nav-brand"><img src="${logo}" alt="Little Code" width="40" height="40"><span>Little<span class="nav-brand-dot">.</span></span></span><nav class="home-nav-items" aria-label="Workspace shortcuts"><span class="home-nav-item current" aria-current="page">${icon('home')}<span>Home</span></span><button class="home-nav-item" data-action="openProject" title="Open project">${icon('folder')}<span>Projects</span></button><button class="home-nav-item" data-action="agent" title="Focus Little Agent">${icon('agent')}<span>Little Agent</span></button><button class="home-nav-item" data-action="terminal" title="Open terminal">${icon('terminal')}<span>Terminal</span></button><button class="home-nav-item" data-action="openRecent" title="Open recent project">${icon('recent')}<span>Recent</span></button></nav><span class="nav-caption">A little spark.<br>A new possibility.</span></aside>
  <div class="home-content">
  <header class="home-topline"><span class="home-wordmark"><span>Make room for your next idea.<small>YOUR LITTLE WORKSPACE</small></span></span><div class="home-header-actions"><span class="build-stage"><span class="build-node" aria-hidden="true"></span>PREVIEW · ${versionLabel}</span><button class="home-appearance" data-action="toggleAppearance" aria-label="Switch to light appearance" title="Light appearance">${icon('sun', 'appearance-sun')}${icon('moon', 'appearance-moon')}</button></div></header>
  <section class="home-intro" aria-labelledby="home-title">
    <div class="hero-copy">
      <p class="eyebrow"><span class="eyebrow-node" aria-hidden="true"></span>A LITTLE CONTEXT. A BIGGER PICTURE.</p>
      <h1 id="home-title">Start with an idea.<br><span>Build with Little.</span></h1>
      <p class="home-description">Your project. A fresh perspective.<br>Explore the code, shape a plan, and build with a companion that keeps you in control.</p>
      <div class="home-actions"><button class="home-primary" data-action="openProject">${icon('folder')}<span>Open project</span>${icon('arrow')}</button><button class="home-secondary" data-action="openRecent">${icon('recent')}Open recent</button></div>
      <p class="home-foundation">Native editor<span aria-hidden="true">·</span>Integrated terminal<span aria-hidden="true">·</span>Git workspace</p>
    </div>
    <div class="hero-mark"><span class="hero-orbit orbit-one" aria-hidden="true"></span><span class="hero-orbit orbit-two" aria-hidden="true"></span><img src="${logo}" alt="Little Code logo" width="340" height="311"><span class="hero-note">${icon('agent')}Ideas welcome here.</span><p class="art-caption">MADE FOR MAKING.</p></div>
  </section>
  <section class="home-setup" aria-labelledby="setup-title">
    <div class="setup-heading"><h2 id="setup-title">Find your flow.</h2><span class="setup-status" id="provider-status">Groq · not connected</span></div>
    <div class="setup-grid">
      <button class="setup-card" data-action="configure"><span class="card-icon">${icon('connect')}</span><span class="card-content"><span class="card-kicker">YOUR MODEL CONNECTION</span><strong id="provider-label">Connect Groq</strong><span>Bring your key. Discover models. Choose the one that fits your flow.</span></span><span class="card-arrow">${icon('arrow')}</span></button>
      <button class="setup-card" data-action="agent"><span class="card-icon">${icon('agent')}</span><span class="card-content"><span class="card-kicker">YOUR CODING COMPANION</span><strong>Meet Little Agent</strong><span>Ask, plan, review an edit, or approve a supervised Agent run.</span></span><span class="card-arrow">${icon('arrow')}</span></button>
    </div>
    <div class="home-actions local-connection"><button class="home-secondary" data-action="configureOllama">${icon('local')}Use Ollama locally</button><span class="setup-status" id="provider-choice">Cloud or local. Your choice.</span></div>
    <p class="setup-privacy">Groq credentials stay in encrypted system storage. AI requests send selected project context to your chosen Groq Cloud or loopback Ollama provider.</p>
  </section>
  <section class="home-setup home-build" aria-labelledby="build-title">
    <div class="setup-heading"><h2 id="build-title">From idea to first run.</h2><button class="home-secondary" data-action="buildTools">${icon('terminal')}Build tools</button></div>
    <div class="setup-grid">
      <button class="setup-card" data-action="createProject"><span class="card-icon">${icon('folder')}</span><span class="card-content"><span class="card-kicker">START WITH A TEMPLATE</span><strong>Create a project</strong><span>Choose a framework, language and starter. Little runs the setup with your approval.</span></span><span class="card-arrow">${icon('arrow')}</span></button>
      <button class="setup-card" data-action="flutterPreview"><span class="card-icon">${icon('local')}</span><span class="card-content"><span class="card-kicker">SEE THE APP YOU BUILD</span><strong>Flutter preview</strong><span>Choose a real device, emulator or local web preview. Reload, restart and stop from Little.</span></span><span class="card-arrow">${icon('arrow')}</span></button>
    </div>
    <div class="home-actions local-connection"><button class="home-secondary" data-action="runFile">${icon('terminal')}Run current file</button><span class="setup-status">Installed language runtimes. Visible build output.</span></div>
  </section>
  <section class="home-workflow" aria-label="Available workflow">
    <div><span class="workflow-node" aria-hidden="true"></span><strong>Understand the project</strong><span>Ask · repository tools &amp; visible context</span></div>
    <div><span class="workflow-node" aria-hidden="true"></span><strong>Shape the next step</strong><span>Plan · investigate before changing code</span></div>
    <div><span class="workflow-node" aria-hidden="true"></span><strong>Review and recover</strong><span>Edit · native diffs, explicit acceptance &amp; checkpoints</span></div>
    <div><span class="workflow-node" aria-hidden="true"></span><strong>Build with oversight</strong><span>Agent · approved commands &amp; visible checks</span></div>
  </section>
  <p class="home-error" id="home-error" role="alert" hidden></p>
  <footer class="home-footer"><span>Built by Priyanshu Chaurasia</span><span id="workspace-status">No project open</span><button class="footer-button" data-action="terminal">${icon('terminal')}Open terminal</button></footer>
</div></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const buttons = [...document.querySelectorAll('[data-action]')];
  const appearance = document.querySelector('.home-appearance');
  function updateAppearance() {
    const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
    appearance.setAttribute('aria-label', light ? 'Switch to dark appearance' : 'Switch to light appearance');
    appearance.title = light ? 'Dark appearance' : 'Light appearance';
  }
  updateAppearance();
  new MutationObserver(updateAppearance).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function setBusy(busy) { for (const button of buttons) button.disabled = busy; }
  for (const button of buttons) button.addEventListener('click', () => {
    document.getElementById('home-error').hidden = true;
    setBusy(true);
    vscode.postMessage({ type: button.dataset.action });
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'snapshot') {
      document.getElementById('provider-status').textContent = message.configured ? 'Groq · key saved' : 'Groq · not connected';
      document.getElementById('provider-status').classList.toggle('connected', !!message.configured);
      document.getElementById('provider-label').textContent = message.configured ? 'Manage Groq connection' : 'Connect Groq';
      document.getElementById('provider-choice').textContent = message.provider === 'ollama' ? 'Current choice: Ollama · local' : 'Current choice: Groq Cloud';
      document.getElementById('workspace-status').textContent = message.workspace ? 'Project · ' + message.workspace : 'No project open';
      setBusy(false);
    } else if (message.type === 'done') setBusy(false);
    else if (message.type === 'error') {
      const error = document.getElementById('home-error');
      error.textContent = typeof message.message === 'string' ? message.message : 'The action could not be completed.';
      error.hidden = false; setBusy(false);
    }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.subscriptions) disposable.dispose();
  }
}
