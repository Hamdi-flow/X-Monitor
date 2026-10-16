# XMonitor - Telegram Router Staging

## Purpose

Staging copy of the production Telegram router. This is the preferred workflow for agent-driven router changes and tests because it can use staging credentials and pinned data before changes are promoted to production.

## Identity

- n8n ID: `oLwwjO05IcRjtF8E`
- Environment: staging
- Active: yes
- Local export: `workflows/staging/xmonitor-codex-staging.json`
- Node count: `155`
- Last observed live update: `2026-10-03T08:17:07Z` (published, `activeVersionId` `d4b403b4-c7b7-40e2-8273-72bfcb301fc6`)
- Error workflow: `XMonitor - Staging Developer Error Alerts` (`CCzwnMyoy7UequuI`)
- Main trigger node: `Telegram Trigger`

## Relation To Production Router

This workflow mirrors [XMonitor - Telegram Router](./xmonitor-telegram-router.md): same intent parser, route structure, post status actions, comment-order path, likes-order path, and order persistence shape.

**The hide-replies path was promoted to production on 2026-08-27** and the two environments match again. Promotion moved four things together, in this order so the router never enqueues into a queue nothing drains: both migrations against the production project, the production drain workflow (`vm4UNW7OIx2zEGb4`) published and activated, its Vault secrets and `pg_cron` job enabled, and only then this router branch.

Important staging deltas:

| Area | Staging value | Production value |
| --- | --- | --- |
| OAuth callback path | `/webhook/x-oauth-callback-staging` | `/webhook/x-oauth-callback` |
| OAuth scopes | includes `tweet.write` plus read/moderate/offline scopes | read/moderate/offline scopes |
| Error workflow | Staging developer error alerts | none configured in export |
| Credentials | Staging Supabase/Postgres/Telegram where configured | Production credentials |
| Hide replies | **Enqueues into `Moderation Queue`**; hiding and failure alerts belong to the drain workflow | Same since the 2026-08-27 promotion |
| Hide percentage | Menu + `/hide POST_ID PERCENT`; percentage of stored **negative** replies, oldest first. See below. | **Not promoted.** Hides every stored reply for the post, whatever its sentiment. Unknown commands get no reply there either (unwired fallback). |
| Order placement retry | `retryOnFail: false` explicit on `Place Comment Order` and `Place Likes Order` | Same, set in the same change on 2026-08-25 |
| SMM API key | n8n credential (`httpTemplatedCustomAuth`) on both order nodes; no `apiKey` in any Set node | Still a plain-text `apiKey` in `Set Comment Service Config` / `Set Likes Service Config`; not promoted |

## SMM API Key Lives In A Credential

Changed 2026-10-03. The SMMWiz key used to be a plain-text `apiKey` assignment in
`Set Comment Service Config` and `Set Likes Service Config`. It was copied forward through
`Prepare Comment Order Request` / `Prepare Likes Order Request` and sent as the `key` form
field. That put it in every export, in git history, and in the stored item data of every
order execution.

Now:

- None of the four Set nodes has an `apiKey` assignment.
- `Place Comment Order` and `Place Likes Order` use `authentication: genericCredentialType`,
  `genericAuthType: httpTemplatedCustomAuth`, and no longer list `key` in their body
  parameters. The credential injects `key` into the same form-urlencoded body, so SMMWiz
  should still receive `key`, `action=add`, `service`, `link`, `comments`/`quantity`.
- The credential has to be created and bound **in the n8n UI**, because the n8n MCP cannot
  create credentials. Template: `{"body":{"key":"{{api_key}}"}}`, with the key in the
  secret field. Suggested name: `SMMWiz API (Staging)`.
- **Until a credential is bound, a live staging `/order_comments` or `/order_likes` fails at
  the order node and places no order.** It fails closed, but the steps before it on that
  path (post lookup, comment generation, `Store … Order Post`) will already have run.

The pinned fixtures pin both order nodes. They prove the graph is intact and that no
`apiKey` appears in item data. They do **not** prove the credential lands in the request
body. Prove that once with a non-SMM echo before the first live staging order (see
`TASK_TODOLIST.md`).

## Order Placement Must Never Retry

Both order nodes carry an explicit `"retryOnFail": false` in both environments. SMMWiz's `add` endpoint is not idempotent and has no cancel, so a retried request that already reached the provider becomes a second real, charged order.

