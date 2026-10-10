# Project builder, code runner and Flutter preview

These workflows are introduced in the **0.3 development build**. The older 0.2 installer does not include them. Check the version and verification details on the download card or in [installer.md](installer.md). Little Code includes its desktop runtime; your project's languages, compilers and platform SDKs are separate installations.

Open a local folder in Little Code and trust it before creating projects or running their code. **Little: Open Build Tools** opens the development choices. The same actions are available from Little Home and the Command Palette.

## Create a framework project

1. Right-click the intended parent folder in Explorer and choose **Little: Create Framework Project**, or run that command from the Command Palette.
2. Choose the framework, template and available language. Next.js offers Tailwind/plain CSS; Flutter app/plugin templates offer platform folder selection.
3. Choose a new subfolder or an existing **empty** folder. Hidden files count as existing contents. Web project names use lowercase letters/digits/hyphens; Python and Flutter names use lowercase letters/digits/underscores.
4. Review the destination and setup plan, then select **Create project**. Every generator or dependency command pauses separately at **Run step**.
5. Follow the native task output. On success choose **Open project** and use the suggested next command. **Cancel** or terminating its task stops owned processes; partial generated files remain for inspection.

The curated catalog has **40 template/language combinations across 9 categories**. Optional Next.js styles and Flutter platform selections do not count as additional combinations.

| Category | Templates | Languages / combinations |
| --- | --- | --- |
| React | Standard React, React Compiler | JavaScript / TypeScript · 4 |
| Vue | Vue 3 | JavaScript / TypeScript · 2 |
| Vite | Vanilla, Preact, Svelte, Solid, Lit, Qwik | JavaScript / TypeScript · 12 |
| Angular | CSS, SCSS | TypeScript · 2 |
| Next.js | App Router, Pages Router | JavaScript / TypeScript · 4 |
| NestJS | Standard server | JavaScript / TypeScript · 2 |
| Python | CLI, FastAPI, Flask, Django, Streamlit | Python · 5 |
| Flutter | Starter app, empty app, package, plugin | Dart · 4 |
| React Native / Expo | Default Router, blank JS/TS, tabs, native directories | Template-dependent JavaScript / TypeScript · 5 |

Web/mobile generators use the pinned official npm creators recorded in [projectTemplates.ts](../src/development/projectTemplates.ts), followed by a separately approved project-local dependency installation. The wizard checks installed Node/npm first: Vite choices require Node 20.19+ or 22.12+; Angular requires 22.22.3+, 24.15+, or 26+; the pinned Next.js/NestJS checks require 20.9+/20.11+. Expo templates also have their own runtime/platform requirements. Package generators and install scripts can access the network and execute downloaded code with your user permissions. The wizard requests no global framework installation.

Python starters require Python **3.10+**. They create a private `.venv`; framework packages are installed through that environment's Python with isolated pip configuration. Django uses its official project generator. An explicit Python runner override takes priority; otherwise running a `.py` file prefers the nearest project `.venv` before searching installed interpreters. Use the generated environment for your framework's development-server command.

Flutter generation uses an already installed, initialized SDK and separates `flutter create --no-pub` from the approved `flutter pub get` step. Generating platform folders does not install Android, iOS or desktop SDKs. For example, iOS builds and simulators require macOS and its tools.

## Run a saved source file

Right-click a source file in Explorer or the editor and select **Little: Run Current File**. Save changes when prompted, inspect the native command review, then choose **Compile / run**. Source changes after review invalidate the run. Output appears in its managed native task terminal; failed compilation prevents execution of its binary.

The **19 catalog entries** are JavaScript, TypeScript, Python, C, C++, Java, C#, Go, Rust, Ruby, PHP, Dart, PowerShell, Bash/shell scripts, Lua, Perl, R, Swift and Kotlin scripts. Install the corresponding executable yourself; **Little: Inspect Language Runtimes** reports discovered paths without running those executables. A found path does not prove its version, packages or successful compilation.

- C uses C17 and C++ uses C++17. C/C++, Go, Rust and Swift compile the single file before running. Private compilation outputs are cleaned when the task ends.
- Java needs JDK 11+ source-file launch; C# needs the .NET 10+ SDK file-based app workflow. Their projects may require additional dependencies.
- TypeScript uses Node 22.18+ native type stripping. It does not type-check, transform JSX/TSX or resolve `tsconfig` path aliases. Use the project's own build command for those cases.
- Kotlin supports `.kts` scripts with a native executable compiler. `.kt` applications use their Gradle/project task. Windows batch compiler shims require another project task or native launcher.
- JSX/TSX, notebooks, framework builds and multi-file native projects use their own project tools. The Dart single-file runner is for CLI programs; Flutter apps use the preview workflow.

