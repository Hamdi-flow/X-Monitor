# XMonitor Task Todo List

Use this file for planned XMonitor work that needs design notes, complexity
estimates, and validation steps before implementation.

## Task Intake Rule

Only add a new task to this todo list when the user explicitly asks for it to be
added. For ordinary requests, analyze and execute the work in the conversation
without creating a todo entry.

When the user explicitly asks to add a task, capture the task design, estimated
complexity, validation plan, open questions for the user, and any risky approval
points. Keep active items under `Open Tasks`, and move finished items to
`Completed Tasks` only after the change has been moved to the production
workflows. Staging validation alone is not enough for completion; keep those
items open and record the staging validation details in `Notes`.

## Complexity Scale

- `S`: documentation-only or narrowly scoped change.
- `M`: local workflow or test change with limited external coordination.
- `L`: live workflow, credential, database, or Git-history work with higher risk.

## Task Template

### Task title

- Status: done
- Priority: low | medium | high | critical
- Complexity: `S` | `M` | `L`
- Source: issue, request, doc, workflow, or date

Design:

1. Describe the intended implementation approach.
2. List the main files, workflows, tables, or systems involved.
3. Note approval points or risky side effects.

Validation:

- List the tests, pinned workflow runs, live checks, or document reviews needed.
- Note any cleanup or rollback checks.

Open Questions:

- List questions for the user that must be resolved before safe execution.
- Write `None` when the task can proceed without clarification.

Notes:

- Capture constraints, follow-up ideas, or things not to forget.

## Open Tasks

### Move the SMMWiz API key out of workflow parameters and rotate it

- Status: in progress (staging router done 2026-10-03; production and polling pending)
- Priority: high
- Complexity: `M`
- Source: n8n MCP validator `SET_CREDENTIAL_FIELD`, 2026-10-03

Design:

1. Staging router `oLwwjO05IcRjtF8E`, **done**: removed `apiKey` from `Set Comment Service Config`,
   `Set Likes Service Config`, `Prepare Comment Order Request`, `Prepare Likes Order Request`.
   Removed the `key` body param from `Place Comment Order` / `Place Likes Order`. Both now use
   `genericCredentialType` / `httpTemplatedCustomAuth`. Published as `66db1fd5-…`.
2. User: create the credential in the n8n UI (template `{"body":{"key":"{{api_key}}"}}`, key in
   the secret field, name e.g. `SMMWiz API (Staging)`) and bind it to both order nodes. Use the
   **rotated** key, not the leaked one.
3. Prove injection without touching SMMWiz: a temporary inactive workflow whose HTTP Request node
   uses the same credential and content type, posting to a temporary in-instance webhook that
   returns only `has_key` and `key_length`. Delete both afterwards.
4. Production router `cWczsttyDbTBbRAC`: same six-node change, bound to a production
   credential. Needs explicit approval.
5. Order status polling (staging `Attach SMM Status Config` + `Check Provider Order Status`,
   and production): the same key, same pattern. Not in the original scope.
6. Rotate the key in the SMMWiz panel. It is in git history (3 commits) and in stored
   execution data of every order and pinned run on both routers (e.g. staging 41002–41007).

Validation:

- Pinned order fixtures (6) on staging: 41008–41013 all pass, and no `apiKey` in item data.
- `tests/n8n/telegram-router-retry-guard.test.mjs`: 4/4 pass after the change.
- Injection proof (step 3) before the first live staging order.

Open Questions:

- Rotate first, or promote first? Recommendation: create the credentials with the new key,
  promote, then revoke the old key, so production never runs on a revoked key.
- Rewrite git history (`git filter-repo`) or rely on rotation? Recommendation: rotation alone,
  since a rewrite does not reach existing clones or n8n execution data.

Notes:

- The local exports for the prod router and both polling workflows now carry
  `REDACTED_SMM_API_KEY_MOVE_TO_N8N_CREDENTIAL` in place of the value, so they intentionally
  differ from live in that one field. Do not re-import them as-is.
- Until a staging credential is bound, live staging orders fail at the order node, closed and
  with no charge.
- 2026-10-23: on staging, step 5 is overtaken for FB and IG — the unified poller
  `iKtxEUBYy5ZFlbaB` reads the key from `FB SMM Settings` via `due_order_polls()`, not from a
  workflow parameter. X will follow the same path once a `smmwiz_x` row exists (see *Order
  status polling: pg_cron gate and unified poller*). The old X staging poller
  `ceX1EiVN3bFWARMu` still has the inline key but is superseded.
- 2026-10-23: production follows the same path — `XPfhrrXEOcavSb94` reads the key from
  production `FB SMM Settings` (`smmwiz`, active, key present) once Vault/cron are set; the
  old production X poller `AqdNgOKRXG6J5zbj` with its inline key is superseded and inactive.

### Order status polling: pg_cron gate and unified poller

- Status: open — staging live and validated 2026-10-23; production code/DB/workflow done
  2026-10-23 and LIVE since 11:30 UTC (Vault set, cron enabled); `smmwiz_x` still open
- Priority: medium
- Complexity: `L`
- Source: n8n execution-billing review, 2026-10-23

Design:

1. **Staging, done 2026-10-23.** `db/migrations/2026-10-23-order-poll-heartbeat.sql` (step A)
   and `db/migrations/2026-10-23-order-poll-unified.sql` (step B) applied to
   `npytqidroqxgikaqofmq`. pg_cron job `order-status-polls` (every minute, **enabled**) runs
   `public.trigger_order_polls()`: 48 h stop, counts `due_order_polls()`, calls n8n at most
   once per 10 minutes, unified mode because Vault `order_poll_webhook_url` is set. New
   workflow `Orders - Order Status Poll (Staging)` `iKtxEUBYy5ZFlbaB`, published
   `520dcf9f-299e-47f9-96f1-5c8dee800f2f`. Doc (both environments):
   `docs/workflows/orders-order-status-poll.md`.
