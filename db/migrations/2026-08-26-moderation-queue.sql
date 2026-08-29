-- Durable hide-replies moderation queue + per-token X rate-limit state
--
-- Implements the design in docs/architecture/limits-and-capacity.md section 2.2
-- ("Hide -- the one that actually bites") and closes defect G in
-- docs/architecture/multi-tenant-and-web-ui.md:93.
--
-- The problem: X caps PUT /2/tweets/:id/hidden at 50 requests per 15 minutes
-- PER ACCESS TOKEN. The Telegram router hid replies inline and tracked the
-- limit in n8n WORKFLOW STATIC DATA (`$getWorkflowStaticData('global')
-- .xHideRateLimits`, written by "Prepare Hide Result"). That cache is
-- per-workflow while the limit is per-token, it is invisible to any second
-- entry point (the console), and when quota ran out the router hid what it
-- could, silently dropped the rest, and told the user to retry by hand.
--
-- The fix: the router enqueues every candidate reply here, and
-- "XMonitor - Moderation Queue Drain (Staging)" drains the queue on a
-- 5-minute schedule inside the real quota, reading and writing that quota in
-- "X Rate Limits" instead of static data.
--
-- SCOPE ADAPTATION -- READ THIS BEFORE ADDING THE MULTI-TENANT COLUMNS.
--
-- Section 2.2 declares action_id and client_id as NOT NULL foreign keys to
-- "Action Log" and "Clients". Neither table exists: this database has only
-- Posts, Tracked Users, Replies, Telegram Users, X Auth Sessions,
-- X Auth Accounts, Order Info, Run State, the Copycat/Muses tables and the
-- FB * tables. Both belong to the unbuilt multi-tenant phase (section 3 of
-- multi-tenant-and-web-ui.md).
--
-- So the columns are created here with the names and types section 2.2 gives
-- them, but NULLABLE and WITHOUT the foreign keys. When "Action Log" and
-- "Clients" land, the follow-up migration is a backfill plus
--
--   ALTER TABLE public."Moderation Queue"
--     ALTER COLUMN action_id SET NOT NULL,
--     ADD CONSTRAINT "Moderation Queue_action_id_fkey"
--       FOREIGN KEY (action_id) REFERENCES public."Action Log"(id) ON DELETE CASCADE;
--
-- -- no column renames, no data rewrite. The same applies to client_id.
--
-- Until then, telegram_chat_id carries ownership, exactly as it does on
-- "Tracked Users" after 2026-08-24-tracked-users-soft-delete.sql.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq, "XMonitor Staging") on 2026-08-26.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-08-27, together with the
-- router promotion and "XMonitor - Moderation Queue Drain". Verified the same
-- day: both tables present with RLS on, moderation_queue_due_idx and
-- moderation_queue_batch_idx created.

-- 1. Moderation Queue ------------------------------------------------------
--
-- gen_random_uuid() for the primary key follows section 2.2 verbatim and the
-- house convention already set by "Order Info" and "FB Moderation Actions".
-- It is a random (v4) uuid, so it does scatter index inserts -- acceptable
-- here because the queue is a working set, not an archive: rows reach 'done'
-- within minutes and the table stays small. Prefer bigint identity for any
-- table meant to grow without bound.

CREATE TABLE IF NOT EXISTS public."Moderation Queue" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deferred multi-tenant keys. Nullable, no FK. See the header.
  action_id   uuid,
  client_id   uuid,

  post_id     text NOT NULL,
  reply_id    text NOT NULL,

  -- Whose 50-per-15-minutes bucket this row spends. The drain groups by this
  -- column, so it is the leading column of the due index below.
  x_user_id   text NOT NULL,

  -- Interim ownership + the Telegram message the drain edits in place to show
  -- live progress (section 2.2 step 4). Section 2.2 keeps message_id in
  -- "Action Log".result; with no Action Log it lives on the queue row, and
  -- batch_id is what groups the rows one enqueue produced so a drain pass can
  -- count "38 of 120" without an Action Log to read.
  telegram_chat_id    text,
  telegram_message_id bigint,
  batch_id            uuid NOT NULL DEFAULT gen_random_uuid(),

  -- Only 'hide' exists today. The column is here so a future 'unhide' or
  -- 'delete_reply' does not need a second queue table.
  action      text NOT NULL DEFAULT 'hide'
                CHECK (action IN ('hide')),

  status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','in_flight','done','failed','abandoned')),

  -- attempts counts DISPATCHED requests only. The drain deliberately does not
  -- charge an attempt for a 429: being rate limited says nothing about whether
  -- the hide would succeed, and charging it would abandon a healthy row after
  -- five busy windows.
  attempts    integer NOT NULL DEFAULT 0
                CHECK (attempts >= 0),

  not_before  timestamptz NOT NULL DEFAULT now(),

  -- last_error is the operator-facing reason; last_error_code is the machine
  -- category from "Prepare Drain Hide Result" (x_auth_rejected,
  -- reply_not_found, x_rate_limited, ...). The drain keys its retry-vs-fail
  -- decision off the code, so it is stored rather than re-parsed from prose.
  last_error      text,
  last_error_code text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Section 2.2: "one pending hide per reply, ever". Enforced globally rather
  -- than per-status so a double tap on the Hide button cannot enqueue a reply
  -- twice. Re-hiding after a permanent failure is still possible: the router
  -- enqueues with ON CONFLICT (reply_id) DO UPDATE, which re-arms a row
  -- sitting in 'failed' or 'abandoned' instead of inserting a second one.
  CONSTRAINT "Moderation Queue_reply_id_key" UNIQUE (reply_id)
);

