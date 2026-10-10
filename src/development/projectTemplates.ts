import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

export type ProjectLanguage = 'typescript' | 'javascript' | 'python' | 'dart';
export type ProjectFrameworkId = 'react' | 'vue' | 'vite' | 'angular' | 'next' | 'nest' | 'python' | 'flutter' | 'react-native';
export interface ProjectTemplate { readonly id: string; readonly label: string; readonly languages: readonly ProjectLanguage[]; readonly description: string }
export interface ProjectFramework { readonly id: ProjectFrameworkId; readonly label: string; readonly description: string; readonly documentation: string; readonly templates: readonly ProjectTemplate[] }
const webLanguages: readonly ProjectLanguage[] = ['typescript', 'javascript'];
const template = (id: string, label: string, languages: readonly ProjectLanguage[], description: string): ProjectTemplate => Object.freeze({ id, label, languages: Object.freeze([...languages]), description });

/** Curated official templates. Creator versions were checked against the npm registry on 2026-10-10. */
export const PROJECT_CREATORS = Object.freeze({ vite: 'create-vite@9.2.1', next: 'create-next-app@16.4.0', angular: '@angular/cli@22.2.2', nest: '@nestjs/cli@12.0.8', expo: 'create-expo-app@5.0.0' });
export const PROJECT_FRAMEWORKS: readonly ProjectFramework[] = Object.freeze([
  { id: 'react', label: 'React', description: 'Vite-powered component app', documentation: 'https://vite.dev/guide/', templates: [template('standard', 'Standard React', webLanguages, 'Official React starter'), template('compiler', 'React Compiler', webLanguages, 'Official React Compiler starter')] },
  { id: 'vue', label: 'Vue', description: 'Vue 3 with Vite', documentation: 'https://vite.dev/guide/', templates: [template('standard', 'Vue 3', webLanguages, 'Official Vue starter')] },
  { id: 'vite', label: 'Vite', description: 'Vanilla, Preact, Svelte, Solid, Lit, or Qwik', documentation: 'https://vite.dev/guide/', templates: ['vanilla', 'preact', 'svelte', 'solid', 'lit', 'qwik'].map(id => template(id, id[0]!.toUpperCase() + id.slice(1), webLanguages, `Official ${id} starter`)) },
  { id: 'angular', label: 'Angular', description: 'TypeScript app with routing', documentation: 'https://angular.dev/cli/new', templates: [template('css', 'CSS', ['typescript'], 'Standard Angular styles'), template('scss', 'SCSS', ['typescript'], 'Sass styles')] },
  { id: 'next', label: 'Next.js', description: 'Full-stack React app', documentation: 'https://nextjs.org/docs/app/api-reference/cli/create-next-app', templates: [template('app', 'App Router', webLanguages, 'Next.js App Router'), template('pages', 'Pages Router', webLanguages, 'Next.js Pages Router')] },
  { id: 'nest', label: 'NestJS', description: 'Node.js server app', documentation: 'https://docs.nestjs.com/cli/usages', templates: [template('standard', 'Standard server', webLanguages, 'Official Nest starter')] },
  { id: 'python', label: 'Python', description: 'CLI, FastAPI, Flask, Django, or Streamlit', documentation: 'https://docs.python.org/3/library/venv.html', templates: [template('cli', 'Python CLI', ['python'], 'Small script with a private virtual environment'), template('fastapi', 'FastAPI', ['python'], 'Typed HTTP API'), template('flask', 'Flask', ['python'], 'Minimal web app'), template('django', 'Django', ['python'], 'Official Django project generator'), template('streamlit', 'Streamlit', ['python'], 'Interactive data app')] },
  { id: 'flutter', label: 'Flutter', description: 'Dart app, package, or plugin', documentation: 'https://docs.flutter.dev/reference/create-new-app', templates: [template('app', 'Starter app', ['dart'], 'Flutter counter app'), template('empty', 'Empty app', ['dart'], 'Minimal Flutter app'), template('package', 'Dart package', ['dart'], 'Reusable Flutter package'), template('plugin', 'Native plugin', ['dart'], 'Flutter plugin with platform implementations')] },
  { id: 'react-native', label: 'React Native · Expo', description: 'Mobile app with official Expo templates', documentation: 'https://docs.expo.dev/more/create-expo/', templates: [template('default', 'Default with Expo Router', ['typescript'], 'Multi-screen mobile app'), template('blank', 'Blank app', webLanguages, 'Minimal mobile app'), template('tabs', 'Tabs and routing', ['typescript'], 'File-based tab navigation'), template('bare-minimum', 'Native directories', ['javascript'], 'Generates Android and iOS native projects; platform toolchains are required')] },
].map(framework => Object.freeze({ ...framework, templates: Object.freeze(framework.templates) })) as ProjectFramework[]);

