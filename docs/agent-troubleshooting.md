# Agent responses and recovery

The October 10 file-tool repair addresses an additional gap: optional format readers could be removed by the request budget, and a successful text-only answer could finish without inspecting the requested file. Format-specific tools are now retained for explicit tasks, and the runtime checks fresh reads and reviewed outcomes before accepting completion claims. See [file workflows and supported formats](file-tools.md). Read requests work in Ask/Plan; mutations require Edit/Agent and native review.

Repository questions exercised a different request path from simple conversation. The earlier GPT OSS adapter forced answers and local actions into a strict JSON response schema. Application logs confirmed `json_validate_failed` on codebase analysis after the request was accepted; passing small fixture calls had not established that broader path. A simpler schema also failed live testing. The current adapter uses Groq's native local tool calling with streamed text, original tool definitions and matched assistant/tool history. GPT OSS parallel calls are disabled. See [provider design](providers.md) and [Groq's tool-use documentation](https://console.groq.com/docs/tool-use/overview).

There was also a notebook context gap: `.ipynb` files were inventory metadata, while generic readers could expose serialized outputs. The [notebook reader](../src/little/tools/notebook-source.ts) now extracts only code/markdown cells with original cell and source-line citations. Generic reads use that same extraction; JSON line ranges, output metadata, raw JSON selections and notebook execution diagnostics are excluded. Automatic context reads are capped at 1 MiB, while explicit `read_notebook` permits protected files up to 8 MiB and at most 20 cells per call. Omitted source is labelled rather than claimed as verified. See [repository context](repository-context.md).

The exact reported prompt, `analyse the notebooks and codebase for me`, completed through the real native Groq provider on an owned notebook/Python fixture. It returned source facts and cell citations with real read operations. This proves that tested request flow, not every repository or model answer. Model quality and a full live reviewed edit/check workflow remain separate acceptance work.

Chats previously lived only in the window's in-memory event list. The new [saved conversation store](conversations.md) persists project chats and restores them on restart. It saves bounded redacted display text and completed-turn follow-up context. Restoring a chat never replays tool calls, approvals or checkpoint actions. Conversations closed before this implementation cannot be reconstructed from discarded memory.

Load the update and retest:

1. Run **Developer: Reload Window** in Little Code, or close and reopen **LittleCode.lnk**.
2. Open your local project. In Little settings, connect Groq and discover models; retain a discovered coding model with remaining allowance.
3. In **Ask**, submit `analyse the notebooks and codebase for me`. Check the included context and cell/file citations. Ask a focused follow-up for files omitted by the visible budget.
4. Close and reopen the same project to check the saved chat selector. Use **New chat** for a separate conversation.
5. After a quota failure, review reset details and wait for the shown cooldown or choose another available model. **Prepare retry** restores the prompt; sending it starts a new request.

| Error | Meaning and recovery |
|---|---|
| `PROVIDER_AUTH_FAILED` | The native key is missing, invalid or no longer authorized. Reconnect it through the masked Little settings dialog. |
| `PROVIDER_RATE_LIMITED` | The account/model quota was exhausted. The card uses observed numeric limits and reset timing. An oversized request needs a smaller payload; waiting cannot raise the allowance. |
| `PROVIDER_PROTOCOL_ERROR` | The provider rejected parameters or returned malformed/incomplete function data. No call from a failed response executes. Safe phase/category/request identifiers appear in **Output → Little Code**. Submit an explicit retry after the cause is addressed. |
| `PROVIDER_UNAVAILABLE` | The provider could not be reached or failed upstream. Check the connection and retry. A transient model refresh preserves the valid cached catalog for the same credentials. |
| `CONTEXT_LIMIT` | The request or source exceeds a bounded limit. Narrow the task or read a smaller notebook cell range. |
| `PERMISSION_DENIED` | Workspace policy, mode restrictions or a pending confirmation prevents the action. Inspect the relevant trust/ignore/review state. |

HTTP and SSE errors share a private classifier. Provider bodies, private failed generation and organization identifiers are never rendered or used to repair executable calls. Generation has no automatic retry. The full native wire body, recent source observations and output reserve share the conservative request ceiling and observed quota pacing.

Ask and Plan remain read-only. Edit requires native diff review and acceptance. Agent requires source inspection and a visible plan before mutation; every project check needs its own native confirmation. A passing command result reports only the checks actually observed. Source excerpts and model prose cannot grant permissions.
