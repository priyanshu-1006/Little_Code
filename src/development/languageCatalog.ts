import { access, lstat, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export interface LanguageDefinition {
  id: string;
  label: string;
  languageIds: readonly string[];
  extensions: readonly string[];
  runtime: string;
  candidates: readonly string[];
  kind: 'script' | 'c' | 'cpp' | 'rust' | 'swift' | 'kotlin';
  documentation: string;
  note?: string;
}

/** This is a single-file runner, not a replacement for framework build systems. */
export const LANGUAGE_CATALOG: readonly LanguageDefinition[] = [
  { id: 'javascript', label: 'JavaScript', languageIds: ['javascript'], extensions: ['.js', '.mjs', '.cjs'], runtime: 'node', candidates: ['node'], kind: 'script', documentation: 'https://nodejs.org/en/download' },
  { id: 'typescript', label: 'TypeScript', languageIds: ['typescript'], extensions: ['.ts', '.mts', '.cts'], runtime: 'node', candidates: ['node'], kind: 'script', documentation: 'https://nodejs.org/en/learn/typescript/run-natively', note: 'Requires Node.js 22.18 or later. Native type stripping does not type-check, read tsconfig paths, or support JSX and syntax that requires transformation. Use your project build task for those files.' },
  { id: 'python', label: 'Python', languageIds: ['python'], extensions: ['.py'], runtime: 'python', candidates: ['python3', 'python', 'py'], kind: 'script', documentation: 'https://www.python.org/downloads/', note: 'An application-level Python override takes priority; otherwise the nearest project .venv is preferred before PATH/launcher discovery. Configure your interpreter when another environment is needed.' },
  { id: 'c', label: 'C', languageIds: ['c'], extensions: ['.c'], runtime: 'gcc', candidates: ['gcc', 'clang'], kind: 'c', documentation: 'https://www.msys2.org/', note: 'Compiles one source file. MSYS2 UCRT64 GCC/MinGW or Clang is required on Windows; multi-file projects should use their build task.' },
  { id: 'cpp', label: 'C++', languageIds: ['cpp'], extensions: ['.cpp', '.cc', '.cxx', '.c++'], runtime: 'g++', candidates: ['g++', 'clang++'], kind: 'cpp', documentation: 'https://www.msys2.org/', note: 'Compiles one C++17 source file, with output in Little Code private storage.' },
  { id: 'java', label: 'Java', languageIds: ['java'], extensions: ['.java'], runtime: 'java', candidates: ['java'], kind: 'script', documentation: 'https://dev.java/learn/launching-single-file-source-code-programs/', note: 'Requires a JDK 11 or later with source-file launch support. The launcher compiles before running.' },
  { id: 'csharp', label: 'C#', languageIds: ['csharp'], extensions: ['.cs'], runtime: 'dotnet', candidates: ['dotnet'], kind: 'script', documentation: 'https://learn.microsoft.com/dotnet/core/sdk/file-based-apps', note: 'Requires the .NET 10 SDK or later for file-based apps. SDK directives may restore packages or execute project build targets; build output is redirected to private storage.' },
  { id: 'go', label: 'Go', languageIds: ['go'], extensions: ['.go'], runtime: 'go', candidates: ['go'], kind: 'script', documentation: 'https://go.dev/doc/install', note: 'go build compiles the active file into private storage before execution. Module dependencies may be downloaded into the Go cache.' },
  { id: 'rust', label: 'Rust', languageIds: ['rust'], extensions: ['.rs'], runtime: 'rustc', candidates: ['rustc'], kind: 'rust', documentation: 'https://www.rust-lang.org/tools/install', note: 'Standalone rustc compilation; Cargo dependencies/build scripts require your Cargo project task.' },
  { id: 'ruby', label: 'Ruby', languageIds: ['ruby'], extensions: ['.rb'], runtime: 'ruby', candidates: ['ruby'], kind: 'script', documentation: 'https://www.ruby-lang.org/en/documentation/installation/' },
  { id: 'php', label: 'PHP', languageIds: ['php'], extensions: ['.php'], runtime: 'php', candidates: ['php'], kind: 'script', documentation: 'https://www.php.net/manual/en/install.php' },
  { id: 'dart', label: 'Dart', languageIds: ['dart'], extensions: ['.dart'], runtime: 'dart', candidates: ['dart'], kind: 'script', documentation: 'https://dart.dev/get-dart', note: 'Standalone Dart CLI file. Flutter applications use the mobile preview workflow.' },
  { id: 'powershell', label: 'PowerShell', languageIds: ['powershell'], extensions: ['.ps1'], runtime: 'pwsh', candidates: ['pwsh', 'powershell'], kind: 'script', documentation: 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell', note: 'Runs a file without bypassing your execution policy.' },
  { id: 'shell', label: 'Shell script', languageIds: ['shellscript'], extensions: ['.sh', '.bash'], runtime: 'bash', candidates: ['bash'], kind: 'script', documentation: 'https://www.gnu.org/software/bash/manual/', note: 'Requires Bash, such as Git Bash/MSYS2 on Windows. Your file is passed as an argument; no command string is constructed.' },
  { id: 'lua', label: 'Lua', languageIds: ['lua'], extensions: ['.lua'], runtime: 'lua', candidates: ['lua', 'lua54', 'lua53'], kind: 'script', documentation: 'https://www.lua.org/download.html' },
  { id: 'perl', label: 'Perl', languageIds: ['perl'], extensions: ['.pl'], runtime: 'perl', candidates: ['perl'], kind: 'script', documentation: 'https://www.perl.org/get.html' },
  { id: 'r', label: 'R', languageIds: ['r'], extensions: ['.r'], runtime: 'Rscript', candidates: ['Rscript'], kind: 'script', documentation: 'https://cran.r-project.org/' },
  { id: 'swift', label: 'Swift', languageIds: ['swift'], extensions: ['.swift'], runtime: 'swiftc', candidates: ['swiftc'], kind: 'swift', documentation: 'https://www.swift.org/install/', note: 'Compiles one source file with the installed Swift SDK.' },
  { id: 'kotlin', label: 'Kotlin script', languageIds: ['kotlin'], extensions: ['.kts'], runtime: 'kotlinc', candidates: ['kotlinc'], kind: 'kotlin', documentation: 'https://kotlinlang.org/docs/command-line.html', note: 'Supports .kts scripts. Native executable Kotlin compilers only; Windows batch shims require a project task or custom native launcher.' },
];

export function selectLanguage(languageId: string, file: string): LanguageDefinition | undefined {
  const extension = path.extname(file).toLowerCase();
  // JSX is framework source rather than an executable Node.js script.
  if (['.tsx', '.jsx'].includes(extension)) return undefined;
  return LANGUAGE_CATALOG.find(language => language.extensions.includes(extension))
    ?? LANGUAGE_CATALOG.find(language => language.languageIds.includes(languageId));
}

export interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  overrides?: Record<string, string>;
  exists?: (file: string) => Promise<boolean>;
}

/** Prefer an explicitly created project environment without resolving its Python symlink. */
export async function discoverProjectPython(file: string, workspace: string): Promise<string | undefined> {
  let directory = path.dirname(file);
  while (true) {
    const relative = path.relative(workspace, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const environment = path.join(directory, '.venv');
    try {
      const root = await lstat(environment);
      const config = await lstat(path.join(environment, 'pyvenv.cfg'));
      const executable = path.join(environment, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
      if (root.isDirectory() && !root.isSymbolicLink() && config.isFile() && !config.isSymbolicLink() && (await stat(executable)).isFile()) {
        if (process.platform !== 'win32') await access(executable, constants.X_OK);
        return executable;
      }
    } catch { /* Not a usable environment; try the next ancestor. */ }
    if (!relative) return undefined;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function runtimeSearchDirectories(options: DiscoveryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const directories = pathValue.split(platform === 'win32' ? ';' : ':')
    .map(directory => directory.replace(/^"(.*)"$/, '$1'))
    // Empty/relative PATH entries could select a project-local executable.
    .filter(directory => paths.isAbsolute(directory) && !/[\0\r\n]/u.test(directory));
  if (platform === 'win32') {
    const drive = env.SystemDrive ?? 'C:';
    const roots = [env.MSYS2_ROOT, `${drive}\\msys64`, env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'msys64')].filter((root): root is string => !!root && paths.isAbsolute(root));
    for (const root of roots) {
      for (const environment of ['ucrt64', 'mingw64', 'clang64', 'usr']) directories.push(paths.join(root, environment, 'bin'));
    }
    if (env.ProgramFiles) directories.push(paths.join(env.ProgramFiles, 'nodejs'), paths.join(env.ProgramFiles, 'dotnet'), paths.join(env.ProgramFiles, 'Git', 'bin'), paths.join(env.ProgramFiles, 'PowerShell', '7'));
    if (env.JAVA_HOME && paths.isAbsolute(env.JAVA_HOME)) directories.push(paths.join(env.JAVA_HOME, 'bin'));
    if (env.GOROOT && paths.isAbsolute(env.GOROOT)) directories.push(paths.join(env.GOROOT, 'bin'));
    if (env.CARGO_HOME && paths.isAbsolute(env.CARGO_HOME)) directories.push(paths.join(env.CARGO_HOME, 'bin'));
    else if (env.USERPROFILE) directories.push(paths.join(env.USERPROFILE, '.cargo', 'bin'));
    if (env.LOCALAPPDATA) directories.push(paths.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
    if (env.SystemRoot) directories.push(paths.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'));
  }
  return [...new Set(directories.filter(directory => paths.isAbsolute(directory) && !/[\0\r\n]/u.test(directory)))];
}

export function validateRuntimeExecutable(file: string, platform: NodeJS.Platform = process.platform): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(file) || /[\0\r\n]/u.test(file)) throw new Error('Runtime executable must be an absolute file path without control characters.');
  if (platform === 'win32' && !/\.exe$/iu.test(file)) throw new Error('Choose a native .exe runtime on Windows. Batch/shell shims are not executed by the file runner.');
}

export async function discoverRuntime(language: LanguageDefinition, options: DiscoveryOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const exists = options.exists ?? (async file => {
    try {
      const metadata = await stat(file);
      if (!metadata.isFile()) return false;
      if (platform !== 'win32') await access(file, constants.X_OK);
      return true;
    } catch { return false; }
  });
  const override = options.overrides?.[language.runtime];
  if (override) {
    validateRuntimeExecutable(override, platform);
    if (!await exists(override)) throw new Error(`Configured ${language.runtime} executable is missing or not executable: ${override}`);
    return override;
  }
  for (const candidate of language.candidates) {
    for (const directory of runtimeSearchDirectories(options)) {
      const file = paths.join(directory, platform === 'win32' ? `${candidate}.exe` : candidate);
      if (await exists(file)) return file;
    }
  }
  return undefined;
}
