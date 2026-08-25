-- Console read model — engagement, provenance, chat labels, and a status decoder
--
-- Backs Phase 4 of docs/architecture/multi-tenant-and-web-ui.md: the read-only
-- X-Monitor Console (sibling repo X-Monitor-Console). Phase 4 was pulled ahead of
-- Phases 2-3 because the /track fix gave "Tracked Users" a telegram_chat_id, which
-- serves as the grouping key until the "Clients" table of section 3 exists.
--
-- ADDITIVE ONLY. Every column is nullable with no default and no constraint, no
-- existing column changes type or nullability, and nothing is dropped. That is
-- deliberate: this migration lands while another session is editing
-- "XMonitor - Scheduled Post Tracking" and "XMonitor - Telegram Router". New
-- nullable columns cannot conflict with a workflow edit, so the two pieces of work
-- are safe to interleave. No workflow is touched here.
--
-- Consequence: sections 1-3 add columns that NOTHING WRITES YET. Populating them
-- is a follow-up task once the concurrent workflow session lands. Until then every
-- one of them is NULL for every row, and that is the point --
--
--     NULL means "not yet collected", NOT zero.
--
-- A post showing 0 impressions is a factual claim this data does not support. The
-- console must branch on metrics_updated_at IS NULL and render "not yet collected".
-- The same holds for status_changed_at and moderated_at: their absence means the
-- provenance was never recorded, not that the change never happened. Every row that
-- exists today was moderated or had its status changed by a workflow that did not
-- write these columns.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-08-25.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-08-25.
--
-- Verified the same day in both, via the runbook at the foot of this file:
-- all 11 new columns present and nullable, and every distinct "Posts".status
-- value in the data decodes without falling through to unknown/none. Staging
-- holds 2 posts, both 'New' -> active; production holds 22, all 'Ignored' ->
-- ignored. No row in either environment currently exercises the order-state
-- branch or the suppression_state_is_certain = false path, so those are
-- verified by construction rather than by data -- re-run the second runbook
-- query after the next order to confirm them against a real row.

BEGIN;

-- 1. Engagement --------------------------------------------------------------
-- X returns public_metrics on every post in every fetch the tracker already makes,
-- so storing all five costs nothing extra against the pay-per-usage billing
-- described in docs/architecture/limits-and-capacity.md. Storing a subset would
-- mean a second fetch later to get the rest, at full price per post resource.
--
-- integer, not bigint: X caps impression_count well inside int4 range for the
-- account sizes in decision #4 (<15 accounts). If a viral post ever approaches
-- 2.1 billion impressions this needs widening, which is a painless ALTER.
--
-- metrics_updated_at is the load-bearing column, not the counts. It is the ONLY
-- way to distinguish "we fetched and this post genuinely has zero likes" from
-- "we have never fetched". Both look like NULL counts today; after the workflow
-- follow-up lands, only the first will have a non-NULL timestamp.

ALTER TABLE public."Posts"
  ADD COLUMN IF NOT EXISTS like_count         integer,
  ADD COLUMN IF NOT EXISTS retweet_count      integer,
  ADD COLUMN IF NOT EXISTS quote_count        integer,
  ADD COLUMN IF NOT EXISTS bookmark_count     integer,
  ADD COLUMN IF NOT EXISTS impression_count   integer,
  ADD COLUMN IF NOT EXISTS metrics_updated_at timestamptz;

COMMENT ON COLUMN public."Posts".metrics_updated_at IS
  'When public_metrics was last read from X. NULL means never collected -- the '
  'five *_count columns must render as "not yet collected", never as zero. '
  'A non-NULL timestamp with zero counts is a real measurement.';

-- 2. Post status provenance --------------------------------------------------
-- Answers "what happened here", which a status column alone cannot. Today a post
-- reading 'Ignored' cannot tell you when it was ignored or by whom, so the console
-- can only show current truth with no history behind it.
--
-- status_changed_by is a Telegram chat id (text, matching
-- "Tracked Users".telegram_chat_id and "Order Info".telegram_chat_id) rather than a
-- user id, because Telegram is the only actor today. Section 6.1 replaces this with
-- a typed actor {channel, chat_id, user_id} once the Action Executor exists and the
-- console can act; until then a chat id is the whole truth. Deliberately NOT a
-- foreign key to "Telegram Users": an order poller writing 'Processing' has no chat
-- to attribute, and an FK would force a fake one.

ALTER TABLE public."Posts"
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by text;

