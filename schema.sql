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
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz
);

create index if not exists users_chat_id_idx   on public.users (chat_id);
create index if not exists users_link_code_idx on public.users (link_code);
create index if not exists users_joined_at_idx on public.users (joined_at desc);

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
-- Row Level Security
--
-- This backend talks to Supabase with the SERVICE ROLE key, which bypasses RLS.
-- We still enable RLS and add no permissive policies, so that the anon/public
-- API key cannot read or write these tables if it ever leaks.
-- ---------------------------------------------------------------------------
alter table public.users         enable row level security;
alter table public.messages      enable row level security;
alter table public.notifications enable row level security;

-- ---------------------------------------------------------------------------
-- admin_user_overview
--
-- Per-user counters used by the admin panel, computed in the database so the
-- panel stays fast as the tables grow. security_invoker keeps the view subject
-- to the RLS of the underlying tables, so the anon key cannot read it either.
-- The backend falls back to counting in Node if this view is absent.
-- ---------------------------------------------------------------------------
create or replace view public.admin_user_overview
with (security_invoker = true) as
select
  u.id,
  u.chat_id,
  u.username,
  u.first_name,
  u.link_code,
  u.status,
  u.joined_at,
  u.last_seen,
  coalesce(m.message_count, 0)      as message_count,
  coalesce(n.notification_count, 0) as notification_count
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
) n on n.chat_id = u.chat_id;
