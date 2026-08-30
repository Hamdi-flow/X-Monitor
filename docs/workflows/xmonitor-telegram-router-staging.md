# XMonitor - Telegram Router Staging

## Purpose

Staging copy of the production Telegram router. This is the preferred workflow for agent-driven router changes and tests because it can use staging credentials and pinned data before changes are promoted to production.

## Identity

- n8n ID: `oLwwjO05IcRjtF8E`
- Environment: staging
- Active: yes
- Local export: `workflows/staging/xmonitor-codex-staging.json`
- Node count: `147`
- Last observed live update: `2026-08-30T08:2xZ` (T5 + deactivate fix, published `4b436194-a5a0-4a4e-a69a-29252e3f38bd`)
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
| Order placement retry | `retryOnFail: false` explicit on `Place Comment Order` and `Place Likes Order` | Same, set in the same change on 2026-08-25 |

## Order Placement Must Never Retry

Both order nodes carry an explicit `"retryOnFail": false` in both environments. SMMWiz's `add` endpoint is not idempotent and has no cancel, so a retried request that already reached the provider becomes a second real, charged order.

The property was previously absent, leaving correct behaviour resting on n8n's default rather than on a recorded decision. A sticky note sits beside each node on the canvas explaining why, and `tests/n8n/telegram-router-retry-guard.test.mjs` fails if the setting goes absent or true, or if `typeVersion` moves off `4.4`.

## Tracking Delete Behavior

`/track` no longer deletes tracked users. It deactivates the **target client's** rows and re-activates the ones it resolves, so post and reply history survives a re-track. Before T5 the scope was the caller's chat; see Client-Scoped Tracking below for why that had to change.

History of this branch, because the earlier fix made things worse before better:

1. Staging execution `3906` failed on 2026-07-07 at `Clear Tracked Users For Chat` because `Tracked Users.user_id = 951803761` was still referenced by `Posts.user_id`.
2. Migration `20260707173226_cascade_tracked_user_posts_and_replies` resolved that failure by making `Tracked Users` → `Posts` → `Replies` cascade on delete. That silenced the error but turned an unscoped delete into a global wipe: the node's only filter was `user_id neq` with no value, so every `/track` deleted every tracked account, post, and reply for every chat.
3. Migration `db/migrations/2026-08-24-tracked-users-soft-delete.sql` reverses that. `Posts_user_id_fkey` is now `ON UPDATE CASCADE ON DELETE RESTRICT`, and `Tracked Users` gained `telegram_chat_id` and `is_active`. `Replies_post_id_fkey` deliberately stays `ON DELETE CASCADE` — deleting a post should still remove its replies; only the `Tracked Users` → `Posts` edge was dangerous, because that is the edge the unscoped delete crossed.

Indexes `posts_user_id_idx` and `replies_post_id_idx` still cover the foreign-key columns, so `RESTRICT` is enforced against an index rather than a sequential scan. `tracked_users_active_owner_idx` on `(telegram_chat_id) WHERE is_active` serves both the router's scoped deactivate and the scheduler's active-only read.

Fixtures `track-users-soft-delete.pinData.json` and `track-users-invalid-input.pinData.json` cover this branch; `TRACK-FIX-EVIDENCE.md` in the same directory records the pinned and live staging runs and the production promotion.

## Client-Scoped Tracking (Phase T5)

`/track` is staff-only (T2) and must name the client it is tracking **for**:

```
/track client:<slug> @user1 @user2
```

The token is **labelled, not positional**, because `Parse Users To Track` accepts bare words as usernames — under a positional syntax `/track acme @foo` is genuinely ambiguous, and getting it wrong silently files an account under the wrong client. The token is stripped before username extraction, so a slug can never be parsed as a handle.

It is **required, with no default**. Omitting it refuses (`invalid_reason: missing_client`) *before* the deactivate, so a mistyped `/track` cannot empty a client's list. There is deliberately no fallback: the pre-T5 path fell back to "the sole active client", which returns NULL the moment a second `Clients` row exists and fails the `NOT NULL` on `Tracked Users.client_id`.

```
If Track Users Input Valid
  -> Resolve Track Client        slug -> active client, plus the valid-slug list
  -> Build Track Client Result   merges client onto the payload; fails closed
  -> If Track Client Known
       [true]  -> Clear Telegram User Links ...   (the original chain)
       [false] -> Build Access Refusal            (refusal_reason: unknown_client)
```

An unknown or inactive slug is named back to the caller along with the valid slugs. That is safe **here and nowhere else** — `/track` is staff-only, so the message only ever reaches a chat already allowed to act across every client. The T2 post refusals stay deliberately indistinguishable.

### `Tracked Users.telegram_chat_id` is deprecated

**`client_id` is the sole ownership key.** `/track` no longer writes `telegram_chat_id`; existing values are left alone as historical record, and the column is scheduled for removal in T6. A staff caller's chat is neither client's chat, so writing it would misattribute ownership, and a client may hold several chats or none — there is no correct single value.

The upsert guard changed with it. It used to compare **chats**:

```sql
WHERE "Tracked Users".telegram_chat_id IS NULL
   OR "Tracked Users".telegram_chat_id = EXCLUDED.telegram_chat_id
```

which stopped meaning anything once `/track` became staff-only — a staff chat matches no client's rows, so any staff caller could have moved an account between clients. It now reads `"Tracked Users".client_id = EXCLUDED.client_id`: **one X account belongs to one client**. `Deactivate Tracked Users For Chat` was re-keyed the same way; its name is kept because three pinned fixtures reference it.

### Deactivation happens last, and by difference

