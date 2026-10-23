# Orders - Order Status Poll

One SMM order-status poller for all three products: X (`Order Info`), FB (`FB Order Info`)
and IG (`IG Orders`). It replaces three separately scheduled pollers with one webhook that
Postgres calls only when an order is actually due.

This doc covers **both** environments. They are structurally identical — same 15 nodes,
same wiring, same code and SQL — differing only in credentials, webhook path and Vault
secrets.

| | Staging | Production |
| --- | --- | --- |
| Name | `Orders - Order Status Poll (Staging)` | `Orders - Order Status Poll` |
| n8n ID | `iKtxEUBYy5ZFlbaB` (personal project) | `XPfhrrXEOcavSb94` (personal project of tarek ismail) |
| Published | `520dcf9f-299e-47f9-96f1-5c8dee800f2f` (2026-10-23) | `052b9807-9ed2-424f-b7fc-cae380923057` (2026-10-23) |
| Webhook | `POST /webhook/order-poll-staging` | `POST /webhook/order-poll` |
| Supabase project | `npytqidroqxgikaqofmq` | `jxnzdxyhoakpfmkbjdeq` |
| Postgres credential | `Supabase Staging Postgres` | `Supabase Account` |
| X Telegram | `Testing Telegram API` | `TrackedUsersManager` |
| FB Telegram | `FB Monitor Staging Telegram` | `FB Monitor Beta Telegram` |
| IG Telegram | `IG Monitor Telegram` | `Insta Monitor Telegram` (@InstaMonitorProductionBot) |
| Export | `workflows/staging/orders-order-status-poll-staging.json` | `workflows/active/orders-order-status-poll.json` |
| SDK source | `workflows/staging/orders-order-status-poll-staging.sdk.js` | `workflows/active/orders-order-status-poll.sdk.js` |
| pg_cron `order-status-polls` | **enabled** | **enabled** 2026-10-23 11:30 UTC |
| Vault `order_poll_secret` / `order_poll_webhook_url` | set | set 2026-10-23 (own secret, differs from staging) |
| Error workflow | none set | none set — see below |

| | |
| --- | --- |
| Migrations | `db/migrations/2026-10-23-order-poll-heartbeat.sql` (step A, the gate), `db/migrations/2026-10-23-order-poll-unified.sql` (step B, the shared functions and unified mode). Applied to both projects 2026-10-23. |
| Pinned tests | none yet |

