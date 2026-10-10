# Publishing Little Code on GitHub

The prepared source repository targets the existing [priyanshu-1006/Little_Code repository](https://github.com/priyanshu-1006/Little_Code). Local Git uses branch `main` and an HTTPS `origin` without embedded credentials. The intended website host is **Vercel**, deployed by the owner after pushing the reviewed source. Preparation does not commit or push source, upload an installer or publish the website.

## Review source before the first push

The source includes the agent runtime, native integration patches, build scripts, tests, product documents, supplied branding, licensed fonts and static website. Large upstream checkouts, dependencies, generated bundles, machine shortcuts, installer/staging directories, smoke profiles, captured user screenshots, logs and credential files are ignored.

```sh
node scripts/repository-audit.mjs
npm ci
npm run check
npm run website:check
npm run website:build
git status --short
```

The audit is read-only. It checks tracked and unignored files, size limits, protected ignore paths, known credential patterns and package/lockfile versions. Findings contain filenames and line numbers rather than suspected secret values. `--json` provides structured results; `--staged` checks the actual index. `--strict` also fails for advisory findings, including an unselected original-source license. It checks current files, not all Git history, and cannot establish a complete secret or license review.

Original Little Code licensing is still a maintainer decision. Public visibility alone does not grant open-source permission; choose publication and contribution terms deliberately, and retain upstream/third-party notices. The normal audit treats the missing original-source license as an advisory rather than blocking repository preparation. Product requirements may include local paths as historical examples; review those separately from generated personal data. The existing font files have their own OFL notices and provenance.

After reviewing the source and selecting publication terms:

```sh
git add .
node scripts/repository-audit.mjs --staged
git diff --cached --stat
git diff --cached
git commit -m "Prepare Little Code 0.2.0 and product showcase"
git push -u origin main
```

These are user-run publishing steps, not actions performed by the preparation workflow. Git author identity is already configured on this machine. Review the identity that will appear in commits using `git var GIT_AUTHOR_IDENT`; change local repository configuration if desired.

## Distribute the Windows installer through Releases

The verified current setup is:

| Field | Value |
| --- | --- |
| Product | Little Code 0.2.0 preview |
| Upstream | Code-OSS 1.141.0 |
| Platform | Windows x64 user setup |
| Asset | `LittleCode-0.2.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe` |
| Size | 347,143,376 bytes |
| SHA-256 | `32ec825e0b94fadab7613dd453ca000c0aab5de19003b3bc65d11129b1a57369` |
| Signing | Unsigned |
| Local folder | `desktop/releases/2026-10-10T04-49-25-203Z-08a1f71c/` |

Keep the setup outside Git. GitHub blocks ordinary Git files over 100 MiB and supports distributing binaries through Releases; each release asset must be under 2 GiB. This installer fits Release distribution. See [GitHub file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) and [release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Before upload:

```sh
node scripts/github-release-check.mjs --installer=desktop/releases/2026-10-10T04-49-25-203Z-08a1f71c/LittleCode-0.2.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe --sha256=32ec825e0b94fadab7613dd453ca000c0aab5de19003b3bc65d11129b1a57369
```

This verifies size, name, current version and the expected checksum; it does not replace the native acceptance receipts or code signing. For a new version, rebuild from its reviewed source, complete acceptance and update the verified metadata rather than reusing this checksum.

Create a **draft** release tagged `v0.2.0` from the final source commit. Attach the verified `.exe`, [plain-text SHA256SUMS](SHA256SUMS) and [public-safe release notes](release-v0.2.0.md) describing preview status, supported platforms, signing status and current document limitations. Review the draft, then publish it. Do not label unbuilt macOS, Linux or ARM packages as available.

After the asset is published, the pinned direct download URL will be:

```text
https://github.com/priyanshu-1006/Little_Code/releases/download/v0.2.0/LittleCode-0.2.0-CodeOSS-1.141.0-win32-x64-UserSetup.exe
```

That URL is a publication target, not evidence an asset already exists. The website’s `website/product.json` holds repository and release metadata. Hosted download activation requires the published release tag and an uploaded asset whose filename, byte size and GitHub SHA-256 digest exactly match that metadata. The API digest must be `sha256:32ec825e0b94fadab7613dd453ca000c0aab5de19003b3bc65d11129b1a57369`; a missing or different digest leaves the direct download unavailable. The download URL must belong to this repository’s release path. A local development preview separately verifies and serves the setup on this machine.

GitHub computes SHA-256 digests when release assets are uploaded and exposes them in its Releases API and UI. Its API documents the `digest` and `browser_download_url` fields; this site compares published metadata rather than downloading the entire installer in the browser to hash it. See [GitHub’s digest announcement](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/), [release asset API](https://docs.github.com/en/rest/releases/assets) and [release linking](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).

## Deploy the website on Vercel

The website is independent static HTML/CSS/JavaScript. Source lives under `website/`; `npm run website:build` writes `website/dist/`, which is ignored. Deploy only the generated website; the installer remains a GitHub Release asset.

After pushing the reviewed repository, import `priyanshu-1006/Little_Code` in Vercel and use these settings:

| Vercel setting | Value |
| --- | --- |
| Root Directory | Repository root; leave blank |
| Framework Preset | Other |
| Build Command | `npm run website:build` |
| Output Directory | `website/dist` |
| Install Command | `node --version` |
| Node.js Version | 24.x |

The root `vercel.json` records these build settings. The showcase build uses Node’s standard library, so the install command intentionally skips installing desktop/agent dependencies. Keep the Root Directory at the repository root because the build script and shared assets live outside `website/`. Vercel supports custom build/output settings and documents root-directory boundaries in [its build configuration guide](https://vercel.com/docs/builds/configure-a-build). Node.js 24.x is a supported Vercel version; see [the version guide](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

Deploy a preview first. Check desktop/mobile navigation, theme and motion preferences, the showcase controls and the actual published release download. No Groq, Ollama, MCP or user API credentials belong in Vercel environment variables for this static site. The local installer endpoint is for the local preview; it is not part of the hosted site.

When ready, deploy the reviewed `main` branch to production. Vercel’s Git integration can produce subsequent previews and production deployments from repository changes; review its configured production branch. See [Vercel deployment guidance](https://vercel.com/docs/deployments).

For a custom domain, open the Vercel project’s **Settings → Domains**, add the domain or subdomain you own, and apply the DNS records Vercel shows for that project. Wait for validation and verify HTTPS and any chosen redirects. A proposed name is not proof of availability or ownership. See [the dated Little Code domain shortlist](domains.md), update the website’s canonical/social metadata after selecting the actual domain, and follow [Vercel’s domain guide](https://vercel.com/docs/domains/working-with-domains/add-a-domain).

## Optional GitHub Pages deployment

The manual Pages workflow is an alternative to Vercel. Its artifact contains only the same website output and never the installer or desktop profile.

1. Push the reviewed repository and configure the release metadata in `website/product.json`.
2. In the GitHub repository, open **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Open **Actions → Publish showcase to GitHub Pages → Run workflow** on `main`.
4. Review the generated deployment URL and verify navigation, mobile layout and the real published download.
5. Optionally add a `push` trigger for `main` to `.github/workflows/pages.yml` after the first reviewed deployment.

The supplied workflow is manual so initial publication remains deliberate. Its build has read-only repository access; deployment uses the required `pages: write` and `id-token: write` permissions with the `github-pages` environment. Set environment protection so only the intended release branch deploys. See [GitHub’s custom Pages workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## CI and maintenance

`.github/workflows/ci.yml` checks source and showcase on Linux and Windows with Node.js 24. It installs the committed lockfile, runs the repository audit, TypeScript, lint, tests and production bundles, then checks/builds the website. It does not build native Code-OSS, run private authenticated provider tests or install the Windows setup.

Dependabot proposes weekly npm and Actions updates. Enable secret scanning and push protection where available, private vulnerability reporting, and branch protection requiring the CI jobs. Review generated screenshots and diagnostic receipts before attaching them publicly; local proof remains in ignored desktop folders. Vercel’s local `.vercel/` linkage state is also ignored.

## Share verification without exposing local data

Historical development documents link to `desktop/logs/` and `desktop/screenshots/`. Those links describe local verification receipts and will not resolve in a clean GitHub clone. Keeping those receipts local is intentional: they can contain usernames, fixture paths, user workspace information and diagnostic details.

Use [the bounded release summary](release-v0.2.0.md) as the public record. It contains supported capabilities, installer/bundle checksums, observed counts, test scopes and remaining limitations without private paths, credentials, prompts or raw logs. The committed tests and smoke scripts are the reproduction instructions; a statement of earlier observed results is not a guarantee they will reproduce in every environment.

If publishing a curated JSON receipt or screenshot later, generate it from an explicit allowlist of public metadata, review its complete contents, run the repository audit and attach only that reviewed artifact. Do not copy an entire ignored directory into Git or a Release. Keep source/CI results, native UI fixtures, live-provider tests and installer lifecycle checks distinct in public claims.
