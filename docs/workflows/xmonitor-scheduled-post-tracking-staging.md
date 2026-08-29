# XMonitor - Scheduled Post Tracking Staging

## Purpose

Inactive staging copy of scheduled post tracking. It scans tracked X users, analyzes **only
replies it has not seen before**, stores every candidate post and every analyzed reply in
staging data stores, and sends staging Telegram alerts for posts over the negative
threshold. It is the preferred place to validate scheduler changes before touching
production.

## Identity

- n8n ID: `l4eKZucUZXzfz0H8`
- Environment: staging
- Active: no
- Local export: `workflows/staging/xmonitor-scheduled-post-tracking-staging.json`
- Last observed live update: `2026-08-24T13:44Z`
- Error workflow: `XMonitor - Staging Developer Error Alerts` (`CCzwnMyoy7UequuI`)

> **In parity with production as of 2026-08-25.** The Phase 1 incremental-replies rebuild
> was validated here and promoted to `Emb26wP77eFXgnVi` on 2026-08-25, so the two are
> structurally equivalent again. Keep them that way: validate changes here first, then
> promote, and remember production runs a **published version** - saving a draft there does
> not change live behaviour until it is published.

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Schedule Trigger` | every `1` hour | Same cadence as production. |
| Lookback window | `Build X API Query`, `DAYS_AGO` | `7` days | X search start time for **post discovery**. |
| Replies lookback | `Build Replies Query`, `LOOKBACK_DAYS` | `7` days | Only used on the first run, when no run state exists. |
| Replies overlap | `Build Replies Query`, `OVERLAP_MINUTES` | `10` minutes | Subtracted from the watermark to tolerate X indexing lag. Duplicates are dropped by `reply_id`. |
| Conversations per chunk | `Build Replies Query`, `MAX_CONVERSATIONS_PER_CHUNK` | `15` | Hard ceiling per replies query. |
| Query length ceiling | `Build Replies Query`, `MAX_QUERY_CHARS` | `1000` | Headroom under X's 1024-char `search/all` cap. Chunks are built by **measuring the assembled string**, not by counting items. |
| Minimum replies | `Keep Posts With 10+ Replies` | `>= {{ $json.client_min_replies }}` | Minimum reply count before a post becomes a candidate, read from the post's **own** `Clients.min_replies` since T3. `10` survives only as the fallback for a post whose client did not resolve. The node name is kept deliberately — `Attach replies to posts` and every pinned fixture reference it by name. |
| Negative threshold | `Calculate/Filter Sentiment Counts`, `post_client_map` | `negative_ratio >=` the post's `Clients.negative_threshold` | Gates **alerting only**. Storage is not gated. Per client since T3; the old `ALERT_THRESHOLD = 0.5` survives as `DEFAULT_ALERT_THRESHOLD` for an unresolved client. |
| X post limit | `Get posts of tracked users` | `max_results=100` | Page size, not a total. X bills per **resource returned**, not per request, so a smaller page size saves nothing and merely multiplies requests. |
| Post author lookup | `Filter Suppressed Posts` | `Tracked Users.username` / `.display_name` | Author identity is read from the database. `expansions=author_id` was **removed** to stop paying $0.010 per user per run. **T3:** the same `author_id` match is also where a post acquires its `client_id` and its client's thresholds. |
| Tracked users source | `Get Tracked Users` | Postgres over `Tracked Users` joined to `Clients` | Was a Supabase `getAll` until T3. Each row now carries `client_id` plus the client's `min_replies`, `negative_threshold` and `lookback_days`. `Clients` is joined but **not** filtered on `is_active` — deactivating a client must not silently stop collecting its posts; it is dropped at delivery instead. |
| Alert recipients | `Get Alert Recipients` | `Client Members` where `is_active` and `receives_alerts`, on an `is_active` client | The T3 routing table. Replaced the unfiltered read of `Telegram Users`. `LEFT JOIN`s so a client with no eligible member still returns a row with a null `chat_id`, which is how a misconfigured client is detected rather than silently skipped. Runs `executeOnce` — its parameters come from `$('Split Out Reply Analysis')`, not from its own input. |
| X reply limit | `Get Replies` | `max_results=500` | Page size per chunk, at the `search/all` ceiling. |
| Pagination | both X searches | `next_token` until absent | `options.pagination.pagination`, completing on `{{ !$response.body.meta.next_token }}`. |
| Page cap | `Get Replies` / `Get posts of tracked users` | `maxRequests` `20` / `10` | Runaway guard. Hitting it raises `SEARCH_PAGE_CAP_REACHED` rather than truncating silently. |
| Chunk pacing | `Get Replies` | `batchSize=1`, `batchInterval=1100ms` | Keeps chunked fan-out under X's 1 request/second ceiling. |
| Page pacing | both X searches | `requestInterval=1100ms` | Same ceiling, applied between pages. |
| Hidden/visible negative counts | `Get Reply Status Counts` | All stored `sentiment='Negative'` replies for the post, joined to `Replies.status` | Counts hidden and visible replies across **stored** negatives, not just the current run's. |
| OpenAI model | `Analyze Sentiment with ChatGPT` | `gpt-5.4-mini` | Must stay identical to production. Aligned 2026-08-24 (was `gpt-4o-mini`). |

## Incremental Reply Fetching

Before 2026-08-24 the replies query emitted a bare `query` string with no `start_time`, so
every hourly pass re-fetched the complete reply history of every qualifying conversation and
re-sent all of it to OpenAI. At $0.005 per post resource returned that cost roughly
$204/month on three accounts, and a single reply was re-read about 168 times over its
lifetime.

The pass is now bounded by a persisted watermark.

| Node | Role |
| --- | --- |
| `Get Run State` | Upserts the `scheduled_post_tracking` marker row and returns `last_successful_run_at` plus this run's `run_started_at`. |
| `Build Replies Query` | Sets `start_time = last_successful_run_at - 10 min`, and splits conversations into chunks of at most 15 ids / 1000 chars. Emits one item per chunk. |
| `Get Analyzed Reply Ids` | Reads `Replies.reply_id where analyzed_at is not null` for the candidate posts. |
| `Attach replies to posts` | Drops replies already scored in an earlier pass, and duplicates arriving across chunks or the overlap window. Emits `has_new_replies`. |
| `If Has New Replies` | If nothing is new, OpenAI is skipped entirely and the run ends at `Advance Run State (Quiet Pass)`. |
| `Get Stored Post Counts` | Per-post totals from previously scored replies, the stored half of the ratio. |
| `Advance Run State` | Moves the watermark, using the run **start** time so replies created mid-run are not skipped. |

### The watermark only moves on success

`last_successful_run_at` is written by exactly two nodes, both of which sit after the work
they attest to:

- `Advance Run State` runs immediately after `Insert or update replies`, so every fetched
  reply is durably stored with its sentiment before the watermark moves.
- `Advance Run State (Quiet Pass)` handles the no-new-replies path, which is a successful
  outcome and should still advance.

**No edge exists from the OpenAI failure path to either node.** `Probe OpenAI Error Reason`
then `Build Sentiment Failure Alert` then `Build Scheduler Developer Alert` terminates at the
developer alert. A failed or aborted pass therefore leaves the watermark untouched and the
next run re-reads the same window. Verified live: execution `14577` failed mid-pass and
`last_successful_run_at` was unchanged.

If this invariant is ever broken, the failure is silent and permanent. The skipped replies
are never re-read, so a post's negative ratio stays wrong forever with nothing to indicate it.

### Rewired 2026-08-25 — quiet passes, and truncated ones

The section above was right about *failure* and wrong in both other directions. Production
proved it: `last_successful_run_at` sat `null` after five successful runs.

**Every quiet pass now advances the marker.** Both writers used to sit downstream of
`Keep Posts With 10+ Replies`, and an n8n Filter that passes zero items emits nothing at all
— there is no branch to connect, so the flow simply ended. Three shapes now reach
`Advance Run State (Quiet Pass)`:

| Quiet case | Path |
| --- | --- |
| Posts qualified, no new replies | `If Has New Replies` (false) → `If Safe To Advance Watermark` |
| No post cleared the 10-reply filter, or the posts search returned nothing | `Keep Posts With 10+ Replies` → `If Any Post Qualified` (false) → `Assess Quiet Outcome` |
| No active tracked users | `If Scheduler Should Continue` (false) → `Assess Quiet Outcome` |

`Keep Posts With 10+ Replies` now carries `alwaysOutputData: true` so the empty case emits a
single item to branch on. Chosen over a Merge — the filter's own output already distinguishes
the two outcomes, so no join was needed — and over a downstream item-count check, because
`Build Replies Query` already returns `[]` on empty input and would have swallowed the
signal.

The flag fires on **both** empty shapes, which is the point that was doubted and is now
settled. It injects the placeholder into the kept branch whether the filter saw no posts at
all *or* saw posts and discarded every one of them. Execution `16402` is the proof for the
second shape: two posts in, both below the threshold, and the filter emits
`main[0] = [ {} ]` next to `main[1] = [ 2 posts ]`, so `If Any Post Qualified` still runs.
A 2026-08-25 note claiming the opposite — that a populated discard branch suppresses the
placeholder — was wrong; see the production doc's "Publication gap" section. Severity here is **cost, not correctness**: a stale marker only causes re-reads. But
while it is `null` the full 7-day fallback window is paid on the next active run, and ~35% of
production runs are quiet.

**No truncated pass advances it.** This is the direction that loses data, and it was broken.
`If Fetch Truncated` was wired as a branch *parallel to* `If Has New Replies`, so it raised
`SEARCH_PAGE_CAP_REACHED` while the marker advanced anyway via whichever writer the other
branch reached — and replies past the page cap are never requested again. Under the old
full-refetch behaviour a truncated page was self-healing; incrementally it is permanent.

Both writers now sit behind a gate reading `fetch_truncated`:

- `If Safe To Advance Watermark` guards the quiet writer.
- `If Safe To Advance Watermark (Analyzed)` guards `Advance Run State`, and its false branch
  continues straight to `Get Reply Status Counts`. Replies that *were* fetched are still
  scored, stored and alerted on — only the watermark write is skipped, so the next run
  re-reads the window and collects the remainder.

`Assess Quiet Outcome` runs the same page-cap check against the posts search, so a truncated
posts page holds the marker too, even when no post qualified.

Covered by the `watermark-*` fixtures in `tests/n8n/scheduled-tracking-pins/`, which
deliberately leave both writers **unpinned**. Every other fixture pins them — which is
exactly why this defect survived staging validation.

`watermark-all-posts-discarded` (added 2026-08-27) pins production's exact live shape: three
posts across two authors, all below the 10-reply threshold, against a `null` watermark. It
asserts that the posts genuinely reached the filter, so it cannot pass by accidentally
exercising the empty-input path instead.

`run-pins.sh` also refuses to run against an **active** workflow whose `versionId` differs
from its `activeVersionId`. `test_workflow` runs the draft while a schedule trigger runs the
published version; without that check a green suite says nothing about production, which is
how the 2026-08-25 fix sat unpublished for two days.

### Pagination, and what `next_token` actually means

Both X searches follow `meta.next_token` until it is absent. This is configured on the HTTP
Request nodes themselves (`options.pagination.pagination`) rather than with a loop node,
because the replies query already fans out one item per conversation chunk and nesting a
cycle inside that fan-out is fragile. A Code node calling `this.helpers.httpRequest` was
rejected outright: Code nodes cannot carry credentials, so the X bearer token would have had
to be handled in plaintext.

**`result_count < max_results` does not prove completeness.** `search/all` pages over time
slices, so only the absence of a token does. Before this change the workflow could not tell
the two apart.

Measured on live backfill `14597`, both searches returned a token on page 1 and a **boundary
duplicate** on page 2 — the previous page's `oldest_id` repeated — then completed:

| Search | Page 1 | Page 2 | Net new |
| --- | --- | --- | --- |
| `Get Replies` | 108 replies, token present | 1 reply (`2089972330982207972` = page 1's `oldest_id`), no token | 0 |
| `Get posts of tracked users` | 2 posts, token present | 1 post (`2089952031398125613` = page 1's `oldest_id`), no token | 0 |

So at current volumes nothing was being lost, and the stored counts were already correct.
Do not read a token as proof of missing data. What pagination buys is that completeness is
now **proven every run** instead of assumed, and that a genuinely oversized conversation
(more replies than one 500-row page) will no longer be cut in silence.

Duplicates across pages, chunks and the overlap window are all dropped by the `seen` set in
`Attach replies to posts`, so the boundary repeat costs one resource (~$0.005) and changes
nothing downstream.

**Page caps are not silent.** `Attach replies to posts` groups pages back to the chunk that
produced them and checks whether that chunk's final page still carried a token. If it did,
`If Fetch Truncated` sends `Build Truncation Alert` into the developer-alert path as
`SEARCH_PAGE_CAP_REACHED`. This matters more under incremental fetching than it would have
before: a truncated page used to be transient because the next pass re-read the whole window,
whereas now the watermark advances past unread replies and they are never requested again.

### Backfill

There is no separate backfill script. When `Run State.last_successful_run_at` is null,
`Build Replies Query` falls back to the full 7-day window and marks the item
`is_backfill: true`. That one pass populates the stored counts, after which the incremental
path takes over.

Rows written before per-reply sentiment existed were marked by migration
`xmonitor_phase1_backfill_legacy_reply_sentiment`: under the old pipeline `Filter Negative
Replies` ran before the upsert, so every stored reply was `Negative` by construction. Posts
still inside the lookback window do not depend on that migration, because their replies have
`analyzed_at is null` and the backfill pass re-scores them exactly.

## Storage Versus Alerting

`Posts` now holds **every candidate post** (10+ replies), not only those over the negative
threshold. This is required, not cosmetic: `Replies.post_id` is a foreign key to
`Posts.post_id`, so a reply's sentiment cannot be stored unless its post row exists, and
without stored sentiment there is no running denominator.

Consequences to keep in mind:

- `Calculate/Filter Sentiment Counts` no longer filters. It emits every candidate post with
  an `alert_now` boolean, and `Build Negative Alert Notification` applies the gate.
- The Telegram router resolves posts by `post_id` with no other filter
  (`Get Post For Hide`, `Get Post For Status Change`, `Get Post For Comment Order`,
  `Get Post For Likes Order`). Hide, ignore, snooze and SMM orders therefore now resolve for
  posts that were never alerted, where they previously answered *"Post ... was not found.
  Wait for monitoring to flag it, then try again."* **Confirmed as intended 2026-08-24.**
- `Insert or update posts` deliberately does not reset `created_at`, because candidate posts
  are refreshed every pass, and it never writes `status` on conflict, so `Ignored` and
  `Snoozed` survive a refresh.

### Ratio recomputation

`negative_ratio` is `(stored negatives + new negatives) / (stored analyzed + new analyzed)`
per post, never the slice fetched in one run. `Posts.analyzed_count` carries the running
denominator and `Posts.negative_ratio` the result.

`Replies.sentiment` (`Positive|Neutral|Negative`) and `Replies.analyzed_at` are written for
**every** analyzed reply. Only rows with `analyzed_at is null` are sent to OpenAI.

## Relation To Production Scheduler

The structure mirrors [XMonitor - Scheduled Post Tracking](./xmonitor-scheduled-post-tracking.md):
suppression advancement, tracked-user loading, X search, reply analysis, post/reply upserts,
hidden/non-hidden reply counting, Telegram alerts, and scheduler developer alerts.

Primary staging differences:

- It is inactive and intended for manual or pinned validation.
- It uses staging credentials where configured.
- It routes handled scheduler errors to staging developer alerts.
- Its sentiment model is `gpt-5.4-mini`, matching production. **Keep the two environments on the same model** so staging validation reflects production behaviour.
- The OpenAI failure branch described below was validated here first, then promoted to production on 2026-08-24. Both environments now have it.
- **Staging is ahead**: it carries the Phase 1 incremental-replies rebuild described above and production does not. Promotion also requires the schema migration and the legacy-sentiment backfill against the production Supabase project.

## OpenAI Failure Handling

`Analyze Sentiment with ChatGPT` runs with `onError: continueErrorOutput`. When the OpenAI
call fails, the run **aborts cleanly instead of crashing**: the whole main branch
(sentiment counts, `Posts`/`Replies` upserts, reply status counts, negative-sentiment
Telegram alert) is skipped, and the error output goes to the developer alert path instead.

| Node | Role |
| --- | --- |
| `Probe OpenAI Error Reason` | HTTP Request, output index 1 of the sentiment node. One minimal `chat/completions` call with `fullResponse` + `neverError`, so the raw provider error is readable. |
| `Build Sentiment Failure Alert` | Classifies the probe result and shapes it for `Build Scheduler Developer Alert`. |

**Why the probe exists.** n8n's `continueErrorOutput` propagates only its own generic
message (`The service is receiving too many requests from you`). The OpenAI `description`
and error `code` never reach the error branch. Without the probe, exhausted credits are
indistinguishable from rate limiting. The probe runs *only* on the failure path, so healthy
runs incur no extra cost or latency.

There is no way to read a credit balance up front: OpenAI's
`dashboard/billing/credit_grants` endpoint requires a browser session key and returns 403
to a secret API key, so "is there enough credit?" can only be answered by attempting a call.

Emitted `scheduler_alert_type` values:

| Value | Trigger |
| --- | --- |
| `SENTIMENT_NO_OPENAI_CREDITS` | Probe returns `insufficient_quota`, `credit_balance_exhausted`, `billing_hard_limit_reached`, or `account_deactivated`. |
| `SENTIMENT_RATE_LIMITED` | Probe returns `rate_limit_exceeded`, or HTTP 429 that is not a credit condition. |
| `SENTIMENT_API_FAILED` | Anything else, including a probe that succeeds (OpenAI healthy, so the original failure was a timeout or malformed model response). |

A run lost this way is not permanent data loss, but the reason has changed. It is no longer
because the lookback window is rolling. It is because **the failure path never advances
`Run State.last_successful_run_at`**, so the next pass re-reads the identical window. That
invariant is now the thing protecting reply coverage; see *The watermark only moves on
success* above.

## Tests

Pinned fixtures live in `tests/n8n/scheduled-tracking-pins/`. Run them with `./run-pins.sh`
(or `./run-pins.sh <substring>` for one); the runner asserts against execution data and exits
non-zero on failure. Nothing in that suite touches live X, OpenAI, Supabase or Telegram.

Read that directory's `README.md` before changing this workflow — it records what the
fixtures deliberately **cannot** prove (multi-chunk truncation grouping, and real
`next_token` pagination, since `test_workflow` pins HTTP nodes), and how the pagination paths
were verified live instead.

**To exercise pagination against real data, shrink `max_results`** rather than waiting for a
high-volume post: at `max_results=10` the existing 108-reply conversation spans 14 pages.
That is how runs `14644` (real page cap) and `14645` (exhaustion across 14 pages) were
produced. Revert the page size afterwards.

## Agent Change Guidance

- Change and validate scheduler behavior here first.
- If changing alert callback data, update the staging Telegram router and risky-path fixtures too.
- If changing thresholds or schedule cadence, update both staging and production docs once promoted.
- Manual execution can read/write staging Supabase, call X/OpenAI, and send staging Telegram messages unless nodes are pinned. A live run now costs real money per post resource returned, so keep runs deliberate and few.
- Telegram negative-sentiment alerts use a professional, metric-first HTML layout that displays post author, total X replies, analyzed replies, negative replies, and hidden/visible counts within those negative replies. "Analyzed replies" is now the **running** denominator (`Posts.analyzed_count`), not the count fetched in that run.
- Anything that inserts a node between `Analyze Sentiment with ChatGPT` and
  `Calculate/Filter Sentiment Counts` must keep reading the model output through
  `$('Analyze Sentiment with ChatGPT')`. That node's own `items` are the stored-count rows,
  not the analysis. This already caused one failure during development.

## Reply Media Sentiment (Option C) - added 2026-08-24

Staging now analyses images attached to replies. Before this, `Get Replies` requested only
`created_at,conversation_id`, so an image-only reply reached the model as an empty string and
was labelled Neutral.

### What changed

| Node | Change |
| --- | --- |
| `Get Replies` | Added `attachments` to `tweet.fields`, plus `expansions=attachments.media_keys` and `media.fields=type,url,preview_image_url,alt_text`. |
| `Attach replies to posts` | Resolves each reply's `media_keys` against `includes.media` and emits a `media_replies` array (`reply_id`, `post_id`, `postText`, `replyText`, `imageUrls`). Photos use `url`; video and GIF fall back to `preview_image_url`. Capped at 4 images per reply. |
| `Build Media Classify Requests` | **New.** One multimodal request per media reply, capped at 40 per pass. Emits a single `no_media` sentinel when the pass has none. |
| `If Has Media Replies` | **New.** Routes past the HTTP call entirely on a pass with no media. |
| `Classify Media Replies` | **New.** `POST /v1/chat/completions` with the images attached, throttled to 3 per second, `neverError`, retry 3x. |
| `Apply Media Sentiment` | **New.** Overrides the batched text label with the multimodal label, for media replies only, and re-emits the same payload shape. |
| `Calculate/Filter Sentiment Counts` | Now reads `Apply Media Sentiment` instead of the raw sentiment node. |

Media replies still go through the batched text call as well. That is deliberate: the text label
is the fallback if the multimodal call fails, and it costs almost nothing since the reply is in
the batch either way.

### Why Option C and not Option A

Measured on [the accuracy benchmark](./xmonitor-media-sentiment-accuracy-benchmark.md)
(`F7VkkER6k85DGkmG`). Option A - describe the image, then classify the description - swung
**75% to 100% between identical runs**, failing a different set of cases each time. The
multimodal path returned **identical labels on every case, every run**, across 108 calls.

A moderation label that changes between hourly passes is worse than one that is merely
imperfect, because these rows drive `hide_replies`.

### Known limitation

A screenshot attacking a **third party the post does not mention** is labelled Negative when it
should be Neutral. The benchmark case is `media-only-counterargument-screenshot`: a journalist
holding Joseph Aoun responsible for the port explosion, replied to a post about 4 August. One
attribution-focused prompt iteration failed to shift it. The error is **stable and reproducible**
rather than random, so it can be measured and revisited.

### Failure behaviour

- No media replies in a pass -> the HTTP node never runs, chain continues.
- A multimodal call fails, times out, or returns unparseable JSON -> that reply silently keeps
  its text-only label. `Apply Media Sentiment` reports `media_labels_applied`,
  `media_labels_failed`, and `media_labels_changed_from_text`.
- The existing OpenAI failure branch on `Analyze Sentiment with ChatGPT` is untouched.

### Validation status

**Pinned test PASSED** - execution `14636`, zero external calls and zero writes (`test_workflow`
pins every credentialed and HTTP node, so all five new Code nodes ran for real against fixtures):

| Node | Result |
| --- | --- |
| `Build Media Classify Requests` | 3 requests built; 2 images on the two-image reply, `detail: low` |
| `Apply Media Sentiment` | `applied 3, failed 0, changed_from_text 2` |
| `Calculate/Filter Sentiment Counts` | post A: 3 analyzed, 2 negative, ratio 0.67, `alert_now true`; post B: ratio 0, `alert_now false` |

Both image-only replies flipped Neutral to Negative, the video thumbnail correctly stayed
Neutral, and the text-only controls were untouched. An earlier run of the same fixture with no
media also confirmed the `no_media` sentinel bypasses the HTTP node cleanly.

**Live validation PASSED** on 2026-08-25, all three rungs.

**Step 2 - live, Telegram suppressed** (execution `14977`). The same 47 replies were scored
twice, once before the media parameters were restored and once after:

| | Analyzed | Negative | Ratio |
| --- | --- | --- | --- |
| Text only (exec `14975`) | 47 | 38 | 0.8085 |
| With media (exec `14977`) | 47 | **41** | **0.8723** |

Five replies carried media; all five stored as `Negative`. The three that text-only analysis
had labelled `Neutral` all flipped, including the flagship `2091108649414340893` - a bare
`@michelhelou_lb` with the دير الصليب images and no other text. That reply is invisible to
text-only analysis and is now correctly Negative.

**Step 3 - full pass with alerting** (execution `14978`). Telegram returned `ok: true`,
`message_id 150`, from `XmonitorBetaBot` to chat `8677383067`, reporting 41 negative replies at
87% with the Snooze / Ignore / Hide replies / Order Likes / Order Comments buttons intact.

Observed cost: ~1,510 prompt tokens per media reply, five calls for this post.

### Two concurrent-edit collisions during rollout

Both were caught by validation, not by review, and both are worth knowing about:

1. A concurrent edit that added pagination-truncation detection **overwrote the media extraction**
   in `Attach replies to posts`. Caught by the pinned test (`media_reply_count: 0`). The two were
   re-merged so both survive.
2. The same work **reverted `Get Replies` queryParameters** to `created_at,conversation_id`,
   silently dropping `attachments`, `expansions` and `media.fields`. Caught by live run `14975`,
   which fetched 47 replies with no `attachments` and no `includes` block. Restored without
   touching the pagination options.

If two people edit this workflow at once, whoever saves last wins the whole node. Re-verify the
media parameters and `Attach replies to posts` after any other change lands here.

### Not yet done

- Staging test scaffolding was reverted: `michelhelou_lb` removed from `Tracked Users`, and the
  post/reply rows the validation runs created were deleted. Baseline restored to 181 replies /
  2 posts / 1 tracked user.
- No description/label caching by `media_key` - each pass re-analyses any media reply it
  re-fetches. The existing `Get Analyzed Reply Ids` dedup limits this, since a reply is scored
  once, but a cache is still worth adding.
- Production is untouched.

## Per-Client Sentiment Cheat Sheet - added 2026-08-29

The analyzer now receives client-specific labelling rules alongside the replies. This is the
read half of a feedback loop: reviewers hand-label stored replies in `Replies.manual_sentiment`,
and a weekly job (not yet built) turns the disagreements into rules that land here.

### What changed

Two nodes were inserted between `If Has New Replies` and `Analyze Sentiment with ChatGPT`:

| Node | Role |
| --- | --- |
| `Get Active Cheat Sheets` | Postgres. `SELECT client_id, version, rules_text FROM "Sentiment Cheat Sheets" WHERE status = 'active'`. Drafts are excluded - they wait for human activation. |
| `Build Analyzer Batches` | Code. Groups posts by client (`Tracked Users.user_id` -> `client_id`) and emits **one item per client**, each carrying only that client's posts and that client's rules. |

`Analyze Sentiment with ChatGPT` gained a **second system message** holding
`{{ $json.cheat_sheet_block }}`. The base prompt was left as a literal string on purpose: it
contains JSON braces, and converting it to an expression would make it one stray `}}` away
from breaking the whole scheduler at runtime.

### Why one call per client

Stance rules ("praising @handle is Negative for us") are client-specific. A single batched
call spanning clients would either leak one client's rules onto another client's replies, or
force the model to scope rules per post - both worse than paying for one call per client.
With a single configured client this emits exactly one batch, identical to the previous
behaviour, so the change is inert until a second client exists.

### Failure behaviour

`Get Active Cheat Sheets` runs with **`alwaysOutputData: true`**. This is load-bearing: it is
a credentialed node in the main path, and a Postgres node returning 0 rows emits no items,
which in n8n silently kills every downstream node including storage and alerting. With the
setting on, an empty table yields one blank item and `Build Analyzer Batches` falls back to
`"No client-specific labelling rules are configured for this client."`.

A post whose author is not in `Tracked Users` is grouped under `client_id: "unknown"`, gets
the same fallback, and is still analyzed rather than dropped.

### Validation

Pinned fixtures `cheat-sheet-per-client-isolation` and `cheat-sheet-absent-fallback` in
`tests/n8n/scheduled-tracking-pins/`. Executions `18701` and `18700` on 2026-08-29, both
success, no live X / OpenAI / Supabase-write / Telegram calls. The full 16-fixture suite
passes, so the two inserted nodes caused no regression.

The `Get Active Cheat Sheets` query itself was additionally run directly against staging
Supabase, returning exactly the one active row and correctly excluding the draft - the pinned
run cannot prove that, because `test_workflow` pins credentialed nodes.

### Not yet done

- The weekly cheat sheet generator workflow and its Telegram activation gate.
- Production promotion. It is blocked behind the separate fix restoring
  `Replies.sentiment` / `analyzed_at` writes in `Emb26wP77eFXgnVi`; without stored model
  labels there is nothing for manual labels to disagree with.
- Cheat sheet `v1` exists in staging as a **draft template with `<PLACEHOLDER>` values**. It
  must be filled in and set to `active` at the first weekly review before it does anything.

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
