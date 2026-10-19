import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const websiteRoot = path.join(workspaceRoot, 'website');
export const websiteDist = path.join(websiteRoot, 'dist');
export const maxWebsiteBytes = 10 * 1024 * 1024;

export function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

// Never follow links while collecting publication or download inputs.
export async function regularPath(parent, target, directory = false) {
  const absolute = path.resolve(target);
  if (!isInside(parent, absolute)) throw new Error('A website input escapes its permitted directory.');
  const segments = path.relative(parent, absolute).split(path.sep);
  let current = parent;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error('Linked website inputs are not allowed.');
    const expectedDirectory = index < segments.length - 1 || directory;
    if (expectedDirectory ? !entry.isDirectory() : !entry.isFile()) throw new Error('A website input has an unexpected file type.');
  }
  const resolvedParent = await realpath(parent);
  const resolvedTarget = await realpath(absolute);
  if (!isInside(resolvedParent, resolvedTarget)) throw new Error('A website input resolves outside its permitted directory.');
  return absolute;
}

export async function websiteFiles(directory) {
  await regularPath(workspaceRoot, directory, true);
  const entries = [];
  async function walk(current) {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, item.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Linked website assets are not allowed.');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) entries.push({ file, relative: path.relative(directory, file).split(path.sep).join('/'), bytes: stat.size });
      else throw new Error('Unsupported website asset type.');
    }
  }
  await walk(directory);
  return entries;
}

export function publicRelease(product) {
  const fields = ['name', 'version', 'releaseDate', 'repository', 'releaseTag', 'releaseApi', 'releasePage', 'fileName', 'bytes', 'sha256', 'platform', 'unsigned'];
  const release = Object.fromEntries(fields.map(field => [field, product[field]]));
  if (release.name !== 'Little Code' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version ?? '')) throw new Error('Invalid Little Code release identity.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release.releaseDate ?? '') || Number.isNaN(Date.parse(release.releaseDate))) throw new Error('Invalid release date.');
  if (!Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > 2 * 1024 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(release.sha256 ?? '')) throw new Error('Invalid installer size or checksum.');
  if (typeof release.fileName !== 'string' || !/^LittleCode-[a-zA-Z0-9.-]+-CodeOSS-[a-zA-Z0-9.-]+-win32-x64-UserSetup\.exe$/.test(release.fileName) || !release.fileName.startsWith(`LittleCode-${release.version}-`)) throw new Error('Invalid installer filename.');
  if (typeof release.repository !== 'string' || !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(release.repository)) throw new Error('Invalid GitHub repository URL.');
  const repositoryPath = new URL(release.repository).pathname;
  if (release.releaseTag !== `v${release.version}` || release.releaseApi !== `https://api.github.com/repos${repositoryPath}/releases/tags/${release.releaseTag}` || release.releasePage !== `${release.repository}/releases`) throw new Error('Release URLs do not match the configured repository and tag.');
  if (typeof release.unsigned !== 'boolean' || typeof release.platform !== 'string' || release.platform.length > 100) throw new Error('Invalid release platform metadata.');
  return release;
}

