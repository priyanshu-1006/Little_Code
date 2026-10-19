# Community reviews on Vercel

The React showcase includes real ratings, filters, pagination and a review form. It contains no sample testimonials or invented ratings. A Vercel Node function at `/api/reviews` is the only browser endpoint; Supabase stores reviews durably. Without the server environment below, the page honestly shows that the community service is not connected and disables submission.

## 1. Create the database

Create your own Supabase project. In its SQL editor, run [`schema.sql`](./schema.sql) as the project owner. It creates two tables and two RPC functions. Keep `public` in the project's exposed API schemas. The browser's `anon` and `authenticated` roles receive no table access or function execution privileges; only the server's `service_role` can call these RPCs.

`little_reviews_feed` returns approved reviews and the count/distribution of approved ratings, with six results per page. `little_reviews_submit` always inserts a pending review. It uses one PostgreSQL transaction/advisory lock to enforce a 24-hour per-network cooldown and a global 1,000-pending-review cap across simultaneous Vercel instances. Functions use an empty search path and schema-qualified tables. This follows Supabase's [function privilege and security-definer guidance](https://supabase.com/docs/guides/database/functions). No public write policy is needed.

The migration is intended for a new service. `CREATE TABLE IF NOT EXISTS` does not migrate a differently shaped existing table. Review the SQL before applying it to an existing database. No hosted service was provisioned by this repository change.

## 2. Configure Vercel server secrets

Use the repository root as the Vercel project root, with the root `vercel.json` and the website build settings in the main publication guide. Add these **server environment variables** in Vercel → Project Settings → Environment Variables:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your project's HTTPS origin, e.g. `https://your-project.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | A server-only `sb_secret_…` key (recommended), or your existing legacy `service_role` JWT |
| `REVIEW_IP_SALT` | A private, random value with at least 32 characters |

Generate the salt locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Store it directly in Vercel, not in source control. Do not prefix any of these variables with `VITE_`, `NEXT_PUBLIC_` or another client-public prefix. Never put an elevated key in the React app. Despite the retained environment-variable name, this implementation supports both key formats: modern `sb_secret_…` keys use `apikey` only; legacy service-role JWTs also use Bearer authorization. Supabase currently recommends the modern secret keys; putting them in a Bearer header causes an invalid-JWT error. See the [official migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys). Publishable/anon keys lack the required RPC privileges.