COMMENT ON TABLE public."Moderation Queue" IS
  'Durable queue for X reply moderation, drained by "XMonitor - Moderation Queue Drain" '
  'inside the per-token 50-per-15-minute hide limit. See '
  'docs/architecture/limits-and-capacity.md section 2.2. '
  'DEFERRED: action_id and client_id are nullable and carry no foreign key because '
  '"Action Log" and "Clients" do not exist yet; add the FKs and NOT NULL when the '
  'multi-tenant phase lands. Until then telegram_chat_id carries ownership.';

COMMENT ON COLUMN public."Moderation Queue".action_id IS
  'DEFERRED FK -> "Action Log"(id) ON DELETE CASCADE. Nullable until "Action Log" exists.';
COMMENT ON COLUMN public."Moderation Queue".client_id IS
  'DEFERRED FK -> "Clients"(id) ON DELETE CASCADE. Nullable until "Clients" exists.';
COMMENT ON COLUMN public."Moderation Queue".x_user_id IS
  'The X account whose 50-per-15-minute hide bucket this row spends.';
COMMENT ON COLUMN public."Moderation Queue".telegram_message_id IS
  'Telegram message the drain edits via editMessageText to show live progress. '
  'Stored at enqueue time -- without it the drain has nothing to edit.';
COMMENT ON COLUMN public."Moderation Queue".attempts IS
  'Dispatched X requests. 429s are not counted. attempts >= 5 on a retryable '
  'failure moves the row to abandoned.';

-- The drain's only hot query, in both of its shapes:
--   find work   -- WHERE status='queued' AND not_before <= now() GROUP BY x_user_id
--   claim rows  -- WHERE status='queued' AND x_user_id = $1 AND not_before <= now()
--                  ORDER BY not_before ... FOR UPDATE SKIP LOCKED
-- Partial on status='queued' because that is the only status the drain scans,
-- and because rows spend the rest of their life in 'done' -- a full index would
-- be mostly dead weight within an hour of any large hide.
CREATE INDEX IF NOT EXISTS moderation_queue_due_idx
  ON public."Moderation Queue" (x_user_id, not_before)
  WHERE status = 'queued';

-- Progress reporting reads one batch at a time ("38 of 120 hidden"), and the
-- router's post-send update stamps telegram_message_id by batch.
CREATE INDEX IF NOT EXISTS moderation_queue_batch_idx
  ON public."Moderation Queue" (batch_id);

-- 2. X Rate Limits ---------------------------------------------------------
--
-- Replaces the n8n workflow static-data cache. Keyed by (x_user_id, endpoint)
-- because the bucket belongs to the token, not to the workflow -- that key IS
-- the fix for defect G. Written from the x-rate-limit-* response headers after
-- every drain pass, read by the drain before it claims.

CREATE TABLE IF NOT EXISTS public."X Rate Limits" (
  x_user_id      text NOT NULL,

  -- Full method + path template, e.g. 'PUT /2/tweets/:id/hidden'. Matches the
  -- ENDPOINT_KEY the router used in its static-data cache key, so historical
  -- log lines still line up.
  endpoint       text NOT NULL,

  -- x-rate-limit-limit. Named limit_ceiling because "limit" is a reserved word
  -- and would need quoting at every call site.
  limit_ceiling  integer,
  remaining      integer,

  -- x-rate-limit-reset, converted from epoch seconds to timestamptz. The drain
  -- sets Moderation Queue.not_before to this value when quota is gone.
  reset_at       timestamptz,

  observed_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "X Rate Limits_pkey" PRIMARY KEY (x_user_id, endpoint)
);

COMMENT ON TABLE public."X Rate Limits" IS
  'Per-access-token X rate-limit state, replacing the n8n workflow static-data cache. '
  'Keyed by (x_user_id, endpoint) because X buckets belong to the token, not the workflow '
  '-- defect G in docs/architecture/multi-tenant-and-web-ui.md. '
  'DEFERRED: gains client_id alongside x_user_id when "Clients" exists.';
COMMENT ON COLUMN public."X Rate Limits".limit_ceiling IS
  'x-rate-limit-limit response header. 50 for PUT /2/tweets/:id/hidden.';
COMMENT ON COLUMN public."X Rate Limits".reset_at IS
  'x-rate-limit-reset, converted from epoch seconds. Quota is assumed full again once passed.';

-- 3. updated_at maintenance ------------------------------------------------
-- The drain writes queue rows from more than one node, and a forgotten
-- updated_at makes "is this queue stuck?" unanswerable. A trigger is used
-- rather than trusting every call site to set it.

CREATE OR REPLACE FUNCTION public.set_moderation_queue_updated_at()
RETURNS trigger
LANGUAGE plpgsql
-- Empty search_path: the function references only pg_catalog operators, so it
-- resolves nothing from a caller-controlled schema.
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moderation_queue_set_updated_at ON public."Moderation Queue";
CREATE TRIGGER moderation_queue_set_updated_at
  BEFORE UPDATE ON public."Moderation Queue"
  FOR EACH ROW
  EXECUTE FUNCTION public.set_moderation_queue_updated_at();

-- 4. Row level security ----------------------------------------------------
-- Matches every other table in this schema: RLS enabled with no policies, so
-- anon and authenticated can read nothing. n8n connects with the service role
-- and bypasses RLS. When the console gains direct client access it needs
-- explicit per-client policies -- do not add a blanket USING (true).

ALTER TABLE public."Moderation Queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."X Rate Limits"    ENABLE ROW LEVEL SECURITY;
