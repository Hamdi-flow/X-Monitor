-- Tracked Users ownership + soft-delete + cascade containment
--
-- Fixes the /track data-loss defect described in
-- docs/architecture/multi-tenant-and-web-ui.md section 1.1.
--
-- The Telegram router node "Clear Tracked Users For Chat" issues an unscoped
-- Supabase delete on "Tracked Users" (filter: user_id neq <empty>, which matches
-- every row). Because Posts_user_id_fkey cascades, one /track from any chat
-- deletes every tracked account, every post, and every reply -- for everybody.
--
-- The sibling node "Clear Telegram User Links" has the SAME defect (chat_id neq
-- <empty>, also with no value), contrary to what the architecture doc and the
-- router doc claim. It is invisible today only because "Telegram Users" holds a
-- single row.
--
-- This file is the database half of the fix. Three changes:
--
--   1. telegram_chat_id gives "Tracked Users" an ownership column. It had none,
--      so /track could not scope anything to the calling chat even in principle.
--      Interim: the target tenancy model in section 3 of the architecture doc
--      replaces this with client_id.
--   2. is_active lets /track deactivate instead of delete, so post and reply
--      history survives a re-track.
--   3. Posts_user_id_fkey becomes ON DELETE RESTRICT so that any future unscoped
--      delete fails loudly instead of silently cascading through Posts and
--      Replies.
--
-- The workflow half (router stops deleting and scopes by telegram_chat_id;
-- scheduler filters on is_active) is NOT in this file -- see TASK_TODOLIST.md.
-- Until the router is changed, a /track against a database with this migration
-- applied will FAIL at "Clear Tracked Users For Chat" with a foreign key
-- violation. That is the intended fail-closed behaviour: an error is strictly
-- better than a silent global wipe.
--
-- Replies_post_id_fkey is deliberately left ON DELETE CASCADE: deleting a post
-- should still remove that post's replies. Only the Tracked Users -> Posts edge
-- is dangerous, because that is the edge the unscoped delete crosses.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-08-24.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-08-24. Verified the same day:
-- "Tracked Users" carries telegram_chat_id and is_active, and Posts_user_id_fkey reports
-- ON DELETE RESTRICT / ON UPDATE CASCADE. An earlier revision of this header said
-- production had been deliberately deferred; that was true when written and is not now.

-- 1. Ownership -------------------------------------------------------------
-- Added nullable and backfilled (expand/migrate/contract). It becomes NOT NULL
-- in a follow-up migration, once the router's "Upsert Tracked X User" node
-- actually stamps the column -- enforcing it before then would break every
-- insert.

ALTER TABLE public."Tracked Users"
  ADD COLUMN IF NOT EXISTS telegram_chat_id text;

-- Backfill only when ownership is unambiguous, i.e. exactly one chat exists.
-- With two or more chats there is no way to infer who owns which handle, so the
-- rows are left NULL for a human to assign.
UPDATE public."Tracked Users" t
SET telegram_chat_id = u.chat_id
FROM (SELECT chat_id FROM public."Telegram Users" LIMIT 1) u
WHERE t.telegram_chat_id IS NULL
  AND (SELECT count(*) FROM public."Telegram Users") = 1;

-- 2. Soft delete -----------------------------------------------------------

ALTER TABLE public."Tracked Users"
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Supersedes an earlier index on (is_active) alone: a boolean column whose rows
-- are nearly all true is not selective enough to be worth indexing by itself.
DROP INDEX IF EXISTS public.tracked_users_is_active_idx;

-- One partial index serves both query shapes:
--   router    -- WHERE telegram_chat_id = <caller> AND is_active
--   scheduler -- WHERE is_active  (scans the partial index only)
CREATE INDEX IF NOT EXISTS tracked_users_active_owner_idx
  ON public."Tracked Users" (telegram_chat_id)
  WHERE is_active;

-- 3. Contain the cascade ---------------------------------------------------
-- posts_user_id_idx already exists, so RESTRICT is enforced against an index
-- rather than a sequential scan of "Posts".
--
-- ON UPDATE CASCADE is preserved deliberately. The two environments had drifted
-- apart before this migration:
--
--   production (jxnzdxyhoakpfmkbjdeq): ON UPDATE CASCADE ON DELETE CASCADE
--   staging    (npytqidroqxgikaqofmq): ON DELETE CASCADE
--
-- Recreating the constraint without an explicit ON UPDATE clause would silently
-- drop CASCADE when this runs on production. Only the DELETE rule is meant to
-- change, so ON UPDATE CASCADE is stated here and staging is brought in line
-- with production at the same time.

ALTER TABLE public."Posts"
  DROP CONSTRAINT IF EXISTS "Posts_user_id_fkey";

ALTER TABLE public."Posts"
  ADD CONSTRAINT "Posts_user_id_fkey"
  FOREIGN KEY (user_id)
  REFERENCES public."Tracked Users" (user_id)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
