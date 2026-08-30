# XMonitor — Limits and Capacity Register

Every external limit the system runs against, what we currently spend against it, what
breaks when it binds, and what to do about it.

Written 2026-08-24. Measurements come from production execution `14472`
(`Emb26wP77eFXgnVi`, 2026-08-24T11:00Z). Anything not measured is labelled as an estimate.

**Read the summary first — the conclusion is not the one the design assumed.**

---

## 0. Summary

| Rank | Constraint | Status | Lever |
| --- | --- | --- | --- |
| 1 | **X charges $0.005 per post returned, and we re-read every reply hourly** | **Measured 167× overpay on replies; ~$147/mo at 3 accounts. Fixed in staging 2026-08-24, not yet in production** | Incremental fetch via `start_time` |
| 2 | **Hide is 50 per 15 min per X account** | Bites on any post with >50 negative replies | Durable queue with scheduled drain |
| 3 | OpenAI re-analyses the same replies hourly | Same 167× volume overpay as #1. Fixed in staging alongside it | Store sentiment per reply |
| 4 | Full-archive query length 1024 chars | Breaks the replies query at ~20 conversations. Chunked at 15 in staging 2026-08-24 | Chunking |
| 5 | Telegram `callback_data` 64 bytes | Constrains multi-tenant button payloads | Never put `client_id` in a callback |
| 6 | X search rate limits | **0.2% utilised — a non-issue** | Nothing |

**A second X app does not help.** It buys app-level rate headroom we are nowhere near
using, does nothing about cost (billing is per resource, whatever app asks), and for the
hide endpoint its benefit is undocumented and would cost every client a second OAuth
authorization. Detail in §2.3.

---

## 1. X API — cost

X moved to **pay-per-usage credits** during 2026; the legacy Basic/Pro monthly tiers were
deprecated on 21 May 2026 and migrated subscribers to per-request billing. Charging is
**per resource returned**, not per request.

| Resource | Price | Where we hit it |
| --- | --- | --- |
| Post | **$0.005** each | every post *and every reply* returned by search |
| User | **$0.010** each | `includes.users` on the post search, `/users/by/username` on `/track` |
| Owned read | $0.001 each | not used today |
| Post create | $0.015 (or $0.200 with a link) | not used today |

Monthly cap on pay-per-usage: **3 million post reads per billing cycle.** Auto-recharge
fires at most once every five minutes.

> **Confirmed 2026-08-24: the account is on pay-per-usage.** The figures below are live, not
> hypothetical.

### 1.1 What we measured

Execution `14472`, one hourly pass, three tracked accounts:

| Call | Returned | Note |
| --- | --- | --- |
| `Get posts of tracked users` | **8 posts** + 3 users | `next_token` present — more available, never paginated |
| `Get Replies` | **42 replies** | `next_token` present |

That is 50 post-resources and 3 user-resources per run:

```
per run    50 × $0.005  +  3 × $0.010   =  $0.28
per month  730 runs     × $0.28         ≈  $204
```

### 1.2 The actual problem

`Build Replies Query` sets a `query` and nothing else — **no `start_time`, no `since_id`.**
Every hour it re-fetches the complete reply history of every qualifying conversation in the
7-day window, and pays full price for every one of them.

The Michel Helou post in that run had 42 replies and was published 21 August. It will be
re-read on every pass until it leaves the 7-day window — roughly **168 times**. Each of
those 42 replies costs $0.005 per read, so a single reply costs about **$0.84 over its
lifetime instead of $0.005**.

The same replies are also re-sent to OpenAI 168 times.

### 1.3 Projection

**Revised 2026-08-25 from 43 measured production runs** (`13875`-`14965`, 2026-08-22T20:00 to
2026-08-25T07:00) rather than the single run in §1.1. Per-run means across that window:
8.19 posts, 3.00 users, 26.19 replies, giving **$0.2019/run → ~$147/month**.

The earlier ~$204/month figure came from extrapolating one *active* run. Both are correct for
what they measure: an active run costs $0.27-0.28, but 35% of runs fetched no replies at all
because the qualifying posts were snoozed or ignored, so the true mean is lower. **Suppression
is itself a cost control** — `Advance Post Suppression State` removes blocked posts before the
replies query runs.

