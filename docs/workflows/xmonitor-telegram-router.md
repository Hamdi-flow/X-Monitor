# XMonitor - Telegram Router

## Purpose

Production Telegram workflow that receives bot commands and alert button callbacks, routes them into XMonitor actions, and sends user or developer Telegram responses. It handles X OAuth link generation, tracked-user management, post suppression state changes, reply hiding on X, comment-order generation, likes orders, and SMM order persistence.

## Identity

- n8n ID: `cWczsttyDbTBbRAC`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-telegram-router.json`
- Node count: `127`
- Unhandled error workflow: `XMonitor - Production Developer Error Alerts` (`UmKr9JkZ3ec3GDH5`)
- Last observed live update: `2026-07-18T14:48:04.997Z`
- Main trigger node: `Telegram Trigger`

## Supported Inputs And Intents

`Parse Telegram Message` normalizes Telegram `message` and `callback_query` payloads into an `intent`, then `Route Telegram Intent` sends the item to the matching branch.

| Intent | User input or callback | Main branch |
| --- | --- | --- |
| `HELP` | `/help`, `/start`, `help`, `start`, fallback help buttons | Sends the help manual. |
| `AUTH_X` | `/auth_x`, `/auth`, `/start auth`, `/start connect_x` | Generates an X OAuth link and stores a PKCE auth session. |
| `TRACK_USERS` | `/track USERS`, `/start track-USERS` | **Staff only** (decision #3). Replaces tracked users for the chat. A non-staff chat is refused. |
| `HIDE_REPLIES` | `/hide_replies POST_ID`, `/hide POST_ID`, `hide_replies:<post_id>` | Authorizes the caller against the post's client, then enqueues stored negative replies for hiding. |
| `IGNORE_POST` | `/ignore POST_ID`, `ignore:<post_id>` | Sets the post status to `Ignored`. |
| `SNOOZE_MENU` | `/snooze POST_ID`, `snooze:<post_id>` | Sends a fixed snooze-duration menu. |
| `SNOOZE_POST` | `/snooze POST_ID 1h|4h|12h|24h`, `snooze_duration:<post_id>:<duration>` | Sets the post status to `Snoozed`. |
| `RESUME_POST` | `/resume POST_ID`, `resume:<post_id>` | Sets the post status back to `New`. |
| `ORDER_COMMENTS` | `/order_comments POST_ID` | Prompts for an amount, generates supportive comments, asks for confirmation, then places an SMM comment order. |
| `ORDER_LIKES` | `/order_likes POST_ID AMOUNT`, `order_likes:<post_id>` | Places an SMM likes order, prompting for amount when the callback omitted it. |
| `UNKNOWN` | Anything else | Sends default help. |

## Authorization (Phase T2)

Every action is authorized before it runs. One shared step resolves the caller once, and
each post lookup is then gated against that result.

```
Parse Telegram Message
  -> Resolve Caller Authorization   Postgres, one query
  -> Build Caller Authorization     Code, adds auth_client_ids / auth_is_staff / auth_is_known
  -> If Caller Known                unknown chat is refused BEFORE the route switch
  -> Route Telegram Intent
```

```
caller chat_id -> { client_ids: [...], is_staff: bool }
   client_ids = active "Client Members" rows, on active "Clients", for this chat
   is_staff   = an active "Staff" row for this chat
