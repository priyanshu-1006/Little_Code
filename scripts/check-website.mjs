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
  for (const required of ['index.html', 'styles.css', 'app.js', 'release.json', 'assets/PROVENANCE.md', 'assets/fonts/provenance.json']) assert(inventory.has(required), `Missing website file: ${required}`);
  const html = await readFile(path.join(websiteDist, 'index.html'), 'utf8');
  const css = await readFile(path.join(websiteDist, 'styles.css'), 'utf8');
  const js = await readFile(path.join(websiteDist, 'app.js'), 'utf8');
  assert(/<!doctype html>/i.test(html) && /<html\b[^>]*\blang=["']en["']/i.test(html), 'Expected an English HTML document.');
  for (const pattern of [/<meta\b[^>]*charset=["']utf-8["']/i, /<meta\b[^>]*name=["']viewport["']/i, /<meta\b[^>]*name=["']description["'][^>]*content=["'][^"']+/i, /<meta\b[^>]*property=["']og:title["']/i, /<meta\b[^>]*property=["']og:description["']/i, /<meta\b[^>]*name=["']twitter:card["']/i, /<title>[^<]*Little Code[^<]*<\/title>/i]) assert(pattern.test(html), 'A required document metadata field is missing.');
  assert.equal([...html.matchAll(/<h1\b/gi)].length, 1, 'Expected exactly one primary heading.');
  const identifiers = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  const ids = new Set(identifiers);
  assert.equal(ids.size, identifiers.length, 'Duplicate document ID.');
  for (const id of ['main', 'top', 'workspace', 'workflow', 'capabilities', 'journey', 'download', 'navigation', 'mode-panel', 'download-setup', 'checksum-value']) assert(ids.has(id), `Missing product section/control: ${id}`);
  let localReferences = 0;
  function inspectReference(value, base = '') {
    if (/^(?:https:|mailto:|tel:|data:)/i.test(value)) return;
    assert(!/^(?:[a-z]+:|\/\/)/i.test(value), 'Unsupported website URL protocol.');
    if (value.startsWith('#')) { assert(ids.has(value.slice(1)), `Missing fragment target: ${value}`); return; }
    const pathname = value.split(/[?#]/)[0];
    if (!pathname) return;
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new Error('Malformed local asset URL.'); }
    assert(!decoded.includes('\\') && !decoded.includes('\0'), 'Unsafe local asset URL.');
    const relative = path.posix.normalize(path.posix.join(base, decoded.replace(/^\//, ''))).replace(/^\.\//, '');
    assert(relative !== '..' && !relative.startsWith('../'), 'Local asset escapes static output.');
    assert(inventory.has(relative), `Missing local website asset: ${relative}`);
    localReferences++;
  }
  for (const match of html.matchAll(/\b(?:href|src|data-image)=["']([^"']+)["']/g)) inspectReference(match[1]);
  for (const match of css.matchAll(/url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)/g)) inspectReference(match[1] ?? match[2]);
  for (const match of html.matchAll(/\baria-(?:controls|labelledby|describedby)=["']([^"']+)["']/g)) for (const id of match[1].split(/\s+/)) assert(ids.has(id), `Missing accessible control target: ${id}`);
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    assert(/\balt=["'][^"']*["']/.test(tag[0]), 'Images require alternative text.');
    if (/\bsrc=["'][^"']+["']/.test(tag[0])) assert(/\bwidth=["']\d+["']/.test(tag[0]) && /\bheight=["']\d+["']/.test(tag[0]), 'Static images require intrinsic dimensions.');
  }
  const syntax = spawnSync(process.execPath, ['--check', path.join(websiteDist, 'app.js')], { encoding: 'utf8', shell: false });
  assert.equal(syntax.status, 0, 'Website JavaScript failed syntax checking.');
  const { release } = await readProduct();
  const published = JSON.parse(await readFile(path.join(websiteDist, 'release.json'), 'utf8'));
  assert.deepEqual(published, release, 'Published release identity differs from source product metadata.');
  assert.deepEqual(Object.keys(publicRelease(published)).sort(), Object.keys(published).sort(), 'Private fields leaked into published metadata.');
  assert(html.includes(release.version) && html.includes(release.sha256), 'Visible version/checksum differ from configured release.');
  assert(!/(?:[a-z]:\\Users\\|localFile|sk-[a-z0-9]{16,})/i.test([html, css, js, JSON.stringify(published)].join('\n')), 'Local-path or credential markers reached public website code.');
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
    if (!entry.relative.startsWith('assets/')) continue;
    const original = await readFile(path.join(workspaceRoot, 'website', 'public', ...entry.relative.split('/')));
    assert.deepEqual(await readFile(entry.file), original, `Published asset differs from approved original: ${entry.relative}`);
  }
  return { files: files.length, bytes, localReferences, verifiedFonts, version: release.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildWebsite();
    const result = await checkWebsite();
    console.log(`Website check passed: ${result.files} files, ${result.localReferences} local asset references, ${result.verifiedFonts} font/license hashes; release ${result.version}.`);
  } catch (error) {
    console.error(`Website check failed: ${error.code ? 'A required local website build input could not be read.' : error.message}`);
    process.exitCode = 1;
  }
}