export interface ProjectOptions {
  readonly frameworkId: ProjectFrameworkId; readonly templateId: string; readonly language: ProjectLanguage;
  readonly name: string; readonly tailwind?: boolean; readonly flutterPlatforms?: readonly string[];
}
export interface ScaffoldStep { readonly id: string; readonly label: string; readonly program: 'npm' | 'python' | 'venv-python' | 'flutter'; readonly args: readonly string[]; readonly network: boolean; readonly purpose: string }
export interface StarterFile { readonly path: string; readonly content: string }
export interface ProjectPlan { readonly options: ProjectOptions; readonly framework: ProjectFramework; readonly steps: readonly ScaffoldStep[]; readonly files: readonly StarterFile[]; readonly next: readonly string[] }
const reservedWindows = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const pythonReserved = new Set(['django', 'test', 'flask', 'fastapi', 'streamlit', 'typing', 'venv', 'sys', 'os', 'keyword', 'python', 'class', 'def', 'import', 'from', 'for', 'while', 'if', 'else', 'elif', 'try', 'except', 'finally', 'with', 'as', 'return', 'yield', 'async', 'await', 'lambda', 'pass', 'raise', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'true', 'false', 'none']);
const dartReserved = new Set(['flutter', 'dart', 'class', 'enum', 'extension', 'import', 'library', 'part', 'void', 'var', 'final', 'const', 'return', 'this', 'super', 'if', 'else', 'switch', 'case', 'for', 'while', 'do', 'try', 'catch', 'throw', 'new', 'true', 'false', 'null']);
export function validateProjectName(name: string, frameworkId: ProjectFrameworkId): string | undefined {
  if (typeof name !== 'string' || name.length < 1 || name.length > 60 || reservedWindows.test(name)) return 'Use a project name of 1–60 characters; reserved device names are unavailable.';
  const identifier = frameworkId === 'python' || frameworkId === 'flutter';
  if (!(identifier ? /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/ : /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).test(name)) return identifier ? 'Use lowercase letters, digits, and underscores, starting with a letter.' : 'Use lowercase letters, digits, and hyphens, starting with a letter.';
  if (frameworkId === 'python' && pythonReserved.has(name)) return 'Choose a name that does not shadow Python or the selected framework.';
  if (frameworkId === 'flutter' && dartReserved.has(name)) return 'Choose a Dart package name that is not a reserved keyword or SDK name.';
  return undefined;
}

const step = (id: string, label: string, program: ScaffoldStep['program'], args: string[], network: boolean, purpose: string): ScaffoldStep => Object.freeze({ id, label, program, args: Object.freeze(args), network, purpose });
const npmCreator = (creator: string, command: string, args: string[]): ScaffoldStep => step('scaffold', 'Generate project', 'npm', ['exec', '--yes', `--package=${creator}`, '--prefix=.', '--workspaces=false', '--global=false', '--', command, ...args], true, 'Download the pinned official creator into npm’s cache and run it to generate this project.');

