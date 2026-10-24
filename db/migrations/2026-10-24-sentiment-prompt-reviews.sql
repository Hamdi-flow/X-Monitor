-- Weekly sentiment prompt review: proposals waiting for a human, and per-platform cheat sheets.
--
-- WHAT THIS IS. Once a week the review (n8n "Sentiment Prompt Review", started by the local
-- Claude scheduled task "sentiment-prompt-review") reads every human sentiment label from
-- "Replies" (X), "FB Comments" and "IG Comments", asks gpt-5.4 for a minimal edit to the
-- shared rows in "Sentiment Prompts" plus per-client cheat-sheet entries, re-labels with the
-- production classifier to measure it, stores the run here and emails a report. NOTHING is
-- applied by the run. A proposal waits as status 'pending' until a human approves it in the
-- console (/prompts/reviews) or by replying to the Claude run; both call
-- public.decide_sentiment_prompt_review() below.
--
-- 1. "Sentiment Cheat Sheets" gains `platform` (x | fb | ig). Until now the table was X-only
--    (one active sheet per client). A client's X, Facebook and Instagram audiences differ, so
--    each platform gets its own sheet: one ACTIVE row per (client_id, platform). Existing rows
--    are X rows (the column defaults to 'x'). Every monitor must filter on its own platform:
--    X's `Get Active Cheat Sheets` gains `AND platform = 'x'` in the same change.
--
-- 2. public."Sentiment Prompt Reviews": one row per weekly run, whatever its outcome
--    (skipped / no_change / pending / failed), so the console shows every week.
--    At most one row is 'pending'; a newer pending run supersedes the older one.
--
-- 3. public.decide_sentiment_prompt_review(): approve or reject a pending review. Approval
--    writes prompt rows through public.save_sentiment_prompt() (so every change lands in
--    "Sentiment Prompt History" and the console's Restore undoes it) and activates the
--    proposed cheat sheets as new versions (the previous active version is retired, not
--    deleted, so it can be re-activated). It refuses (SQLSTATE PT409) when a prompt row or
--    an active cheat sheet changed after the review read it: the measurements would no
--    longer describe what is being applied.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Every
-- statement names its table or function. Requires 2026-08-29-sentiment-manual-labels.sql,
-- 2026-10-18-sentiment-prompts.sql and 2026-10-18-sentiment-prompt-history.sql.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-24.

-- ---------------------------------------------------------------------------
-- 1. Per-platform cheat sheets
-- ---------------------------------------------------------------------------
ALTER TABLE public."Sentiment Cheat Sheets"
  ADD COLUMN IF NOT EXISTS platform  text NOT NULL DEFAULT 'x',
  ADD COLUMN IF NOT EXISTS review_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sentiment_cheat_sheets_platform_check'
      AND conrelid = 'public."Sentiment Cheat Sheets"'::regclass
  ) THEN
    ALTER TABLE public."Sentiment Cheat Sheets"
      ADD CONSTRAINT sentiment_cheat_sheets_platform_check CHECK (platform IN ('x', 'fb', 'ig'));
  END IF;
  -- Versions now count per (client, platform).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sentiment_cheat_sheets_client_version_key'
      AND conrelid = 'public."Sentiment Cheat Sheets"'::regclass
  ) THEN
    ALTER TABLE public."Sentiment Cheat Sheets" DROP CONSTRAINT sentiment_cheat_sheets_client_version_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sentiment_cheat_sheets_client_platform_version_key'
      AND conrelid = 'public."Sentiment Cheat Sheets"'::regclass
  ) THEN
    ALTER TABLE public."Sentiment Cheat Sheets"
      ADD CONSTRAINT sentiment_cheat_sheets_client_platform_version_key UNIQUE (client_id, platform, version);
  END IF;
END $$;

DROP INDEX IF EXISTS public.sentiment_cheat_sheets_one_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sentiment_cheat_sheets_one_active_per_platform_idx
  ON public."Sentiment Cheat Sheets" (client_id, platform)
  WHERE status = 'active';

COMMENT ON COLUMN public."Sentiment Cheat Sheets".platform IS
  'x | fb | ig. Each monitor reads only its own platform''s active row for the post''s client.';
COMMENT ON COLUMN public."Sentiment Cheat Sheets".review_id IS
  'The "Sentiment Prompt Reviews" run whose approval activated this version, if any.';

