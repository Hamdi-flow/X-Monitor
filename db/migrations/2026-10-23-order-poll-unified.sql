-- One order poller for X, FB and IG (step B of the order-poll redesign)
--
-- Follows 2026-10-23-order-poll-heartbeat.sql (step A), which moved the three
-- per-product pollers onto a pg_cron gate. This migration lets ONE n8n workflow
-- poll every product's orders, so orders due at the same moment in different
-- products share a single execution instead of one each.
--
-- The per-table differences move out of n8n into three functions, so the
-- workflow never has to know table names:
--
--   due_order_polls(limit)      due rows from every order table, one shape,
--                               with the provider endpoint + key joined on
--   record_order_poll(...)      writes one status result to the right table
--                               (and, for X, Posts.status), returns the row
--   mark_order_notified(...)    stamps notified_at once, after a good send
--
-- trigger_order_polls() is replaced. It now has two modes, picked by Vault:
--   * 'order_poll_webhook_url' present  -> UNIFIED: one call for all products,
--                                          one 10-minute throttle ('order_poll')
--   * absent                            -> PER-PRODUCT: step A behaviour, using
--                                          order_poll_webhook_url_<product>
-- Deleting the unified URL secret is therefore the rollback to step A.
--
-- PROVIDER KEYS. A status call only works with the key that placed the order.
-- FB and IG share the smmwiz account in "FB SMM Settings" (provider 'smmwiz').
-- X's routers carry their own key inline, and nobody has confirmed it is the
-- same account. So X rows join a SEPARATE row, provider 'smmwiz_x'. Until that
-- row exists the INNER JOIN returns no X rows: X is simply not polled, rather
-- than polled with a key that would answer "Incorrect order ID" -- which the
-- normalizer reads as `failed` and would announce to the user as a failure.
--
-- X-Monitor-Advanced ("Advanced Order Info", production only) is NOT included:
-- its poller also updates "Advanced Mentions" and still runs on its own
-- 8-hourly schedule (~90 runs/month). Fold it in as a later step.
--
-- SECURITY. due_order_polls() returns api_key. All three functions are in
-- `public`, which PostgREST exposes, so EXECUTE is revoked from public, anon
-- and authenticated. n8n connects as `postgres` and is unaffected.
--
-- Idempotent. Applied to staging (npytqidroqxgikaqofmq) on 2026-10-23.
-- NOT yet applied to production.

-- 1. Due rows, every product, one shape -----------------------------------

