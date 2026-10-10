import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const patchRoot = path.dirname(fileURLToPath(import.meta.url));
const pinnedCommit = '2a59476c9bfcb90b3ddc372c36762471b7dfad1c';
const nativeRoot = 'src/vs/workbench/contrib/little/browser';
// Only these exact checked-in predecessors may be migrated; local source edits stay protected.
const previousTemplateHashes = new Map([
  ['little.contribution.ts', new Set(['92ef0521e5c12bb8ee33610fd495fc9567558479f1c5bce9531caf0058c1abaa', '3122337512ffe55926d5fd71eacc3e8c3f9e1d31ed9090efd12840935eb754d8'])],
  ['little.css', new Set(['faf496582a2b2ec9ee44bd4b496f5c12a64017f645f5d24f2cbf0b30ce7bb9a1'])],
  ['little-chrome.css', new Set(['7790861205ae780f48807d3d62a26df7ec3f9dfe9b274cdf54db7b7e39a6a77d'])],
]);

const replacements = [
  {
    file: 'src/vs/workbench/services/chat/common/chatEntitlementService.ts',
    before: '\t\tif (!productService.defaultChatAgent) {\n\t\t\treturn; // we need a default chat agent configured going forward from here\n\t\t}',
    after: "\t\tif (!productService.defaultChatAgent) {\n\t\t\tif (productService.applicationName === 'little-code') {\n\t\t\t\t// A product without an upstream agent still honors the real AI visibility setting.\n\t\t\t\tconst hidden = ChatEntitlementContextKeys.Setup.hidden.bindTo(this.contextKeyService);\n\t\t\t\tconst updateHidden = () => hidden.set(this.forceHiddenWithoutAgent || this.configurationService.getValue<boolean>(ChatAIDisabledSettingId) === true);\n\t\t\t\tupdateHidden();\n\t\t\t\tthis._register(this.configurationService.onDidChangeConfiguration(event => {\n\t\t\t\t\tif (event.affectsConfiguration(ChatAIDisabledSettingId)) { updateHidden(); }\n\t\t\t\t}));\n\t\t\t}\n\t\t\treturn; // we need a default chat agent configured going forward from here\n\t\t}",
    previousBefore: "\t\tif (!productService.defaultChatAgent) {\n\t\t\tif (productService.applicationName === 'little-code') {\n\t\t\t\t// A product without an upstream agent still honors the real AI visibility setting.\n\t\t\t\tconst hidden = ChatEntitlementContextKeys.Setup.hidden.bindTo(this.contextKeyService);\n\t\t\t\tconst updateHidden = () => hidden.set(this.configurationService.getValue<boolean>(ChatAIDisabledSettingId) === true);\n\t\t\t\tupdateHidden();\n\t\t\t\tthis._register(this.configurationService.onDidChangeConfiguration(event => {\n\t\t\t\t\tif (event.affectsConfiguration(ChatAIDisabledSettingId)) { updateHidden(); }\n\t\t\t\t}));\n\t\t\t}\n\t\t\treturn; // we need a default chat agent configured going forward from here\n\t\t}",
  },
  {
    file: 'src/vs/workbench/services/chat/common/chatEntitlementService.ts',
    before: '\treadonly requests: Lazy<ChatEntitlementRequests> | undefined;\n\n\tconstructor(',
    after: '\treadonly requests: Lazy<ChatEntitlementRequests> | undefined;\n\tprivate forceHiddenWithoutAgent = false;\n\n\tconstructor(',
  },
  {
    file: 'src/vs/workbench/services/chat/common/chatEntitlementService.ts',
    before: '\t\t\t// No ChatEntitlementContext (e.g. no defaultChatAgent in product.json).\n\t\t\t// Set the context key directly as a fallback.\n\t\t\tChatEntitlementContextKeys.Setup.hidden.bindTo(this.contextKeyService).set(hidden);',
    after: "\t\t\t// No ChatEntitlementContext (e.g. no defaultChatAgent in product.json).\n\t\t\t// Preserve both account policy and Little's effective AI visibility configuration.\n\t\t\tthis.forceHiddenWithoutAgent = hidden;\n\t\t\tconst disabled = product.applicationName === 'little-code' && this.configurationService.getValue<boolean>(ChatAIDisabledSettingId) === true;\n\t\t\tChatEntitlementContextKeys.Setup.hidden.bindTo(this.contextKeyService).set(hidden || disabled);",
  },
  {
    file: 'src/vs/code/electron-browser/workbench/workbench.html',
    before: '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">',
    after: '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">\n\t\t<link rel="stylesheet" href="./little-chrome.css">',
  },
  {
    file: 'build/next/resources.ts',
    before: "\t'vs/code/electron-browser/workbench/workbench.html',",
    after: "\t'vs/code/electron-browser/workbench/workbench.html',\n\t'vs/code/electron-browser/workbench/little-chrome.css',",
  },
  {
    file: 'build/next/resources.ts',
    before: "\t'vs/code/electron-browser/workbench/little-chrome.css',",
    after: "\t'vs/code/electron-browser/workbench/little-chrome.css',\n\t// Little's native brand mark.\n\t'vs/workbench/contrib/little/browser/media/*.png',",
  },
  {
    file: 'build/lib/electron.ts',
    before: '\trepo: electronAssetResolver,',
    after: "\t// Use the pinned upstream checksum table for reproducible Little builds, including cached archives.\n\trepo: product.applicationName === 'little-code' && !electronFeed\n\t\t? async ({ url, fileName }: { url: string; fileName: string }): Promise<Response> => {\n\t\t\tif (fileName === 'SHASUMS256.txt') {\n\t\t\t\treturn new Response(fs.readFileSync(path.join(root, 'build', 'checksums', 'electron.txt'), 'utf8'), { status: 200 });\n\t\t\t}\n\t\t\treturn fetch(url, { signal: AbortSignal.timeout(60_000) });\n\t\t}\n\t\t: electronAssetResolver,",
  },
  {
    file: 'src/vs/workbench/services/accounts/browser/defaultAccount.ts',
    before: '\tprivate readonly defaultAccountConfig: IDefaultAccountConfig;\n\tprivate defaultAccountProvider:',
    after: '\tprivate readonly defaultAccountConfig: IDefaultAccountConfig | undefined;\n\tprivate defaultAccountProvider:',
  },
  {
    file: 'src/vs/workbench/services/accounts/browser/defaultAccount.ts',
    before: '\t\tthis.defaultAccountConfig = toDefaultAccountConfig(productService.defaultChatAgent);',
    after: '\t\tif (productService.defaultChatAgent) {\n\t\t\tthis.defaultAccountConfig = toDefaultAccountConfig(productService.defaultChatAgent);\n\t\t} else {\n\t\t\t// A standalone distribution may have no upstream account provider.\n\t\t\tthis.initBarrier.open();\n\t\t}',
  },
  {
    file: 'src/vs/workbench/services/accounts/browser/defaultAccount.ts',
    before: '\t\treturn {\n\t\t\t...this.defaultAccountConfig.authenticationProvider.default,\n\t\t\tenterprise: false\n\t\t};\n\t}\n\n\tsetDefaultAccountProvider',
    after: "\t\treturn {\n\t\t\t...(this.defaultAccountConfig?.authenticationProvider.default ?? { id: '', name: '' }),\n\t\t\tenterprise: false\n\t\t};\n\t}\n\n\tsetDefaultAccountProvider",
  },
  {
    file: 'src/vs/workbench/services/accounts/browser/defaultAccount.ts',
    before: '\t\tconst defaultAccountProvider = this._register(instantiationService.createInstance(DefaultAccountProvider, toDefaultAccountConfig(productService.defaultChatAgent)));',
    after: '\t\tif (!productService.defaultChatAgent) {\n\t\t\treturn;\n\t\t}\n\t\tconst defaultAccountProvider = this._register(instantiationService.createInstance(DefaultAccountProvider, toDefaultAccountConfig(productService.defaultChatAgent)));',
  },
  {
    file: 'src/vs/workbench/workbench.common.main.ts',
    before: "import './contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.js';",
    after: "// Little owns onboarding without Microsoft's default chat agent configuration.\nimport './contrib/little/browser/littleOnboarding.contribution.js';",
  },
  {
    file: 'build/gulpfile.vscode.ts',
    before: "\t\t\tif (quality === 'stable' || quality === 'insider') {\n\t\t\t\tresult = es.merge(result, gulp.src('.build/win32/appx/**', { base: '.build/win32' }));",
    after: "\t\t\tif ((quality === 'stable' || quality === 'insider') && product.applicationName !== 'little-code') {\n\t\t\t\t// Little's portable build does not ship Microsoft's Explorer shell DLL/AppX integration.\n\t\t\t\tresult = es.merge(result, gulp.src('.build/win32/appx/**', { base: '.build/win32' }));",
  },
  {
    // Imports must use the pinned API even when this checkout is nested below another Node project.
    file: 'extensions/tsconfig.base.json',
    before: '"compilerOptions": {\n\t\t"esModuleInterop": true,',
    after: '"compilerOptions": {\n\t\t"paths": {\n\t\t\t"vscode": ["../src/vscode-dts/vscode.d.ts"]\n\t\t},\n\t\t"esModuleInterop": true,',
  },
  {
    file: 'build/next/index.ts',
    before: "\t\t\tloader: {\n\t\t\t\t'.ttf': 'file',",
    after: "\t\t\tloader: {\n\t\t\t\t'.woff2': 'file', // Little's bundled Inter font.\n\t\t\t\t'.ttf': 'file',",
  },
  {
    file: 'build/npm/dirs.ts',
    before: "import { existsSync } from 'fs';",
    after: "import { existsSync, readFileSync } from 'fs';",
  },
  {
    file: 'build/npm/dirs.ts',
    before: "if (existsSync(`${import.meta.dirname}/../../.build/distro/npm`)) {",
    after: "// Install the local Little desktop and its native IDE extensions.\nconst littleDesktop = JSON.parse(readFileSync(new URL('../../product.json', import.meta.url), 'utf8')).applicationName === 'little-code';\nif (littleDesktop) {\n\tfor (let index = dirs.length - 1; index >= 0; index--) {\n\t\tconst directory = dirs[index];\n\t\tif (directory === 'extensions/copilot' || directory.startsWith('test/') || directory.startsWith('.vscode/extensions/') || /^extensions\\/vscode-(api-tests|colorize-tests|colorize-perf-tests|test-resolver)$/.test(directory)) {\n\t\t\tdirs.splice(index, 1);\n\t\t}\n\t}\n}\n\nif (existsSync(`${import.meta.dirname}/../../.build/distro/npm`)) {",
  },
  {
    file: `${nativeRoot}/little.css`,
    before: '/* Little uses native parts and theme colors. The editor remains the primary surface. */',
    after: "@import url('./media/fonts/fonts.css');\n\n/* Little uses native parts and theme colors. The editor remains the primary surface. */\n.little-code .monaco-workbench {\n\tfont-family: Inter, 'Segoe UI', sans-serif;\n}\n",
    optional: true,
  },
  {
    file: 'build/lib/extensions.ts',
    before: "export function packageCopilotExtensionStream(): Stream {\n\tconst extensionPath = path.join(root, 'extensions', 'copilot');",
    after: "export function packageCopilotExtensionStream(): Stream {\n\t// Little Code ships its own Groq agent instead of the upstream Copilot plugin.\n\tif (productJson.applicationName === 'little-code') {\n\t\treturn es.readArray([]);\n\t}\n\tconst extensionPath = path.join(root, 'extensions', 'copilot');",
  },
  {
    file: 'build/gulpfile.vscode.ts',
    before: "\t\tconst extensions = gulp.src(['.build/extensions/**', ...platformSpecificBuiltInExtensionsExclusions], { base: '.build', dot: true });",
    after: "\t\tconst littleExtensionExclusions = product.applicationName === 'little-code' ? ['!.build/extensions/copilot/**'] : [];\n\t\tconst extensions = gulp.src(['.build/extensions/**', ...platformSpecificBuiltInExtensionsExclusions, ...littleExtensionExclusions], { base: '.build', dot: true });",
  },
  {
    file: 'build/gulpfile.vscode.ts',
    before: "function prepareCopilotRipgrepShimTask(platform: string, arch: string, destinationFolderName: string) {\n\tconst outputDir = path.join(path.dirname(root), destinationFolderName);\n\n\treturn async () => {\n\t\t// On Windows with win32VersionedUpdate, app resources live under a",
    after: "function prepareCopilotRipgrepShimTask(platform: string, arch: string, destinationFolderName: string) {\n\tconst outputDir = path.join(path.dirname(root), destinationFolderName);\n\n\treturn async () => {\n\t\tif (product.applicationName === 'little-code') {\n\t\t\treturn; // Little does not package the upstream Copilot plugin.\n\t\t}\n\t\t// On Windows with win32VersionedUpdate, app resources live under a",
  },
  {
    file: 'src/vs/workbench/workbench.common.main.ts',
    before: "// Opener\nimport './contrib/opener/browser/opener.contribution.js';",
    after: "// Opener\nimport './contrib/opener/browser/opener.contribution.js';\n\n// Little Code native workbench integration\nimport './contrib/little/browser/little.contribution.js';",
  },
  {
    file: 'src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts',
    before: '\tprivate async run() {\n\n\t\t// Wait for resolving startup editor',
    after: "\tprivate async run() {\n\n\t\t// Little's bundled home owns onboarding; restored editors remain native.\n\t\tif (this.productService.applicationName === 'little-code') {\n\t\t\treturn;\n\t\t}\n\n\t\t// Wait for resolving startup editor",
  },
  {
    file: 'src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts',
    before: '\tprivate tryShowOnboarding(): void {\n\t\tif (this.environmentService.skipWelcome)',
    after: "\tprivate tryShowOnboarding(): void {\n\t\tif (this.productService.applicationName === 'little-code') {\n\t\t\treturn;\n\t\t}\n\t\tif (this.environmentService.skipWelcome)",
  },
  {
    file: 'src/vs/workbench/browser/parts/titlebar/commandCenterControl.ts',
    before: "\t\t\t\t\t\t\tif (!label) {\n\t\t\t\t\t\t\t\tlabel = localize('label.dfl', \"Search\");\n\t\t\t\t\t\t\t}",
    after: "\t\t\t\t\t\t\tif (!label) {\n\t\t\t\t\t\t\t\tlabel = localize('little.commandCenter', \"Little Code\");\n\t\t\t\t\t\t\t} else if (!that._windowTitle.isCustomTitleFormat()) {\n\t\t\t\t\t\t\t\tlabel = localize('little.commandCenterWorkspace', \"Little Code · {0}\", label);\n\t\t\t\t\t\t\t}",
  },
];