```

Each of the four post lookups is followed by a gate — `If Hide Authorized`,
`If Status Change Authorized`, `If Comment Order Authorized`, `If Likes Order Authorized`.
A post is actionable when it **exists** and (`is_staff` **or** its `client_id` is in the
caller's `client_ids`). The true branch continues into the original downstream node,
unchanged; the false branch goes to `Build Access Refusal`.

Six branches converge on that one refusal node: the four post gates, the unknown-chat branch,
and `If Track Caller Is Staff`.

| `refusal_reason` | When | What the user is told |
| --- | --- | --- |
| `cross_tenant_post` | the post belongs to another client | `Post <id> was not found. Wait for monitoring to flag it, then try again.` |
| `post_not_found` | no such post anywhere | **the same message, exactly** |
| `unknown_chat` | chat is in neither `Client Members` nor `Staff` | `This chat is not registered with XMonitor. Ask your account manager to add it, then try again.` |
| `staff_only_command` | `/track` from a non-staff chat | `This command is not available for this chat.` |

**The first two rows must never diverge.** Only the post id differs, and the caller supplied
that themselves. If the messages ever differ, the bot becomes an oracle for probing which
post ids exist inside other clients. The real reason lives in `refusal_reason` in execution
data and in the developer alert, never in the reply.

Refusals are clean: a friendly message, the callback answered where one exists (via
`If Refusal Has Callback` -> `Answer Access Refusal Callback`), and no half-completed side
effect. For both order branches the gate sits before `Get Comment/Likes Post Tracked User`,
so it precedes the OpenAI generation **and** the SMMWiz call — SMMWiz has no cancel, so money
is decided first.

It fails closed. `Resolve Caller Authorization` has `alwaysOutputData`; an empty result
yields no `client_ids` and `is_staff = false`, which refuses.

`Action Log` does not exist yet — it arrives with the Action Executor — so refusals are
recorded in execution data and escalated by `Build Developer Alert - Access Denied`: always
for an unknown chat (decision #7, so it can be assigned), and otherwise once a chat produces
3 refusals in a rolling hour. That counter lives in workflow static data, which n8n persists
for production executions only, so `denial_count` is always 1 in a pinned run.

`SNOOZE_MENU` is deliberately **not** gated: it renders a duration keyboard from the post id
the caller typed and never reads the database, so it is neither an oracle nor a side effect.
Picking a duration produces `SNOOZE_POST`, which is gated.

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| X OAuth redirect URI | `Generate X OAuth Link` | `https://tarek1207.app.n8n.cloud/webhook/x-oauth-callback` | Must match the production OAuth callback workflow and X app settings. |
| X OAuth scopes | `Generate X OAuth Link` | `tweet.read`, `users.read`, `tweet.moderate.write`, `offline.access` | Required for auth lookup, token refresh, and hiding replies. |
| X auth session lifetime | `Generate X OAuth Link` | `10` minutes | Stored in `X Auth Sessions.expires_at`. |
| Token refresh buffer | `Validate X Auth Account` | `2` minutes | Refreshes X tokens if they expire within this buffer. |
| Snooze duration options | `Parse Telegram Message`, `Build Snooze Duration Menu`, `Prepare Post Status Change` | `1h`, `4h`, `12h`, `24h` | Each option maps to the same number of hourly scheduler runs in `snooze_runs_remaining`. |
| Comment SMM service ID | `Prepare Comment Order Request` | `8404` | SMMWiz service used for comment orders. |
| Likes SMM service ID | `Prepare Likes Order Request` | `12104` | SMMWiz service used for likes orders. |
| Comment count limits | `Validate Comment Order Input`, `Build Comment Order Payload` | minimum `10`, maximum `250` | The form accepts only whole numbers in range and the generated unique count must match exactly. |
| Supportive-comment model | `OpenAI Chat Model - Supportive Comments` | `gpt-5.5` | Generates short, varied comments supporting the original post or author. |
| SMM provider URL | `Set Comment Service Config`, `Set Likes Service Config` | `https://smmwiz.com/api/v2` | Used by both order branches. |

## Main Branches

### Help

`Send Help Manual` and `Send Default Help` describe the bot commands and expose inline shortcuts for connecting X and starting `/track`.

The production Telegram command menu for `@trackedUsersManagerBot` uses the same `/order_comments POST_ID` syntax and was verified in both the default and `all_private_chats` scopes after the 2026-07-11 promotion.

### X OAuth

