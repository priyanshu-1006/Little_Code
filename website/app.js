'use strict';

const $ = (selector) => document.querySelector(selector);
const themeButton = $('.theme-toggle');
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  themeButton.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} appearance`);
  themeButton.setAttribute('aria-pressed', String(dark));
  $('meta[name="theme-color"]').content = dark ? '#15151b' : '#f5f3ee';
}
try { applyTheme(localStorage.getItem('little-showcase-theme') === 'dark'); } catch { applyTheme(false); }
themeButton.addEventListener('click', () => {
  const dark = !document.body.classList.contains('dark');
  applyTheme(dark);
  try { localStorage.setItem('little-showcase-theme', dark ? 'dark' : 'light'); } catch { /* Browser storage is optional. */ }
});

const menuButton = $('.menu-toggle');
const navigation = $('#navigation');
function closeMenu() { navigation.classList.remove('open'); menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-label', 'Open navigation'); }
menuButton.addEventListener('click', () => {
  const open = !navigation.classList.contains('open');
  navigation.classList.toggle('open', open);
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', `${open ? 'Close' : 'Open'} navigation`);
});
navigation.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && navigation.classList.contains('open')) { closeMenu(); menuButton.focus(); } });
window.matchMedia('(min-width:801px)').addEventListener('change', (event) => { if (event.matches) closeMenu(); });

const modes = {
  ask: { path: 'src/ideas.ts', status: 'Read only', tool: 'read_file', prompt: 'Explain how this function works.',
    code: ['export function greet(name: string) {', '  return `Hello, ${name}.`;', '}'],
    answer: 'Read the source, then explain it with file and line evidence. Ask explores your project without changing files.', result: 'Source first. Answer second.' },
  plan: { path: 'plan / next steps', status: 'Read only', tool: 'update_plan', prompt: 'Plan a friendlier greeting.',
    code: ['01  Inspect the current function.', '02  Propose one focused replacement.', '03  Review before applying changes.', '04  Run the relevant check with approval.'],
    answer: 'Make the scope and sequence visible before implementation. Plan organizes the work without writing files or running commands.', result: 'A clear plan. A considered next step.' },
  edit: { path: 'src/ideas.ts · proposed diff', status: 'Review required', tool: 'propose_file_edits', prompt: 'Make the greeting a little warmer.',
    code: ['- return `Hello, ${name}.`;', '+ return `Hello, ${name}. Welcome aboard!`;'],
    answer: 'Inspect the proposed diff. Accept changes to apply it, or reject to leave your file untouched. Accepted changes get a restore checkpoint.', result: 'Your review is the boundary.' },
  agent: { path: 'run / inspect → plan → review → check', status: 'Approval required', tool: 'run_command', prompt: 'Implement the greeting and verify it.',
    code: ['✓ Inspect current source', '✓ Publish the plan', '→ Request native file review', '→ Ask approval for the project check'],
    answer: 'Agent coordinates the loop. Files need review; commands need a separate approval. Results reflect observed tool outcomes and current checks.', result: 'Approve the change. Approve the check.' },
};
const tabs = [...document.querySelectorAll('.mode-tab')];
const horizontalModes = window.matchMedia('(max-width:800px)');
function updateModeOrientation() { $('.mode-tabs').setAttribute('aria-orientation', horizontalModes.matches ? 'horizontal' : 'vertical'); }
updateModeOrientation();
horizontalModes.addEventListener('change', updateModeOrientation);
function selectMode(tab, focus = false) {
  const mode = modes[tab.dataset.mode];
  tabs.forEach((item) => { const selected = item === tab; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1; });
  $('#mode-panel').setAttribute('aria-labelledby', tab.id);
  $('#preview-path').textContent = mode.path;
  $('#preview-status').textContent = mode.status;
  $('#preview-tool').textContent = mode.tool;
  $('#preview-prompt').textContent = mode.prompt;
  $('#preview-answer').textContent = mode.answer;
  const code = $('#preview-code'); code.replaceChildren();
  mode.code.forEach((line, index) => {
    const row = document.createElement('div'); const number = document.createElement('span'); const text = document.createElement('code');
    number.textContent = String(index + 1); number.setAttribute('aria-hidden', 'true'); text.textContent = line; row.append(number, text); code.append(row);
  });
  const result = $('#preview-result'); result.replaceChildren(); const dot = document.createElement('span'); dot.className = 'status-dot'; dot.setAttribute('aria-hidden', 'true'); result.append(dot, document.createTextNode(mode.result));
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectMode(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectMode(tabs[next], true); }
  });
});

// This catalog mirrors the desktop builder's curated choices. Selecting here
// explains a workflow; it never installs a generator or creates project files.
const frameworks = {
  react: { title: 'React', language: 'TypeScript / JavaScript', description: 'Start with the official Vite-powered React starter, or choose its React Compiler template.', templates: ['Standard React', 'React Compiler'], requirement: 'Installed Node.js 20.19+ or 22.12+ and npm. Generator and dependency steps can access the network.' },
  vue: { title: 'Vue', language: 'TypeScript / JavaScript', description: 'A Vue 3 starter powered by Vite, with your choice of TypeScript or JavaScript.', templates: ['Vue 3'], requirement: 'Installed Node.js 20.19+ or 22.12+ and npm. The wizard reviews generation and dependency installation separately.' },
  vite: { title: 'Vite', language: 'TypeScript / JavaScript', description: 'Choose the shape of your frontend, from a small vanilla app to a component framework.', templates: ['Vanilla', 'Preact', 'Svelte', 'Solid', 'Lit', 'Qwik'], requirement: 'Installed Node.js 20.19+ or 22.12+ and npm. Six starters in two languages give you 12 combinations.' },
  angular: { title: 'Angular', language: 'TypeScript', description: 'Generate an Angular application with routing and your choice of CSS or SCSS.', templates: ['CSS', 'SCSS'], requirement: 'The pinned creator requires Node.js 22.22.3+, 24.15+, or 26+, plus npm. Its version is checked before creation.' },
  next: { title: 'Next.js', language: 'TypeScript / JavaScript', description: 'Choose App Router or Pages Router, then decide whether to include Tailwind CSS.', templates: ['App Router', 'Pages Router'], requirement: 'Installed Node.js 20.9+ and npm. Generation skips dependency installation until you approve the separate install step.' },
  nest: { title: 'NestJS', language: 'TypeScript / JavaScript', description: 'Create a Node.js server using the official Nest starter in your preferred language.', templates: ['Standard server'], requirement: 'Installed Node.js 20.11+ and npm. The native task shows generator and dependency output.' },
  python: { title: 'Python', language: 'Python', description: 'Start with a CLI, API, web app or data app in a project-local virtual environment.', templates: ['Python CLI', 'FastAPI', 'Flask', 'Django', 'Streamlit'], requirement: 'Installed Python 3.10+. The wizard creates .venv and installs approved dependencies there; packages run with your user permissions.' },
  flutter: { title: 'Flutter', language: 'Dart', description: 'Create a starter app, empty app, reusable package or native plugin with your initialized Flutter SDK.', templates: ['Starter app', 'Empty app', 'Dart package', 'Native plugin'], requirement: 'Installed, initialized Flutter SDK. Generated platform folders still require their own SDKs and a supported host OS to build.', footnote: 'App templates can use Little: Flutter Preview. Packages and plugins use their own test or example-app workflows.' },
  expo: { title: 'React Native · Expo', language: 'Template-dependent JS / TS', description: 'Create a mobile project using official Expo templates, from a blank screen to routed tabs.', templates: ['Default with Expo Router', 'Blank app', 'Tabs and routing', 'Native directories'], requirement: 'Installed Node.js and npm, plus the runtime requirements of your selected Expo template. Native builds require platform tools; iOS simulators require macOS.', footnote: 'Five available template/language combinations. Use Expo Go, its project tasks, or a configured native target.' },
};
const frameworkTabs = [...document.querySelectorAll('.framework-tab')];
function selectFramework(tab, focus = false) {
  const framework = frameworks[tab.dataset.framework];
  if (!framework) return;
  frameworkTabs.forEach((item) => { const selected = item === tab; item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1; });
  $('#framework-panel').setAttribute('aria-labelledby', tab.id);
  $('#framework-title').textContent = framework.title;
  $('#framework-language').textContent = framework.language;
  $('#framework-description').textContent = framework.description;
  $('#framework-requirement').textContent = framework.requirement;
  $('#framework-footnote').textContent = framework.footnote || 'Use a new subfolder or an empty folder. Every generator and dependency command has its own native confirmation.';
  $('#framework-templates').replaceChildren(...framework.templates.map((label) => { const element = document.createElement('span'); element.textContent = label; return element; }));
  if (focus) tab.focus();
}
frameworkTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectFramework(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % frameworkTabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + frameworkTabs.length) % frameworkTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = frameworkTabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectFramework(frameworkTabs[next], true); }
  });
});

const captureDialog = $('#capture-dialog');
let captureTrigger;
document.querySelectorAll('[data-image]').forEach((button) => button.addEventListener('click', () => {
  captureTrigger = button;
  $('#capture-image').src = button.dataset.image;
  $('#capture-image').alt = button.dataset.caption;
  $('#capture-caption').textContent = button.dataset.caption;
  captureDialog.showModal();
}));
$('.dialog-close').addEventListener('click', () => captureDialog.close());
captureDialog.addEventListener('click', (event) => { if (event.target === captureDialog) { const rect = captureDialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) captureDialog.close(); } });
captureDialog.addEventListener('close', () => { $('#capture-image').removeAttribute('src'); captureTrigger?.focus(); });

const reducedMotion = window.matchMedia('(prefers-reduced-motion:reduce)');
if (!reducedMotion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('js-motion');
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); } }), { threshold: 0.04 });
  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
  reducedMotion.addEventListener('change', (event) => { if (event.matches) { document.documentElement.classList.remove('js-motion'); observer.disconnect(); } });
}

let expectedChecksum = $('#checksum-value').textContent.trim();
$('#copy-checksum').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(expectedChecksum); $('#copy-status').textContent = 'Checksum copied.'; }
  catch { $('#copy-status').textContent = 'Select and copy the checksum above.'; }
});
const platform = navigator.userAgentData?.platform || navigator.platform || '';
if (/Mac/i.test(platform)) $('#platform-note').textContent = 'You appear to be on macOS. This installer requires a Windows x64 PC.';
else if (/Linux|Android|iPhone|iPad/i.test(platform + ' ' + navigator.userAgent)) $('#platform-note').textContent = 'This is a Windows x64 desktop installer; transfer it to a compatible PC.';

async function fetchJson(url) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try { const response = await fetch(url, { signal: controller.signal, credentials: 'omit', headers: { Accept: 'application/json' } }); if (!response.ok) return { status: response.status }; return { status: response.status, data: await response.json() }; }
  finally { clearTimeout(timeout); }
}
function activateDownload(url, state) {
  const button = $('#download-setup'); button.href = url; button.removeAttribute('target'); button.setAttribute('download', '');
  $('#download-button-label').textContent = 'Download Windows setup'; $('#download-state').textContent = state;
}
async function configureDownload() {
  try {
    const result = await fetchJson('./release.json'); const config = result.data;
    if (!config || !/^[a-f0-9]{64}$/.test(config.sha256) || !Number.isSafeInteger(config.bytes) || !config.repository.startsWith('https://github.com/')) return;
    expectedChecksum = config.sha256; $('#checksum-value').textContent = config.sha256;
    document.querySelectorAll('[data-version]').forEach((element) => { element.textContent = config.version; });
    const [major, minor] = config.version.split('.').map(Number);
    if (major >= 1 || major === 0 && minor >= 3) {
      $('#build-release-status').textContent = 'NEW / VERSION ' + config.version;
      $('#build-availability').textContent = 'Framework builder, code runner and Flutter controls are included in the verified v' + config.version + ' Windows setup. Language runtimes and platform SDKs are installed separately.';
    }
    const button = $('#download-setup'); button.href = config.releasePage;
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
    if (loopback) {
      const local = (await fetchJson('/api/release')).data;
      if (local?.available === true && local.sha256 === config.sha256 && local.bytes === config.bytes && local.fileName === config.fileName && typeof local.downloadUrl === 'string' && local.downloadUrl.startsWith('/downloads/')) {
        activateDownload(local.downloadUrl, 'Local preview download · verified setup file, exact size and SHA-256.'); return;
      }
    }
    const release = await fetchJson(config.releaseApi);
    if (release.status === 404) { $('#download-state').textContent = 'The verified v' + config.version + ' setup is ready locally. Its public GitHub Release has not been published yet.'; return; }
    if (!release.data || release.data.draft === true || release.data.tag_name !== config.releaseTag) { $('#download-state').textContent = 'Release availability could not be confirmed. Check GitHub releases for the latest published setup.'; return; }
    const asset = release.data.assets?.find((value) => value.name === config.fileName && value.size === config.bytes && value.state === 'uploaded' && value.digest === 'sha256:' + config.sha256);
    if (!asset || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith(config.repository + '/releases/download/')) { $('#download-state').textContent = 'The matching verified installer is not yet available in this release. View GitHub releases for publication updates.'; return; }
    activateDownload(asset.browser_download_url, 'Published GitHub Release · asset name, size, and SHA-256 match the verified build.');
  } catch { $('#download-state').textContent = 'Release availability could not be checked. You can still visit GitHub releases; the checksum is shown below.'; }
}
configureDownload();
