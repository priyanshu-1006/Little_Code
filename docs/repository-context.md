# Repository indexing and context

Open a trusted local project in Little Code. **Project intelligence** in the Agent panel builds its local map automatically, without a Groq key. The card shows file/declaration counts, progress, limited-map notices, and a refresh control. Saved file changes trigger a debounced update. The map lives in memory and is rebuilt after restarting the extension host.

[RepositoryHost](../src/extension/repository-host.ts) keeps at most three local project maps, watches file changes, and pauses background refreshes while an Agent run owns the index. Each model context or repository-tool query refreshes current inventory and policy before using metadata. [WorkspaceService](../src/little/tools/workspace-service.ts) applies root and nested `.gitignore`/`.littleignore` rules, credential-path exclusions, generated/vendor exclusions, and workspace boundaries. Inventory omits symbolic links, junctions, and hard-linked files.

## Incremental local map

[RepositoryIndex](../src/little/context/repository-index.ts) caches relative paths, language, size/mtime, declaration names and one-based lines, static imports, and bounded identifier terms. It does not retain raw source contents or write an index into the project. Unchanged files reuse metadata; size, mtime, ctime, inode/device identity, explicit invalidation, deletion, movement, and refreshed ignore rules determine reuse. Inventory is checked again before committing a completed generation. Cancellation or a concurrent change cannot publish a partial cache as ready.

The parser uses lexical heuristics for JavaScript/TypeScript, Python, Go, and Rust. It masks comments/literals and preserves line positions, including non-ASCII source and redacted private-key blocks. This is not an AST, language-server symbol database, embedding search, or complete dependency graph. Unsupported languages, oversized/binary files, source beyond the bounded read prefix, and capped metadata can leave a limited map.

| Boundary | Current limit |
| --- | --- |
| Inventory | 2,000 files, 5,000 visited entries, 24 directory levels |
| Aggregate index source reads per refresh | 8 MiB |
| Source file | 256 KiB; analysis uses the protected read's first 20,000 characters |
| Metadata per file | 120 declarations, 80 imports, 300 identifier terms |
| Term/import length | 50 / 256 characters |
| Model repository-tool observation | 18,000 serialized characters |

Skipped reads caused by the aggregate byte budget are retried on a later refresh after reusable files. Missing metadata is reported rather than represented as complete project understanding.

## Query context and provenance

[Ranking](../src/little/context/retrieve-context.ts) combines task references, path terms, declaration names, identifier terms, active/open files, diagnostics, and direct relative import neighbors. Scores are deterministic and configurable numerical weights; they are not probabilities or accuracy estimates. The model receives fresh protected source reads from up to six ranked files, with one-based line citations and explicit selection reasons. Cached source text is never substituted for these reads. Newly ignored, missing, private, oversized, or non-text context files are omitted; cancellation propagates.

Broad requests such as “tell me about the codebase” use an overview strategy: root project documentation/manifests and diverse workspace architecture paths receive priority. Conversational terms such as “about” do not steer an overview toward About/profile screens. This is a bounded heuristic, not a complete architecture analysis. Focused requests for an About component still use ordinary lexical ranking. A limited map and shortened excerpts remain visible, and the model must use focused source tools when more evidence is needed.

[collectContext](../src/little/context/collect-context.ts) shares a 20,000-character budget between explicit selection, project instructions, active editor buffer, permitted open paths, diagnostics, retrieved snippets, and a compact map. Selection/instructions have 2,200-character allocations, active content 2,400, diagnostics 1,600, open paths 500, and compact metadata 1,800. Each retrieved excerpt is capped at 1,600 characters and 32 lines. The aggregate limit includes section text and headers. Context chips display why each source was included and estimated tokens; estimates use characters, not provider tokenization. An active unsaved buffer is labeled separately from retrieved disk source.

The runtime applies a second [full-request budget](agent-runtime.md), measuring the same serialized native request as the Groq transport. Tool schemas, canonical observations and up to 2,048 GPT OSS output tokens fit a conservative 5,500-token ceiling. Optional tools and evidence may be shortened with visible notices. Provider usage remains separate from these estimates.

Fresh tool observations are shortened against the actual escaped wire size before older exchanges are summarized. Complete action arguments and outcome ledgers stay intact; omitted source is not verified evidence. Native fixtures verify that real read results reach follow-up requests without automatic replay.

The exact notebook/codebase prompt now completes through native Groq on an owned notebook/Python fixture with actual reads, cell citations and source facts. This establishes the tested flow, not exhaustive semantic analysis or live edit/check acceptance. Short standalone Ask greetings continue to skip repository collection and tools.

The local index does not send data to a provider. Submitting an AI request sends selected context and subsequent tool results to the chosen Groq or Ollama provider, as described in the connection flow. Ignore rules and redaction remain heuristic privacy controls.

## Repository tools

Notebook files use source-cell extraction rather than serialized JSON lines. Automatic indexing/retrieval reads notebooks up to 1 MiB, extracting bounded code/markdown source and lexical terms without claiming an AST or assigning false JSON-line symbols. Explicit `read_notebook(path, startCell, endCell)` supports files up to 8 MiB, at most 20 cells per range and bounded source previews. Saved outputs, images, attachments, execution counts and metadata are excluded. Generic `read_file` uses the same source extractor for notebooks; `read_range` directs notebook callers to cell ranges, text search skips notebook JSON with a notice, active notebook buffers are parsed, and raw selections/diagnostics without cell provenance are omitted. Current ignore, sensitive-path, UTF-8, boundary and cancellation policy applies before parsing.

The selected chat's recent completed turns can add at most 3,000 characters of labelled untrusted recollection. This is budgeted context, not freshly verified repository evidence or action authorization. See [saved conversations](conversations.md).

All four modes can use these SAFE tools:

- `get_repository_map`: a bounded metadata listing with declaration/import hints.
- `find_relevant_files`: up to twelve ranked candidate paths with reasons.
- `search_symbol`: up to fifty literal-name declaration matches and line hints.

Each tool refreshes the index before querying. Results explicitly ask the model to verify current code with `read_file` or `read_range`. Metadata and automatically gathered initial context do not satisfy AGENT's source-inspection prerequisite; the runtime still requires an actual source read and a published plan before edits or commands.

## Reproducing acceptance

~~~powershell
npm.cmd run check
npm.cmd run desktop:agent
npm.cmd run desktop:smoke-repository
~~~

The repository smoke opens the actual packaged executable with an isolated generated project/profile. It checks native Home/right Agent/logo/fonts and all four modes, disconnected Groq and native key-dialog cancellation, a visible ready index, manual refresh with unchanged-file reuse, a real new-file watcher update, and updated ignore policy. It closes only its owned app instance and records [the screenshot](../desktop/screenshots/repository-index.png) and [report](../desktop/screenshots/repository-index.json). Fixture tests separately cover relevance, import neighbors, fresh reads, ignored/credential/linked paths, cancellation, byte/file limits, line provenance, and the Agent inspection gate.

The [current full check](../desktop/logs/little-check-groq-live.log) ran 356 tests: 355 passed, one expected POSIX-only Windows skip, zero failures, with TypeScript, lint and build exiting 0. Persistent indexing, AST/LSP integration, richer dependency analysis, semantic retrieval, broad large-repository performance, and broader live Groq repository acceptance remain future work.
