-- Move order status polling from n8n schedules to a Postgres heartbeat
--
-- Same pattern as 2026-08-27-moderation-drain-cron.sql, applied to the SMM order
-- pollers of all three products. That migration's header explains the mechanism
-- (pg_cron = clock, pg_net = phone, Vault = config) and is not repeated here.
--
-- WHY. n8n bills an execution when a trigger fires, not when work is done. The
-- pollers ran on fixed schedules:
--
--   XMonitor  prod + staging   every 30 min    96/day
--   FB        prod + staging   every 30 min    96/day
--   IG        prod + staging   every 15 min   192/day
--   X-Monitor-Advanced          every 8 h        3/day
--
-- ~11,500 executions/month with everything armed. Measured 2026-10-01..15 with
-- only IG staging, FB staging and FB prod armed: 2,181 runs, each ~0.3 s, all of
-- them no-ops -- orders are rare, so nearly every tick found nothing due.
--
-- AFTER. pg_cron ticks every minute and asks each order table whether anything
-- is due. Only a product with due rows gets an HTTP call, and so an n8n run:
--
--   no open orders            -> 0 executions
--   one order                 -> one run per backoff step until it goes final
--   several due together      -> one run (the workflow batches up to 50 rows)
--
-- WHAT EACH TICK DOES, per product:
--   1. Stops orders still non-final 48 h after placement (next_check_at :=
--      'infinity', reason in last_error). Done here, so giving up costs no run.
--      This closes limits-and-capacity.md section 7.1 #7 ("polled forever").
--   2. Counts due rows. Zero -> 'idle', nothing else happens.
--   3. FB and IG only: requires an active FB SMM Settings row with a key.
--      Their workflows INNER JOIN on it and would do nothing anyway, so firing
--      without it would buy an empty run every 10 minutes.
--   4. Throttle: at most one call per product per 10 minutes, so orders that
--      fall due a few minutes apart share a run.
--   5. Needs that product's webhook URL and the shared secret in Vault. A
--      product without a URL reports 'unconfigured' and is never called --
--      this is how products are switched over one at a time.
--
-- The backoff ladder itself (+15m, +30m, +1h, +2h, then every 4h) lives in each
-- poller's UPDATE, next to the poll_attempts it reads.
--
-- Idempotent; safe to re-run. Re-running re-DISABLES the cron job, deliberately,
-- as with the moderation drain.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-10-23.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-10-23. The cron job is still
-- DISABLED there and the Vault secrets are not yet created -- see the unified
-- migration and docs/workflows/orders-order-status-poll.md for the steps.

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.trigger_order_polls()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  p          record;
  v_due      integer;
  v_stopped  integer;
  v_url      text;
  v_secret   text;
  v_last     timestamptz;
  v_note     text;
  v_out      text[] := '{}';
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'order_poll_secret';

  -- product key, table, whether the provider row must be configured.
  -- 'Advanced Order Info' exists only in production; missing tables are skipped.
  FOR p IN
    SELECT * FROM (VALUES
      ('x',          'Order Info',          false),
      ('x_advanced', 'Advanced Order Info', false),
      ('fb',         'FB Order Info',       true),
      ('ig',         'IG Orders',           true)
    ) AS t(product, tbl, needs_provider)
  LOOP
    IF to_regclass(format('public.%I', p.tbl)) IS NULL THEN
      CONTINUE;
    END IF;

    -- 1. Give up on orders that never resolved.
    EXECUTE format($q$
      UPDATE public.%I
      SET next_check_at = 'infinity',
          last_error    = 'Polling stopped: still not final 48 hours after placement.'
      WHERE normalized_status IN ('pending', 'in_progress')
        AND created_at < now() - interval '48 hours'
        AND next_check_at IS DISTINCT FROM 'infinity'
    $q$, p.tbl);
    GET DIAGNOSTICS v_stopped = ROW_COUNT;
    v_note := CASE WHEN v_stopped > 0 THEN ' stopped:' || v_stopped ELSE '' END;

    -- 2. Anything due?
    EXECUTE format($q$
      SELECT count(*) FROM public.%I
      WHERE normalized_status IN ('pending', 'in_progress')
        AND next_check_at <= now()
    $q$, p.tbl) INTO v_due;

    IF v_due = 0 THEN
      v_out := v_out || (p.product || ':idle' || v_note);
      CONTINUE;
    END IF;

    -- 3. Provider configured?
    IF p.needs_provider AND NOT EXISTS (
      SELECT 1 FROM public."FB SMM Settings"
      WHERE is_active AND api_key IS NOT NULL
    ) THEN
      v_out := v_out || (p.product || ':no_provider' || v_note);
      CONTINUE;
    END IF;

    -- 4. Throttle. 9m50s rather than 10m so a tick landing a few seconds early
    -- does not slip the next call by a whole extra minute.
    SELECT last_successful_run_at INTO v_last
    FROM public."Run State" WHERE key = 'order_poll_' || p.product;

    IF v_last IS NOT NULL AND v_last > now() - interval '9 minutes 50 seconds' THEN
      v_out := v_out || (p.product || ':throttled' || v_note);
      CONTINUE;
    END IF;

    -- 5. Configured for this product?
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'order_poll_webhook_url_' || p.product;

    IF v_url IS NULL OR v_secret IS NULL THEN
      v_out := v_out || (p.product || ':unconfigured' || v_note);
      CONTINUE;
    END IF;

    -- Stamp before the call: pg_net is fire-and-forget, and a lost request
    -- only means the rows are still due on the next allowed tick.
    INSERT INTO public."Run State" (key, last_successful_run_at, updated_at)
    VALUES ('order_poll_' || p.product, now(), now())
    ON CONFLICT (key) DO UPDATE
      SET last_successful_run_at = now(), updated_at = now();

    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
                   'Content-Type',        'application/json',
                   'X-Order-Poll-Secret', v_secret
                 ),
      body    := jsonb_build_object(
                   'product',   p.product,
                   'due_count', v_due,
                   'fired_at',  now()
                 ),
      timeout_milliseconds := 5000
    );

    v_out := v_out || (p.product || ':fired:' || v_due || v_note);
  END LOOP;

  RETURN array_to_string(v_out, ' ');
