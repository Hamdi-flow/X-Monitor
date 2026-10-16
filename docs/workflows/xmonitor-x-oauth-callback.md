# XMonitor - X OAuth Callback

## Purpose

Production webhook workflow that completes the X OAuth PKCE flow started by the Telegram router. It receives X's redirect, validates the stored auth session, exchanges the authorization code for tokens, fetches the authenticated X user, stores account tokens, marks the auth session as used, notifies Telegram, and responds to the browser.

## Identity

- n8n ID: `JQ9KM3l1kRJQhWxb`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-x-oauth-callback.json`
- Unhandled error workflow: `XMonitor - Production Developer Error Alerts` (`UmKr9JkZ3ec3GDH5`)
- Last observed live update: `2026-10-14T23:06:25.762Z` (published; `versionId` = `activeVersionId` = `08616485-30fd-44ac-a780-ae644167020d`, re-exported 2026-10-16)
- Node count: `21`
- Webhook path: `/webhook/x-oauth-callback`
- HTTP method: `GET`

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Webhook path | `OAuth Callback Webhook` | `x-oauth-callback` | Must match the Telegram router OAuth redirect URI and the X app callback URL. |
| Redirect URI | `Prepare Token Request` | `https://tarek1207.app.n8n.cloud/webhook/x-oauth-callback` | Sent to X during token exchange; must exactly match the authorize request. |
| Token endpoint | `Exchange Code For Tokens` | `https://api.x.com/2/oauth2/token` | Exchanges authorization code and PKCE verifier for tokens. |
| User endpoint | `Get Authenticated X User` | `https://api.x.com/2/users/me` | Resolves authenticated X user ID and username. |
| Session lookup key | `Get Auth Session` | `state` | Matches X callback state to `X Auth Sessions`. |
| Account upsert key | `Upsert X Auth Account` | `x_user_id` | One stored X auth account per X user. |

## Main Flow

1. `OAuth Callback Webhook` receives X's redirect with `code` and `state`, or an OAuth error.
   `PolyJess callback?` checks the state first: a `polyjess.<43 chars>` state leaves this flow
   (see [PolyJess Forwarding](#polyjess-forwarding)), and every other state continues below.
2. `Parse Callback` rejects provider errors and missing `code` or `state`.
3. `Get Auth Session` fetches the `X Auth Sessions` row for the callback state.
4. `Validate Auth Session` rejects missing, expired, or already used sessions.
5. `Prepare Token Request` prepares Basic auth and redirect URI.
6. `Exchange Code For Tokens` posts `grant_type=authorization_code`, `code`, `redirect_uri`, and `code_verifier` to X.
7. `Get Authenticated X User` calls X `/2/users/me`.
8. `Prepare Account Row` builds the persistent token/account row.
9. `Upsert X Auth Account` stores access token, refresh token, expiry, scope, username, and Telegram chat.
10. `Stamp Auth Account Client` (T5) copies the session's `client_id` onto the account row.
    It is a separate statement with `onError: continueRegularOutput` and is a no-op when
    no client resolved, so it can never stop an account from connecting.
11. `Mark Auth Session Used` marks the PKCE state as used.
12. `Console authorization?` checks whether the state starts with `console.`. A console
    authorization goes straight to `Respond Success`. A Telegram one goes through
    `Send Telegram Success` first, which tells the user their X account connected.
13. `Respond Success` tells the browser the flow is complete.

Console states have the shape `console.<x_username>.<nonce>`. `Prepare Account Row` throws
if the X account that authorized is not that username, so a console user cannot attach the
wrong X account to a client.

## PolyJess Forwarding

Added 2026-10-14 by two n8n editor saves by tarek ismail (`71562351`, then `08616485`). Neither
was made through the repo. When `state` matches `^polyjess\.[A-Za-z0-9_-]{43}$`:

1. `Forward PolyJess callback` sends `GET` to
   `https://npytqidroqxgikaqofmq.supabase.co/functions/v1/jess-workspace-gateway/oauth/polyjess`
   with `state`, `code` and `error` as query parameters. It uses a full response and
   `neverError`, and its timeout is 60 s. The first save used 20 s, and the second save
   changed nothing but this timeout.
2. `Respond PolyJess callback` returns that response's body and status code to the browser.

Nothing in `X Auth Sessions` or `X Auth Accounts` is read or written on this path, and no
Telegram message is sent. `npytqidroqxgikaqofmq` is the **XMonitor Staging** Supabase project,
so this production webhook depends on an edge function hosted in staging. That edge function
is not in this repo.

## Data Stores

| Table | Use |
| --- | --- |
| `X Auth Sessions` | Reads `state`, `code_verifier`, `telegram_chat_id`, `expires_at`, `used` and `client_id`; marks the state used after success. |
| `X Auth Accounts` | Stores `telegram_chat_id`, `x_user_id`, `x_username`, access/refresh tokens, expiry, scope, and update time; `Stamp Auth Account Client` then sets `client_id`. |

## Error Paths

- OAuth provider error or missing callback fields returns HTTP `400`.
- Missing, used, or expired session returns HTTP `400` and asks the user to send `/auth_x` again.

## Agent Change Guidance

- Keep webhook path, Telegram router redirect URI, and X app callback URL aligned.
- Do not print or duplicate X client secrets or returned tokens.
- If changing session fields, update both this workflow and the Telegram router's `Save Auth Session`.
- If changing token/account fields, inspect hide-replies token refresh behavior in the Telegram router.
