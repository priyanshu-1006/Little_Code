# Little Code desktop branding

The desktop build uses repository-owned Little Code assets rather than the
development extension host's application identity.

The selected artwork is the user's `Little_code_logo.png` at the project root.
It supersedes the PRD's earlier logo sketch. The original stays unchanged;
`resources/app/little-logo.png` is a byte-identical copy for application surfaces.
The supplied 1312 × 1199 PNG has genuine transparency. The complete canvas is
preserved, including the user's gradients, code brackets, star, and 3D shape.

`node scripts/generate-icons.mjs` converts that PNG into proportional PNG sizes,
a multi-resolution Windows ICO, macOS ICNS, and Windows installer BMPs in
`resources/app`. It averages premultiplied-alpha pixels when scaling and adds
transparent padding to square icons. Installer BMPs require an opaque background;
the logo is composited over the installer surface only. The SVGs are compatibility
wrappers embedding the supplied PNG, so native workbench paths can retain their
existing SVG filenames. The conversion does not redraw, crop, recolor, or add a
new app tile to the artwork, and needs only Node's built-in libraries.

`resources/app/logo-provenance.json` records the original dimensions, SHA-256, and
conversion policy. `--check` checks generated assets against the original source.
Use `--vectors` to refresh the canonical PNG and SVG wrappers without regenerating
binary icon sizes. App metadata and ICO resources must be refreshed in the desktop
executable after applying this recipe; copying `code.ico` beside an existing EXE
alone does not update its embedded Windows icon.

`manifest.json` is an idempotent branding recipe for the pinned Code-OSS build.
Paths under `assetCopies.target` and `textPatches.path` are relative to the
Code-OSS source checkout. Each text patch must match once, or already contain its
replacement; fail on an unexpected upstream version rather than silently shipping
Microsoft app branding. The identity fields and installation UUIDs are supplied by
the desktop setup script. Original source headers and MIT notices are retained.

Product service cleanup removes the stock Copilot agent, entitlements, plan links,
Microsoft voice endpoint, cloud webview CDN, update and sync services, automatic
Copilot updates, and privileged Copilot authentication access. The Little runtime
owns Groq configuration and model discovery. Keep the Code-OSS language, Git, and
debugger infrastructure. Marketplace and application update servers remain unset
until Little Code has release infrastructure; telemetry is disabled.

Some native contribution registrations can still show generic chat commands after
`defaultChatAgent` is removed. The Little shell contribution should own the default
agent surface and command center, and suppress stock promotional entry points with
the upstream `chat.disableAIFeatures` setting where appropriate. Do not rename
Copilot fields to Little: they describe a different API and require GitHub tokens.

The Electron application metadata and Windows installer publisher are Little Code /
Priyanshu Chaurasia. The inherited source keeps Microsoft attribution. Leave third
party DLL copyright metadata untouched; branded application metadata is scoped to
the app executable.