`Generate X OAuth Link` creates a PKCE `state`, `code_verifier`, and `code_challenge`, then `Save Auth Session` stores the state in `X Auth Sessions`. `Send Auth Link` sends a 10-minute authorization link to the Telegram chat.

The callback exchange itself is handled by `XMonitor - X OAuth Callback`, so changes to redirect URI, scopes, state shape, or session table fields must be coordinated with that workflow.

### Track Users

The tracking branch parses usernames from handles, URLs, or plain text, and **only once that parse succeeds** does it clear the caller's rows, look each user up through X API `GET /2/users/by/username/:username`, and write:

- `Tracked Users`: tracked X username/user ID records, stamped with the caller's `telegram_chat_id` and `is_active = true`.
- `Telegram Users`: the caller's `chat_id` only. **There is no link column** — the table is `(id, created_at, chat_id)`, so `Link Telegram User To X User` records an alert recipient, not a chat-to-account linkage.

Node order is `Parse Users To Track` → `If Track Users Input Valid` → `Clear Telegram User Links` → `Deactivate Tracked Users For Chat` → `Restore Track User List` → `Split Users To Track` → `Lookup X User By Username` → `If X User Lookup Successful` → `Upsert Tracked X User` → `Link Telegram User To X User` → `Send Tracking Success`.

`Restore Track User List` exists because both clearing nodes return Supabase rows rather than the parsed handle list. Without it `Split Users To Track` finds no `usersToTrack` field, emits zero items, and `/track` reports success while doing nothing.

`Upsert Tracked X User` is a **Postgres** node, not a Supabase one — the Supabase node has no upsert operation, and a plain create only worked while the old branch deleted every row first. Its `ON CONFLICT (user_id) DO UPDATE` is guarded by `telegram_chat_id IS NULL OR telegram_chat_id = EXCLUDED.telegram_chat_id`, so one chat cannot take over a handle another chat already tracks.

> **Fixed 2026-08-24 — was a global data-loss defect.** `Clear Tracked Users For Chat` was an unscoped Supabase `delete` (only filter: `user_id neq` with no value, matching every row), and `Clear Telegram User Links` had the same defect on `chat_id`. With `Posts_user_id_fkey` and `Replies_post_id_fkey` both `ON DELETE CASCADE`, one `/track` from any chat wiped every tracked account, post, and reply in the project. The delete is now a chat-scoped `is_active = false` update on the renamed `Deactivate Tracked Users For Chat`, the Telegram link delete is chat-scoped, and `Posts_user_id_fkey` is `ON DELETE RESTRICT` so any future unscoped delete fails loudly instead of cascading. See `db/migrations/2026-08-24-tracked-users-soft-delete.sql`, `tests/n8n/telegram-router-risky-pins/TRACK-FIX-EVIDENCE.md`, and `docs/architecture/multi-tenant-and-web-ui.md` §1.1.

Two known gaps remain, both non-destructive: a blocked ownership takeover still reports success to the caller, and a failed X lookup leaves the caller's accounts deactivated because only the parse, not the lookup, precedes the deactivate.

### Post Status Changes

`IGNORE_POST`, `SNOOZE_POST`, and `RESUME_POST` all read the target `Posts` row, validate the action, and update `Posts.status` plus `snooze_runs_remaining`.

`SNOOZE_MENU` is the first step for `/snooze POST_ID` and `snooze:<post_id>`. It sends a new Telegram message with the fixed duration menu and leaves the original alert unchanged. The selected button sends `snooze_duration:<post_id>:1h`, `4h`, `12h`, or `24h`, which continues into `SNOOZE_POST`.

| Action | Result |
| --- | --- |
| Ignore | `status='Ignored'`, `snooze_runs_remaining=0`, shows a resume button. |
| Snooze | `status='Snoozed'`, `snooze_runs_remaining=1`, `4`, `12`, or `24`, shows a resume button. |
| Resume | `status='New'`, `snooze_runs_remaining=0`, removes the resume path. |

