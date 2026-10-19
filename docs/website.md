# Showcase architecture and maintenance

The website is a React 19/TypeScript showcase for Little Code. It includes the product tour, verified Windows download process, illustrated documentation and persistent community reviews when the optional backend is configured. It does not run the coding agent in a visitor's browser. Vercel is the intended host.

## Build and routes

Install the root lockfile with `npm ci`. `npm run website:build` bundles `website/src/main.tsx` with esbuild into `app.js` and `app.css`. A separate Node/React renderer produces complete HTML for `/`, `/docs`, `/reviews` and every supported guide, so documentation content and navigation are available before browser JavaScript runs. React hydrates those pages for search, themes, menus and review interactions.

The build copies only approved `website/public/assets/`, generated route HTML, browser bundles, `routes.json` and an allowlisted `release.json` into `website/dist/`. Installer files, the local installer path, API server code, service credentials, source maps and database configuration are excluded. Source files imported by the browser must never include private `product.json`: the esbuild `__LITTLE_RELEASE__` constant contains its public fields only.

`npm run website:check` builds fresh output and checks every pre-rendered page's metadata, primary heading, IDs, local links, image descriptions/dimensions and accessible references. It checks bundle syntax, public release identity, private-path markers, asset copies and the bundled font/license SHA-256 hashes. Dedicated Node website tests cover local routes, HTTP methods, review-unconfigured handling and installer authorization/ranges.

`website/src/docs/catalog.ts` defines guide slugs, titles and descriptions. When adding a guide, implement the page, update the catalog and the restricted guide rewrite in `vercel.json`, then run checks. Known paths receive route-specific titles/descriptions/canonical URLs; unknown routes stay 404 instead of masking missing APIs or assets with the SPA shell. Assets and links use absolute origin-root paths. Repository-subdirectory GitHub Pages hosting needs a separate asset/router base; the complete reviews experience requires a function host.

## Local preview and Vercel

`npm run website:dev` serves the generated output on `127.0.0.1:4173`. Rebuild after editing; this server is a preview, not a source watcher. Stop it with Ctrl+C. `/api/reviews` delegates to the same handler used on Vercel. Without backend configuration it reports an explicit unavailable state.

Development-only `/api/release` verifies an existing local setup by size and SHA-256; `/downloads/` serves only that exact installer and supports resumable byte ranges. Replaced or changed files invalidate authorization. A verified held descriptor is separate from each transfer so cancellation does not corrupt other downloads. These two local endpoints are not deployed on Vercel; hosted download discovery uses GitHub Releases.

Use [website/README.md](../website/README.md) for commands and [github-publication.md](github-publication.md) for deployment. Root Vercel settings are Other, Node 24.x, install `npm ci`, build `npm run website:build`, output `website/dist`. The repository root also contains the independent `api/reviews.mjs` function; page rewrites never swallow `/api/`.

The October 19 React checks passed 14 pre-rendered routes, 585 local references and six font/license hashes. The dedicated suite passed 35 tests: 20 review API tests, six download identity tests and nine build/HTTP integration tests. Website TypeScript and frontend lint passed after the tactile design refinements.

The final isolated browser run passed 354 assertions and exited successfully. It covered the tactile navbar and keyboard disclosure controls, modes/frameworks, documentation search, screenshot dialogs and focus restoration, checksum copying, persisted themes and mobile navigation. Thirty route/viewport cases checked readable prose, heading structure and no page overflow at 320/360/390/768/1024/1440 pixels; all nine framework panels also fit at 320 pixels. Documentation captures have intrinsic dimensions, descriptive labels and readable captions. The review-form success path used an explicitly mocked service and remained pending without inflating the published rating. There were no browser JavaScript errors. The optional reproducible check is `node scripts/smoke-website.mjs`; its local screenshots and receipt stay ignored under `desktop/`. The October 10 receipts describe the previous static site separately.

The material design layer is `website/src/tactile.css`; navigation lives in `website/src/components/SiteHeader.tsx` and its scoped stylesheet. `website/src/docs/field-guide.css` controls article sheets, reading measures, outlines and figure formatting. Seven real product screenshots are distinguished from the labeled installation process illustration.

These local/mock results do not establish a deployed database, Vercel function or public GitHub download. Exercise the actual hosted submission → moderation → published rating and setup download after configuring those services.

## Download publication

`website/product.json` pins version, tag, filename, byte size and SHA-256. The current 0.3.0 setup is 347,230,859 bytes with SHA-256 `d6c9f69746e2ffed717f7b0a5e96a3ce6bec55e4b8f119e78be12851a7baf9d3`.

On Vercel, browser JavaScript requests the pinned public GitHub Release. A direct download is offered only for a published release whose uploaded asset matches **filename, byte size and GitHub's SHA-256 digest**, with a download URL inside the configured repository. A pending release, mismatch, API limit or network failure leaves a working Releases link and an honest message. This validates publication metadata; visitors can hash the downloaded file independently using the displayed checksum and installation guide.

Before changing release metadata:

1. Build and verify a new setup from reviewed source.
2. Update the root product version and `website/product.json` using measured values.
3. Review version/date/capability copy and public release notes.
4. Run website checks, repository audit and `scripts/github-release-check.mjs` against the actual installer.
5. Publish the matching GitHub asset, verify its API digest and exercise download from a Vercel preview.

Do not place executable installers in `website/public/` or Git. See [0.3 release notes](release-v0.3.0.md) for acceptance boundaries and [historical 0.2 notes](release-v0.2.0.md) for earlier provider/file results.

## Reviews, moderation and privacy

The UI lists and aggregates **approved** reviews from the same-origin `/api/reviews` endpoint. A successful submission is pending until the owner approves it. There are no invented testimonials and no browser-local reviews presented as public feedback. The unconfigured/error states disclose that reviews are unavailable instead of fabricating a score.

Follow [website/reviews/README.md](../website/reviews/README.md) to apply the Supabase schema, set server-only environment variables and moderate. The API validates fields, applies same-origin POST checks, bounds request size, uses a honeypot and asks the database to enforce rate limits using a salted IP-derived value. Backend moderation is still required. Visitors' public name, title, message, rating and optional version become public only after approval; do not ask them to include secrets or contact information. Supabase and Vercel retention/access policies also apply. Never put the service-role credential in frontend environment prefixes or static output.

Theme preference and any explicitly local form state are browser-local. Fonts and product captures are bundled. There is no analytics integration or desktop AI key input. The browser contacts the site's reviews API and the configured public GitHub Releases API; downloads use GitHub asset delivery. Hosting providers may keep access logs.

## Canonical URLs and assets

Set `SITE_URL` to the final HTTPS **origin**, for example `https://littlecode.app`. A subdirectory, query, fragment or credential is rejected because the router and assets use origin-root paths. The build can use `VERCEL_PROJECT_PRODUCTION_URL` when Vercel supplies it. Without a known URL, canonical/social-image URLs are omitted instead of invented. Each route receives its own canonical path when configured.

Add a domain you own through Vercel's project settings, apply the exact provided DNS records, verify HTTPS/redirects and rebuild. See [the dated domain shortlist](domains.md); an earlier availability check is not a purchase guarantee.

`website/public/assets/PROVENANCE.md` records the supplied logo, original product captures and documentation illustrations. Bundled Inter, Space Grotesk and JetBrains Mono retain their OFL notices/hashes. Review every screenshot before publication: exclude keys, private source, real user prompts and personal machine paths. Documentation illustrations must be labeled as illustrations, distinct from actual product captures.
