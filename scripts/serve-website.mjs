import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isInside, readProduct, regularPath, websiteDist, websiteFiles, workspaceRoot } from './build-website.mjs';

const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.github.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function reply(response, status, body, method, headers = {}) {
  const contents = Buffer.from(body);
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': contents.length, 'Cache-Control': 'no-store', ...headers });
  response.end(method === 'HEAD' ? undefined : contents);
}

function parseRange(header, bytes) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, bytes - suffix);
    end = bytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : bytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes || start > end) return null;
    end = Math.min(end, bytes - 1);
  }
  return { start, end };
}

export async function createWebsiteServer({ port = 4173, reviewsOptions } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Website port must be between 0 and 65535.');
  const { product, release } = await readProduct();
  const staticFiles = new Map((await websiteFiles(websiteDist)).map(entry => [`/${entry.relative}`, entry]));
  if (!staticFiles.has('/index.html') || !staticFiles.has('/release.json')) throw new Error('Build the website before starting its local server.');
  const builtRelease = JSON.parse(await readFile(path.join(websiteDist, 'release.json'), 'utf8'));
  if (JSON.stringify(builtRelease) !== JSON.stringify(release)) throw new Error('The website build is stale. Rebuild before previewing downloads.');
  const routes = JSON.parse(await readFile(path.join(websiteDist, 'routes.json'), 'utf8'));
  for (const route of routes) {
    if (typeof route.pathname !== 'string' || !/^\/(?:docs(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?|reviews)?$/.test(route.pathname)) throw new Error('Invalid generated application route.');
    const entry = staticFiles.get(route.pathname === '/' ? '/index.html' : `${route.pathname}/index.html`);
    if (!entry) throw new Error('A pre-rendered application route is missing.');
    staticFiles.set(route.pathname, entry);
    if (route.pathname !== '/') staticFiles.set(`${route.pathname}/`, entry);
  }
  let reviewsHandler = null;
  try {
    const reviewsPath = await regularPath(workspaceRoot, path.join(workspaceRoot, 'api', 'reviews.mjs'));
    const reviewsModule = await import(pathToFileURL(reviewsPath).href);
    reviewsHandler = reviewsOptions ? reviewsModule.createReviewsHandler(reviewsOptions) : reviewsModule.default;
    if (typeof reviewsHandler !== 'function') throw new Error('Invalid reviews API handler.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let verifiedInstaller = null;
  let verification = null;
  let closing = false;
  const downloadPath = `/downloads/${release.fileName}`;

  async function findInstaller() {
    if (typeof product.localFile !== 'string' || !product.localFile.startsWith('desktop/releases/') || product.localFile.includes('\\') || path.isAbsolute(product.localFile) || product.localFile.split('/').some(segment => segment === '..' || segment === '.' || !segment)) throw new Error('The local installer is unavailable.');
    const target = path.resolve(workspaceRoot, ...product.localFile.split('/'));
    if (!isInside(workspaceRoot, target) || path.basename(target) !== release.fileName) throw new Error('The local installer is unavailable.');
    return regularPath(workspaceRoot, target);
  }

  async function verifyInstaller() {
    const target = await findInstaller();
    if (verifiedInstaller) {
      const freshPath = await regularPath(workspaceRoot, target);
      const pathHandle = await open(freshPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let stat;
      try { stat = await pathHandle.stat(); } finally { await pathHandle.close(); }
      const held = await verifiedInstaller.handle.stat();
      if (identity(stat) === verifiedInstaller.identity && identity(held) === verifiedInstaller.identity) return verifiedInstaller;
      await verifiedInstaller.handle.close();
      verifiedInstaller = null;
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== release.bytes) throw new Error('The local installer does not match this release.');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
      const after = await handle.stat();
      const freshTarget = await findInstaller();
      const fresh = await open(freshTarget, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let current;
      try { current = await fresh.stat(); } finally { await fresh.close(); }
      if (identity(before) !== identity(after) || identity(after) !== identity(current) || hash.digest('hex') !== release.sha256 || closing) throw new Error('The local installer does not match this release.');
      verifiedInstaller = { handle, path: target, identity: identity(after), modified: after.mtime.toUTCString() };
      return verifiedInstaller;
    } catch (error) { await handle.close(); throw error; }
  }

  function currentInstaller() {
    if (!verification) verification = verifyInstaller().finally(() => { verification = null; });
    return verification;
  }

  const server = http.createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    try {
      let pathname;
      try { pathname = decodeURIComponent((request.url ?? '/').split(/[?#]/)[0]); } catch { reply(response, 400, 'Malformed request path.', method); return; }
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(segment => segment === '..' || segment === '.')) { reply(response, 400, 'Invalid request path.', method); return; }
      if (pathname === '/api/reviews') {
        for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);
        if (reviewsHandler) {
          response.status = status => { response.statusCode = status; return response; };
          response.json = body => {
            const contents = Buffer.from(JSON.stringify(body));
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.setHeader('Content-Length', contents.length);
            response.end(method === 'HEAD' ? undefined : contents);
          };
          await reviewsHandler(request, response);
        }
        else reply(response, 503, JSON.stringify({ configured: false, code: 'REVIEWS_UNAVAILABLE', message: 'Community reviews are not connected yet.' }), method, { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') { reply(response, 405, 'Only GET and HEAD are supported.', method, { Allow: 'GET, HEAD' }); return; }
      if (pathname === '/api/release') {
        let available = false;
        try { await currentInstaller(); available = true; } catch { /* Static publication remains useful without a local build artifact. */ }
        const body = JSON.stringify({ ...release, available, downloadUrl: available ? downloadPath : null, source: available ? 'local' : 'pending', reason: available ? 'The local installer size and SHA-256 match this release.' : 'The verified local installer is unavailable. Use a published GitHub release when available.' });
        reply(response, 200, body, method, { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      if (pathname.startsWith('/downloads/')) {
        if (pathname !== downloadPath) { reply(response, 404, 'Download not found.', method); return; }
        let installer;
        try { installer = await currentInstaller(); } catch { reply(response, 503, 'The installer is unavailable or its identity changed.', method); return; }
        if (identity(await installer.handle.stat()) !== installer.identity) { reply(response, 503, 'The installer identity changed.', method); return; }
        const etag = `"sha256-${release.sha256}"`;
        const headers = { ...securityHeaders, 'Content-Type': 'application/vnd.microsoft.portable-executable', 'Content-Disposition': `attachment; filename="${release.fileName}"`, 'Accept-Ranges': 'bytes', 'Last-Modified': installer.modified, ETag: etag, 'Cache-Control': 'private, no-cache' };
        if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); response.end(); return; }
        let range = null;
        if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag || request.headers['if-range'] === installer.modified)) {
          range = parseRange(request.headers.range, release.bytes);
          if (!range) { reply(response, 416, 'Requested byte range is not available.', method, { 'Content-Range': `bytes */${release.bytes}`, 'Accept-Ranges': 'bytes' }); return; }
        }
        const start = range?.start ?? 0, end = range?.end ?? release.bytes - 1;
        const downloadHeaders = { ...headers, 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${release.bytes}` } : {}) };
        if (method === 'HEAD') { response.writeHead(range ? 206 : 200, downloadHeaders); response.end(); return; }
        // Each transfer owns its descriptor: cancellation cannot destroy the
        // cached verification handle or another simultaneous range download.
        const download = await open(await regularPath(workspaceRoot, installer.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (identity(await download.stat()) !== installer.identity) { reply(response, 503, 'The installer identity changed.', method); return; }
          response.writeHead(range ? 206 : 200, downloadHeaders);
          await pipeline(download.createReadStream({ start, end, autoClose: true }), response);
        } finally { await download.close().catch(() => {}); }
        return;
      }
      const entry = staticFiles.get(pathname === '/' ? '/index.html' : pathname);
      if (!entry) { reply(response, 404, 'Page or asset not found.', method); return; }
      const safeFile = await regularPath(websiteDist, entry.file);
      const contents = await readFile(safeFile);
      reply(response, 200, contents, method, { 'Content-Type': contentTypes[path.extname(entry.file)] ?? 'application/octet-stream', 'Cache-Control': /\.(?:html|json|js|css)$/.test(entry.relative) ? 'no-cache' : 'public, max-age=3600' });
    } catch {
      if (!response.headersSent) reply(response, 500, 'The local preview could not complete this request.', method);
      else if (!response.destroyed) response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  async function close() {
    closing = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { await verification; } catch { /* A stopped verification cannot authorize a download. */ }
    if (verifiedInstaller) { await verifiedInstaller.handle.close(); verifiedInstaller = null; }
  }
  return { server, port: server.address().port, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !/^--port=\d+$/.test(arg)) || args.length > 1) throw new Error('Usage: node scripts/serve-website.mjs [--port=4173]');
    const configured = args[0]?.slice('--port='.length) ?? process.env.PORT ?? '4173';
    if (!/^\d+$/.test(configured)) throw new Error('Website port must be numeric.');
    const preview = await createWebsiteServer({ port: Number(configured) });
    console.log(`Little Code website: http://127.0.0.1:${preview.port}`);
    console.log('Local setup downloads are enabled only after size and SHA-256 verification. Ctrl+C stops this owned preview.');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await preview.close(); });
  } catch (error) {
    console.error(`Website preview failed: ${error.code === 'EADDRINUSE' ? 'The requested localhost port is already in use.' : error.code ? 'A required local website input could not be read.' : error.message}`);
    process.exitCode = 1;
  }
}
