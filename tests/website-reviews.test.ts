import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import test, { before } from 'node:test';
import { pathToFileURL } from 'node:url';

type Request = { method: string; url: string; headers: Record<string, string>; body?: unknown; socket: { remoteAddress: string } };
type ResponseCapture = { statusCode: number; body: unknown; headers: Record<string, string>; setHeader(name: string, value: string): void; status(code: number): ResponseCapture; json(body: unknown): void };
type Dependencies = { env?: Record<string, string>; fetcher?: typeof fetch };
type CreateHandler = (deps?: Dependencies) => (request: Request, response: ResponseCapture) => Promise<unknown>;
let createHandler: CreateHandler;
let validateReview: (body: unknown) => unknown;
before(async () => {
  const module = await import(pathToFileURL(resolve('api/reviews.mjs')).href);
  createHandler = module.createReviewsHandler as CreateHandler;
  validateReview = module.validateReview as (body: unknown) => unknown;
});
const env = { SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key', REVIEW_IP_SALT: 'test-private-salt-with-at-least-32-characters' };
const review = { name: 'A developer', rating: 4, title: 'A useful workspace', body: 'The project creation flow made starting my app much easier.', version: '0.3.0', website: '' };
const approved = { ...review, id: '8a7fe63a-8e75-4b51-9e22-5144f9612698', status: 'approved', createdAt: '2026-10-19T10:00:00Z' };
const emptyFeed = { reviews: [], aggregate: { count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }, filteredCount: 0 };
function request(change: Partial<Request> = {}): Request {
  return { method: 'GET', url: '/api/reviews', headers: { host: 'little-code.vercel.app', origin: 'https://little-code.vercel.app', 'content-type': 'application/json' }, socket: { remoteAddress: '203.0.113.17' }, ...change };
}
function capture(): ResponseCapture {
  return { statusCode: 0, body: undefined, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
}
function jsonFetcher(value: unknown): typeof fetch { return async () => Response.json(value); }
async function run(req: Request, deps: Dependencies = {}) {
  const response = capture();
  await createHandler({ env, fetcher: jsonFetcher(emptyFeed), ...deps })(req, response);
  return response;
}

test('reviews without server configuration stay unavailable without invented data', async () => {
  let called = false;
  const result = await run(request(), { env: {}, fetcher: async () => { called = true; return Response.json(emptyFeed); } });
  assert.equal(result.statusCode, 503);
  assert.equal(called, false);
  assert.equal((result.body as { code: string }).code, 'REVIEWS_UNAVAILABLE');
  assert.equal((result.body as { configured: boolean }).configured, false);
  assert.doesNotMatch(JSON.stringify(result.body), /test-private-salt|server-only/);
});

test('empty configured service reports zero count and null average', async () => {
  const result = await run(request());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { configured: true, reviews: [], aggregate: { count: 0, average: null, distribution: emptyFeed.aggregate.distribution }, page: 1, pageSize: 6, hasMore: false });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
});

test('feed exposes only approved allowlisted fields, computes honest weighted aggregate and forwards bounded filters', async () => {
  let sent: unknown;
  const result = await run(request({ url: '/api/reviews?rating=4&sort=lowest&page=2' }), { fetcher: async (url, init) => {
    assert.equal(String(url), 'https://test-project.supabase.co/rest/v1/rpc/little_reviews_feed');
    sent = JSON.parse(String(init?.body));
    return Response.json({ reviews: [{ ...approved, ip_hash: 'private', email: 'private@example.invalid' }, { ...approved, status: 'pending', id: 'd5dc5e64-fec0-446a-b8f7-f33dbd456582' }], aggregate: { count: 15, distribution: { 1: 1, 2: 0, 3: 0, 4: 13, 5: 1 } }, filteredCount: 13 });
  } });
  assert.deepEqual(sent, { p_rating: 4, p_sort: 'lowest', p_page: 2 });
  assert.equal(result.statusCode, 200);
  const body = result.body as { reviews: Record<string, unknown>[]; aggregate: { average: number }; hasMore: boolean };
  assert.equal(body.reviews.length, 1);
  assert.equal(body.reviews[0]?.id, approved.id);
  assert.equal(body.aggregate.average, 3.9);
  assert.equal(body.hasMore, true);
  assert.doesNotMatch(JSON.stringify(result.body), /private|status|website|pending/);
});

test('invalid query values never reach the provider', async () => {
  for (const query of ['rating=6', 'rating=1%26status=pending', 'sort=title', 'page=0', 'page=101', 'page=1.5', 'page=-1']) {
    let called = false;
    const result = await run(request({ url: `/api/reviews?${query}` }), { fetcher: async () => { called = true; return Response.json(emptyFeed); } });
    assert.equal(result.statusCode, 400, query);
    assert.equal(called, false, query);
  }
});

test('submission persists pending through RPC with HMAC only and never trusts moderation or forwarded identity fields', async () => {
  let sent: Record<string, unknown> = {};
  const result = await run(request({ method: 'POST', body: { ...review, status: 'approved', ip_hash: 'attacker', email: 'ignored' }, headers: { ...request().headers, 'x-forwarded-for': '192.0.2.99' } }), { fetcher: async (url, init) => {
    assert.equal(String(url), 'https://test-project.supabase.co/rest/v1/rpc/little_reviews_submit');
    sent = JSON.parse(String(init?.body));
    assert.ok(init?.signal);
    return Response.json({ code: 'ACCEPTED', id: 'must-not-be-publicly-returned' });
  } });
  assert.equal(result.statusCode, 202);
  assert.match(JSON.stringify(result.body), /awaiting moderation/);
  assert.deepEqual(sent, { p_name: review.name, p_rating: review.rating, p_title: review.title, p_body: review.body, p_version: review.version, p_ip_hash: createHmac('sha256', env.REVIEW_IP_SALT).update('203.0.113.17').digest('hex') });
  assert.doesNotMatch(JSON.stringify(sent), /203\.0\.113|192\.0\.2|email|approved/);
  assert.doesNotMatch(JSON.stringify(result.body), /must-not-be-publicly/);
});

test('Vercel mode hashes platform proxy address and ignores spoofed generic forwarded header', async () => {
  let hash: unknown;
  await run(request({ method: 'POST', body: review, headers: { ...request().headers, 'x-vercel-forwarded-for': '198.51.100.24', 'x-forwarded-for': '192.0.2.99' } }), { env: { ...env, VERCEL: '1' }, fetcher: async (_url, init) => {
    hash = JSON.parse(String(init?.body)).p_ip_hash; return Response.json({ code: 'ACCEPTED' });
  } });
  assert.equal(hash, createHmac('sha256', env.REVIEW_IP_SALT).update('198.51.100.24').digest('hex'));
});

test('Vercel mode refuses a missing trusted address instead of sharing a proxy cooldown across visitors', async () => {
  let called = false;
  const result = await run(request({ method: 'POST', body: review }), { env: { ...env, VERCEL: '1' }, fetcher: async () => { called = true; return Response.json({ code: 'ACCEPTED' }); } });
  assert.equal(result.statusCode, 503);
  assert.equal((result.body as { configured: boolean }).configured, true);
  assert.equal(called, false);
});

test('modern Supabase secret key uses apikey without invalid Bearer authentication', async () => {
  let headers: HeadersInit | undefined;
  const result = await run(request(), { env: { ...env, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_only_for_test' }, fetcher: async (_url, init) => { headers = init?.headers; return Response.json(emptyFeed); } });
  assert.equal(result.statusCode, 200);
  assert.equal(new Headers(headers).get('apikey'), 'sb_secret_only_for_test');
  assert.equal(new Headers(headers).has('authorization'), false);
});

test('legacy service-role key uses server-only apikey and Bearer headers', async () => {
  let headers: HeadersInit | undefined;
  await run(request(), { fetcher: async (_url, init) => { headers = init?.headers; return Response.json(emptyFeed); } });
  assert.equal(new Headers(headers).get('apikey'), env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(new Headers(headers).get('authorization'), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
});

test('cross-site, absent, null, malformed and wrong-scheme origins cannot submit', async () => {
  for (const origin of ['', 'null', 'https://attacker.example', 'http://little-code.vercel.app', 'https://little-code.vercel.app.evil', 'https://little-code.vercel.app/']) {
    let called = false;
    const result = await run(request({ method: 'POST', body: review, headers: { ...request().headers, origin } }), { fetcher: async () => { called = true; return Response.json({ code: 'ACCEPTED' }); } });
    assert.equal(result.statusCode, 403, origin);
    assert.equal(called, false, origin);
  }
  const crossSite = await run(request({ method: 'POST', body: review, headers: { ...request().headers, 'sec-fetch-site': 'cross-site' } }));
  assert.equal(crossSite.statusCode, 403);
});

test('same-origin localhost development can submit', async () => {
  const result = await run(request({ method: 'POST', body: review, headers: { ...request().headers, host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' } }), { fetcher: jsonFetcher({ code: 'ACCEPTED' }) });
  assert.equal(result.statusCode, 202);
});

test('validation rejects honeypot, markup, coercion, boundary violations and controls', () => {
  for (const candidate of [null, [], {}, { ...review, website: 'https://spam.invalid' }, { ...review, website: undefined }, { ...review, rating: '5' }, { ...review, rating: 4.5 }, { ...review, rating: 0 }, { ...review, rating: 6 }, { ...review, name: ' ' }, { ...review, title: '<script>alert(1)</script>' }, { ...review, body: 'too short' }, { ...review, body: 'x'.repeat(2001) }, { ...review, title: 'Bad\u0000title' }, { ...review, version: '../private' }]) assert.equal(validateReview(candidate), null);
  assert.deepEqual(validateReview({ ...review, name: '  A developer  ' }), reviewWithoutHoneypot());
  assert.equal(validateReview({ ...review, name: '😀' }), null, 'SQL char_length and validation both count Unicode characters');
});
function reviewWithoutHoneypot() { return { name: review.name, rating: review.rating, title: review.title, body: review.body, version: review.version }; }

test('invalid reviews do not consume provider requests', async () => {
  let called = false;
  const result = await run(request({ method: 'POST', body: { ...review, body: 'tiny' } }), { fetcher: async () => { called = true; return Response.json({ code: 'ACCEPTED' }); } });
  assert.equal(result.statusCode, 400);
  assert.equal(called, false);
});

test('unsupported method, non-JSON, malformed JSON and oversized bodies are rejected', async () => {
  const method = await run(request({ method: 'DELETE' }));
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.Allow, 'GET, POST');
  assert.equal((await run(request({ method: 'POST', body: review, headers: { ...request().headers, 'content-type': 'text/plain' } }))).statusCode, 415);
  assert.equal((await run(request({ method: 'POST', body: '{' }))).statusCode, 400);
  assert.equal((await run(request({ method: 'POST', body: 'x'.repeat(12_289) }))).statusCode, 413);
  assert.equal((await run(request({ method: 'POST', body: review, headers: { ...request().headers, 'content-length': '12289' } }))).statusCode, 413);
});

test('raw Node request streams work and are bounded without Vercel body helpers', async () => {
  const raw = Object.assign(Readable.from([Buffer.from(JSON.stringify(review))]), request({ method: 'POST' }));
  const result = await run(raw, { fetcher: jsonFetcher({ code: 'ACCEPTED' }) });
  assert.equal(result.statusCode, 202);
  const large = Object.assign(Readable.from([Buffer.alloc(8000), Buffer.alloc(8000)]), request({ method: 'POST' }));
  assert.equal((await run(large)).statusCode, 413);
});

test('oversized chunked HTTP uploads receive a useful 413 rather than a destroyed response socket', { timeout: 10_000 }, async () => {
  const handler = createHandler({ env, fetcher: jsonFetcher({ code: 'ACCEPTED' }) });
  const server = createServer((incoming, outgoing) => {
    const response = capture();
    response.setHeader = (name, value) => { outgoing.setHeader(name, value); };
    response.status = function (code) { outgoing.statusCode = code; return this; };
    response.json = body => { outgoing.end(JSON.stringify(body)); };
    void handler(incoming as unknown as Request, response);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const client = httpRequest(`${origin}/api/reviews`, { method: 'POST', agent: false, headers: { origin, 'content-type': 'application/json' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      client.on('error', reject);
      client.write(Buffer.alloc(8000, 'a'));
      client.end(Buffer.alloc(8000, 'b'));
    });
    assert.equal(result.status, 413);
    assert.match(result.body, /too large/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('cooldown and full moderation queue are truthful failures', async () => {
  const cooldown = await run(request({ method: 'POST', body: review }), { fetcher: jsonFetcher({ code: 'COOLDOWN', retrySeconds: 4321 }) });
  assert.equal(cooldown.statusCode, 429);
  assert.equal(cooldown.headers['Retry-After'], '4321');
  const queue = await run(request({ method: 'POST', body: review }), { fetcher: jsonFetcher({ code: 'QUEUE_FULL' }) });
  assert.equal(queue.statusCode, 503);
  assert.equal((queue.body as { code: string }).code, 'REVIEWS_BUSY');
});

test('provider failures, malformed feeds, oversized responses and thrown secrets stay private', async () => {
  const fetchers: (typeof fetch)[] = [
    async () => { throw new Error(`secret ${env.SUPABASE_SERVICE_ROLE_KEY} ${env.REVIEW_IP_SALT}`); },
    async () => new Response(`database error ${env.SUPABASE_SERVICE_ROLE_KEY}`, { status: 403 }),
    async () => new Response('not json'),
    jsonFetcher({ ...emptyFeed, aggregate: { ...emptyFeed.aggregate, count: 50 } }),
    jsonFetcher({ ...emptyFeed, reviews: [{ ...approved, body: '<script>injected</script>' }] }),
    async () => new Response('x'.repeat(64_001)),
    async () => new Response('{}', { headers: { 'content-length': '64001' } }),
  ];
  for (const fetcher of fetchers) {
    const result = await run(request(), { fetcher });
    assert.equal(result.statusCode, 503);
    assert.equal((result.body as { configured: boolean }).configured, true);
    assert.doesNotMatch(JSON.stringify(result.body), /server-only-test-key|test-private-salt|database error|injected/);
  }
});

test('unsafe provider origin and short salt are never used', async () => {
  for (const changed of [{ SUPABASE_URL: 'http://test-project.supabase.co' }, { SUPABASE_URL: 'https://user:pass@test-project.supabase.co' }, { SUPABASE_URL: 'https://test-project.supabase.co/private?key=x' }, { REVIEW_IP_SALT: 'short' }]) {
    let called = false;
    const result = await run(request(), { env: { ...env, ...changed }, fetcher: async () => { called = true; return Response.json(emptyFeed); } });
    assert.equal(result.statusCode, 503);
    assert.equal(called, false);
  }
});

test('invalid address or unknown storage result cannot report a successful review', async () => {
  const address = await run(request({ method: 'POST', body: review, socket: { remoteAddress: 'not an address' } }), { fetcher: jsonFetcher({ code: 'ACCEPTED' }) });
  assert.equal(address.statusCode, 503);
  const unknown = await run(request({ method: 'POST', body: review }), { fetcher: jsonFetcher({ code: 'ok' }) });
  assert.equal(unknown.statusCode, 503);
});
