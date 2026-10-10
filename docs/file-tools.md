# Agent file workflows

Little Code chooses file tools from the requested format and task. A relevant reader or writer remains advertised inside the provider request budget. Explicit file tasks require observed evidence and reviewed operation outcomes before a final answer can claim completion. A successful text-only response that skips required tools gets one bounded corrective continuation; provider errors are not retried automatically.

| Format | Read | Create/edit | Delete |
|---|---|---|---|
| UTF-8 code, Markdown, JSON, CSV and other text | `read_file`, `read_range`, literal search | `propose_file_edits`: create or unique literal replacements | `propose_file_edits`: delete |
| Jupyter `.ipynb` | `read_notebook`, including focused source lines within one cell | `propose_notebook_edits`: create, insert, replace, patch or delete code/markdown cells | Reviewed whole-file delete |
| Word `.docx` | `read_document`: paragraphs | `propose_document`: create or unique text replacements across runs | Reviewed whole-file delete |
| PowerPoint `.pptx` | `read_document`: slides in presentation order | `propose_document`: create or unique paragraph text replacements | Reviewed whole-file delete |
| Text-based `.pdf` | `read_document`: pages | `propose_document`: create or append new text pages | Reviewed whole-file delete |
| Other regular binary files | `inspect_file`: metadata and hash only | No binary content edits | Reviewed whole-file delete |

**Ask/Plan** can inspect files. Choose **Edit** for reviewed mutations or **Agent** for inspection, a visible plan, reviewed changes and approved checks. Source/file contents are untrusted evidence; instructions embedded in a notebook or document do not authorize commands or override the user's task. Creating a file starts with inspection of its target parent. Existing files need fresh source evidence; deleting a binary file can use its metadata instead.

For notebooks, use one-based cell numbers. Optional `startLine`/`endLine` selects up to 120 source lines when `startCell=endCell`. Edit operations apply sequentially to the current cell order. Whole-cell replacement/deletion requires matching `expectedSource`; a patch requires a unique literal `search`. Source lines use LF when constructing arguments. Changed code cells lose stale outputs and execution counts. Unrelated cells and metadata are preserved. These tools do not execute notebooks.

Document reads return paragraph, slide or page citations, up to 20 units and 12,000 output characters. Office reads omit images, embedded objects, notes and metadata; external relationships are not fetched. OOXML archives have limits on input size, entries, expansion, XML and source text. PDF text extraction runs in an isolated worker with memory and time limits and locally bundled parser assets.

Document creation uses simple text formatting. DOCX content lines become paragraphs. PPTX uses `---` between slides and each slide's first line as its title. DOCX/PPTX replacement searches must match once within one paragraph; unrelated package parts remain intact, though changed text can wrap differently. PDF `append_text` adds pages and preserves existing page content; arbitrary in-place PDF text/layout replacement is unavailable. PDF creation uses standard fonts and rejects unsupported characters explicitly. Text previews are not rendered-layout verification.

Legacy `.doc`/`.ppt`, encrypted documents, macros and scanned-PDF OCR are unsupported. Unknown binary content cannot be summarized from metadata. The agent must disclose these limits instead of inventing a read or edit.

Every mutation waits for **Review diff → Accept changes**. Rejection writes nothing. Accepted files have exact-byte checkpoints, including deleted or binary originals. Fresh policy, dirty editors/notebooks, original hashes and file identities are checked again before application. Restore conflicts preserve later external changes; files must stay within the trusted workspace, outside sensitive/ignored/generated paths, and have existing parent directories.

Open the current app with `LittleCode.lnk`, then run **Developer: Reload Window** if it was already open. Open the folder containing your files and choose a tool-capable provider model. Use paths relative to that folder in requests, for example:

- **Ask:** `Read lessons/training.ipynb and explain each code cell. Cite cells and source lines; do not execute it.`
- **Ask:** `Read docs/report.docx, slides/demo.pptx and docs/spec.pdf. Summarize each with paragraph, slide or page citations.`
- **Edit:** `Read lessons/training.ipynb. Add a markdown explanation before cell 2, preserving other cells and metadata.`
- **Edit:** `Create docs/summary.docx from the inspected report, then show the proposal for review.`
- **Agent:** `Inspect src/example.ts, publish a plan, make the requested change and run the existing relevant check after I accept it.`
- **Edit:** `Delete drafts/obsolete.pdf.` The agent inspects metadata before proposing the reviewed deletion.

The **Activity** entries show actual tool starts and results. A review card means the operation is waiting for you; open **Review diff**, inspect the text or source preview, and choose **Accept changes** or **Reject**. A completed chat answer alone is not an accepted edit. The checkpoint card provides **Restore changes** after an accepted operation. If a file is open with unsaved changes, save or discard them before requesting another proposal.

The current build passed [15 native file cases](../desktop/logs/native-file-tools-smoke.json), including 20 reviews and eight exact-byte restorations. These use an isolated workspace and scripted local provider with the unchanged production bundle. [Five authenticated Groq GPT OSS 120B cases](../desktop/logs/groq-file-live-acceptance.json) separately verified notebook/DOCX/PDF reads, a notebook edit proposal and metadata-first slide-file deletion; both live proposals were rejected and original bytes stayed unchanged. [30 native Groq/history checks](../desktop/logs/native-groq-smoke.json) also passed, including saved-chat restoration without request or action replay. This evidence covers the recorded flows, not arbitrary document layouts or every model.
