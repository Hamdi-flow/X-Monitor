# XMonitor - Moderation Queue Drain

This doc covers **both** environments. They are structurally identical — same nodes,
same wiring, same pinned settings — differing only in credentials, webhook path,
error workflow, and Vault secrets.

| | Staging | Production |
| --- | --- | --- |
| n8n ID | `xt8fLOmRvDvTdZT9` | `vm4UNW7OIx2zEGb4` |
| Export | `workflows/staging/xmonitor-moderation-queue-drain-staging.json` | `workflows/active/xmonitor-moderation-queue-drain.json` |
| Webhook path | `/webhook/moderation-queue-drain-staging` | `/webhook/moderation-queue-drain` |
| Supabase project | `npytqidroqxgikaqofmq` | `jxnzdxyhoakpfmkbjdeq` |
| Postgres credential | `Supabase Staging Postgres` | `Supabase Account` |
| Telegram credential | `Testing Telegram API` | `TrackedUsersManager` |
| Error workflow | `CCzwnMyoy7UequuI` | `UmKr9JkZ3ec3GDH5` |

**Production has an unpublished draft (checked 2026-10-16).** Triggers run the published
version `f19a65a0-3710-4528-8d0f-a10aec6ed13d` (2026-08-27). The latest saved version is
`b25fd601-21c3-4982-9008-f2bb073a0a09`, an n8n editor autosave by tarek ismail on
2026-09-02 22:13 UTC that was never published. It changes no nodes and no wiring. It moves
32 of the 34 nodes on the canvas and adds `binaryMode: separate` to the settings. The editor
also dropped three parameters:

- `resource: message` on `Edit Telegram Progress`, which is that parameter's default;
- `additionalFields.appendAttribution: false` on `Edit Telegram Progress`. The Telegram node
  does not show this option for `editMessageText`, so it should not change the edited
  progress message, but that has not been run;
- `responseMode: onReceived` on `Drain Webhook`, which is that parameter's default.

The export holds the draft at top level (`versionId` `b25fd601…`) and the running version
under `activeVersion` (`sameAsDraft: false`, 34 nodes). Publishing or discarding that draft is
the owner's call. Until then, the next production edit that gets published will ship it too.

The two environments use **different** shared secrets, so a leak in one cannot
authorise the other.

| | |
| --- | --- |
| Status | **Active in both environments** since 2026-08-27; `pg_cron` job `moderation-queue-drain` enabled in both |
| Trigger | Webhook `POST /webhook/moderation-queue-drain-staging`, called by `pg_cron` |
| Credentials | `Supabase Staging Postgres`, `Testing Telegram API` |
| Error workflow | `CCzwnMyoy7UequuI` (XMonitor - Staging Developer Error Alerts) |
| Pinned tests | `tests/n8n/moderation-queue-drain.test.mjs` |

## Why this exists

X caps `PUT /2/tweets/:id/hidden` at **50 requests per 15 minutes, per access
token**. The bucket belongs to the token, so every tracked account has its own —
but a single post that needs 120 replies hidden still needs three windows.

The staging Telegram Router used to hide inline and track that limit in n8n
**workflow static data** (`$getWorkflowStaticData('global').xHideRateLimits`).
That was wrong three ways: the cache is per-workflow while the limit is
per-token, nothing outside that one workflow could see it, and when quota ran
out the router hid what it could, silently dropped the rest, and told the user
to retry by hand.

This workflow is the second half of the fix described in
[limits-and-capacity.md §2.2](../architecture/limits-and-capacity.md). The router
now enqueues; this drains. It also closes defect G in
[multi-tenant-and-web-ui.md](../architecture/multi-tenant-and-web-ui.md).

## Tables it owns

Created by `db/migrations/2026-08-26-moderation-queue.sql`.

- **`Moderation Queue`** — one row per reply to hide. `status` moves
  `queued → in_flight → done | failed | abandoned`. `not_before` is the retry
  clock, `attempts` the retry budget, `batch_id` groups one press of the Hide
  button, and `telegram_message_id` is the message this workflow edits.
- **`X Rate Limits`** — `(x_user_id, endpoint)` quota state read from the
  `x-rate-limit-*` response headers. This is what replaced static data.

`action_id` and `client_id` exist on the queue but are nullable and carry no
foreign keys, because `Action Log` and `Clients` do not exist yet. See the
migration header before adding them.

## Flow

