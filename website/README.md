# Little Code showcase

A responsive static product website for Little Code, built from HTML, CSS and browser JavaScript. Warm paper, ink, electric purple, locally bundled fonts, the original Little Code logo and actual desktop captures define its appearance. It includes a light/dark switch, keyboard-accessible mode walkthrough, screenshot gallery, product timeline, requirements, FAQs and verified download discovery.

## Run locally

From the **repository root**, with Node 22 or newer:

```powershell
npm.cmd run website:check
npm.cmd run website:build
npm.cmd run website:dev
```

Open **http://127.0.0.1:4173**. Stop the preview with Ctrl+C. Use `npm.cmd run website:dev -- --port=4174` for another local port. Rebuild after editing source; the server serves `website/dist/`.

No npm install is required for these three website scripts. Desktop/agent development has separate dependencies and toolchain requirements in [development.md](../docs/development.md).

## Deploy on Vercel

Push the reviewed repository to [priyanshu-1006/Little_Code](https://github.com/priyanshu-1006/Little_Code), then import it into Vercel:

| Setting | Value |
| --- | --- |
| Root Directory | Repository root; leave blank |
| Framework | Other |
| Node.js | 24.x |
| Install Command | `node --version` |
| Build Command | `npm run website:build` |
| Output Directory | `website/dist` |

The root `vercel.json` includes these settings and security headers. No provider key or backend service is required. The desktop installer is distributed through GitHub Releases, separately from the static site.

Follow [the publication guide](../docs/github-publication.md) for source review, installer upload, checksum validation and deployment. Domain research is in [domains.md](../docs/domains.md).

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Product copy, real captures, tour, journey and download section |
| `styles.css` | Responsive appearance, dark theme, motion and focus styles |
| `app.js` | Theme, tour, mobile navigation, gallery and release lookup |
| `product.json` | Pinned verified installer metadata and GitHub repository |
| `public/assets/` | Original logo, approved captures, fonts and provenance |
| `dist/` | Generated deployable output; ignored by Git |

See [website maintenance](../docs/website.md) for release metadata, canonical/social URLs, verification scope and privacy behavior.
