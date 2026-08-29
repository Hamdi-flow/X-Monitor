-- Move the moderation-queue drain from an n8n schedule to a Postgres heartbeat
--
-- Companion to 2026-08-26-moderation-queue.sql. That migration built the queue;
-- this one changes what wakes the drain.
--
-- WHY. n8n bills per workflow execution, and an execution is counted when the
-- TRIGGER FIRES, not when the workflow does useful work. The drain's original
-- Schedule Trigger ran every 5 minutes:
--
--   288 executions/day = ~8,640/month
--
-- With an empty queue every one of those runs "Find Drainable Tokens", gets zero
-- rows, and stops. Worse, the 5-minute cadence never bought throughput in the
-- first place: X allows 50 hides per 15 minutes per token, so during an active
-- batch the passes at +5 and +10 minutes find allowance 0 and defer by design
-- (pinned by tests/n8n/moderation-queue-drain-pins/quota-exhausted-mid-batch).
-- Two of every three passes were guaranteed no-ops.
--
-- So the "is there work?" question moves to the database, which polls for free.
-- pg_cron ticks every minute and only calls the n8n webhook when
-- "Moderation Queue" actually has due rows:
--
--   n8n executions ~= number of drain passes actually needed
--   (a 120-reply hide is 3 passes, not 288/day forever)
--
-- It is also FASTER: worst-case pickup latency drops from 5 minutes to 1.
--
-- WHAT THIS NEEDS THAT SCHEMA CANNOT PROVIDE. Two Vault secrets, set per
-- environment. No n8n environment variable -- see section 5.
--
-- Idempotent; safe to re-run.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-08-27. The job is created
-- DISABLED by this file; it was subsequently ENABLED on staging the same day,
-- after the workflow was activated and the webhook gate was verified live in
-- both directions. Re-running this file re-disables the job -- that is
-- deliberate, so a replay onto production never starts hiding replies by
-- surprise.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-08-27 and ENABLED the same
-- day, after the production drain was published, activated, and its webhook gate
-- verified live in both directions. Production carries its own Vault secrets --
-- a DIFFERENT shared secret from staging, so one leaked environment cannot
-- authorise the other.

-- 1. Extensions ------------------------------------------------------------
-- pg_cron is the clock; pg_net is the phone. Postgres has neither by default,
-- and neither one alone is sufficient here.
--
-- pg_net is deliberately chosen over the older `http` extension because it is
-- ASYNCHRONOUS: net.http_post() hands the request to a background worker and
-- returns immediately. `http` is synchronous and would hold this function's
-- transaction open for the duration of the call -- a slow or hanging n8n would
-- then hold locks on "Moderation Queue".

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. The heartbeat function ------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_moderation_drain()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
-- Empty search_path so nothing here resolves through a caller-controlled
-- schema. Everything below is schema-qualified; only pg_catalog builtins
-- (now(), count(), greatest()) resolve implicitly.
SET search_path = ''
AS $$
DECLARE
  v_reclaimed integer := 0;
  v_due       integer := 0;
  v_url       text;
  v_secret    text;
  v_last      timestamptz;
BEGIN
  -- 2a. Recover stale claims.
  --
  -- "Claim Due Hide Rows" flips rows to 'in_flight' before calling X. If a drain
  -- pass dies between the claim and "Persist Queue Outcomes", those rows are
  -- stranded: nothing in the drain ever looks at 'in_flight' again, so without
  -- this they would sit there forever and the batch would silently stall.
  --
  -- updated_at is maintained by the moderation_queue_set_updated_at trigger, so
  -- for an in_flight row it is the claim time.
  --
  -- The attempt is deliberately NOT refunded. A pass that died after dispatching
  -- may well have hidden the reply, and leaving the attempt charged keeps the
  -- retry budget honest; a genuinely re-hidden reply just comes back as
  -- already_hidden, which the drain treats as success.
  UPDATE public."Moderation Queue"
  SET status          = 'queued',
      last_error      = 'Drain pass did not finish; stale claim reclaimed.',
      last_error_code = 'stale_claim'
  WHERE status = 'in_flight'
    AND updated_at < now() - interval '15 minutes';
  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

  -- 2b. Is there anything to do?
  --
  -- This is the whole point of the migration, and it is the only query that runs
  -- on an idle tick. It is a covering probe of moderation_queue_due_idx
  -- (x_user_id, not_before) WHERE status = 'queued' -- sub-millisecond, and it
  -- costs nothing per invocation because Postgres does not bill per query.
  SELECT count(*) INTO v_due
  FROM public."Moderation Queue"
  WHERE status = 'queued'
    AND action = 'hide'
    AND not_before <= now();

  IF v_due = 0 THEN
    -- No HTTP call, therefore no n8n execution, therefore no charge. Rows
    -- deferred behind a rate-limit window land here too: not_before is in the
    -- future, so they are not due, so nothing fires until the window resets.
    RETURN 'idle';
  END IF;

  -- 2c. Do not stack passes.
  --
  -- The drain is already safe against concurrent runs -- "Claim Due Hide Rows"
  -- uses FOR UPDATE SKIP LOCKED and re-checks status = 'queued' -- so a second
  -- pass would claim nothing. But it would still cost a full n8n execution to
  -- discover that, which is exactly what this migration exists to avoid.
  IF EXISTS (SELECT 1 FROM public."Moderation Queue" WHERE status = 'in_flight') THEN
    RETURN 'in_flight';
  END IF;

  -- 2d. Throttle. Belt and braces against a cron schedule someone later tightens
  -- to seconds: at most one call per minute regardless of tick rate.
  SELECT last_successful_run_at INTO v_last
  FROM public."Run State"
  WHERE key = 'moderation_queue_drain';

  IF v_last IS NOT NULL AND v_last > now() - interval '55 seconds' THEN
    RETURN 'throttled';
  END IF;

  -- 2e. Configuration. Kept in Vault rather than inlined here because a function
  -- body is readable by anything with schema access, and because staging and
  -- production need different values for the same migration.
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets WHERE name = 'moderation_drain_webhook_url';
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'moderation_drain_secret';

  -- Fail closed and say so. Returning 'unconfigured' every minute is a loud,
  -- greppable signal in cron.job_run_details; firing an unauthenticated request
  -- would not be.
  IF v_url IS NULL OR v_secret IS NULL THEN
    RETURN 'unconfigured';
  END IF;

  -- Stamp BEFORE the call. pg_net is fire-and-forget, so if the request is lost
  -- the throttle simply expires and the next tick retries -- the rows are still
  -- queued. Stamping after would risk a burst if the call were slow.
  INSERT INTO public."Run State" (key, last_successful_run_at, updated_at)
  VALUES ('moderation_queue_drain', now(), now())
  ON CONFLICT (key) DO UPDATE
    SET last_successful_run_at = now(), updated_at = now();

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'X-Drain-Secret', v_secret
               ),
    body    := jsonb_build_object(
                 'due_count',       v_due,
                 'stale_reclaimed', v_reclaimed,
                 'fired_at',        now()
               ),
    timeout_milliseconds := 5000
  );

  RETURN 'fired:' || v_due || CASE WHEN v_reclaimed > 0
                                   THEN ' reclaimed:' || v_reclaimed
                                   ELSE '' END;
