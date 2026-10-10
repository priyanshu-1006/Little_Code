# Little Code 0.3.0 preview

Little Code is a standalone desktop coding companion built on Code-OSS. Version 0.3.0 adds a native framework project builder, a managed source-file runner and Flutter preview controls to its custom workspace, reviewed agent workflows and local project conversations.

This public summary describes observed verification scopes. Private paths, user projects, credentials, raw conversations and diagnostic receipts remain outside the source repository. The historical [0.2 summary](release-v0.2.0.md) records earlier provider and file-tool acceptance; those results are not fresh regressions of the new bundle.

## Download artifact

| Field | Value |
| --- | --- |
| Product version | 0.3.0 preview |
| Package | Windows x64 per-user setup |
| Upstream | Code-OSS 1.141.0 |
| Upstream commit | `2a59476c9bfcb90b3ddc372c36762471b7dfad1c` |
| Asset | `LittleCode-0.3.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe` |
| Bytes | 347,230,859 |
| SHA-256 | `d6c9f69746e2ffed717f7b0a5e96a3ce6bec55e4b8f119e78be12851a7baf9d3` |
| Signing | Unsigned |

Public delivery requires uploading this artifact to the matching GitHub Release. The setup stays outside Git and the Vercel website output. macOS, Linux and ARM packages are not offered. Installation, upgrade and uninstall were not executed during this verification.

## New development tools

- **Framework builder:** right-click a workspace folder or use Little Home / Build Tools. Choose React, Vue, Vite, Angular, Next.js, NestJS, Python, Flutter or React Native through Expo. The catalog offers 40 template/language combinations; style/platform options are additional choices. Each generator and dependency step has a native review. Existing nonempty destinations are rejected.
- **Python starters:** CLI, FastAPI, Flask, Django and Streamlit use a project-local `.venv`, with isolated pip installation through that environment.
- **Source runner:** right-click a saved file or press Ctrl+Alt+R. The 19-entry catalog uses installed interpreters/compilers. Compiled languages stop on compilation failure. Native task terminals handle line input and cancellation. Source changes after review invalidate execution.
- **C/C++ setup:** guided, separately reviewed MSYS2 / MinGW installation and compiler discovery on Windows. Package-manager prompts and signature validation remain active.
- **Flutter controls:** initialized SDK discovery, actual device/emulator selection, machine-protocol web preview, hot reload, hot restart and stop. Web preview waits for the reported loopback URL and HTTP readiness. Unconfirmed shutdown retains the owned session for retry.

Languages and platform SDKs are separate installations. Framework projects, JSX/TSX, notebooks and multi-file builds use their own project tools. Windows cannot provide iOS simulator builds. See [the workflow guide](build-tools.md) for runtime versions, settings and supported file types.

## Recorded verification

| Scope | Observed result |
| --- | --- |
| Source checks | TypeScript, ESLint and production bundling passed. 517 tests: 513 passed, four platform-specific skips, zero failures. |
| Native builder/runner fixture | Nine functional assertions passed against unchanged packaged bundle signatures: command/menu registration, actual framework picker, cancellation without mutation, rejected runs, reviewed Node execution and prevention after a source changed. |
| Native shutdown reconciliation | The original functional run's harness exited 1 when its shutdown check failed. A later successful exact-PID Windows query found the original root process absent. Original failure fields are preserved; this is not a clean original harness exit or a check of every descendant. Other attempts failed before extension progress and are retained separately. |
| Real React scaffold probe | The pinned official Vite creator generated one JavaScript React starter; project-local dependency installation and its production build passed. The owned fixture was removed. This does not cover every creator or the complete native wizard flow. |
| Installer inputs | The installer checksum/PE metadata and all 2,865 staged/current packaged inputs were checked independently, including 209 bundled Agent/document assets. Compressed installer contents were not extracted and setup was not run. |

The packaged main Agent bundle is **952,617 bytes**, SHA-256 `b83f316d8d9c58e785b2073440b59f19b1fb460e89308922f0b4bcc799469b5c`. Installer verification binds the preserved nine functional assertions and separate cleanup reconciliation to the same four packaged bundle signatures.

## Reproduce and remaining acceptance

```sh
npm ci
npm run check
node scripts/repository-audit.mjs
npm run website:check
npm run website:build
```

`npm run desktop:smoke-build-tools` requires the prepared Windows desktop package and creates an isolated, owned fixture profile. `scripts/verify-installer.mjs --help` documents the read-only installer verifier, including optional immutable native and cleanup receipts. Build a fresh owned installer snapshot before invoking it; completed staging may have been removed to reclaim storage.

Tests do not establish all 40 creator installations, all 19 real toolchains, actual MSYS2 setup, Flutter engine/device/web rendering, installed Ollama inference or complete PRD acceptance. Groq/history/file fixtures and live-provider evidence described in 0.2 have not been rerun on the new bundle. Full real-project agent edit/check acceptance, signing, installed lifecycle checks and dependency/license review remain release gates. Original Little Code licensing is a maintainer decision; retained third-party notices keep their own terms.

See [GitHub and Vercel publication](github-publication.md), [installer details](installer.md) and [the roadmap](roadmap.md).
