import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { packagedExecutable, projectRoot } from './desktop-paths.mjs';
import { startApp, stopApp, readAgent, click, waitFor, evaluate, profileRoot, fixtureRoot, evidenceRoot } from './smoke-features.mjs';

const runFile = promisify(execFile);
const reportPath = path.join(projectRoot, 'desktop', 'logs', 'native-shell-smoke.json');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const gitExecutable = 'C:\\Program Files\\Git\\cmd\\git.exe';
const darkTheme = 'Little Dark / Neo Aurora';
const lightTheme = 'Little Light / Paper Aurora';
const durationMs = 360000;
let cancelled = false;

const stateExpression = `(() => {
  const root = document.querySelector('.monaco-workbench');
  const visible = element => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
  const sidebar = document.querySelector('.part.sidebar');
  const panel = document.querySelector('.part.panel');
  const agent = document.querySelector('.part.auxiliarybar');
  const navigation = [...document.querySelectorAll('.little-shell-navigator button')].map(button => {
    const box = button.getBoundingClientRect();
    return { id: button.dataset.littleNavigation, visible: visible(button), current: button.getAttribute('aria-current'), label: button.getAttribute('aria-label'), mask: getComputedStyle(button.querySelector('.little-shell-icon')).maskImage, left: box.left, right: box.right };
  });
  const logo = document.querySelector('img.little-shell-logo');
  const filesIcon = document.querySelector('.part.activitybar .codicon-explorer-view-icon');
  const activityContent = document.querySelector('.part.activitybar > .content');
  return {
    branded: document.body.classList.contains('little-code') && !!root,
    theme: root?.classList.contains('vs-dark') ? 'dark' : root?.classList.contains('vs') ? 'light' : 'other',
    titlebarBackground: document.querySelector('.part.titlebar') ? getComputedStyle(document.querySelector('.part.titlebar')).backgroundColor : '',
    logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
    navigation,
    sidebar: { visible: visible(sidebar), composite: sidebar?.dataset.activeComposite, text: sidebar?.textContent?.slice(0, 4000) },
    terminal: { visible: visible(panel) && panel?.dataset.activeComposite === 'terminal', composite: panel?.dataset.activeComposite, nativeXterm: visible(panel?.querySelector('.xterm')), focusedInput: document.activeElement?.classList.contains('xterm-helper-textarea') === true },
    agent: { visible: visible(agent), composite: agent?.dataset.activeComposite, tabs: [...(agent?.querySelectorAll('.composite-bar-container [role="tab"]') || [])].filter(visible).map(tab => tab.textContent?.trim()) },
    homeActive: navigation.some(button => button.id === 'home' && button.current === 'true') && [...document.querySelectorAll('.part.editor .tab.active')].some(tab => /Little Code/.test(tab.textContent)),
    rail: { visible: visible(activityContent), radius: activityContent ? getComputedStyle(activityContent).borderRadius : '', filesMask: filesIcon ? getComputedStyle(filesIcon, '::before').maskImage : '' },
    errors: [...document.querySelectorAll('.notification-list-item')].map(item => item.textContent).filter(text => /Could Not Open This View|command.*not found/i.test(text)),
    viewport: { width: innerWidth, height: innerHeight },
  };
})()`;

async function nativeState(app) {
  if (cancelled) throw new Error('Native shell smoke cancelled.');
  return evaluate(app.client, stateExpression, app.renderer);
}

async function waitState(app, predicate, description, deadline, timeout = 20000) {
  return waitFor(async () => { const state = await nativeState(app); return state && predicate(state) ? state : undefined; }, description, deadline, timeout);
}

async function activate(app, id, predicate, description, deadline) {
  await click(app, `.little-shell-navigator button[data-little-navigation="${id}"]`, undefined, app.renderer);
  const state = await waitState(app, predicate, description, deadline);
  assert.equal(state.errors.length, 0, 'Native navigation reported a command failure.');
  return state;
}

