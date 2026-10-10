import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  return url;
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function buildWebsite(env = process.env) {
  const { release } = await readProduct();
  const published = new Map();
  for (const name of ['index.html', 'styles.css', 'app.js']) {
    const input = await regularPath(workspaceRoot, path.join(websiteRoot, name));
    published.set(name, await readFile(input));
  }
  for (const asset of await websiteFiles(path.join(websiteRoot, 'public'))) {
    if (!asset.relative.startsWith('assets/') || /(?:^|\/)\./.test(asset.relative) || /\.(?:exe|dll|pfx|pem|key|db|sqlite|map)$/i.test(asset.relative)) throw new Error('Unexpected file in public website assets.');
    published.set(asset.relative, await readFile(asset.file));
  }
  const site = canonicalSite(env);
  if (site) {
    const url = escapeAttribute(site.href);
    const image = escapeAttribute(new URL('assets/workspace-home.png', site).href);
    const html = published.get('index.html').toString('utf8')
      .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>\s*/gi, '')
      .replace(/<meta\b[^>]*(?:property|name)=["'](?:og:url|og:image|twitter:image)["'][^>]*>\s*/gi, '');
    published.set('index.html', Buffer.from(html.replace('</head>', `  <link rel="canonical" href="${url}">\n  <meta property="og:url" content="${url}">\n  <meta property="og:image" content="${image}">\n  <meta name="twitter:image" content="${image}">\n</head>`)));
  }
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
  return { files: published.size, bytes, version: release.version, canonical: site?.href ?? null };
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
