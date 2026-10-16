# Telegram Router Risky Path Pin Data

These fixtures are for `XMonitor - Telegram Router Staging` (`oLwwjO05IcRjtF8E`).
They let regression tests reach risky branches without live X writes, SMM orders,
Supabase mutations, Telegram sends, or AI generation.

Use each `*.pinData.json` file as the `pinData` argument for n8n MCP
`test_workflow` against the staging router. The files intentionally pin:

- The `Telegram Trigger` input.
- External read/write nodes on the exercised path.
- HTTP Request nodes that would call X or SMM.
- Telegram output nodes that would notify real chats.
- AI/Supabase nodes on the comment-order path.

## Fixtures

**Since 2026-10-03 the alert button `hide_replies:<POST_ID>` only opens a
percentage menu.** The fixtures that reach the queue press a menu choice,
`hide_pct:<POST_ID>:<25|50|75|100|custom>`, instead. Every stored reply now
carries `sentiment`, because only `Negative` replies are hide candidates.

- `hide-replies-enqueue.pinData.json`: presses 100% against four negative
  replies — `New`, `null`, `hidden`, `hide_failed` — plus one Neutral and one
  Positive. Verifies the Neutral and Positive replies are never queued, the
  already-hidden negative counts toward the target while `hide_failed` stays
  eligible, the three candidates go into `Moderation Queue` as one batch, the
  Telegram reply states its denominator, and the sent `message_id` is written
  back so the drain can edit it.
- `hide-replies-all-hidden.pinData.json`: verifies an all-hidden negative set
  sends a clean user message, writes nothing, and does not send the
  no-replies developer alert.
- `hide-replies-menu.pinData.json`: the alert button opens the 25/50/75/100/Custom
  menu and reads or writes nothing.
- `hide-replies-percentage.pinData.json`: 50% of six negatives (one hidden)
  queues exactly the two oldest visible ones. Reply ids are shuffled and one is
  a digit shorter, which proves the order is numeric snowflake order, not row
  order or string order.
- `hide-replies-custom-percentage.pinData.json`: the Custom button answers the
  callback, pins the send-and-wait form as `34`, and queues the two oldest of
  three (34% rounds up).
- `hide-replies-invalid-percentage.pinData.json`: `/hide POST_ID 150` is
  rejected by `Validate Hide Percentage` before any lookup.
- `unknown-command-default-help.pinData.json`: an unknown command reaches
  `Send Default Help` through the switch fallback (output 14). Before
  2026-10-03 that output was unwired and unknown commands got no reply.

**Deleted 2026-08-26** — `hide-replies-success`, `hide-replies-provider-error`,
`hide-replies-skip-hidden`, `hide-replies-rate-limit-precheck`, and
`hide-replies-rate-limit-partial`. The router no longer calls X, so these pinned
nodes (`Hide Reply On X`, `Prepare Hide Result`, `Update Reply Status`,
`Send Hide Summary`) no longer exist, and the workflow static-data rate-limit
precheck they exercised has been removed. The scenarios they covered now live in
`tests/n8n/moderation-queue-drain.test.mjs` with fixtures in
`tests/n8n/moderation-queue-drain-pins/`: successful hides, provider errors and
their permanent-vs-retryable classification, quota exhausted mid-batch, 429
handling, and attempts exhaustion. `hide-replies-skip-hidden` is superseded by
the mixed-status set in `hide-replies-enqueue`.
- `order-likes-success.pinData.json`: exercises `/order_likes POST_ID AMOUNT`
  and pins the SMM add/status calls.
- `order-comments-confirm-success.pinData.json`: exercises `/order_comments`,
  pins the comment-amount form as `12`, pins exactly 12 supportive comments,
  pins the send-and-wait confirmation as `Confirm`, then pins the SMM
  add/status calls.
- `order-comments-invalid-amount.pinData.json`: submits `9` in the amount form,
  pins the Telegram validation error, and verifies that post lookup, generation,
  and ordering are skipped.
- `track-users-soft-delete.pinData.json`: exercises `/track @handle` and proves
  the branch parses and validates *before* touching any row, deactivates only the
  caller's tracked users instead of deleting every row, and restores the parsed
  handle list past the deactivate so `Split Users To Track` is not starved.
- `track-users-invalid-input.pinData.json`: exercises `/track ?????` and proves an
  invalid input changes nothing — neither `Clear Telegram User Links` nor
  `Deactivate Tracked Users For Chat` runs.

`TRACK-FIX-EVIDENCE.md` records what these two fixtures were built for, including
the live staging runs that caught three defects the pinned runs could not: pinning
a Supabase node means the scoped database call never actually happens.

## Expected Safety

These fixtures should be treated as safe regression tests only while all
credentialed and HTTP nodes listed in the file remain pinned. If a risky path
adds a new external node, add it to the relevant fixture before running the test.
X hide quota is no longer tested here. It is not workflow state any more — it
lives in the `X Rate Limits` table, keyed by `(x_user_id, endpoint)`, and is
exercised by the drain fixtures. The `x_hide_rate_limit_override` field the old
precheck fixtures set on the pinned X auth account is dead and reads nowhere.

## Live Order Info database integration

Run `node tests/n8n/order-info-database.integration.test.mjs` from the repository
root to prove that staging Postgres can insert and conflict-update an `Order Info`
row. The test creates an inactive, temporary n8n workflow and pins only its
manual trigger and fake SMM response. Its Postgres nodes run live, verify all 28
columns returned by the table, delete the deterministic test row, confirm that
zero rows remain, and then delete the temporary workflow. It never calls the SMM
provider, Telegram, X, or OpenAI.
