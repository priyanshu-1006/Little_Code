# Windows setup package

Little Code has a per-user Inno Setup build. It packages the already-built standalone app, including the Little Agent extension, supplied logo, bundled licenses and third-party notices. The installer version follows the Little Agent package version; its report separately records the underlying Code-OSS version and commit.

The October 10 development setup compiled successfully with notebook and document
file tools, reviewed create/edit/delete operations, native Groq calls and persistent project chats:
[Little Code 0.2.0 Windows setup](../desktop/releases/2026-10-10T04-49-25-203Z-08a1f71c/LittleCode-0.2.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe).
It contains 2,865 payload files and is 347,143,376 bytes. Its SHA-256 is
`32ec825e0b94fadab7613dd453ca000c0aab5de19003b3bc65d11129b1a57369`.
See [the build report](../desktop/releases/2026-10-10T04-49-25-203Z-08a1f71c/installer-report.json),
[checksums](../desktop/releases/2026-10-10T04-49-25-203Z-08a1f71c/SHA256SUMS.txt)
and [independent verification](../desktop/releases/2026-10-10T04-49-25-203Z-08a1f71c/independent-verification.json).
Independent verification matched every current/staged payload file and all 209 updater
assets, including the PDF worker, parser, fonts, CMaps and supplied dependency notices.
The packaged Agent bundle is 867,009 bytes with SHA-256
`d2512f4ee8e92f3bf71718ff15879086438610ea5883032c9de210f00c5107bd`.
The same bundle passed 30 native Groq/history checks in 65.200 seconds,
including chat restoration after restart without request or action replay, and
15 native file cases with 20 reviews and eight exact-byte restores.
The file runner's initial cleanup timeout was independently reconciled with verified
owned-process absence; its original observation remains in the receipt.
The complete [source check](../desktop/logs/file-agent-check-final.log) passed 459 of
460 tests with one platform-specific skip, plus TypeScript, lint and build. Five
[live GPT OSS 120B file flows](../desktop/logs/groq-file-live-acceptance.json) verified
reads and rejected edit/delete proposals on owned fixtures; accepted native changes
used a scripted local provider. See [file tools](file-tools.md) and [provider evidence](providers.md).
Setup remains unsigned and has not been executed;
installation, upgrade/uninstall and signing remain release gates.

Build from the project directory after updating the app:

```powershell
npm.cmd run desktop:agent
node scripts/build-installer.mjs --check
node scripts/build-installer.mjs
```

The build uses the Inno Setup compiler already installed by the pinned Code-OSS dependencies. It does not download tools, install the app, launch the resulting setup, edit the registry, or publish a release. `--check` is a no-staging preflight: it validates the bundle and writes a preflight report without staging or compression.

Each build creates a separate directory under `desktop/releases/` containing:

- `LittleCode-<version>-CodeOSS-<version>-win32-x64-UserSetup.exe`
- `SHA256SUMS.txt`
- `payload-manifest.json`, with hashes of every staged payload file
- `installer-report.json`, with source identity, compiler provenance and build results
- `compile.log`

The latest build report is also saved to `desktop/logs/installer-build.json`. Staged payloads are created under `desktop/installer/staging/` for verification. Generated `node-compile-cache` data is excluded. A build stops if the source bundle changes during staging, or if it finds linked payloads. The source app directory is preserved. Requested cleanup removed the superseded setup and completed staging copy after the newest installer passed independent verification; only this release remains and staging is empty. The payload manifest and verification reports remain in the release directory. See [the cleanup record](../desktop/logs/setup-cleanup.json) for completed targets and retained identity. Temporary obsolete builds are accounted separately from initial storage savings.

For a preserved failed compiler attempt, `--resume=<owned-build-id>` revalidates
the complete staged payload, current source, identity, compiler and branding before
retrying without replacing the original logs. A changed app requires a fresh build.
The successful build above used a fresh snapshot; resume is syntax checked but
has not been exercised. Older staging snapshots were removed during the requested storage cleanup.

To install, close Little Code, open the generated setup executable, review the license, and follow the wizard. Setup defaults to `%LOCALAPPDATA%\Programs\Little Code` and creates **Little Code** in the current user's Start Menu. A desktop shortcut is optional. Administrative elevation is not requested. These behaviors follow Inno Setup's [per-user installation setting](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm).

The package uses Little Code's own x64 user AppId `{1C63266D-735C-5821-A9D9-4D863E745C8A}` and AppUserModelID `PriyanshuChaurasia.LittleCode`. This gives it a separate installation identity and uninstall record. Inno Setup documents how [AppId determines installation and uninstall identity](https://jrsoftware.org/ishelp/topic_setup_appid.htm).

This installer does not add PATH entries, file associations, Explorer menus, URL protocols, tunnel services, automatic updates, or launch hooks. It does not force-close running applications. It refuses a destination containing `Code.exe`, `VSCodium.exe`, or another application's product identity. Uninstall removes its recorded installation files and shortcuts; the user's Little Code profile and project folders are outside the payload and have no uninstall deletion rules.

The configuration uses the upstream Windows build's Inno compiler, product metadata and branded wizard assets. Its small template omits the upstream updater and shell integration hooks because this development bundle does not contain the full signed update and Appx payloads.

The setup is unsigned. Windows may identify its publisher as unknown. Compiler success and payload hashes verify packaging; they do not replace installation, upgrade and uninstall tests in a separate Windows test environment, code signing, dependency/license review, or a release audit. The build does not perform those tests or claim release readiness.