/** Rejects source drift before writing any upstream file; running it twice is safe. */
export async function applyLittleWorkbenchPatch(upstream, { checkOnly = false } = {}) {
  const resolvedUpstream = path.resolve(upstream);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolvedUpstream, encoding: 'utf8', shell: false });
  if (revision.error) throw revision.error;
  if (revision.status !== 0 || revision.stdout.trim() !== pinnedCommit) {
    throw new Error('Little native integration requires the pinned Code-OSS 1.141.0 checkout. Existing source was preserved.');
  }
  const planned = new Map();
  for (const replacement of replacements) {
    const fullPath = path.join(resolvedUpstream, replacement.file);
    let current = planned.get(fullPath)?.content;
    if (current === undefined) {
      try { current = (await readFile(fullPath, 'utf8')).replaceAll('\r\n', '\n'); }
      catch (error) { if (replacement.optional && error.code === 'ENOENT') continue; throw error; }
    }
    if (current.includes(replacement.after)) {
      planned.set(fullPath, { content: current, changed: planned.get(fullPath)?.changed ?? false });
      continue;
    }
    const anchor = [replacement.before, replacement.previousBefore].filter(Boolean).find(candidate => current.split(candidate).length === 2);
    if (!anchor) {
      throw new Error(`Native patch anchor changed in ${replacement.file}. Existing source was preserved.`);
    }
    planned.set(fullPath, { content: current.replace(anchor, replacement.after), changed: true });
  }
  const templates = ['little.contribution.ts', 'littleOnboarding.contribution.ts', 'little.css'].map(file => ({file, target: `${nativeRoot}/${file}`}));
  templates.push({file: 'little-chrome.css', target: 'src/vs/code/electron-browser/workbench/little-chrome.css'});
  for (const {file, target} of templates) {
    const fullPath = path.join(resolvedUpstream, target);
    const content = (await readFile(path.join(patchRoot, 'native', file), 'utf8')).replaceAll('\r\n', '\n');
    let existing;
    try { existing = planned.get(fullPath)?.content ?? (await readFile(fullPath, 'utf8')).replaceAll('\r\n', '\n'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing !== undefined && existing !== content && !previousTemplateHashes.get(file)?.has(createHash('sha256').update(existing).digest('hex'))) {
      throw new Error(`Existing native Little source differs: ${target}. Existing source was preserved.`);
    }
    planned.set(fullPath, { content, changed: (planned.get(fullPath)?.changed ?? false) || existing !== content });
  }
  const changed = [...planned].filter(([, value]) => value.changed);
  if (!checkOnly) {
    for (const [file, value] of changed) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, value.content, 'utf8');
    }
  }
  return { files: [...planned.keys()].map(file => path.relative(resolvedUpstream, file).replaceAll('\\', '/')), changed: changed.length, checkOnly };
}