async function capture(app, name, report) {
  await delay(250);
  const result = await app.client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, app.renderer.sessionId, 8000);
  const file = path.join(evidenceRoot, `native-shell-${name}.png`);
  await writeFile(file, Buffer.from(result.data, 'base64'));
  report.screenshots.push(file);
}

async function key(app, keyName, code, keyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await app.client.send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }, app.renderer.sessionId);
}

/** Uses the actual Explorer, native editor input and Ctrl+S; only fixtureRoot can change. */
async function editFixtureInNativeEditor(app, deadline, report) {
  const file = path.join(fixtureRoot, 'app.ts');
  assert.ok(file.startsWith(fixtureRoot + path.sep));
  const before = await readFile(file, 'utf8');
  const point = await evaluate(app.client, `(() => {
    const labels = [...document.querySelectorAll('.part.sidebar .monaco-list-row .label-name')].filter(label => label.textContent?.trim() === 'app.ts' && label.getBoundingClientRect().height > 0);
    if (labels.length !== 1) return null;
    const box = labels[0].getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`, app.renderer);
  assert.ok(point, 'The generated app.ts was absent or ambiguous in the real Explorer.');
  for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await app.client.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount, ...point }, app.renderer.sessionId);
  await waitFor(() => evaluate(app.client, `(() => {
    const tabs = [...document.querySelectorAll('.part.editor .tab.active')];
    const editors = [...document.querySelectorAll('.part.editor .monaco-editor')].filter(editor => editor.getBoundingClientRect().height > 0 && editor.querySelector('.view-lines')?.textContent.includes('LITTLE_NATIVE_SHELL_SOURCE'));
    if (!tabs.some(tab => /app.ts/.test(tab.textContent)) || editors.length !== 1) return false;
    const input = editors[0].querySelector('textarea.inputarea, .native-edit-context'); if (!input) return false;
    input.focus(); return document.activeElement === input;
  })()`, app.renderer), 'Generated source in the actual native editor', deadline, 20000);
  const addition = 'export const nativeShellSaved = "LITTLE_NATIVE_SHELL_SAVED";\n';
  await key(app, 'End', 'End', 35, 2);
  await app.client.send('Input.insertText', { text: addition }, app.renderer.sessionId);
  await waitFor(() => evaluate(app.client, `[...document.querySelectorAll('.part.editor .monaco-editor .view-lines')].some(lines => lines.textContent.includes('LITTLE_NATIVE_SHELL_SAVED'))`, app.renderer), 'Actual editor accepted generated source text', deadline, 10000);
  await key(app, 's', 'KeyS', 83, 2);
  const after = await waitFor(async () => { const content = await readFile(file, 'utf8'); return content === before + addition ? content : undefined; }, 'Native Ctrl+S persisted the generated file', deadline, 10000);
  report.observations.editor = { file: path.relative(fixtureRoot, file), before, after, openedVia: 'Explorer pointer double-click', savedVia: 'Native editor Ctrl+S' };
  report.assertions.nativeEditorFileSave = true;
}

async function searchSavedFixture(app, deadline, report) {
  const focused = await evaluate(app.client, `(() => {
    const inputs = [...document.querySelectorAll('.part.sidebar .search-widget textarea[aria-label^="Search:"], .part.sidebar .search-widget input[aria-label^="Search:"]')].filter(input => input.getBoundingClientRect().height > 0);
    if (inputs.length !== 1) return false; inputs[0].focus(); return document.activeElement === inputs[0];
  })()`, app.renderer);
  assert.equal(focused, true, 'The actual native Search query input was unavailable or ambiguous.');
  await key(app, 'a', 'KeyA', 65, 2);
  await app.client.send('Input.insertText', { text: 'LITTLE_NATIVE_SHELL_SAVED' }, app.renderer.sessionId);
  await key(app, 'Enter', 'Enter', 13);
  const results = await waitFor(() => evaluate(app.client, `(() => {
    const result = document.querySelector('.part.sidebar .search-view .results');
    if (!result || result.getBoundingClientRect().height === 0) return null;
    const text = result.textContent.replace(/\\u00a0/g, ' ');
    return text.includes('app.ts') && text.includes('LITTLE_NATIVE_SHELL_SAVED') ? text.slice(0, 2000) : null;
  })()`, app.renderer), 'Native Search found the saved fixture source', deadline, 20000);
  report.observations.searchResults = { query: 'LITTLE_NATIVE_SHELL_SAVED', nativeResults: results };
  report.assertions.nativeSearchSavedSource = true;
}