The property was previously absent, leaving correct behaviour resting on n8n's default rather than on a recorded decision. A sticky note sits beside each node on the canvas explaining why, and `tests/n8n/telegram-router-retry-guard.test.mjs` fails if the setting goes absent or true, or if `typeVersion` moves off `4.4`.

## Tracking Delete Behavior

`/track` no longer deletes tracked users. It deactivates the **caller's** rows and re-activates the ones it resolves, so post and reply history survives a re-track.

History of this branch, because the earlier fix made things worse before better:

1. Staging execution `3906` failed on 2026-07-07 at `Clear Tracked Users For Chat` because `Tracked Users.user_id = 951803761` was still referenced by `Posts.user_id`.
2. Migration `20260707173226_cascade_tracked_user_posts_and_replies` resolved that failure by making `Tracked Users` → `Posts` → `Replies` cascade on delete. That silenced the error but turned an unscoped delete into a global wipe: the node's only filter was `user_id neq` with no value, so every `/track` deleted every tracked account, post, and reply for every chat.
3. Migration `db/migrations/2026-08-24-tracked-users-soft-delete.sql` reverses that. `Posts_user_id_fkey` is now `ON UPDATE CASCADE ON DELETE RESTRICT`, and `Tracked Users` gained `telegram_chat_id` and `is_active`. `Replies_post_id_fkey` deliberately stays `ON DELETE CASCADE` — deleting a post should still remove its replies; only the `Tracked Users` → `Posts` edge was dangerous, because that is the edge the unscoped delete crossed.

Indexes `posts_user_id_idx` and `replies_post_id_idx` still cover the foreign-key columns, so `RESTRICT` is enforced against an index rather than a sequential scan. `tracked_users_active_owner_idx` on `(telegram_chat_id) WHERE is_active` serves both the router's scoped deactivate and the scheduler's active-only read.

Fixtures `track-users-soft-delete.pinData.json` and `track-users-invalid-input.pinData.json` cover this branch; `TRACK-FIX-EVIDENCE.md` in the same directory records the pinned and live staging runs and the production promotion.

## Hide Replies By Percentage

**Changed 2026-10-03, staging only — not yet promoted.** The user now picks what share of a post's negative replies should be hidden.

| Input | Intent | Result |
| --- | --- | --- |
| Alert button `hide_replies:<post_id>`, `/hide POST_ID`, `/hide_replies POST_ID`, "hide replies of post N" | `HIDE_MENU` | `Build Hide Percentage Menu` sends 25% / 50% / 75% / 100% / Custom % buttons. Nothing is read or written. |
| Menu button `hide_pct:<post_id>:<25,50,75,100>` | `HIDE_REPLIES` | Applies that percentage. |
| Menu button `hide_pct:<post_id>:custom` | `HIDE_REPLIES` | `Answer Hide Callback` then `Prompt For Hide Percentage`, a send-and-wait number form like the likes amount prompt. |
| `/hide POST_ID PERCENT` (`50` or `50%`) | `HIDE_REPLIES` | Applies directly. |

The alert button payload is unchanged (`hide_replies:<post_id>`), so the scheduler did not need to change. Pressing it now opens the menu instead of hiding at once.

`HIDE_REPLIES` goes through `If Hide Percentage Needed` → (form) → `Validate Hide Percentage` → `If Hide Percentage Valid` before `Get Post For Hide`. A missing post ID, extra arguments, or a value outside 1–100 (whole numbers only) goes to `Send Hide Percentage Error` without any lookup. The tenancy gate (`If Hide Authorized`) is unchanged and still runs after validation.

What the percentage means (`Build Hide Queue Items`):

- **Denominator: stored replies with `Replies.sentiment = 'Negative'`.** This is the same set the alert's hidden / not-hidden counts use. Neutral, Positive and unanalyzed replies are never queued. *This also fixes a pre-existing bug:* the branch used to queue every stored reply for the post, whatever its sentiment, because `Replies` started storing every analyzed reply and nothing here filtered by sentiment.
- **It is a target, not an increment.** `target = ceil(negatives × percent / 100)`; already-hidden negatives count toward it, and only `target − already hidden` more are queued. Pressing 50% twice queues nothing the second time, which is reported as `hide_target_already_met`. Rounding up means 1% of a small post still hides one reply, and 100% always means every negative.
- **Oldest first, by reply ID.** X reply IDs are snowflakes, so numeric order is creation order on X. `Replies.created_at` is not used because it records when the row was stored, which is late for backfilled replies.
- `hide_failed` and no-status rows stay eligible, as before.

