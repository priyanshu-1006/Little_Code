# Little Code

**Your AI-native coding companion. Built by Priyanshu Chaurasia.**

Little Code now opens as its own **Electron / Code-OSS desktop application**, following [PRD.md](PRD.md) and [the frontend specification](LITTLE_CODE_FRONTEND_ARCHITECTURE_UI_SPEC.md). The packaged Windows development build has a custom native Home/Files/Search/Git/Terminal/Agent top bar, outline icons and side rail, redesigned Little Home and Agent, your supplied logo, and matching light/dark themes. The Little extension is bundled inside the app. See [the interface guide](docs/interface.md).

Version **0.3.0** adds a native framework project builder, a managed single-file runner and Flutter device/web preview controls. The builder offers **40 template/language combinations across nine categories**; the runner has **19 language entries**, using installed runtimes and compilers. Python starters create a project-local `.venv`; Flutter needs an initialized SDK and the target platform tools. See [the build tools guide](docs/build-tools.md).

The **ASK**, **PLAN**, controlled **EDIT**, and supervised **AGENT** foundation includes encrypted Groq key storage, local Ollama, model discovery, streaming, project memory, approved MCP, repository/file tools, visible plans/activity, bounded runs and cancellation. ASK and PLAN are read-only. EDIT requires native diff acceptance, with private checkpoints and restoration; AGENT adds separately approved project checks and a bounded inspect/plan/edit/check/repair loop. Format-aware file workflows and live Groq evidence were recorded on **0.2.0** and are identified below as historical acceptance. They have not yet been rerun on the new 0.3 bundle. Broader PRD capabilities, installed-toolchain acceptance and release lifecycle validation remain. See [file tools](docs/file-tools.md), [the roadmap](docs/roadmap.md) and [Windows setup status](docs/installer.md).

## Product showcase and GitHub

