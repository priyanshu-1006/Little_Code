# Showcase architecture and maintenance

The showcase introduces Little Code, explains its current workflow and journey, and offers the verified Windows preview. It is an independent static site under `website/`, suitable for Vercel or GitHub Pages. It does not run the coding agent in a visitor's browser.

## Build and preview

The website scripts use Node's standard library. `npm run website:check` builds fresh output and validates linked assets, identifiers and release metadata. `npm run website:build` copies approved source and public assets to `website/dist/` and generates `release.json` from an explicit set of public fields. The installer and the local installer path are excluded from the deployable output.

`npm run website:dev` serves that output on `127.0.0.1:4173`. Its development-only `/api/release` endpoint verifies the existing local setup and reports whether download is available. The `/downloads/` handler serves only the pinned installer and supports resumable byte ranges. An absent or changed installer leaves the page usable with a GitHub Releases link. These endpoints are not deployed to Vercel.

Use [website/README.md](../website/README.md) for commands and [github-publication.md](github-publication.md) for Vercel configuration.

## Release links

`website/product.json` pins version, tag, filename, byte size and SHA-256. For 0.2.0, the existing verified setup is 347,143,376 bytes with SHA-256 `32ec825e0b94fadab7613dd453ca000c0aab5de19003b3bc65d11129b1a57369`.

On a hosted site, browser JavaScript asks the public GitHub Releases API for the pinned tag. A direct button appears only for a published release whose uploaded asset matches **filename, byte size and GitHub's SHA-256 digest**, with a download URL inside the configured repository. Missing releases, mismatches, API limits and network failures leave a working Releases link and an honest status message. This checks publication metadata; visitors can independently hash their downloaded file using the displayed checksum.

Before changing metadata:

1. Build and verify a new setup from its reviewed source.
2. Update the root product version and `website/product.json` with verified values.
3. Review all version/date/capability copy and public release notes.
4. Run website checks/build, audit source, and verify the actual installer using `scripts/github-release-check.mjs`.
5. Publish the matching GitHub Release asset, verify its digest and try the public download from a Vercel preview.

Do not put `.exe` files in `website/public/` or Git. See [public release notes](release-v0.2.0.md) for the current preview's acceptance scope and limitations.

## Canonical and social URLs

Once the production URL is known, set `SITE_URL` to its full HTTPS origin, for example `https://littlecode.app`. The build can also use Vercel's production-project URL when supplied by the platform. Without a confirmed URL, it omits invented canonical URLs. A configured URL produces canonical, Open Graph URL and social-image metadata using the bundled product capture.

After buying a domain you control, add it in Vercel's project settings and follow the exact DNS records Vercel provides. Rebuild with the final canonical URL and confirm redirects/HTTPS. Availability research and registrable-parent guidance are in [domains.md](domains.md).

## Accessibility, motion and privacy

Semantic sections, a skip link, visible keyboard focus, roving mode tabs, native disclosure controls and a modal screenshot gallery support keyboard navigation. Gallery closure returns focus to its trigger. Motion honors `prefers-reduced-motion`; content remains visible when JavaScript is unavailable. The mobile menu exposes its expanded state and closes with Escape.

Appearance preference is the only browser-local persisted value. Storage failure does not prevent use. Fonts and product imagery are bundled locally. There are no analytics, sign-up forms or credential inputs. The browser contacts the configured public GitHub API to discover release availability; download opens GitHub asset delivery. Vercel and GitHub may keep their own access logs.

The four-mode walkthrough is illustrative and never calls an AI provider or changes files. Real screenshot captions identify isolated development fixtures. File support, Windows requirements and future work describe the preview actually built. RAM/disk recommendations are not benchmarked minimums; local Ollama model requirements vary.

## Asset provenance

`website/public/assets/PROVENANCE.md` records original logo and capture sources and hashes. The bundled Inter, Space Grotesk and JetBrains Mono fonts retain their OFL notices and provenance. Review any future screenshot in full before adding it: exclude keys, real user prompts, private source and personal machine paths.