When the action came from an alert callback, the workflow also edits the original Telegram alert message and answers the callback.

### Hide Replies

The hide branch validates that the target post exists in `Posts`, finds the X auth account for the stored post owner, refreshes the token if needed, loads stored `Replies`, then calls X API:

`PUT https://api.x.com/2/tweets/<reply_id>/hidden`

`Hide Reply On X` captures the full X response and does not throw on non-2xx provider responses. `Prepare Hide Result` classifies each reply into safe failure categories such as missing moderation permission, rejected token, non-owner moderation attempt, reply not found, already hidden, rate limited, X unavailable, network error, or unknown rejection.

Before calling X, `Build Reply Hide Items` skips stored replies already marked `Replies.status='hidden'`. Rows with no status, non-hidden status, or `hide_failed` remain eligible so retry attempts still work. If every stored reply is already hidden locally, the workflow sends a clean user message, skips X and Supabase writes, and does not send the no-replies developer alert.

The hide branch keeps a best-effort cached X hide rate-limit state from response headers (`x-rate-limit-limit`, `x-rate-limit-remaining`, and `x-rate-limit-reset`) in workflow static data. When the cached reset time is still in the future, `Build Reply Hide Items` compares available quota against candidate hide count. If no calls are available, it skips X and tells the user when to retry. If only some calls are available, it attempts the available count, leaves the rest unchanged, and reports `Skipped due to X rate limit` plus the retry timestamp.

Successful or already-hidden X results upsert `Replies.status='hidden'`; failed attempts upsert `Replies.status='hide_failed'`. `Build Hide Summary` reports total stored replies, X attempts, locally hidden replies, X already-hidden replies, rate-limit skips, hidden-now count, and failures. When failures occur it adds grouped user-facing reasons and sample reply IDs. `Build Developer Alert - Hide Failures` sends a sanitized developer alert only when at least one reply fails. This is an X write action and should only be live-tested after explicit approval.

### Comment Orders

`ORDER_COMMENTS` opens `Prompt For Comment Amount`, a required Telegram number form for a whole-number amount from `10` to `250`. Invalid values stop before post lookup, OpenAI, or SMM activity.

For valid input, the branch loads the post and tracked user, then asks OpenAI for exactly the requested number of short, varied supportive comments about the original post or author. It does not read stored replies for quantity or prompt context and does not write generated text to `Replies.counter_reply_text`.

`Build Comment Order Payload` deduplicates generated comments and requires the unique count to match the form amount before showing the Telegram preview and asking the user to choose `Confirm` or `Do nothing`.

On confirmation, it sends a SMMWiz `add` request with service `8404`, normalizes provider errors, inserts or updates an `Order Info` row, marks the `Posts` row as `Processing`, and sends a success or error message.

### Likes Orders

`ORDER_LIKES` validates `POST_ID` and a positive whole-number amount. Button callbacks prompt the user for the amount via `sendAndWait`. Valid requests send a SMMWiz `add` request with service `12104`, write an `Order Info` row, mark the `Posts` row as `Processing`, and notify the user.

## Data Stores

| Table | Use |
| --- | --- |
| `X Auth Sessions` | Temporary PKCE OAuth state and code verifier for `/auth_x`. |
| `X Auth Accounts` | Stored X access/refresh tokens and owner metadata. |
| `Telegram Users` | Alert recipients, `chat_id` only. Despite the name of `Link Telegram User To X User`, there is no chat-to-account link column. Retired as a routing source at T3, not T2. |
| `Clients` / `Client Members` / `Staff` | Read by `Resolve Caller Authorization` to decide who may act on which post. `Staff` is a chat that may act across every client. |
| `Tracked Users` | Usernames and X user IDs monitored by scheduled tracking, owned by `telegram_chat_id` and enabled by `is_active`. |
| `Posts` | Flagged posts plus status state: `New`, `Snoozed`, `Ignored`, `Processing`. |
| `Replies` | Stored negative replies; the hide branch updates reply status. Historical `counter_reply_text` values may remain, but new comment orders do not use or write them. |
| `Order Info` | SMM provider order tracking for comment and likes orders. |