export async function readProduct() {
  const productPath = await regularPath(workspaceRoot, path.join(websiteRoot, 'product.json'));
  const product = JSON.parse(await readFile(productPath, 'utf8'));
  const release = publicRelease(product);
  const packageMetadata = JSON.parse(await readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
  if (release.version !== packageMetadata.version) throw new Error('Website and application versions differ.');
  return { product, release };
}

function canonicalSite(env) {
  const configured = env.SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  if (!configured) return null;
  let url;
  try { url = new URL(configured); } catch { throw new Error('SITE_URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error('SITE_URL must be an HTTPS URL without credentials, query or fragment.');
  if (url.pathname !== '/') throw new Error('SITE_URL must name the website origin, without a subdirectory.');
  return url;
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function documentRoutes(documents) {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 100) throw new Error('Expected a bounded documentation catalog.');
  const routes = [
    { pathname: '/', title: 'Little Code — Your idea, in motion.', description: 'Meet Little Code, your AI-native coding workspace. Explore the product, download the Windows preview, read the guides and share your experience.' },
    { pathname: '/docs', title: 'Documentation · Little Code', description: 'Install Little Code, set up your AI provider and learn the editor, agent, notebooks, project creators and language runners with illustrated guides.' },
    { pathname: '/reviews', title: 'Community reviews · Little Code', description: 'Read community experiences and share a rating and review of the Little Code Windows preview.' },
  ];
  const slugs = new Set();
  for (const document of documents) {
    if (!document || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.slug ?? '') || slugs.has(document.slug) || typeof document.title !== 'string' || !document.title.trim() || typeof document.description !== 'string' || !document.description.trim()) throw new Error('Invalid or duplicate documentation route.');
    slugs.add(document.slug);
    routes.push({ pathname: `/docs/${document.slug}`, title: `${document.title} · Little Code Docs`, description: document.description });
  }
  return routes;
}

function routeHtml(shell, markup, route, site) {
  if (!shell.includes('<!--app-html-->')) throw new Error('The React HTML shell is missing its application marker.');
  let html = shell.replace('<!--app-html-->', markup)
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeAttribute(route.title)}</title>`)
    .replace(/(<meta\b[^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*\bcontent=)["'][^"']*["']/gi, `$1"${escapeAttribute(route.description)}"`)
    .replace(/(<meta\b[^>]*(?:name|property)=["'](?:og:title|twitter:title)["'][^>]*\bcontent=)["'][^"']*["']/gi, `$1"${escapeAttribute(route.title)}"`)
    .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>\s*/gi, '')
    .replace(/<meta\b[^>]*(?:property|name)=["'](?:og:url|og:image|twitter:image)["'][^>]*>\s*/gi, '');
  if (site) {
    const url = escapeAttribute(new URL(route.pathname, site).href);
    const image = escapeAttribute(new URL('/assets/workspace-home.png', site).href);
    html = html.replace('</head>', `  <link rel="canonical" href="${url}">\n  <meta property="og:url" content="${url}">\n  <meta property="og:image" content="${image}">\n  <meta name="twitter:image" content="${image}">\n</head>`);
  }
  return html;
}

export async function buildWebsite(env = process.env) {
  const { release } = await readProduct();
  const published = new Map();
  const shell = await readFile(await regularPath(workspaceRoot, path.join(websiteRoot, 'index.html')), 'utf8');
  const main = await regularPath(workspaceRoot, path.join(websiteRoot, 'src', 'main.tsx'));
  await regularPath(workspaceRoot, path.join(websiteRoot, 'src', 'prerender.tsx'));
  await regularPath(workspaceRoot, path.join(websiteRoot, 'src', 'docs', 'catalog.ts'));
  const define = { __LITTLE_RELEASE__: JSON.stringify(release), 'process.env.NODE_ENV': '"production"' };
  const bundled = await build({
    entryPoints: [main], bundle: true, write: false, outdir: websiteDist,
    entryNames: 'app', assetNames: 'assets/build/[name]-[hash]', format: 'esm', platform: 'browser',
    target: ['es2022'], jsx: 'automatic', minify: true, sourcemap: false, legalComments: 'eof',
    metafile: true, define, external: ['/assets/*'], logLevel: 'silent',
  });
  for (const file of bundled.outputFiles) {
    const relative = path.relative(websiteDist, file.path).split(path.sep).join('/');
    if (!isInside(websiteDist, file.path)) throw new Error('Unexpected React bundle output.');
    published.set(relative, Buffer.from(file.contents));
  }
  if (!published.has('app.js') || !published.has('app.css')) throw new Error('The React entry must produce app.js and import its stylesheet.');
  for (const asset of await websiteFiles(path.join(websiteRoot, 'public'))) {
    if (!asset.relative.startsWith('assets/') || /(?:^|\/)\./.test(asset.relative) || /\.(?:exe|dll|pfx|pem|key|db|sqlite|map)$/i.test(asset.relative)) throw new Error('Unexpected file in public website assets.');
    published.set(asset.relative, await readFile(asset.file));
  }
  const site = canonicalSite(env);
  const rendering = await build({
    stdin: { contents: "export { renderRoute } from './src/prerender.tsx'; export { documents } from './src/docs/catalog.ts';", resolveDir: websiteRoot, sourcefile: 'render-entry.ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
    jsx: 'automatic', define, logLevel: 'silent',
    plugins: [{ name: 'omit-render-styles', setup(builder) { builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'little-code-website-render-'));
  const requireRenderer = createRequire(import.meta.url);
  const renderFile = path.join(temporary, 'render.cjs');
  let routes;
  try {
    await writeFile(renderFile, rendering.outputFiles[0].contents);
    // This output is deliberately CommonJS. Loading its exact exports avoids
    // ESM loader wrappers changing the default shape under tsx or test runners.
    const renderer = requireRenderer(renderFile);
    if (typeof renderer.renderRoute !== 'function') throw new Error('Expected a React route renderer.');
    routes = documentRoutes(renderer.documents);
    for (const route of routes) {
      const markup = await renderer.renderRoute(route.pathname);
      if (typeof markup !== 'string' || !markup.includes('<')) throw new Error('React route rendering returned no markup.');
      const relative = route.pathname === '/' ? 'index.html' : `${route.pathname.slice(1)}/index.html`;
      published.set(relative, Buffer.from(routeHtml(shell, markup, route, site)));
    }
  } finally {
    delete requireRenderer.cache[renderFile];
    await rm(temporary, { recursive: true, force: true });
  }
  published.set('routes.json', Buffer.from(`${JSON.stringify(routes, null, 2)}\n`));
  published.set('release.json', Buffer.from(`${JSON.stringify(release, null, 2)}\n`));
  const bytes = [...published.values()].reduce((total, value) => total + value.length, 0);
  if (bytes > maxWebsiteBytes) throw new Error('Static website exceeds the 10 MiB publication limit.');
  // This exact generated output is checked before recursive replacement.
  if (websiteDist !== path.join(workspaceRoot, 'website', 'dist') || !isInside(workspaceRoot, websiteDist)) throw new Error('Unexpected website build target.');
  try { await websiteFiles(websiteDist); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await regularPath(workspaceRoot, websiteRoot, true);
  await rm(websiteDist, { recursive: true, force: true });
  await mkdir(websiteDist, { recursive: true });
  for (const [relative, contents] of published) {
    const output = path.join(websiteDist, ...relative.split('/'));
    if (!isInside(websiteDist, output)) throw new Error('Unexpected website output path.');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
  return { files: published.size, bytes, routes: routes.length, version: release.version, canonical: site?.href ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildWebsite();
    console.log(`Website built: ${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(2)} MiB, Little Code ${result.version}. Installer remains outside static output.`);
    if (!result.canonical) console.log('Set SITE_URL to add production canonical and social-image URLs.');
  } catch (error) {
    console.error(`Website build failed: ${error.code ? 'A required local website input could not be read.' : error.message}`);
    process.exitCode = 1;
  }
}
