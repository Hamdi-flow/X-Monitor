# XMonitor - Scheduled Post Tracking

## Purpose

Production workflow that periodically scans X posts from tracked users, finds posts with enough replies, labels reply sentiment with OpenAI, stores posts and negative replies in Supabase/Postgres, and sends Telegram alerts for posts where at least half the analyzed replies are negative.

## Identity

- n8n ID: `Emb26wP77eFXgnVi`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-scheduled-post-tracking.json`
- Live description: `Production scheduled post tracking workflow using production Supabase/Postgres/Telegram credentials and shared X/OpenAI credentials.`
- Unhandled error workflow: `XMonitor - Production Developer Error Alerts` (`UmKr9JkZ3ec3GDH5`)
- Last observed live update: `2026-09-04T11:27:17.257Z` (published version `401b14d9-679b-4d74-b69b-3e52afbb490a`, confirmed `versionId == activeVersionId`)

> **Phase 1 promoted 2026-08-25.** This workflow now fetches replies incrementally
> (`start_time` from a persisted `Run State` watermark), stores per-reply sentiment,
> recomputes the negative ratio from stored rows, chunks the conversation query at 15,
> and honours `next_token` on both X searches. Migrations
> `xmonitor_phase1_incremental_replies` and
> `xmonitor_phase1_backfill_legacy_reply_sentiment` are applied to the production
> Supabase project (`jxnzdxyhoakpfmkbjdeq`). Measured cost drops from ~$147/month to
> ~$35/month at three accounts. See `TASK_TODOLIST.md` and the
> [staging doc](./xmonitor-scheduled-post-tracking-staging.md) for the full design.

## Schedule And Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Schedule Trigger` | every `1` hour | Runs the whole tracking process hourly. |
| Lookback window | `Build X API Query` code, `DAYS_AGO` | `7` days | X search `start_time` is set to now minus this many UTC days. |
| Tracked users source | `Get Tracked Users` | Postgres query over `Tracked Users` joined to `Clients`, filtered `tu.is_active` | The workflow builds an X query from each non-empty `username`. Rows a chat has stopped tracking are deactivated rather than deleted, so they must be filtered out here. **T3:** each row now also carries `client_id` and its client's `min_replies`, `negative_threshold` and `lookback_days`, which is how every downstream gate becomes per-client. `Clients` is joined but *not* filtered on `is_active` — deactivating a client must not silently stop collecting its posts; it is dropped at delivery instead. |
| X post search limit | `Get posts of tracked users` | `max_results=50` | Fetches up to 50 matching posts per run from X search/all. |
| Minimum replies | `Keep Posts With 10+ Replies` | `public_metrics.reply_count >= {{ $json.client_min_replies }}` | Posts below their **own client's** `Clients.min_replies` do not get reply sentiment analysis. Was a hardcoded `10` until T3; `10` survives only as the fallback for a post whose client did not resolve. The node name is kept deliberately — `Attach replies to posts` and every pinned fixture reference it by name. |
| X reply search limit | `Get Replies` | `max_results=500` | Fetches up to 500 replies for the collected conversations. |
| Negative threshold | `Calculate/Filter Sentiment Counts` | `negative_ratio >=` the post's `Clients.negative_threshold` | Only posts crossing **their own client's** threshold are alerted. Was a hardcoded `0.5` until T3, which survives as `DEFAULT_ALERT_THRESHOLD` for an unresolved client. The per-post value is read from `post_client_map`, emitted by `Attach replies to posts` and deliberately kept out of the OpenAI payload. |
| OpenAI model | `Analyze Sentiment with ChatGPT` | `gpt-5.4-mini` | Labels every reply as `Positive`, `Negative`, or `Neutral`. Switched from `gpt-5.4` on 2026-08-24 to cut cost; same model generation, so Lebanese-Arabic handling is far closer to `gpt-5.4` than an older mini model would be. |
| Developer alert recipient | `Build Scheduler Developer Alert` | hard-coded chat ID | Used when scheduler validation fails or a client has alerting posts but no eligible recipient. **T3:** `NO_TELEGRAM_RECIPIENTS` is raised per client and the alert names it, because a bare count is unactionable past one client. |

## Main Flow