-- ---------------------------------------------------------------------------
-- 2. Review runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."Sentiment Prompt Reviews" (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at            timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL,
  -- Labels with manual_labeled_at in (window_from, window_to] are this run's new evidence.
  window_from           timestamptz,
  window_to             timestamptz NOT NULL,
  new_label_count       integer NOT NULL DEFAULT 0,
  total_label_count     integer NOT NULL DEFAULT 0,
  summary               text,
  -- {key: {system_prompt, user_template, model, temperature}} as read at the start of the run.
  base_prompts          jsonb,
  -- {key: {system_prompt}} for the rows the proposal changes, nothing else.
  candidate_prompts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The reviewer's raw edit list [{key, find, replace, reason, accepted, problem}].
  prompt_edits          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{platform, client_id, client_name, base_version, base_rules, rules_text, reason}]
  cheat_sheet_proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{id, scope: general | client, reason}] - how each new correction was sorted.
  corrections           jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- {labelled: {n, before_correct, after_correct, fixed: [...], broken: [...]},
  --  stability: {n, flips: [...]}, model, temperature}
  metrics               jsonb,
  report_html           text,
  email_sent_at         timestamptz,
  email_error           text,
  decided_at            timestamptz,
  decided_by            text,
  decided_via           text,
  decision_note         text,
  -- {history_ids: [...], cheat_sheet_ids: [...]}
  applied               jsonb,
  error                 text,
  n8n_execution_id      text,
  CONSTRAINT sentiment_prompt_reviews_status_check
    CHECK (status IN ('skipped', 'no_change', 'pending', 'approved', 'rejected', 'superseded', 'failed')),
  CONSTRAINT sentiment_prompt_reviews_decided_via_check
    CHECK (decided_via IS NULL OR decided_via IN ('console', 'claude'))
);

CREATE INDEX IF NOT EXISTS sentiment_prompt_reviews_created_at_idx
  ON public."Sentiment Prompt Reviews" (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sentiment_prompt_reviews_one_pending_idx
  ON public."Sentiment Prompt Reviews" ((true))
  WHERE status = 'pending';

-- Same posture as every other table here: RLS on, no policies.
ALTER TABLE public."Sentiment Prompt Reviews" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sentiment_cheat_sheets_review_id_fkey'
      AND conrelid = 'public."Sentiment Cheat Sheets"'::regclass
  ) THEN
    ALTER TABLE public."Sentiment Cheat Sheets"
      ADD CONSTRAINT sentiment_cheat_sheets_review_id_fkey
      FOREIGN KEY (review_id) REFERENCES public."Sentiment Prompt Reviews"(id) ON DELETE SET NULL;
  END IF;
END $$;

-- A new pending proposal replaces an older undecided one: it was measured against newer
-- evidence, and two open proposals could each be approved on top of the other.
CREATE OR REPLACE FUNCTION public.supersede_pending_sentiment_prompt_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    UPDATE public."Sentiment Prompt Reviews"
       SET status = 'superseded', decision_note = 'superseded by a newer review'
     WHERE status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sentiment_prompt_reviews_supersede ON public."Sentiment Prompt Reviews";
CREATE TRIGGER sentiment_prompt_reviews_supersede
  BEFORE INSERT ON public."Sentiment Prompt Reviews"
  FOR EACH ROW EXECUTE FUNCTION public.supersede_pending_sentiment_prompt_review();

