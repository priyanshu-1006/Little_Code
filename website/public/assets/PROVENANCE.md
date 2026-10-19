# Little Code showcase assets

These are byte-for-byte copies of existing product resources and real native app screenshots. No product UI, text, customer identity, benchmark or feature was invented for the images. The three screenshots were visually inspected before selection and show an isolated generated `feature-project`; no API key, user project content or personal terminal path is visible.

## Screenshot captions and scope

- **workspace-home.png:** Actual Little Code Home and Little Agent after saved conversation restoration in a native Groq/history fixture. The image includes an Extension Development Host title and a fixture model label. It illustrates the custom shell and persisted chat interface; it is not a claim that a live provider is responding in this frame.
- **notebook-review.png:** Actual production notebook review UI in an isolated native file workflow. A code cell changes from `value = 1` to `value = 10`, with Accept changes and Reject controls visible. The request marker and local provider are test fixtures. The screenshot shows a pending proposal, before acceptance, and does not show notebook execution.
- **document-review.png:** Actual production DOCX text-replacement review UI in an isolated native file workflow, with a second PDF proposal tab. The request marker and local provider are test fixtures. The screenshot shows a pending proposal, before acceptance, and a source/text preview rather than rendered document layout.

Source evidence is retained privately in `desktop/logs/native-groq-smoke.json` and `desktop/logs/native-file-tools-smoke.json`. The latter covers native acceptance/rejection and exact-byte restoration separately. Authenticated live Groq reads and rejected proposals are recorded in `desktop/logs/groq-file-live-acceptance.json`; these screenshot fixtures do not establish accepted live-model edits.

The React documentation also includes four real memory, MCP, model-discovery and provider-cooldown captures. See [their provenance and hashes](docs/PROVENANCE.md). Installation steps are clearly labeled process illustrations; they are not installer screenshots.

## Original artwork and fonts

The logo comes from the user's `Little_code_logo.png`, whose SHA-256 is `cb43bcfe4ae81b14acb48e1f2a4f7493914d14b61a5bdc6e31ab168011e97060`. The existing platform resources preserve the full original canvas and colors using proportional resampling. The website copies the existing 512 px and 256 px transparent PNGs without further transformation.

Inter, Space Grotesk and JetBrains Mono are bundled locally, unmodified, under the SIL Open Font License 1.1. Their individual OFL files and the existing source/commit/hash metadata are included beside the fonts. See [font provenance](fonts/provenance.json), [Inter license](fonts/inter-OFL.txt), [Space Grotesk license](fonts/space-grotesk-OFL.txt) and [JetBrains Mono license](fonts/jetbrains-mono-OFL.txt).

## Copy identities

Paths below are relative to the repository root for sources, and to this assets folder for copied files. SHA-256 was checked against each original after copying.

| Website file | Source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| workspace-home.png | desktop/screenshots/features.groq-history-restored.png | 446375 | `274e4b29ed63fdb8a10feff7070ba544330038b38e32338597d740400c421d82` |
| notebook-review.png | desktop/screenshots/features.file-tools-notebook-patch-review.png | 207053 | `0425936fa6a5aefe8c6b51ded6cc08c13739bf543b19a952e68b75552a156d53` |
| document-review.png | desktop/screenshots/features.file-tools-documents-edit-review.png | 237942 | `75a1f31347fb00d5e867a7bb54d75c87d17edf0f8fa506a90ec147cb03a975bc` |
| little-code-logo.png | resources/app/little-code-512.png | 260365 | `1987e9dc3e978c93e2a37650ef247f8ab934d5999a4ec80ad76a2823576eb817` |
| little-code-icon.png | resources/app/little-code-256.png | 73050 | `eacb772ee0ea441920f25cef6edd0321c26c4b31a62ac5e831886d3da2226817` |
| fonts/inter-variable.woff2 | resources/fonts/inter-variable.woff2 | 352240 | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| fonts/space-grotesk-variable.ttf | resources/fonts/space-grotesk-variable.ttf | 136676 | `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72` |
| fonts/jetbrains-mono-variable.ttf | resources/fonts/jetbrains-mono-variable.ttf | 303144 | `662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016` |
| fonts/inter-OFL.txt | resources/fonts/inter-OFL.txt | 4380 | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |
| fonts/space-grotesk-OFL.txt | resources/fonts/space-grotesk-OFL.txt | 4495 | `564ce565c371c5e5bbf286006565a7c9aa55a9f56e7ca58d56e05d649dd61a72` |
| fonts/jetbrains-mono-OFL.txt | resources/fonts/jetbrains-mono-OFL.txt | 4399 | `30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad` |
| fonts/provenance.json | resources/fonts/provenance.json | 4875 | `1b3a4c769e193508be50b4d5ff9eac273acc9150739164e67d26552ae65cc459` |