CREATE OR REPLACE FUNCTION public.due_order_polls(p_limit integer DEFAULT 50)
RETURNS TABLE (
  product                    text,
  id                         uuid,
  provider_order_id          text,
  order_type                 text,
  post_ref                   text,
  page_name                  text,
  quantity                   integer,
  telegram_chat_id           text,
  previous_normalized_status text,
  next_check_at              timestamptz,
  api_url                    text,
  api_key                    text
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT * FROM (
    SELECT 'x'::text, o.id, o.provider_order_id, o.order_type, o.post_id, NULL::text,
           coalesce(o.quantity, o.comment_count), o.telegram_chat_id, o.normalized_status,
           o.next_check_at, s.api_url, s.api_key
    FROM public."Order Info" o
    JOIN public."FB SMM Settings" s ON s.provider = 'smmwiz_x'
    WHERE o.normalized_status IN ('pending', 'in_progress')
      AND o.provider_order_id IS NOT NULL
      AND (o.next_check_at IS NULL OR o.next_check_at <= now())
      AND s.api_key IS NOT NULL AND s.is_active

    UNION ALL
    SELECT 'fb', o.id, o.provider_order_id, o.order_type, o.post_id, o.page_name,
           coalesce(o.quantity, o.comment_count), o.telegram_chat_id, o.normalized_status,
           o.next_check_at, s.api_url, s.api_key
    FROM public."FB Order Info" o
    JOIN public."FB SMM Settings" s ON s.provider = o.provider
    WHERE o.normalized_status IN ('pending', 'in_progress')
      AND o.provider_order_id IS NOT NULL
      AND (o.next_check_at IS NULL OR o.next_check_at <= now())
      AND s.api_key IS NOT NULL AND s.is_active

    UNION ALL
    SELECT 'ig', o.id, o.provider_order_id, o.order_type, o.media_id, NULL,
           o.quantity, o.telegram_chat_id, o.normalized_status,
           o.next_check_at, s.api_url, s.api_key
    FROM public."IG Orders" o
    JOIN public."FB SMM Settings" s ON s.provider = o.provider
    WHERE o.normalized_status IN ('pending', 'in_progress')
      AND o.provider_order_id IS NOT NULL
      AND (o.next_check_at IS NULL OR o.next_check_at <= now())
      AND s.api_key IS NOT NULL AND s.is_active
  ) due
  ORDER BY next_check_at ASC NULLS FIRST
  LIMIT p_limit;
$$;

-- 2. Record one poll result -----------------------------------------------
--
-- Same write as the three per-product UPDATEs it replaces:
--   * charge/start_count/remains/currency COALESCEd -- a provider NULL means
--     "did not say", so a recorded figure is never erased
--   * provider_status, normalized_status, last_error always overwritten
--   * next_check_at frozen once final; otherwise the backoff ladder by attempts
--     already made: +15m, +30m, +1h, +2h, then every 4h
--   * completed_at stamped on the first final observation only
-- X additionally mirrors the order onto Posts.status (Processing / Done /
-- Order Failed), as its own poller did. FB Posts and IG Media are never
-- touched: their status columns are CHECK-constrained and drive dedup.

CREATE OR REPLACE FUNCTION public.record_order_poll(
  p_product           text,
  p_id                uuid,
  p_provider_status   text,
  p_normalized_status text,
  p_status_response   jsonb,
  p_charge            numeric,
  p_start_count       integer,
  p_remains           integer,
  p_currency          text,
  p_last_error        text
)
RETURNS TABLE (
  product           text,
  id                uuid,
  provider_order_id text,
  normalized_status text,
  telegram_chat_id  text,
  notified_at       timestamptz
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_final boolean := p_normalized_status IN ('completed', 'partial', 'canceled', 'failed');
  v_table text;
  v_post  text;
BEGIN
  v_table := CASE p_product
    WHEN 'x'  THEN 'Order Info'
    WHEN 'fb' THEN 'FB Order Info'
    WHEN 'ig' THEN 'IG Orders'
  END;
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'record_order_poll: unknown product %', p_product;
  END IF;

  RETURN QUERY EXECUTE format($q$
    UPDATE public.%I o
    SET provider_status   = $2,
        normalized_status = $3,
        %s
        charge            = coalesce($5, o.charge),
        start_count       = coalesce($6, o.start_count),
        remains           = coalesce($7, o.remains),
        currency          = coalesce($8, o.currency),
        poll_attempts     = o.poll_attempts + 1,
        last_checked_at   = now(),
        next_check_at     = CASE
          WHEN $10 THEN o.next_check_at
          ELSE now() + CASE o.poll_attempts
            WHEN 0 THEN interval '15 minutes'
            WHEN 1 THEN interval '30 minutes'
            WHEN 2 THEN interval '1 hour'
            WHEN 3 THEN interval '2 hours'
            ELSE interval '4 hours'
          END
        END,
        last_error        = $9,
        completed_at      = CASE WHEN $10 THEN coalesce(o.completed_at, now())
                                 ELSE o.completed_at END
    WHERE o.id = $1
    RETURNING %L::text, o.id, o.provider_order_id, o.normalized_status,
              o.telegram_chat_id, o.notified_at
  $q$,
    v_table,
    -- IG Orders has no status_response column.
    CASE WHEN p_product = 'ig' THEN '' ELSE 'status_response = $4,' END,
    p_product)
  USING p_id, p_provider_status, p_normalized_status, p_status_response,
        p_charge, p_start_count, p_remains, p_currency, p_last_error, v_final;

  IF p_product = 'x' THEN
    SELECT o.post_id INTO v_post FROM public."Order Info" o WHERE o.id = p_id;
    UPDATE public."Posts"
    SET status = CASE
      WHEN p_normalized_status IN ('completed', 'partial') THEN 'Done'
      WHEN p_normalized_status IN ('canceled', 'failed')   THEN 'Order Failed'
      ELSE 'Processing'
    END
    WHERE post_id = v_post;
  END IF;
END;
$$;

-- 3. Stamp a delivered notice ---------------------------------------------
-- AND notified_at IS NULL: two racing runs can only stamp once.

CREATE OR REPLACE FUNCTION public.mark_order_notified(p_product text, p_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_table text := CASE p_product
    WHEN 'x'  THEN 'Order Info'
    WHEN 'fb' THEN 'FB Order Info'
    WHEN 'ig' THEN 'IG Orders'
  END;
  v_at timestamptz;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'mark_order_notified: unknown product %', p_product;
  END IF;
  EXECUTE format(
    'UPDATE public.%I SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING notified_at',
    v_table) INTO v_at USING p_id;
  RETURN v_at;
END;
$$;

REVOKE ALL ON FUNCTION public.due_order_polls(integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_poll(text, uuid, text, text, jsonb, numeric, integer, integer, text, text)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_notified(text, uuid) FROM public, anon, authenticated;

-- 4. The gate, now with a unified mode ------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_order_polls()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t          record;
  d          record;
  v_stopped  integer;
  v_url      text;
  v_unified  text;
  v_secret   text;
  v_last     timestamptz;
  v_counts   jsonb := '{}';
  v_out      text[] := '{}';
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'order_poll_secret';
  SELECT decrypted_secret INTO v_unified
  FROM vault.decrypted_secrets WHERE name = 'order_poll_webhook_url';

  -- 1. Give up on orders still non-final 48 h after placement. Costs no run.
  FOR t IN
    SELECT * FROM (VALUES ('x', 'Order Info'), ('fb', 'FB Order Info'), ('ig', 'IG Orders'))
      AS v(product, tbl)
  LOOP
    IF to_regclass(format('public.%I', t.tbl)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format($q$
      UPDATE public.%I
      SET next_check_at = 'infinity',
          last_error    = 'Polling stopped: still not final 48 hours after placement.'
      WHERE normalized_status IN ('pending', 'in_progress')
        AND created_at < now() - interval '48 hours'
        AND next_check_at IS DISTINCT FROM 'infinity'
    $q$, t.tbl);
    GET DIAGNOSTICS v_stopped = ROW_COUNT;
    IF v_stopped > 0 THEN
      v_out := v_out || (t.product || ':stopped:' || v_stopped);
    END IF;
  END LOOP;

  -- 2. What is due, per product. due_order_polls() is the same query the
  -- workflow runs, so "due" here and "fetched" there can never disagree --
  -- including the provider-key join, so an unkeyed product is never called.
  SELECT coalesce(jsonb_object_agg(product, n), '{}') INTO v_counts
  FROM (SELECT product, count(*) n FROM public.due_order_polls(1000) GROUP BY product) c;

  IF v_counts = '{}' THEN
    RETURN array_to_string(v_out || 'idle'::text, ' ');
  END IF;

  IF v_secret IS NULL THEN
    RETURN array_to_string(v_out || 'unconfigured'::text, ' ');
  END IF;

  -- 3a. Unified: one call covers every product.
  IF v_unified IS NOT NULL THEN
    SELECT last_successful_run_at INTO v_last
    FROM public."Run State" WHERE key = 'order_poll';
    IF v_last IS NOT NULL AND v_last > now() - interval '9 minutes 50 seconds' THEN
      RETURN array_to_string(v_out || ('throttled ' || v_counts::text), ' ');
    END IF;

    INSERT INTO public."Run State" (key, last_successful_run_at, updated_at)
    VALUES ('order_poll', now(), now())
    ON CONFLICT (key) DO UPDATE SET last_successful_run_at = now(), updated_at = now();

    PERFORM net.http_post(
      url     := v_unified,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'X-Order-Poll-Secret', v_secret),
      body    := jsonb_build_object('due', v_counts, 'fired_at', now()),
      timeout_milliseconds := 5000);

    RETURN array_to_string(v_out || ('fired ' || v_counts::text), ' ');
  END IF;

  -- 3b. Per-product (step A behaviour).
  FOR d IN SELECT key AS product, value::integer AS n FROM jsonb_each_text(v_counts) LOOP
    SELECT last_successful_run_at INTO v_last
    FROM public."Run State" WHERE key = 'order_poll_' || d.product;
    IF v_last IS NOT NULL AND v_last > now() - interval '9 minutes 50 seconds' THEN
      v_out := v_out || (d.product || ':throttled');
      CONTINUE;
    END IF;

    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'order_poll_webhook_url_' || d.product;
    IF v_url IS NULL THEN
      v_out := v_out || (d.product || ':unconfigured');
      CONTINUE;
    END IF;

    INSERT INTO public."Run State" (key, last_successful_run_at, updated_at)
    VALUES ('order_poll_' || d.product, now(), now())
    ON CONFLICT (key) DO UPDATE SET last_successful_run_at = now(), updated_at = now();

    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'X-Order-Poll-Secret', v_secret),
      body    := jsonb_build_object('product', d.product, 'due_count', d.n, 'fired_at', now()),
      timeout_milliseconds := 5000);

    v_out := v_out || (d.product || ':fired:' || d.n);
  END LOOP;

  RETURN array_to_string(v_out, ' ');
END;
$$;

COMMENT ON FUNCTION public.trigger_order_polls() IS
  'Heartbeat for the SMM order pollers. Stops orders non-final after 48 h, then '
  'calls n8n ONLY when due_order_polls() has rows, at most every 10 minutes. '
  'Unified mode (Vault order_poll_webhook_url set): one call for all products. '
  'Otherwise per product via order_poll_webhook_url_<product>.';

REVOKE ALL ON FUNCTION public.trigger_order_polls() FROM public, anon, authenticated;