The queued summary now states the denominator: `Target: 50% of 40 negative replies = 20 hidden`, plus already-hidden and `Queued to hide: N (oldest first)`. No negatives at all sends "Nothing to hide" and skips the no-replies developer alert; that alert still fires only when the post has no stored replies whatsoever.

Known limit: lowering the percentage does not cancel rows an earlier, higher request already queued. Press 75% and then 25% before the drain finishes, and the 75% batch still drains.

### Switch fallback fix

Appending the `HIDE_MENU` rule moved the switch's fallback output from 13 to 14. While doing it we found the fallback had been **unwired**: when the three client-admin rules were added, `Send Default Help` stayed on output 10 (now `LIST_CLIENTS`), so unknown commands got no reply at all (pinned execution `40967`). The fallback (output 14) is now wired to `Send Default Help`, and the stray `LIST_CLIENTS` → `Send Default Help` edge is removed.

## Hide Replies Enqueues, It No Longer Calls X

**Changed 2026-08-26, promoted to production 2026-08-27.** The hide branch does not call X at all any more. It enqueues, and [XMonitor - Moderation Queue Drain](./xmonitor-moderation-queue-drain-staging.md) does the hiding inside the real per-token quota, woken by a `pg_cron` heartbeat only when the queue has due rows. This implements [limits-and-capacity.md §2.2](../architecture/limits-and-capacity.md) and closes defect G in [multi-tenant-and-web-ui.md](../architecture/multi-tenant-and-web-ui.md).

The branch is now:

```
Validate Hide Percentage → If Hide Percentage Valid → Get Post For Hide → … → Prepare Account For Replies
    → Get Replies For Post → Build Hide Queue Items → If Replies Found
    ├─ true  → Enqueue Hide Requests → Build Hide Queued Summary
    │            → Send Hide Queued Summary → Store Queue Message Id
    └─ false → Send No Replies → Build/Send Developer Alert - No Replies
```

`Build Hide Queue Items` (renamed from `Build Reply Hide Items`) still skips stored replies already marked `Replies.status='hidden'`; rows with no status, a non-hidden status, or `hide_failed` remain eligible so retries still work. If every stored reply is already hidden locally it sends a clean user message, writes nothing, and does not fire the no-replies developer alert. Otherwise it mints a `batch_id` and emits **one** item carrying every candidate, so `Enqueue Hide Requests` runs a single upsert into `Moderation Queue`.

That upsert is `ON CONFLICT (reply_id) DO UPDATE`, which re-arms a row sitting in `failed`, `abandoned`, or `done` — so pressing Hide again after fixing a revoked token works — while leaving an `in_flight` row alone, because its request may already be airborne.

`Send Hide Queued Summary` reports the honest queued count and states that X allows 50 hides per 15 minutes when the batch is larger. `Store Queue Message Id` then writes that message's `message_id` onto the batch's queue rows, which is what lets the drain edit the message in place as it progresses (§2.2 step 4).

### What was removed

`Hide Reply On X`, `Prepare Hide Result`, `Update Reply Status`, `Build Hide Summary`, `Send Hide Summary`, `Build Developer Alert - Hide Failures`, and `Send Developer Alert - Hide Failures` are gone from this workflow. Their behaviour — including the failure classification categories, the `Replies.status` write, and the sanitized developer alert — moved to the drain, which is where hide failures now happen.

The **workflow static-data rate-limit cache is gone too**. `$getWorkflowStaticData('global').xHideRateLimits` was per-workflow while the X limit is per access token, and it was invisible to any second entry point. Quota now lives in the `X Rate Limits` table, keyed by `(x_user_id, endpoint)`. Nothing in this workflow reads or writes it any more; the drain owns throttling entirely, which is why the precheck that used to skip or truncate a hide batch no longer exists.

## Comment Orders

The staging `/order_comments POST_ID` branch asks the user to choose how many supportive comments to generate for the original post or author instead of deriving the amount from stored negative replies.

`Prompt For Comment Amount` opens a required Telegram number form. `Validate Comment Order Input` accepts whole numbers from `10` to `250`, matching SMM service `8404`; invalid input is reported before post lookup or generation.

