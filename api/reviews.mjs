import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_BODY_BYTES = 12_288;
const PAGE_SIZE = 6;
const UNAVAILABLE = { code: 'REVIEWS_UNAVAILABLE', configured: false, message: 'Community reviews are not configured yet. Please try again later.' };
const TEMPORARILY_UNAVAILABLE = { code: 'REVIEWS_UNAVAILABLE', configured: true, message: 'Community reviews are temporarily unavailable. Please try again later.' };
const TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/u;

export function validateReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.website !== 'string' || value.website !== '') return null;
  const result = {};
  for (const [key, minimum, maximum] of [['name', 2, 60], ['title', 3, 100], ['body', 20, 2000]]) {
    if (typeof value[key] !== 'string') return null;
    const text = value[key].trim();
    const characters = [...text].length;
    if (characters < minimum || characters > maximum || TEXT_CONTROL.test(text)) return null;
    result[key] = text;
  }
  if (!Number.isInteger(value.rating) || value.rating < 1 || value.rating > 5) return null;
  if (typeof value.version !== 'string' || !/^[a-zA-Z0-9.+ _-]{0,40}$/u.test(value.version)) return null;
  return { ...result, rating: value.rating, version: value.version.trim() };
}

function header(request, name) {
  const value = request.headers?.[name];
  return typeof value === 'string' ? value : '';
}

function sameOrigin(request) {
  try {
    const origin = new URL(header(request, 'origin'));
    const host = header(request, 'host');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    return origin.origin === header(request, 'origin') && origin.host === host
      && (origin.protocol === 'https:' || (local && origin.protocol === 'http:'))
      && !['cross-site', 'none'].includes(header(request, 'sec-fetch-site'));
  } catch { return false; }
}