Use **Ctrl+C** in the task terminal or **Tasks: Terminate Task** to stop a run. Line input is forwarded on Enter. Full-screen terminal applications need a normal project terminal. Programs and their imports execute with your operating-system permissions; they can change files or access the network. Agent file checkpoints do not roll back command side effects.

Application/user settings can override discovered executables and supply argument tokens:

```json
{
  "little.runner.runtimePaths": {
    "python": "C:/Tools/Python/python.exe",
    "gcc": "C:/msys64/ucrt64/bin/gcc.exe",
    "g++": "C:/msys64/ucrt64/bin/g++.exe"
  },
  "little.runner.arguments": ["first argument", "second argument"]
}
```

Replace these examples with actual installed paths. Workspace settings cannot redirect these application-level executables. For another interpreter, `little.runner.customRuntimes` accepts an absolute executable and an argument array containing `${file}` as a whole argument; `${dir}` is also available. It does not accept shell command strings.

## C/C++ on Windows: MSYS2 / MinGW

Choose **Little: Set Up C / C++ Toolchain**. It finds an existing MSYS2 installation or offers a separately reviewed Windows Package Manager installation when `winget` is available. The wizard then checks signing-keyring files; first-login initialization, when needed, has its own native confirmation. An incomplete keyring stops installation and links to the official repair/update guide.

Update MSYS2 using its [official instructions](https://www.msys2.org/docs/updating/), then review installation of the **UCRT64 GCC/MinGW package**. Pacman's package list and installation prompt remain interactive; nothing is automatically accepted. The runner discovers `gcc.exe` / `g++.exe` in known UCRT64/MinGW locations and includes the compiler directory for runtime DLL loading. You can set the paths above if discovery cannot find your installation.

Compiler setup writes to the chosen MSYS2 installation and may need its normal permissions. It preserves signature verification and does not delete an existing keyring. This repository's checks do not establish successful installation on every Windows configuration.

## Preview a Flutter application

1. Install Flutter and the tools for your target using the [official setup guide](https://docs.flutter.dev/get-started/install). Run `flutter doctor` yourself to initialize and verify the SDK, then restart Little Code.
2. If discovery cannot find it, set the **user/application** setting `little.flutter.sdkPath` to the SDK folder. It must contain warmed Dart, `flutter_tools.snapshot` and the Flutter tool package configuration. Little Code never installs or initializes Flutter silently.
3. Open a Flutter **app** with a Flutter SDK dependency in `pubspec.yaml` and a regular `lib/main.dart`. Right-click its folder → **Little: Flutter Preview**, or use the Command Palette.
4. Approve device discovery. Choose a real discovered device, **Launch an existing emulator**, or **Web preview inside Little Code**. Emulator launch uses an already configured image; no image is installed for you.
5. Review and approve **Run Flutter**. Building can fetch project dependencies and platform artifacts. Web preview binds to loopback, waits for the actual machine-protocol URL and a ready HTTP response, then opens it beside the editor.
6. Use the status-bar controls or **Little: Flutter Hot Reload**, **Little: Flutter Hot Restart**, and **Little: Stop Flutter Preview**. Reload/restart have native confirmation and report actual protocol results. Only one Little-managed Flutter preview is active at a time.

Web-server debugging has [Flutter's documented limitations](https://docs.flutter.dev/platform-integration/web/setup). Packages and plugins need their test/example-app workflow; selecting a template is not proof that the target SDK is available. Stop and disposal target Little-owned processes rather than other independently running devices or applications. A stop completes only after the owned child's close event is observed. If shutdown cannot be confirmed, the active session and Stop control remain available for a retry; another preview cannot start while the owned process remains.

## What verification establishes

The 0.3 source check passed 517 tests: 513 passed, four platform-specific skips and zero failures, alongside TypeScript, lint and production build. Tests exercise curated project plans, destination/environment validation, runner argv/sequence behavior, runtime discovery and Flutter machine-message/device/project/shutdown validation. Actual native picker cancellation, reviewed Node execution, rejection and changed-source prevention have passed in owned fixtures. A separate real React generator/dependency/build probe also passed. These checks did not install platform SDKs or run private projects; native shutdown receipt reconciliation is recorded separately in the current development evidence.

These checks do **not** establish successful registry installation for all creators, all 19 real compilers/interpreters, or actual Flutter engine/emulator/web rendering. Those require installed-toolchain acceptance. Installer payload verification is separate from signing, installation, upgrade and uninstall acceptance. See [development evidence](development.md) and [the roadmap](roadmap.md).
