-- Edit history for public."Sentiment Prompts", so a bad prompt edit can be undone.
--
-- WHAT THIS IS. One row in public."Sentiment Prompt History" per UPDATE of a
-- "Sentiment Prompts" row that changes system_prompt, user_template, model or
-- temperature. Written by a trigger, so EVERY edit is recorded: the console's prompt
-- page (X-Monitor-Console /prompts), the Supabase table editor, and ad-hoc SQL alike.
-- Rows hold the old AND new values, so any row is a restorable version.
--
-- WHO EDITED. The trigger reads two transaction-local settings, set by
-- public.save_sentiment_prompt() below:
--   sentiment_prompts.edited_by  the console user's email
--   sentiment_prompts.action     'edit' or 'restore'
--   sentiment_prompts.restored_from  history id a restore came from
-- An edit made any other way records current_user (e.g. 'postgres') and action 'direct'.
--
-- WRITE PATH FOR THE CONSOLE. public.save_sentiment_prompt() updates one row with an
-- optimistic lock (the caller passes the updated_at it last read; a concurrent edit makes
-- the call fail with SQLSTATE PT409, which PostgREST returns as HTTP 409, instead of
-- silently overwriting; not 40001, which PostgREST retries until it times out). It is SECURITY
-- INVOKER and executable by service_role only, so the anon / authenticated API roles
-- cannot call it. Validation of the prompt text (placeholders) lives in the console
-- (lib/prompts/rules.ts) because it mirrors the workflows' Resolve Sentiment Prompts.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Every
-- statement names its table or function. Requires 2026-10-18-sentiment-prompts.sql.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-18.
-- NOT yet applied to production (jxnzdxyhoakpfmkbjdeq): needs the user's approval.

CREATE TABLE IF NOT EXISTS public."Sentiment Prompt History" (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key                text NOT NULL,
  action             text NOT NULL CHECK (action IN ('edit', 'restore', 'direct')),
  restored_from_id   bigint REFERENCES public."Sentiment Prompt History"(id) ON DELETE SET NULL,
  old_system_prompt  text,
  new_system_prompt  text,
  old_user_template  text,
  new_user_template  text,
  old_model          text,
  new_model          text,
  old_temperature    numeric,
  new_temperature    numeric,
  edited_by          text NOT NULL,
  edited_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sentiment_prompt_history_key_edited_at_idx
  ON public."Sentiment Prompt History" (key, edited_at DESC);

-- Same posture as "Sentiment Prompts": RLS on, no policies. Only service_role / postgres read it.
ALTER TABLE public."Sentiment Prompt History" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.log_sentiment_prompt_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_by     text := nullif(current_setting('sentiment_prompts.edited_by', true), '');
  v_action text := coalesce(nullif(current_setting('sentiment_prompts.action', true), ''), 'direct');
  v_from   text := nullif(current_setting('sentiment_prompts.restored_from', true), '');
BEGIN
  IF NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
     OR NEW.user_template IS DISTINCT FROM OLD.user_template
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.temperature IS DISTINCT FROM OLD.temperature THEN
    INSERT INTO public."Sentiment Prompt History" (
      key, action, restored_from_id,
      old_system_prompt, new_system_prompt,
      old_user_template, new_user_template,
      old_model, new_model,
      old_temperature, new_temperature,
      edited_by, edited_at
    ) VALUES (
      NEW.key,
      CASE WHEN v_action IN ('edit', 'restore') THEN v_action ELSE 'direct' END,
      v_from::bigint,
      OLD.system_prompt, NEW.system_prompt,
      OLD.user_template, NEW.user_template,
      OLD.model, NEW.model,
      OLD.temperature, NEW.temperature,
      coalesce(v_by, current_user),
      NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sentiment_prompts_log_change ON public."Sentiment Prompts";
CREATE TRIGGER sentiment_prompts_log_change
  AFTER UPDATE ON public."Sentiment Prompts"
  FOR EACH ROW EXECUTE FUNCTION public.log_sentiment_prompt_change();

CREATE OR REPLACE FUNCTION public.save_sentiment_prompt(
  p_key                 text,
  p_expected_updated_at timestamptz,
  p_system_prompt       text,
  p_user_template       text,
  p_model               text,
  p_temperature         numeric,
  p_edited_by           text,
  p_action              text DEFAULT 'edit',
  p_restored_from       bigint DEFAULT NULL
)
RETURNS SETOF public."Sentiment Prompts"
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_action NOT IN ('edit', 'restore') THEN
    RAISE EXCEPTION 'save_sentiment_prompt: action must be edit or restore' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_edited_by), '') = '' THEN
    RAISE EXCEPTION 'save_sentiment_prompt: edited_by is required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_system_prompt), '') = '' THEN
    RAISE EXCEPTION 'save_sentiment_prompt: system_prompt must not be empty' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('sentiment_prompts.edited_by', p_edited_by, true);
  PERFORM set_config('sentiment_prompts.action', p_action, true);
  PERFORM set_config('sentiment_prompts.restored_from', coalesce(p_restored_from::text, ''), true);

  RETURN QUERY
    UPDATE public."Sentiment Prompts"
       SET system_prompt = p_system_prompt,
           user_template = p_user_template,
           model         = p_model,
           temperature   = p_temperature
     WHERE key = p_key
       AND updated_at = p_expected_updated_at
    RETURNING *;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public."Sentiment Prompts" WHERE key = p_key) THEN
      RAISE EXCEPTION 'save_sentiment_prompt: % was changed by someone else since it was loaded', p_key
        USING ERRCODE = 'PT409';
    END IF;
    RAISE EXCEPTION 'save_sentiment_prompt: no row %', p_key USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_sentiment_prompt(text, timestamptz, text, text, text, numeric, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_sentiment_prompt(text, timestamptz, text, text, text, numeric, text, text, bigint)
  TO service_role;

REVOKE ALL ON FUNCTION public.log_sentiment_prompt_change() FROM PUBLIC, anon, authenticated;
