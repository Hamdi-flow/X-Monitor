-- Read views for X-Monitor-Console: public.console_posts and public.console_x_connections.
--
-- WHY THIS FILE EXISTS. Both views were created by hand on both Supabase projects and
-- never had a migration, so nothing in any repo recorded them (found by the console's
-- docs/schema-dependencies.md audit, 2026-10-23). This file records them AS THEY ARE
-- LIVE. It was not written to change anything: on 2026-10-23,
-- md5(pg_get_viewdef(oid, true)) matched on staging (npytqidroqxgikaqofmq) and
-- production (jxnzdxyhoakpfmkbjdeq):
--   console_posts          97a879143a3d76092f25bb91d3b0d724
--   console_x_connections  caacc7a7662a2a3aa195a6ea0118b207
-- Both have security_invoker = true, and only postgres and service_role hold
-- privileges (anon and authenticated have none). Re-running it is a no-op.
--
-- WHAT THEY ARE FOR (see ../X-Monitor-Console/CLAUDE.md, "Data honesty"):
--   console_posts decodes the overloaded Posts.status into suppression_state and
--     order_state, so the console and the workflows share one decoding. Do not
--     reimplement it in TypeScript. suppression_state_is_certain = false means the
--     snooze state was overwritten by an order status and is genuinely unknown.
--   console_x_connections exposes X token PRESENCE and timestamps, never the tokens.
--     needs_reconnect mirrors the Telegram router's own condition
--     (expires_at < now() AND no refresh token). A lapsed expires_at alone is normal.
--     Never add access_token or refresh_token to this view.
--
-- BOTH SUPABASE PROJECTS ARE SHARED BY X-Monitor, FB Monitor AND Insta-Monitor. Every
-- statement names its view. Changing a column set needs DROP VIEW first (CREATE OR
-- REPLACE cannot drop or reorder columns); check the console's lib/platform/x.ts
-- selects before doing that.

CREATE OR REPLACE VIEW public.console_posts
WITH (security_invoker = true) AS
 SELECT p.post_id,
    p.user_id,
    p.post_text,
    p.comment_count,
    p.analyzed_count,
    p.negative_count,
    p.negative_ratio,
    p.snooze_runs_remaining,
    p.created_at,
    p.status AS status_raw,
    p.like_count,
    p.retweet_count,
    p.quote_count,
    p.bookmark_count,
    p.impression_count,
    p.metrics_updated_at,
    p.status_changed_at,
    p.status_changed_by,
        CASE p.status
            WHEN 'New'::text THEN 'active'::text
            WHEN 'Snoozed'::text THEN 'snoozed'::text
            WHEN 'Ignored'::text THEN 'ignored'::text
            ELSE 'unknown'::text
        END AS suppression_state,
    p.status = ANY (ARRAY['New'::text, 'Snoozed'::text, 'Ignored'::text]) AS suppression_state_is_certain,
    COALESCE(
        CASE
            WHEN lower(o.normalized_status) = ANY (ARRAY['pending'::text, 'in_progress'::text, 'processing'::text]) THEN 'processing'::text
            WHEN lower(o.normalized_status) = ANY (ARRAY['completed'::text, 'partial'::text]) THEN 'done'::text
            WHEN lower(o.normalized_status) = ANY (ARRAY['failed'::text, 'canceled'::text, 'cancelled'::text, 'refunded'::text]) THEN 'failed'::text
            WHEN o.normalized_status IS NOT NULL THEN 'processing'::text
            ELSE NULL::text
        END,
        CASE p.status
            WHEN 'Processing'::text THEN 'processing'::text
            WHEN 'Done'::text THEN 'done'::text
            WHEN 'Order Failed'::text THEN 'failed'::text
            ELSE 'none'::text
        END) AS order_state,
    t.username,
    t.display_name,
    t.telegram_chat_id,
    t.is_active AS account_is_active,
    COALESCE(NULLIF(t.display_name, ''::text), '@'::text || t.username) AS author_label,
        CASE
            WHEN t.username IS NULL THEN NULL::text
            ELSE (('https://x.com/'::text || t.username) || '/status/'::text) || p.post_id
        END AS post_url
   FROM "Posts" p
     LEFT JOIN "Tracked Users" t ON t.user_id = p.user_id
     LEFT JOIN LATERAL ( SELECT oi.normalized_status
           FROM "Order Info" oi
          WHERE oi.post_id = p.post_id
          ORDER BY oi.created_at DESC NULLS LAST, oi.id DESC
         LIMIT 1) o ON true;

CREATE OR REPLACE VIEW public.console_x_connections
WITH (security_invoker = true) AS
 SELECT x_user_id,
    x_username,
    telegram_chat_id,
    scope,
    updated_at AS last_authorised_at,
    expires_at,
    expires_at < now() AS access_token_lapsed,
    access_token IS NOT NULL AND access_token <> ''::text AS has_access_token,
    refresh_token IS NOT NULL AND refresh_token <> ''::text AS has_refresh_token,
    expires_at < now() AND (refresh_token IS NULL OR refresh_token = ''::text) AS needs_reconnect
   FROM "X Auth Accounts" a;

-- The console reads these with the service key only. Keep the public API roles out.
REVOKE ALL ON public.console_posts FROM anon, authenticated;
REVOKE ALL ON public.console_x_connections FROM anon, authenticated;