**Production is live (2026-10-23 11:30 UTC).** The migrations are applied, the functions
exist with EXECUTE revoked from `anon`/`authenticated`, the workflow is published
(`versionId` = `activeVersionId`), both Vault secrets exist and the cron job is enabled; the
first scheduled tick (11:31:00) succeeded. These are the steps that were run, in the SQL
editor of `jxnzdxyhoakpfmkbjdeq` (the secret must differ from staging's), kept for a rebuild:

```sql
-- 1. shared secret (random, never printed)
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),
  'order_poll_secret', 'Shared secret for the order poller webhook, production');
-- 2. unified webhook URL
select vault.create_secret('https://tarek1207.app.n8n.cloud/webhook/order-poll',
  'order_poll_webhook_url', 'n8n webhook for Orders - Order Status Poll (production)');
-- 3. enable the gate
select cron.alter_job((select jobid from cron.job where jobname='order-status-polls'),
  active := true);
```

**Production error workflow is not set.** `XMonitor - Production Developer Error Alerts`
(`UmKr9JkZ3ec3GDH5`) rejected it because of that workflow's caller policy. To fix, allow
`XPfhrrXEOcavSb94` in `UmKr9JkZ3ec3GDH5`'s caller policy, then set it as the error workflow.

**Old production pollers.** `FB - Order Status Polling` (`c8JodUU51nV1gDYh`) and
`IG - Order Status Poll (Production)` (`TrR3x4Sh442boEMr`) are unpublished
(`activeVersionId` null); both last ran 2026-10-15 04:30 UTC and nobody recorded why.
`XMonitor - Order Status Polling` (`AqdNgOKRXG6J5zbj`) shows `active: false` in n8n's
listing (not MCP-readable; when it stopped is unknown). So production FB and IG orders have
**not been polled since 2026-10-15**, X orders not since that poller stopped, and all stay
unpolled until steps 1–3 are run (X longer — see
[X is deliberately not polled yet](#x-is-deliberately-not-polled-yet--key-safety)).
`X-Monitor-Advanced-Order-Polling` (`AmLbKMDPumbW6fsq`) is unchanged and still active,
8-hourly.

## Why this exists

n8n bills an execution when a trigger fires, whether or not there is work to do. The
order pollers ran on fixed schedules (X and FB every 30 minutes, IG every 15, in both
environments). Orders are rare, so almost every run found nothing due:

| Measure | Executions |
| --- | --- |
| FB staging + FB prod + IG staging pollers, 2026-10-01..15 | **~2,181**, all no-ops (~0.3 s each) |
| All six pollers armed (X/FB/IG x prod/staging) | ~11,500 / month |
| This design, idle day | **0** |
| This design, one order | one run per backoff step until it goes final |
| This design, several orders due at once, any products | **one** run (batch of up to 50) |

It is the same pattern as the moderation queue drain
([xmonitor-moderation-queue-drain-staging.md](./xmonitor-moderation-queue-drain-staging.md)):
pg_cron is the clock, pg_net makes the call, Vault holds the URL and the shared secret.

## Flow

```
Order Poll Webhook                 POST, from pg_cron only when due_order_polls() has rows
  → Verify Poll Secret             header vs Vault IN SQL; FAILS CLOSED
  → If Poll Authorized
      ├─ false → Reject Unauthorized Poll Call   (no-op, run ends)
      └─ true  ↓
  → Fetch Due Orders               select * from public.due_order_polls(50)
  → Check Provider Order Status    SMMWiz action=status, read-only; onError continue
  → Normalize Provider Status      per item; product-aware notice text (HTML-escaped)
  → Record Order Poll              public.record_order_poll(...) per item
  → If Final And Unnotified        is_final && !notified_at && telegram_chat_id
  → Route By Product               (credentials: staging / production)
      ├─ x  → Send X Notice        Testing Telegram API / TrackedUsersManager
      ├─ fb → Send FB Notice       FB Monitor Staging Telegram / FB Monitor Beta Telegram
      └─ ig → Send IG Notice       IG Monitor Telegram / Insta Monitor Telegram
                (all three: onError continueRegularOutput, parse_mode HTML)
  → If Notification Sent           !$json.error
  → Mark Order Notification Sent   public.mark_order_notified(product, id)
```

The workflow never names a table. All table-specific SQL lives in three Postgres
functions, so adding a product is a migration, not a workflow edit.

## The gate: `public.trigger_order_polls()`

pg_cron job `order-status-polls` runs `select public.trigger_order_polls()` every minute.
**Enabled on staging** (checked 2026-10-23: `active = true`, schedule `* * * * *`);
**enabled on production** since 2026-10-23 11:30 UTC (first tick 11:31:00 succeeded). Each tick:

1. **48-hour stop.** Any `pending` / `in_progress` order placed more than 48 hours ago gets
   `next_check_at = 'infinity'` and `last_error = 'Polling stopped: still not final 48
   hours after placement.'`. Giving up costs no n8n run. The first tick on staging retired
   two stale June X test orders (`30051512`, `30051764`) that had never been polled. On
   production the first enabled tick will likewise retire any order still open after 48 h —
   on 2026-10-23 there were none.
2. **Count due rows** with `public.due_order_polls(1000)` — the same function the
   workflow's `Fetch Due Orders` calls, provider-key join included, so "due" at the gate
   and "fetched" in n8n cannot disagree. Nothing due → `idle`, no HTTP call.
3. **Secret present?** No Vault `order_poll_secret` → `unconfigured`, no call.
4. **Mode, picked by Vault:**
   - **Unified** — Vault `order_poll_webhook_url` exists (staging: set, pointing at
     `/webhook/order-poll-staging`; production: not yet, will point at `/webhook/order-poll`). One throttle key `order_poll` in `Run State`; at most
     one call per 9 min 50 s; body `{"due": {"fb": 1, "ig": 1}, "fired_at": ...}`.
   - **Per-product** (fallback, step A) — no unified URL. Each product with due rows is
     called at its own `order_poll_webhook_url_<x|fb|ig>` with its own throttle key
     `order_poll_<product>`. On staging `_fb` and `_ig` are set, `_x` is not.
     On production no `order_poll*` secret exists at all (checked 2026-10-23), so
     per-product mode would call nothing.
5. Calls go out with header `X-Order-Poll-Secret: <Vault order_poll_secret>`.

`Run State` is stamped **before** the call: pg_net is fire-and-forget, and a lost request
only means the rows are still due on the next allowed tick.

`cron.job_run_details.return_message` shows only `1 row` (pg_cron reports the SELECT's
row count, not the function's text result), so the gate's verdict is not visible there.
To see what a tick would decide, read `due_order_polls()` counts and `Run State` rather
than calling `trigger_order_polls()` by hand — calling it can fire the webhook.

### Verify Poll Secret

Same design as `Verify Drain Secret`: the header is compared against
`vault.decrypted_secrets` **in SQL** and only a boolean comes back, so the secret never
enters n8n execution data. Missing, empty or wrong header, or a missing Vault row, all
give `authorized = false`. `responseMode: onReceived` means every caller gets HTTP 200
before the workflow runs — judge authorization from the execution, not the status code.

## The functions

All three are in `public` (which PostgREST exposes), so EXECUTE is **revoked from
`public`, `anon` and `authenticated`**. n8n connects as `postgres` and is unaffected.
This matters most for `due_order_polls()`, which returns `api_key`.

| Function | Does |
| --- | --- |
| `due_order_polls(p_limit int default 50)` | Due rows (`pending`/`in_progress`, `provider_order_id` set, `next_check_at` null or past) from all three tables in one shape: `product, id, provider_order_id, order_type, post_ref, page_name, quantity, telegram_chat_id, previous_normalized_status, next_check_at, api_url, api_key`. Provider config is INNER JOINed from `FB SMM Settings` (active, key present). Ordered by `next_check_at` nulls first. |
| `record_order_poll(product, id, provider_status, normalized_status, status_response, charge, start_count, remains, currency, last_error)` | Writes one result to the right table. `charge`/`start_count`/`remains`/`currency` are `COALESCE`d (a provider NULL never erases a recorded figure); `provider_status`, `normalized_status`, `last_error` always overwritten; `status_response` written except for IG (no column). Backoff by `poll_attempts` already made: **+15m, +30m, +1h, +2h, then every 4h**. Once final, `next_check_at` is frozen and `completed_at` stamped (first time only). **X only:** also sets `Posts.status` to `Processing` / `Done` / `Order Failed`. FB Posts and IG Media are never touched. Returns `product, id, provider_order_id, normalized_status, telegram_chat_id, notified_at`. |
| `mark_order_notified(product, id)` | `UPDATE ... SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING notified_at`. |

Status mapping (in `Normalize Provider Status`) is unchanged from the per-product pollers:
`complete` → completed, `partial` → partial, `cancel`/`refund` → canceled,
`fail`/`reject`/`error` (or any provider error) → failed, `progress`/`process` →
in_progress, otherwise pending. Final = completed, partial, canceled, failed.

## X is deliberately not polled yet — key safety

A status call only works with the API key of the account that placed the order. FB and IG
share the SMMWiz account in `FB SMM Settings` row `provider = 'smmwiz'`. The X routers
place orders with their **own inline SMMWiz key**. The user confirmed on 2026-10-23 that it
is the same account.

X rows still join a separate row, `provider = 'smmwiz_x'`, so X can be pointed at a
different account later without touching a workflow. That row was added 2026-10-23 in both
projects (id 2): `api_url`/`api_key` copied in SQL from `smmwiz`, never printed, service ids
NULL so no order path can use it. The IG router reads `WHERE is_active ORDER BY id LIMIT 1`
and still picks `smmwiz` (id 1). Deleting or deactivating `smmwiz_x` switches X polling
off: `due_order_polls()` then returns no X rows. Never point it at a different account's
key without checking, or every X order would answer `Incorrect order ID` and be announced
as failed.

## Notify exactly once

- `If Final And Unnotified` only passes items that are final, have no `notified_at`, and
  have a `telegram_chat_id`.
- Each product's notice goes through **that product's own bot**, so a user only ever hears
  from the bot they ordered through.
- The Telegram nodes are `onError: continueRegularOutput`; `If Notification Sent` checks
  `!$json.error`, so `notified_at` is stamped **only after a successful send**. A failed
  send leaves the row unnotified (but already final, so it is not re-polled — the notice
  is not retried automatically).
- `mark_order_notified` stamps with `AND notified_at IS NULL`, so two racing runs cannot
  both stamp.
- `Normalize Provider Status` runs **once per item** and returns one object. In all-items
  mode `$itemIndex` is always 0 and only the first due order is processed — the defect FB
  staging execution `42654` showed, and the one the old X staging poller still has.
- The provider `api_key` is not carried past `Normalize Provider Status`, so it never
  reaches the Record/notify nodes' execution data. It is still visible in
  `Fetch Due Orders` and `Check Provider Order Status` output.

## Test evidence — 2026-10-23

Staging:

| Check | Result |
| --- | --- |
| Live execution **`51756`** (pg_cron → webhook) | One run handled FB order `30820544` **and** IG order `31247568` together; both final; two notices sent, one per product bot; both rows stamped `notified_at`. |
| Non-final path, verified directly in SQL via `record_order_poll` | attempt 2 → `next_check_at` +60 min; recorded `charge` preserved when the provider omitted it. |
| Cleanup | Test rows restored afterwards. |
| 48 h stop | Retired staging X orders `30051512`, `30051764` on the first enabled tick. |

| Staging execution **`51866`** | X branch: June order `30051512` (placed with the X router's own key) polled with the shared key → `Completed`, charge 0.0387, notice on @XmonitorBetaBot, stamped. Proves the same-account claim. The staging post has no `Posts` row, so the `Posts.status` mirror was a no-op. |

Not yet exercised: the `Posts.status` mirror against a real row, a failed Telegram send,
the unauthorized-call path against the live webhook, per-product fallback mode with this
version of the gate.

Production:

| Check | Result |
| --- | --- |
| Pinned test execution **`51763`** | Wrong secret → `If Poll Authorized` false → `Reject Unauthorized Poll Call`; nothing fetched or sent. |
| Manual gate call | `trigger_order_polls()` returned `idle` (no open production orders). |
| Signed webhook execution **`51864`** | One `net.http_post` signed from Vault, nothing due: `Verify Poll Secret` authorized → `Fetch Due Orders` returned 0 rows → stop. Proves the production secret, URL and Postgres credential end to end with no order touched and nothing sent. |
| Scheduled tick | `order-status-polls` 11:31:00 `succeeded`. |

Still unproven in production: a real order going final (notice on each production bot). Inspect
the first fire that carries a due order.

## Agent change guidance

- **Change table logic in the functions, not the workflow.** Any change to what counts as
  due must go into `due_order_polls()`, because the gate counts with it too.
- Change staging first, then promote to production keeping production credentials, the
  `order-poll` path and the production bots; re-export both and confirm `versionId` =
  `activeVersionId` on each.
- Keep the status mapping aligned with the routers' order creation.
- Do not change or remove the `smmwiz_x` row, change `FB SMM Settings`, create or change production
  Vault secrets, or enable/disable the production cron job without explicit approval.
- Do not republish the old production pollers (`c8JodUU51nV1gDYh`, `TrR3x4Sh442boEMr`,
  `AqdNgOKRXG6J5zbj`) alongside this one: two pollers on the same rows can double-notify.
- Do not remove `responseFormat: json` on `Check Provider Order Status` or
  `unwrapProviderBody()` — SMMWiz returns JSON under `Content-Type: text/html`.
- Live runs call SMMWiz (status only — read, never an order) and send Telegram messages on
  three bots per environment; production runs message real users. Snapshot the order rows before forcing anything due.
- Never print the Vault secret or `api_key`; describe them as present or missing.

## Rollback and kill switch

**Rollback to per-product mode** (step A): delete the Vault secret
`order_poll_webhook_url`. The gate then calls `order_poll_webhook_url_fb` / `_ig` (and
`_x` if ever set), i.e. the products' own pollers, and this workflow stops being called.

On production there are no per-product URLs, so this stops polling instead.

```sql
-- staging only
DELETE FROM vault.secrets WHERE name = 'order_poll_webhook_url';
```

**Kill switch** (stops all order polling dispatch; orders stay intact):

```sql
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'order-status-polls'), active := false);
```

Unpublishing this workflow alone is not a clean stop: the gate keeps firing every
10 minutes while orders are due and each call 404s.

## Related

- [xmonitor-order-status-polling-staging.md](./xmonitor-order-status-polling-staging.md) —
  the old X staging poller, superseded by this workflow.
- [xmonitor-order-status-polling.md](./xmonitor-order-status-polling.md) — old production
  X poller, superseded by this workflow (shows `active: false`).
- `orders-order-status-poll-staging.md` — former name of this doc, kept as a pointer.
- Production `X-Monitor-Advanced-Order-Polling` (`AmLbKMDPumbW6fsq`, 8-hourly) is **not**
  covered: it also updates `Advanced Mentions`, and `Advanced Order Info` exists only in
  production.