```
Drain Webhook                      POST, called by pg_cron only when work is due
  → Verify Drain Secret            constant-time compare, FAILS CLOSED
  → If Drain Authorized
      ├─ false → Reject Unauthorized Drain Call
      └─ true  ↓
  → Find Drainable Tokens          one row per x_user_id with due work, plus its allowance
  → Plan Drain Pass                decides drain / defer / block per token
  → Route Token Plan
      ├─ drain → If Token Needs Refresh
      │            ├─ true  → Prepare Drain Refresh Request → Refresh Drain X Token
      │            │            → Apply Drain Refresh → If Drain Refresh OK
      │            │                 ├─ true  → Upsert Refreshed Drain Account → Ready To Claim
      │            │                 └─ false → Route Refresh Failure → Defer / Fail Token Rows
      │            └─ false → Ready To Claim
      ├─ defer → Defer Token Rows  → Build/Send Developer Alert - Drain Blocked
      └─ block → Fail Token Rows   → Build/Send Developer Alert - Drain Blocked

Ready To Claim
  → Claim Due Hide Rows            atomic, FOR UPDATE SKIP LOCKED, LIMIT = allowance
  → Prepare Hide Requests          attaches the token by x_user_id
  → Hide Reply On X                the only node that spends X quota
  → Prepare Drain Hide Result      classifies every response, decides the next status
  → Persist Queue Outcomes → Persist Reply Statuses → Persist X Rate Limits
  → Defer Rate Limited Tokens
      ├─ → Read Batch Progress → Build Progress Edits → Edit Telegram Progress
      └─ → Build Developer Alert - Drain Failures → Send …
```

## Why a webhook and not a schedule

**n8n bills per execution, and an execution is counted when the trigger fires —
not when the workflow does useful work.** This started life on a 5-minute
Schedule Trigger, which is 288 executions/day, ~8,640/month, almost all of them
spent running `Find Drainable Tokens`, getting zero rows, and stopping.

The 5-minute cadence was not buying throughput either. X allows 50 hides per 15
minutes per token, so during an active batch the passes at +5 and +10 minutes
find allowance 0 and defer by design — two of every three passes were guaranteed
no-ops, which is exactly what `quota-exhausted-mid-batch` pins.

So the polling moved into Postgres, which does not charge per question.
`db/migrations/2026-08-27-moderation-drain-cron.sql` installs `pg_cron` and
`pg_net` and schedules `public.trigger_moderation_drain()` every minute. That
function returns early unless `Moderation Queue` has due rows, and only calls
this webhook when it does:

| Trigger | Executions/month |
| --- | --- |
| Schedule, every 5 min | ~8,640 |
| Webhook driven by `pg_cron` | ~3 per 120-reply hide |

Pickup latency also *improved*, from 5 minutes to 1, because a database tick is
free and an n8n tick is not.

The function returns `idle | in_flight | throttled | unconfigured | fired:<n>`,
all visible in `cron.job_run_details`. It also reclaims `in_flight` rows older
than 15 minutes — without that, a drain pass that dies between claiming and
persisting would strand its rows forever, since nothing else ever looks at
`in_flight`.

### Security

The production webhook URL is publicly reachable, so `Verify Drain Secret`
compares the `X-Drain-Secret` header against `vault.decrypted_secrets`
**in SQL**, returning only a boolean. The secret therefore never enters n8n
execution data, and Vault is the single source of truth shared with the
`pg_cron` caller that signs the request.

It was briefly a Code node reading `$env.MODERATION_DRAIN_SECRET`. **That could
never have worked on n8n Cloud**, which blocks env access inside Code nodes —
a probe returned `"access to env vars denied"`, and `$vars` is present but
empty on this instance. The gate failed closed, so it rejected every call rather
than accepting them, but it was non-functional. There is no
`MODERATION_DRAIN_SECRET` environment variable and nothing needs one.

Verified live on 2026-08-27 against the activated workflow:

| Call | Gate verdict | Nodes reached |
| --- | --- | --- |
| Wrong `X-Drain-Secret` | `authorized: false` | stops at `Reject Unauthorized Drain Call` |
| Correct `X-Drain-Secret` | `authorized: true` | proceeds to `Find Drainable Tokens` |

Note the HTTP response is **not** an auth signal: `responseMode: onReceived`
returns 200 before the workflow runs, so both calls above got a 200. Judge
authorization from the execution, not the status code. That is fine for `pg_net`,
which never reads the body.

Hardening available later: n8n's built-in webhook Header Auth rejects before an
execution is even created, so a bad call costs nothing at all — the current gate
burns one execution to say no. It needs a credential created in the n8n UI
(type **Header Auth**, name `X-Drain-Secret`), which is why it is not wired yet.

### Activating it

Active is not the same as running. An active *webhook* workflow costs zero
executions until something calls it — unlike an active scheduled one. But an
n8n production webhook only answers while its workflow is active, so both halves
must be switched on, in this order:

All three are **done on staging** as of 2026-08-27:

1. ~~Both Vault secrets set~~ (`moderation_drain_webhook_url`, `moderation_drain_secret`).
2. ~~Workflow activated.~~
3. ~~`cron.alter_job(..., active := true)`.~~

The kill switch is the same call with `active := false`: it stops dispatch
immediately and leaves the queue intact.

```sql
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'moderation-queue-drain'), active := false);
```

Confirmed after enabling: with an empty queue the job ticks every minute,
returns `idle`, and makes **zero** HTTP calls — so zero n8n executions. That is
the whole design goal, measured rather than assumed.

## The quota rules

**Allowance.** `Find Drainable Tokens` reads `X Rate Limits` for
`PUT /2/tweets/:id/hidden`. If there is no row, or `reset_at` has passed, the
allowance is the full 50 — that is the real window, not an optimistic guess.
Otherwise it is `remaining`. `Claim Due Hide Rows` then claims at most that many
rows, so a pass never dispatches more requests than X will honour.

**Quota spent (§2.2 step 3).** Allowance 0 with `reset_at` still in the future →
`Plan Drain Pass` returns `mode: 'defer'`, `Defer Token Rows` pushes every queued
row for that token to `not_before = reset_at`, and the pass ends. **No requests
are spent.**

**429.** `Prepare Drain Hide Result` requeues the row, sets `not_before` to the
reset, records `remaining = 0` for that token, and — importantly — **refunds the
attempt** (`attempts_delta: -1`). A 429 says nothing about whether the hide would
succeed; charging it would abandon a healthy row after five busy windows. A plain
429 does not raise a developer alert.

Requests already dispatched within the same pass still complete — n8n cannot
abort an HTTP node mid-item. That window is bounded by the claimed batch size,
which is itself bounded by the live `remaining` header, so in practice a 429
should only appear when another client shares the token.

**`Hide Reply On X` has `retryOnFail` explicitly `false`.** The claim step budgets
exactly the requests X will honour; an n8n-level retry spends one it never
budgeted. Retry belongs to the queue. Pinned by the test file and by the
"Why Hide Reply On X Must Not Retry" sticky note.

## Failure handling

Categories are copied verbatim from the router's old `Prepare Hide Result`, so
classification did not change — only what happens next.

| Outcome | Next status | Retried? |
| --- | --- | --- |
| `hidden: true`, or `already_hidden` | `done` | — |
| `x_rate_limited` | `queued`, `not_before = reset_at`, attempt refunded | yes |
| `x_auth_rejected`, `missing_moderation_permission`, `not_post_owner_or_not_moderatable`, `x_moderation_forbidden`, `reply_not_found` | `failed` | **never** — §2.2 step 5 |
| `x_unavailable`, `network_error`, `x_hide_rejected`, `x_hide_not_confirmed` | `queued` with backoff, or `abandoned` at `attempts >= 5` | yes, up to 5 |

Backoff is `min(2^attempts, 32)` minutes. `failed` and `abandoned` rows set
`Replies.status = 'hide_failed'`, which keeps them eligible for a fresh enqueue
if the user fixes the cause and presses Hide again.

## Live progress (§2.2 step 4)

`Read Batch Progress` recomputes counts from the queue itself — not from
accumulated workflow state — so an edit is correct even if a previous pass
crashed. `Edit Telegram Progress` then edits the message the router sent:

> **Hiding replies**
> Post: `2060604129798496702`
> 38 of 120 hidden
> 82 queued - resuming 14:15 UTC

That node is `onError: continueRegularOutput`. Telegram rejects an edit whose
text is byte-identical to the current message and refuses edits on very old
messages; neither is a drain failure, since the queue work already committed.

The four DB nodes between `Prepare Drain Hide Result` and `Read Batch Progress`
carry `alwaysOutputData: true`. Each ends in a `RETURNING` that legitimately
yields zero rows on an ordinary pass (nothing deferred, nothing rate limited),
and without it the first empty one silently ends the pass — taking the progress
edit and the developer alert with it. They also carry `executeOnce: true`,
because they sit downstream of a `RETURNING` that emits one item per updated row
while reading their own parameters from `$('Prepare Drain Hide Result').first()`.

## Token refresh — needs two environment variables

X access tokens expire in about two hours; a large batch can outlive one. The
drain therefore refreshes, but it does **not** copy the X OAuth client secret
that the router keeps inline in its `Prepare Refresh Request` Code node.
It reads them from the n8n instance environment instead:

- `X_OAUTH_CLIENT_ID`
- `X_OAUTH_CLIENT_SECRET`

**If they are unset**, `Plan Drain Pass` does not fail anything. A token that is
still valid is used as-is; a stale one has its rows **deferred 10 minutes** and
raises a developer alert. A missing env var is an operator problem, not a dead
reply.