`Build Supportive Comment Prompt` reads the stored post and tracked author, then uses the validated form amount as `order.comment_count`. The branch no longer reads stored reply rows or uses reply text as generation context.

`Generate Supportive Comments` uses the existing OpenAI model subnode with a structured parser that returns `supportive_comments[].comment_text`. The prompt asks for short, varied, natural positive comments, occasional emoji, and no direct rebuttals or references to criticism, moderation, bots, AI, or generated orders.

`Build Comment Order Payload` requires exactly the requested number of unique generated comments, then creates the Telegram preview plus SMMWiz newline-delimited comments payload. The previous split/loop/save/readback flow was removed, so normal staging comment orders no longer write generated text to `Replies.counter_reply_text` before confirmation.

## Snooze Duration Menu

The staging router supports a two-step snooze flow for alert buttons:

1. `snooze:<post_id>` sends a new Telegram message with a fixed inline menu. The original alert message is left unchanged.
2. The menu offers `1 hour`, `4 hours`, `12 hours`, and `24 hours`.
3. Selecting an option sends `snooze_duration:<post_id>:<duration>` and updates `Posts.status` to `Snoozed`.
4. The selected duration maps directly to hourly scheduler runs: `1`, `4`, `12`, or `24` in `Posts.snooze_runs_remaining`.

Slash commands use the same rules. `/snooze POST_ID` opens the fixed menu, while `/snooze POST_ID 4h` applies a valid duration directly. Unsupported durations are rejected with a validation message.

## Authorization (Phase T2)

Identical to production — see
[`xmonitor-telegram-router.md`](./xmonitor-telegram-router.md) § Authorization for the full
design, the refusal table, and the rule that `post_not_found` and `cross_tenant_post` must
return the same message.

Staging-specific detail:

- `Resolve Caller Authorization` uses the `Supabase Staging Postgres` credential.
- The staging operator chat `8677383067` holds **both** a `Client Members` row of `house`
  and a `Staff` row. The `Staff` row is what lets it act across every client, and it is also
  why every fixture in `tests/n8n/telegram-router-risky-pins/` still passes unchanged: those
  fixtures all run as that chat, and their pinned post rows predate T1 and carry no
  `client_id`, so only the `is_staff` short-circuit keeps them green.
- Developer alerts go to `8677383067` here, same as production.

## Testing Guidance

- Safe direct checks include `/help`, invalid commands, `/auth_x` link generation with side-effect nodes pinned, and validation failures.
- For snooze changes, pin Telegram inputs for `snooze:<post_id>`, `snooze_duration:<post_id>:12h`, invalid duration commands, and missing post IDs.
- Use `tests/n8n/telegram-router-risky-pins/` for `hide_replies`, `order_likes`, and `order_comments` paths. Comment-order coverage includes the amount form's success and invalid-range branches. Hide-replies coverage here is `hide-replies-enqueue` (mixed statuses and sentiments at 100%), `hide-replies-all-hidden`, `hide-replies-menu`, `hide-replies-percentage` (50%, oldest-first ordering), `hide-replies-custom-percentage` (the form), and `hide-replies-invalid-percentage`; `unknown-command-default-help` covers the switch fallback. Last pinned pass 2026-10-03: executions `40971`–`40980`.
- The X-facing hide scenarios — success, provider errors, rate limiting, attempts exhaustion — moved to `tests/n8n/moderation-queue-drain.test.mjs` with fixtures in `tests/n8n/moderation-queue-drain-pins/`, because the router no longer calls X. The `hide-replies-success`, `-provider-error`, `-skip-hidden`, `-rate-limit-partial`, and `-rate-limit-precheck` fixtures were deleted on 2026-08-26: they pinned nodes that no longer exist and a static-data precheck that no longer runs.
- Keep HTTP requests, Telegram sends, Supabase writes, OpenAI generation, and SMM calls pinned when exercising risky paths without explicit live approval.
- Never run live `hide_replies`, `/order_comments`, or valid `/order_likes` from staging without explicit approval. A live `hide_replies` now only writes queue rows, but activating the drain is what actually hides on X — that needs its own approval.

## Agent Change Guidance

- Make router changes here first, then mirror the minimal change into production after validation.
- If changing scheduled alert button payloads, update both scheduled tracking and the router fixtures.
- Keep local exports in `workflows/staging/xmonitor-codex-staging.json` and `workflows/active/xmonitor-telegram-router.json` aligned after promotion.