Per-account rates derived from that window: 2.73 posts/run, 8.73 re-read replies/run, and
**0.24 genuinely new replies per active run** (the tracked conversation grew 39 → 46 over 29
consecutive hourly runs). The workflow was therefore paying for ~40 replies every hour to
discover a quarter of one — a **167× overpay**, confirming the ~168× estimate in §1.2 from
measurement rather than arithmetic.

| Accounts | Clients | Before | Phase 1 + pagination | Also incremental posts |
| --- | --- | --- | --- | --- |
| 3 | 1 | $147 | **$35** | $5 |
| 6 | 2 | $295 | **$66** | $6 |
| 15 | 5 | $737 | **$157** | $8 |
| 30 | 10 | $1,474 | **$309** | $12 |
| 45 | 15 | $2,211 | **$462** | $16 |
| 75 | 25 | $3,685 | **$771** | $28 |

Phase 1 plus pagination removes **76-79%** at every scale. The remaining spend is then almost
entirely post discovery: at 15 accounts it is **97% posts query, 3% replies**. Making post
discovery incremental is the next lever and is worth far more than anything left on the reply
side, but it needs the live-conversation table described in §1.4, because the conversation set
must still span the whole window.

Cost per post over its 7-day life, by engagement — this is the shape change, not just a level
change. Before, cost scaled with *total* replies re-read hourly; after, with replies read once:

| Replies on the post | Before | After | Overpay |
| --- | --- | --- | --- |
| 40 (the post measured in prod) | $33.60 | $0.20 | 168× |
| 500 | $420 | $2.50 | 168× |
| 2,000 (modestly viral) | $1,680 | $10 | 168× |
| 10,000 | $8,400 | $50 | 168× |

A single reply costs **$0.84 over its lifetime before, $0.005 after**, regardless of scale.

The 3M post-read cap is not the binding constraint — even at 75 accounts *before* the fix we
would use ~21% of it. **Cost binds long before the cap does.**

**Where the page cap bites.** `maxRequests=20` × `max_results=500` is 10,000 replies per
*chunk*, and a chunk holds up to 15 conversations — so the cap trips when the average
qualifying post exceeds roughly **666** replies, not 10,000. This only matters on a backfill
pass over the full window; in steady state a chunk returns almost nothing. Hitting it raises
`SEARCH_PAGE_CAP_REACHED` rather than truncating silently, which matters because incremental
fetching would otherwise move the watermark past replies that were never read.

### 1.4 Fix: fetch incrementally

Both searches accept `start_time`. Set it to the previous successful run's timestamp rather
than "seven days ago", and each pass reads only what appeared since.

- **Replies query** — `start_time = last_successful_run_at`. Returns only new replies. This
  is the ~90% saving, and it is close to a one-line change.
- **Posts query** — `start_time = last_successful_run_at` for *discovery* only. We no longer
  need to re-read a post to learn its reply count, because we count replies ourselves.
- **Conversation set** — must still span the whole lookback window, because a four-day-old
  post can get new replies today. That is a query-length problem, not a cost problem, and
  §4 handles it by chunking.

**This only works if reply sentiment is stored per reply.** The ratio has to be computed
from stored rows plus the new arrivals, which is exactly the `Replies.sentiment` +
`analyzed_at` column pair the architecture already proposes. The cost saving and the
OpenAI saving are the same change.

Two things to get right: the first run after deploying needs a one-off backfill over the
full window, and `last_successful_run_at` must be persisted (a `Clients` column or a small
`Run State` table) and only advanced on a **successful** pass — otherwise a failed run
silently creates a permanent gap in reply coverage.

---

## 2. X API — rate limits

Official figures, `docs.x.com/x-api/fundamentals/rate-limits`:

| Endpoint | Per app | Per user | Our use |
| --- | --- | --- | --- |
| `GET /2/tweets/search/all` | 1/sec, **300 / 15 min** | 1/sec | **2 requests/hour** |
| `GET /2/tweets/search/recent` | 450 / 15 min | 300 / 15 min | not used |
| `PUT /2/tweets/:id/hidden` | — | **50 / 15 min** | the real constraint |
| `GET /2/users/by/username/:username` | 300 / 15 min | 900 / 15 min | only on `/track` |

