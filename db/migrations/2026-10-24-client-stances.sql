-- Client stances, and hand edits of per-platform cheat sheets from the console.
--
-- WHAT THIS IS. The classifier decides Positive / Negative by whether a comment is for or
-- against the account owner, but it only sees the owner's name, the post and the comment.
-- Many comments need what the post does not say: who the client is and who or what they
-- support or oppose. A STANCE is that, written by a human, one per client, for every
-- platform. It is separate from the cheat sheets (one per client per platform, mostly
-- proposed by the weekly review): the review may read a stance but never writes one.
--
-- At classification time both fill the SAME slot each monitor already fills
-- ({{cheat_sheet_block}} in the comment_text row): the stance first, then the platform's
-- cheat sheet. A client without a stance gets exactly the block it got before.
--
-- 1. public."Client Stances": one row per VERSION. Every save inserts a new version and
--    retires the previous one, so the table is its own history. At most one 'active' row
--    per client. Empty text is a valid version and means "no stance" (monitors skip it), so
--    clearing a stance is recorded like any other edit and can be restored.
-- 2. public.save_client_stance(): the only write path (console, lib/actions/client-stances.ts).
--    Optimistic lock on the active version; a mismatch raises SQLSTATE PT409 (HTTP 409 in
--    PostgREST; never 40001, which PostgREST retries until it times out).
-- 3. "Sentiment Cheat Sheets" gains created_by and restored_from_version, and
--    public.save_sentiment_cheat_sheet() lets a human edit, clear or restore a client's sheet
--    for one platform: a new active version (the old one is retired, never deleted), or, for
--    empty text, the active one retired with nothing in its place. Rows written by a review
--    approval keep created_by NULL and carry review_id.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Requires
-- 2026-10-24-sentiment-prompt-reviews.sql (per-platform cheat sheets).
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-24 (migration name client_stances).

