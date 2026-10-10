# Security

Little Code 0.2.x is an early preview. Use the latest verified release and review every proposed write or command before approval. The current Windows setup is unsigned.

## Reporting a vulnerability

When the GitHub repository is created, the maintainer should enable **Settings → Security → Private vulnerability reporting**. Use **Security → Report a vulnerability** to report a workspace escape, unexpected execution, credential exposure or unauthorized mutation privately. If that button is unavailable, use the maintainer’s published private contact channel; no contact address has been invented here.

Do not open a public issue containing secrets or an exploit against a private project. Include the product version, operating system, affected mode/provider, minimal synthetic reproduction, expected behavior and observed impact. Redact credentials, personal paths and source content. An ordinary bug report may contain a safe error code, but attach full logs only after reviewing them.

## Relevant boundaries

Provider keys live in native SecretStorage. Conversation history, project memory and checkpoint files are local application state and must not be committed. Workspace tools enforce path, trust, size and permission checks. Document input and tool output are untrusted data. Mutations go through native review and checkpoint recovery; that review is part of the supported workflow.

Ollama and browser integrations use restricted loopback endpoints. MCP integration is bounded and should be configured only for servers you trust. Public release CI does not receive provider keys or run authenticated agent tasks.

Dependency review and the repository audit help identify risks, but neither replaces full threat modeling, code signing or release acceptance. The repository audit checks current files rather than all Git history.
