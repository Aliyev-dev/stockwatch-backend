-- StockWatch backend schema.
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).
-- Safe to re-run: every statement is idempotent.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null unique,
  username    text,
  first_name  text,
  link_code   text not null unique,
  status      text not null default 'active',
  -- Admin on/off switch, independent of `status` (which reflects Telegram):
  -- a deactivated user is skipped by every send path.
  is_active   boolean not null default true,
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz
);

create index if not exists users_chat_id_idx   on public.users (chat_id);
create index if not exists users_link_code_idx on public.users (link_code);
create index if not exists users_joined_at_idx on public.users (joined_at desc);
create index if not exists users_is_active_idx on public.users (is_active);

-- Existing databases: add the column without touching any data.
alter table public.users add column if not exists is_active boolean not null default true;

-- ---------------------------------------------------------------------------
-- messages  (support chat, both directions)
--   direction 'in'  = user -> admin
--   direction 'out' = admin -> user
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  direction   text not null check (direction in ('in', 'out')),
  text        text,
  created_at  timestamptz not null default now()
);

create index if not exists messages_chat_id_idx    on public.messages (chat_id);
create index if not exists messages_created_at_idx on public.messages (created_at desc);

-- ---------------------------------------------------------------------------
-- notifications  (alerts pushed by the Chrome extension via POST /api/notify)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  text        text,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_chat_id_idx    on public.notifications (chat_id);
create index if not exists notifications_created_at_idx on public.notifications (created_at desc);

-- ---------------------------------------------------------------------------
-- products  (what each user is watching; pushed by the extension via
--            POST /api/products/sync, which replaces the owner's whole list)
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  chat_id        bigint not null,
  asin           text not null,
  name           text,
  domain         text not null,
  threshold      int,
  last_status    text,
  last_quantity  int,
  last_price     text,
  updated_at     timestamptz not null default now()
);

create unique index if not exists products_owner_item_key on public.products (chat_id, asin, domain);
create index if not exists products_chat_id_idx    on public.products (chat_id);
create index if not exists products_updated_at_idx on public.products (updated_at desc);

-- ---------------------------------------------------------------------------
-- support_messages  (two-way support inbox: the bot writes incoming messages,
--                    the support group or the admin panel writes the reply)
-- ---------------------------------------------------------------------------
create table if not exists public.support_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  username    text,
  message     text not null,
  reply       text,
  status      text not null default 'open' check (status in ('open', 'answered')),
  created_at  timestamptz not null default now(),
  replied_at  timestamptz
);

create index if not exists support_messages_chat_id_idx    on public.support_messages (chat_id);
create index if not exists support_messages_status_idx     on public.support_messages (status);
create index if not exists support_messages_created_at_idx on public.support_messages (created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- This backend talks to Supabase with the SERVICE ROLE key, which bypasses RLS.
-- We still enable RLS and add no permissive policies, so that the anon/public
-- API key cannot read or write these tables if it ever leaks.
-- ---------------------------------------------------------------------------
alter table public.users         enable row level security;
alter table public.messages      enable row level security;
alter table public.notifications enable row level security;
alter table public.products      enable row level security;
alter table public.support_messages enable row level security;

-- ---------------------------------------------------------------------------
-- admin_user_overview
--
-- Per-user counters used by the admin panel, computed in the database so the
-- panel stays fast as the tables grow. security_invoker keeps the view subject
-- to the RLS of the underlying tables, so the anon key cannot read it either.
-- The backend falls back to counting in Node if this view is absent.
--
-- The view is dropped and recreated rather than replaced, because its column
-- list has grown; it holds no data of its own, so this is safe to re-run.
-- ---------------------------------------------------------------------------
drop view if exists public.admin_user_overview;

create view public.admin_user_overview
with (security_invoker = true) as
select
  u.id,
  u.chat_id,
  u.username,
  u.first_name,
  u.link_code,
  u.status,
  u.is_active,
  u.joined_at,
  u.last_seen,
  coalesce(m.message_count, 0)      as message_count,
  coalesce(n.notification_count, 0) as notification_count,
  coalesce(p.product_count, 0)      as product_count
from public.users u
left join (
  select chat_id, count(*)::bigint as message_count
  from public.messages
  group by chat_id
) m on m.chat_id = u.chat_id
left join (
  select chat_id, count(*)::bigint as notification_count
  from public.notifications
  group by chat_id
) n on n.chat_id = u.chat_id
left join (
  select chat_id, count(*)::bigint as product_count
  from public.products
  group by chat_id
) p on p.chat_id = u.chat_id;
