-- Run once in the Supabase SQL editor as the project owner. No browser role has access.
begin;
create table if not exists public.little_reviews (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 60),
  rating smallint not null check (rating between 1 and 5),
  title text not null check (char_length(title) between 3 and 100),
  body text not null check (char_length(body) between 20 and 2000),
  version text not null default '' check (char_length(version) <= 40),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  moderated_at timestamptz
);
create index if not exists little_reviews_feed_idx on public.little_reviews (status, created_at desc, id desc);
create index if not exists little_reviews_rating_idx on public.little_reviews (status, rating, created_at desc);
create table if not exists public.little_review_cooldowns (
  ip_hash text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
  last_submitted_at timestamptz not null default now()
);
create index if not exists little_review_cooldown_expiry_idx on public.little_review_cooldowns (last_submitted_at);
alter table public.little_reviews enable row level security;
alter table public.little_review_cooldowns enable row level security;
revoke all on public.little_reviews, public.little_review_cooldowns from public, anon, authenticated;

create or replace function public.little_reviews_submit(
  p_name text, p_rating integer, p_title text, p_body text, p_version text, p_ip_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous_at timestamptz;
begin
  if p_ip_hash !~ '^[0-9a-f]{64}$' or p_ip_hash is null
    or p_name is null or char_length(p_name) not between 2 and 60
    or p_rating is null or p_rating not between 1 and 5
    or p_title is null or char_length(p_title) not between 3 and 100
    or p_body is null or char_length(p_body) not between 20 and 2000
    or p_version is null or char_length(p_version) > 40 then
    raise exception 'Invalid review';
  end if;
  -- Serialize review submissions to make cooldown and queue cap atomic across instances.
  perform pg_catalog.pg_advisory_xact_lock(719003031);
  delete from public.little_review_cooldowns where last_submitted_at < now() - interval '7 days';
  select last_submitted_at into previous_at from public.little_review_cooldowns where ip_hash = p_ip_hash;
  if previous_at is not null and previous_at > now() - interval '24 hours' then
    return jsonb_build_object('code','COOLDOWN','retrySeconds',ceil(extract(epoch from (previous_at + interval '24 hours' - now()))));
  end if;
  if (select count(*) from public.little_reviews where status = 'pending') >= 1000 then
    return jsonb_build_object('code','QUEUE_FULL');
  end if;
  insert into public.little_reviews (name,rating,title,body,version,status)
    values (p_name,p_rating,p_title,p_body,p_version,'pending');
  insert into public.little_review_cooldowns (ip_hash,last_submitted_at) values (p_ip_hash,now())
    on conflict (ip_hash) do update set last_submitted_at = excluded.last_submitted_at;
  return jsonb_build_object('code','ACCEPTED');
end;
$$;

create or replace function public.little_reviews_feed(p_rating integer default null, p_sort text default 'newest', p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare review_rows jsonb; distribution jsonb; total_count bigint; filtered_count bigint;
begin
  if (p_rating is not null and p_rating not between 1 and 5) or p_sort is null or p_sort not in ('newest','highest','lowest') or p_page is null or p_page not between 1 and 100 then
    raise exception 'Invalid filters';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'name',r.name,'rating',r.rating,'title',r.title,'body',r.body,'version',r.version,
    'status',r.status,'createdAt',r.created_at
  ) order by r.position),'[]'::jsonb) into review_rows from (
    select *, row_number() over (order by
      case when p_sort = 'highest' then rating end desc,
      case when p_sort = 'lowest' then rating end asc, created_at desc, id desc) as position
    from public.little_reviews where status = 'approved' and (p_rating is null or rating = p_rating)
    order by case when p_sort = 'highest' then rating end desc,
      case when p_sort = 'lowest' then rating end asc, created_at desc, id desc
    limit 6 offset ((p_page-1)*6)
  ) r;
  select jsonb_object_agg(stars::text,amount), coalesce(sum(amount),0) into distribution,total_count from (
    select stars, (select count(*) from public.little_reviews where status = 'approved' and rating = stars) as amount
    from generate_series(1,5) stars
  ) d;
  select count(*) into filtered_count from public.little_reviews where status = 'approved' and (p_rating is null or rating = p_rating);
  return jsonb_build_object('reviews',review_rows,'aggregate',jsonb_build_object('count',total_count,'distribution',distribution),'filteredCount',filtered_count);
end;
$$;
revoke all on function public.little_reviews_submit(text,integer,text,text,text,text) from public, anon, authenticated;
revoke all on function public.little_reviews_feed(integer,text,integer) from public, anon, authenticated;
grant execute on function public.little_reviews_submit(text,integer,text,text,text,text) to service_role;
grant execute on function public.little_reviews_feed(integer,text,integer) to service_role;
commit;