1. `Schedule Trigger` runs hourly.
2. `Advance Post Suppression State` reads suppressed post IDs from `Posts`, decrements `snooze_runs_remaining` for snoozed posts, and moves expired snoozes back to `New`.
3. `Get Tracked Users` loads the active rows from `Tracked Users`, joined to `Clients`, so each row arrives with its owning `client_id` and that client's thresholds. Deactivated rows are skipped. It keeps `alwaysOutputData` — with zero tracked users the pass must still reach `Build X API Query` to raise `NO_TRACKED_USERS` and take the quiet path.
4. `Build X API Query` builds an X query like `from:user1 OR from:user2`, using a 7-day start time. If no usernames exist, it emits a handled scheduler alert instead of calling X.
5. `Get posts of tracked users` calls X API `https://api.x.com/2/tweets/search/all`.
6. `Split Out Posts`, `Filter Suppressed Posts`, and `Keep Posts With 10+ Replies` reduce the candidates to unsuppressed posts at or above **their own client's** `min_replies`. `Filter Suppressed Posts` is where a post acquires its `client_id` and thresholds, by matching `author_id` against the tracked users loaded in step 3.
7. `Get Backfilled Post Ids`, `Build Replies Query`, `Wait`, and `Get Replies` fetch replies for the remaining conversations. The lookup decides each post's search window: posts that already have stored replies use the run watermark, and posts being fetched for the first time are windowed from their own `created_at`, because on the pass where a post first crosses `min_replies` every reply it already holds is older than the watermark. See [Per-post reply backfill](#per-post-reply-backfill--promoted-2026-09-04).
8. `Attach replies to posts` groups replies under their source post and carries post author plus X total reply count forward. It also emits `post_client_map` — post id to client and thresholds — **outside** the `text` field, so the OpenAI prompt payload is unchanged by T3.
9. `Analyze Sentiment with ChatGPT` labels replies.
10. `Calculate/Filter Sentiment Counts` calculates positive, neutral, negative, total analyzed, and total X reply counts, then sets `alert_now` per post against that post's own client threshold, read from `post_client_map`. It also stamps `client_id` onto each post so the fan-out can route without re-querying.
11. `Prepare Post Data` and `Insert or update posts` upsert matching posts into `Posts`.
12. `Flatten All Replies`, `Prepare Reply Data`, and `Insert or update replies` upsert **every** analyzed reply into `Replies` — positive, neutral and negative alike — each with its `sentiment` and `analyzed_at`. `Filter Negative Replies` was removed when Phase 1 shipped on 2026-08-25; the stored non-negative rows are what make the cross-pass ratio in step 10 correct. See [Per-reply sentiment persistence](#per-reply-sentiment-persistence).
13. `Get Reply Status Counts` counts hidden and visible negative replies for the alerting posts by joining against `Replies.status`, over all stored rows with `sentiment = 'Negative' AND analyzed_at IS NOT NULL`.
14. `Get Alert Recipients` resolves recipients **per owner**: `Client Members` rows for the clients of this pass's alerting posts, where `is_active` and `receives_alerts`, on a client that is itself `is_active`. It `LEFT JOIN`s so a client with no eligible member still returns a row with a null `chat_id`, and it runs `executeOnce` because its parameters come from `$('Split Out Reply Analysis')`, not from its own input.
15. `Build Negative Alert Notification` groups the alerting posts by owner and creates one alert per recipient per post — a chat only ever receives its own client's posts. A client with posts but no eligible recipient produces a `NO_TELEGRAM_RECIPIENTS` item **alongside** the other clients' alerts, so one client's misconfiguration cannot suppress another's.
16. `If Notifications Ready` either sends Telegram alerts or sends a developer alert.

## Data Stores

| Table | Use |
| --- | --- |
| `Tracked Users` | Source of X usernames to monitor. Only `is_active = true` rows are read; `/track` deactivates rather than deletes, and `telegram_chat_id` records the owning chat. |
| `Posts` | Stores posts that crossed the negative sentiment threshold; also stores suppression state via `status` and `snooze_runs_remaining`. |
| `Replies` | Stores every analyzed reply for a qualifying post, keyed by `reply_id`, with `sentiment` (`Positive`/`Neutral`/`Negative`) and `analyzed_at`. Those two columns are the input to every stored-count query; a row without them is invisible to `Get Stored Post Counts` and `Get Reply Status Counts`. `client_id` is not mapped by the upsert — the `replies_set_client` trigger derives it from `post_id`. |
| `Clients` | Per-client `min_replies`, `negative_threshold`, `lookback_days`, `timezone` and `is_active`. Read by `Get Tracked Users` and `Get Alert Recipients`. |
| `Client Members` | The routing table since T3: `client_id` → `chat_id`, gated on `is_active` and `receives_alerts`. |
| ~~`Telegram Users`~~ | **No longer read by this workflow (T3).** The Telegram router still *writes* it, so the table stays in place — dropping it is a later cleanup. A table nothing reads is harmless; removing one something still writes is not. |

## External Side Effects

- Reads from X API search/all using bearer authentication.
- Calls OpenAI for sentiment labeling.
- Writes to production Postgres/Supabase tables `Posts` and `Replies`.
- Sends production Telegram alerts to every configured Telegram user.
- Sends developer Telegram alerts for handled scheduler error states.

## Telegram Alert Actions

Each alert displays the post author, total replies from X, analyzed replies fetched in the current run, negative replies, hidden negative replies, visible negative replies, negative sentiment percentage, and overall sentiment.

Each negative sentiment alert includes inline buttons whose callback data is handled by the Telegram router:

- `snooze:<post_id>`
- `ignore:<post_id>`
- `hide_replies:<post_id>`
- `/order_likes <post_id>`
- `/order_comments <post_id>`

These callbacks make this workflow coupled to the Telegram router command parsing. If button payloads change here, update and test the router too.

## Handled Error Paths

| Condition | Behavior |
| --- | --- |
| No tracked users | `Build X API Query` emits `scheduler_alert_type: NO_TRACKED_USERS`; `If Scheduler Should Continue` routes to developer alert. |
| A client has negative posts but no eligible recipient | `Build Negative Alert Notification` emits one `scheduler_alert_type: NO_TELEGRAM_RECIPIENTS` item **for that client**, naming it; `If Notifications Ready` routes that item to the developer alert while every other client's alerts still send on the true branch. |
| A post whose owning client did not resolve | Treated as the case above with an unresolved client, never broadcast to some other client's chat. Its thresholds fall back to the pre-T3 `10` / `0.5`. |
| OpenAI sentiment call fails | `Analyze Sentiment with ChatGPT` runs with `onError: continueErrorOutput`. Output 1 goes to `Probe OpenAI Error Reason` → `Build Sentiment Failure Alert` → developer alert. See below. |
| Reply or post search hit the page cap | `Attach replies to posts` sets `fetch_truncated`; `If Fetch Truncated` raises `SEARCH_PAGE_CAP_REACHED` on the developer-alert path **and** the watermark is held. See below. |

## Per-post reply backfill — promoted 2026-09-04

Before this, `Build Replies Query` applied one `start_time` to every conversation in the pass:
the run watermark minus a 10-minute overlap. A post is not a reply-fetch candidate until its X
`reply_count` crosses its client's `min_replies`, so on the pass where it first qualified it
already held roughly `min_replies` replies, every one of them older than that one-hour window.
Those replies were never requested, and because the watermark only moves forward they were
never requested again. The gap was systematic, and its size was roughly `min_replies` for every
post that ever alerted.

**How it surfaced.** Post `2095516553672380450` (@michelhelou_lb, House Account):

| | |
| --- | --- |
| Post created | 2026-09-03 14:17 UTC |
| Replies 1 to 9 arrive | 2026-09-03 15:05 to 21:20 |
| First pass where it cleared 10 replies | execution `21420`, 2026-09-04 00:00 |
| `start_time` that pass requested | 2026-09-03 22:50 |
| Stored replies | 4, one per hourly pass at 00:00, 06:00, 07:00, 08:00 |
| Alert sent | execution `21552`, message 1304: total replies 13, analyzed 4, negative sentiment 100% |

None of the nine had aged out of X: a live `conversation_id:` search over the full window
returns `result_count: 13`. The workflow simply never asked.

It stayed invisible because incremental reply fetching shipped 2026-08-25 and
`2095516553672380450` was the only row in `Posts` created since. Every earlier post was
collected under the old full 7-day lookback, which is why their `analyzed_count` equals their
`comment_count`.

**The change.**

| Node | Change |
| --- | --- |
| `Get Backfilled Post Ids` | **New.** Returns the candidate posts that already have an analyzed reply stored, with the candidate ids supplied the same way `Get Analyzed Reply Ids` supplies its own. `executeOnce`, read-only, bound to `Supabase Account` (`Usl8p3UJw2s7aMMe`). Sits between `If Any Post Qualified` and `Build Replies Query`. |
| `Build Replies Query` | Reads its posts from `Keep Posts With 10+ Replies` instead of its own input, which is now a single aggregate row. Splits conversations into an incremental group (watermark window, unchanged) and a backfill group windowed from the post's own `created_at` minus a minute, floored at the 7-day post-search window. Chunks each group independently and stamps `is_backfill` per chunk. |

Splitting was chosen over simply widening the shared window. Widening would re-read every
already-tracked conversation from the oldest new post's creation date and give back most of the
Phase 1 saving; splitting pays a full-history read only for posts never read at all.
Over-reading inside a backfill chunk is harmless, since `Attach replies to posts` dedupes by
`reply_id` and `Get Analyzed Reply Ids` keeps anything already scored out of the OpenAI call.

**Promotion evidence.** Draft `401b14d9-679b-4d74-b69b-3e52afbb490a` published 2026-09-04
11:27 UTC, and `get_workflow_details` re-read afterwards confirms
`versionId == activeVersionId == 401b14d9-679b-4d74-b69b-3e52afbb490a` on a workflow that is
`active: true`, 43 nodes. This is the check that silently shipped nothing twice before.

| Execution | Fixture | Result |
| --- | --- | --- |
| `21617` | `backfill-new-post-full-window` | `is_backfill true`, `start_time 2026-08-24T09:59:00.000Z`, `new_reply_count 4`, `analyzed_count 4`, `alert_now true`; pre-watermark reply `B1001` reached `Prepare Reply Data` |
| `21618` | `pagination-page-cap-truncated` | `replies_truncated true`, `fetch_truncated true`, `SEARCH_PAGE_CAP_REACHED`, `new_reply_count 3`; incremental window unchanged at `13:50:00` |

Staging evidence for the same code is in the
[staging doc](./xmonitor-scheduled-post-tracking-staging.md#per-post-backfill--2026-09-04).

**Recovery of the post that exposed it.** The fix does not retroactively collect replies: a
post with stored replies takes the incremental path. The four stored `Replies` rows for
`2095516553672380450` were therefore deleted 2026-09-04 so the post would re-enter the backfill
path on the next pass. All four were `status = 'New'` with `moderated_at`, `moderated_by` and
`counter_reply_text` NULL, so no operator action was lost. `Replies` went from 933 rows to 929.

**Not covered.** The alert text in `Build Truncation Alert` still advises nulling the run state
watermark to force a backfill. With per-post backfill the narrower recovery is deleting the
affected post's stored replies. Stale advice, not a defect.

## Incremental Watermark

`Run State.last_successful_run_at` is the start of the reply search window. `Build Replies
Query` reads it, subtracts a 10-minute overlap, and falls back to the full 7-day window when
it is `null`.

Phase 1 was promoted 2026-08-25. Two defects found the same day were fixed in the same
session, but the fix reached the **draft only** — it was not published until 2026-08-27.
Read "Publication gap" below before trusting any execution id in this section.

**Every quiet pass advances the marker.** Both writers previously sat downstream of
`Keep Posts With 10+ Replies`, and an n8n Filter that passes zero items emits nothing at all,
so the flow ended there — `last_successful_run_at` was still `null` after five successful
production runs, and the full 7-day fallback was being paid on every active run. The filter
now carries `alwaysOutputData: true` and branches through `If Any Post Qualified`; three
shapes reach `Advance Run State (Quiet Pass)`:

| Quiet case | Path |
| --- | --- |
| Posts qualified, no new replies | `If Has New Replies` (false) → `If Safe To Advance Watermark` |
| No post cleared the 10-reply filter, or the posts search returned nothing | `If Any Post Qualified` (false) → `Assess Quiet Outcome` |
| No active tracked users | `If Scheduler Should Continue` (false) → `Assess Quiet Outcome` |

Severity there is cost, not correctness — a stale marker causes re-reads, never gaps.

**No truncated pass advances it**, and this is the direction that loses data. `If Fetch
Truncated` used to be wired as a branch *parallel to* `If Has New Replies`, so it raised the
developer alert while the marker advanced anyway, and replies past the page cap were never
requested again. Both writers now sit behind a gate reading `fetch_truncated`. On the
analyzed path the gate's false branch continues to `Get Reply Status Counts`, so scoring,
storage and alerting still happen — only the watermark write is skipped.

The OpenAI abort path reaches neither writer: from `Analyze Sentiment with ChatGPT` output 1
the reachable set ends at `Send Scheduler Developer Alert`.

Fixtures: the `watermark-*` group in `tests/n8n/scheduled-tracking-pins/`. Run them against
production with `XMONITOR_WORKFLOW_ID=Emb26wP77eFXgnVi ./run-pins.sh watermark` — they write
`Run State` for real and the runner snapshots and restores it.

### Publication gap — 2026-08-25 to 2026-08-27

The watermark fix above was written to the production draft as version `796403a8` on
2026-08-25 10:23 and **never published**. Production kept executing `560b69f9`, the 38-node
pre-fix graph, for two days — its `Keep Posts With 10+ Replies` had no `alwaysOutputData` and
fed `Build Replies Query` directly, so every quiet pass still died at the filter and
`last_successful_run_at` stayed `null` with `updated_at` frozen at 2026-08-25 08:00:12.

Executions `15074` and `15075`, recorded at the time as production confirmation, were
`test_workflow` runs. **`test_workflow` executes the draft**; a schedule trigger executes the
published active version. They were real evidence about the fixed graph and no evidence at
all about what production was running.

Two beliefs written down during that session were wrong, and are corrected here:

- **`alwaysOutputData` was blamed and is not at fault.** It was said to fire only when a node
  returns no data at all, so a Filter with a populated discard branch would leave branch 0
  genuinely empty. Disproved directly — staging execution `16402` feeds two posts that both
  fail the 10-reply test and `Keep Posts With 10+ Replies` emits
  `main[0] = [ {} ]` (the injected placeholder) alongside `main[1] = [ 2 posts ]`. The chain
  runs and the watermark advances. The flag behaves as the fix assumed.
- **The fixture was said not to reproduce the production shape.** `watermark-no-qualifying-posts`
  already supplies two posts with `reply_count` 2 and 9 — both discarded — which is exactly
  production's shape. It was not a fixture gap.

The real gap was that nothing checked whether the draft under test was the version production
runs. `run-pins.sh` now refuses to run against an active workflow whose `versionId` differs
from its `activeVersionId`, and `watermark-all-posts-discarded` pins production's exact live
shape (three posts across two authors, all below the threshold, `null` watermark).

**After any edit to an active workflow, re-read `get_workflow_details` and confirm
`versionId == activeVersionId`.** `active: true` is not evidence.

`796403a8` was published 2026-08-27. The first scheduled run after it, `16436` (20:00:11),
terminated on `Advance Run State (Quiet Pass)` and wrote `last_successful_run_at =
2026-08-27 20:00:12.168+00` — the first time the marker moved since Phase 1 shipped. Its own
data is also the cleanest disproof of the `alwaysOutputData` theory: the filter emitted
`main[0] = [ {} ]` next to `main[1] = [ 6 real posts ]`, all with `reply_count 0`.

It has advanced every hour since: 22 consecutive successful runs through `17034`
(2026-08-28 17:00), each terminating on a watermark writer and storing its own start time.
All of them were quiet passes, so `Build Replies Query` has still never run post-publish —
the reply-read saving is enabled but unmeasured until a post next clears the 10-reply filter.

## Per-reply sentiment persistence

`Insert or update replies` maps six columns into `public."Replies"`:

| Column | Value |
| --- | --- |
| `reply_id` | `={{ $json.reply_id }}` (the matching column for the upsert) |
| `text` | `={{ $json.text }}` |
| `post_id` | `={{ $json.post_id }}` |
| `sentiment` | `={{ $json.sentiment }}` |
| `analyzed_at` | `={{ $json.analyzed_at }}` |
| `created_at` | `={{ $now }}` |

`sentiment` and `analyzed_at` are not decoration. Both stored-count queries key off them:

- `Get Stored Post Counts` — `COUNT(*) FILTER (WHERE r.analyzed_at IS NOT NULL ...)` split by
  `r.sentiment`, which supplies the *stored* half of the `negative_ratio` denominator in
  `Calculate/Filter Sentiment Counts`.
- `Get Reply Status Counts` — joins on `r.sentiment = 'Negative' AND r.analyzed_at IS NOT NULL`
  to produce the hidden/visible denominators shown in the Telegram alert.

A row stored without them is counted nowhere, so the ratio silently collapses to the current
run's slice alone and the `negative_ratio >= 0.5` alert gate fires on different posts.

### Regression — 2026-08-25 to 2026-08-29

Phase 1 (version `560b69f9`, 2026-08-25, "rewire incremental path (promote)") removed
`Filter Negative Replies` so that every analyzed reply would persist with its sentiment. The
filter removal shipped; **the column mapping that stores the sentiment did not.** It was lost
in the staging → production copy — staging (`l4eKZucUZXzfz0H8`) had all six columns the whole
time, production had only four, and its `columns.schema` cache listed the same four for an
11-column table.

The bug stayed **latent**. The last pass that actually analyzed replies ran 2026-08-24
21:00:35, before the regression; every hourly execution afterwards was a ~6-second quiet pass
with no new replies. All 929 production rows still carried `sentiment='Negative'` and a
non-null `analyzed_at`, and no row was ever written with a NULL sentiment. The next real batch
of replies would have been the first casualty.

Fixed 2026-08-29 by copying staging's `columns` object — value map and schema cache — onto the
production node. Published the same day: draft `f155fb3d-61b3-45fa-81dd-37703a2f6522` became
`activeVersionId` at 10:12:36 UTC, confirmed by re-reading `get_workflow_details`.

### Why the pinned suite did not catch it

`tests/n8n/scheduled-tracking-pins/` pins every credentialed node, `Insert or update replies`
included. That is the right default — it keeps a pinned run off every live surface — but it
means **no fixture in that directory can observe what the upsert's column mapping writes.**
All six non-watermark fixtures passed against the broken production workflow on 2026-08-29
(executions `18658`–`18664`) immediately before the fix.

`ratio-from-stored-rows` is the near miss. Its `non-negative sentiment persisted` assertion
greps the execution data for `"sentiment":"Positive"` — which `Prepare Reply Data` emits
whether or not the upsert stores it. The assertion describes the node *upstream* of the defect.

`tests/n8n/reply-sentiment-persistence.test.mjs` closes the gap. It leaves
`Insert or update replies` **unpinned** on purpose — the same deliberate exception the
`watermark-*` fixtures make for the two `Run State` writers — and asserts against the table
itself. Everything with an external side effect stays pinned: X, OpenAI, both Telegram sends,
the `Posts` upsert and both watermark writers. It drives three replies of *mixed* sentiment,
because a negatives-only fixture could not have caught this: every pre-existing production row
was already `Negative`, so a negative-only check passes on stale data.

```bash
node tests/n8n/reply-sentiment-persistence.test.mjs
```

It writes three synthetic `TEST-SENT-*` rows against a real post (so the `Replies.post_id`
foreign key and the `replies_set_client` trigger are both satisfied without inventing a `Posts`
row), snapshots that post's existing replies first, and deletes the synthetic rows in a
`finally` block — then verifies both that no `TEST-%` residue remains and that the pre-existing
rows are byte-identical to the snapshot. `--expect-broken` inverts the persistence assertions,
so the test can be shown to genuinely reproduce the regression before a fix is applied.

Evidence from the fix, against production `Emb26wP77eFXgnVi`, post `2084580476883292402`
(7 pre-existing replies, all `Negative`, stored counts 7/7/0/0):

| Stage | Execution | Result |
| --- | --- | --- |
| Before the fix (`--expect-broken`) | `18671` | All three rows written with `sentiment = NULL`, `analyzed_at = NULL`. |
| After the fix — persistence | `18680` | `Negative`, `Positive`, `Neutral` each stored with its own non-null `analyzed_at`. |
| After the fix — stored counts | — | `stored_analyzed 10 / negative 8 / positive 1 / neutral 1`; non-zero in every bucket. |
| After the fix — cross-pass ratio | `18682` | `Get Stored Post Counts` left **unpinned** reads those rows back; two new negatives give `analyzed_count 12`, `negative_ratio 0.8333…` = 10/12. A new-slice-only ratio would have been 2/2 = 1.0. |
| After the fix — alert denominator | `18682` | `Get Reply Status Counts` returns hidden 0 / visible 8, covering all 8 stored analyzed negatives. |

Cleanup was clean on both runs: 3 synthetic rows deleted, no `TEST-%` residue, and the 7
pre-existing replies byte-identical to the snapshot. Production `Replies` finished at 929 rows
with 0 NULL `sentiment` and 0 NULL `analyzed_at` — unchanged from before the work.

The six pinned fixtures were re-run after the fix (executions `18684`–`18694`) and stayed
green, so the change introduced no regression in the paths they do cover.

### Live end-to-end verification on real data — staging, 2026-08-29

The evidence above is real but synthetic: pinned OpenAI, invented reply ids. It proves the
mapping, not the pipeline. `tests/n8n/reply-sentiment-live-staging.test.mjs` closes that
gap on `XMonitor - Scheduled Post Tracking Staging` (`l4eKZucUZXzfz0H8`), whose
`Insert or update replies` is byte-identical to the node production now runs.

Only two nodes are pinned, **neither on the write path**: `Get posts of tracked users`
(the target post predates the live 7-day post-search window) and `Get Run State` (back-dates
the watermark so the *real* reply search reaches the conversation). The X reply search,
OpenAI, both upserts, both stored-count queries, the alert builder and the Telegram send all
run for real.

Target: post `2089952031398125613` (@lynnharfoush), 108 stored replies — 81 Negative,
25 Neutral, 2 Positive.

**Probe first.** X's `conversation_id:` search does not return every reply ever stored — older
and deleted ones fall out of the index. A first quiet-pass run (`18759`) discovers which
replies are still retrievable; cohorts drawn without it land on rows X can no longer fetch,
and the run analyzes nothing. That is not hypothetical — the first attempt (`18750`) picked
the 40 oldest reply ids, X returned only the 26 newest, and `new_reply_count` came back `0`.

The retrievable set (106 of 108) is then split so **both upsert paths** are covered — a
missing column breaks INSERT and ON CONFLICT UPDATE alike, but they are distinct SQL paths:

| Cohort | Prepared as | Proves |
| --- | --- | --- |
| A — 53 replies | deleted | the INSERT path writes `sentiment` + `analyzed_at` |
| B — 53 replies | `sentiment`/`analyzed_at` set NULL | the ON CONFLICT UPDATE path writes them — this is exactly the shape the production regression produced, so it doubles as a heal-forward check |
| C — 2 replies | untouched | a real non-zero stored baseline for the cross-pass ratio |

Result — execution `18761`, status `success`, 40 nodes:

| Check | Result |
| --- | --- |
| Real X reply search | 106 unanalyzed replies over 2 pages, `replies_truncated: false` |
| Cohort A (INSERT) | 53/53 with `sentiment` + `analyzed_at` — Negative 43 / Neutral 8 / Positive 2 |
| Cohort B (UPDATE) | 53/53 with `sentiment` + `analyzed_at` — Negative 42 / Neutral 9 / Positive 2 |
| Distinct labels | 3 — the column carries the model's value, not a constant |
| `Get Stored Post Counts` | `stored_analyzed 2` mid-run (cohort C), read live |
| Cross-pass ratio | `analyzed_count 108` = stored 2 + new 106; `negative_ratio 0.7963`, `alert_now true` |
| `Get Reply Status Counts` | hidden 0 / visible 86 |
| Telegram | **delivered** — `ok: true`, `message_id 174`, chat `8677383067` via `@XmonitorBetaBot` |

Re-classifying real Lebanese-Arabic replies agreed with the previously stored label
**95/106** (A 47/53, B 48/53). The disagreements are `gpt-5.4-mini` run-to-run variation on
genuinely borderline replies, not a persistence fault — every row stored *a* valid label.
That 90% self-agreement is a useful baseline for the separate sentiment-accuracy work.

All 108 replies, the `Posts` row and `Run State` were snapshotted to disk before any mutation
and restored afterwards; the post's replies verified byte-identical, and staging finished at
its exact starting totals (184 rows, Negative 154 / Neutral 25 / Positive 2 / NULL 3). The
three unrelated NULL-sentiment rows from the manual-labelling effort were never touched.
`--restore-only` replays the snapshot if a run dies mid-flight.

> **Two unrelated defects found during this run — see `TASK_TODOLIST.md`. Both were fixed by T3 on 2026-08-29; the description below is kept because it is the evidence for the matched pair.**
>
> **1. Only the first Telegram recipient is ever alerted (correctness, latent).**
> `Build Negative Alert Notification` has `executeOnce: true`, so n8n truncates its input to
> the first item and `$input.all()` returns one recipient however many arrive. The node's own
> `telegramUsers.flatMap(...)` fan-out is dead code. Proved on staging execution `18789`: two
> recipients pinned in, `Get Telegram Users` emitted 2 items, `Build` emitted **1** — chat
> `1111111111` only, `2222222222` silently dropped. Latent because each environment holds
> exactly one recipient row today; the day a second is added they receive nothing.
>
> **2. Per-item fan-out of two input-independent lookups (cost and latency).**
> `Insert or update replies` emits one item per reply (106), and both `Get Reply Status Counts`
> and `Get Telegram Users` execute once per input item — 106 identical Postgres queries and
> 106 identical Supabase calls for one alert. Neither reads its own input
> (`Get Reply Status Counts` takes its post ids from `$('Split Out Reply Analysis').all()`).
> Scales with reply volume: a 500-reply post fires 500 of each.
>
> **Both shipped in T3, 2026-08-29** — `executeOnce` removed from `Build Negative Alert Notification`
> and added to `Get Reply Status Counts` and the new `Get Alert Recipients`. Asserted by
> `tests/n8n/t3-alert-routing.test.mjs`. The original note follows.
>
> The fix is a **matched pair**: `executeOnce: true` on the two lookup nodes, *and* remove it
> from `Build Negative Alert Notification`. Shipping only the second half sends one message per
> reply; only the first half leaves defect 1 in place. Both defects predate the sentiment fix
> and are present in production identically.

> Production and staging `Replies` schemas differ right now: staging additionally has
> `manual_sentiment`, `manual_sentiment_note`, `manual_labeled_at` and `manual_labeled_by` from
> `db/migrations/2026-08-29-sentiment-manual-labels.sql`, which is applied to staging only. The
> upsert maps none of them, so the divergence does not affect this node.

## OpenAI Failure Handling

Added 2026-08-24, promoted from staging. Before this, an OpenAI failure **crashed the whole
hourly pass** — no `Posts`/`Replies` writes, no Telegram alert, and no notification that
anything had gone wrong. Production failed silently every hour from 2026-08-23 13:00 UTC
onward because the OpenAI account ran out of credits.

Now the run **aborts cleanly**: the entire main branch (sentiment counts, DB upserts, reply
status counts, negative-sentiment alert) is skipped and the error is reported instead.

| Node | Role |
| --- | --- |
| `Probe OpenAI Error Reason` | HTTP Request on output index 1 of the sentiment node. One minimal `chat/completions` call with `fullResponse` + `neverError`. |
| `Build Sentiment Failure Alert` | Classifies the probe result into a `scheduler_alert_type` and shapes it for `Build Scheduler Developer Alert`. |

**Why the probe exists.** n8n's `continueErrorOutput` propagates only its own generic
message (`The service is receiving too many requests from you`) — OpenAI's `description`
and error `code` never reach the error branch, so exhausted credits look identical to rate
limiting. The probe runs *only* on the failure path, so healthy runs cost nothing extra.

There is no way to check a credit balance up front: OpenAI's
`dashboard/billing/credit_grants` requires a browser session key and returns 403 to a secret
API key. "Is there enough credit?" can only be answered by attempting a call.

| `scheduler_alert_type` | Trigger |
| --- | --- |
| `SENTIMENT_NO_OPENAI_CREDITS` | `insufficient_quota`, `credit_balance_exhausted`, `billing_hard_limit_reached`, `account_deactivated` |
| `SENTIMENT_RATE_LIMITED` | `rate_limit_exceeded`, or an HTTP 429 that is not a credit condition |
| `SENTIMENT_API_FAILED` | Anything else, including a probe that succeeds (OpenAI healthy → original failure was a timeout or malformed model response) |

A pass lost this way is not permanent data loss: `Build X API Query` uses a 7-day lookback,
so the next scheduled pass re-fetches the same posts and replies.

The probe body uses `max_completion_tokens` (required by the gpt-5 family, and accepted by
older models too). Staging uses the identical body. Keep that param aligned with whatever
model the probe targets.

## Per-client alert routing — T3, 2026-08-29

Before T3 this workflow contained **zero references to any tenancy column**.
`Get Telegram Users` read the whole table with no filter and
`Build Negative Alert Notification` emitted one alert per recipient per post, so adding a
second chat to `Telegram Users` would immediately have sent it every client's flagged posts —
post text, reply counts and all. That is what T3 closes.

### The route a post's owner now takes

`Posts.client_id` is `NOT NULL` and populated by the `posts_set_client` trigger, but the
scheduler decides before a post is ever written, so ownership is resolved from the same place
the trigger resolves it — the tracked user — and carried along the pass:

| Node | What it adds |
| --- | --- |
| `Get Tracked Users` | joins `Clients`, so each tracked account arrives with `client_id`, `client_min_replies`, `client_negative_threshold`, `client_lookback_days` |
| `Filter Suppressed Posts` | matches each X post's `author_id` to a tracked user and copies those fields onto the post |
| `Keep Posts With 10+ Replies` | compares `reply_count` against that post's `client_min_replies` |
| `Attach replies to posts` | emits `post_client_map`, **outside** `text` |
| `Calculate/Filter Sentiment Counts` | sets `alert_now` against that post's own `negative_threshold`, and stamps `client_id` onto the post |
| `Get Alert Recipients` | resolves `Client Members` for the owners of this pass's alerting posts |
| `Build Negative Alert Notification` | groups by owner; one alert per recipient per post |

`post_client_map` is kept out of `text` on purpose: `text` is the OpenAI prompt payload, and
tenancy ids in it would change the prompt, its cost, and the model's input for no gain. There
is a test asserting the payload's key set is exactly what it was before T3.

### `lookback_days` is deliberately not per-client

`Clients.lookback_days` is loaded and carried, but nothing reads it. Since Phase 1 the replies
query is driven by the run watermark, so lookback only governs the **backfill fallback** — the
first run, when no run state exists. Making that per-client would force one replies query per
client and a fan-out this phase does not need, for a value that is exercised once in the life
of an environment. It is loaded rather than dropped so the day it is wanted, the plumbing is
already there.

### "No recipients" is per client, not global

The old `NO_TELEGRAM_RECIPIENTS` alert `return`ed early, so one client with no recipients would
have suppressed every other client's alerts in the same pass. It is now an item **pushed
alongside** the others: `If Notifications Ready` routes it to the developer chat on the false
branch while the true branch still sends everyone else's alerts. The developer alert names the
client, because a bare count is unactionable past one client.

A client arrives as "has no recipients" in three different ways, all of which look identical
to `Build Negative Alert Notification` — the query `LEFT JOIN`s, so each produces a row with a
null `chat_id`:

- no `Client Members` row at all
- every member `is_active = false`
- every member `receives_alerts = false`

A fourth case — a post whose owning client did not resolve at all — is reported the same way
and, critically, is **never** broadcast to some other client's chat.

### The `executeOnce` matched pair

`Build Negative Alert Notification` used to carry `executeOnce: true`, which truncates a Code
node's input to the *first* item — so `$input.all()` returned one recipient however many
arrived, and its own fan-out was dead code. Removing that flag is what makes per-client routing
possible at all, but it is only safe as a **pair**: `Insert or update replies` emits one item
per reply, and both lookups downstream of it read none of their own input, so removing it alone
would send one Telegram message per reply. T3 therefore ships both halves —

- removed from `Build Negative Alert Notification`
- added to `Get Reply Status Counts` and to the new `Get Alert Recipients`

### `Telegram Users` is retired as a routing source, not dropped

Nothing in this workflow reads the table any more. **It is deliberately still there, and the
Telegram router still writes it.** Leaving a table that nothing reads is harmless; removing one
that something still writes is not. Dropping it is a later cleanup, after the router stops
writing it.

### What T3 did not touch

The incremental replies query, the 15-conversation chunking, per-reply sentiment storage, and
all three watermark behaviours — advance on a quiet pass, advance on a successful active pass,
hold on a truncated pass, hold on a failed pass. `tests/n8n/t3-alert-routing.test.mjs` asserts
each of these structurally so a future edit to the routing cannot quietly move them.

### Promotion — 2026-08-29

Published to production `Emb26wP77eFXgnVi` at `versionId` /
`activeVersionId` `577efebb-acdd-4062-a205-dbeed364a17e`, `active: true`, 42 nodes, verified by
re-reading after the publish. **The first publish call was interrupted and had not applied** —
the re-read caught `activeVersionId` still on the pre-T3 `f155fb3d-…`, and a second call
landed it. Live production showed **zero drift** from this export before the edit, and the
change was applied as surgical `update_workflow` operations rather than by pushing the export.

Staging `l4eKZucUZXzfz0H8` carries the same change and stays `active: false` by design.

### Tests

| Test | Access needed | Proves |
| --- | --- | --- |
| `tests/n8n/t3-alert-routing.test.mjs` | none | node shapes, the retirement of `Telegram Users`, the matched pair, the watermark gates, and the routing table against synthetic recipients |
| `tests/n8n/t3-alert-routing-fixtures.test.mjs` | none | replays the three `tenancy-*` pin fixtures through the real Code-node bodies, X search response to Telegram items |
| `tests/n8n/scheduled-tracking-pins/tenancy-*.pinData.json` | n8n | the same table through n8n itself, with every Telegram send pinned |

The offline pair proves the logic; the pinned runs proved it through n8n. All six acceptance
rows passed against live staging on 2026-08-29 (executions 18822 / 18824 / 18827 / 18828 /
18830), the three watermark behaviours were re-proved with the writers unpinned (18832 /
18833 / 18834), and a fully unpinned live pass (18840) confirmed the two new Postgres queries
execute against the real database with real credentials. Execution 18865 then re-ran the
acceptance table with `Get Alert Recipients` **unpinned** against three real synthetic clients,
so the recipient query itself is proved, not just the fan-out that consumes it. Production's
first pass under T3 is 18854. See §12d of `docs/architecture/multi-tenant-and-web-ui.md`.

## Agent Change Guidance

- Prefer making changes in `XMonitor - Scheduled Post Tracking Staging` first, then mirror to production after validation.
- If changing cadence, edit `Schedule Trigger`; keep this document's schedule row in sync.
- If changing the monitored time window, update `DAYS_AGO` in `Build X API Query`.
- Alert sensitivity is **per client** since T3. Change `Clients.min_replies` / `Clients.negative_threshold` for the client concerned rather than editing the nodes; the constants left in `Filter Suppressed Posts` and `Calculate/Filter Sentiment Counts` are fallbacks for an unresolved client, not the live values.
- If changing alert buttons, inspect the Telegram router and its staging fixtures before promoting.
- If changing database writes, check the `Posts` and `Replies` schema assumptions and run a safe staging validation. **A pinned run cannot see a Postgres node's column mapping** — every fixture in `tests/n8n/scheduled-tracking-pins/` pins the credentialed nodes, so an upsert that silently drops a column passes the whole suite. Verify the mapping against the table with `tests/n8n/reply-sentiment-persistence.test.mjs`, or by reading the rows back.
- When promoting this workflow from staging, diff `parameters.columns.value` **and** `parameters.columns.schema` on every Postgres node against staging. The 2026-08-25 regression was exactly a lost pair of column mappings that no test and no green execution surfaced.
- If testing this production workflow directly, expect live X/OpenAI calls, production DB writes, and Telegram sends. Use staging or pin external nodes unless the user explicitly approves live side effects.
