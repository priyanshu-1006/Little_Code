import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWebsite, maxWebsiteBytes, publicRelease, readProduct, websiteDist, websiteFiles, workspaceRoot } from './build-website.mjs';

export async function checkWebsite() {
  const files = await websiteFiles(websiteDist);
  const inventory = new Set(files.map(file => file.relative));
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  assert(bytes <= maxWebsiteBytes, 'Website exceeds 10 MiB.');
  assert(!files.some(file => /\.(?:exe|dll|key|pem|pfx|sqlite|db|map)$/i.test(file.relative)), 'Private, executable or debug files reached the static build.');
  for (const required of ['index.html', 'app.css', 'app.js', 'release.json', 'routes.json', 'assets/PROVENANCE.md', 'assets/fonts/provenance.json']) assert(inventory.has(required), `Missing website file: ${required}`);
  const css = await readFile(path.join(websiteDist, 'app.css'), 'utf8');
  const js = await readFile(path.join(websiteDist, 'app.js'), 'utf8');
  const routes = JSON.parse(await readFile(path.join(websiteDist, 'routes.json'), 'utf8'));
  const routeSet = new Set(routes.map(route => route.pathname));
  assert(routeSet.has('/') && routeSet.has('/docs') && routeSet.has('/reviews'), 'Missing application route.');
  assert.equal(routes.length, routeSet.size, 'Duplicate application route.');
  let localReferences = 0;
  const htmlByRoute = new Map();
  const idsByRoute = new Map();
  for (const route of routes) {
    const relative = route.pathname === '/' ? 'index.html' : `${route.pathname.slice(1)}/index.html`;
    assert(inventory.has(relative), `Missing pre-rendered route: ${route.pathname}`);
    const html = await readFile(path.join(websiteDist, relative), 'utf8');
    htmlByRoute.set(route.pathname, html);
    assert(/<!doctype html>/i.test(html) && /<html\b[^>]*\blang=["']en["']/i.test(html), 'Expected an English HTML document.');
    for (const pattern of [/<meta\b[^>]*charset=["']utf-8["']/i, /<meta\b[^>]*name=["']viewport["']/i, /<meta\b[^>]*name=["']description["'][^>]*content=["'][^"']+/i, /<meta\b[^>]*property=["']og:title["']/i, /<meta\b[^>]*property=["']og:description["']/i, /<meta\b[^>]*name=["']twitter:card["']/i, /<title>[^<]*Little Code[^<]*<\/title>/i]) assert(pattern.test(html), `Missing document metadata: ${route.pathname}`);
    assert.equal([...html.matchAll(/<h1\b/gi)].length, 1, `Expected one pre-rendered primary heading: ${route.pathname}`);
    assert(!html.includes('<!--app-html-->'), 'An unrendered application marker reached publication.');
    assert(/\bid=["']root["']/.test(html) && /<script\b[^>]*src=["']\/app\.js["']/.test(html), 'Missing React hydration shell.');
    assert(!/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), 'Inline scripts would violate the website security policy.');
    assert(!/\bstyle=["']/.test(html), `Inline styles would violate the website security policy: ${route.pathname}`);
    const identifiers = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
    assert.equal(new Set(identifiers).size, identifiers.length, `Duplicate document ID: ${route.pathname}`);
    idsByRoute.set(route.pathname, new Set(identifiers));
    for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
      assert(/\balt=["'][^"']*["']/.test(tag[0]), `An image lacks alternative text: ${route.pathname}`);
      assert(/\bwidth=["']\d+["']/.test(tag[0]) && /\bheight=["']\d+["']/.test(tag[0]), `An image lacks intrinsic dimensions: ${route.pathname}`);
    }
  }
  function inspectReference(value, currentRoute = '/') {
    const decodedEntities = value.replaceAll('&amp;', '&');
    if (/^(?:https:|mailto:|tel:|data:)/i.test(decodedEntities)) return;
    assert(!/^(?:[a-z]+:|\/\/)/i.test(decodedEntities), 'Unsupported website URL protocol.');
    const parsed = new URL(decodedEntities, `https://little-code.invalid${currentRoute}`);
    let pathname;
    try { pathname = decodeURIComponent(parsed.pathname); } catch { throw new Error('Malformed local asset URL.'); }
    assert(!pathname.includes('\\') && !pathname.includes('\0'), 'Unsafe local asset URL.');
    const normalized = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
    if (routeSet.has(normalized)) {
      if (parsed.hash) {
        let fragment;
        try { fragment = decodeURIComponent(parsed.hash.slice(1)); } catch { throw new Error('Malformed fragment.'); }
        assert(idsByRoute.get(normalized).has(fragment), `Missing fragment target: ${decodedEntities}`);
      }
    } else {
      const relative = pathname.replace(/^\//, '');
      assert(relative !== '..' && !relative.startsWith('../') && inventory.has(relative), `Missing local website route or asset: ${relative}`);
    }
    localReferences++;
  }
  for (const [route, html] of htmlByRoute) {
    for (const match of html.matchAll(/\b(?:href|src|data-image)=["']([^"']+)["']/g)) inspectReference(match[1], route);
    for (const match of html.matchAll(/\baria-(?:controls|labelledby|describedby)=["']([^"']+)["']/g)) for (const id of match[1].split(/\s+/)) assert(idsByRoute.get(route).has(id), `Missing accessible control target: ${route}#${id}`);
  }
  for (const match of css.matchAll(/url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)/g)) inspectReference(match[1] ?? match[2]);
  const syntax = spawnSync(process.execPath, ['--check', path.join(websiteDist, 'app.js')], { encoding: 'utf8', shell: false });
  assert.equal(syntax.status, 0, 'Website JavaScript failed syntax checking.');
  const { release } = await readProduct();
  const published = JSON.parse(await readFile(path.join(websiteDist, 'release.json'), 'utf8'));
  assert.deepEqual(published, release, 'Published release identity differs from source product metadata.');
  assert.deepEqual(Object.keys(publicRelease(published)).sort(), Object.keys(published).sort(), 'Private fields leaked into published metadata.');
  assert(htmlByRoute.get('/').includes(release.version) && htmlByRoute.get('/').includes(release.sha256), 'Visible version/checksum differ from configured release.');
  assert(!/(?:[a-z]:\\Users\\|localFile|sk-[a-z0-9]{16,})/i.test([...htmlByRoute.values(), css, js, JSON.stringify(published)].join('\n')), 'Local-path or credential markers reached public website code.');
  const provenance = JSON.parse(await readFile(path.join(websiteDist, 'assets/fonts/provenance.json'), 'utf8'));
  assert.equal(provenance.license, 'SIL Open Font License 1.1', 'Font license metadata is missing.');
  let verifiedFonts = 0;
  for (const font of provenance.files) {
    assert(/^[a-zA-Z0-9_.-]+$/.test(font.file), 'Unsafe font provenance path.');
    const relative = `assets/fonts/${font.file}`;
    assert(inventory.has(relative), `Font provenance references a missing file: ${font.file}`);
    const contents = await readFile(path.join(websiteDist, relative));
    assert.equal(contents.length, font.bytes, `Font size differs: ${font.file}`);
    assert.equal(createHash('sha256').update(contents).digest('hex'), font.sha256, `Font identity differs: ${font.file}`);
    verifiedFonts++;
  }
  for (const entry of files) {
    if (!entry.relative.startsWith('assets/') || entry.relative.startsWith('assets/build/')) continue;
    const original = await readFile(path.join(workspaceRoot, 'website', 'public', ...entry.relative.split('/')));
    assert.deepEqual(await readFile(entry.file), original, `Published asset differs from approved original: ${entry.relative}`);
  }
  return { files: files.length, bytes, routes: routes.length, localReferences, verifiedFonts, version: release.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildWebsite();
    const result = await checkWebsite();
    console.log(`React website check passed: ${result.routes} pre-rendered routes, ${result.files} files, ${result.localReferences} local references, ${result.verifiedFonts} font/license hashes; release ${result.version}.`);
  } catch (error) {
    console.error(`Website check failed: ${error.code ? 'A required local website build input could not be read.' : error.message}`);
    process.exitCode = 1;
  }
}
