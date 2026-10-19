# Little Code React showcase

The product website is a React 19 application written in TypeScript. Its product tour, verified download flow, searchable documentation and community review screens share Little Code's original branding, local fonts and reviewed product captures. esbuild creates the browser bundle; React pre-renders every supported page before deployment, then hydrates it in the browser.

## Run locally

From the **repository root**, with Node 22 or newer (Node 24 recommended):

```powershell
npm.cmd ci
npm.cmd run website:check
npm.cmd run website:typecheck
npm.cmd run website:test
npm.cmd run website:dev
```

Open **http://127.0.0.1:4173**. Stop the owned preview with Ctrl+C. For another port use `npm.cmd run website:dev -- --port=4174`. Run `npm.cmd run website:build` after editing source: the preview serves generated `website/dist/`, not a live source watcher. `npm run website:check` always builds fresh output before validating it.

The local preview supports documentation deep links, the reviews API and a development-only verified installer endpoint. An installer download is offered only if its size and SHA-256 match `product.json`. It is never copied into the static deployment.

For optional browser acceptance, install Playwright in your development environment and run `node scripts/smoke-website.mjs` while the preview is running. `LITTLE_WEBSITE_PLAYWRIGHT_MODULE` can select an existing absolute Playwright module and `LITTLE_WEBSITE_BROWSER` an installed Chromium executable. The script uses an isolated headless browser, checks narrow layouts, docs/search/themes, installer identity and explicitly mocked review-form states, then writes ignored screenshots and a receipt under `desktop/`. It does not create public reviews or install the setup. The deployed website does not require Playwright.

## Deploy on Vercel

Import [priyanshu-1006/Little_Code](https://github.com/priyanshu-1006/Little_Code) after reviewing and pushing source:

| Setting | Value |
| --- | --- |
| Root Directory | Repository root; leave blank |
| Framework | Other |
| Node.js | 24.x |
| Install Command | `npm ci` |
| Build Command | `npm run website:build` |
| Output Directory | `website/dist` |

The root `vercel.json` includes these build settings, security headers, documented page routes and the same-origin `/api/reviews` Node function. Set `SITE_URL` to the final HTTPS origin for canonical/social URLs, or use Vercel's production-project URL. No desktop AI provider key belongs in the website.

Distribute the Windows setup as the exact pinned GitHub Release asset. Until the published tag, filename, size and GitHub SHA-256 digest match `product.json`, hosted visitors see an honest release status and the Releases link instead of an unverified direct download. Follow [the publication guide](../docs/github-publication.md).

## Enable real reviews

The review interface works without a database and clearly explains when submissions are unavailable. It does not invent testimonials, ratings or local-only public reviews. To accept persistent reviews, create the Supabase schema and set the **server-only** variables described in [reviews/README.md](reviews/README.md), then redeploy. Approve submitted reviews in Supabase before they become public. Never put a service-role credential in browser source, a `VITE_` variable or a Git commit.

Vercel runs the API separately from static files. Other static hosts can serve product and documentation pages, but need a compatible API deployment for reviews. A GitHub project-subdirectory Pages site also needs asset-base configuration; the supplied absolute URLs target an origin-root Vercel deployment or a custom root domain.

## Source map

| Path | Purpose |
| --- | --- |
| `src/main.tsx`, `src/App.tsx` | React hydration, routes and product showcase |
| `src/prerender.tsx` | Build-time page renderer |
| `src/docs/` | Documentation catalog and illustrated guide screens |
| `src/components/` | Download and community review interactions |
| `src/styles.css` | Responsive themes, motion and focus styles |
| `index.html` | HTML metadata and React shell |
| `product.json` | Pinned verified installer metadata; local path stays private |
| `public/assets/` | Logo, reviewed captures, fonts, licenses and provenance |
| `reviews/` | Persistent review database setup and moderation instructions |
| `dist/` | Generated public output; ignored by Git |

See [website maintenance](../docs/website.md) for release changes, build checks, privacy and verification limits.