END;
$$;

COMMENT ON FUNCTION public.trigger_order_polls() IS
  'Heartbeat for the SMM order pollers (X, X-Advanced, FB, IG). Stops orders '
  'non-final after 48 h, then calls a product''s n8n poller webhook ONLY when '
  'that product has due rows, at most every 10 minutes. Returns one '
  '<product>:idle|no_provider|throttled|unconfigured|fired:<n> per table '
  'when called directly (cron.job_run_details only records "1 row").';

REVOKE ALL ON FUNCTION public.trigger_order_polls() FROM public, anon, authenticated;

SELECT cron.schedule(
  'order-status-polls',
  '* * * * *',
  $cron$SELECT public.trigger_order_polls()$cron$
);

-- Created DISABLED. Enable only after the target pollers are switched to their
-- webhook trigger and published -- an inactive webhook just collects 404s.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'order-status-polls'),
  active := false
);

-- Required configuration (NOT created here; values differ per environment) ---
--
--   SELECT vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
--     'order_poll_secret', 'Shared secret for the order poller webhooks');
--
--   One per product that should be called (leave unset to keep it off):
--   SELECT vault.create_secret('https://<n8n host>/webhook/<path>',
--     'order_poll_webhook_url_x' | '_x_advanced' | '_fb' | '_ig', '...');
--
-- Each poller's gate node compares the X-Order-Poll-Secret header against
-- vault.decrypted_secrets IN SQL and returns only a boolean, exactly like
-- Verify Drain Secret, so the secret never enters n8n execution data.
--
-- Operating notes ----------------------------------------------------------
-- cron.job_run_details shows whether each tick succeeded, but its
-- return_message is only "1 row" -- pg_cron does not record a function's
-- text result. To see the verdict, call it by hand (it is the same tick):
--   SELECT public.trigger_order_polls();
-- Whether n8n answered a fired call:
--   SELECT status_code, error_msg, created FROM net._http_response
--   ORDER BY created DESC LIMIT 10;
--
-- Kill switch: cron.alter_job(<jobid>, active := false). Orders stay intact and
-- simply stop being polled.