COMMENT ON COLUMN public."Posts".status_changed_by IS
  'Telegram chat id that last changed "Posts".status, or NULL when the change came '
  'from a workflow with no human actor (e.g. the order poller writing Processing/ '
  'Done, or the scheduler auto-resuming an expired snooze). Not an FK on purpose. '
  'Superseded by the typed actor in architecture section 6.1 at Phase 5.';

-- 3. Reply moderation provenance ---------------------------------------------
-- "Replies".status already records that a reply is hidden; these record when and by
-- whom. Section 4.2 specifies moderated_at plus last_moderation_error at Phase 2 --
-- only moderated_at is taken here, because last_moderation_error needs the Action
-- Executor to have somewhere to write it from.
--
-- The sibling FB Monitor project has carried exactly this pair since
-- 20260820120000_fb_baseline_schema.sql ("FB Comments".moderated_at,
-- last_moderation_error) plus an append-only "FB Moderation Actions" audit table.
-- Same shape, same names, deliberately -- the two projects share this schema and
-- people read them together.

ALTER TABLE public."Replies"
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz,
  ADD COLUMN IF NOT EXISTS moderated_by text;

COMMENT ON COLUMN public."Replies".moderated_at IS
  'When this reply was hidden or a hide was attempted. NULL means no moderation '
  'attempt was ever RECORDED -- which for every row predating this migration is '
  'true even where status = ''hidden''. Do not infer "never moderated" from NULL.';

-- 4. Telegram chat labels ----------------------------------------------------
-- "Telegram Users" holds chat_id and nothing else, so every console screen that
-- groups by chat would print a raw number like 8372903693 as a group heading.
--
-- Left NULL here on purpose. Labels name real people and cannot be invented from
-- the data; the console falls back to the raw chat id until a human fills them in.
-- See the foot of this file for the UPDATE.
--
-- Prior art in the same schema: "FB Notification Recipients".label
-- (20260821120000_fb_config_management.sql) already does this for the FB side, with
-- a chat_type column alongside. Telegram chat ids are global rather than per-bot,
-- so the same id identifies the same chat in both tables and the two directories
-- can be reconciled later.

ALTER TABLE public."Telegram Users"
  ADD COLUMN IF NOT EXISTS label text;

COMMENT ON COLUMN public."Telegram Users".label IS
  'Human-friendly name for this chat, for display only. NULL falls back to the raw '
  'chat_id. Mirrors "FB Notification Recipients".label in this same schema.';

-- 5. console_posts -- decode the overloaded status column ---------------------
-- Defect H in architecture section 1.2: "Posts".status carries two independent
-- state machines in one text column.
--
--     suppression   New | Snoozed | Ignored          (router, scheduler)
--     order         Processing | Done | Order Failed (order poller)
--
-- They overwrite each other. Placing an order on a snoozed post writes 'Processing'
-- over 'Snoozed' and the snooze is gone from the column -- though
-- snooze_runs_remaining survives, which is what makes partial recovery possible
-- below. Section 4.2 splits these into real columns at Phase 2. This view is the
-- interim, and exists so the console does not reimplement the decoding in
-- TypeScript -- which would guarantee the app and the workflows disagree about what
-- a post's state is the first time either changes.
--
-- The honest part is suppression_state_is_certain. When an order state occupies the
-- column, the suppression state is genuinely UNKNOWN, not 'active'. Reporting
-- 'active' there would be an invention: the post may well be snoozed. The view says
-- so, and hands the caller snooze_runs_remaining as the one surviving clue.
--
-- security_invoker = true is deliberate and load-bearing. A Postgres view defaults
-- to running with its OWNER's privileges, which would make this view a standing RLS
-- bypass on "Posts" and "Tracked Users" the moment Phase 4's RLS policies land --
-- exactly the hole that phase exists to close. With security_invoker the view is
-- evaluated as the querying role, so it inherits whatever policies those tables
-- carry. The console reads it with the service key, which bypasses RLS regardless;
-- this setting protects the roles that come later, not the one using it today.

