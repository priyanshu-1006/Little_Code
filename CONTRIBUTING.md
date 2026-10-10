# Contributing to Little Code

Little Code is an independent desktop application built on pinned Code-OSS source, with a host-neutral agent runtime and a separate static product website. Read [the architecture](docs/architecture.md), [development guide](docs/development.md) and [file-tool guide](docs/file-tools.md) before changing behavior.

The maintainer has not yet selected a license for original Little Code source. Public visibility alone does not grant an open-source license; check the repository’s eventual LICENSE before reuse or submitting contributions under assumed terms. Existing upstream and font notices retain their own terms.

## Local verification

Use Node.js 24 and Git. From the repository root:

```sh
npm ci
npm run check
npm run website:check
npm run website:build
node scripts/repository-audit.mjs
```

`npm run website:dev` serves the showcase locally. Root agent checks build the extension bundles; they do not compile or launch the full desktop application. Native Windows builds require the pinned compiler, SDK and toolchain described in the development guide. Do not check in `.upstream`, build output, installer files, smoke profiles, logs or user screenshots.

## Scope and review

Keep changes focused and describe resulting behavior. Agent work should preserve workspace boundaries, bounded context, explicit native review of writes, exact-byte checkpoints and private credential storage. Add meaningful tests for new behavior or a regression; avoid tests that only restate implementation. Document supported formats and limitations alongside tool changes.

Use minimal synthetic fixtures. Never put a real API key, user repository, notebook output, private document, saved conversation or credential database into a test or issue. Repository audit reports locations without printing suspected values. It is a heuristic preflight, so review the staged diff as well.

Open a pull request using the supplied template. State exactly which checks passed and whether evidence came from fixtures, a real provider, the packaged app or an installed setup. CI performs source and website checks on Windows and Linux. Native packaging and authenticated provider acceptance are separate, deliberate checks.
