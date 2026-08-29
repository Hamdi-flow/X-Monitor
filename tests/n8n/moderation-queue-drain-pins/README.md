# Moderation Queue Drain pinned fixtures

Fixtures for `tests/n8n/moderation-queue-drain.test.mjs`, which exercises
**XMonitor - Moderation Queue Drain (Staging)** (`xt8fLOmRvDvTdZT9`).

Run from the repository root:

```bash
node tests/n8n/moderation-queue-drain.test.mjs
```

## What is pinned, and why it matters

Every external surface is pinned: the webhook trigger, all ten Postgres nodes,
all three Telegram nodes, `Refresh Drain X Token`, and — the one that actually
matters — **`Hide Reply On X`**. The live X hide endpoint is never called by
these tests.

What executes for real is the drain's decision logic: `Plan Drain Pass`,
`Ready To Claim`, `Prepare Hide Requests`, `Prepare Drain Hide Result`,
`Build Progress Edits`, and both alert builders. That is the code these fixtures
exist to pin. Pinning `Claim Due Hide Rows` is how each fixture controls
`attempts` per row without touching the database.

**A passing run here is not approval to hide anything on X.** Activating the
drain, or running it live, needs explicit user approval every time.

## Fixtures

| File | Proves |
| --- | --- |
| `quota-exhausted-mid-batch.pinData.json` | Two tokens. `TEST_DRAIN_PARTIAL` has 5 rows due but only 2 calls left in its window, and must plan for 2 — claiming `due_count` would overrun the 50-per-15-minute limit and turn the tail of the batch into 429s. `TEST_DRAIN_SPENT` has 0 left with the window still open, and must be deferred to `reset_at` **without reaching `Hide Reply On X` at all**. A routine quota deferral must not page a developer. |
| `rate-limit-429.pinData.json` | The hide that landed before the 429 still commits. The 429'd row is requeued, not failed; `not_before` moves to the `x-rate-limit-reset` value; that token's `remaining` is recorded as 0 so the next pass claims nothing; the rest of the token's queued rows are deferred; and no developer alert fires. Critically the attempt is **refunded** (`attempts_delta: -1`) — a 429 says nothing about whether the hide would succeed, and charging it would abandon a healthy row after five busy windows. |
| `permanent-failures.pinData.json` | 404 deleted reply, 401 revoked token, 403 non-owner, and 403 missing `tweet.moderate.write` each classify to their own category and go straight to `failed` with no `not_before` — section 2.2 step 5, "permanent failures must not be retried". `Replies.status` becomes `hide_failed` so a fixed account can re-enqueue. A developer alert does fire. |
| `unauthorized-call.pinData.json` | A call carrying the wrong `X-Drain-Secret`. `Verify Drain Secret` is deliberately **not** pinned here so the gate actually runs. Asserts not just that it says no, but that it *stops*: no X, database, or Telegram node executes, and `Reject Unauthorized Drain Call` does. This is the only fixture that exercises authentication; the other four pin the gate open so they test drain logic instead. |
| `attempts-exhausted.pinData.json` | The same retryable 503 behaves differently by attempt count: at `attempts` 5 the row is `abandoned`, at 4 and 1 it is requeued, and the backoff at 4 is longer than at 1. A 503 is never classified as a permanent failure. |

## Fake identifiers

Every id is synthetic and namespaced so it cannot collide with staging data:
`TEST_DRAIN_*` for X user ids, `999000000000000xxxx` for reply and post ids,
`00000000-0000-4000-8000-*` for queue and batch uuids, and
`PINNED_FAKE_ACCESS_TOKEN` for credentials.

## Keeping them honest

If the drain gains a new external node, add it to every fixture before running
the test — an unpinned credentialed node runs live. The test also asserts the
workflow is still inactive, that the trigger has not reverted to a Schedule
Trigger (which would reintroduce ~8,640 executions/month), that
`Verify Drain Secret` still fails closed, and that `retryOnFail: false` on the
HTTP nodes and `executeOnce: true` on the four post-outcome DB nodes have not
drifted; both are
correctness properties, not style, and the reasons are recorded in the
"Why Hide Reply On X Must Not Retry" sticky note and in
`docs/workflows/xmonitor-moderation-queue-drain-staging.md`.