export function createProjectPlan(input: ProjectOptions): ProjectPlan {
  const framework = PROJECT_FRAMEWORKS.find(candidate => candidate.id === input.frameworkId);
  const chosen = framework?.templates.find(candidate => candidate.id === input.templateId);
  if (!framework || !chosen || !chosen.languages.includes(input.language)) throw new Error('This framework, template, and language combination is unavailable.');
  const nameError = validateProjectName(input.name, input.frameworkId); if (nameError) throw new Error(nameError);
  if (input.tailwind !== undefined && (typeof input.tailwind !== 'boolean' || input.frameworkId !== 'next')) throw new Error('Tailwind is available only as a Next.js option.');
  const allowedPlatforms = ['android', 'ios', 'web', 'windows', 'macos', 'linux'];
  if (input.flutterPlatforms !== undefined && (input.frameworkId !== 'flutter' || !Array.isArray(input.flutterPlatforms) || !input.flutterPlatforms.length || new Set(input.flutterPlatforms).size !== input.flutterPlatforms.length || input.flutterPlatforms.some(platform => !allowedPlatforms.includes(platform)))) throw new Error('Choose supported, distinct Flutter platforms.');
  const options = Object.freeze({ frameworkId: input.frameworkId, templateId: input.templateId, language: input.language, name: input.name, ...(input.tailwind !== undefined ? { tailwind: input.tailwind } : {}), ...(input.flutterPlatforms ? { flutterPlatforms: Object.freeze([...input.flutterPlatforms]) } : {}) });
  const steps: ScaffoldStep[] = []; const files: StarterFile[] = []; const next: string[] = [];
  const suffix = input.language === 'typescript' ? '-ts' : '';
  if (input.frameworkId === 'react' || input.frameworkId === 'vue' || input.frameworkId === 'vite') {
    const preset = input.frameworkId === 'react' ? `react${input.templateId === 'compiler' ? '-compiler' : ''}` : input.frameworkId === 'vue' ? 'vue' : input.templateId;
    steps.push(npmCreator(PROJECT_CREATORS.vite, 'create-vite', ['.', '--template', preset + suffix, '--no-interactive'])); next.push('npm run dev');
  } else if (input.frameworkId === 'next') {
    steps.push(npmCreator(PROJECT_CREATORS.next, 'create-next-app', ['.', '--yes', '--use-npm', '--skip-install', '--disable-git', input.language === 'typescript' ? '--typescript' : '--javascript', input.templateId === 'app' ? '--app' : '--no-app', '--src-dir', '--import-alias', '@/*', '--eslint', input.tailwind ? '--tailwind' : '--no-tailwind', '--no-react-compiler'])); next.push('npm run dev');
  } else if (input.frameworkId === 'angular') {
    steps.push(npmCreator(PROJECT_CREATORS.angular, 'ng', ['new', input.name, '--directory', '.', '--defaults', '--routing', '--style', input.templateId, '--package-manager', 'npm', '--skip-git', '--skip-install'])); next.push('npm start');
  } else if (input.frameworkId === 'nest') {
    steps.push(npmCreator(PROJECT_CREATORS.nest, 'nest', ['new', input.name, '--directory', '.', '--language', input.language === 'typescript' ? 'TS' : 'JS', '--package-manager', 'npm', '--skip-git', '--skip-install', '--no-observe'])); next.push('npm run start:dev');
  } else if (input.frameworkId === 'react-native') {
    const preset = input.templateId === 'blank' && input.language === 'typescript' ? 'blank-typescript' : input.templateId;
    steps.push(npmCreator(PROJECT_CREATORS.expo, 'create-expo-app', ['.', '--yes', '--no-install', '--no-agents-md', '--template', preset])); next.push('npx expo start', 'Use Expo Go or a configured Android emulator; iOS simulators require macOS.');
  } else if (input.frameworkId === 'flutter') {
    const flutterTemplate = input.templateId === 'empty' ? 'app' : input.templateId;
    const platforms = input.flutterPlatforms ?? ['android', 'ios', 'web'];
    const args = ['create', '.', '--project-name', input.name, '--template', flutterTemplate, '--no-pub'];
    if (input.templateId === 'empty') args.push('--empty');
    if (flutterTemplate !== 'package') args.push('--platforms', platforms.join(','));
    steps.push(step('scaffold', 'Generate Flutter project', 'flutter', args, false, 'Use the installed, initialized Flutter SDK to generate project files without fetching packages.'));
    steps.push(step('dependencies', 'Fetch Flutter packages', 'flutter', ['pub', 'get'], true, 'Fetch project dependencies into the Flutter/Dart package cache.'));
    next.push(flutterTemplate === 'app' ? 'Little: Preview Flutter App' : 'flutter test');
  } else {
    steps.push(step('environment', 'Create private Python environment', 'python', ['-I', '-m', 'venv', '.venv'], false, 'Create a project-local Python virtual environment; no global Python packages are changed.'));
    const packages: Record<string, string> = { fastapi: 'fastapi[standard]', flask: 'Flask', django: 'Django', streamlit: 'streamlit' };
    const dependency = packages[input.templateId];
    if (dependency) {
      files.push({ path: 'requirements.txt', content: dependency + '\n' });
      steps.push(step('dependencies', 'Install Python project dependencies', 'venv-python', ['-I', '-m', 'pip', 'install', '--isolated', '--require-virtualenv', '-r', 'requirements.txt'], true, 'Install packages only into this project’s .venv, ignoring inherited pip configuration. Downloaded packages run with your operating-system permissions.'));
    }
    if (input.templateId === 'django') {
      steps.push(step('scaffold', 'Generate Django project', 'venv-python', ['-m', 'django', 'startproject', input.name, '.'], false, 'Generate the official Django project inside this folder.')); next.push('.venv Python: manage.py runserver');
    } else if (input.templateId === 'fastapi') {
      files.push({ path: 'main.py', content: 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef hello():\n    return {"message": "Built with Little Code"}\n' }); next.push('.venv Python: -m fastapi dev main.py');
    } else if (input.templateId === 'flask') {
      files.push({ path: 'app.py', content: 'from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef hello():\n    return "Built with Little Code"\n' }); next.push('.venv Python: -m flask --app app run --debug');
    } else if (input.templateId === 'streamlit') {
      files.push({ path: 'app.py', content: 'import streamlit as st\n\nst.title("Built with Little Code")\nst.write("Your next idea starts here.")\n' }); next.push('.venv Python: -m streamlit run app.py');
    } else {
      files.push({ path: 'main.py', content: 'def main():\n    print("Built with Little Code")\n\n\nif __name__ == "__main__":\n    main()\n' }); next.push('Little: Run Current File · main.py');
    }
    files.push({ path: '.gitignore', content: '.venv/\n__pycache__/\n*.py[cod]\n.env\n' }, { path: 'README.md', content: `# ${input.name}\n\nCreated with Little Code’s ${chosen.label} starter.\n\nThe wizard installs dependencies into a private \`.venv\`. Use its Python interpreter to run this project.\n\nDocumentation: ${framework.documentation}\n` });
  }
  if (!['python', 'flutter'].includes(input.frameworkId)) steps.push(step('dependencies', 'Install project dependencies', 'npm', ['install', '--prefix=.', '--workspaces=false', '--global=false', '--no-audit', '--no-fund'], true, 'Download this project’s dependencies and run any package installation scripts. No global npm packages are installed.'));
  return Object.freeze({ options, framework, steps: Object.freeze(steps), files: Object.freeze(files.map(file => Object.freeze(file))), next: Object.freeze(next) });
}

interface DirectoryIdentity { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
export interface ProjectDestination { readonly root: string; readonly parent: string; readonly target: string; readonly mode: 'new' | 'empty'; readonly rootIdentity: DirectoryIdentity; readonly parentIdentity: DirectoryIdentity; readonly targetIdentity?: DirectoryIdentity }
const identity = (stat: { dev: number; ino: number; birthtimeMs: number }): DirectoryIdentity => Object.freeze({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
const sameIdentity = (stat: { dev: number; ino: number; birthtimeMs: number }, previous: DirectoryIdentity): boolean => stat.dev === previous.dev && stat.ino === previous.ino && stat.birthtimeMs === previous.birthtimeMs;
function within(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
async function regularDirectory(absolute: string): Promise<Stats> {
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Project folders must be real local directories, without symbolic links or junctions.');
  return stat;
}
async function checkedParent(rootInput: string, parentInput: string): Promise<{ root: string; parent: string; rootIdentity: DirectoryIdentity; parentIdentity: DirectoryIdentity }> {
  if (!path.isAbsolute(rootInput) || !path.isAbsolute(parentInput)) throw new Error('Choose an absolute local project folder.');
  const root = path.resolve(rootInput), parent = path.resolve(parentInput);
  if (!within(root, parent)) throw new Error('Choose a folder inside the trusted workspace.');
  const rootStat = await regularDirectory(root);
  const rootReal = await fs.realpath(root);
  let current = root;
  for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) { current = path.join(current, segment); await regularDirectory(current); }
  const parentReal = await fs.realpath(parent);
  if (!within(rootReal, parentReal)) throw new Error('The selected folder resolves outside the trusted workspace.');
  return { root, parent, rootIdentity: identity(rootStat), parentIdentity: identity(await regularDirectory(parent)) };
}
/** Both a new child and an explicitly selected empty folder are rechecked before creation or process launch. */
export async function inspectProjectDestination(root: string, parent: string, name: string, mode: 'new' | 'empty' = 'new'): Promise<ProjectDestination> {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(name) || name.length > 60 || reservedWindows.test(name)) throw new Error('Use a safe project name, without separators or options.');
  if (mode !== 'new' && mode !== 'empty') throw new Error('Choose a new child folder or an empty selected folder.');
  const checked = await checkedParent(root, parent);
  const target = mode === 'new' ? path.join(checked.parent, name) : checked.parent;
  if (mode === 'empty') {
    if ((await fs.readdir(target)).length) throw new Error('This folder is not empty. Create a named child folder instead.');
    return Object.freeze({ ...checked, target, mode, targetIdentity: checked.parentIdentity });
  }
  try { await fs.lstat(target); throw new Error('That project folder already exists. Choose another name; existing files are never overwritten.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return Object.freeze({ ...checked, target, mode });
}
export async function recheckProjectDestination(destination: ProjectDestination, targetIdentity?: DirectoryIdentity, requireEmpty = false): Promise<void> {
  const current = await checkedParent(destination.root, destination.parent);
  if (!sameIdentity(current.rootIdentity, destination.rootIdentity) || !sameIdentity(current.parentIdentity, destination.parentIdentity)) throw new Error('The workspace or selected folder changed. Restart the project wizard.');
  const expected = targetIdentity ?? destination.targetIdentity;
  if (expected) {
    const stat = await regularDirectory(destination.target);
    if (!sameIdentity(stat, expected)) throw new Error('The project folder changed. Restart the project wizard.');
    if (requireEmpty && (await fs.readdir(destination.target)).length) throw new Error('The project folder is no longer empty. Existing files will not be overwritten.');
  } else {
    try { await fs.lstat(destination.target); throw new Error('That project folder now exists. Existing files will not be overwritten.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export async function prepareProjectDestination(destination: ProjectDestination): Promise<DirectoryIdentity> {
  await recheckProjectDestination(destination, undefined, true);
  if (destination.mode === 'new') await fs.mkdir(destination.target, { recursive: false });
  const stat = await regularDirectory(destination.target);
  return identity(stat);
}
export async function writeStarterFiles(destination: ProjectDestination, targetIdentity: DirectoryIdentity, files: readonly StarterFile[]): Promise<void> {
  await recheckProjectDestination(destination, targetIdentity);
  for (const file of files) {
    if (!/^(?:requirements\.txt|main\.py|app\.py|README\.md|\.gitignore)$/.test(file.path)) throw new Error('This starter file is outside the curated template.');
    await recheckProjectDestination(destination, targetIdentity);
    await fs.writeFile(path.join(destination.target, file.path), file.content, { flag: 'wx', encoding: 'utf8' });
  }
}

export interface ProjectPythonEnvironment { readonly executable: string; readonly configuration: string; recheck(): Promise<void> }
/** Preserve the virtualenv launch path: resolving a POSIX python symlink before launch would lose its environment. */
export async function inspectProjectPythonEnvironment(project: string, platform: NodeJS.Platform = process.platform): Promise<ProjectPythonEnvironment> {
  const directory = path.join(project, '.venv');
  const bin = path.join(directory, platform === 'win32' ? 'Scripts' : 'bin');
  const configuration = path.join(directory, 'pyvenv.cfg');
  const executable = path.join(bin, platform === 'win32' ? 'python.exe' : 'python');
  const directoryIdentity = identity(await regularDirectory(directory)); const binIdentity = identity(await regularDirectory(bin));
  const configStat = await fs.lstat(configuration);
  if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error('The project virtual environment configuration is unavailable or linked outside the project.');
  if (!(await fs.stat(executable)).isFile()) throw new Error('The project virtual environment Python is unavailable.');
  const realExecutable = await fs.realpath(executable);
  return Object.freeze({ executable, configuration, async recheck() {
    if (!sameIdentity(await regularDirectory(directory), directoryIdentity) || !sameIdentity(await regularDirectory(bin), binIdentity)) throw new Error('The project virtual environment changed. Restart the project wizard.');
    const currentConfig = await fs.lstat(configuration);
    if (!currentConfig.isFile() || currentConfig.isSymbolicLink() || currentConfig.dev !== configStat.dev || currentConfig.ino !== configStat.ino || currentConfig.size !== configStat.size || currentConfig.mtimeMs !== configStat.mtimeMs || await fs.realpath(executable) !== realExecutable) throw new Error('The project virtual environment changed. Restart the project wizard.');
  } });
}