### 2.1 Search — not a problem, and never will be

Two search calls an hour against a 300-per-15-minute budget is **0.2% utilisation**. Even at
50 clients with chunked queries this stays trivial. The 1-request-per-second ceiling means a
chunked fan-out needs a small delay between chunks — the existing `Wait` node already
provides it. Nothing else to do here.

### 2.2 Hide — the one that actually bites

**50 per 15 minutes, per X user.** The bucket belongs to the token, so every tracked account
has its own: 15 accounts is 750 hides per 15 minutes in aggregate, but still only 50 for any
one account. It binds whenever a single post needs more than 50 replies hidden — which, on a
post like the one in run 14472, is entirely realistic.

Today the router reads the rate-limit headers into **n8n workflow static data**, and when
quota runs out it hides what it can, skips the rest, and tells the user to retry manually.
Three problems: the cache is per-workflow (wrong — limits are per token), it is invisible to
the console, and "retry manually" is not moderation, it is homework.

**Fix — a durable queue with a scheduled drain.** This is the mechanism you proposed, and it
is the right one.

```sql
create table public."Moderation Queue" (
  id         uuid primary key default gen_random_uuid(),
  action_id  uuid not null references public."Action Log"(id) on delete cascade,
  client_id  uuid not null references public."Clients"(id) on delete cascade,
  post_id    text not null,
  reply_id   text not null,
  x_user_id  text not null,              -- whose 50/15min bucket this spends
  status     text not null default 'queued'
               check (status in ('queued','in_flight','done','failed','abandoned')),
  attempts   integer not null default 0,
  not_before timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  unique (reply_id)                       -- one pending hide per reply, ever
);
create index moderation_queue_due_idx
  on public."Moderation Queue"(x_user_id, not_before)
  where status = 'queued';
```

How it runs:

1. `replies.hide` claims its rows (the `claimed_by` update in the architecture doc §6.4) and
   **enqueues all of them** rather than calling X inline.
2. `XMonitor - Moderation Queue Drain`, every 5 minutes: for each `x_user_id` with due rows,
   read `X Rate Limits` for that token, take at most `remaining` rows, hide them, write the
   response headers back.
3. On `429`, or when `remaining` is 0 and `reset_at` is in the future, set
   `not_before = reset_at` for that token's rows and stop. No burnt requests.
4. Update `Action Log.result` after every drain pass. **Decided 2026-08-24: live progress.**
   The drain edits the original Telegram message in place — `editMessageText` on the
   `message_id` stored in `Action Log.result` — so it reads *"38 of 120 hidden · resuming
   14:15"* and refreshes each pass. The console gets the same thing free through a Realtime
   subscription on the `Action Log` row. Message edits are cheap and do not count against
   the 1-message-per-second send limit in any meaningful way, but the drain must store the
   `message_id` at enqueue time or it has nothing to edit.
5. `attempts >= 5` → `abandoned`, with the reason surfaced. Permanent failures (deleted
   reply, revoked token, non-owner) must not be retried — they are already classified by
   `Prepare Hide Result`, so reuse those categories.

The drain replaces the static-data cache entirely, and it is what makes the console's
"hide 120 replies" button honest.

### 2.3 Would a second X app help? Mostly no

| Endpoint class | Second app helps? | Why |
| --- | --- | --- |
| Search, user lookup (app-only bearer) | Technically yes | A second app is a second bearer token and a genuinely separate per-app bucket. But we use 0.2% of the first one, so this solves nothing. |
| **Cost** | **No** | Billing is per resource returned, regardless of which app asked. Two apps on one developer account draw the same credit balance. |
| **Hide (per-user)** | **Unknown — must be tested** | X documents the limit as "Per User" without stating whether the bucket is per user or per (user, app). Historically per-user limits were per access token, which would mean a fresh bucket — but X has since added account-level caps that may cut across apps. |

Even if the hide bucket does turn out to be per (user, app), the cost is that **every client
must authorize a second app** during onboarding, and we store and refresh two token sets per
account — for at best a 2× improvement on a limit the queue already handles gracefully.

