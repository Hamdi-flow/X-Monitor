# Scheduled Tracking Pin Data

Fixtures for `XMonitor - Scheduled Post Tracking Staging` (`l4eKZucUZXzfz0H8`), covering the
Phase 1 incremental-replies rebuild: run-state watermarking, per-reply stored sentiment,
ratio recomputation from stored rows, conversation chunking, and `next_token` pagination.

Run them with `./run-pins.sh` (all) or `./run-pins.sh <substring>` (one). The runner drives
n8n MCP `test_workflow`, then asserts against the resulting execution data and exits non-zero
on any failure. Each `*.pinData.json` can also be passed directly as the `pinData` argument
if you prefer to drive it by hand.

Every fixture pins the trigger, all credentialed nodes, and all HTTP Request nodes, so a run
touches **no** live X, OpenAI, Supabase or Telegram surface. Code, Set, Filter and If nodes
execute for real — which is the point, since that is where the Phase 1 logic lives.

The one deliberate exception is the `watermark-*` group, which leaves the two `Run State`
writers unpinned so the UPDATE actually runs. `run-pins.sh` snapshots and restores that row
around them. See [The `watermark-*` fixtures](#the-watermark-fixtures) below.

## The publish check

Before running anything, `run-pins.sh` reads the target workflow and — if it is **active** —
refuses to continue when `versionId` differs from `activeVersionId`.

`test_workflow` runs the **draft**. A schedule trigger runs the separately **published**
active version. When those differ, every assertion below is evidence about code no scheduled
run will ever execute. That is not hypothetical: the 2026-08-25 watermark fix was written to
the production draft and never published, so `Emb26wP77eFXgnVi` executed the pre-fix graph for
two days while its pinned suite passed green against the fixed draft. `active: true` is not
evidence — check the two version ids.

Staging is `active: false` by design and driven by manual execution, so the check reports
"not applicable" there and the suite proceeds.

The check **fails closed**. If the workflow read fails or the response shape changes, the
parsed fields come back empty — and an empty draft id compares equal to an empty active id,
so a naive check would sail straight through and silently skip the very thing it exists for.
An unreadable `active` flag, or an active workflow with an unreadable or absent
`activeVersionId` (meaning it has never been published), aborts the run.

## Fixtures

- `chunking-25-conversations.pinData.json` — 25 qualifying conversations must split into two
  chunks (15 + 10). This is the case that returns a 400 on the pre-Phase-1 workflow, where a
  single 1,246-character query exceeded X's 1,024-char `search/all` cap. Asserts the chunk
  sizes, not just that a chunk boundary exists.
- `ratio-from-stored-rows.pinData.json` — the correctness heart of the change. One reply is
  pinned as already scored and must be skipped; post A combines stored 10 analyzed / 6
  negative with 2 new (1 negative) to reach `12` and `0.5833…` and alert; post B lands at
  `0.1`, is stored, and must **not** alert. Also asserts a non-negative sentiment is
  persisted, which the pre-Phase-1 `Filter Negative Replies` node discarded.
- `no-post-crosses-threshold.pinData.json` — new replies arrive and are stored with their
  sentiment, but nothing crosses `0.5`, so no alert is built. This exercises the
  empty-alert chain (`Get Reply Status Counts` receives an empty post-id array) which is the
  common steady-state outcome once storage stopped being gated on the threshold.
- `quiet-pass-no-new-replies.pinData.json` — nothing new, so OpenAI is skipped entirely and
  the run must terminate on `Advance Run State (Quiet Pass)`.
- `pagination-multi-page-complete.pinData.json` — three reply pages where the final page
  carries no `next_token`. All three must contribute, and the run must **not** be flagged as
  truncated.
- `pagination-page-cap-truncated.pinData.json` — identical, except the final page still
  carries a token, meaning pagination stopped on the page cap rather than on an exhausted
  result set. Must set `replies_truncated` and raise `SEARCH_PAGE_CAP_REACHED` on the
  developer-alert path, while the main branch still completes.
- `watermark-all-posts-discarded.pinData.json` — production's live shape, added 2026-08-27:
  three posts across two authors, every one below the 10-reply threshold, against a `null`
  watermark. The filter's kept branch is empty while its discard branch is full, and
  `alwaysOutputData` must still inject the placeholder so `If Any Post Qualified` runs. It
  asserts a discarded post id appears in the execution data, so unlike a bare "no qualifying
  posts" case it cannot pass by accidentally exercising the empty-input path instead.

## The `watermark-*` fixtures

Added 2026-08-25. These are the exception to the rule above, and the exception is the point.

`Run State.last_successful_run_at` is the start of the reply search window. The two ways of
getting it wrong are not symmetrical:

- A **stale** marker causes re-reads. Wasteful, never wrong, self-correcting.
- A marker **advanced past replies that were never read** loses them permanently, because
  they are never requested again.

So: advance on every pass that genuinely finished, including the boring ones; never advance
on a pass that left anything unread.

| Fixture | Must |
| --- | --- |
| `watermark-no-qualifying-posts` | advance — no post cleared the 10-reply filter |
| `watermark-all-posts-discarded` | advance — production's live shape: 3 posts, all below the threshold |
| `watermark-no-tracked-users` | advance — no active tracked users |
| `watermark-quiet-replies-advances` | advance — control, replies all previously scored |
| `watermark-analyzed-advances` | advance — control, a complete pass. **Staging only** |
| `watermark-truncated-posts-holds` | **hold** — posts search hit the page cap |
| `watermark-truncated-replies-quiet-holds` | **hold** — replies search hit the page cap |
| `watermark-truncated-replies-analyzed-holds` | **hold** — same, with scoring. **Staging only** |

**Every other fixture here pins `Advance Run State` and `Advance Run State (Quiet Pass)`, so
the UPDATE never executes and its reachability is never tested. That is exactly why the
2026-08-25 production defect survived staging validation** — the marker sat `null` in
production for five runs while the pinned suite stayed green. These eight leave both writers
unpinned on purpose, so they write `Run State` for real. `run-pins.sh` snapshots the row
before each one, asserts the value afterwards, and restores it; that assertion, not the
execution status, is what the fixture exists for.

Everything with an external side effect is still pinned, `Send Scheduler Developer Alert`
included. The truncated fixtures still assert `SEARCH_PAGE_CAP_REACHED` appears in the
execution data, which proves the alert was *built* without a message being sent. (The first
version of these fixtures omitted that pin and did send real staging developer alerts —
if you add a fixture that reaches an alert branch, pin the send.)

The two `*-analyzed-*` fixtures pin `Apply Media Sentiment` and `Classify Media Replies`,
which exist only in staging, so `run-pins.sh` skips them when `XMONITOR_WORKFLOW_ID` targets
production — pin data naming an absent node is a hard error, not a warning.

## What these fixtures cannot prove

- **What any Postgres node actually writes.** Every fixture here pins the credentialed nodes,
  `Insert or update replies` included, so no assertion in this directory can observe an
  upsert's column mapping. That is not hypothetical either: production lost the `sentiment`
  and `analyzed_at` mappings on that node in the 2026-08-25 promotion and all six
  non-watermark fixtures stayed green against the broken workflow for four days
  (executions `18658`–`18664`, 2026-08-29). `ratio-from-stored-rows` is the near miss — its
  `non-negative sentiment persisted` assertion greps for `"sentiment":"Positive"`, which
  `Prepare Reply Data` emits whether or not the upsert stores it, so it describes the node
  *upstream* of the defect. `tests/n8n/reply-sentiment-persistence.test.mjs` covers this by
  leaving that one node unpinned and asserting against the table; see
  [the workflow doc](../../../docs/workflows/xmonitor-scheduled-post-tracking.md#per-reply-sentiment-persistence).
- **Multi-chunk truncation grouping.** `Attach replies to posts` groups response pages back
  to the chunk that produced them via `pairedItem`, then checks whether that chunk's *last*
  page still held a token. Pin data cannot control `pairedItem`, so every pinned page lands
  in one group. The single-chunk behaviour is covered; two chunks where only the second is
  truncated is not, and staging has never had enough candidate conversations to produce two
  chunks live.
- **Real pagination.** `test_workflow` pins HTTP Request nodes, so no fixture here actually
  exercises n8n's `options.pagination.pagination`. That was verified live instead — see
  below.

## Live pagination verification

Real pagination was proved by **shrinking the page size** so existing staging data spans many
pages, rather than waiting for a high-volume post to exist:

| Run | Settings | Result |
| --- | --- | --- |
| `14644` | `max_results=10`, `maxRequests=3` | Stopped on the cap at 3 pages / 29 replies, `replies_truncated: true`, `SEARCH_PAGE_CAP_REACHED` raised — through the real `pairedItem` path. |
| `14645` | `max_results=10`, `maxRequests=20` | Ran to exhaustion across **14 real pages**, `replies_truncated: false`. |

`14645` also confirmed the boundary-duplicate behaviour: it fetched 121 rows for a
108-reply conversation, and 121 − 108 = 13 = one repeated item per page transition. All were
absorbed by the `seen` set (`new_reply_count: 0`), so duplicates never reach OpenAI or the
database.

Both runs used temporary settings that were reverted immediately afterwards; the committed
values are `max_results=500` / `maxRequests=20` for replies and `max_results=100` /
`maxRequests=10` for posts. **Reuse this page-size trick** rather than assuming pagination
works — it is the only way to reach these paths without a genuinely oversized conversation.

## Related live evidence

Behaviour that cannot be pinned at all, verified by live staging runs:

- `14577` — an aborted pass leaves `Run State.last_successful_run_at` untouched. This is the
  invariant that stops a failed run from silently and permanently skipping replies.
- `14572` / `14576` — reply reads drop from 108 on the backfill to 0 on the next incremental
  pass, with OpenAI skipped entirely.
- `14597` — stored `Posts.analyzed_count` / `negative_ratio` match a full recompute from the
  `Replies` rows.

## Cheat sheet injection (added 2026-08-29)

Two fixtures cover the per-client sentiment cheat sheet read path, added when
`Get Active Cheat Sheets` and `Build Analyzer Batches` were inserted ahead of the analyzer.

| Fixture | Proves |
| --- | --- |
| `cheat-sheet-per-client-isolation` | Two clients each get their own OpenAI call, carrying only their own posts and only their own rules. |
| `cheat-sheet-absent-fallback` | An empty `Sentiment Cheat Sheets` table degrades to general judgement instead of stalling, and a post whose author is not in `Tracked Users` is still analyzed. |

**Why isolation is asserted the way it is.** The runner matches regexes against execution
data, so it cannot directly express "client A's payload does *not* contain client B's post".
Instead each fixture asserts the *contiguous* pairing
`"client_id":"<uuid>","cheat_sheet_version":<n>`. Those two keys are adjacent in the emitted
batch object, so a merge across clients, or a sheet handed to the wrong client, cannot
produce both pairings. The `CANARY_ALPHA` / `CANARY_BRAVO` tokens then confirm the rule text
actually reached the prompt rather than being computed and dropped.

**Why the fallback fixture exists at all.** `Get Active Cheat Sheets` is a credentialed node
sitting in the main analysis path. A Postgres node returning 0 rows emits **no items**, which
in n8n silently kills every downstream node — storage and alerting included. The node
therefore runs with `alwaysOutputData: true`, and the fixture pins the single empty item that
setting produces, so the guard cannot be removed without a test failing.

**These two fixtures pin `Get Active Cheat Sheets` deliberately.** The other fixtures leave it
unpinned and let it run its real read-only `SELECT` against staging, which is harmless. That
means their behaviour changes once a real sheet is activated — none of them assert on cheat
sheet fields, so that is safe, but keep it in mind when adding assertions.
