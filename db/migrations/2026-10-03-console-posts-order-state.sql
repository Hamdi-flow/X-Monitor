-- console_posts: read order_state from "Order Info", not only from Posts.status
--
-- WHY. "Posts".status is one overloaded column (defect H): it holds suppression
-- (New / Snoozed / Ignored) and order lifecycle (Processing / Done / Order Failed).
-- When a post with a finished order is later ignored or snoozed, 'Done' is
-- overwritten and the view reported order_state = 'none'. On 2026-10-03 all four
-- production orders were 'completed' in "Order Info" while their posts read
-- 'none', so the console showed no order badge and the "Order: Done" filter found
-- nothing.
--
-- WHAT CHANGES. Only the order_state expression. It now uses the newest
-- "Order Info" row per post:
--   pending / in_progress / processing      -> 'processing'
--   completed / partial                     -> 'done'
--   failed / canceled / cancelled / refunded -> 'failed'
--   any other non-null status               -> 'processing'
--     (still with the provider -- never silently 'done'; matches the console's
--      orderStatusTone)
--   no order row, or a NULL status          -> the previous Posts.status decoding,
--     so nothing that worked before gets worse.
-- Column names, types and order are unchanged, so CREATE OR REPLACE applies and
-- the console needs no code change. security_invoker is restated because
-- CREATE OR REPLACE VIEW replaces the view's options. Grants are kept by
-- CREATE OR REPLACE.
--
-- WHAT IT DOES NOT FIX. suppression_state is still decoded from Posts.status, so
-- an order still overwrites a snooze and suppression reads 'unknown'. Only the
-- planned suppression_status / order_state column split closes that.
--
-- READERS. Only X-Monitor-Console (lib/platform/x.ts). No n8n workflow reads it.
--
-- This file is also the first time the view's definition is in source control;
-- before it, it existed only in the two databases (identical, md5
-- 88e8ae004acebb6da637590dde13ed9b of pg_get_viewdef on 2026-10-03).
--
-- Applied: staging npytqidroqxgikaqofmq, then production jxnzdxyhoakpfmkbjdeq,
-- 2026-10-03.

create or replace view public.console_posts
with (security_invoker = true)
as
select
  p.post_id,
  p.user_id,
  p.post_text,
  p.comment_count,
  p.analyzed_count,
  p.negative_count,
  p.negative_ratio,
  p.snooze_runs_remaining,
  p.created_at,
  p.status as status_raw,
  p.like_count,
  p.retweet_count,
  p.quote_count,
  p.bookmark_count,
  p.impression_count,
  p.metrics_updated_at,
  p.status_changed_at,
  p.status_changed_by,
  case p.status
    when 'New' then 'active'
    when 'Snoozed' then 'snoozed'
    when 'Ignored' then 'ignored'
    else 'unknown'
  end as suppression_state,
  p.status = any (array['New', 'Snoozed', 'Ignored']) as suppression_state_is_certain,
  coalesce(
    case
      when lower(o.normalized_status) in ('pending', 'in_progress', 'processing') then 'processing'
      when lower(o.normalized_status) in ('completed', 'partial') then 'done'
      when lower(o.normalized_status) in ('failed', 'canceled', 'cancelled', 'refunded') then 'failed'
      when o.normalized_status is not null then 'processing'
    end,
    case p.status
      when 'Processing' then 'processing'
      when 'Done' then 'done'
      when 'Order Failed' then 'failed'
      else 'none'
    end
  ) as order_state,
  t.username,
  t.display_name,
  t.telegram_chat_id,
  t.is_active as account_is_active,
  coalesce(nullif(t.display_name, ''), '@' || t.username) as author_label,
  case
    when t.username is null then null
    else 'https://x.com/' || t.username || '/status/' || p.post_id
  end as post_url
from "Posts" p
left join "Tracked Users" t on t.user_id = p.user_id
left join lateral (
  select oi.normalized_status
  from "Order Info" oi
  where oi.post_id = p.post_id
  order by oi.created_at desc nulls last, oi.id desc
  limit 1
) o on true;

-- ROLLBACK (the definition before this file):
--
-- create or replace view public.console_posts
-- with (security_invoker = true)
-- as
-- select p.post_id, p.user_id, p.post_text, p.comment_count, p.analyzed_count,
--   p.negative_count, p.negative_ratio, p.snooze_runs_remaining, p.created_at,
--   p.status as status_raw, p.like_count, p.retweet_count, p.quote_count,
--   p.bookmark_count, p.impression_count, p.metrics_updated_at,
--   p.status_changed_at, p.status_changed_by,
--   case p.status when 'New' then 'active' when 'Snoozed' then 'snoozed'
--     when 'Ignored' then 'ignored' else 'unknown' end as suppression_state,
--   p.status = any (array['New', 'Snoozed', 'Ignored']) as suppression_state_is_certain,
--   case p.status when 'Processing' then 'processing' when 'Done' then 'done'
--     when 'Order Failed' then 'failed' else 'none' end as order_state,
--   t.username, t.display_name, t.telegram_chat_id, t.is_active as account_is_active,
--   coalesce(nullif(t.display_name, ''), '@' || t.username) as author_label,
--   case when t.username is null then null
--     else 'https://x.com/' || t.username || '/status/' || p.post_id end as post_url
-- from "Posts" p
-- left join "Tracked Users" t on t.user_id = p.user_id;