-- ---------------------------------------------------------------------------
-- 3. Approve / reject
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_sentiment_prompt_review(
  p_review_id  bigint,
  p_decision   text,
  p_decided_by text,
  p_via        text,
  p_note       text DEFAULT NULL
)
RETURNS SETOF public."Sentiment Prompt Reviews"
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_review   public."Sentiment Prompt Reviews"%ROWTYPE;
  v_key      text;
  v_cand     jsonb;
  v_base     jsonb;
  v_row      public."Sentiment Prompts"%ROWTYPE;
  v_sheet    jsonb;
  v_active   public."Sentiment Cheat Sheets"%ROWTYPE;
  v_new_id   uuid;
  v_hist     bigint[] := '{}';
  v_sheets   uuid[] := '{}';
  v_label    text;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decide_sentiment_prompt_review: decision must be approve or reject' USING ERRCODE = '22023';
  END IF;
  IF p_via NOT IN ('console', 'claude') THEN
    RAISE EXCEPTION 'decide_sentiment_prompt_review: via must be console or claude' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_decided_by), '') = '' THEN
    RAISE EXCEPTION 'decide_sentiment_prompt_review: decided_by is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_review FROM public."Sentiment Prompt Reviews" WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decide_sentiment_prompt_review: no review %', p_review_id USING ERRCODE = 'P0002';
  END IF;
  IF v_review.status <> 'pending' THEN
    RAISE EXCEPTION 'decide_sentiment_prompt_review: review % is %, not pending', p_review_id, v_review.status
      USING ERRCODE = 'PT409';
  END IF;

  IF p_decision = 'approve' THEN
    v_label := 'prompt review #' || p_review_id || ' (' || p_decided_by || ')';

    FOR v_key, v_cand IN SELECT key, value FROM jsonb_each(v_review.candidate_prompts) LOOP
      v_base := v_review.base_prompts -> v_key;
      SELECT * INTO v_row FROM public."Sentiment Prompts" WHERE key = v_key FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'decide_sentiment_prompt_review: no prompt row %', v_key USING ERRCODE = 'P0002';
      END IF;
      IF v_base IS NULL OR v_row.system_prompt IS DISTINCT FROM (v_base ->> 'system_prompt') THEN
        RAISE EXCEPTION 'decide_sentiment_prompt_review: % was edited after review % read it; reject this review and wait for the next one', v_key, p_review_id
          USING ERRCODE = 'PT409';
      END IF;
      PERFORM public.save_sentiment_prompt(
        v_key, v_row.updated_at, v_cand ->> 'system_prompt',
        CASE WHEN v_cand ? 'user_template' THEN v_cand ->> 'user_template' ELSE v_row.user_template END,
        v_row.model, v_row.temperature, v_label, 'edit', NULL);
      v_hist := v_hist || (SELECT max(id) FROM public."Sentiment Prompt History" WHERE key = v_key);
    END LOOP;

    FOR v_sheet IN SELECT value FROM jsonb_array_elements(v_review.cheat_sheet_proposals) LOOP
      SELECT * INTO v_active FROM public."Sentiment Cheat Sheets"
       WHERE client_id = (v_sheet ->> 'client_id')::uuid AND platform = v_sheet ->> 'platform' AND status = 'active'
       FOR UPDATE;
      IF (FOUND AND (v_sheet ->> 'base_version') IS DISTINCT FROM v_active.version::text)
         OR (NOT FOUND AND (v_sheet ->> 'base_version') IS NOT NULL) THEN
        RAISE EXCEPTION 'decide_sentiment_prompt_review: the % cheat sheet of client % changed after review % read it', v_sheet ->> 'platform', v_sheet ->> 'client_id', p_review_id
          USING ERRCODE = 'PT409';
      END IF;
      IF FOUND THEN
        UPDATE public."Sentiment Cheat Sheets" SET status = 'retired' WHERE id = v_active.id;
      END IF;
      IF coalesce(btrim(v_sheet ->> 'rules_text'), '') <> '' THEN
        INSERT INTO public."Sentiment Cheat Sheets"
          (client_id, platform, version, status, rules_text, source_label_count, generated_from, generated_to, activated_at, review_id)
        SELECT (v_sheet ->> 'client_id')::uuid, v_sheet ->> 'platform',
               coalesce(max(version), 0) + 1, 'active', v_sheet ->> 'rules_text',
               v_review.total_label_count, v_review.window_from, v_review.window_to, now(), p_review_id
          FROM public."Sentiment Cheat Sheets"
         WHERE client_id = (v_sheet ->> 'client_id')::uuid AND platform = v_sheet ->> 'platform'
        RETURNING id INTO v_new_id;
        v_sheets := v_sheets || v_new_id;
      END IF;
    END LOOP;
  END IF;

  RETURN QUERY
    UPDATE public."Sentiment Prompt Reviews"
       SET status        = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
           decided_at    = now(),
           decided_by    = p_decided_by,
           decided_via   = p_via,
           decision_note = nullif(btrim(coalesce(p_note, '')), ''),
           applied       = CASE WHEN p_decision = 'approve'
                                THEN jsonb_build_object('history_ids', to_jsonb(v_hist), 'cheat_sheet_ids', to_jsonb(v_sheets))
                                ELSE NULL END
     WHERE id = p_review_id
    RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_sentiment_prompt_review(bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_sentiment_prompt_review(bigint, text, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.supersede_pending_sentiment_prompt_review() FROM PUBLIC, anon, authenticated;