CREATE OR REPLACE VIEW public.console_posts
WITH (security_invoker = true) AS
SELECT
  p.post_id,
  p.user_id,
  p.post_text,
  p.comment_count,
  p.analyzed_count,
  p.negative_count,
  p.negative_ratio,
  p.snooze_runs_remaining,
  p.created_at,

  -- kept verbatim so the console can show the underlying value when the decode
  -- lands on 'unknown', and so an unrecognised future value is never silently
  -- swallowed by the CASE below
  p.status AS status_raw,

  p.like_count,
  p.retweet_count,
  p.quote_count,
  p.bookmark_count,
  p.impression_count,
  p.metrics_updated_at,
  p.status_changed_at,
  p.status_changed_by,

  CASE p.status
    WHEN 'New'     THEN 'active'
    WHEN 'Snoozed' THEN 'snoozed'
    WHEN 'Ignored' THEN 'ignored'
    ELSE 'unknown'
  END AS suppression_state,

  -- false whenever an order state (or anything unrecognised) is sitting in the
  -- column, i.e. whenever suppression_state = 'unknown'
  (p.status IN ('New', 'Snoozed', 'Ignored')) AS suppression_state_is_certain,

  CASE p.status
    WHEN 'Processing'   THEN 'processing'
    WHEN 'Done'         THEN 'done'
    WHEN 'Order Failed' THEN 'failed'
    ELSE 'none'
  END AS order_state,

  -- author, joined here rather than in the app because the Supabase project is in
  -- ap-northeast-1 and the operator is in Beirut -- roughly 250ms per round trip
  -- (decision #13), so the posts screen is one query instead of two
  t.username,
  t.display_name,
  t.telegram_chat_id,
  t.is_active AS account_is_active,

  -- display_name is NULL on every row today; the fallback is baked in so every
  -- caller renders the same thing
  coalesce(nullif(t.display_name, ''), '@' || t.username) AS author_label,

  CASE
    WHEN t.username IS NULL THEN NULL
    ELSE 'https://x.com/' || t.username || '/status/' || p.post_id
  END AS post_url

FROM public."Posts" p
LEFT JOIN public."Tracked Users" t ON t.user_id = p.user_id;

-- LEFT JOIN, not INNER: "Posts_user_id_fkey" is ON DELETE RESTRICT as of
-- 2026-08-24-tracked-users-soft-delete.sql, so an orphan post should be impossible
-- -- but a view that silently drops rows is a bad way to find out otherwise. An
-- orphan surfaces with a NULL username and a NULL post_url instead of vanishing.

COMMENT ON VIEW public.console_posts IS
  'Read model for the X-Monitor Console. Decodes the overloaded "Posts".status into '
  'independent suppression_state and order_state, and joins the author. Interim -- '
  'architecture section 4.2 replaces it with real columns at Phase 2. Read-only by '
  'construction (a join makes it non-updatable). All writes go through the n8n '
  'Action Gateway, never this view -- see architecture section 6.';

COMMENT ON COLUMN public.console_posts.suppression_state_is_certain IS
  'false when an order state occupies "Posts".status and has overwritten the '
  'suppression state (defect H). suppression_state is then ''unknown'' and the '
  'caller should fall back to snooze_runs_remaining > 0 as a hint, not a fact.';

-- Nothing but the service key reads this in Phase 4, and no RLS policy exists yet
-- to constrain the anon/authenticated roles Supabase grants by default. Revoke
-- rather than rely on the base tables, so an accidental grant later does not expose
-- every client's posts to the browser.
REVOKE ALL ON public.console_posts FROM anon, authenticated;

COMMIT;


-- Runbook ---------------------------------------------------------------------
--
-- 1. Apply to staging npytqidroqxgikaqofmq, then verify:
--
--      select column_name, data_type, is_nullable
--        from information_schema.columns
--       where table_schema = 'public'
--         and (   (table_name = 'Posts'
--                  and column_name in ('like_count','retweet_count','quote_count',
--                                      'bookmark_count','impression_count',
--                                      'metrics_updated_at','status_changed_at',
--                                      'status_changed_by'))
--              or (table_name = 'Replies'
--                  and column_name in ('moderated_at','moderated_by'))
--              or (table_name = 'Telegram Users' and column_name = 'label'))
--       order by table_name, column_name;
--
--    Expect 11 rows, every one is_nullable = YES.
--
--      select status_raw, suppression_state, suppression_state_is_certain,
--             order_state, count(*)
--        from public.console_posts
--       group by 1,2,3,4 order by 5 desc;
--
--    Every distinct "Posts".status value in the data must land on a non-'unknown'
--    suppression_state or a non-'none' order_state. A row that is BOTH 'unknown'
--    and 'none' is a status literal this CASE does not know about -- investigate
--    before applying to production rather than after.
--
-- 2. Apply to production jxnzdxyhoakpfmkbjdeq, run the same two checks, and record
--    both dates in the header above.
--
-- 3. Chat labels. Not part of the migration because the names are not derivable
--    from any data in this database -- they must come from a human. Fill them in
--    once, per environment:
--
--      select chat_id, label from public."Telegram Users" order by chat_id;
--
--      update public."Telegram Users" set label = '<name>'
--       where chat_id = '<id>';
--
--    The console renders the raw chat_id until this is done, which is correct but
--    unfriendly.
