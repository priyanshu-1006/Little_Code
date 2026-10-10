# Showcase evidence and product claims

The showcase describes Little Code **0.2.0**, built by **Priyanshu Chaurasia**. The product is an independent desktop application built on Code-OSS, with Little's shell, identity and Agent. The PRD remains the product direction; it is not evidence that every planned feature exists.

## Current product

The native app includes Home/Files/Search/Git/Terminal/Agent navigation, custom outline icons, light/dark appearance, a supplied logo and local fonts. ASK and PLAN read project sources; EDIT proposes changes for native review; supervised AGENT adds visible plans and individually approved checks. Selected project context goes to Groq when Groq is used. The encrypted key stays in native SecretStorage. An installed local Ollama runtime is a separate provider choice.

File tools cover UTF-8 code/text, Jupyter notebook source cells, DOCX paragraphs, PPTX slides and text-based PDF pages. Changes use review and exact-byte checkpoints. Notebook cells are not executed. DOCX/PPTX edits replace unique text within a paragraph; PDF edits append text pages rather than rewriting existing page layouts. Scanned-PDF OCR, legacy DOC/PPT, encrypted documents and arbitrary binary content edits remain unsupported. Unknown regular binary files support metadata inspection and reviewed deletion.

Project chats and bounded notes persist locally. Approved local Streamable HTTP MCP, Git review, independent review workers and approved local browser snapshots are implemented. Installed-engine Ollama inference, broader MCP transports/authentication, interactive browser automation, accepted live-model edit/check workflows, richer orchestration and the complete PRD demo remain future acceptance work. See [the roadmap](roadmap.md), [file workflows](file-tools.md), [provider guide](providers.md) and [interface](interface.md).

## Verifiable journey

These are observed milestones, not invented launch dates or a claim of public release:

| Date (UTC) | Observed milestone | Local source |
| --- | --- | --- |
| 8 October 2026 | Standalone Little Code launched with Home, Agent, supplied logo and local fonts; repository mapping and packaged ConPTY were verified. | `desktop/screenshots/first-launch.json`, `desktop/screenshots/repository-index.json`, `desktop/logs/native-terminal-smoke.json` |
| 9 October 2026 | Custom shell and light-theme restart behavior passed 19 native checks; local provider, memory, MCP, Git, reviewer and browser fixtures passed. Native Groq source/notebook flow also passed. | `desktop/logs/native-shell-smoke.json`, `desktop/screenshots/features.json`, `desktop/logs/groq-live-native-acceptance.json` |
| 10 October 2026 | Format-aware file tools, native review and restoration passed; current 0.2.0 payload and unsigned Windows setup were independently verified. | `desktop/logs/native-file-tools-smoke.json`, `desktop/logs/native-groq-smoke.json`, `docs/installer.md` |

The final source check passed **459 of 460 tests**, with one platform-specific skip, plus TypeScript, lint and build. Native fixtures cover **15 file cases**, **20 reviews**, **eight exact-byte restores** and **30 Groq/history checks**. Five authenticated GPT OSS 120B file flows cover notebook/DOCX/PDF reads and two rejected proposals on generated fixtures, with 14 HTTP 200 responses. The two live proposals did not modify any file. Counts describe these recorded checks; they are not customer counts, arbitrary-document guarantees or accepted live project-workflow results.

## Download identity and requirements

Only a **Windows x64** package is currently available. The installer and pinned upstream template configure `MinVersion=10.0`; the Little template also configures `ArchitecturesAllowed=x64compatible`. The website may describe this package as Windows 10/11 x64, recommend Windows 11 and state that macOS, Linux and native ARM packages are unavailable. Broad hardware/OS validation is pending. The packaged app carries its own Electron runtime; end users do not need Node or an installed VS Code. Existing project language/toolchain dependencies are needed to run that project's checks.

The current unsigned setup is `LittleCode-0.2.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe`, **347,143,376 bytes** (347 MB decimal; 331 MiB), with SHA-256 `32ec825e0b94fadab7613dd453ca000c0aab5de19003b3bc65d11129b1a57369`. The unpacked payload is approximately **1.25 GB**. Recommend **8 GB RAM** and **4 GB available storage** as practical Little Code guidance, clearly labelled recommendations rather than benchmarked minimum requirements. Local models need additional storage/RAM and sometimes a GPU according to the selected model. Groq needs internet access and the user's API key; local Ollama needs an installed, running loopback runtime and a tool-capable model. Setup has not been executed; installation, upgrade, uninstall, signing and public release checks remain pending. See [installer identity and boundaries](installer.md).

Primary external references checked on 10 October 2026: [Electron's Windows 7/8/8.1 deprecation notice](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice) supports the Windows 10-or-newer runtime baseline; [upstream VS Code requirements](https://code.visualstudio.com/docs/supporting/requirements) are contextual editor guidance, not benchmark results for Little Code. Do not copy upstream VS Code's smaller download/footprint claims into this showcase.

## Public screenshots

The three selected screenshots show actual native UI in generated fixtures, including developer-host titles, local fixture model names and test markers. Captions must identify that scope. No fake users, testimonials, stars, adoption figures or unsupported platform download buttons should be added. Selected copies, per-file hashes, font licenses and caption guidance live in [asset provenance](../website/public/assets/PROVENANCE.md). These originals contain no API key, private project content or personal terminal path; raw light-theme captures with personal terminal paths were excluded.
