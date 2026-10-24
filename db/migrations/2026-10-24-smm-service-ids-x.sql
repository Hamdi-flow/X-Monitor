-- X's SMMWiz service ids move from router constants into public."FB SMM Settings".
--
-- WHAT THIS IS. Until now XMonitor - Telegram Router hard-coded the ids in its Set nodes
-- `Prepare Likes Order Request` (12104) and `Prepare Comment Order Request` (8404). From
-- router version "service ids from table" on, it reads them at order time from the row
-- public."FB SMM Settings" provider = 'smmwiz_x' (the row the Order Status Poll already
-- uses for X's provider account), columns likes_service_id / comments_service_id, only
-- while that row is_active. NULL refuses the order before SMMWiz is called.
--
-- This file:
--   1. lets public."SMM Service ID History" record platform 'x';
--   2. makes public.log_smm_service_id_change() label the smmwiz_x row as platform 'x';
--   3. lets public.save_smm_service_id() change the smmwiz_x row (p_platform = 'x');
--   4. seeds the smmwiz_x row with the ids the router used until now (12104 / 8404), only
--      where they are still NULL, recorded in the history as edited_by 'migration'.
-- Requires 2026-10-24-smm-service-id-history.sql. Changes no other column or row; never
-- touches api_key / api_url.
--
-- ORDER ON A PROJECT: apply this BEFORE publishing the router that reads the table; a router
-- that reads a NULL id refuses (safe), but X orders would stop until the seed is in.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Every
-- statement names its table or function. Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-24.
-- NOT applied to production (jxnzdxyhoakpfmkbjdeq) yet.

ALTER TABLE public."SMM Service ID History" DROP CONSTRAINT IF EXISTS "SMM Service ID History_platform_check";
ALTER TABLE public."SMM Service ID History"
  ADD CONSTRAINT "SMM Service ID History_platform_check" CHECK (platform IN ('x', 'fb', 'ig'));

CREATE OR REPLACE FUNCTION public.log_smm_service_id_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_by       text := nullif(current_setting('smm_service_ids.edited_by', true), '');
  v_platform text := CASE
                       WHEN TG_TABLE_NAME = 'FB SMM Settings' AND NEW.provider = 'smmwiz_x' THEN 'x'
                       WHEN TG_TABLE_NAME = 'FB SMM Settings' THEN 'fb'
                       ELSE 'ig'
                     END;
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
  v_table   text := CASE p_platform WHEN 'ig' THEN 'IG SMM Settings' ELSE 'FB SMM Settings' END;
BEGIN
  IF p_platform NOT IN ('x', 'fb', 'ig') THEN
    RAISE EXCEPTION 'save_smm_service_id: platform must be x, fb or ig' USING ERRCODE = '22023';
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
  IF p_platform IN ('x', 'fb') THEN
    SELECT s.id, CASE p_order_type WHEN 'likes' THEN s.likes_service_id ELSE s.comments_service_id END
      INTO v_id, v_current
      FROM public."FB SMM Settings" s
     WHERE s.provider = CASE p_platform WHEN 'x' THEN 'smmwiz_x' ELSE 'smmwiz' END
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

  IF v_table = 'FB SMM Settings' AND p_order_type = 'likes' THEN
    UPDATE public."FB SMM Settings" SET likes_service_id = p_new WHERE id = v_id;
  ELSIF v_table = 'FB SMM Settings' THEN
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

-- Seed: the ids XMonitor - Telegram Router hard-coded until now (both environments).
SELECT set_config('smm_service_ids.edited_by', 'migration 2026-10-24-smm-service-ids-x', true);
UPDATE public."FB SMM Settings" SET likes_service_id = '12104'
 WHERE provider = 'smmwiz_x' AND likes_service_id IS NULL;
UPDATE public."FB SMM Settings" SET comments_service_id = '8404'
 WHERE provider = 'smmwiz_x' AND comments_service_id IS NULL;
SELECT set_config('smm_service_ids.edited_by', '', true);