async function readBody(request) {
  const length = header(request, 'content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error('BODY_TOO_LARGE');
  if (request.body !== undefined) {
    const encoded = typeof request.body === 'string' || Buffer.isBuffer(request.body)
      ? request.body : JSON.stringify(request.body);
    if (Buffer.byteLength(encoded) > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    return JSON.parse(String(encoded));
  }
  const chunks = [];
  let bytes = 0;
  // An IncomingMessage's default iterator destroys its socket on early return,
  // preventing the 413 response from reaching a chunked-upload client.
  const stream = typeof request.iterator === 'function' ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) { request.resume?.(); throw new Error('BODY_TOO_LARGE'); }
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function configuration(env) {
  try {
    const url = new URL(env.SUPABASE_URL || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.REVIEW_IP_SALT || env.REVIEW_IP_SALT.length < 32) return null;
    return { url: url.origin, key: env.SUPABASE_SERVICE_ROLE_KEY, salt: env.REVIEW_IP_SALT };
  } catch { return null; }
}

async function rpc(config, name, values, fetcher) {
  const headers = { apikey: config.key, 'content-type': 'application/json' };
  // Modern secret keys authenticate through apikey; legacy service-role JWTs also use Bearer.
  if (!config.key.startsWith('sb_secret_')) headers.authorization = `Bearer ${config.key}`;
  const response = await fetcher(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(values), signal: AbortSignal.timeout(8_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('REVIEW_STORAGE_UNAVAILABLE');
  const limit = Number(response.headers.get('content-length') || 0);
  if (limit > 64_000) throw new Error('REVIEW_STORAGE_INVALID');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('REVIEW_STORAGE_INVALID');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64_000) { await reader.cancel(); throw new Error('REVIEW_STORAGE_INVALID'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicFeed(data, page) {
  if (!data || !Array.isArray(data.reviews) || data.reviews.length > PAGE_SIZE || !data.aggregate) throw new Error('INVALID_FEED');
  const aggregate = data.aggregate;
  const distribution = Object.fromEntries([1, 2, 3, 4, 5].map(rating => {
    const count = aggregate.distribution?.[rating];
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('INVALID_AGGREGATE');
    return [rating, count];
  }));
  const count = Object.values(distribution).reduce((sum, value) => sum + value, 0);
  const weighted = Object.entries(distribution).reduce((sum, [rating, value]) => sum + Number(rating) * value, 0);
  if (aggregate.count !== count || !Number.isSafeInteger(data.filteredCount) || data.filteredCount < 0 || data.filteredCount > count) throw new Error('INVALID_AGGREGATE');
  const reviews = data.reviews.filter(item => item?.status === 'approved').map(item => {
    const validated = validateReview({ ...item, website: '' });
    if (!validated || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/iu.test(item.id)
      || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('INVALID_REVIEW');
    return { id: item.id, ...validated, createdAt: item.createdAt };
  });
  return { configured: true, reviews, aggregate: { count, average: count ? Math.round(weighted / count * 10) / 10 : null, distribution }, page, pageSize: PAGE_SIZE, hasMore: page * PAGE_SIZE < data.filteredCount };
}

/** Dependency injection keeps tests offline; the default handler reads only server environment. */
export function createReviewsHandler({ env = process.env, fetcher = globalThis.fetch } = {}) {
  return async function reviews(request, response) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    const send = (status, body) => response.status(status).json(body);
    if (!['GET', 'POST'].includes(request.method)) {
      response.setHeader('Allow', 'GET, POST');
      return send(405, { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' });
    }
    if (request.method === 'POST' && !sameOrigin(request)) return send(403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Submit reviews from this website.' });
    const config = configuration(env);
    if (!config) return send(503, UNAVAILABLE);
    try {
      if (request.method === 'GET') {
        const query = new URL(request.url, 'https://little.invalid').searchParams;
        const rating = query.get('rating') || 'all';
        const sort = query.get('sort') || 'newest';
        const pageText = query.get('page') || '1';
        if (!/^(all|[1-5])$/u.test(rating) || !['newest', 'highest', 'lowest'].includes(sort)
          || !/^[1-9]\d{0,2}$/u.test(pageText) || Number(pageText) > 100) return send(400, { code: 'INVALID_FILTER', message: 'Choose a valid review filter or page.' });
        const page = Number(pageText);
        const data = await rpc(config, 'little_reviews_feed', { p_rating: rating === 'all' ? null : Number(rating), p_sort: sort, p_page: page }, fetcher);
        return send(200, publicFeed(data, page));
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(header(request, 'content-type'))) return send(415, { code: 'INVALID_CONTENT_TYPE', message: 'Send a JSON review.' });
      let body;
      try { body = await readBody(request); } catch (error) {
        return send(error.message === 'BODY_TOO_LARGE' ? 413 : 400, { code: 'INVALID_REVIEW', message: 'Review is invalid or too large.' });
      }
      const review = validateReview(body);
      if (!review) return send(400, { code: 'INVALID_REVIEW', message: 'Use a name (2–60 characters), rating (1–5), title (3–100), and review (20–2,000). Plain text only.' });
      // Vercel overwrites this trusted proxy header. Do not use client x-forwarded-for.
      const ip = env.VERCEL === '1' ? header(request, 'x-vercel-forwarded-for').split(',')[0]?.trim() : request.socket?.remoteAddress;
      if (!ip || !isIP(ip)) return send(503, TEMPORARILY_UNAVAILABLE);
      const ipHash = createHmac('sha256', config.salt).update(ip).digest('hex');
      const result = await rpc(config, 'little_reviews_submit', {
        p_name: review.name, p_rating: review.rating, p_title: review.title, p_body: review.body, p_version: review.version, p_ip_hash: ipHash,
      }, fetcher);
      if (result?.code === 'COOLDOWN') {
        const retry = Math.min(86_400, Math.max(60, Number(result.retrySeconds) || 86_400));
        response.setHeader('Retry-After', String(Math.ceil(retry)));
        return send(429, { code: 'REVIEW_COOLDOWN', message: 'One review per network every 24 hours. Please try again later.' });
      }
      if (result?.code === 'QUEUE_FULL') return send(503, { code: 'REVIEWS_BUSY', configured: true, message: 'The moderation queue is full. Please try again later.' });
      if (result?.code !== 'ACCEPTED') throw new Error('INVALID_SUBMISSION_RESULT');
      return send(202, { message: 'Your review was received and is awaiting moderation.' });
    } catch {
      return send(503, TEMPORARILY_UNAVAILABLE);
    }
  };
}

export default createReviewsHandler();