The [product showcase](website/README.md) is a separate responsive website with the supplied logo, real app captures, an interactive four-mode tour, a browsable framework catalog, runner/Flutter workflows, project journey, light/dark appearances and Windows download requirements. It is prepared for **Vercel** and [priyanshu-1006/Little_Code](https://github.com/priyanshu-1006/Little_Code).

Preview it from this repository with Node 22 or newer; no website dependency installation is needed:

~~~powershell
npm.cmd run website:check
npm.cmd run website:build
npm.cmd run website:dev
~~~

Open **http://127.0.0.1:4173**. The local preview enables setup downloads only after checking the configured file's size and SHA-256. The hosted site enables a direct download only when a matching GitHub Release asset is published with the verified name, size and digest. Installers, dependencies, upstream builds, private profiles and raw diagnostic receipts stay outside Git. See [GitHub and Vercel publication](docs/github-publication.md), [website maintenance](docs/website.md), [domain choices](docs/domains.md), [current 0.3 release notes](docs/release-v0.3.0.md) and the [historical 0.2 summary](docs/release-v0.2.0.md). Preparation has not committed or pushed these changes, uploaded the setup or deployed the site.

## Open Little Code

Double-click **[LittleCode.lnk](LittleCode.lnk)** in this repository. You can also open **[Little Code.exe](.upstream/VSCode-win32-x64/Little%20Code.exe)** directly. The app carries its own Electron runtime and opens without Node or an installed VS Code. Keep the entire `.upstream/VSCode-win32-x64` folder intact.

The optional **Start Little Code.cmd** wrapper and this PowerShell command require Node:

~~~powershell
npm.cmd run desktop:start
~~~

The launcher prefers the packaged executable and offers a source-backed native fallback for developer debugging. Little Code has its own product identity and user data.

Fully close and reopen Little Code after the native shell update. Use the **sun/moon** button in the top bar, Home or Agent to change the entire app's appearance. The choice persists in your profile. **Developer: Reload Window** remains sufficient for later Agent-only bundle updates.

The supplied [Little_code_logo.png](Little_code_logo.png) appears in Little Home and product branding; generated platform icons preserve its complete artwork and colors. Space Grotesk, Inter, and JetBrains Mono are bundled locally with their licenses and [font provenance](resources/fonts/README.md).

Earlier standalone-shell acceptance passed canonical Windows packaging, all 25 native bundles, 17 bundle syntax checks and [full native TypeScript checking](desktop/logs/native-typecheck.json). Its [first-launch smoke](desktop/screenshots/first-launch.json) passed six startup assertions, including the logo, right Agent panel, Ask/Plan/Edit/Agent, disconnected provider and native Inter font. It opened and cancelled the masked Groq dialog without entering a key. See the [actual first-launch capture](desktop/screenshots/first-launch.png). These shell captures precede the 0.3 feature additions.

The earlier [packaged terminal smoke](desktop/logs/native-terminal-smoke.json) loaded real ConPTY, received a unique PowerShell marker and exited 0 using Electron 43.7.7/native ABI 148. Historical [Agent command-host checks](desktop/logs/native-command-host-smoke.json) exercised actual Node confirmations, rejection/replay, cancellation/disposal and owned-app exit. The current **0.3** source check and native builder/runner evidence are listed under development verification below; the [latest Agent refresh](desktop/logs/agent-update.json) verifies the updated packaged bundle identities.

## First run

The Agent now includes a saved-chat selector and **New chat**. Prompts and answers persist locally for the reopened project/profile; interrupted runs restore as read-only history. Recent completed turns provide bounded follow-up context. See [saved conversations](docs/conversations.md).

In the app:

1. Open a local repository from Little Home or **File → Open Folder**.
2. Use the Little Agent panel on the right. **Little: Focus Agent** also opens it.
3. Connect Groq, or choose **Ollama local** from the Settings gear and configure a running loopback Ollama runtime. Discover models and choose a model that supports tool calling.
4. In ASK, request: **Explain this repository's architecture and cite its main entry points.**
5. In PLAN, request an implementation plan and test **Stop** during a run.
6. Save the affected editor files, switch to EDIT, and request a small change, such as **Add an explanatory comment to this function without changing its behavior.**
7. Select **Review diff** to inspect the proposed changes in native diff editors, then choose **Accept changes** or **Reject**. After an accepted run finishes, use **Restore changes** on its checkpoint card, or **Little: Restore Checkpoint** from the Command Palette.
8. In AGENT, request: **Inspect this repository, show a short plan, make one small reviewed improvement, and run its existing tests.** Each command pauses at **Allow once** or **Reject**; allowing also requires **Run command** in a native confirmation dialog. Inspect command output and the verification card, and use **Stop** to cancel a run.

Startup now shows Little Home and the agent panel automatically in the isolated native launch. Your API key is stored through encrypted SecretStorage and never passed to the webview. Requests send selected repository context and tool results to Groq Cloud. Sensitive paths are blocked and likely secrets are redacted; inspect the context you include.

Groq model discovery filters incompatible systems and preserves valid selections after transient failures. GPT OSS 20B/120B now use native local tool calling and streamed answers, with parallel calls disabled. The full native request and up to 2,048 completion tokens share the conservative 5,500-token ceiling. Host validation and approvals still apply. Broad questions include architecture and notebook cell evidence; quota errors expose reset details and a cooldown. See [provider setup](docs/providers.md).

[Earlier live authenticated discovery](desktop/logs/groq-live-models-success.json) returned four coding models, including GPT OSS 120B and 20B with tool-capable labels. The discovery probe confirmed owned app/extension-host exit; it does not establish inference for every model or a fresh 0.3 live-provider run.

The forced JSON decision wrapper that failed on repository questions with `json_validate_failed` has been removed. On the **0.2 acceptance bundle**, the reported prompt **analyse the notebooks and codebase for me** completed through native Groq against an owned notebook/Python fixture with actual reads and source-grounded answers. Small source-read probes alone had not established that broader flow. See [response recovery](docs/agent-troubleshooting.md); a fresh 0.3 live-provider regression remains pending.

Opening a trusted project now builds a local **Project intelligence** map before you connect Groq. The card shows progress, file/declaration counts, and refresh; saved file changes update it automatically. AI requests select fresh source snippets for your task and show why each file was included. The index uses bounded lexical declarations/imports rather than a complete semantic graph. See [repository context](docs/repository-context.md) for limits and the real-app acceptance check.

File requests now retain the relevant tools within the provider budget: `read_notebook` reads notebook cells and focused source lines; `read_document` extracts DOCX paragraphs, PPTX slides and PDF pages; `inspect_file` returns bounded size/hash metadata without content. EDIT/AGENT can propose UTF-8 create/replace/delete operations, notebook cell changes, simple document creation, DOCX/PPTX text replacements and PDF text-page appends. Every mutation still waits for **Review diff → Accept changes**. Unknown binary files can be inspected as metadata and deleted through review; their contents cannot be summarized or edited. See [supported file workflows](docs/file-tools.md).

Explicit file answers are withheld until actual tool evidence or an honest limitation resolves the request. A valid answer that skips required tools receives one bounded correction; failed provider generations are not replayed. Creation inspects the actual parent folder; existing-file edits require fresh contents, while deletion can use exact-byte metadata. Literal requested filenames are masked during intent checks: `Delete slides.pptx.` is whole-file deletion, and `Read scripts/update.ts.` does not request an update. Original paths and formats still identify the targets. File instructions remain untrusted, and rejected proposals cannot be resubmitted in the same run.

Text proposals contain at most eight files, with 256 KiB per text file and 1 MiB of combined text originals/proposals; private binary originals and generated format files have separate bounded byte limits. Dirty editors/notebooks must be saved first. Sensitive, ignored, generated, linked, and ignore-policy paths are excluded. Staging and rejection leave repository files unchanged; accepting requires a trusted workspace and host review. Later changes invalidate a proposal or become restore conflicts rather than being overwritten. Legacy DOC/PPT, encrypted documents and scanned-PDF OCR are unsupported. PDF append preserves existing pages; arbitrary in-place text/layout replacement and rendered-layout verification are unavailable.

Original bytes, including deleted or binary originals, and write-ahead mutation records are persisted in private workspace storage before each file mutation. Actual child-process crash tests cover interrupted apply and restore, exact original bytes, and later-save/deletion conflicts. **Saved checkpoints** discovers interrupted records after restart and requires native confirmation before recovery. Portable Windows Node cannot guarantee every power-loss window or lock other applications' open file handles and parent directories. See [checkpoint recovery](docs/checkpoints.md).

AGENT commands use supported development programs and bounded argument tokens, with a project-relative launch folder, timeout, captured output, and a fresh host-owned approval for every request. Approved scripts run with your current user permissions and can change files or access the network; they are not OS-sandboxed. Edit checkpoints do not roll back command side effects. A passing verification card means the recorded current checks exited successfully with complete captured output, not that every requirement is proven. Later accepted edits invalidate earlier checks. The live AGENT probe exercised source reading only; it executed no edits or commands.

## Ollama, memory, and MCP

Open Little Code with `LittleCode.lnk`, then open the Settings gear in the Little panel. Choose **Ollama local** and **Configure Ollama** to set the runtime origin; the default is `http://127.0.0.1:11434`. Start your own Ollama installation with a suitable model already installed, choose **Discover models**, and select that model. Little Code does not install Ollama or pull models. Model discovery uses the runtime's actual installed tags and excludes entries identified as cloud or proxy models. Tool support stays unknown until verified. A loopback origin alone does not prove that an independently configured runtime never forwards traffic. Live inference with an installed Ollama engine remains to be verified; socket fixtures exercise the provider API without such an engine.

Use **Project memory → Add note** to add a note with a title, content, kind, and optional source, then approve the native **Save memory** dialog. Notes can be edited or deleted. A fact needs a permitted source file that is read fresh; inferred notes carry a lower-confidence label. Personal preferences are entered separately and are limited to 1,500 characters. Project notes persist privately for that project, with up to 50 notes, 4,000 characters per note, and 128 KiB total storage. Retrieved note context is bounded to 3,000 characters. Memory is validated and redacted before it reaches model context; a saved inference is not promoted to a verified source fact.

Use **MCP integrations → Add MCP server** to add a named server with the URL of an already running loopback Streamable HTTP endpoint, such as `http://127.0.0.1:3000/mcp`. Approve the native connection dialog. In **Agent** mode, inspect the project and publish a plan before requesting an MCP tool; every invocation needs its own native **Allow once** approval. Little Code supports up to eight server configurations, discovers at most 50 tools per server, and exposes at most 16 tools within a 12,000-character schema budget. It supports the stateless `2026-07-28` protocol and session-based `2025-11-25`, `2025-06-18`, and `2025-03-26` compatibility. Failed tool calls are not replayed automatically. Stdio transports, remote hosts, remote authentication, and integration process management are not implemented.

Git status and diff helpers are available as read-only tools in every mode. **Review Git changes** opens a native file picker and read-only diff documents. **Saved checkpoints** opens validated recorded and interrupted transactions for explicit restoration. Full Git workflows, stronger storage durability, and coordination with external writers remain pending.

In **Agent** mode, ask for architecture and verification reviews. The agent can delegate one review team per run using the selected provider and model. Two progress/result cards show isolated ASK workers, each bounded to four turns, 12,000 usage tokens and 4,000 result characters. Groq workers run in sequence with a 180-second deadline each to accommodate observed quota waits; other providers run in parallel with 60-second deadlines. Reviews provide source-based analysis and suggested verification steps; they do not execute checks, write files, call MCP tools, or recursively delegate work. Failed or cancelled workers retain their actual state, and the main agent still needs its own inspection, plan, and approval gates. Native Git review and both review cards have passed in the packaged app; the verification worker explicitly states that it did not execute checks. **Compare reviews** prepares a request for you to send. Parallel agent writers remain later work.

## Framework projects, source runs and Flutter

The 0.3 development build adds **Little: Create Framework Project**, **Little: Run Current File** and **Little: Flutter Preview** through Home, Build Tools and native context menus. Right-click a workspace folder to create a framework project, or right-click a saved source file to review and run its managed native task. Each generator/dependency step needs native confirmation; generated files remain available after cancellation. Flutter can discover devices, launch an existing emulator or open its actual loopback web-server URL, with hot reload/restart/stop controls. An unconfirmed stop retains the session and permits a retry.

Install your project runtimes and SDKs separately. See the [build tools guide](docs/build-tools.md) for all catalog choices, Python `.venv`, C/C++ MinGW setup, native task input/cancellation and Flutter SDK/device requirements. These additions are included in the verified **0.3.0** setup. Reopen Little Code or use **Developer: Reload Window** after updating its Agent bundle.

## Local browser preview

In Settings, open **Local browser preview** and configure a running isolated Chrome/Edge debug endpoint. **Inspect local app** opens native consent, then rendered page text and a screenshot in native editors. AGENT can request the same inspection after its plan; page text becomes provider context, while the screenshot stays in native preview. This foundation creates and closes its own tab, blocks document navigation outside the approved local origin, and does not click controls or select your existing tabs. See [the browser guide](docs/browser-preview.md).

## Build for development

To rebuild from source on Windows, use **Node 24.18.0 or newer within major version 24**, npm, Python, and the matching Visual Studio C++/Windows SDK toolchain. The build supplies the verified x64 Spectre libraries for this machine's MSVC 14.29.30133 when needed. See [development.md](docs/development.md) for setup and the guarded upstream adaptations.

~~~powershell
npm.cmd ci
npm.cmd run desktop:build
~~~

The build prepares Little, installs native dependencies and built-in extensions, runs the canonical `npm run gulp -- vscode-win32-x64` packaging task, and creates the shortcut. Output is recorded in `desktop/logs/build.log`.

`npm.cmd run check` verifies the Little runtime, adapter, and UI bundles. `npm.cmd run desktop:agent` rebuilds and copies only the bundled Little integration into an existing standalone package, then verifies its bundle hashes; reopen the app or use **Developer: Reload Window** to load the update. `npm.cmd run desktop:prepare` refreshes native source integration without completing native compilation. F5 with **Little Code: Development Host** remains available for adapter debugging only.

The **0.3.0** final source check exited 0 with **517 tests: 513 passed, four platform-specific skips, zero failures**; TypeScript, ESLint and production build passed. The updated packaged main bundle is **952,617 bytes**, SHA-256 `b83f316d8d9c58e785b2073440b59f19b1fb460e89308922f0b4bcc799469b5c`; its staged/packaged identities are recorded in [agent-update.json](desktop/logs/agent-update.json).

The preserved [native build-tools fixture](desktop/logs/native-build-tools-smoke-second-attempt.json) exercised actual command/menu registration, the framework picker and cancellation without folder mutation, native run rejection, a reviewed Node task, and rejection after the source changed. All nine functional assertions passed against the unchanged packaged bundle. The original harness exited 1 because its shutdown check failed; a later successful exact-PID query found the original test process absent, recorded in [cleanup reconciliation](desktop/logs/native-build-tools-cleanup-reconciled.json). This preserves the original failure and does not establish a clean harness exit, every descendant's absence, all creator installs, all 19 language engines or actual Flutter rendering. Other attempts that failed before extension progress remain separate diagnostic receipts.

Separately, the [owned React scaffold probe](desktop/logs/project-scaffold-smoke.json) used the actual pinned `create-vite` generator, installed project dependencies, built its generated JavaScript React app and verified fixture removal. It covers one real template/language combination, not the entire catalog or the complete native wizard flow.

Historical **0.2.0** source verification passed **460 tests: 459 passed, one platform-specific skip, zero failures**, with TypeScript, lint and build green. Its **867,009-byte** main bundle had SHA-256 `d2512f4ee8e92f3bf71718ff15879086438610ea5883032c9de210f00c5107bd` and passed **30 native Groq/history checks in 65.200 seconds**: source feedback, malformed-call rejection, safe errors, quota cooldown, recovery and saved chats across a full restart without replay. Those Groq/history checks have not been rerun on the new 0.3 bundle. See the [0.2 source log](desktop/logs/file-agent-check-final.log), [native report](desktop/logs/native-groq-smoke.json) and [run log](desktop/logs/file-agent-native-groq-smoke-final.log).

The historical **0.2** [native file-tool report](desktop/logs/native-file-tools-smoke.json) confirms **15 functional cases and 12 assertions** on that older bundle: 20 native reviews, eight exact-byte restorations, 16 restoration Cancel/Confirm dialogs and 34 loopback provider observations. Text, notebook, DOCX/PPTX and PDF create/read/edit/delete exercised production review UI, rejection/cancellation, trust/dirty-notebook gates and notebook-output privacy. The final receipt confirms cleanup after independent reconciliation; see [development evidence](docs/development.md). These are accepted scripted-provider fixtures, have not been rerun on the new 0.3 bundle, and do not establish accepted live-model changes.

Five historical **0.2** [live Groq file cases](desktop/logs/groq-file-live-acceptance.json) passed with GPT OSS 120B/native SecretStorage: notebook, DOCX and PDF reads, a valid notebook proposal, and `Delete slides.pptx.` using `inspect_file` before `propose_file_edits`. The host rejected both proposals; original bytes stayed unchanged and owned windows closed. All 14 requests returned 200, with estimated request costs at most 5,000 inside the 5,500 ceiling. Only owned fixtures were used; no private project or accepted live mutation/check was tested. Fresh 0.3 provider/file regressions and broader live edit/check acceptance remain pending.

The **0.3.0** [Windows setup](desktop/releases/2026-10-10T11-00-25-356Z-b6fb3b59/LittleCode-0.3.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe) is 347,230,859 bytes, SHA-256 `d6c9f69746e2ffed717f7b0a5e96a3ce6bec55e4b8f119e78be12851a7baf9d3`. [Independent verification](desktop/releases/2026-10-10T11-00-25-356Z-b6fb3b59/independent-verification.json) checks all 2,865 staged/current packaged inputs and 209 Agent/document assets, and binds the preserved functional native receipt with separate shutdown reconciliation to matching bundle bytes. Compressed installer contents were not extracted; setup was not executed. Signing, installation, upgrade and uninstall remain untested. The [0.3 public summary](docs/release-v0.3.0.md) records this scope without local data.

Ollama, project/preference memory, approved loopback HTTP MCP, read-only Git review, bounded review workers and local browser snapshot inspection remain implemented foundations. Their earlier native results do not replace fresh 0.3 regression or installed-engine acceptance. Continue with actual Ollama inference, broader Groq/Agent edit/check flows, richer Git/browser workflows, persistent/semantic indexing and coordinated parallel writers. Use [installer.md](docs/installer.md) and [roadmap.md](docs/roadmap.md) for current status; see also [architecture](docs/architecture.md), [runtime](docs/agent-runtime.md), [providers](docs/providers.md), [file workflows](docs/file-tools.md) and [tools](docs/tools.md).