END;
$$;

COMMENT ON FUNCTION public.trigger_moderation_drain() IS
  'Heartbeat for "XMonitor - Moderation Queue Drain". Reclaims stale in_flight '
  'claims, then calls the n8n webhook ONLY when "Moderation Queue" has due rows, '
  'so an idle queue costs zero n8n executions. Returns idle | in_flight | '
  'throttled | unconfigured | fired:<n>, all visible in cron.job_run_details.';

-- Nobody but the scheduler should be able to fire the drain.
REVOKE ALL ON FUNCTION public.trigger_moderation_drain() FROM public, anon, authenticated;

-- 3. Schedule --------------------------------------------------------------
-- Every minute. The function returns early on an idle queue, so the cost of a
-- tight cadence is one index probe; the benefit is pickup latency of at most
-- 60 seconds instead of the 5 minutes the n8n schedule gave.

SELECT cron.schedule(
  'moderation-queue-drain',
  '* * * * *',
  $cron$SELECT public.trigger_moderation_drain()$cron$
);

-- 4. Created DISABLED ------------------------------------------------------
-- Enabling this job is the moment the queue starts hiding replies on X for
-- real. That needs explicit human approval, and it needs the n8n workflow
-- activated first -- an n8n production webhook only answers while its workflow
-- is active, so until then every call would just collect a 404.
--
-- To turn it on, in order:
--   1. set the two Vault secrets and the n8n env var (section 5)
--   2. activate "XMonitor - Moderation Queue Drain (Staging)" in n8n
--   3. SELECT cron.alter_job(
--        (SELECT jobid FROM cron.job WHERE jobname = 'moderation-queue-drain'),
--        active := true);
--
-- To stop it in a hurry, the same call with active := false. That is the kill
-- switch: it leaves the queue intact and simply stops anything being dispatched.

SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'moderation-queue-drain'),
  active := false
);

-- 5. Required configuration (NOT created here) -----------------------------
-- Values differ per environment and must never live in a committed migration.
--
--   -- Supabase, once per environment:
--   SELECT vault.create_secret(
--     'https://<host>/webhook/moderation-queue-drain-staging',
--     'moderation_drain_webhook_url',
--     'n8n production webhook for the moderation queue drain');
--
--   SELECT vault.create_secret(
--     encode(gen_random_bytes(32), 'hex'),
--     'moderation_drain_secret',
--     'Shared secret for the moderation drain webhook');
--
--   -- NO n8n environment variable is needed. n8n Cloud BLOCKS env access inside
--   -- Code nodes (a probe returned "access to env vars denied") and $vars is
--   -- empty on this instance, so the drain gate reads the secret from Vault via
--   -- its Postgres credential instead. That role is `postgres`, which can read
--   -- vault.decrypted_secrets -- verified 2026-08-27.
--
-- Read the generated secret back with:
--   SELECT decrypted_secret FROM vault.decrypted_secrets
--   WHERE name = 'moderation_drain_secret';
--
-- The drain's "Verify Drain Secret" node compares the presented header against
-- vault.decrypted_secrets IN SQL and returns only a boolean, so the secret never
-- enters n8n execution data. It fails CLOSED on every path: missing header,
-- empty header, wrong value, or a missing Vault row.

-- 6. Operating notes -------------------------------------------------------
-- Recent decisions and why the job did or did not fire:
--   SELECT j.jobname, d.status, d.return_message, d.start_time
--   FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--   WHERE j.jobname = 'moderation-queue-drain'
--   ORDER BY d.start_time DESC LIMIT 20;
--
-- Whether n8n actually answered (pg_net is async, so this is the only place the
-- response appears; rows are garbage-collected after a few hours):
--   SELECT id, status_code, error_msg, created
--   FROM net._http_response ORDER BY created DESC LIMIT 10;
--
-- pg_net does NOT guarantee delivery and does not retry. That is survivable
-- here only because the queue is durable: a dropped call leaves the rows
-- 'queued', so the next tick asks the same question and calls again. Do not
-- copy this pattern for work that is not backed by a queue.