// Electron exposes renderer emulation, but not Chrome's Browser window-bound commands.
// These dimensions exercise the real native DOM's responsive layout, not the OS window.
async function emulateViewport(app, width, height) {
  await app.client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, app.renderer.sessionId);
}

/** Reads only this isolated test profile's bounded native logs, without writing preferences. */
async function inspectLogs() {
  const logRoot = path.join(profileRoot, 'user-data', 'logs');
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.log')) files.push(file);
    }
  }
  await visit(logRoot);
  assert.ok(files.length > 0 && files.length <= 100, 'Owned native log inventory was absent or unexpectedly large.');
  let total = 0;
  const failures = [];
  let gitActivated = false;
  for (const file of files) {
    const handle = await open(file, 'r');
    let text;
    try {
      const metadata = await handle.stat();
      total += metadata.size;
      assert.ok(metadata.size <= 2 * 1024 * 1024 && total <= 8 * 1024 * 1024, 'Owned logs exceeded the bounded inspection budget.');
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
    if (/_doActivateExtension\s+vscode\.git(?:[\s,]|$)/i.test(text)) gitActivated = true;
    for (const line of text.split(/\r?\n/)) {
      if (/Agent Host process started successfully|No default agent (?:contributed|registered)|Cannot find.*copilot[-/]sdk|Failed.*Copilot.*(?:SDK|agent)/i.test(line)) {
        failures.push({ file: path.relative(profileRoot, file).replaceAll('\\', '/'), message: line.slice(0, 300) });
      }
    }
  }
  return { files: files.map(file => path.relative(profileRoot, file).replaceAll('\\', '/')), bytes: total, gitActivated, agentHostStarted: failures.some(item => /Agent Host process started successfully/i.test(item.message)), missingDefaultAgent: failures.some(item => /No default agent (?:contributed|registered)/i.test(item.message)), failures };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ executable: packagedExecutable, isolatedProfile: profileRoot, generatedProject: fixtureRoot, nativeActions: ['Home', 'Files', 'Search', 'Git', 'Terminal', 'Agent', 'Light/Dark'], reportPath, durationMs, launched: false, fixtureChatDefaultOverride: false }, null, 2));
    return;
  }
  assert.equal(process.platform, 'win32', 'This smoke check targets the real Windows Little Code package.');
  await access(packagedExecutable);
  await access(powershell);
  await access(gitExecutable);
  const expected = await realpath(packagedExecutable);
  const root = path.resolve(projectRoot) + path.sep;
  assert.ok(expected.toLowerCase().startsWith(root.toLowerCase()), 'Packaged executable escaped the authorized workspace.');
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  const report = { executable: expected, profileRoot, fixtureRoot, startedAt: new Date(startedAt).toISOString(), fixtureChatDefaultOverride: false, responsiveNativeDOMEmulated: true, launches: [], screenshots: [], assertions: {}, observations: {}, success: false };
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  await mkdir(path.join(profileRoot, 'user-data', 'User'), { recursive: true });
  await mkdir(path.join(profileRoot, 'extensions'), { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'app.ts'), 'export const nativeShellSmoke = "LITTLE_NATIVE_SHELL_SOURCE";\n');
  await writeFile(path.join(fixtureRoot, 'README.md'), '# Native Little Shell Fixture\n');
  // Keep native terminal startup deterministic. No shell command or provider credential is supplied.
  await writeFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), JSON.stringify({
    'terminal.integrated.profiles.windows': { 'Little Shell Smoke': { path: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive'] } },
    'terminal.integrated.defaultProfile.windows': 'Little Shell Smoke',
    'git.autofetch': false,
  }, null, 2));
  const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  await runFile(gitExecutable, ['-c', 'init.defaultBranch=main', 'init', fixtureRoot], { cwd: fixtureRoot, env: gitEnvironment, windowsHide: true, timeout: 10000, maxBuffer: 16000 });
  let app;
  try {
    console.log('Launching the owned Little Code package for native navigation and appearance verification.');
    app = await startApp(expected, deadline, report, [], { enableGit: true });
    const initial = await waitState(app, state => state.branded && state.logoLoaded && state.theme === 'dark' && state.navigation.length === 7 && state.navigation.every(button => button.visible && /little-/.test(button.mask)), 'Real native navigator and supplied logo', deadline);
    report.observations.initial = initial;
    report.assertions.nativeNavigationAndLogo = true;
    report.assertions.upstreamChatHidden = !initial.agent.tabs.some(label => label === 'Chat');
    assert.ok(report.assertions.upstreamChatHidden, 'The fresh native sidebar still displayed unused upstream Chat.');
    report.assertions.nativeRailIcons = initial.rail.visible && /little-files/.test(initial.rail.filesMask) && initial.rail.radius !== '0px';
    assert.ok(report.assertions.nativeRailIcons, 'Actual activity rail did not load Little outline icons and floating shape.');
    report.observations.files = await activate(app, 'files', state => state.sidebar.visible && state.sidebar.composite === 'workbench.view.explorer' && /app.ts/.test(state.sidebar.text), 'Native Explorer and generated source', deadline);
    report.assertions.nativeExplorer = true;
    await editFixtureInNativeEditor(app, deadline, report);
    report.observations.search = await activate(app, 'search', state => state.sidebar.visible && state.sidebar.composite === 'workbench.view.search', 'Native Search', deadline);
    report.assertions.nativeSearch = true;
    await searchSavedFixture(app, deadline, report);
    report.observations.git = await activate(app, 'git', state => state.sidebar.visible && state.sidebar.composite === 'workbench.view.scm' && /app.ts/.test(state.sidebar.text), 'Native Git changes', deadline);
    report.assertions.nativeGitChanges = true;
    report.observations.terminal = await activate(app, 'terminal', state => state.terminal.visible && state.terminal.nativeXterm, 'Native terminal widget', deadline);
    report.assertions.nativeTerminal = true;
    report.observations.agent = await activate(app, 'agent', state => state.agent.visible && state.agent.composite === 'workbench.view.extension.little', 'Native Little Agent sidebar', deadline);
    const agent = await readAgent(app);
    report.assertions.nativeAgent = !!agent && agent.workspace === 'feature-project';
    report.observations.home = await activate(app, 'home', state => state.homeActive, 'Native Little Home editor', deadline);
    report.assertions.nativeHome = true;
    await capture(app, 'dark', report);
    assert.equal(await evaluate(app.client, `(() => { const button = document.querySelector('button[data-little-navigation="home"]'); if (!button) return false; button.focus(); return true; })()`, app.renderer), true);
    await key(app, 'ArrowRight', 'ArrowRight', 39);
    assert.equal(await evaluate(app.client, `document.activeElement?.dataset.littleNavigation`, app.renderer), 'files', 'Real toolbar arrow navigation failed.');
    report.assertions.nativeKeyboardNavigation = true;
    await app.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, app.renderer.sessionId);
    assert.equal(await evaluate(app.client, `getComputedStyle(document.querySelector('.little-shell-button')).transitionDuration`, app.renderer), '0s', 'Native shell did not honor reduced motion.');
    await app.client.send('Emulation.setEmulatedMedia', { features: [] }, app.renderer.sessionId);
    report.assertions.reducedMotion = true;
    await emulateViewport(app, 900, 800);
    const compact = await waitState(app, state => state.viewport.width < 1100 && state.navigation.every(button => button.visible && button.left >= 0 && button.right <= state.viewport.width), 'Compact native navigation', deadline);
    report.observations.compact = compact;
    report.assertions.compactNavigation = true;
    await app.client.send('Emulation.clearDeviceMetricsOverride', {}, app.renderer.sessionId);
    report.observations.light = await activate(app, 'appearance', state => state.theme === 'light' && state.navigation.find(button => button.id === 'appearance')?.label === 'Switch to Dark Mode', 'Native Little light theme', deadline);
    assert.notEqual(report.observations.light.titlebarBackground, initial.titlebarBackground, 'Native appearance did not change the real shell background.');
    report.assertions.lightAppearance = true;
    await capture(app, 'light', report);
    const saved = await readFile(path.join(profileRoot, 'user-data', 'User', 'settings.json'), 'utf8');
    assert.match(saved, /"workbench\.colorTheme"\s*:\s*"Little Light \/ Paper Aurora"/, 'Native theme preference was not persisted.');
    assert.doesNotMatch(saved, /chat\.disableAIFeatures/, 'Fixture unexpectedly overrode the upstream AI distribution default.');
    await stopApp(app, report);
    app = undefined;
    console.log('Restarting only the owned test profile to verify the saved native light theme.');
    app = await startApp(expected, deadline, report, [], { enableGit: true });
    report.observations.restart = await waitState(app, state => state.theme === 'light' && state.logoLoaded, 'Persisted native light appearance', deadline);
    report.assertions.lightPersistedAcrossRestart = true;
    await capture(app, 'light-restart', report);
    report.observations.darkAgain = await activate(app, 'appearance', state => state.theme === 'dark' && state.navigation.find(button => button.id === 'appearance')?.label === 'Switch to Light Mode', 'Native Little dark theme', deadline);
    report.assertions.darkAppearance = true;
    report.themes = { dark: darkTheme, light: lightTheme };
    await stopApp(app, report);
    app = undefined;
    report.logs = await inspectLogs();
    report.assertions.nativeGitExtensionActivated = report.logs.gitActivated;
    assert.equal(report.logs.failures.length, 0, 'Owned startup logs reported orphan upstream AI startup or missing-default-agent errors.');
    report.assertions.earlyDistributionChatDefault = true;
    assert.ok(Object.values(report.assertions).every(Boolean), 'At least one native shell assertion failed.');
    report.success = true;
    console.log('Actual native navigation, Explorer/Search/Git/terminal/Agent/Home, dark/light persistence, keyboard and reduced-motion behavior verified.');
  } catch (error) {
    app ??= error.smokeApp;
    report.error = error.message;
    process.exitCode = 1;
    console.error(`Native shell smoke failed: ${error.message}`);
    if (app?.client && app.renderer) {
      app.client.deadline = Date.now() + 5000;
      report.failedState = await nativeState(app).catch(() => undefined);
      await capture(app, 'failed', report).catch(() => undefined);
    }
  } finally {
    if (app?.client && app.renderer) await app.client.send('Emulation.clearDeviceMetricsOverride', {}, app.renderer.sessionId, 2000).catch(() => undefined);
    try { await stopApp(app, report); } catch (error) { report.cleanupError = error.message; report.success = false; process.exitCode = 1; }
    if (!report.logs) {
      try { report.logs = await inspectLogs(); } catch (error) { report.logInspectionError = error.message; }
    }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAt;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native shell evidence: ${reportPath}`);
  }
}

main().catch(error => { console.error(`Native shell smoke could not start: ${error.message}`); process.exitCode = 1; });
