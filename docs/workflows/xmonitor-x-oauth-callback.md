# XMonitor - X OAuth Callback

## Purpose

Production webhook workflow that completes the X OAuth PKCE flow started by the Telegram router. It receives X's redirect, validates the stored auth session, exchanges the authorization code for tokens, fetches the authenticated X user, stores account tokens, marks the auth session as used, notifies Telegram, and responds to the browser.

## Identity

- n8n ID: `JQ9KM3l1kRJQhWxb`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-x-oauth-callback.json`
- Unhandled error workflow: `XMonitor - Production Developer Error Alerts` (`UmKr9JkZ3ec3GDH5`)
- Last observed live update: `2026-08-30` (T5, published `75af05ef-4586-472a-8bd9-5c6ee088a554`, 17 nodes)
- Webhook path: `/webhook/x-oauth-callback`
- HTTP method: `GET`

## The Client Stamp (Phase T5)

Live since 2026-08-30, published `75af05ef-4586-472a-8bd9-5c6ee088a554` at 17 nodes.
`Stamp Auth Account Client` runs after `Upsert X Auth Account` and records which client an X
authorization was for, on `X Auth Accounts.client_id`. It is a separate node rather than a
column on that upsert, and carries `onError: continueRegularOutput`, so it can never break an
authorization — see the staging doc for the reasoning.

`"X Auth Sessions".client_id` was added by `db/migrations/2026-08-29-t5-onboarding.sql`.
Existing production tokens keep `client_id = null` until each is re-authorized; nothing reads
the column yet.

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
2. `Parse Callback` rejects provider errors and missing `code` or `state`.
3. `Get Auth Session` fetches the `X Auth Sessions` row for the callback state.
4. `Validate Auth Session` rejects missing, expired, or already used sessions.
5. `Prepare Token Request` prepares Basic auth and redirect URI.
6. `Exchange Code For Tokens` posts `grant_type=authorization_code`, `code`, `redirect_uri`, and `code_verifier` to X.
7. `Get Authenticated X User` calls X `/2/users/me`.
8. `Prepare Account Row` builds the persistent token/account row.
9. `Upsert X Auth Account` stores access token, refresh token, expiry, scope, username, and Telegram chat; **`Stamp Auth Account Client`** then records the owning client (T5).
10. `Mark Auth Session Used` marks the PKCE state as used.
11. `Send Telegram Success` tells the user their X account connected.
12. `Respond Success` tells the browser the flow is complete.

## Data Stores

| Table | Use |
| --- | --- |
| `X Auth Sessions` | Reads `state`, `code_verifier`, `telegram_chat_id`, `client_id`, `expires_at`, and `used`; marks the state used after success. |
| `X Auth Accounts` | Stores `telegram_chat_id`, `x_user_id`, `x_username`, access/refresh tokens, expiry, scope, update time, and `client_id` (T5). |

## Error Paths

- OAuth provider error or missing callback fields returns HTTP `400`.
- Missing, used, or expired session returns HTTP `400` and asks the user to send `/auth_x` again.

## Agent Change Guidance

- Keep webhook path, Telegram router redirect URI, and X app callback URL aligned.
- Do not print or duplicate X client secrets or returned tokens.
- If changing session fields, update both this workflow and the Telegram router's `Save Auth Session`.
- If changing token/account fields, inspect hide-replies token refresh behavior in the Telegram router.
