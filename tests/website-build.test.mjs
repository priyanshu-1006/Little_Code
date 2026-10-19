import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWebsite, documentRoutes, publicRelease, readProduct, websiteDist, workspaceRoot } from '../scripts/build-website.mjs';
import { checkWebsite } from '../scripts/check-website.mjs';
import { createWebsiteServer } from '../scripts/serve-website.mjs';

let preview;
let origin;
let release;
before(async () => {
  await buildWebsite({ SITE_URL: 'https://littlecode.example' });
  ({ release } = await readProduct());
  preview = await createWebsiteServer({ port: 0, reviewsOptions: { env: {}, fetcher: () => { throw new Error('Offline tests must not call storage.'); } } });
  origin = `http://127.0.0.1:${preview.port}`;
});
after(async () => {
  await preview?.close();
  // Do not leave the test-only canonical origin in the user's preview output.
  await buildWebsite();
});

test('the React build checks every pre-rendered route, assets and public release identity', async () => {
  const result = await checkWebsite();
  assert.equal(result.version, release.version);
  assert(result.routes > 3);
  assert.equal(result.verifiedFonts, 6);
  const publicMetadata = JSON.parse(await readFile(path.join(websiteDist, 'release.json'), 'utf8'));
  assert(!Object.hasOwn(publicMetadata, 'localFile'));
  assert.deepEqual(publicMetadata, publicRelease(publicMetadata));
});

test('documentation routes are bounded, unique and reject traversal', () => {
  const valid = [{ slug: 'installation', title: 'Install', description: 'Install the app.' }];
  assert(documentRoutes(valid).some(route => route.pathname === '/docs/installation'));
  for (const documents of [[], [...valid, ...valid], [{ ...valid[0], slug: '../private' }], [{ ...valid[0], title: '' }]]) assert.throws(() => documentRoutes(documents));
});

test('Vercel documentation rewrites cover the catalog without rewriting APIs or unknown pages', async () => {
  const configuration = JSON.parse(await readFile(path.join(workspaceRoot, 'vercel.json'), 'utf8'));
  const routes = JSON.parse(await readFile(path.join(websiteDist, 'routes.json'), 'utf8'));
  const guideRewrite = configuration.rewrites.find(route => route.source.startsWith('/docs/:slug('));
  assert(guideRewrite);
  const slugs = guideRewrite.source.slice('/docs/:slug('.length, -1).split('|');
  assert.deepEqual([...slugs].sort(), routes.filter(route => route.pathname.startsWith('/docs/')).map(route => route.pathname.slice('/docs/'.length)).sort());
  assert(configuration.rewrites.every(route => route.source.startsWith('/docs') || route.source === '/reviews'));
  assert.equal(configuration.functions['api/reviews.mjs'].maxDuration, 15);
  assert.equal(configuration.installCommand, 'npm ci');
});

test('each deep link serves its own pre-rendered content and canonical URL', async () => {
  for (const pathname of ['/', '/docs', '/docs/installation', '/reviews']) {
    const response = await fetch(`${origin}${pathname}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert(html.includes(`rel="canonical" href="https://littlecode.example${pathname}"`));
    assert(!html.includes('<!--app-html-->'));
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('unknown pages and assets remain 404 and non-API mutation methods are rejected', async () => {
  for (const pathname of ['/docs/not-a-real-guide', '/not-a-route', '/missing.js', '/api/unknown']) assert.equal((await fetch(`${origin}${pathname}`)).status, 404);
  const response = await fetch(`${origin}/docs/installation`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('the local API adapter reports missing review storage honestly and rejects cross-origin POST', async () => {
  const response = await fetch(`${origin}/api/reviews`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'REVIEWS_UNAVAILABLE');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const rejected = await fetch(`${origin}/api/reviews`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 403);
  const local = await fetch(`${origin}/api/reviews`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(local.status, 503);
  assert.equal((await local.json()).code, 'REVIEWS_UNAVAILABLE');
});

test('a raw local POST reaches configured review storage and remains pending instead of fabricating a public review', async () => {
  const calls = [];
  const configured = await createWebsiteServer({ port: 0, reviewsOptions: {
    env: { SUPABASE_URL: 'https://reviews.example', SUPABASE_SERVICE_ROLE_KEY: 'offline-server-key', REVIEW_IP_SALT: 'offline-test-only-private-salt-at-least-32-characters' },
    fetcher: async (url, options) => {
      calls.push({ url, values: JSON.parse(options.body) });
      const body = url.endsWith('/little_reviews_submit') ? { code: 'ACCEPTED' } : { reviews: [], aggregate: { count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }, filteredCount: 0 };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    },
  } });
  const localOrigin = `http://127.0.0.1:${configured.port}`;
  try {
    const response = await fetch(`${localOrigin}/api/reviews`, { method: 'POST', headers: { Origin: localOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A reviewer', title: 'Thoughtful workspace', body: 'The guided project creation made setup easier to review.', rating: 4, version: release.version, website: '' }) });
    assert.equal(response.status, 202);
    assert.match((await response.json()).message, /moderation/);
    assert.equal(calls[0].values.p_rating, 4);
    assert.match(calls[0].values.p_ip_hash, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(calls[0].values).includes('127.0.0.1'));
    const feed = await fetch(`${localOrigin}/api/reviews`);
    assert.equal(feed.status, 200);
    const published = await feed.json();
    assert.equal(published.configured, true);
    assert.deepEqual(published.reviews, []);
    assert.equal(published.aggregate.count, 0);
    assert.equal(published.aggregate.average, null);
  } finally { await configured.close(); }
});

test('static release metadata excludes machine paths and missing download names fail closed', async () => {
  const response = await fetch(`${origin}/release.json`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), release);
  assert.equal((await fetch(`${origin}/downloads/not-this-release.exe`)).status, 404);
});

test('the pinned local installer verifies identity and supports bounded resumable downloads', async context => {
  const { product } = await readProduct();
  const localFile = path.join(workspaceRoot, ...product.localFile.split('/'));
  try { await lstat(localFile); } catch (error) { if (error.code === 'ENOENT') { context.skip('The private local installer is absent on a clean clone.'); return; } throw error; }
  const availabilityResponse = await fetch(`${origin}/api/release`);
  const availability = await availabilityResponse.json();
  assert.equal(availability.available, true);
  assert.equal(availability.sha256, release.sha256);
  const response = await fetch(`${origin}${availability.downloadUrl}`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(Number(response.headers.get('content-length')), release.bytes);
  assert.equal(response.headers.get('etag'), `"sha256-${release.sha256}"`);
  const range = await fetch(`${origin}${availability.downloadUrl}`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  const bytes = Buffer.from(await range.arrayBuffer());
  assert.equal(bytes.length, 32);
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const invalid = await fetch(`${origin}${availability.downloadUrl}`, { headers: { Range: `bytes=${release.bytes}-` } });
  assert.equal(invalid.status, 416);
  const cached = await fetch(`${origin}${availability.downloadUrl}`, { headers: { 'If-None-Match': `"sha256-${release.sha256}"` } });
  assert.equal(cached.status, 304);
});
