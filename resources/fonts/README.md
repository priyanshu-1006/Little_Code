# Little Code fonts

These fonts implement PRD § 6 without requesting a font CDN at runtime. The font
binaries are unmodified copies from pinned official releases. Complete SIL Open
Font License 1.1 notices are included beside them.

| Product role | CSS family | Local file | Normal weight range | Official release |
| --- | --- | --- | --- | --- |
| Brand and headings | Space Grotesk | `space-grotesk-variable.ttf` | 300–700 | [Space Grotesk 2.0.0](https://github.com/floriankarsten/space-grotesk/releases/tag/2.0.0) |
| Application UI | Inter | `inter-variable.woff2` | 100–900 | [Inter 4.1](https://github.com/rsms/inter/releases/tag/v4.1) |
| Code | JetBrains Mono | `jetbrains-mono-variable.ttf` | 100–800 | [JetBrains Mono 2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304) |

Inter's intrinsic variable family name is `Inter Variable`; a local `@font-face`
may register it under the product's `Inter` CSS family. Its `opsz` axis runs from
14 to 32; `font-optical-sizing: auto` lets the browser select it. Declare each
file's complete `font-weight` range and `font-style: normal`. Keep system fallbacks
for characters outside a font's coverage and preserve the configurable code font.

`provenance.json` records each official release, exact source commit, download URL,
byte length, SHA-256 hash, font version, and variable axes. The three font binaries
total 792,060 bytes. Font table bounds, WOFF2 Brotli data, variable axes, and all
six font/license hashes were checked using Node's built-in libraries.

When copying fonts into the workbench or bundled extension, include the matching
OFL notices and provenance. A webview must allow local fonts through its CSP
(`font-src` with the webview's CSP source). The files require no installation in
the user's operating system and no new runtime dependency.