**Recommendation: build the queue, skip the second app.** If you want the question settled
anyway, it is a ten-minute test:

1. Authorize one staging X account under both apps.
2. Burn its hide quota under app A (50 calls in a window).
3. Immediately call hide under app B and read `x-rate-limit-remaining` on the response.

`remaining: 49` means separate buckets. `429`, or a value continuing app A's count, means one
shared bucket and the idea is dead. Record the result here either way.

---

## 3. X API — auth and token limits

| Limit | Value | Exposure |
| --- | --- | --- |
| Access token lifetime | 2 hours | `Validate X Auth Account` refreshes within a 2-minute buffer. Fine. |
| Refresh token rotation | single-use — each refresh returns a new one | **A failed write after a successful refresh loses the account permanently.** Persist the new refresh token before using the new access token, and never run two refreshes for one account concurrently. Two front ends make that race real. |
| PKCE auth session | 10 minutes (ours, not X's) | Fine. |
| Scopes | `tweet.moderate.write` required to hide | A client who authorizes without it fails at hide time, not at connect time. The console's Accounts screen should check `scope` and flag it. |

Refresh-token rotation is the quietest way to lose a client's connection, and it gets riskier
the moment the console can trigger actions concurrently with Telegram. Serialise refresh per
`x_user_id` — an advisory lock on the account row is enough.

---

## 4. X API — request shape

| Limit | Value | Where it bites |
| --- | --- | --- |
| Query length, `search/all` | **1024 chars** self-serve, 4096 enterprise | `(conversation_id:… is:reply)` is ~50 chars each → **~20 conversations max**. Post 21 returns 400 and kills the run. |
| Query length, `search/recent` | 512 chars self-serve | not used |
| `from:handle` cost | ~21 chars each | ~48 handles. At 15 accounts (~315 chars) this is comfortable. |
| `max_results` | 10–500 (`search/all`) | Currently 50 for posts and 500 for replies, with `next_token` ignored — so results are silently truncated. |

Fix: build each chunk by measuring the assembled string, not by counting items, and honour
`next_token` up to the client's `max_posts_per_run`. Reply chunking at **15 conversations**
stays in Phase 3 — it is the only shape limit that binds at your stated scale.

---

## 5. OpenAI

| Limit | Exposure | Mitigation |
| --- | --- | --- |
| **Credit balance** | Already caused a silent 26-hour outage from 2026-08-23 13:00 UTC | Handled — `Probe OpenAI Error Reason` classifies exhausted credits vs rate limiting and raises `SENTIMENT_NO_OPENAI_CREDITS`. Add a low-balance warning before it hits zero. |
| RPM / TPM per tier | One request per run today | Not binding. Per-post batching will raise request count; stay under tier limits by batching per post, not per reply. |
| Context window | All posts and all replies go in **one JSON blob** | Breaks as clients are added. Batch per post. |
| Cost | Re-analyses the same replies ~168× | Same fix as §1.4 — only send replies where `analyzed_at is null`. |

Model is now `gpt-5.4-mini` (switched 2026-08-24 from `gpt-5.4` to cut cost), so the
per-token rate is already reduced; the **volume** is where the remaining waste is.

---

## 6. Telegram Bot API

| Limit | Value | Exposure |
| --- | --- | --- |
| Per chat | **1 message/sec** | Fine now. A fan-out that alerts 5 clients about several posts each must pace per chat, not globally. |
| Per group | **20 messages/min** | Only if a client uses a group chat. |
| Global broadcast | **~30 messages/sec** | Never close. |
| Message text | **4096 characters** | A hide summary listing many failed reply ids can exceed this. Truncate with a count, or send a follow-up. |
| **`callback_data`** | **1–64 bytes** | **Design constraint.** `snooze_duration:<19-digit post id>:24h` is 39 bytes. Adding a `client_id` uuid (36 chars) would blow past 64. **Never put tenancy in a callback — resolve the client from the post id.** This is why the design authorizes by looking the post up. |
| Bot token → webhook | one webhook per token | One bot, many chats is fine. A second router on the same bot steals the first one's updates. |
| 429 | returns `retry_after` | The router should honour it rather than failing the action. |

---

## 7. SMMWiz

| Limit | Value | Exposure |
| --- | --- | --- |
| Rate limit | **Undocumented** | Probe it before the order queue matters. Assume conservative and serialise. |
| Comment quantity | 10–250 (service `8404`) | Enforced in `Validate Comment Order Input`. |
| Account balance | Unknown to us until an order fails | **An order fails at placement with a provider error.** Add a balance check before placing, and surface it in the console. |
| Cancellation | **None** | A placed order cannot be recalled. This is why idempotency on `order.*` actions is non-negotiable. |

**Decided 2026-08-24: no cap. Record spend instead.** Clients keep full ordering rights and
nothing blocks a provider call; the control is visibility after the fact.

That works, because `Order Info.charge` is already populated with real figures — verified
live: `0.1935` for 50 likes, `0.79305` for a comments order, both `USD`. Three gaps to close
before it counts as reporting:

| Gap | Fix |
| --- | --- |
| No tenant column | `Order Info.client_id` (already in the architecture migration) |
| `quantity` is `NULL` on comment orders — the count lives in `comment_count` | any report must `coalesce(quantity, comment_count)` |
| `charge` arrives only on the **first poll**, up to 30 minutes after placement | show placed-but-unpriced orders as pending, not as $0 |

```sql
create view public."Client Spend" with (security_invoker = true) as
select client_id,
       date_trunc('month', created_at) as month,
       order_type,
       count(*)                                   as orders,
       sum(coalesce(quantity, comment_count))     as units,
       sum(charge) filter (where charge is not null) as charged,
       count(*) filter (where charge is null and normalized_status not in ('failed','canceled'))
                                                  as awaiting_price
from public."Order Info"
group by 1,2,3;
```

**Shipped 2026-08-30** to staging (`npytqidroqxgikaqofmq`) and production
(`jxnzdxyhoakpfmkbjdeq`) as `db/migrations/2026-08-30-client-spend-view.sql`. The live view
adds `currency` to the select list as well as the grouping, so the console can render it.
Verified against the three real production orders: `0.0387` (Jun, 10 likes), `0.79305`
(Jul, comments -- `units` 15 via `coalesce(quantity, comment_count)`, proving gap 2), and
`0.1935` (Aug, 50 likes) -- all USD, all `client_id` populated, `awaiting_price` 0. Note
that `currency` is written by the same poll that writes `charge`, so an order that is still
`awaiting_price` also has a NULL currency and lands in its own group; render that group as
a dash, not as a currency, and never as $0.

The console's Orders screen surfaces this as a running month-to-date total per client. If a
bill ever surprises you, add `Clients.monthly_order_cap` later — the executor is the one
place that would need to check it, so the door stays open.

### 7.1 Keeping the recording accurate

With no cap, the record *is* the control, so it has to be trustworthy. Nine things, in
descending order of how badly they hurt.

#### 1. A transient poll error erases a charge you already captured — **live bug**

`Update Order Info Status` writes `charge = $5::numeric` unconditionally on every poll, and
`charge` is parsed from the provider response with `toNumber(firstPresent(['charge'…]))`. A
poll that returns an error, or a response without a `charge` field, therefore **overwrites a
previously recorded figure with `NULL`**. The order keeps polling, so it usually recovers —
but if that error poll happens to land on the transition to a final status, the charge is
lost permanently and the row goes final at `NULL`.

```sql
-- never regress a known value to null
charge      = coalesce($5::numeric, charge),
currency    = coalesce($8,          currency),
start_count = coalesce($6::integer, start_count),
remains     = coalesce($7::integer, remains)
```

**Correction to an earlier revision of this file**, which said to leave `remains` alone
because it "legitimately decreases". That reasoning was wrong: `coalesce` only substitutes
when the new value is `NULL`, and `coalesce(0, remains)` still yields `0`, so a countdown to
zero is unaffected. Coalesce all four. `NULL` from the provider means *"did not tell us"*,
and for every one of these columns the last known value is a better answer than nothing.
(The earlier revision also cited `$9` for currency; the parameter is `$8` — `$9` is
`last_error`.)

This is the cheapest fix on the list and the only one correcting active corruption.

#### 2. Money can be spent with no row at all — **write-ahead the intent**

`Insert Order Info` runs **after** `Place Comment Order` / `Place Likes Order`. If the HTTP
call succeeds at SMMWiz and the workflow then dies — network timeout on the response, n8n
restart, expression error in a downstream node — you have been charged and there is no
record anywhere. SMMWiz has no cancel and no "list my orders" endpoint, so that spend is
invisible forever.

Invert the order:

1. Insert the row **first** with `normalized_status = 'placing'`, the idempotency key, the
   client, post, service and quantity.
2. Call the provider.
3. Update the same row with `provider_order_id`, `provider_add_response` and
   `normalized_status = 'pending'`.

Anything left in `placing` for more than a few minutes is a reconciliation item, not a
silent loss. Add `'placing'` to the `normalized_status` check constraint, and make sure the
sweep that finds them does **not** re-place the order — it flags for a human.

#### 3. Placement must never retry

`Place Comment Order` and `Place Likes Order` carry no explicit `retryOnFail`, so they rely
on the n8n default of `false`. That is correct today but it is a default, not a decision — a
node version bump or a well-meaning edit turns one click into two charges with no way back.
Set `"retryOnFail": false` explicitly on both, and add it to the pinned-test assertions.

#### 4. A fresh order reads `NULL`, not $0 — estimate at placement

`charge` only arrives on the first poll, up to 30 minutes later. Capture the service rate at
placement instead of leaving a hole:

```sql
alter table public."Order Info"
  add column rate_per_1000    numeric,   -- from SMMWiz action=services, cached
  add column estimated_charge numeric;   -- rate_per_1000 / 1000 * quantity
```

Report actual where present, estimate where not, and label which is which. Never sum the two
into one number without saying so.

#### 5. Refunds after a final status are never seen

The poller's due filter is `normalized_status IN ('pending','in_progress')`, so once an
order goes `partial` or `canceled` it stops being polled. SMM providers commonly refund the
undelivered remainder *after* that point, so a partial order over-reports spend permanently.

Fix: on entering `partial` or `canceled`, set `next_check_at = now() + 24 hours` and allow
one final re-poll, then stop for good. Track it with a `final_recheck_done boolean` so it
cannot loop.

#### 6. Daily balance reconciliation — the backstop that catches everything else

Row-level controls only find problems in rows that exist. The only thing that catches a
charge with *no* row — case 2's leftovers, or an order someone places by hand in the SMMWiz
panel — is watching the provider balance.

```sql
create table public."Provider Balance Log" (
  id           bigint generated always as identity primary key,
  provider     text not null default 'smmwiz',
  balance      numeric not null,
  currency     text not null,
  recorded_at  timestamptz not null default now()
);
```

A daily workflow calls the panel's balance action, appends a row, and compares
`previous.balance − current.balance` against `sum(charge)` for the same window. A divergence
beyond a small tolerance is an alert. This is the one control that would have caught a
missing order, and it costs one API call a day.

> Confirm the exact balance parameter against SMMWiz's own documentation before building —
> `action=balance` is the convention across this panel API family, but it has not been
> verified against their endpoint.

#### 7. Stuck orders never resolve their charge

`poll_attempts` is incremented on every poll and **never read**. An order stuck in
`in_progress` is therefore polled every 30 minutes forever, and its `charge` stays whatever
the last poll said. Surface anything non-final after 7 days on the console's Orders screen
and stop polling it after a bounded number of attempts, recording why.

#### 8. Currency must never be summed across values

Every row today is `USD`, but `currency` comes from the provider and nothing enforces it.
The `Client Spend` view groups by `currency` so a second one can never silently distort a
total.

#### 9. `client_id` is set at placement, not derived later

`Order Info` has no FK to `Posts`, which is deliberate — an order must survive its post
being deleted, or spend disappears with the post. But that means `client_id` cannot be
back-derived through the post. Write it at placement from the tracked account and never
null it.

#### Where each fix lands

| Fix | Phase | Cost |
| --- | --- | --- |
| 1 · `coalesce` on poll writes | **now** — independent of everything | one SQL edit |
| 3 · explicit `retryOnFail: false` | **now** | two node flags |
| 2 · write-ahead intent row | 2 (schema) + 5 (executor) | reorders the order branch |
| 4 · rate capture and estimate | 2 (schema) | two columns, one cached lookup |
| 5 · post-final re-poll | 2 | one column, one branch in the poller |
| 6 · balance reconciliation | 2 | one table, one small daily workflow |
| 7 · stale sweep | 4 (console) | a query and a screen section |
| 8 · currency grouping | 2 | already in the view above |
| 9 · `client_id` at placement | 2 | part of the tenancy migration |

Fixes 1 and 3 are worth doing this week regardless of the roadmap — one is repairing active
data loss, the other is removing a double-charge that is currently prevented only by a
default.

---

## 8. Infrastructure

| Limit | Exposure | Action |
| --- | --- | --- |
| n8n Cloud execution concurrency | Unknown — depends on plan | **Check the plan before Phase 3.** A per-chunk fan-out with `Execute Workflow` raises concurrent executions sharply; hitting the cap queues sub-workflows and stretches run time past the hourly window. |
| n8n execution timeout | Plan-dependent | A chunked run is *more* resilient here, not less — each worker is short. |
| n8n execution data retention | Plan-dependent | Execution data is our only forensic record until `Action Log` exists. |
| Supabase connection pool | Shared with FB Monitor in **both** projects | A fan-out that opens a Postgres connection per worker can exhaust the pool. Use the Supabase REST node or the pooler, not direct Postgres, in the workers. |
| Supabase egress / storage | Small at this scale | Watch after the console adds Realtime subscriptions. |
| Vercel free tier | Not yet in use | Adequate for two users. |

---

## 9. What to do, in order

| # | Action | Addresses | Saving / effect |
| --- | --- | --- | --- |
| ~~1~~ | ~~Confirm the X billing model~~ | §1 | **Done 2026-08-24 — pay-per-usage confirmed.** All §1 figures are live |
| 2 | `coalesce` on the poller's `charge`/`currency`/`start_count` writes | §7.1 #1 | stops a transient poll error erasing a captured charge |
| 3 | Explicit `retryOnFail: false` on both SMM placement nodes | §7.1 #3 | removes a double-charge currently prevented only by a default |
| 4 | `start_time = last_successful_run_at` on the replies query + store `Replies.sentiment` | §1.2, §5 | **~90% of X read cost and OpenAI cost** |
| 5 | Chunk the replies query at 15 conversations | §4 | removes the 400 that kills whole runs |
| 6 | Write-ahead intent row before the provider call | §7.1 #2 | no more spend-with-no-record |
| 7 | `Moderation Queue` + 5-minute drain, replacing static data | §2.2 | hides complete instead of asking for a retry |
| 8 | `Order Info.client_id`, rate capture, `Client Spend` view, balance log | §7, §7.1 | makes spend legible and reconcilable without capping it |
| 9 | Serialise token refresh per `x_user_id` | §3 | stops silent account loss |
| 10 | Check n8n concurrency plan before fan-out | §8 | avoids a queued, over-running hourly pass |
| ~~11~~ | ~~Second-app bucket test~~ | §2.3 | **Dropped 2026-08-24** — the queue handles the limit and the test only matters if the queue proves too slow in practice |

Items 2 and 3 are single-line changes that can go this week, independent of every phase.

**Decided 2026-08-24: items 2 and 3 move ahead of the tenancy work**, becoming Phase 1 of the
architecture plan rather than Phase 3. They touch the same nodes as each other, are entirely
independent of tenancy, and every hour of delay costs money at the 168× rate.

---

## Sources

- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X API pay-per-usage pricing](https://docs.x.com/x-api/getting-started/pricing)
- [X API build a query — length limits](https://docs.x.com/x-api/posts/search/integrate/build-a-query)
- [Telegram Bot FAQ — broadcasting limits](https://core.telegram.org/bots/faq)
- Production execution `14472` (`Emb26wP77eFXgnVi`), 2026-08-24T11:00Z
