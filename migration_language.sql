-- ===========================================================================
-- StockWatch — dil (i18n) migration
--
-- Supabase SQL Editor -> New query -> yapışdır -> Run.
-- Hər sətir idempotentdir: təkrar işlətmək heç nəyi pozmur, məlumat silmir.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. users.language
--
-- İstifadəçinin seçdiyi dil: 'az' | 'en' | 'ru' | 'tr' | 'de'.
-- Default 'az', ona görə mövcud istifadəçilər avtomatik Azərbaycanca alır.
-- --------------------------------------------------------------------------
alter table public.users
  add column if not exists language text not null default 'az';

-- Yazma anında yanlış dil kodunun düşməsinin qarşısını alır.
-- (Constraint artıq varsa, ikinci dəfə əlavə edilmir.)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_language_check'
  ) then
    alter table public.users
      add constraint users_language_check
      check (language in ('az', 'en', 'ru', 'tr', 'de'));
  end if;
end $$;

-- --------------------------------------------------------------------------
-- 2. Telegram identifikatoru
--
-- Ayrıca `telegram_id` sütunu LAZIM DEYİL: `users.chat_id` (bigint, unique)
-- artıq məhz Telegram istifadəçi id-sidir — şəxsi çatda chat.id = from.id.
-- Bütün kod (bot, /api/notify, /api/products/sync, admin panel) bu sütun
-- üzərində işləyir, ona görə dublikat sütun əlavə etmirik.
--
-- Yoxlamaq üçün:
--   select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'users';
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- 3. admin_user_overview — dil sütunu ilə yenidən qurulur
--
-- Sütun siyahısı dəyişdiyi üçün create or replace işləmir; view-də məlumat
-- saxlanmır, ona görə drop + create təhlükəsizdir.
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
  u.language,
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
