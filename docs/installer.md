# Windows setup package

Little Code has a per-user Inno Setup build. It packages the already-built standalone app, including the Little Agent extension, supplied logo, bundled licenses and third-party notices. The installer version follows the Little Agent package version; its report separately records the underlying Code-OSS version and commit.

The October 10 **0.3.0** setup contains the framework builder, single-file runner and Flutter controls alongside the existing Agent/file/history foundation:
[Little Code 0.3.0 Windows setup](../desktop/releases/2026-10-10T11-00-25-356Z-b6fb3b59/LittleCode-0.3.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe).
It packages 2,865 files and is **347,230,859 bytes**, SHA-256
`d6c9f69746e2ffed717f7b0a5e96a3ce6bec55e4b8f119e78be12851a7baf9d3`.
See [the build report](../desktop/releases/2026-10-10T11-00-25-356Z-b6fb3b59/installer-report.json),
[checksums](../desktop/releases/2026-10-10T11-00-25-356Z-b6fb3b59/SHA256SUMS.txt)
and [independent verification](../desktop/releases/2026-10-10T11-00-25-356Z-b6fb3b59/independent-verification.json).

Independent verification checked the installer checksum/PE metadata and every staged/current packaged input, including 209 Agent/document assets. It checked the exact `target=user` product transformation and compiler/template/branding provenance. It did **not** extract the compressed installer or execute setup. The packaged Agent bundle is **952,617 bytes**, SHA-256 `b83f316d8d9c58e785b2073440b59f19b1fb460e89308922f0b4bcc799469b5c`.

The verifier's optional legacy PowerShell metadata probe returned no data. A separate [Windows metadata check](../desktop/logs/installer-windows-metadata-v0.3.0.json) confirmed `NotSigned`, file version `0.3.0.0` and the same installer checksum.

The current [source check](../desktop/logs/build-tools-check-final.log) passed TypeScript, lint, build and 517 tests: 513 passed, four platform-specific skips, zero failures. The preserved [native builder/runner receipt](../desktop/logs/native-build-tools-smoke-second-attempt.json) passed nine functional assertions, including the actual framework picker, rejected/approved Node tasks and changed-source prevention, against unchanged bundle signatures. Its harness exited 1 when shutdown verification failed. A later successful exact-PID query found the original root process absent; [separate cleanup reconciliation](../desktop/logs/native-build-tools-cleanup-reconciled.json) preserves the original failure and does not establish every descendant's absence or a clean original exit. Independent installer verification binds these receipts to matching bundle bytes as `functional_pass_cleanup_reconciled`. Other startup failures remain separate diagnostics.

A real React/Vite JavaScript scaffold, dependency installation and production build also passed. Full creator/toolchain installation, actual Flutter engine/device rendering and fresh 0.3 provider/file regressions remain acceptance work. Earlier Groq/history and file-tool results belong to [the historical 0.2 release](release-v0.2.0.md); they have not been rerun on this bundle. Setup is unsigned and was not installed. Installation, upgrade/uninstall, signing and full release audit remain gates. See [0.3 public notes](release-v0.3.0.md) and [build tools](build-tools.md).

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

The latest build report is also saved to `desktop/logs/installer-build.json`. Staged payloads are created under `desktop/installer/staging/` for verification. Generated `node-compile-cache` data is excluded. A build stops if source changes during staging or linked payloads are found. Keep the source app directory intact. After independent verification, the requested cleanup removed the superseded 0.2 setup and completed 0.3 staging copy, reclaiming **1,600,481,842 bytes**. Only the new 0.3 setup remains; historical manifests/reports and the source app are preserved. The dated [0.3 cleanup receipt](../desktop/logs/setup-cleanup-v0.3.0.json) records completed targets and retained identity; [earlier cleanup](../desktop/logs/setup-cleanup.json) records previous storage savings separately.

Verify a fresh build before staging cleanup:

```powershell
node scripts/verify-installer.mjs --report=desktop/releases/<owned-build-id>/installer-report.json
```

Use `--native-report` and `--cleanup-report` only with their exact preserved receipts when binding a functional run and separate shutdown reconciliation. See `--help`. The verifier reads build inputs and writes a new ignored `independent-verification.json`; it does not replace evidence, execute setup or delete files. Verification after staging removal requires a fresh build snapshot.

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