-- ---------------------------------------------------------------------------
-- 1. Stances
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."Client Stances" (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id         uuid NOT NULL REFERENCES public."Clients"(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  stance_text       text NOT NULL,
  action            text NOT NULL DEFAULT 'edit',
  restored_from_version integer,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_stances_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT client_stances_action_check CHECK (action IN ('edit', 'restore')),
  CONSTRAINT client_stances_length_check CHECK (char_length(stance_text) <= 2000),
  CONSTRAINT client_stances_client_version_key UNIQUE (client_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_stances_one_active_idx
  ON public."Client Stances" (client_id)
  WHERE status = 'active';

COMMENT ON TABLE public."Client Stances" IS
  'Who each client is and what they stand for, written by staff; prepended to the client''s cheat sheet in every monitor''s classifier prompt. One row per version; status = active is the live one. Empty stance_text = no stance.';

ALTER TABLE public."Client Stances" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.save_client_stance(
  p_client_id        uuid,
  p_expected_version integer,
  p_stance_text      text,
  p_created_by       text,
  p_action           text DEFAULT 'edit',
  p_restored_from    integer DEFAULT NULL
)
RETURNS SETOF public."Client Stances"
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_active public."Client Stances"%ROWTYPE;
  v_next   integer;
BEGIN
  IF coalesce(btrim(p_created_by), '') = '' THEN
    RAISE EXCEPTION 'save_client_stance: created_by is required' USING ERRCODE = '22023';
  END IF;
  IF p_action NOT IN ('edit', 'restore') THEN
    RAISE EXCEPTION 'save_client_stance: action must be edit or restore' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public."Clients" WHERE id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'save_client_stance: no client %', p_client_id USING ERRCODE = 'P0002';
  END IF;
  -- Serialises saves for one client, including the very first (no active row to lock yet).
  PERFORM pg_advisory_xact_lock(hashtext('client_stance:' || p_client_id::text));

  SELECT * INTO v_active FROM public."Client Stances"
   WHERE client_id = p_client_id AND status = 'active' FOR UPDATE;
  IF (FOUND AND p_expected_version IS DISTINCT FROM v_active.version)
     OR (NOT FOUND AND p_expected_version IS NOT NULL) THEN
    RAISE EXCEPTION 'save_client_stance: the stance of client % changed since it was read', p_client_id
      USING ERRCODE = 'PT409';
  END IF;

  IF FOUND THEN
    UPDATE public."Client Stances" SET status = 'retired' WHERE id = v_active.id;
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_next FROM public."Client Stances" WHERE client_id = p_client_id;

  RETURN QUERY
    INSERT INTO public."Client Stances"
      (client_id, version, status, stance_text, action, restored_from_version, created_by)
    VALUES (p_client_id, v_next, 'active', btrim(coalesce(p_stance_text, '')), p_action, p_restored_from, p_created_by)
    RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.save_client_stance(uuid, integer, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_client_stance(uuid, integer, text, text, text, integer)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Hand edits of cheat sheets
-- ---------------------------------------------------------------------------
ALTER TABLE public."Sentiment Cheat Sheets"
  ADD COLUMN IF NOT EXISTS created_by            text,
  ADD COLUMN IF NOT EXISTS restored_from_version integer;

COMMENT ON COLUMN public."Sentiment Cheat Sheets".created_by IS
  'Who saved this version in the console. NULL for versions activated by a review approval (see review_id) or written before 2026-10-24.';
COMMENT ON COLUMN public."Sentiment Cheat Sheets".restored_from_version IS
  'Set when this version was a console restore of an older version of the same client and platform.';

CREATE OR REPLACE FUNCTION public.save_sentiment_cheat_sheet(
  p_client_id        uuid,
  p_platform         text,
  p_expected_version integer,
  p_rules_text       text,
  p_created_by       text,
  p_restored_from    integer DEFAULT NULL
)
RETURNS SETOF public."Sentiment Cheat Sheets"
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_active public."Sentiment Cheat Sheets"%ROWTYPE;
  v_text   text := btrim(coalesce(p_rules_text, ''));
BEGIN
  IF coalesce(btrim(p_created_by), '') = '' THEN
    RAISE EXCEPTION 'save_sentiment_cheat_sheet: created_by is required' USING ERRCODE = '22023';
  END IF;
  IF p_platform NOT IN ('x', 'fb', 'ig') THEN
    RAISE EXCEPTION 'save_sentiment_cheat_sheet: platform must be x, fb or ig' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_text) > 2000 THEN
    RAISE EXCEPTION 'save_sentiment_cheat_sheet: rules_text is longer than 2000 characters' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public."Clients" WHERE id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'save_sentiment_cheat_sheet: no client %', p_client_id USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cheat_sheet:' || p_client_id::text || ':' || p_platform));

  SELECT * INTO v_active FROM public."Sentiment Cheat Sheets"
   WHERE client_id = p_client_id AND platform = p_platform AND status = 'active' FOR UPDATE;
  IF (FOUND AND p_expected_version IS DISTINCT FROM v_active.version)
     OR (NOT FOUND AND p_expected_version IS NOT NULL) THEN
    RAISE EXCEPTION 'save_sentiment_cheat_sheet: the % cheat sheet of client % changed since it was read', p_platform, p_client_id
      USING ERRCODE = 'PT409';
  END IF;

  IF FOUND THEN
    UPDATE public."Sentiment Cheat Sheets" SET status = 'retired' WHERE id = v_active.id;
  END IF;
  IF v_text = '' THEN
    -- Cleared: the retired row is returned so the caller sees what was switched off.
    IF FOUND THEN
      RETURN QUERY SELECT * FROM public."Sentiment Cheat Sheets" WHERE id = v_active.id;
    END IF;
    RETURN;
  END IF;

  RETURN QUERY
    INSERT INTO public."Sentiment Cheat Sheets"
      (client_id, platform, version, status, rules_text, activated_at, created_by, restored_from_version)
    SELECT p_client_id, p_platform, coalesce(max(version), 0) + 1, 'active', v_text, now(), p_created_by, p_restored_from
      FROM public."Sentiment Cheat Sheets"
     WHERE client_id = p_client_id AND platform = p_platform
    RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.save_sentiment_cheat_sheet(uuid, text, integer, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_sentiment_cheat_sheet(uuid, text, integer, text, text, integer)
  TO service_role;
