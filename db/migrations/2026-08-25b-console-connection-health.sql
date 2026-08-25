-- Console connection health -- a credential-free view over "X Auth Accounts"
--
-- Follow-up to 2026-08-25-console-read-model.sql, which is already applied to
-- both environments. Separate file rather than an edit, because that one has
-- shipped.
--
-- Two problems this fixes.
--
-- 1. THE CONSOLE WAS READING expires_at AS A HEALTH SIGNAL. It is not one.
--
--    X OAuth2 access tokens live two hours -- verified in production, where
--    expires_at is exactly updated_at + 2h on all ten rows. The Telegram router
--    refreshes lazily, at the moment it needs the token:
--
--      tokenExpired = expires_at <= Date.now() + refreshBufferMs
--      if (tokenExpired && !account.refresh_token) -> fail, ask for /auth
--
--    So a lapsed expires_at is the NORMAL steady state between hides, and says
--    nothing about whether the account can act. All ten production rows read as
--    lapsed on 2026-08-25 while the system was working fine. A console that
--    paints those red is a false alarm on every account, which is worse than no
--    indicator at all -- it teaches the operator to ignore the one screen whose
--    entire job is to be believed.
--
--    The real failure is the router's own condition: lapsed AND no refresh
--    token. That is the state that produces "Please send /auth_..." and stops
--    moderation dead.
--
-- 2. THE APP SHOULD NEVER SELECT A CREDENTIAL COLUMN AT ALL. Deriving
--    has_refresh_token in TypeScript would mean pulling access_token and
--    refresh_token into application memory, and from there into any error
--    payload, log line or React prop that happens to serialise the row. The
--    booleans are computed here so the console never holds the secret in the
--    first place -- "connection health means status, not secrets" enforced by
--    the query surface rather than by reviewer discipline.
--
-- WHAT THIS STILL CANNOT SEE: a refresh token that exists but has been revoked
-- by X, or one whose rotation failed. Those look identical to healthy here.
-- Nothing in this schema records a refresh outcome, so nothing can distinguish
-- them. Architecture section 4.2 specifies "X Auth Accounts".last_refresh_error
-- for exactly this at Phase 2; until it exists the console says "refreshable",
-- which is the honest claim, rather than "connected", which is not.
--
-- Idempotent; safe to re-run. Additive -- no table is touched.
--
-- Applied to staging (npytqidroqxgikaqofmq) on 2026-08-25.
-- Applied to production (jxnzdxyhoakpfmkbjdeq) on 2026-08-25.

BEGIN;

CREATE OR REPLACE VIEW public.console_x_connections
WITH (security_invoker = true) AS
SELECT
  a.x_user_id,
  a.x_username,
  a.telegram_chat_id,
  a.scope,

  -- When the account last completed an OAuth exchange or refresh. This is the
  -- useful timestamp for a human: "authorised 3 days ago" means something,
  -- "access token expired 3 days ago" does not.
  a.updated_at AS last_authorised_at,

  -- Kept for diagnostics only. Do NOT drive a health badge from this.
  a.expires_at,
  (a.expires_at < now()) AS access_token_lapsed,

  -- Presence only. The token values never leave the database.
  (a.access_token  IS NOT NULL AND a.access_token  <> '') AS has_access_token,
  (a.refresh_token IS NOT NULL AND a.refresh_token <> '') AS has_refresh_token,

  -- The router's own failure condition, mirrored so the console and the bot
  -- agree on what "broken" means. Anything else is workable.
  (a.expires_at < now()
     AND (a.refresh_token IS NULL OR a.refresh_token = '')) AS needs_reconnect

FROM public."X Auth Accounts" a;

COMMENT ON VIEW public.console_x_connections IS
  'Credential-free health view over "X Auth Accounts" for the X-Monitor Console. '
  'Exposes presence booleans and timestamps, never token values. needs_reconnect '
  'mirrors the Telegram router''s own refuse-to-act condition; expires_at alone is '
  'NOT a health signal, because access tokens live 2 hours and are refreshed '
  'lazily.';

COMMENT ON COLUMN public.console_x_connections.needs_reconnect IS
  'True only when the access token has lapsed AND no refresh token exists -- the '
  'state in which the router tells the user to re-run /auth. A lapsed token with '
  'a refresh token present is normal and healthy.';

REVOKE ALL ON public.console_x_connections FROM anon, authenticated;

COMMIT;


-- Runbook ---------------------------------------------------------------------
--
--   select x_username, access_token_lapsed, has_refresh_token, needs_reconnect
--     from public.console_x_connections order by x_username;
--
-- Production on 2026-08-25: 10 rows, all access_token_lapsed = true,
-- all has_refresh_token = true, all needs_reconnect = FALSE. That combination is
-- the expected healthy steady state and is the reason this file exists.
