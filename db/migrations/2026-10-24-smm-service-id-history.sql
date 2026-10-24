-- Edit history and a guarded write path for the SMMWiz service ids of Facebook and Instagram.
--
-- WHAT THIS IS. The service id is the SMMWiz product a paid order buys. The FB and IG
-- Telegram routers read it at order time from:
--   public."FB SMM Settings".likes_service_id / comments_service_id, row provider = 'smmwiz'
--   public."IG SMM Settings".likes_service_id / comments_service_id, first is_active row by id
-- (exactly the rows the routers' Load ... Order Context / Validate Order Request queries pick).
-- NULL is the disarmed state: both routers refuse the order. IG production is deliberately NULL.
-- X's ids are still constants in the X router's Set nodes, so X is not covered here.
--
-- HISTORY. One row in public."SMM Service ID History" per changed service id column on an
-- UPDATE of either table, written by a trigger, so EVERY change is recorded: the console's
-- /settings/smm page, the Supabase table editor and ad-hoc SQL alike. Who changed it comes
-- from the transaction-local setting smm_service_ids.edited_by, set by
-- public.save_smm_service_id() below; any other edit records current_user and action 'direct'.
--
-- WRITE PATH FOR THE CONSOLE. public.save_smm_service_id() changes ONE service id column on
-- the row the router reads, with an optimistic lock on the value the caller last read (a
-- concurrent change fails with SQLSTATE PT409, which PostgREST returns as HTTP 409). It
-- validates the new value (NULL, or a positive integer as text) and never touches any other
-- column -- in particular never api_key / api_url. SECURITY INVOKER, executable by
-- service_role only.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Every
-- statement names its table, trigger or function. "FB SMM Settings" belongs to FB Monitor and
-- "IG SMM Settings" to Insta-Monitor; this file only adds a trigger to each and changes no
-- column or row of either.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-24.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-10-24 (user approval in chat).

CREATE TABLE IF NOT EXISTS public."SMM Service ID History" (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform         text NOT NULL CHECK (platform IN ('fb', 'ig')),
  settings_row_id  bigint NOT NULL,
  provider         text,
  order_type       text NOT NULL CHECK (order_type IN ('likes', 'comments')),
  action           text NOT NULL CHECK (action IN ('edit', 'direct')),
  old_service_id   text,
  new_service_id   text,
  edited_by        text NOT NULL,
  edited_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS smm_service_id_history_edited_at_idx
  ON public."SMM Service ID History" (edited_at DESC);

-- RLS on, no policies: only service_role / postgres read it.
ALTER TABLE public."SMM Service ID History" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.log_smm_service_id_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_by       text := nullif(current_setting('smm_service_ids.edited_by', true), '');
  v_platform text := CASE TG_TABLE_NAME WHEN 'FB SMM Settings' THEN 'fb' ELSE 'ig' END;
  v_action   text := CASE WHEN nullif(current_setting('smm_service_ids.edited_by', true), '') IS NULL THEN 'direct' ELSE 'edit' END;
BEGIN
  IF NEW.likes_service_id IS DISTINCT FROM OLD.likes_service_id THEN
    INSERT INTO public."SMM Service ID History"
      (platform, settings_row_id, provider, order_type, action, old_service_id, new_service_id, edited_by)
    VALUES
      (v_platform, NEW.id, NEW.provider, 'likes', v_action, OLD.likes_service_id, NEW.likes_service_id, coalesce(v_by, current_user));
  END IF;
  IF NEW.comments_service_id IS DISTINCT FROM OLD.comments_service_id THEN
    INSERT INTO public."SMM Service ID History"
      (platform, settings_row_id, provider, order_type, action, old_service_id, new_service_id, edited_by)
    VALUES
      (v_platform, NEW.id, NEW.provider, 'comments', v_action, OLD.comments_service_id, NEW.comments_service_id, coalesce(v_by, current_user));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fb_smm_settings_log_service_id ON public."FB SMM Settings";
CREATE TRIGGER fb_smm_settings_log_service_id
  AFTER UPDATE OF likes_service_id, comments_service_id ON public."FB SMM Settings"
  FOR EACH ROW EXECUTE FUNCTION public.log_smm_service_id_change();

DROP TRIGGER IF EXISTS ig_smm_settings_log_service_id ON public."IG SMM Settings";
CREATE TRIGGER ig_smm_settings_log_service_id
  AFTER UPDATE OF likes_service_id, comments_service_id ON public."IG SMM Settings"
  FOR EACH ROW EXECUTE FUNCTION public.log_smm_service_id_change();

-- Returns the row id that was changed and the stored new value.
CREATE OR REPLACE FUNCTION public.save_smm_service_id(
  p_platform    text,
  p_order_type  text,
  p_expected    text,
  p_new         text,
  p_edited_by   text
)
RETURNS TABLE (settings_row_id bigint, service_id text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_id      bigint;
  v_current text;
BEGIN
  IF p_platform NOT IN ('fb', 'ig') THEN
    RAISE EXCEPTION 'save_smm_service_id: platform must be fb or ig' USING ERRCODE = '22023';
  END IF;
  IF p_order_type NOT IN ('likes', 'comments') THEN
    RAISE EXCEPTION 'save_smm_service_id: order_type must be likes or comments' USING ERRCODE = '22023';
  END IF;
  IF p_new IS NOT NULL AND p_new !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION 'save_smm_service_id: service id must be a positive integer or NULL' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_edited_by), '') = '' THEN
    RAISE EXCEPTION 'save_smm_service_id: edited_by is required' USING ERRCODE = '22023';
  END IF;

  -- The same row each router reads. FOR UPDATE so the lock check and the write see one value.
  IF p_platform = 'fb' THEN
    SELECT s.id, CASE p_order_type WHEN 'likes' THEN s.likes_service_id ELSE s.comments_service_id END
      INTO v_id, v_current
      FROM public."FB SMM Settings" s
     WHERE s.provider = 'smmwiz'
     ORDER BY s.id
     LIMIT 1
       FOR UPDATE;
  ELSE
    SELECT s.id, CASE p_order_type WHEN 'likes' THEN s.likes_service_id ELSE s.comments_service_id END
      INTO v_id, v_current
      FROM public."IG SMM Settings" s
     WHERE s.is_active
     ORDER BY s.id
     LIMIT 1
       FOR UPDATE;
  END IF;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'save_smm_service_id: no settings row the % router reads', p_platform USING ERRCODE = 'P0002';
  END IF;
  IF v_current IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'save_smm_service_id: % % service id was changed by someone else since it was loaded', p_platform, p_order_type
      USING ERRCODE = 'PT409';
  END IF;

  PERFORM set_config('smm_service_ids.edited_by', p_edited_by, true);

  IF p_platform = 'fb' AND p_order_type = 'likes' THEN
    UPDATE public."FB SMM Settings" SET likes_service_id = p_new WHERE id = v_id;
  ELSIF p_platform = 'fb' THEN
    UPDATE public."FB SMM Settings" SET comments_service_id = p_new WHERE id = v_id;
  ELSIF p_order_type = 'likes' THEN
    UPDATE public."IG SMM Settings" SET likes_service_id = p_new WHERE id = v_id;
  ELSE
    UPDATE public."IG SMM Settings" SET comments_service_id = p_new WHERE id = v_id;
  END IF;

  PERFORM set_config('smm_service_ids.edited_by', '', true);

  settings_row_id := v_id;
  service_id := p_new;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.save_smm_service_id(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_smm_service_id(text, text, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.log_smm_service_id_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public."SMM Service ID History" FROM anon, authenticated;