If the refresh itself is refused with `invalid_grant` / 400 / 401, the refresh
token is dead and reconnecting is the only fix, so those rows go straight to
`failed`. Transient refresh failures defer instead.

## Verified against live X — 2026-08-27

Run on staging with real posts and replies (@keryxpoc hiding replies authored by
@Hamditlr6), driven end to end by the live `pg_cron` heartbeat. Four things this
found that pinned fixtures could not:

**1. A deleted reply returns 400, not 404.** X answers
`{"title":"Invalid Request","detail":"One or more parameters to your request was
invalid.","type":".../problems/invalid-request"}` with status **400**. The
classifier only treated 404 (or text containing "not found"/"deleted") as
`reply_not_found`, so a deleted reply fell through to the generic
`x_hide_rejected` branch — which is **retryable**, burning all five attempts on a
reply that can never succeed, contradicting section 2.2 step 5. Fixed; the pinned
fixture now carries X's real payload instead of an invented 404.

**2. X will not let you hide your own reply.** A self-authored reply returns a
bare `403 Forbidden` with no detail text. That classifies as
`not_post_owner_or_not_moderatable` — correct — but it means a hide test needs a
reply from a *second* account, which is also the real production shape.

**3. n8n runs a published ACTIVE version, not the draft.** `update_workflow`
edits the draft; webhook and schedule executions run the separately published
active version, and `test_workflow` runs the **draft**. The classifier fix above
passed the entire pinned suite while live traffic kept running the old code.
`publish_workflow` is what closes the gap, and the suite now asserts
`activeVersion.sameAsDraft === true` so this cannot recur silently.

**4. Reply permissions gate test data.** An account can only reply to a post where
it is mentioned or is the author, so the parent tweet has to @-mention the
replying account before it can reply.

What the live run proved directly:

| Behaviour | Observed |
| --- | --- |
| Successful hide | 16 replies genuinely hidden on X, `Replies.status = hidden` |
| Partial allowance | 24 queued with `remaining = 5` → claimed exactly **5** |
| Header write-back | `X Rate Limits.remaining` tracked X's real header (5 → 17 → 3) |
| Real 429 | 5 rows requeued, **attempts refunded to 0**, `not_before` = real reset |
| Token-wide defer | 2 further rows pushed to the reset without being dispatched |
| Zero burnt requests | While deferred, the heartbeat returns `idle` and makes no call |
| Live Telegram progress | Message edited in place, `edit_date` set |
| Multi-row persistence | `jsonb_to_recordset` wrote 18 reply statuses in one call |

Still only pinned, never live: `abandoned` at `attempts >= 5`, because it needs a
*transient* X failure five times over and those cannot be produced on demand.

## Testing

```bash
node tests/n8n/moderation-queue-drain.test.mjs
```

And against production — same fixtures, deliberately, because the two workflows
must behave identically and a fixture that passes in only one is a drift alarm:

```bash
DRAIN_ENV=production node tests/n8n/moderation-queue-drain.test.mjs
```

Fixtures in `tests/n8n/moderation-queue-drain-pins/`. Everything external is
pinned — the webhook trigger, every Postgres node, every Telegram node, and
`Hide Reply On X`. **The X hide endpoint is never called.** What executes is the
decision logic. The test also asserts the workflow is still inactive, that the trigger has not
reverted to a Schedule Trigger, that `Verify Drain Secret` still fails closed,
and that `retryOnFail` / `executeOnce` have not drifted.

| Fixture | Pins |
| --- | --- |
| `quota-exhausted-mid-batch` | 5 rows due, 2 calls left → claims 2; a second token with 0 left is deferred to its reset without spending a request |
| `rate-limit-429` | attempt refunded, `not_before` = reset, `remaining` = 0, token's other rows deferred, no developer alert |
| `permanent-failures` | 404 deleted / 401 revoked / 403 non-owner / 403 missing-scope all → `failed`, never retried |
| `attempts-exhausted` | 503 at `attempts` 5 → `abandoned`; at 4 and 1 → requeued with growing backoff |
| `unauthorized-call` | a wrong `X-Drain-Secret` is rejected at the gate and reaches no X, database, or Telegram node |

## Safety

- **Never activate without explicit user approval.** Active, this hits the live
  X hide endpoint every 5 minutes for whatever is queued. A passing pinned run is
  not approval.
- A live drain also needs a working X connection for the owning account. As of
  2026-08-26 the staging token for `951803761` / `RebelHam_` expired 2026-07-05,
  so a live run needs a fresh `/auth_x` first.
- Snapshot `Moderation Queue` and `Replies.status` before any live run.