Set variables only on the deployment environments intended to accept reviews. A separate Supabase test project is preferable for Vercel Preview deployments; otherwise all previews configured with the same secrets share the production moderation queue and ratings. Redeploy after changing variables. Vercel supplies `VERCEL=1` automatically, letting the handler use its `x-vercel-forwarded-for` header; see [Vercel's proxy header reference](https://vercel.com/docs/headers/request-headers). A missing/invalid trusted address fails submission safely instead of applying a shared proxy address to every visitor. The local server uses its socket address and ignores forwarded headers.

The API is an ES module in `api/reviews.mjs`, exporting a Node request/response handler. Vercel supports `.mjs` entry points and automatically builds the project's `api` directory; no browser Supabase SDK is required. See [Vercel's Node runtime reference](https://vercel.com/docs/functions/runtimes/node-js). Keep rewrites from swallowing `/api/reviews`; the root configuration supplies explicit routes.

For local preview, set the three variables in the terminal before running `npm run website:dev`. Use the local URL reported by that command. Environment files are not automatically loaded by the standalone preview server. An unconfigured local preview intentionally returns 503 and shows the honest unavailable state. Do not publish local secrets or copy them into website assets.

## 3. Moderate submissions

Use Supabase's SQL editor or Table Editor as the project owner. There is no public moderation page or browser administration key. Read pending reviews, including critical ratings; approve based on spam/privacy rules rather than whether the review is positive:

```sql
select id, name, rating, title, body, version, created_at
from public.little_reviews
where status = 'pending'
order by created_at;
```

Approve a specific review after checking its content (replace the UUID):

```sql
update public.little_reviews
set status = 'approved', moderated_at = now()
where id = '00000000-0000-0000-0000-000000000000'
  and status = 'pending';
```

Reject spam or a review containing private information:

```sql
update public.little_reviews
set status = 'rejected', moderated_at = now()
where id = '00000000-0000-0000-0000-000000000000';
```

To remove a review, delete its row by ID. Public lists and the overall aggregate are computed from `status = 'approved'` on every request, so unpublishing or deleting immediately removes it from the next fresh request. All API responses use `Cache-Control: no-store`. Page sorting is stable by timestamp and ID; a new approval between requests can shift page boundaries.

## 4. Privacy, limits and operations

- Visitors provide a public display name, 1–5 rating, title, plain-text body and optional app version. They explicitly agree to publication. No account, email address or verified-installation claim is collected.
- The server HMAC-hashes the network address with `REVIEW_IP_SALT`; no raw IP is written to this database, returned in responses, or logged by this handler. Vercel/Supabase infrastructure may have its own access logs and retention policies. Add an appropriate site privacy notice before a public launch.
- Cooldown hashes are separate from review rows and have no review-ID link. They are pruned after seven days when the next valid submission is processed. For guaranteed retention cleanup when traffic is idle, schedule a project-owned job for `delete from public.little_review_cooldowns where last_submitted_at < now() - interval '7 days';`. Rotate the salt after a compromise; rotation resets network cooldown matching.
- One network can submit once per 24 hours. People sharing a campus, office or VPN may share that limit. The cap and honeypot reduce spam; they are not bot-proof. For a busy public launch, enable Vercel firewall/rate rules or add a verified bot challenge before increasing limits. Keep the SQL cooldown, because in-memory serverless counters are not durable.
- Submissions are limited to 12 KiB of JSON, with name 2–60, title 3–100, review 20–2,000, and version up to 40 characters. HTML/control characters are rejected; React renders stored text as text. Same-origin POSTs are required and cross-site origins are rejected. This is a browser request boundary, not authentication for anonymous visitors.
- Supabase REST RPC calls use JSON named parameters at `/rest/v1/rpc/function_name` and time out after eight seconds. Responses are bounded to 64 KiB. See the [PostgREST function API](https://docs.postgrest.org/en/v12/references/api/functions.html). Provider errors and credentials are never returned to visitors.
- If Supabase is unreachable, the schema has not been installed, or variables are absent, return 503 with a useful retry state. A POST is considered successful only after the RPC returns `ACCEPTED`; the page then says **awaiting moderation**, and does not alter the public score optimistically.
- Check the Vercel deployment output for the `/api/reviews` function, then test an empty feed, a pending submission, moderation and a second submission (429). This repository's offline tests mock PostgREST; they do not claim a hosted database or deployed function was exercised.

## API contract

`GET /api/reviews?rating=all&sort=newest&page=1` returns `{configured:true,reviews,aggregate,page,pageSize:6,hasMore}`. `rating` accepts `all` or `1`–`5`; `sort` accepts `newest`, `highest`, `lowest`; page is 1–100. `aggregate` always describes all published reviews, while the list and `hasMore` follow the selected rating. An empty aggregate has count `0`, average `null` and five zero counts.

`POST /api/reviews` accepts JSON `{name,rating,title,body,version,website:""}` from the site's exact Origin. `website` is the honeypot and must stay empty. Responses: 202 pending, 400 invalid input, 403 origin rejected, 405 unsupported method, 413 oversized input, 415 non-JSON, 429 cooldown, 503 missing configuration/unavailable/full moderation queue. A 503 includes `configured:false` only when server configuration is missing/invalid; configured service outages use `configured:true`, so the browser shows a retry error without incorrectly asking the owner to connect a service again. Requests do not accept a moderation status or author identity claim.
