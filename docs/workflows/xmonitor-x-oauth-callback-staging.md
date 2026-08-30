# XMonitor - X OAuth Callback Staging

## Purpose

Staging webhook workflow that completes the X OAuth PKCE flow started by the staging Telegram
router. It mirrors [XMonitor - X OAuth Callback](./xmonitor-x-oauth-callback.md): same node
graph, same validation, same error responses — plus the T5 client stamp, which staging has and
production does not.

## Identity

- n8n ID: `gji3bQd2LdodwEJR`
- Environment: staging
- Active: yes
- Local export: `workflows/staging/xmonitor-x-oauth-callback-staging.json`
- Node count: `17`
- Last observed live update: `2026-08-30T07:47Z` (T5, published `774ebf62-14ca-4118-a3b9-0bf423fec471`)
- Webhook path: `/webhook/x-oauth-callback-staging`
- HTTP method: `GET`

Credentials: `Supabase Staging API` (`Get Auth Session`), `Supabase Staging Postgres`
(`Upsert X Auth Account`, `Stamp Auth Account Client`, `Mark Auth Session Used`),
`Testing Telegram API` (`Send Telegram Success`).

## Relation To Production

Identical apart from webhook path, credentials, redirect URI — and one node. **`Stamp Auth
Account Client` exists only here.** Production has neither that node nor the
`"X Auth Sessions".client_id` column it depends on, because every production write in the
session that built T5 was refused by the permission classifier. See
`docs/architecture/multi-tenant-and-web-ui.md` §12e.

## The Client Stamp (Phase T5)

`X Auth Accounts.client_id` has existed since T1 and nothing populated it. T5 carries the
client from the session onto the account:

```
Validate Auth Session      passes session.client_id through
  -> Prepare Account Row   carries it onto the account payload
  -> Upsert X Auth Account writes the account exactly as before  <- unchanged
  -> Stamp Auth Account Client   T5: sets X Auth Accounts.client_id
  -> Mark Auth Session Used
```

**Why a separate node rather than a column on `Upsert X Auth Account`.** This is a live
external flow, and a failure here would only surface the next time somebody ran `/auth_x` —
meaning clients could not connect X accounts at all. Adding `client_id` to that upsert's
column mapping risks a null or empty uuid cast breaking the insert. `Stamp Auth Account
Client` instead runs *after* the account row is safely written, is a no-op when no client
resolved (`where … and nullif($1,'') is not null`), and carries
`onError: continueRegularOutput` so it can never break an authorization.

The client is resolved upstream in the router (`Resolve Auth Client`) and stored on
`X Auth Sessions.client_id`. Resolution is best-effort and never refuses: a chat with no
client authorizes exactly as before, leaving `client_id` null — which is why T1 left the
column nullable.

`Mark Auth Session Used` deliberately does **not** list `client_id` among its columns. It is
an upsert matching on `state`, and its `DO UPDATE` only sets the listed columns, so the
client already on the row is preserved.

## Main Flow

Steps 1–8 and 10–12 are identical to production. Step 9 gains the stamp:

1. `OAuth Callback Webhook` receives X's redirect with `code` and `state`, or an OAuth error.
2. `Parse Callback` rejects provider errors and missing `code` or `state`.
3. `Get Auth Session` fetches the `X Auth Sessions` row for the callback state.
4. `Validate Auth Session` rejects missing, expired, or already used sessions; passes
   `client_id` through.
5. `Prepare Token Request` prepares Basic auth and redirect URI.
6. `Exchange Code For Tokens` posts the code and PKCE verifier to X.
7. `Get Authenticated X User` calls X `/2/users/me`.
8. `Prepare Account Row` builds the persistent token/account row, including `client_id`.
9. `Upsert X Auth Account` stores tokens; **`Stamp Auth Account Client`** then records the
   owning client.
10. `Mark Auth Session Used` marks the PKCE state as used.
11. `Send Telegram Success` tells the user their X account connected.
12. `Respond Success` tells the browser the flow is complete.

## Data Stores

| Table | Use |
| --- | --- |
| `X Auth Sessions` | Reads `state`, `code_verifier`, `telegram_chat_id`, `client_id`, `expires_at`, `used`; marks the state used after success. |
| `X Auth Accounts` | Stores `telegram_chat_id`, `x_user_id`, `x_username`, access/refresh tokens, expiry, scope, update time, and `client_id`. |

Both Supabase projects are shared with the sibling FB Monitor project, so every table is
named explicitly.

## Testing

Staging execution `19267` exercised the full chain with `Exchange Code For Tokens`,
`Get Authenticated X User` and `Send Telegram Success` pinned — no real grant, no real X call,
no Telegram message — while the database writes ran live. `Stamp Auth Account Client` returned
`client_id c2698b52-…` and the account row carried the correct client. The row and its session
were removed afterwards.

**Never run a real authorization against a production X account without asking.** A pinned run
proves the wiring; it does not prove the token exchange, which cannot be exercised without a
real grant.

## Agent Change Guidance

- Keep webhook path, Telegram router redirect URI, and X app callback URL aligned.
- Do not print or duplicate X client secrets or returned tokens.
- If changing session fields, update both this workflow and the router's `Save Auth Session`.
- If changing token/account fields, inspect hide-replies token refresh in the Telegram router.
- Do not fold `Stamp Auth Account Client` back into `Upsert X Auth Account` — see above.
