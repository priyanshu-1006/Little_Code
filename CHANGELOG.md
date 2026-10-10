# Changelog

This records implemented product changes. Preview availability and supported platforms are stated in the release notes; roadmap items are not presented as delivered features.

## 0.2.0 — File-aware agent preview

- Dedicated notebook, DOCX, PPTX and PDF readers with bounded source evidence and citations.
- Reviewed text/notebook/document creation and editing, whole-file deletion and exact-byte recovery.
- Required target evidence and filename-safe routing before the agent claims file work.
- Provider request-budget handling, native Groq tool calls and persistent project conversations.
- Static product showcase with product journey, supported-platform guidance and configurable release downloads.
- GitHub source audit, source/website CI, community templates and manual Pages deployment workflow.

PDF mutation currently appends pages; scanned-PDF OCR and legacy `.doc`/`.ppt` operations are not supported. Native fixture acceptance and live-provider rejection/read tests cover different scopes; they do not establish all PRD features or accepted live mutations.

## 0.1.0 — Standalone foundation preview

- Separate Little Code desktop identity on pinned Code-OSS, supplied branding, custom navigation and light/dark themes.
- Ask, Plan, Edit and Agent modes; project intelligence and bounded repository context.
- Groq and local Ollama adapters, local memory and bounded MCP integration.
- Reviewed command/file workflows, Git review, local browser inspection and Windows user setup packaging.