2. **Production rollout — done 2026-10-23.**
   - [x] Migrations `order_poll_heartbeat` and `order_poll_unified` applied to
     `jxnzdxyhoakpfmkbjdeq`; functions exist, EXECUTE revoked from `anon`/`authenticated`.
   - [x] pg_cron job `order-status-polls` created, then **enabled** 2026-10-23 11:30 UTC; first
     tick 11:31:00 succeeded.
   - [x] Workflow `Orders - Order Status Poll` `XPfhrrXEOcavSb94` created and published
     (`versionId` = `activeVersionId` = `052b9807-9ed2-424f-b7fc-cae380923057`), webhook
     `/webhook/order-poll`, production credentials (`Supabase Account`, `TrackedUsersManager`,
     `FB Monitor Beta Telegram`, `Insta Monitor Telegram`). Export
     `workflows/active/orders-order-status-poll.json`.
   - [x] Vault `order_poll_secret` and `order_poll_webhook_url` created 2026-10-23 (on the
     user's go-ahead). Signed webhook check, execution `51864`: authorized, 0 due, stopped.
   - [ ] Error workflow: `UmKr9JkZ3ec3GDH5` rejected `XPfhrrXEOcavSb94` (caller policy). Allow
     it there, then set it as the error workflow.
   - [ ] Inspect the first production fire that carries a real due order end to end.
   - Old production pollers are already off: FB `c8JodUU51nV1gDYh` and IG `TrR3x4Sh442boEMr`
     unpublished (`activeVersionId` null), last ran 2026-10-15 04:30 UTC, reason unrecorded;
     X `AqdNgOKRXG6J5zbj` shows `active: false`. So production orders are unpolled until the
     Vault/cron step. Do not republish them alongside the unified poller.

   Original plan, for reference: apply both migrations to
   `jxnzdxyhoakpfmkbjdeq`, create the production Vault secrets (`order_poll_secret`, a
   *different* value from staging; `order_poll_webhook_url`), create and publish a production
   copy of the unified poller with production credentials and bots, then enable the cron job.
   Retire the production schedules only after the first production fire is verified:
   `XMonitor - Order Status Polling` `AqdNgOKRXG6J5zbj` plus the FB and IG production pollers.
   Order: workflow published → Vault set → cron enabled → schedules switched off.
3. **`smmwiz_x` key decision.** X orders are not polled by the unified poller until an active
   `FB SMM Settings` row `provider = 'smmwiz_x'` exists. The X routers place orders with
   their own inline SMMWiz key; whether that is the same account as `smmwiz` is unconfirmed.
   Same on production (checked 2026-10-23: only `smmwiz`, active). With the old X poller
   inactive, production X orders have **no** poller until this is settled.
4. **Fold in X-Monitor-Advanced.** `X-Monitor-Advanced-Order-Polling` `AmLbKMDPumbW6fsq`
   (production, 8-hourly, ~90 runs/month, still active) is not covered: it also updates
   `Advanced Mentions`, and `Advanced Order Info` exists only in production. Needs a branch in
   `due_order_polls()` / `record_order_poll()` that also writes `Advanced Mentions`.
5. **X staging poller defects are moot once unified.** `ceX1EiVN3bFWARMu` has an unpublished
   draft (webhook `order-poll-x-staging` + secret gate + backoff) and still: processes only the
   first due order (all-items Normalize mode), stamps `notified_at` even when the send fails,
   and carries the inline SMM key. Do not fix; retire it (or keep inactive as reference) when
   X moves to the unified poller. Production `AqdNgOKRXG6J5zbj` shares the same Normalize-mode
   and notify defects and is replaced by step 2 rather than patched.

Validation:

- Staging, done: execution `51756` polled FB order `30820544` and IG order `31247568` in one
  run, sent two notices on their own bots, stamped both `notified_at`. Non-final path verified
  in SQL (attempt 2 → +60 min, charge preserved). Test rows restored.
- Production, done: pinned test execution `51763` — wrong secret stops at
  `Reject Unauthorized Poll Call`. No live production execution yet (no open production
  orders, 0 due, gate disabled).
- Still to check: an idle-day check that the cron job makes zero HTTP calls.
- Production: first fired run inspected end to end; compare monthly execution counts against
  the ~2,181 no-op runs per half-month measured 2026-10-01..15.
- Pinned fixtures in `tests/n8n/order-status-polling-pins/` pin `Every 30 Minutes`, which the
  X staging draft no longer has; new fixtures are needed for the unified poller.

Open Questions:

- Is the X routers' inline SMMWiz key the same account as `FB SMM Settings` `smmwiz`?
  Options: (a) same account → add `smmwiz_x` with the same key (or point X at `smmwiz`);
  (b) different account → add `smmwiz_x` with the X key; (c) leave X on its own poller.
  Recommendation: confirm in the SMMWiz panel which account placed a known X order, then (a)
  or (b). Pair it with the key rotation in the SMMWiz task above so the rotated key is the one
  stored.
- ~~Approve the production rollout (step 2)?~~ Approved and done 2026-10-23 except the
  Vault/cron step and the error-workflow caller policy.
- Why were the FB and IG production pollers unpublished on/after 2026-10-15? Not recorded.

Notes:

- Rollback to per-product mode: delete Vault `order_poll_webhook_url`. Kill switch:
  `cron.alter_job(<order-status-polls jobid>, active := false)`.
- `cron.job_run_details.return_message` shows only `1 row`, not the function's verdict.
- The 48 h stop retired two stale June staging X test orders (`30051512`, `30051764`).

### Hide replies by percentage — live in staging and production; production evidence not recorded

- Status: open. Staging was published at 08:17 UTC on 2026-10-03, and **production was promoted
  at 10:08 UTC the same day** (`92d6b099`, tarek ismail via MCP), a fact confirmed from live n8n
  on 2026-10-16. Close it once the production run evidence below is recorded.
- Priority: medium
- Complexity: `M`
- Source: user request 2026-10-03

Design:

1. The alert button `hide_replies:<id>`, `/hide POST_ID` and `/hide_replies POST_ID` open a menu with 25% / 50% / 75% / 100% / Custom %. Choices arrive as `hide_pct:<id>:<pct|custom>`; Custom opens a send-and-wait number form. `/hide POST_ID PERCENT` and `/hide_replies POST_ID PERCENT` apply directly.
2. The percentage is a **target share of stored `Negative` replies**. Already-hidden negatives count toward it, and the rest are picked oldest first by snowflake reply ID. `target = ceil(negatives × pct / 100)`.
3. This also fixes a pre-existing bug: the hide branch queued every stored reply for the post, including Neutral, Positive and unanalyzed ones.
4. Also fixed while in the switch: its fallback output was unwired (Default Help sat on `LIST_CLIENTS`), so unknown commands got no reply.
5. Workflow: staging router `oLwwjO05IcRjtF8E`. Doc: `docs/workflows/xmonitor-telegram-router-staging.md` § "Hide Replies By Percentage".

Validation:

- [x] Local logic checks for the parser, validator, queue builder and summary.
- [x] Pinned staging runs on the draft: `40971` menu, `40972` 50% with oldest-first ordering, `40973` invalid 150%, `40974` unknown command → Default Help, `40975` custom 34% form, `40976` 100% mixed sentiments, `40977` all hidden, `40978`–`40980` tenancy (cross-tenant refused, same-tenant and staff authorized). No live X, Supabase or Telegram writes.
- [x] Published: `versionId` = `activeVersionId` = `d4b403b4-c7b7-40e2-8273-72bfcb301fc6`.
- [x] Staging bot command menu updated (`@XmonitorBetaBot`, default and `all_private_chats` scopes).
- [ ] Optional live staging check: press Hide on a real staging alert and pick a percentage. This only writes `Moderation Queue` rows, but the active staging drain will then hide those replies on X, which needs explicit approval.
- [x] Production promotion of router `cWczsttyDbTBbRAC`: published 2026-10-03 10:08 UTC as
  `92d6b099-f1f1-40e1-b80d-f7f6636c586e` (`versionId` = `activeVersionId`, re-read
  2026-10-16). The version note says it was promoted from staging `d4b403b4` without the
  staging SMM credential change, and that Telegram nodes use `TrackedUsersManager`. The export
  was re-synced on 2026-10-16.
- [x] Production command menu: `@trackedUsersManagerBot` shows
  `/hide_replies` = "Hide a percentage of negative replies. Usage: /hide_replies POST_ID [PERCENT]"
  in both the default and `all_private_chats` scopes (read with `getMyCommands`, 2026-10-16).
- [ ] Production run evidence. Seven manual executions, `41065`–`41071`, ran between 10:09 and
  10:10 UTC right after the publish, and all succeeded. They look like the pinned production
  runs, but which fixtures they used, and whether every side-effect node was pinned, was not
  written down. Record that from the executions, or re-run the hide fixtures against
  production, before moving this task to Completed.

Open Questions (resolved 2026-10-16 from live n8n):

- ~~Production router has an unpublished draft (`adf487cc…`) that differs from its published
  version (`a645e560…`) in five nodes~~ — overtaken by the promotion. Neither id appears in
  the router's n8n history any more. n8n's diff `9c8b0bae` → `92d6b099` shows the promotion
  shipped the rest of staging's graph along with the hide nodes. That covers the post-status
  rework (`Prepare Post Status Change`, `Update Post Status` as a Postgres query,
  `If Status Origin Is Callback`, `If Edit Resume Button`, both `Edit Status Alert` nodes),
  `Clear Telegram User Links` (`filterType` dropped) and `Resolve Caller Authorization`
  (`onError` default). `Route Client Admin Intent` did not change in that publish.

Notes:

- Lowering the percentage does not cancel rows queued by an earlier, higher request that is still draining.
- The n8n command-menu utility `Rwsu0hUtYA0Ithpl` still carries the old `/hide_replies` description; only `scripts/set-telegram-bot-commands.ps1` was updated and run.

### Fix the scheduler alert chain: only the first recipient is alerted, and lookups fan out per reply

- Status: open — found 2026-08-29 during live staging verification, not yet fixed
- Complexity: S to change, M to validate (the two halves must ship together)
- Environments: staging and production, identical in both

Two distinct defects in the same stretch of graph, discovered together. They are independent
faults but the fix is coupled, so they belong in one change.

#### Defect 1 — only the first Telegram recipient ever receives an alert (correctness, latent)

`Build Negative Alert Notification` carries `executeOnce: true`. n8n truncates that node's
input to the first item, so `$input.all()` returns exactly one recipient no matter how many
arrive. The node's own code is written to fan out —
`return telegramUsers.flatMap(user => posts.map(...))` — and that fan-out is dead code today.

**Measured, staging execution `18789`:** the `ratio-from-stored-rows` fixture with
`Get Telegram Users` pinned to two recipients and the send node still pinned.
`Get Telegram Users` emitted 2 items; `Build Negative Alert Notification` emitted **1**, for
chat `1111111111` only. Chat `2222222222` was silently dropped. A clean 2-item input, so this
is not a side effect of defect 2.

**Latent only because each environment has exactly one recipient row** — production
`Telegram Users` holds one (`8372903693`), staging one (`8677383067`). With one recipient,
truncating to the first is indistinguishable from correct. The day a second recipient is
added, they silently receive nothing. Same failure shape as the sentiment regression: armed,
invisible, waiting on a precondition.

#### Defect 2 — per-item fan-out of two input-independent lookups (cost and latency)

`Insert or update replies` emits one item per reply. Two downstream nodes then execute once
per input item even though neither reads its own input:

| Node | Cost per alerting run |
| --- | --- |
| `Get Reply Status Counts` (Postgres) | one identical query per reply |
| `Get Telegram Users` (Supabase) | one identical API call per reply |

**Measured, staging execution `18761`:** 106 replies produced **106 identical Postgres queries
and 106 identical Supabase calls** for a single alert — 212 redundant round trips. It scales
with reply volume, not post volume: a 500-reply post fires 500 of each.

`Get Reply Status Counts` takes its post ids from `$('Split Out Reply Analysis').all()`, not
from its input. `Get Telegram Users` is an unfiltered `getAll`. Both are already
input-independent.

#### The fix is a matched pair — do not ship half

1. `executeOnce: true` on `Get Reply Status Counts` and `Get Telegram Users`. Each then runs
   once; `Get Telegram Users` emits its full recipient set once instead of N copies per reply.
2. **Remove** `executeOnce` from `Build Negative Alert Notification` so its `flatMap` finally
   sees every recipient.

**Order matters and the halves are not independently safe.** Removing `executeOnce` from
`Build` while the upstream fan-out is still present would send one message per reply — 106
duplicate Telegram alerts in the `18761` shape. Conversely, doing only step 1 leaves defect 1
untouched, because `Build` would still truncate to its first item. This is precisely the
half-a-change hazard that lost the sentiment mapping on 2026-08-25.

Open question before touching production: `Get Telegram Users` has `alwaysOutputData: true`,
which exists so the zero-recipient case still emits an item and `Build` can raise
`NO_TELEGRAM_RECIPIENTS`. Confirm `executeOnce` composes with it and that the empty-recipient
branch still fires.

Validation:
- Re-run the two-recipient probe (fixture with `Get Telegram Users` pinned to two rows, send
  node pinned) and assert `Build Negative Alert Notification` emits **2** items, one per chat.
- Re-run `tests/n8n/reply-sentiment-live-staging.test.mjs` and assert `Get Reply Status Counts`
  emits one item rather than one per reply, and that exactly one message goes to each real
  recipient.
- Re-run the six non-watermark pinned fixtures, then promote and re-verify in production.

### Durable hide-replies moderation queue and scheduled drain

- Status: done — promoted to production 2026-08-27; both environments live and validated
- Priority: high
- Complexity: `L`
- Source: request 2026-08-26, `docs/architecture/limits-and-capacity.md` §2.2, defect G in `docs/architecture/multi-tenant-and-web-ui.md`

Design:

X caps `PUT /2/tweets/:id/hidden` at 50 per 15 minutes **per access token**. The router used
to hide inline and cache that limit in n8n workflow static data — per-workflow state for a
per-token limit, invisible to any second entry point, and when quota ran out it hid what it
could, silently dropped the rest, and told the user to retry by hand.

Replaced with enqueue-plus-drain:

1. `db/migrations/2026-08-26-moderation-queue.sql` adds `Moderation Queue` (with the
   `(x_user_id, not_before) WHERE status='queued'` due index) and `X Rate Limits`.
   Single-tenant adaptation: `action_id` and `client_id` keep the §2.2 names and types but
   are nullable with no FK, because `Action Log` and `Clients` do not exist yet. The
   migration header carries the exact follow-up ALTER.
2. Staging router `oLwwjO05IcRjtF8E`: `Build Reply Hide Items` → `Build Hide Queue Items`,
   which enqueues every non-hidden candidate under one `batch_id`; new `Enqueue Hide
   Requests`, `Build Hide Queued Summary`, `Send Hide Queued Summary`, `Store Queue Message
   Id`. Seven inline-hide nodes removed along with the static-data precheck.
3. New staging workflow `xt8fLOmRvDvTdZT9` drains the queue: claims per `x_user_id`
   within the allowance from `X Rate Limits`, hides, writes headers back, defers on 429 or
   exhausted quota, fails permanent errors immediately, abandons at `attempts >= 5`, and
   edits the router's Telegram message with live progress.
4. **Trigger changed 2026-08-27 for cost.** It was a 5-minute Schedule Trigger. n8n bills per
   trigger firing, so that was ~8,640 executions/month spent almost entirely on discovering an
   empty queue — and the cadence bought no throughput, because X's 50-per-15-minute limit
   makes two of every three passes no-ops by design. Replaced with a secret-guarded webhook
   driven by `pg_cron` + `pg_net` inside Supabase
   (`db/migrations/2026-08-27-moderation-drain-cron.sql`), which polls for free and only calls
   n8n when rows are actually due. Pickup latency also improved from 5 minutes to 1.

Validation:

- [x] `node tests/n8n/moderation-queue-drain.test.mjs` — five pinned scenarios, X never called.
- [x] `pg_cron` + `pg_net` proven on staging: `pg_net` POSTed to the real drain webhook and n8n
      answered (404, because the workflow is correctly still inactive); `pg_cron` fired
      unattended on schedule. Function ladder verified end to end — `idle`, `unconfigured`,
      `fired:1`, `throttled`, `in_flight`, and `fired:2 reclaimed:1` for stale-claim recovery.
- [x] `node tests/n8n/telegram-router-retry-guard.test.mjs` — order-node guard still green.
- [x] Router enqueue path pinned run (execution 15833) and all-hidden run (15834).
- [x] Migration applied to staging `npytqidroqxgikaqofmq` and verified.
- [x] **Live staging drain run** — real X hides verified end to end (@keryxpoc hiding replies from @Hamditlr6): 23 replies genuinely hidden, partial allowance, real 429, deleted-reply classification, live Telegram progress edit. All test tweets and rows removed afterwards.
- [x] Production promotion 2026-08-27: both migrations applied to `jxnzdxyhoakpfmkbjdeq`; drain `vm4UNW7OIx2zEGb4` created, published, activated and passing all five pinned fixtures (`DRAIN_ENV=production`); its own Vault secrets set and `pg_cron` enabled; router `cWczsttyDbTBbRAC` hide branch promoted and published. Ordered so the router never enqueued into an undrained queue. Zero production `Replies` rows touched.

Open Questions:

1. ~~Activate the drain?~~ **Done 2026-08-27** — Vault secrets set, workflow activated, cron
   job enabled. Kill switch is `cron.alter_job(..., active := false)`.
2. Wire the drain's X token refresh to Vault as well. `Plan Drain Pass` and
   `Prepare Drain Refresh Request` still read `$env.X_OAUTH_CLIENT_ID` /
   `X_OAUTH_CLIENT_SECRET`, which **cannot work on n8n Cloud** for the same reason the gate
   could not. They fail safe (stale-token rows are deferred with a developer alert, never
   failed), so the drain is correct but cannot renew an expired token. Fixing it means moving
   the X OAuth client credentials out of the router's `Prepare Refresh Request` Code node
   into Vault — which overlaps the credentials task assigned to another session, and those
   values should be rotated first since they are in git history.
2. X OAuth client credentials for the drain's token refresh — set `X_OAUTH_CLIENT_ID` and
   `X_OAUTH_CLIENT_SECRET` as n8n environment variables, or inline them the way the router's
   `Prepare Refresh Request` does? Env vars were chosen to avoid duplicating a plaintext
   secret; until they are set, the drain defers stale-token rows rather than failing them.

Notes:

- **Live end-to-end verification 2026-08-27** on real X data (@keryxpoc hiding replies
  authored by @Hamditlr6, driven by the live pg_cron heartbeat). Proved: real successful
  hides (16 replies actually hidden, Replies.status=hidden), partial allowance (24 queued
  with remaining=5 -> claimed exactly 5), real 429 handling (rows requeued, attempts refunded
  to 0, not_before = X reset), token-wide defer, header write-back into "X Rate Limits", the
  live Telegram editMessageText progress update, and multi-row jsonb_to_recordset persistence.
- **Three defects the pinned tests could not have found:**
  1. A deleted reply returns **400 invalid-request**, not 404, so it was classified
     x_hide_rejected (retryable) and burned all five attempts instead of failing immediately.
     Fixed; the fixture now uses X real payload.
  2. X refuses to hide a **self-authored** reply with a bare 403 — so any hide test needs a
     second account replying. Classified correctly as not_post_owner_or_not_moderatable.
  3. **n8n runs a published ACTIVE version, not the draft.** update_workflow edits the draft
     and test_workflow tests the draft, so the fix in (1) passed the whole suite while live
     traffic ran the old code. publish_workflow closes it; the suite now asserts
     activeVersion.sameAsDraft === true.
- Still pinned-only, never proven live: abandoned at attempts >= 5, which needs a transient X
  failure five times over and cannot be produced on demand.
- Staging evidence 2026-08-26: drain executions 16278–16281 (quota exhausted mid-batch, 429,
  permanent failures, attempts exhaustion) all pass with the drain inactive and every external
  node pinned. Router executions 15833 (enqueue: 4 stored replies → 1 already hidden excluded,
  `hide_failed` still eligible, 3 queued, `message_id` stored) and 15834 (all-hidden: nothing
  enqueued, no spurious developer alert).
- No staging `Replies` or `Posts` rows were mutated. Queue SQL was exercised against
  `Moderation Queue` with synthetic `QTEST_*` rows, which were deleted; both new tables were
  left empty.
- Five obsolete router fixtures were deleted (`hide-replies-success`, `-provider-error`,
  `-skip-hidden`, `-rate-limit-partial`, `-rate-limit-precheck`) — they pinned nodes that no
  longer exist. Their scenarios moved to the drain pins.
- Keep this item open until production matches. Promotion has to move **both** migrations, the
  router branch, and a production drain together; a promoted router without the queue tables
  fails at `Enqueue Hide Requests`. Production also needs its own Vault secrets (different
  webhook URL, different shared secret) — the cron migration deliberately contains neither.
- **n8n Cloud blocks `$env` inside Code nodes.** A probe workflow returned
  `"access to env vars denied"`, and `$vars` is present but empty on this instance. Any design
  that reads instance environment variables from a Code node here is dead on arrival. The
  drain gate now compares against `vault.decrypted_secrets` in SQL via the Postgres
  credential, whose role is `postgres` and can read Vault (verified). There is no
  `MODERATION_DRAIN_SECRET` env var and none is needed.
- The webhook always answers HTTP 200 (`responseMode: onReceived`), so the status code is not
  an authorization signal — judge from the execution. That is fine for `pg_net`, which never
  reads the body.
- Possible hardening later: n8n's built-in webhook Header Auth rejects a bad call *before* an
  execution is created, so it costs nothing at all, whereas the current in-workflow gate burns
  one execution to say no. It needs a credential created in the n8n UI, which is why it was
  not wired now.
- `pg_net` does not guarantee delivery and never retries. That is only survivable because the
  queue is durable — a dropped call leaves rows `queued` and the next tick calls again. Do not
  reuse this pattern for work that is not backed by a queue.
- The drain hides within a pass even after a 429 for requests already dispatched — n8n cannot
  abort an HTTP node mid-item. Bounded by the claimed batch size, which is bounded by the live
  `remaining` header. Revisit with `splitInBatches` only if it shows up in practice.

### Make SMM order spend recording trustworthy

- Status: open
- Priority: high
- Complexity: `M`
- Source: limits review 2026-08-24, `docs/architecture/limits-and-capacity.md` §7.1

Design:

With no spend cap on client orders (decision #9), the `Order Info` record *is* the control,
so it has to be right. Nine gaps catalogued in §7.1; two are single-line changes worth doing
immediately and independently of any phase.

1. **Active corruption.** `Update Order Info Status` in the order poller writes
   `charge = $5::numeric` unconditionally, and `charge` is parsed with
   `toNumber(firstPresent(['charge'…]))`. A poll returning an error or a response without a
   `charge` field overwrites a previously captured figure with `NULL`. Usually recovered by
   the next poll, but permanent if it lands on the transition to a final status. Fix:
   `charge = coalesce($5::numeric, charge)`, same for `currency`, `start_count` **and
   `remains`**. The earlier "leave `remains` alone, it legitimately decreases" reasoning was
   wrong, and §7.1 corrects it: `coalesce` only substitutes when the incoming value is `NULL`,
   and `coalesce(0, remains)` is still `0`, so a countdown to zero is unaffected.
   **Done 2026-08-25 in staging and production.**
2. **Double-charge risk.** `Place Comment Order` and `Place Likes Order` carry no explicit
   `retryOnFail`, relying on the n8n default of `false`. Set it explicitly on both and assert
   it in the pinned fixtures — SMMWiz has no cancel.
   **Done 2026-08-25 in both routers, staging and production.**
3. **Spend with no record.** `Insert Order Info` runs *after* the provider call, so a crash
   or timeout between them means money spent and nothing written. Invert to a write-ahead
   intent row (`normalized_status = 'placing'`), then update with the provider order id.
4. Remaining items — charge estimation at placement from the cached service rate, one
   post-final re-poll to capture partial-order refunds, a daily provider balance
   reconciliation, a stale-order sweep, currency grouping, and `client_id` written at
   placement — land with the tenancy schema (Phase 2) and the console (Phase 4).

Validation:

- Pinned poller run where the status response omits `charge`; the stored value must survive.
- Pinned order run confirming a single provider call per placement.
- Verified live 2026-08-24: `Order Info.charge` currently holds real figures — `0.1935`,
  `0.79305`, `0.0387`, all `USD` — so the recording works when the poll succeeds. Re-verified
  unchanged 2026-08-25.

Progress 2026-08-25 (items 1 and 2):

- Item 1 applied to `XMonitor - Order Status Polling Staging` (`ceX1EiVN3bFWARMu`) and to both
  local exports. Validated with three pinned staging runs that deliberately leave
  `Update Order Info Status` **unpinned**, so the UPDATE really executes — the existing
  fixtures pin that node, which is why they could never have caught this:
  - `15030` error response, no `charge`, row goes final (`failed`): `0.42`/`USD`/`5`/`3` all
    survived; `provider_status`, `normalized_status`, `last_error` correctly updated.
  - `15031` `Completed` response omitting `charge`: value survived, and `remains` still wrote
    `3 → 0`, disproving the "coalesce freezes the countdown" concern.
  - `15032` happy path: `0.42 → 0.98765`, `USD → EUR`, `5 → 77` all overwritten as expected.
  - Test row `coalesce-regression-1` deleted afterwards; staging `Order Info` back to its
    original 5 rows.
  - New fixtures: `tests/n8n/order-status-polling-pins/order-status-{error-no-charge,
    completed-no-charge,charge-overwrite}.pinData.json`, plus manifest seed/reset/cleanup SQL.
- Item 2 applied to both routers, staging (`oLwwjO05IcRjtF8E`) and production
  (`cWczsttyDbTBbRAC`): `retryOnFail: false` explicit on both order nodes, a sticky note beside
  each recording why, `nodeSettingsAssertions` in the risky-pins manifest, and a new read-only
  guard `tests/n8n/telegram-router-retry-guard.test.mjs`. Pinned staging runs `15038`
  (`order-likes-provider-error`) and `15040` (`order-likes-success`) both succeeded. No live
  SMM call was made.

Production promotion of item 1 — 2026-08-25:

- `XMonitor - Order Status Polling` (`AqdNgOKRXG6J5zbj`) reports `availableInMCP: false`, so
  MCP refuses to read it, edit it, or even list its executions. It was reached over the REST
  API instead, after the user supplied a fresh `N8N_API_KEY` (the previous one expired
  2026-07-12, which is why both routes were briefly shut).
- Applied by `PUT /api/v1/workflows/AqdNgOKRXG6J5zbj` and confirmed by readback: the SQL now
  carries all four `coalesce` guards, `active: true` survived, and all five credential
  bindings are intact. Local export re-synced from the REST response.
- **No pinned production run is possible** — `test_workflow` is an MCP tool and the workflow
  is invisible to it. The fix rests on the three staging executions above plus the fact that
  `Update Order Info Status` is byte-identical between the two environments. Enabling MCP on
  that workflow's card would remove this gap.

Drift found while resolving the staging/production parity question:

- Staging (`updatedAt 2026-06-17`) was 20 days behind production (`2026-07-07`). A REST diff
  of the two live workflows found **one** substantive difference, and it is not in the node
  that was fixed: production's `Fetch Due Order Info Rows` has **no `AND next_check_at <=
  now()` clause**, so it polls every non-final order on every 30-minute run and
  `next_check_at` scheduling is inert there. Staging has the clause.
- Left unchanged — it is a separate decision (adopt the due filter in production, or drop it
  from staging), not part of the charge fix. Recorded in both poller docs.
- The other two node differences are cosmetic: the n8n editor strips default values on save,
  so production omits `resource`/`operation` on `Send Final Order Notification` and `mode` on
  `Attach SMM Status Config`.

Open Questions:

- SMMWiz's balance endpoint has not been verified. `action=balance` is the convention across
  this panel API family; confirm against their documentation before building the daily
  reconciliation.

Notes:

- `quantity` is `NULL` on comment orders — the count lives in `comment_count`, so any report
  must `coalesce(quantity, comment_count)`.
- `poll_attempts` is incremented on every poll and never read, so a stuck order polls forever
  and its charge never resolves.
- Balance reconciliation is the only control that can catch a charge with no row at all,
  including an order placed by hand in the SMMWiz panel.

### Multi-tenant clients and web moderation UI

- Status: in progress — **T1, T2 and T3 all done 2026-08-29.** T3 is live in both
  environments; production is published at `577efebb-acdd-4062-a205-dbeed364a17e` with
  `activeVersionId` matching `versionId`. Next is T4 (isolation proof). Execution plan is
  `docs/architecture/multi-tenant-and-web-ui.md` §12b (phases T1–T7); §12a records verified
  state as of 2026-08-29, §12c what T2 delivered, §12d what T3 delivered
- Priority: high
- Complexity: `L`

State check 2026-08-29 (verified against live n8n and both Supabase projects):

- Shipped and single-tenant: `/track` soft-delete with its ownership guard, `Posts` FK
  `RESTRICT`, incremental replies with the watermark advancing since 2026-08-28 17:00,
  engagement and provenance columns, console views, `Moderation Queue` + `X Rate Limits` +
  drains in both environments, and a read-only console.
- **T1 landed 2026-08-29** — `db/migrations/2026-08-29-tenancy-schema.sql`, applied to
  staging then production. `Clients` / `Client Members` / `Staff` exist; `client_id` is on
  `Tracked Users`, `Posts`, `Replies`, `Order Info` and `X Auth Accounts`, backfilled to one
  `house` client and `NOT NULL` on the first three. Four `security definer` triggers keep it
  populated, so **no workflow was changed and none needs to be**. Row counts identical before
  and after in both environments; both console views byte-identical. `Telegram Users` is
  still in place and still the scheduler's recipient source until T3.
- Two T1 deltas worth remembering: `Order Info.client_id` stayed **nullable** (spend must
  record even when it cannot be attributed — `limits-and-capacity.md` §7.1 #9), and a fourth
  trigger on `Tracked Users` was required because `Upsert Tracked X User` supplies no
  `client_id` and `NOT NULL` would otherwise have broken `/track`.
- **T2 landed 2026-08-29** — authorization, in both routers, `active` and published with
  `activeVersionId` matching `versionId`. One shared resolver
  (`Resolve Caller Authorization` -> `Build Caller Authorization` -> `If Caller Known`) sits
  between `Parse Telegram Message` and `Route Telegram Intent`; each of the four
  `Get Post For *` lookups gained an owner gate. 113 → 127 nodes per router. `/track` is now
  staff-only (decision #3). The operator chat was added to `Staff` in both environments
  (`8372903693` production, `8677383067` staging) — that is what lets it act across clients
  once client #2 exists, and the decision is recorded in §12c.
- The T2 rule most likely to be broken later: **"post not found" and "post belongs to another
  client" must return the same message.** They differ only by the post id the caller typed.
  If they ever diverge the bot becomes an oracle for probing other clients' post ids.
  `tests/n8n/tenancy-pins/missing-post-refusal` exists to catch exactly that.
- **T3 written 2026-08-29, not promoted.** Both scheduler exports now resolve recipients
  through `Client Members` (`Get Telegram Users` → `Get Alert Recipients`) and apply each
  client's own `min_replies` / `negative_threshold`. `Telegram Users` is no longer read by
  either scheduler; it is deliberately **not** dropped, because the Telegram router still
  writes it. 58 offline assertions across `tests/n8n/t3-alert-routing.test.mjs` and
  `tests/n8n/t3-alert-routing-fixtures.test.mjs`, plus three new `tenancy-*` pin fixtures
  awaiting an n8n run.
- **What blocks T3 from being done:** no n8n access. The claude.ai n8n connector was absent
  and `N8N_MCP_URL` / `N8N_MCP_ACCESS_TOKEN` are no longer in `keys.env` —
  `tests/n8n/scheduled-tracking-pins/run-pins.sh` hard-requires both. Supabase was reachable
  throughout. Restore either route, then follow §12d's six promotion steps; re-run
  `scripts/apply-t3-alert-routing.mjs` against a freshly pulled live export rather than
  pushing the local one, since it may have drifted.
- **T3 found and fixed the `executeOnce` matched pair** already recorded in
  `docs/workflows/xmonitor-scheduled-post-tracking.md` (staging execution `18789`).
  `executeOnce` removed from `Build Negative Alert Notification`, added to
  `Get Reply Status Counts` and `Get Alert Recipients`. That flag was the only reason the
  pre-T3 broadcast sent one message rather than N — it masked the defect. Shipping the
  removal without the two additions would send one Telegram message per reply.
- **`lookback_days` is deliberately out of T3.** The replies query has been watermark-driven
  since Phase 1, so lookback only governs the first-run backfill; per-client would force a
  per-client query fan-out for a value used once per environment. Loaded and carried, read by
  nothing.
- **The operator row was deliberately left `receives_alerts = true`** in both environments.
  Decision #5 wants the operator on the console instead, but that flip takes a person off
  Telegram alerts entirely and is an operational choice, not a side effect of a code change.
  T3 makes the flip sufficient — nothing else needs to change:
  `update public."Client Members" set receives_alerts = false where chat_id = '8372903693';`
- Order of work was T2 (authorization) before T3 (alert routing): a broadcast alert is
  embarrassing, unauthorized spending on another client's post is worse.
- The design call before T1 is settled: **`Clients`**, chosen 2026-08-28 on edit count rather
  than capability.
- Source: user request 2026-08-24

Design:

1. Full design record: `docs/architecture/multi-tenant-and-web-ui.md`.
2. Tenancy anchored on `Tracked Users.client_id`; new `Clients`, `Client Members`,
   `App Users`, `Client Access`, `Action Log`, `X Rate Limits` tables; `Posts.status` split
   into `suppression_status` / `order_state`.
3. Action logic extracted from the Telegram router into an `XMonitor - Action Executor`
   sub-workflow, called by both the router and a new `Action Gateway` webhook so Telegram
   and the UI share one implementation.
4. UI is Next.js + Supabase Auth; reads go direct to Postgres under RLS, writes go through
   the gateway. Eight delivery phases listed in §12.

Validation:

- Per phase, per §12 gate column. `tests/n8n/tenancy-pins/` exists as of T2 (18 fixtures,
  self-contained, runnable against either router); RLS asserted as `authenticated`, never as
  `postgres`.
- Existing `tests/n8n/telegram-router-risky-pins/` fixtures must pass unchanged after the
  executor extraction — that is the parity proof.

Open Questions:

- Resolved 2026-08-24 — sixteen decisions recorded in §11 of the design. Headlines: a client
  is one person with one chat; a tracked X account belongs to exactly one client; `/track` is
  staff-only; scale target is under 5 clients and 15 accounts; the operator chat stops
  receiving alerts and uses the console instead; clients keep every action including paid
  orders, with spend recorded rather than capped; console v1 is read-only on Vercel.
- Still open: the `snooze_runs_remaining` → `snoozed_until` migration (wants its own slot —
  it touches the router, the scheduler, and every pinned snooze fixture), which X billing
  model the account is on, and n8n Cloud execution concurrency on the current plan.

Notes:

- Because the operator chat goes quiet, the read-only console became a **prerequisite for
  onboarding client #2**, not a finishing touch. Phases reordered accordingly in §12:
  0 → replies-pipeline rebuild → tenancy schema → tenancy in workflows → console read-only →
  *onboarding gate* → executor → gateway + hide queue → console actions.
- Latent defects that multi-tenancy triggers immediately are catalogued in §1.2. The
  1024-char cap on the replies query and the hourly re-alert are the two that break first.
- Limits, X API cost, and the moderation queue now live in
  `docs/architecture/limits-and-capacity.md`. A second X app was evaluated and dropped —
  search runs at 0.2% utilisation, billing is per resource regardless of app, and the
  per-user hide bucket's app-scoping is undocumented.
- Sibling FB Monitor already implements the per-row config, self-registering recipients,
  audit table, and alert-dedupe patterns this design reuses.

### Evaluate native sentiment tracker accuracy and readiness

- Status: open
- Priority: high
- Complexity: `M`
- Source: request, 2026-07-05

Design:

1. Measure the staging native sentiment tracker against hand-labeled synthetic reply examples before considering it for the standard scheduler.
2. Keep validation isolated from X, Telegram, SMM, Supabase writes, and production workflows by using a temporary MCP-enabled benchmark workflow that contains only the sentiment analysis path.
3. Compare expected vs actual labels across Positive, Neutral, and Negative examples, with special attention to false negatives for hostile replies and false positives for factual or mixed replies.
4. If accuracy is acceptable, decide whether to tune the native sentiment prompt, expand examples with real anonymized replies, or promote the native sentiment path into the standard staging scheduler.

Validation:

- Run `node tests/n8n/native-sentiment-accuracy.integration.test.mjs` from the repository root.
- Confirm the runner reads live workflow `f2eFqB2wO91HAYMJ`, creates a temporary benchmark workflow, runs only the synthetic examples through the sentiment analysis path, prints the confusion matrix, and deletes the temporary workflow.
- Re-run `node tests/n8n/scheduled-post-native-sentiment.test.mjs` to verify the local native sentiment workflow export still deduplicates and expands replies correctly.
- Document the latest benchmark score and mismatch patterns in the native sentiment accuracy doc.

Open Questions:

- None.

Notes:

- Initial synthetic benchmark files were added under `tests/n8n/` with 36 hand-labeled examples: 12 Positive, 12 Neutral, and 12 Negative.
- The benchmark calls OpenAI through n8n and may consume API quota, but it should not call X, Telegram, SMM, Supabase, or production workflows.
- Live benchmark executions `3708` through `3714` all failed at `Analyze Reply Sentiment` before scoring with `Error during parsing of LLM output`, including a one-case plain English probe, parser-compatible prompt candidate, auto-fixing candidate, and `gpt-4o` model override candidate.
- A cleanup check after the failed benchmark probes found `0` temporary benchmark workflows remaining in n8n.
- Previous conclusion: native sentiment accuracy could not be measured because the native sentiment node path was not returning parseable labels. That parser path has now been bypassed in staging; live accuracy scoring is waiting on OpenAI rate-limit recovery.
- On 2026-07-05, staging workflow `f2eFqB2wO91HAYMJ` was updated to bypass the broken native sentiment parser: `Analyze Reply Sentiment` now uses n8n's OpenAI JSON-mode node with `gpt-4o-mini`, `retryOnFail=true`, `maxTries=3`, and `waitBetweenTries=5000`; `Attach Sentiment Metadata` parses the JSON output and restores `sentimentAnalysis.category` for the existing downstream count logic.
- Live readback after the fix showed the workflow inactive, `Analyze Reply Sentiment` type `@n8n/n8n-nodes-langchain.openAi`, `Attach Sentiment Metadata` present, and the old `OpenAI Chat Model - Sentiment` plus `Merge Sentiment Categories` nodes removed.
- Local regression `node tests/n8n/scheduled-post-native-sentiment.test.mjs` passed after the graph change.
- Pinned benchmark executions `3726` and `3728` validated the fixed graph and adapter with all 36 synthetic cases pinned at `Analyze Reply Sentiment`: `36/36`, `100%`, no mismatches, no OpenAI/X/Telegram/Supabase calls.
- Live OpenAI probes of the JSON-mode path (`3723` through `3725`, and `3727` after applying the fix) reached `Analyze Reply Sentiment` but failed with provider throttling: `The service is receiving too many requests from you`. This is a separate external rate-limit blocker, not the original native parser error.
- Cleanup checks after the benchmark probes, including after latest pinned execution `3728`, found `0` temporary benchmark workflows remaining in n8n.
- On 2026-07-05, OpenAI throttling backoff was increased in staging workflow `f2eFqB2wO91HAYMJ`: `Analyze Reply Sentiment` now uses `maxTries=6` and `waitBetweenTries=60000`, giving a throttled run five minutes of artificial retry spacing before failing. The benchmark runner was updated with matching defaults plus `--delay-before-run-ms`, `--retry-tries`, `--retry-wait-ms`, and `--execution-timeout-ms` controls for deliberate live OpenAI validation.
- Live OpenAI validation after adding backoff still failed at the provider level: execution `3730` failed after a 60-second pre-run delay, execution `3733` failed after a 5-minute pre-run delay, and execution `3734` failed with model override `gpt-4.1-mini`. Each was a single synthetic case and returned `The service is receiving too many requests from you`, so the next practical unblocker is OpenAI credential/project quota or rate-limit recovery rather than more prompt work.
- **2026-10-10 - superseded in staging.** The standard staging scheduler `l4eKZucUZXzfz0H8` now classifies one reply per call with n8n's Sentiment Analysis node (`Classify Sentiment`, `gpt-5.4-mini`, IG - Monitor's prompt adapted to X), which is the per-reply path this task set out to evaluate. The parser error that blocked `f2eFqB2wO91HAYMJ` did not recur: live execution `44787` labelled 104 real replies with 0 failures and no auto-fix retries. Agreement with the old batched labels was 77/104 (13 Neutral→Negative, 9 Negative→Positive, by design of the target-and-stance prompt). Evidence and cost in `docs/workflows/xmonitor-scheduled-post-tracking-staging.md`, "Per-Reply Sentiment Classification - 2026-10-10". The synthetic accuracy benchmark was not re-run and the parked workflow `f2eFqB2wO91HAYMJ` stays parked. **Promoted to production the same day**: `Emb26wP77eFXgnVi` published version `8669273d-0fac-44cf-8e35-053df306a956` (`versionId == activeVersionId`), pinned simulations `44801`-`44804` on the draft first. Still open here: a measured accuracy score against real reviewer labels, now that the console writes `manual_sentiment`.

### Finalize metrics tests and document X reply retrieval limits

- Status: open
- Priority: high
- Complexity: `M`
- Source: request, 2026-06-30

Design:

1. Finish scheduled monitoring metric validation for single-post and multi-post cases.
2. Document exactly which X replies the scheduled tracker currently retrieves, including endpoint/query behavior, ordering, filters, and pagination behavior.
3. Identify the current reply retrieval limit and whether the workflow is limited by X API parameters, pagination handling, n8n node behavior, database schema, runtime cost, or rate limits.
4. Define the safest next step for expanding the reply limit without increasing cost or API risk unexpectedly.

Validation:

- Re-run pinned metric tests covering total replies, analyzed replies, negative replies, hidden negative replies, and visible negative replies.
- Verify live staging metric output against Supabase rows for at least one representative tracked post.
- Inspect the X reply retrieval node and any pagination or limit settings in the scheduled tracker workflow.
- Record the current limit, the reason for the limit, and the proposed expansion path in workflow docs or notes.

Open Questions:

- None.

Notes:

- Existing staging metric validation includes pinned executions `3263`, `3270`, `3276`, and live staging execution `3278`.
- Live staging execution `3278` sent Telegram message `79` for post `2060604129798496702` with total replies `32`, analyzed replies `25`, negative replies `16`, hidden negative replies `16`, and visible negative replies `0`.
- Product clarification on 2026-07-05: the alert should not present separate "total replies" and "analyzed replies" counters. The displayed result should use the final complete reply set, so the denominator must be trustworthy rather than exposing a partial-analysis count beside the X public total.
- Current live staging behavior is not just a formatting problem: `total_reply_count` is copied from X `public_metrics.reply_count`, while `comments_count` / analyzed replies is the number of replies returned by `Get Replies` and sent through sentiment analysis. If retrieval is incomplete, the alert can show two truthful-but-confusing numbers.
- Live staging drift observed on 2026-07-05: `Build X API Query` uses `DAYS_AGO = 60` and live `Get Replies` uses `max_results=500`, while the staging doc/local export still describe older values (`7` days and/or `200`). Treat live n8n as authoritative until exports/docs are resynced.
- Supabase validation on 2026-07-05 found two stored `Posts` rows. Post `2060604129798496702` stores `comment_count=25`, `negative_count=16`, but has `20` stored `Replies` rows, all hidden; the extra four stored rows are older negative replies from prior runs and were not part of execution `3278`'s current negative set. Post `2058879475094266262` stores `comment_count=17`, `negative_count=11`, has `11` stored visible negative replies, and is currently `Processing`.
- Fresh read-only X API validation attempts on 2026-07-05 created temporary n8n workflows and executed X reads only, then deleted the workflows. Executions `3717` and `3718` hit X `503 Service Unavailable` on `GET /2/tweets`; execution `3720` hit X `503 Service Unavailable` on `GET /2/tweets/search/all`. No X writes, Supabase writes, Telegram sends, token values, or token refreshes were performed.
- An owner OAuth row exists for X user `951803761` with `tweet.read`, but its access token is expired. Refresh was intentionally not attempted because refresh-token rotation can change stored auth state and should be treated as an approval point.
- Secondary evidence from prior successful X response bodies in staging execution `3278`: post search saw X public reply counts `32` for `2060604129798496702` and `26` for `2058879475094266262`; reply search returned only `34` replies total (`25` for `2060604129798496702`, `9` for `2058879475094266262`). The missing replies are older than the implicit reply-search window because `Get Replies` does not pass an explicit `start_time`.
- Implementation direction to validate before changing alerts: fetch replies from each post's creation time or another explicit lower bound, paginate until `next_token` is exhausted or the fetched count reaches X `public_metrics.reply_count`, then use one displayed reply total. If full retrieval cannot be guaranteed because of X caps/rate limits, the alert should avoid claiming a final total and should surface an explicit incomplete-data state instead of showing "analyzed replies" as a second metric.

### Avoid re-querying already processed replies in scheduled tracker

- Status: **merged 2026-08-24** into *Stop re-reading every reply every hour (X read cost +
  OpenAI)* at the top of this file. Do not work this entry — it is kept only so the original
  2026-06-30 request stays traceable.
- Source: request, 2026-06-30

Its guidance was folded into the merged task and still holds:

- Preserve metric correctness — total replies, analyzed replies, negative replies, and
  hidden/visible negative counts must survive the change. This is why the merged task
  requires the ratio to be recomputed from stored rows.
- Pinned tests must cover the mixed case: some replies already in Supabase, some new.
- **Do not trade lower OpenAI cost for higher X API cost.** Confirm the retrieval limit and
  pagination behavior before changing the query shape. Written 2026-06-30 and it aged well —
  X moved to per-resource billing in the interim, so both costs now move together and X is
  the larger of the two.

## Completed Tasks
### Per-post reply backfill — replies before a post qualifies were never fetched

- Status: done — promoted to production 2026-09-04
- Priority: high
- Complexity: `L`
- Source: production alert on post `2095516553672380450`, 2026-09-04 — 13 replies on X, 4 analyzed

What it was:

`Build Replies Query` applied one `start_time` to every conversation in the pass, the run
watermark minus a 10-minute overlap. A post is not a reply-fetch candidate until its X
`reply_count` crosses `min_replies`, so on the pass where it first qualified every reply it
already held was older than that one-hour window. Those replies were never requested, and
because the watermark only moves forward they were never requested again. Gap size was roughly
`min_replies` per alerting post. Latent since incremental fetching shipped 2026-08-25;
`2095516553672380450` was the first post to qualify under it and exposed it immediately.

What shipped:

1. New node `Get Backfilled Post Ids` — read-only, `executeOnce`, between `If Any Post
   Qualified` and `Build Replies Query`. Returns the candidate posts that already have an
   analyzed reply stored.
2. `Build Replies Query` splits conversations into an incremental group (watermark window,
   unchanged) and a backfill group windowed from the post's own `created_at`. Each group is
   chunked independently; a backfill chunk starts at its oldest post.

Evidence:

- Staging `l4eKZucUZXzfz0H8`, draft `e04f9e2f-8cc7-4dea-9edb-e850cc95a73f`: executions `21593`,
  `21594`, `21596`, `21597`, `21602`, `21603`, `21619`. Live X search over a backfill window
  returned all 13 replies for the post that exposed the defect.
- Production `Emb26wP77eFXgnVi`: published `401b14d9-679b-4d74-b69b-3e52afbb490a` at 11:27 UTC,
  `versionId == activeVersionId` confirmed by re-read on an `active: true` workflow. Fixtures
  `21617` (backfill) and `21618` (page-cap truncation) green.
- New fixture `backfill-new-post-full-window`, environment-neutral, plus the new node pinned in
  the 15 existing fixtures that reach it.

Recovery:

The four stored `Replies` rows for `2095516553672380450` were deleted so the post would
re-enter the backfill path; the fix does not retroactively collect replies for a post that
already has stored rows. All four were `status = 'New'` with no moderation, so nothing an
operator had done was lost. `Replies` went 933 → 929.

The next scheduled pass, execution `21628` at 2026-09-04 12:00 UTC, re-collected the post:
`is_backfill true` with `start_time 2026-09-03T14:16:33.000Z`, 13 new replies over 2 pages,
and alert message 1305 reading `Analyzed replies: 13` against `Total replies: 13`. The
previous alert on the same post, message 1304, read `Analyzed replies: 4`. `Replies` went
929 → 942 and the watermark advanced normally.

Notes:

- `Build Truncation Alert` still advises nulling the run state watermark to force a backfill.
  With per-post backfill the narrower recovery is deleting the affected post's stored replies.
  Stale advice rather than a defect; worth a follow-up edit.
- `Posts.comment_count` stores the analyzed count, not X's reply count, so the table carried
  `4` while X reported `13`. Not addressed here.

### Stop re-reading every reply every hour (X read cost + OpenAI)

- Status: **done — promoted to production and verified 2026-08-25.** Reopened the same day for
  two watermark defects (quiet passes never advanced it; truncated passes advanced it when
  they must not); both fixed, validated in staging, promoted, and confirmed live in
  production. The reply-read saving itself is still unmeasured — see the last note.
- Priority: critical
- Complexity: `L`
- Source: limits review 2026-08-24, `docs/architecture/limits-and-capacity.md` §1

Design:

1. `Build Replies Query` set only `query` — no `start_time`, no `since_id` — so every hourly
   pass re-fetched the complete reply history of every qualifying conversation in the 7-day
   window. X now bills **$0.005 per post resource returned** (pay-per-usage replaced the
   Basic/Pro tiers in May 2026), and a reply is a post. A reply was therefore read ~168 times
   before ageing out, at ~$0.84 instead of $0.005. The same replies were re-sent to OpenAI
   each pass.
2. Set `start_time = last_successful_run_at` on the replies query. Persist that timestamp and
   advance it **only on a successful pass** — a failed run that advances it creates a
   permanent gap in reply coverage.
3. Add `Replies.sentiment` and `Replies.analyzed_at`; store a label for every analyzed reply,
   not just negatives. Send only `analyzed_at is null` rows to OpenAI. The negative ratio is
   then computed from stored rows plus new arrivals — this is what makes step 2 possible at
   all, so the two ship together.
4. Chunk the conversation-id query at 15 (the 1024-char full-archive cap broke it at ~20).
5. One-off backfill over the full window on first deploy.

Delivered in staging (`l4eKZucUZXzfz0H8`), 2026-08-24:

| Item | How |
| --- | --- |
| Run-state persistence | New `Run State` table; `Get Run State` reads it, `Advance Run State` / `Advance Run State (Quiet Pass)` write it. |
| `start_time` on replies | `Build Replies Query` uses `last_successful_run_at - 10 min`, falling back to the 7-day window when null. |
| Advance only on success | Both writer nodes sit after the work they attest to. No edge from the OpenAI failure path to either. |
| Per-reply sentiment | `Replies.sentiment` + `analyzed_at`; `Filter Negative Replies` removed so all three labels persist. |
| Skip analyzed replies | `Get Analyzed Reply Ids` + filtering in `Attach replies to posts`; `If Has New Replies` skips OpenAI entirely on a quiet pass. |
| Ratio from stored rows | `Get Stored Post Counts` supplies the stored half; `Calculate/Filter Sentiment Counts` computes `(stored + new) / (stored + new)`. |
| Candidate-post storage | All 10+ reply posts stored; `alert_now` gates alerting only. Required by the `Replies.post_id` FK. |
| Chunking at 15 | Chunks built by measuring the assembled string, capped at 15 ids / 1000 chars. |
| Backfill | Null watermark triggers a full-window pass; migration `xmonitor_phase1_backfill_legacy_reply_sentiment` marks pre-existing rows. |
| `expansions=author_id` dropped | Author identity now read from `Tracked Users`; added `display_name`. |

Migrations applied to staging `npytqidroqxgikaqofmq`:
`xmonitor_phase1_incremental_replies`, `xmonitor_phase1_backfill_legacy_reply_sentiment`.

Validation:

- Measured baseline, production execution `14472` (2026-08-24T11:00Z): 8 posts + 3 users +
  42 replies = $0.28/run ≈ $204/month on three accounts. Both searches returned an unused
  `next_token`.
- ✅ 25 qualifying conversations must not 400 — pinned execution `14568`: 2 chunks (15 + 10),
  longest query 746 chars against the 1024 cap. The single query this replaces would have
  been 1,246 chars.
- ✅ Reply-read count drops to new arrivals only — live `14572` (backfill) read 108 replies;
  live `14576` immediately after read **0** and skipped OpenAI entirely.
- ✅ Negative ratios match a full-window recompute — post `2089952031398125613`, stored
  108/81/0.750000 versus recomputed 108/81/0.750000 from the reply rows.
- ✅ Watermark does not advance on a failed pass — live `14577` aborted mid-pass with
  `last_successful_run_at` unchanged.
- ✅ Ratio arithmetic and the storage/alert split — pinned `14570`: stored 10+2 analyzed and
  6+1 negative gives 0.5833 and alerts; a second post at 0.1 is stored and not alerted.

Open Questions:

- None blocking. Pay-per-usage billing confirmed by the user 2026-08-24. Router-widening and
  the `expansions` removal were both confirmed by the user 2026-08-24.

Notes:

- Decided 2026-08-24 to move this ahead of the tenancy work — it is independent of tenancy
  and costs money every hour it waits. It is Phase 1 in
  `docs/architecture/multi-tenant-and-web-ui.md` §12.
- Projection at 5 clients × 3 accounts: ~$1,170/month unfixed, ~$124/month fixed.
- The 3M post-read monthly cap is not the binding constraint; cost is.
- **Supersedes the 2026-06-30 entry "Avoid re-querying already processed replies in scheduled
  tracker"**. Its warning not to trade OpenAI cost for X API cost is satisfied: both drop
  together, because the same `analyzed_at` marker gates both.
- Scope held to the **replies query only**. The posts query still covers the full 7-day
  window.
- **Behaviour change to be aware of before promotion:** a post above the threshold with no
  new replies in a pass no longer re-alerts every hour, because it never reaches the alert
  branch. Previously the full refetch re-alerted hourly. This matches the intended alert
  dedupe in §7.2 but arrives earlier than that phase.
- **Router widening confirmed by the user 2026-08-24:** storing every candidate post means
  `Get Post For Hide`, `Get Post For Status Change`, `Get Post For Comment Order` and
  `Get Post For Likes Order` now resolve for posts that were never alerted. Two of those
  spend real money. The old *"Wait for monitoring to flag it"* refusal no longer fires for
  candidate posts.
- `Tracked Users.display_name` is added but **not populated** — it is unused by the alert
  today (`post_author` always prefers `@username`), so no X call was spent backfilling it.
  `/track` should populate it when it next calls `/users/by/username`.
- **`next_token` pagination is now implemented** — see the dedicated task below. Both searches
  follow the token to exhaustion and prove completeness rather than assuming it.
Production promotion — 2026-08-25:

- Migrations applied to `jxnzdxyhoakpfmkbjdeq`: `Replies.sentiment` + `analyzed_at`,
  `Run State`, `Tracked Users.display_name` all present. Legacy backfill marked all 929
  existing rows analyzed and `Negative` (correct — the old workflow stored negatives only).
- Workflow promoted. Manual validation runs `14992`–`14995` (07:45) and scheduled run
  `15000` (08:00) all succeeded.
- **Open defect found 2026-08-25 — the watermark never advances on a no-qualifying-posts
  pass.** `Run State.last_successful_run_at` is still `null` in production after five runs.
  Execution `15000` reports `lastNodeExecuted: "Keep Posts With 10+ Replies"` — no post
  cleared the 10-reply filter, so the flow ended there and neither `Advance Run State` nor
  `Advance Run State (Quiet Pass)` executed. There are two distinct quiet cases and only one
  is handled:

  | Quiet case | Path | Watermark |
  | --- | --- | --- |
  | Posts qualified, no new replies | `If Has New Replies` → `Advance Run State (Quiet Pass)` | advances ✅ |
  | **No posts qualified at all** | flow ends at `Keep Posts With 10+ Replies` | **never advances** ❌ |

  Severity is **cost, not correctness** — the watermark erring stale causes re-reads, never
  gaps, so no reply can be missed. But while it stays `null`, `Build Replies Query` falls
  back to the full 7-day window, so the next active run pays a full backfill instead of an
  incremental fetch. In production, where ~35% of runs fetch nothing, this can strand the
  watermark for long stretches and silently withhold most of the saving.

  Fix: route the empty output of `Keep Posts With 10+ Replies` (and, for the same reason, the
  no-tracked-users and no-posts-returned paths) into `Advance Run State (Quiet Pass)`. A pass
  that legitimately found nothing to do is still a successful pass. Add a pinned case for it —
  staging validation passed only because its runs always had a qualifying post.

- Not yet proven in production: the reply-read drop. No active run has happened
  post-promotion, so the saving is applied but unmeasured. Re-check after the first run that
  clears the reply filter. **Still unproven as of 2026-08-25** — production
  `last_successful_run_at` is still `null`.

- **Second defect from this same promotion, found and fixed 2026-08-29 — production never
  actually stored the per-reply sentiment.** The table above lists "Per-reply sentiment" as
  delivered, and in staging it was. In production only half of it shipped: `Filter Negative
  Replies` was removed, but `Insert or update replies` kept the old four-column mapping
  (`reply_id`, `text`, `post_id`, `created_at`). `sentiment` and `analyzed_at` were computed
  by `Prepare Reply Data` and then discarded at the upsert, and the node's `columns.schema`
  cache still described a 4-column table. The mapping was lost in the staging → production
  copy; staging (`l4eKZucUZXzfz0H8`) had all six columns the whole time.

  Consequence had it bitten: `Get Stored Post Counts` filters on
  `analyzed_at IS NOT NULL` split by `sentiment`, so every stored count would collapse to 0,
  `negative_ratio` would come from the current run's slice alone instead of stored+new, and
  the `>= 0.5` gate would alert on different posts. `Get Reply Status Counts` (the hidden vs
  visible denominators in the alert) breaks the same way.

  **It never bit.** The last pass that analyzed replies ran 2026-08-24 21:00:35, before the
  regression; every hourly run since was a quiet pass. All 929 rows still carry a sentiment
  and an `analyzed_at`, and no row was ever written NULL — so there is nothing to backfill.

  Fixed by copying staging's `columns` object onto the production node and publishing:
  `f155fb3d-61b3-45fa-81dd-37703a2f6522` became `activeVersionId` 2026-08-29 10:12:36 UTC.

  **The lesson is about the tests, not the mapping.** Every fixture in
  `tests/n8n/scheduled-tracking-pins/` pins the credentialed nodes, so none of them can see
  what a Postgres node writes; all six non-watermark fixtures passed against the broken
  workflow (`18658`–`18664`). `ratio-from-stored-rows` even asserts "non-negative sentiment
  persisted", but greps the execution data for `"sentiment":"Positive"` — emitted by
  `Prepare Reply Data` regardless of the upsert. New coverage:
  `tests/n8n/reply-sentiment-persistence.test.mjs` leaves `Insert or update replies` unpinned
  and asserts against the table, with mixed Positive/Neutral/Negative replies (a
  negatives-only fixture passes on stale data, since every existing row was already
  `Negative`). Verified red before the fix (`18671`, all three rows NULL) and green after
  (`18680` persistence, `18682` cross-pass ratio 10/12 = 0.8333 from a live unpinned
  `Get Stored Post Counts`). Synthetic rows snapshotted and removed; zero residue.

  **Confirmed end-to-end on real data, staging, 2026-08-29.**
  `tests/n8n/reply-sentiment-live-staging.test.mjs` runs the real pipeline on post
  `2089952031398125613` (@lynnharfoush, 108 real replies): real X reply search, real OpenAI,
  real upserts, real stored counts, real Telegram. Only `Get posts of tracked users` and
  `Get Run State` are pinned, neither on the write path. 106 retrievable replies were split
  into 53 deleted (INSERT path) and 53 nulled (ON CONFLICT UPDATE path) with 2 left as the
  stored baseline — execution `18761` stored all 106 with a sentiment and an `analyzed_at`
  across three distinct labels, `analyzed_count 108` = stored 2 + new 106,
  `negative_ratio 0.7963`, and delivered Telegram `message_id 174` to chat `8677383067`.
  Everything snapshotted and restored byte-identical. Re-classification agreed with the
  previously stored label 95/106 — useful baseline for the sentiment-accuracy task.

Watermark fix — staging and production, 2026-08-25:

A third quiet case existed beyond the two tabled above, and a fourth problem in the opposite
and more dangerous direction.

Quiet cases, all three now reaching `Advance Run State (Quiet Pass)`:

| Quiet case | New path |
| --- | --- |
| Posts qualified, no new replies | `If Has New Replies` (false) → `If Safe To Advance Watermark` |
| No post cleared the 10-reply filter, **or the posts search returned nothing** | `Keep Posts With 10+ Replies` → `If Any Post Qualified` (false) → `Assess Quiet Outcome` |
| No active tracked users | `If Scheduler Should Continue` (false) → `Assess Quiet Outcome` |

Not a simple rewire: an n8n Filter that passes zero items emits nothing to connect to, so
`Keep Posts With 10+ Replies` now carries `alwaysOutputData: true` and branches through an
`If`. Chosen over a Merge because the filter's own output already distinguishes the two
outcomes, so no extra join was needed, and over checking item count downstream because
`Build Replies Query` already returns `[]` on empty input and would have swallowed the signal.

**Truncation did NOT block the watermark — confirmed broken, and this is the direction that
loses data.** `If Fetch Truncated` was wired as a branch *parallel to* `If Has New Replies`,
so it raised `SEARCH_PAGE_CAP_REACHED` while the watermark advanced anyway via whichever
writer the other branch reached. Replies past the page cap were never requested again. Under
the old full-refetch behaviour a truncated page was self-healing; incrementally it is
permanent. Both writers now sit behind a gate reading `fetch_truncated`, and the analyzed
gate's false branch continues to `Get Reply Status Counts` so scoring, storage and alerting
still happen — only the watermark write is skipped.

Validation on `l4eKZucUZXzfz0H8`, watermark writers left unpinned so the UPDATE really runs:

| Case | Execution | Result |
| --- | --- | --- |
| No qualifying posts (the reported bug) | `15043` | advanced to `09:00` ✅ |
| No tracked users | `15044` | advanced to `09:10` ✅ |
| Truncated posts search | `15045` | held ✅ |
| Truncated replies, quiet branch | `15046` | held ✅ |
| Clean quiet replies (control) | `15047` | advanced to `09:35` ✅ |
| Truncated replies, analyzed branch | `15048` | held ✅ |
| Clean analyzed pass (control) | `15049` | advanced to `09:55` ✅ |

Staging `Run State` was snapshotted and restored to `2026-08-25 07:26:29.825+00`.

The OpenAI abort path has no fixture — forcing it needs a live failing model call. Proved by
reachability against the live graph instead: from `Analyze Sentiment with ChatGPT` output 1 the
reachable set is `Probe OpenAI Error Reason` → `Build Sentiment Failure Alert` → `Build
Scheduler Developer Alert` → `Send Scheduler Developer Alert`, containing neither writer.

Fixtures: seven `watermark-*` files added to the existing
`tests/n8n/scheduled-tracking-pins/`, with `run-pins.sh` extended to snapshot `Run State`,
assert the stored value, and restore it. Every other fixture in that directory pins both
watermark writers, so the UPDATE never ran and its reachability was never tested — that is
precisely why this survived staging validation. The full suite (6 pre-existing + 7 new) passes
13/13 against staging, so the rewire caused no regression.

Promoted to production `Emb26wP77eFXgnVi` the same day (18 operations, subgraph verified
node-for-node and edge-for-edge identical to the validated staging one beforehand; 38 → 42
nodes, still active). Confirmed live with the zero-side-effect case first:

| Production check | Execution | Result |
| --- | --- | --- |
| Truncated posts search — must hold | `15074` | `Run State` untouched, both columns ✅ |
| No qualifying posts — must advance | `15075` | wrote `2026-08-25 09:00:00+00` ✅ |

`Run State.last_successful_run_at` was then restored to `null`. Deliberate: the fixture's
timestamp is fabricated, and leaving it would falsely assert that replies before 09:00 had
been processed — the exact failure this fix exists to prevent. The next real run will set it
honestly.

Residue check: staging `Run State` restored to `2026-08-25 07:26:29.825+00`; production back
to `null` with `updated_at 2026-08-25 08:00:12.165824+00`.

Mistake worth recording: the first version of the new fixtures did not pin
`Send Scheduler Developer Alert`, so the two truncated-replies fixtures sent six real staging
developer alerts across the validation runs. Fixed — all seven now pin it, and the truncation
assertion checks `SEARCH_PAGE_CAP_REACHED` in the execution data, proving the alert was
*built* without sending. No production alert was sent.

Watermark regression resolved — 2026-08-27:

**The cause was not the one written up on 2026-08-25. The fix was never published.** The
watermark rewire was saved to the production draft as version `796403a8` at 2026-08-25 10:23
and left there. Production's `activeVersionId` stayed `560b69f9`, the 38-node pre-fix graph,
and executed it for two days — hence `last_successful_run_at` still `null` with `updated_at`
frozen at `2026-08-25 08:00:12`.

The `activeVersionId` trap recorded in the *next_token* entry directly above caught this same
promotion a second time, in the same session that recorded it.

Two claims in the 2026-08-25 diagnosis were checked against live data and are **false**:

| Claim | Reality |
| --- | --- |
| `alwaysOutputData` does not fire when a Filter's discard branch is populated | It does. Staging `16402`: two posts in, both discarded, filter emits `main[0] = [ {} ]` beside `main[1] = [ 2 posts ]`; `If Any Post Qualified` runs and the watermark advances. |
| Fixture `watermark-no-qualifying-posts` feeds zero posts, so the production shape was untested | It already feeds two posts with `reply_count` 2 and 9 — both discarded. That *is* the production shape. |
| Production executions `15074` / `15075` confirmed the fix live | They were `test_workflow` runs, which execute the **draft**. No evidence about the published version. |

The graph needed no rewire. Verified before publishing that the production draft's watermark
subgraph was node-for-node and edge-for-edge identical to the validated staging one, and that
the draft differed from the live active version by exactly the watermark fix — one
`alwaysOutputData` flag and eight connection changes, no credential, model or schedule drift.

Published `796403a8`; re-read confirms `versionId == activeVersionId == 796403a8`,
`sameAsDraft: true`, 42 nodes, still active.

Validation:

- Full staging suite 13/13 before the change (`16403`–`16415`), Run State snapshotted and
  restored to `2026-08-25 07:26:29.825+00` each time.
- New fixture `watermark-all-posts-discarded` — staging `16418`. It pins production's exact
  live shape: three posts across two authors, all below the threshold, `null` watermark. It
  asserts a discarded post id appears in the execution data, so it cannot pass by accidentally
  exercising the empty-input path.
- The three must-not-regress behaviours re-verified against the published graph: truncation
  gates (`fetch_truncated` on both writers), the OpenAI abort path (reachable set from
  `Analyze Sentiment with ChatGPT` output 1 is `Probe OpenAI Error Reason` → `Build Sentiment
  Failure Alert` → `Build Scheduler Developer Alert` → `Send Scheduler Developer Alert`,
  containing neither writer), and all three quiet cases.

Guard added so this cannot recur silently: `run-pins.sh` now refuses to run against an
**active** workflow whose `versionId` differs from its `activeVersionId`, naming both. A green
pinned suite against an unpublished draft is precisely what happened here, twice.

Production proof — real scheduled runs, not fixtures. **22 consecutive hourly runs**
(`16436` at 2026-08-27 20:00 through `17034` at 2026-08-28 17:00), all `success`, all
terminating on a watermark writer:

| Run | Started | Terminated at | `last_successful_run_at` written |
| --- | --- | --- | --- |
| `16340` (pre-publish) | 08-27 19:00:11 | `Keep Posts With 10+ Replies` | `null`, `updated_at` frozen at 08-25 08:00:12 |
| `16436` | 08-27 20:00:11 | `Advance Run State (Quiet Pass)` | `2026-08-27 20:00:12.168+00` ✅ |
| `16455` | 08-27 21:00:11 | `Advance Run State (Quiet Pass)` | `2026-08-27 21:00:12.214+00` ✅ |
| `16506` | 08-28 00:00:11 | `Advance Run State (Quiet Pass)` | `2026-08-28 00:00:12.234+00` ✅ |
| `16698` | 08-28 07:00:11 | `Advance Run State (Quiet Pass)` | `2026-08-28 07:00:12.185+00` ✅ |
| `16929` | 08-28 14:00:11 | `Advance Run State (Quiet Pass)` | `2026-08-28 14:00:12.453+00` ✅ |
| `17034` | 08-28 17:00:11 | `Advance Run State (Quiet Pass)` | `2026-08-28 17:00:12.330+00` ✅ |

Stored state at 2026-08-28 17:43 UTC: `last_successful_run_at 2026-08-28 17:00:12.33+00`,
`updated_at 2026-08-28 17:00:17.376464+00` — matching the newest run exactly, versus three
days frozen before. Six runs spread across the whole window were opened individually; every
one wrote its own start time. Workflow re-checked after the day: still
`versionId == activeVersionId == 796403a8`, active, 42 nodes, error workflow and tag intact.

`16436` also kills the `alwaysOutputData` theory on production's own data, not just staging's.
`Keep Posts With 10+ Replies` emitted `main[0] = [ {} ]` — the injected placeholder, its
`pairedItem` naming all six input items — alongside `main[1] = [ 6 real posts, all
reply_count 0 ]`. A populated discard branch does not suppress the placeholder. The chain then
ran `If Any Post Qualified` (false) → `Assess Quiet Outcome`
(`NO_QUALIFYING_POSTS`, `posts_truncated: false`, `fetch_truncated: false`) →
`If Safe To Advance Watermark` (output 0) → the writer.

**The reply-read saving is applied but still unmeasured.** Every one of these 22 runs was
quiet — all 22 `Posts` rows are `Ignored`, so nothing cleared the 10-reply filter and
`Build Replies Query` never ran. What is now fixed is that the watermark no longer sits at
`null`, so the next run that *does* qualify will fetch incrementally instead of paying a full
7-day backfill. Confirm the read count on the first active run.

Not re-verified in production: the truncation **hold** taking its false branch live. Running
that fixture writes production `Run State` and the sandbox refused the command. Evidence
standing in its place: all three hold cases pass on staging, the published production
watermark subgraph is node-for-node and edge-for-edge identical to the validated staging one,
and every production run above shows the gate executing live and reading `fetch_truncated`
(`false` on all of them, so output 0). Worth closing with one deliberate production run of
`watermark-truncated-posts-holds` when someone can approve it — it is the zero-side-effect
case, asserting the marker does **not** move.

### Honour `next_token` on both X searches

- Status: **done — promoted to production and verified 2026-08-25**
- Priority: high
- Complexity: `M`
- Source: discovered 2026-08-24 while validating Phase 1; `docs/architecture/limits-and-capacity.md` §4

Design:

1. Neither `Get posts of tracked users` nor `Get Replies` read `meta.next_token`, so both took
   the first page and discarded whatever a token pointed at.
2. **`result_count < max_results` does not by itself mean the result set is complete.**
   `search/all` pages over time slices, so only the *absence* of `next_token` proves
   completeness. Both calls were returning a token while far under their page size.
3. Implemented with the HTTP Request node's built-in token pagination
   (`options.pagination.pagination`), so no graph cycle and the bearer credential stays on the
   node: `paginationMode: updateAParameterInEachRequest`, `next_token` as a `qs` parameter,
   `paginationCompleteWhen: other` with `completeExpression: {{ !$response.body.meta.next_token }}`,
   `requestInterval: 1100` to respect X's 1 request/second ceiling.
4. Page caps are **not silent** (`limits-and-capacity.md` §4). `Attach replies to posts` groups
   response pages back to the chunk that produced them and checks whether that chunk's last
   page still carried a token; if so `If Fetch Truncated` routes `Build Truncation Alert` into
   the existing developer-alert path as `SEARCH_PAGE_CAP_REACHED`.
5. `max_results` stays at the ceiling — 500 for replies, raised 50 → 100 for posts. X bills per
   **resource returned**, not per request, so a smaller page size costs exactly the same while
   multiplying request count and latency.

Measured outcome (live staging `14597`, full backfill with a null watermark):

| Search | Page 1 | Page 2 | Net new rows |
| --- | --- | --- | --- |
| `Get Replies` | 108 replies, `next_token` present | 1 reply — id `2089972330982207972`, which is page 1's `oldest_id` — no token | **0** |
| `Get posts of tracked users` | 2 posts, `next_token` present | 1 post — id `2089952031398125613`, page 1's `oldest_id` — no token | **0** |

**The token was a boundary artifact at this volume, not evidence of lost data.** Following it
re-returns the previous page's last item and then terminates. Database state was unchanged
after the paginated backfill (181 replies, post `2089952031398125613` still 108 analyzed / 81
negative / `0.750000`), which confirms the single page had already been complete.

An earlier revision of this file claimed truncation was "happening at every volume, in both
environments, today" and that stored ratios were therefore a lower bound. **That was
overstated** and is corrected here: nothing was being lost at current volumes.

What the change genuinely buys:

- Completeness is now **proven each run** rather than assumed. Previously "complete" and
  "truncated" were indistinguishable from the workflow's point of view.
- At real volume the token stops being an artifact — a conversation with more replies than one
  page returns, or more posts than one page holds, would have been silently cut.
- It matters more under incremental fetching than it did before. A truncated page used to be
  transient, because the next hourly pass re-read the whole window. Now the watermark advances
  past unread replies and they are never requested again, so truncation would be permanent.
  That is why detection routes to an alert instead of failing quietly.

Cost:

- The two searches behave differently, verified on steady-state run `14600`:
  - **Replies**: on a quiet pass X returns `result_count: 0` with **no token**, so it is a
    single request returning zero resources. Pagination costs nothing in steady state, and
    only pays a boundary duplicate on passes that actually return replies.
  - **Posts**: the 7-day discovery window always contains posts, so this one paginates on
    **every** run and pays one duplicate boundary resource each time - about $0.005/run,
    ~$3.65/month at current scale. That is the standing price of proving completeness on
    post discovery.
- Raising the posts page size costs nothing (billing is per resource returned).

Validation:

Pinned fixtures live in `tests/n8n/scheduled-tracking-pins/`; run them with `./run-pins.sh`.
All 6 fixtures / 22 assertions pass (executions `14637`-`14642`).

- ✅ Pagination runs to exhaustion on real data — `14645`, with `max_results` temporarily
  shrunk to 10 so the existing 108-reply conversation spans many pages: **14 real pages**
  consumed, `replies_truncated: false`.
- ✅ Page-cap detection fires on real data — `14644`, `max_results=10` with `maxRequests=3`:
  stopped on the cap at 3 pages / 29 replies, `replies_truncated: true`, and
  `SEARCH_PAGE_CAP_REACHED` raised on the developer-alert path via the real `pairedItem`
  grouping. Pinned `pagination-page-cap-truncated` covers the same logic without X calls.
- ✅ Boundary duplicates do not double-count — `14645` fetched 121 rows for a 108-reply
  conversation; 121 - 108 = 13 = one repeat per page transition across 14 pages, all absorbed
  by the `seen` set (`new_reply_count: 0`). Confirms the duplicate is a pagination boundary
  artifact rather than new data.
- ✅ Multi-page completion is not mistaken for truncation — pinned
  `pagination-multi-page-complete`: 3 pages, final page token-free, `replies_truncated: false`.
- ✅ The empty-alert chain is safe — pinned `no-post-crosses-threshold`: replies stored with
  sentiment, ratio `0.1`, `alert_now: false`, no alert built. This path only exists because
  storage stopped being gated on the threshold.

**Simulating a high-volume conversation:** shrink `max_results` rather than waiting for a
big post. At `max_results=10` a 108-reply conversation becomes 14 pages, which reaches every
pagination path. Committed values are `max_results=500` / `maxRequests=20` for replies and
`max_results=100` / `maxRequests=10` for posts; both temporary changes above were reverted
and re-verified.

- Still unproven: **multi-chunk** truncation grouping — two chunks where only the second is
  cut. Pin data cannot set `pairedItem`, and staging has never had the 16+ candidate
  conversations needed to produce two chunks live. Single-chunk grouping is covered.

Open Questions:

- `maxRequests` is 20 for replies (up to 10,000 replies, ~$50 worst case per chunk) and 10 for
  posts. Those caps are a runaway guard, not a tuned value. Revisit if a real high-volume post
  ever trips `SEARCH_PAGE_CAP_REACHED`.

Notes:

- Implemented with node-level pagination rather than a `SplitInBatches` cycle specifically
  because the replies query already fans out one item per conversation chunk; nesting a loop
  inside that fan-out is where this gets fragile.
- A Code node calling `this.helpers.httpRequest` was rejected as an approach: Code nodes cannot
  carry credentials, so the X bearer token would have had to be handled in plaintext.

Production promotion evidence (2026-08-25):

- Migrations on `jxnzdxyhoakpfmkbjdeq`: `xmonitor_phase1_incremental_replies`,
  `xmonitor_phase1_backfill_legacy_reply_sentiment`,
  `xmonitor_phase1_backfill_ignored_inwindow_posts`.
- Workflow `Emb26wP77eFXgnVi`: 40 operations, 8 new nodes, `Filter Negative Replies` removed.
  Activation, trigger, error workflow and all six credential bindings preserved; model still
  `gpt-5.4-mini`.
- **Published explicitly.** An active n8n workflow runs a *published* version, not the draft.
  After the edits `versionId` was `560b69f9` while `activeVersionId` was still the old
  `f5ed183e`, so production was executing the pre-promotion workflow. `test_workflow` runs the
  draft, so pinned tests passed against changes that were not live. Always check
  `activeVersionId` after editing an active workflow.
- Pinned production tests: all 6 fixtures / 22 assertions pass (`14990`-`14995`).
- First scheduled production run `15000` (mode `trigger`) succeeded. It terminated at
  `Keep Posts With 10+ Replies` because both in-window posts are `Ignored`, so no conversation
  qualified. Posts query paginated correctly (8 + 1 boundary duplicate), author enrichment came
  from `Tracked Users` with no `includes.users`, and the watermark correctly stayed null - there
  was no reply read to attest to.
- Final production data state: 0 unscored reply rows, 0 posts without a denominator, 668
  non-`New` statuses preserved, and **0 ratio mismatches** against a recompute from the reply
  rows.

**Regression found 2026-08-25 16:00 — the quiet-pass fix does not fire in production.**

> **Superseded 2026-08-27 — the analysis below is wrong.** The symptom was real; the cause
> was not. Production never ran the graph this section reasons about: version `796403a8` was
> written to the draft and never published, so `Emb26wP77eFXgnVi` kept executing the 38-node
> pre-fix `560b69f9`. `alwaysOutputData` is not at fault and the fixture did reproduce the
> production shape. Kept verbatim because the reasoning is plausible and someone will
> re-derive it; see "Watermark regression resolved — 2026-08-27" in *Stop re-reading every
> reply every hour* for the disproof and the fix.

`Run State.last_successful_run_at` is still `null` eight hours after promotion, across at
least six successful scheduled runs (`15117`, `15136`, `15155`, `15176`, `15193`, `15215`).
Every one terminates at `lastNodeExecuted: "Keep Posts With 10+ Replies"`; `If Any Post
Qualified`, `Assess Quiet Outcome` and the writers never execute.

The wiring and the flag are both correct — verified in the export: the filter carries
`alwaysOutputData: true`, and `main[0]` connects to `If Any Post Qualified`, whose false
branch reaches `Assess Quiet Outcome` → `If Safe To Advance Watermark`. The problem is the
node's runtime behaviour. Execution `15215` output:

```
main[0] = []                         <- kept, empty
main[1] = [ 1 post, reply_count 0 ]  <- discarded
```

`alwaysOutputData` injects a placeholder item only when a node returns **no data at all**.
A Filter with a populated discard branch *has* returned data, so branch 0 stays genuinely
empty and nothing downstream runs.

**Why staging validation passed anyway.** Fixture case `15043` is "no qualifying posts", but
it exercises *zero posts reaching the filter* — both branches empty, `alwaysOutputData` fires,
branch 0 gets its placeholder, the chain runs. Production's real shape is different: posts
exist and are all discarded. Those are two different paths through `alwaysOutputData` and only
the first was ever tested. Same failure class as the original defect — the fixture did not
reproduce the production shape.

Practical effect: the watermark now advances only when the posts search returns literally
nothing, which is rare. Production is still paying the full-window price on every active run,
so Phase 1's saving remains unrealised.

Fix direction: do not depend on `alwaysOutputData` for this. The decision needs to sit on a
path that always executes — a spine from the trigger feeding a Merge, or the qualification
test moved ahead of the filter — rather than on a branch that only exists when the filter
emits nothing at all. Whatever is chosen, the new fixture must supply **posts that all fail
the 10-reply test**, not an empty input, or it will pass without proving anything.

Follow-up this promotion exposed:

- **Un-ignoring a post does not trigger a re-backfill.** Legacy rows on an `Ignored` in-window
  post are marked Negative with the historical denominator preserved. If such a post is later
  set back to `New` while still inside the lookback window, the replies query only fetches
  replies newer than the watermark, so its non-negative legacy replies are never recovered and
  `Get Stored Post Counts` returns a negatives-only denominator, skewing its ratio high. Narrow
  edge, but worth closing when the suppression model is next touched: un-ignore should reset
  that post's participation and force a full re-fetch for it.


### Fix destructive `/track` delete before onboarding a second client

- Status: done
- Priority: critical
- Complexity: `L`
- Source: architecture review 2026-08-24, `docs/architecture/multi-tenant-and-web-ui.md` §1.1

Design (as built):

1. `Clear Tracked Users For Chat` was a Supabase `delete` on `Tracked Users` whose only
   condition was `user_id neq` with no value, so it matched every row. With
   `Posts_user_id_fkey` and `Replies_post_id_fkey` both `ON DELETE CASCADE`, one `/track`
   from any chat deleted every tracked account, post, and reply globally.
2. `db/migrations/2026-08-24-tracked-users-soft-delete.sql` adds `telegram_chat_id` (owner)
   and `is_active`, adds `tracked_users_active_owner_idx`, and moves `Posts_user_id_fkey` to
   `ON UPDATE CASCADE ON DELETE RESTRICT`. `Replies_post_id_fkey` deliberately stays
   `CASCADE`. Applied to staging and production.
3. The node became a chat-scoped `is_active = false` update, renamed
   `Deactivate Tracked Users For Chat`. `Clear Telegram User Links` had the *same* unscoped
   defect and is now chat-scoped too — the architecture doc's claim that it was correctly
   scoped was wrong.
4. Both schedulers' `Get Tracked Users` now filter `is_active = true`.

Three further defects were found by testing and fixed in the same change:

- `Upsert Tracked X User` was a Supabase *create*, not an upsert. It only ever worked
  because the delete emptied the table first, so under soft-delete it failed on
  `Tracked Users_pkey`. It is now a Postgres `INSERT ... ON CONFLICT DO UPDATE`, guarded so
  one chat cannot take over another chat's handle.
- Both destructive steps ran *before* `If Track Users Input Valid`, so an invalid `/track`
  tore down the caller's tracking and never restored it. They now run on the valid branch.
- Moving them there starved `Split Users To Track` of its input, making `/track` report
  success while doing nothing. `Restore Track User List` bridges the parsed handle list.

Validation:

- Full evidence in `tests/n8n/telegram-router-risky-pins/TRACK-FIX-EVIDENCE.md`.
- Staging live runs with the Supabase nodes unpinned: `14509` (re-track restores state),
  `14512` (invalid input non-destructive), `14515` (ownership takeover blocked). Row counts
  1/1/73 unchanged throughout; a seeded second chat was never touched.
- Production: migration applied, router `268c0f65`, scheduler `f5ed183e`, pinned run `14529`.
  Counts unchanged at Tracked 3 / Posts 22 / Replies 927.
- Regression: existing fixture `hide-replies-success` still passes (`14519`).

Notes:

- Supersedes the completed task *Cascade staging tracked-user deletes to posts and replies*.
  That migration silenced a foreign-key error by making the delete cascade, which is what
  turned an unscoped delete into a global wipe.
- New fixtures `track-users-soft-delete.pinData.json` and
  `track-users-invalid-input.pinData.json`, both registered in the fixture `manifest.json`
  and described in its README.
- Two non-destructive gaps remain, both tracked in the evidence file: a blocked ownership
  takeover still reports success to the caller, and a failed X lookup leaves the caller's
  accounts deactivated because only the parse, not the lookup, precedes the deactivate.
- `XMonitor - Scheduled Post Tracking Native Sentiment Staging` (`f2eFqB2wO91HAYMJ`) still
  reads `Tracked Users` unfiltered; MCP access is disabled on that workflow so it could not
  be updated.

### Skip already-hidden replies during hide action

- Status: done
- Priority: medium
- Complexity: `M`
- Source: request, 2026-07-07

Design:

1. Skip replies already marked `Replies.status = 'hidden'` before calling X during normal hide actions.
2. Keep replies with missing status, non-hidden status, or `hide_failed` eligible for X hide attempts so retries still work.
3. Preserve X response classification, including `already_hidden`, because X can still report that state for rows not marked hidden locally.
4. Report locally skipped replies as `Already hidden locally` in the Telegram summary.
5. Capture X hide rate-limit headers and cache them in workflow static data by endpoint and X account.
6. Use fresh cached quota before hiding: skip the batch when no calls are available, partially limit attempts when quota is low, and tell the user when to retry.
7. Keep live `429` handling actionable by classifying it as `x_rate_limited` and including the retry timestamp when X provides one.

Validation:

- Staging router `oLwwjO05IcRjtF8E` was implemented and published on 2026-07-11 as active version `da08d89d-8f7c-49c0-b9c2-5d22fe48f5f5`.
- Pinned staging validation: `4246` all-success path, `4247` grouped provider failures, `4248` local hidden skip with `New` and `hide_failed` still attempted, `4249` all-hidden branch with no X/Supabase writes and no no-replies developer alert, `4251` `429` retry timestamp, `4256` zero-quota precheck, and `4257` partial quota.
- Production router `cWczsttyDbTBbRAC` was updated on 2026-07-18 and published as active version `af18a788-3d18-4f50-9d2d-c39df4e2ef30`.
- Pinned production validation after promotion: `5742` all-hidden branch skipped X and developer alert, `5743` skipped one local hidden row and attempted two retryable rows, `5744` zero-quota precheck skipped X, `5745` partial quota attempted one and skipped two, `5746` `429` retry timestamp, and `5747` existing grouped provider failures.
- Validation used pinned X, Telegram, and Supabase nodes. No production X hide write, Telegram send, or successful production Supabase mutation was performed.

Open Questions:

- None.

Notes:

- The implementation trusts local `Replies.status = 'hidden'`. If a reply is manually unhidden on X later, a separate force-refresh or force-hide path would be needed.
- `hide_failed` rows remain retryable.
- A true side-effect-free preflight for the hide endpoint is not available; the rate-limit gate uses the last observed X response headers as a best-effort guard.
- Exploratory staging execution `4252` and production execution `5741` failed validation because stale/pre-promotion code reached fake-token X calls and fake Supabase upserts. Both failed before any valid X hide or successful Supabase mutation; final validation pins include downstream guardrails.

### Generate supportive order comments instead of counter replies

- Status: done
- Priority: high
- Complexity: `M`
- Source: request, 2026-07-07

Design:

1. Update the Telegram router `/order_comments` branch so comment generation is no longer framed as one counter reply per stored negative reply.
2. Generate a provider-ready list of positive comments that support the original post or its author. The comments should feel natural and varied, with short sentences, occasional emoji, and no obvious templated repetition.
3. After `/order_comments POST_ID`, open a required Telegram number form so the user chooses the exact amount to generate. Validate the response as a whole number from `10` to `250` before reading the post or invoking generation.
4. Stop using existing reply text or reply count as creative or quantity input. Generated comments should be anchored to the original post/author instead of rebutting individual replies.
5. Keep the current SMM comment service constraints in mind: at least `10` comments and at most `250` comments for service `8404`, unless the provider config changes.
6. Change the data flow so generated comments can feed the Telegram preview and SMM order payload directly. The workflow should no longer save `counter_reply_text` back onto each `Replies` row as part of normal order-comments generation.
7. Require the generated unique-comment count to equal the user's validated form amount before previewing or ordering.
8. Update naming and user-facing copy away from "counter replies" toward "supportive comments" or similar wording in router nodes, Telegram preview text, command descriptions, workflow docs, local exports, and risky-path fixtures.
9. Keep staging as the first target. Promote to production only after pinned staging validation and explicit approval for production changes, preserving production credentials, activation state, webhook behavior, and SMM provider settings.

Validation:

- Run pinned Telegram router order-comments tests with OpenAI output pinned to a realistic supportive-comments list. Verify the generated comments are short, varied, positive toward the post/author, and not direct rebuttals to individual negative replies.
- Verify the order-comments path no longer writes generated comment text to `Replies.counter_reply_text` or depends on reading saved counter replies before building the SMM payload.
- Update and run the pinned success fixture for `tests/n8n/telegram-router-risky-pins/order-comments-confirm-success.pinData.json`, confirming the Telegram preview and SMM request payload use the generated supportive comments directly.
- Update and run the pinned provider-error fixture for `tests/n8n/telegram-router-risky-pins/order-comments-provider-error.pinData.json`, confirming error handling still normalizes and reports the provider failure without saving per-reply counter text.
- Inspect `Order Info.request_payload` shape in pinned validation to ensure comment text, comment count, provider service ID, post ID, and status fields remain compatible with order status polling.
- Keep OpenAI calls, Telegram sends, Supabase writes, and SMM provider requests pinned unless the user explicitly approves a live staging order-comments test.

Open Questions:

- None.

Notes:

- Previous staging/production behavior loaded stored negative replies, generated Lebanese Arabic counter replies, saved those generated values back to `Replies.counter_reply_text`, previewed them in Telegram, and then built the SMMWiz payload from the saved reply rows.
- The `Replies.counter_reply_text` column can remain for backward compatibility unless a separate schema cleanup task is requested; this task is only to stop writing and depending on it for new comment orders.
- `scripts/set-telegram-bot-commands.ps1` now describes `/order_comments` as generating supportive comments for the staging command menu.
- On 2026-07-07, staging router `oLwwjO05IcRjtF8E` was updated and published as active version `53d2dc66-0a8c-464f-aeed-b498366f8678`.
- The staging branch now uses `Build Supportive Comment Prompt`, `Generate Supportive Comments`, `Supportive Comments Parser`, and `OpenAI Chat Model - Supportive Comments`.
- Removed the previous `Split Counter Replies`, `Loop Counter Replies`, `Save Counter Reply`, and `Get Fresh Counter Replies` path from staging. `Build Comment Order Payload` now reads generated `supportive_comments` directly, so new staging comment orders do not save generated comment text to `Replies.counter_reply_text`.
- Pinned staging validation passed: execution `3915` for confirmed comment order success, execution `3916` for canceling at confirmation, and execution `3917` for provider insufficient-funds error handling. OpenAI, Telegram sends/sendAndWait, Supabase writes, and SMM requests were pinned; no live order was placed.
- Staging Telegram command menu was reapplied for `@XmonitorBetaBot` in both default and `all_private_chats` scopes after updating the `/order_comments` description.
- On 2026-07-11, the live staging router was retrieved through n8n MCP as the source of truth, updated, and published with `113` nodes. After pinned validation, its current active version is `707ef1c8-9eda-48ca-823c-7d8770d663cc`.
- `/order_comments POST_ID` now opens `Prompt For Comment Amount`, validates a required whole-number amount from `10` to `250`, and carries that exact requested count through generation and the SMM payload. `Get Replies For Comment Order` was removed because stored reply rows no longer determine quantity or prompt context.
- Pinned staging validation passed without live external actions: execution `4244` propagated a requested amount of `12` through generation and `Order Info.request_payload`; execution `4241` covered cancellation; execution `4242` covered the provider-error branch; and execution `4245` rejected amount `9` before post lookup, generation, or ordering.
- The staging Telegram command menu was reapplied for `@XmonitorBetaBot` in both default and `all_private_chats` scopes with the amount-form description.
- On 2026-07-11, the validated branch was promoted to production router `cWczsttyDbTBbRAC` and published as active version `e5c172c3-106c-46ef-8d93-e95a3bb25c54` with `113` nodes. Production credentials, OAuth behavior, active state, and error workflow `UmKr9JkZ3ec3GDH5` were preserved.
- Pinned production validation passed without live external actions: execution `4258` propagated a requested amount of `12`; execution `4259` covered cancellation; execution `4260` covered provider failure; and execution `4261` rejected amount `9` before post lookup, generation, or ordering.
- The production Telegram command menu for `@trackedUsersManagerBot` was updated and verified in both default and `all_private_chats` scopes.


### Cascade staging tracked-user deletes to posts and replies

- Status: done, then **reversed on 2026-08-24** — see *Fix destructive `/track` delete before
  onboarding a second client*. Making the delete cascade silenced a foreign-key error but
  turned the branch's unscoped delete into a global wipe of every tracked account, post, and
  reply. `Posts_user_id_fkey` is now `ON DELETE RESTRICT`; `Replies_post_id_fkey` keeps the
  cascade added here.
- Priority: high
- Complexity: `L`
- Source: request, 2026-07-07

Design:

1. Investigated latest failed Telegram router staging execution `3906`.
2. Confirmed `/track RebelHam_` reached `Clear Tracked Users For Chat` and failed because `Posts_user_id_fkey` blocked deletion of `Tracked Users.user_id = 951803761`.
3. Applied Supabase migration `20260707173226_cascade_tracked_user_posts_and_replies` so `Tracked Users -> Posts` and `Posts -> Replies` both use `ON DELETE CASCADE`.
4. Added `posts_user_id_idx` and `replies_post_id_idx` to cover the foreign-key columns used by cascaded deletes.

Validation:

- Live constraint readback confirmed `Posts_user_id_fkey` and `Replies_post_id_fkey` now have `on_delete = CASCADE`.
- Rollback-only Supabase test inserted a temporary tracked user, post, and reply, deleted the tracked user, and confirmed all three rows were gone before rolling back.
- Post-migration performance advisor no longer reports unindexed foreign keys for `Posts_user_id_fkey` or `Replies_post_id_fkey`.

Open Questions:

- None.

Notes:

- Before the migration, staging had `RebelHam_` (`951803761`) with `2` stored posts and `31` stored replies, which explained the delete failure.
- The newly created `posts_user_id_idx` is immediately reported as unused by the advisor because it has not accumulated usage stats yet; keep it for foreign-key delete performance.

### Fix production workflow error-alert coverage

- Status: done
- Priority: high
- Complexity: `M`
- Source: request, 2026-07-07

Design:

1. Created a production-specific error workflow, `XMonitor - Production Developer Error Alerts` (`UmKr9JkZ3ec3GDH5`), instead of reusing the staging developer alert workflow.
2. Attached the production handler through `settings.errorWorkflow` on all production workflows that should report unhandled failures: Scheduled Post Tracking, Telegram Router, X OAuth Callback, and Order Status Polling.
3. Used production message copy and the `TrackedUsersManager` Telegram credential for the production alert send node.
4. Preserved production activation state, credentials, webhook paths, schedules, and workflow node graphs while updating only the error workflow settings.

Validation:

- MCP node configuration validation passed for `Error Trigger`, `Build Production Error Alert`, and `Send Production Error Alert`.
- MCP full-workflow validation passed before creation.
- Pinned execution `3901` verified the production alert message build with the Telegram send node pinned, so no live Telegram message was sent.
- Live REST readback on 2026-07-07 confirmed `settings.errorWorkflow = UmKr9JkZ3ec3GDH5` for `Emb26wP77eFXgnVi`, `cWczsttyDbTBbRAC`, `JQ9KM3l1kRJQhWxb`, and `AqdNgOKRXG6J5zbj`.
- A live production failure was intentionally not triggered because it would send a production Telegram alert.

Open Questions:

- None.

Notes:

- Initial inspection found only Scheduled Post Tracking pointed at the staging error workflow `CCzwnMyoy7UequuI`; Telegram Router, X OAuth Callback, and Order Status Polling had no production error handler.
- `XMonitor - Order Status Polling` remains unavailable in MCP, so its live settings were verified and updated through the n8n REST API.
- The new production error workflow is inactive by design for an Error Trigger workflow and is invoked by linked production workflow failures.

### Show clearer hide-reply failure reasons

- Status: done
- Priority: high
- Complexity: `M`
- Source: request, 2026-06-30

Design:

1. Improve hide-reply transparency so Telegram output explains why hiding a reply failed when a failure occurs.
2. Capture provider error details safely without leaking credentials, raw tokens, headers, or overly noisy response bodies.
3. Surface actionable failure categories such as missing auth, insufficient X scope, non-owner moderation attempt, reply not found, already hidden, rate limit, or provider/network error.
4. Send a sanitized developer alert only when at least one reply hide attempt fails.

Validation:

- Staging router `oLwwjO05IcRjtF8E` was updated on 2026-07-05 with X hide full-response capture, per-reply failure classification, grouped user summaries, and a developer alert only when hide failures occur.
- Pinned staging validation executions: `3715` for the all-success hide path and `3716` for partial hide failures covering `missing_moderation_permission` and `reply_not_found`.
- Live staging validation on 2026-07-05 used Supabase post `2060604129798496702`, unhid three real replies on X in temporary helper execution `3731`, then re-hid `20` real replies and reproduced one synthetic failure in temporary helper execution `3732`. The synthetic row was deleted afterward; final Supabase check showed `20` replies, `20` hidden, `0` `hide_failed`, and `0` probe rows remaining.
- Production router `cWczsttyDbTBbRAC` was promoted on 2026-07-05. Pinned production validation execution `3736` covered the all-success hide path (`total=2`, `hidden=2`, `failed=0`, no developer alert). Pinned production validation execution `3737` covered partial failures (`total=3`, `hidden=1`, `failed=2`) with grouped `missing_moderation_permission` and `reply_not_found` reasons plus one developer-alert payload.
- Live mutation of auth scopes/tokens was intentionally not used to recreate `missing_moderation_permission`; pinned executions cover that branch because changing stored OAuth state would be a higher-risk test.

Open Questions:

- None.

Notes:

- Production workflow remained active after promotion and now has `114` nodes.
- Live X writes were performed only in staging after explicit approval; production validation was pinned and did not call X, write Supabase rows, or send Telegram messages.

### Add snooze duration menu and promote to production

- Status: done
- Priority: high
- Complexity: `L`
- Source: request, 2026-06-30

Design:

1. Add a fixed snooze duration menu for Telegram alert callbacks and `/snooze POST_ID`.
2. Support direct slash-command duration selection with `/snooze POST_ID 1h`, `/snooze POST_ID 4h`, `/snooze POST_ID 12h`, and `/snooze POST_ID 24h`.
3. Send the duration menu as a new Telegram message so the original alert remains unchanged.
4. Map selected duration options to hourly scheduler runs in `Posts.snooze_runs_remaining`.
5. Promote the validated staging behavior to production and keep local exports plus workflow docs aligned.

Validation:

- Staging Telegram router `oLwwjO05IcRjtF8E` was validated with pinned executions `3265` for menu rendering, `3266` for valid `12h`, `3267` for invalid duration rejection, and `3269` for missing post ID rejection.
- Production Telegram router `cWczsttyDbTBbRAC` was validated with pinned execution `3338` for `snooze:<post_id>` reaching `Send Snooze Duration Menu`.
- Production pinned execution `3339` verified `snooze_duration:<post_id>:24h` applies `24` snooze runs.
- Pinned production validation avoided real Telegram sends and production DB writes.
- Scheduled expiry uses the existing hourly `Advance Post Suppression State` behavior in `XMonitor - Scheduled Post Tracking`, which decrements `snooze_runs_remaining` and resumes expired snoozes.

Open Questions:

- None.

Notes:

- Production commit: `245a381` (`Add production snooze duration menu`) on `main`.
- Production help text now describes `/snooze POST_ID` as choosing how long to snooze alerts.
- Current fixed options are `1h`, `4h`, `12h`, and `24h`.
