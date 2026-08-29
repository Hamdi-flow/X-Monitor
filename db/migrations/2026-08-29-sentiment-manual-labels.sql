-- Manual sentiment ground truth + per-client cheat sheets.
--
-- Purpose: give the sentiment analyzer a feedback loop. Reviewers hand-label
-- stored replies; a weekly job turns the disagreements into a per-client cheat
-- sheet that is appended to the analyzer's system prompt.
--
-- Applied to: XMonitor Staging (npytqidroqxgikaqofmq) first, production
-- (jxnzdxyhoakpfmkbjdeq) after staging validation.
--
-- NOTE ON PREREQUISITE: this feedback loop is meaningless until the production
-- "Insert or update replies" node writes Replies.sentiment again. The 2026-08-25
-- Phase 1 promotion dropped the sentiment/analyzed_at column mappings that the
-- staging scheduler still has, so production replies would land with a NULL AI
-- label and there would be nothing to compare a manual label against.

-- ---------------------------------------------------------------------------
-- 1. Manual label columns on "Replies"
-- ---------------------------------------------------------------------------
-- All nullable: adding them is a metadata-only change, no table rewrite.
ALTER TABLE public."Replies"
  ADD COLUMN IF NOT EXISTS manual_sentiment      text,
  ADD COLUMN IF NOT EXISTS manual_sentiment_note text,
  ADD COLUMN IF NOT EXISTS manual_labeled_at     timestamptz,
  ADD COLUMN IF NOT EXISTS manual_labeled_by     text;

COMMENT ON COLUMN public."Replies".manual_sentiment IS
  'Human ground-truth label: Positive | Neutral | Negative. NULL = not yet reviewed. '
  'Compared against "sentiment" (the model label) to mine cheat sheet rules.';
COMMENT ON COLUMN public."Replies".manual_sentiment_note IS
  'Why the reviewer chose that label. Free text; the weekly job feeds these to the '
  'rule generator, so short concrete reasons beat essays.';
COMMENT ON COLUMN public."Replies".manual_labeled_at IS
  'Set automatically by replies_touch_manual_label whenever manual_sentiment changes. '
  'The weekly cheat sheet job uses this as its incremental watermark.';
COMMENT ON COLUMN public."Replies".manual_labeled_by IS
  'Who labelled it. Filled by hand in the Supabase table editor.';

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so guard it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'replies_manual_sentiment_check'
      AND conrelid = 'public."Replies"'::regclass
  ) THEN
    ALTER TABLE public."Replies"
      ADD CONSTRAINT replies_manual_sentiment_check
      CHECK (manual_sentiment IN ('Positive', 'Neutral', 'Negative'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Keep manual_labeled_at honest
-- ---------------------------------------------------------------------------
-- Reviewers work in the Supabase table editor and will not fill a timestamp by
-- hand. The weekly job's "labels since last run" query depends on this, so the
-- database sets it rather than trusting the surface.
CREATE OR REPLACE FUNCTION public.touch_reply_manual_label()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.manual_sentiment IS DISTINCT FROM OLD.manual_sentiment THEN
    NEW.manual_labeled_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS replies_touch_manual_label ON public."Replies";
CREATE TRIGGER replies_touch_manual_label
  BEFORE UPDATE OF manual_sentiment ON public."Replies"
  FOR EACH ROW EXECUTE FUNCTION public.touch_reply_manual_label();

-- ---------------------------------------------------------------------------
-- 3. Indexes for the two access patterns
-- ---------------------------------------------------------------------------
-- (a) The review queue: unlabelled replies that the model actually scored,
--     newest first, scoped to one client.
CREATE INDEX IF NOT EXISTS replies_manual_label_queue_idx
  ON public."Replies" (client_id, analyzed_at DESC)
  WHERE manual_sentiment IS NULL AND analyzed_at IS NOT NULL;

-- (b) The weekly job: labels added since its last run, scoped to one client.
CREATE INDEX IF NOT EXISTS replies_manual_labeled_idx
  ON public."Replies" (client_id, manual_labeled_at DESC)
  WHERE manual_sentiment IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Per-client versioned cheat sheets
-- ---------------------------------------------------------------------------
-- Per-client, not global: stance rules ("praising @handle is negative for us")
-- are client-specific, and leaking one client's rules into another client's
-- analysis would actively degrade it. Versioned so a bad regeneration can be
-- rolled back to the previous active row.
CREATE TABLE IF NOT EXISTS public."Sentiment Cheat Sheets" (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES public."Clients"(id) ON DELETE CASCADE,
  version             integer NOT NULL,
  status              text NOT NULL DEFAULT 'draft',
  rules_text          text NOT NULL,
  source_label_count  integer NOT NULL DEFAULT 0,
  benchmark_accuracy  numeric,
  generated_from      timestamptz,
  generated_to        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  activated_at        timestamptz,
  CONSTRAINT sentiment_cheat_sheets_status_check
    CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT sentiment_cheat_sheets_client_version_key
    UNIQUE (client_id, version)
);

COMMENT ON TABLE public."Sentiment Cheat Sheets" IS
  'Per-client sentiment labelling rules appended to the analyzer system prompt. '
  'Exactly one row per client may be active; drafts wait for human activation.';
COMMENT ON COLUMN public."Sentiment Cheat Sheets".rules_text IS
  'The block injected verbatim into the analyzer system prompt. Keep it short - it '
  'is paid for on every scheduler pass, for every post.';
COMMENT ON COLUMN public."Sentiment Cheat Sheets".benchmark_accuracy IS
  'Accuracy this version scored before activation, or NULL if it was never scored.';

-- One active cheat sheet per client, enforced by the database rather than by
-- whichever workflow happens to be writing.
CREATE UNIQUE INDEX IF NOT EXISTS sentiment_cheat_sheets_one_active_idx
  ON public."Sentiment Cheat Sheets" (client_id)
  WHERE status = 'active';

-- FK columns need their own index; the unique index above only covers active rows.
CREATE INDEX IF NOT EXISTS sentiment_cheat_sheets_client_idx
  ON public."Sentiment Cheat Sheets" (client_id);

-- Matches every other table here: RLS on, no policies, so only service_role and
-- direct Postgres connections (n8n) can reach it. anon/authenticated get nothing.
ALTER TABLE public."Sentiment Cheat Sheets" ENABLE ROW LEVEL SECURITY;
