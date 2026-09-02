-- ===========================================================================
-- StockWatch — 2026-08-25 migration
--
-- Run this in the Supabase SQL editor on an EXISTING database.
-- (A fresh database can just run schema.sql, which already contains all of it.)
--
-- Adds:
--   1. users.is_active      — admin on/off switch  (DÜZƏLİŞ 6)
--   2. support_messages     — two-way support inbox (DÜZƏLİŞ 8+9)
--   3. admin_user_overview  — rebuilt so the panel sees is_active
--
-- Every statement is idempotent; re-running it changes nothing and deletes no data.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. users.is_active
--
-- Separate from the existing `status` column on purpose:
--   status    = what Telegram tells us  ('active' / 'blocked')
--   is_active = what the admin decides  (true / false)
-- A deactivated user is skipped by every send path and by the extension's loop.
-- --------------------------------------------------------------------------
alter table public.users
  add column if not exists is_active boolean not null default true;

create index if not exists users_is_active_idx on public.users (is_active);

-- --------------------------------------------------------------------------
-- 2. support_messages
--
-- One row per incoming support message. `reply` and `status` are filled in when
-- the support group or the admin panel answers it.
-- --------------------------------------------------------------------------
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

alter table public.support_messages enable row level security;

-- --------------------------------------------------------------------------
-- 3. admin_user_overview — rebuilt with is_active
--
-- create or replace cannot reorder existing columns, so the view is dropped and
-- recreated. It holds no data of its own.
-- --------------------------------------------------------------------------
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