## External Side Effects

- Sends Telegram messages, callback answers, edited messages, and `sendAndWait` prompts.
- Calls X API for user lookup, OAuth token refresh, and hiding replies.
- Calls OpenAI to generate supportive comment options.
- Calls SMMWiz to place comment and likes orders.
- Writes production Supabase/Postgres tables listed above.
- Reads `Client Members`, `Clients` and `Staff` on **every** update, before the route switch.

## Configuration Risks

- The workflow export currently contains inline SMMWiz API key configuration in the order service config nodes. Do not copy the key into docs or logs. Prefer moving it into n8n credentials or another secret store before further promotion work.
- The X OAuth client ID and client secret are embedded in code nodes in the export. Treat them as sensitive configuration and avoid printing or duplicating them.
- `/order_comments`, `/order_likes`, and `hide_replies` have real external side effects. Use staging and pinned tests unless the user explicitly approves live X writes or SMM orders.

### Order placement must never retry

`Place Comment Order` and `Place Likes Order` carry an explicit `"retryOnFail": false`, set 2026-08-25 in both routers. Do not remove it, and do not turn it on.

SMMWiz's `add` endpoint is not idempotent and has no cancel. An HTTP timeout does not mean the request failed to arrive — if it reached SMMWiz the order exists and the client has already been charged, so a retry places and charges a **second real order** with no way back.

The property used to be absent, which meant correct behaviour rested on n8n's default of `false` rather than on a decision. A node `typeVersion` bump or a well-meaning edit could have turned one click into two charges. It is now pinned explicitly, recorded on the canvas as a sticky note beside each node, and asserted by `tests/n8n/telegram-router-retry-guard.test.mjs`, which fails if `retryOnFail` becomes absent or true, or if `typeVersion` moves off `4.4`.

## Testing Guidance

- Use `XMonitor - Telegram Router Staging` (`oLwwjO05IcRjtF8E`) for changes first.
- Safe pinned or low-risk checks include `/help`, `/auth_x` link generation with pinned side-effect nodes, invalid command handling, and validation-only status/order input branches.
- Reuse fixtures in `tests/n8n/telegram-router-risky-pins/` for risky paths:
  - `hide-replies-enqueue.pinData.json`
  - `hide-replies-all-hidden.pinData.json`
  - `order-likes-success.pinData.json`
  - `order-comments-confirm-success.pinData.json`
  - `order-comments-invalid-amount.pinData.json`
- `tests/n8n/tenancy-pins/` covers the T2 refusals — cross-tenant actions, unknown chats, staff-only `/track`, and the not-found/cross-tenant message-identity check. Those fixtures pin `Resolve Caller Authorization`, so the same files run against either router.
- Keep any new credentialed, HTTP, Telegram, OpenAI, or Supabase write node pinned in risky-path tests.
- Production pinned executions `4258` through `4261` cover confirmation with 12 comments, cancellation, provider failure, and invalid amount `9`; all external nodes were pinned and no live order was placed.

## Agent Change Guidance

- When adding a command, update `Parse Telegram Message`, `Route Telegram Intent`, help text, and staging tests together. If it acts on a post, it needs an owner gate against `Build Caller Authorization` too — an ungated branch is a cross-tenant hole.
- Never make a refusal message distinguish "not found" from "another client's post". See Authorization above.
- When changing scheduled alert buttons, keep this router aligned with `XMonitor - Scheduled Post Tracking`.
- When changing X OAuth scopes or redirect URI, also inspect `XMonitor - X OAuth Callback`.
- When changing order fields, update `Order Info` schema/tests and the order status polling workflows.
- When changing post status semantics, update scheduled tracking suppression logic and router status confirmations together.