`/track` replaces a client's list, so accounts the caller did not name are deactivated. That deactivate runs **after** the upserts and takes the set of accounts actually written:

```
Upsert Tracked X User -> Link Telegram User To X User -> Build Track Outcome
  -> Deactivate Tracked Users For Chat -> Build Track Result Message -> Send Tracking Success
```

It used to run first, which meant any later failure — a blocked ownership takeover, or a failed X lookup — emptied the client's list and still reported success (staging execution `19263`). Nothing is deactivated now until at least one account has been written, so a wholly failed `/track` is a no-op. The `jsonb_array_length($2::jsonb) > 0` guard in the statement is load-bearing: with an empty succeeded set the `NOT EXISTS` would match every row.

`Build Track Result Message` reports all three outcomes — tracked, stopped, and blocked. A blocked account is named rather than being folded into a success message, because "already tracked by another client" is something only staff can resolve. Proved by `19351` (blocked takeover changes nothing) and `19352` (replace still deactivates the dropped account, and says so).

## Client Administration (Phase T5)

Three staff-only commands, so a client can be onboarded with no hand-written SQL (the console is read-only). All three route through `If Client Admin Is Staff` into `Route Client Admin Intent`, and a non-staff caller lands on the same `Build Access Refusal` as `/track` with `refusal_reason: staff_only_command`.

| Command | Effect |
| --- | --- |
| `/clients` | lists active clients, their attached chats, and per-client thresholds |
| `/client_new <slug> <Name>` | creates a `Clients` row; re-running with an existing slug reports it rather than failing |
| `/client_attach <slug> <chat_id> [role] [label]` | upserts a `Client Members` row; `role` defaults to `client`, and re-attaching reactivates |

`role` is optional and positional, so a label in its place is treated as a label rather than an invalid role. An unknown slug on `/client_attach` reports the unknown client instead of silently succeeding — the insert selects from an empty CTE, so an empty result is the signal.

## Per-Chat Command Menus (Phase T5)

The **client** menu is the baseline and goes on both the default scope and `all_private_chats`. This matters: `all_private_chats` silently overrides the visible default menu, so whatever sits there is what an ordinary chat sees. Putting the client menu there means a chat that is not explicitly staff can never be offered `/track` or a client-administration command. Staff chats get the fuller menu through a per-chat scope, which outranks `all_private_chats` for that chat.

`scripts/set-telegram-bot-commands.ps1` takes `-StaffChatIds` and `-ClientChatIds` and throws if a client scope ever contains a staff command. A per-chat scope can only be set for a chat Telegram already knows — an unknown id returns `Bad Request: chat not found`.

## OAuth Carries The Client (Phase T5)

`Resolve Auth Client` sits between the route switch and `Generate X OAuth Link` and resolves either an explicit `client:<slug>` typed by staff or the caller's own client when they belong to exactly one. `Save Auth Session` records it on `X Auth Sessions.client_id`, and the callback stamps it onto `X Auth Accounts.client_id`.

Resolution is **best-effort and never refuses**: a chat with no client authorizes exactly as before, leaving `client_id` null. Breaking this flow would mean clients cannot connect X accounts at all, and the failure would only surface the next time someone ran `/auth_x`.

> `Generate X OAuth Link` now sits *behind* a Postgres node, so `$json` is that row and the chat id must come from `Parse Telegram Message`. Missing this wrote a session with a null `telegram_chat_id`, leaving the callback with nowhere to reply — caught by staging execution `19264` and fixed before publish.

## Hide Replies Enqueues, It No Longer Calls X

**Changed 2026-08-26, promoted to production 2026-08-27.** The hide branch does not call X at all any more. It enqueues, and [XMonitor - Moderation Queue Drain](./xmonitor-moderation-queue-drain-staging.md) does the hiding inside the real per-token quota, woken by a `pg_cron` heartbeat only when the queue has due rows. This implements [limits-and-capacity.md §2.2](../architecture/limits-and-capacity.md) and closes defect G in [multi-tenant-and-web-ui.md](../architecture/multi-tenant-and-web-ui.md).

The branch is now:

```
Prepare Account For Replies → Get Replies For Post → Build Hide Queue Items → If Replies Found
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
- Use `tests/n8n/telegram-router-risky-pins/` for `hide_replies`, `order_likes`, and `order_comments` paths. Comment-order coverage includes the amount form's success and invalid-range branches. Hide-replies coverage here is now `hide-replies-enqueue` (mixed statuses: new, null, already-hidden, `hide_failed`) and `hide-replies-all-hidden`.
- The X-facing hide scenarios — success, provider errors, rate limiting, attempts exhaustion — moved to `tests/n8n/moderation-queue-drain.test.mjs` with fixtures in `tests/n8n/moderation-queue-drain-pins/`, because the router no longer calls X. The `hide-replies-success`, `-provider-error`, `-skip-hidden`, `-rate-limit-partial`, and `-rate-limit-precheck` fixtures were deleted on 2026-08-26: they pinned nodes that no longer exist and a static-data precheck that no longer runs.
- Keep HTTP requests, Telegram sends, Supabase writes, OpenAI generation, and SMM calls pinned when exercising risky paths without explicit live approval.
- Never run live `hide_replies`, `/order_comments`, or valid `/order_likes` from staging without explicit approval. A live `hide_replies` now only writes queue rows, but activating the drain is what actually hides on X — that needs its own approval.

## Agent Change Guidance

- Make router changes here first, then mirror the minimal change into production after validation.
- If changing scheduled alert button payloads, update both scheduled tracking and the router fixtures.
- Keep local exports in `workflows/staging/xmonitor-codex-staging.json` and `workflows/active/xmonitor-telegram-router.json` aligned after promotion.
