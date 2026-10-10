# ADR 001: Host-neutral runtime inside a standalone Code-OSS desktop

Status: accepted; amended to make standalone desktop delivery the primary acceptance boundary.

## Decision

Little Code is a separate Electron / Code-OSS desktop application, as required by the PRD. Keep the provider-neutral runtime in `src/little` and use a thin bundled Code-OSS adapter to connect its React UI, structured events, tools, and storage to native editor services. Use the pinned upstream source and canonical `vscode-win32-x64` task to build a complete packaged application folder, with Little Home, the right-side agent, separate product identity, and its own profile. The packaged `Little Code.exe` is the primary launch target and carries its own runtime; opening it does not require Node or an installed VS Code.

The adapter may also run in an existing editor's extension development host for fast integration debugging. That workflow is an internal test harness. It is not the product, does not establish standalone startup, and cannot complete the PRD's first two stages.

## Rationale and consequences

A host-neutral runtime keeps provider and agent contracts testable while the Code-OSS workbench supplies professional editing, explorer, search, terminal, Git, and language features. A bundled extension boundary is an implementation choice within the app; it does not reduce the product to an external VS Code plugin. Native shell composition, startup behavior, branding, packaging, and distribution remain product responsibilities.

The original read-only slice established runtime and adapter behavior before native compilation. Its tests remain useful, but the desktop foundation was not delivered by those tests. The next acceptance gate must finish native installation, compilation, and packaging, open the packaged executable independently, and inspect the actual custom shell. The source-backed native Electron launch remains a debugging fallback. Node-based launch wrappers are optional; the direct executable and generated shortcut are the product run paths. Installer generation and release validation remain distinct steps, and no packaging or launch success is claimed before those checks pass.

## Scope and verification

ASK and PLAN currently expose read-only tools. AGENT writes, terminal execution, verification/repair, Git review, checkpoints, and rollback remain pending. Implement those capabilities in the PRD section 91 sequence with the necessary approval, workspace, cancellation, and recovery boundaries in place before exposing write or execution tools.

Verify core/transport/UI behavior through automated tests, then verify standalone startup, native editor services, layout, live Groq, cancellation, and restart through desktop smoke checks. Neither an extension-host launch nor a passing Little bundle build is evidence that the native desktop deliverable is complete.
