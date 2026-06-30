# XMonitor - Telegram Router

## Purpose

Production Telegram workflow that receives bot commands and alert button callbacks, routes them into XMonitor actions, and sends user or developer Telegram responses. It handles X OAuth link generation, tracked-user management, post suppression state changes, reply hiding on X, comment-order generation, likes orders, and SMM order persistence.

## Identity

- n8n ID: `cWczsttyDbTBbRAC`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-telegram-router.json`
- Node count: `112`
- Last observed live update: `2026-06-30T18:43:54.333Z`
- Main trigger node: `Telegram Trigger`

## Supported Inputs And Intents

`Parse Telegram Message` normalizes Telegram `message` and `callback_query` payloads into an `intent`, then `Route Telegram Intent` sends the item to the matching branch.

| Intent | User input or callback | Main branch |
| --- | --- | --- |
| `HELP` | `/help`, `/start`, `help`, `start`, fallback help buttons | Sends the help manual. |
| `AUTH_X` | `/auth_x`, `/auth`, `/start auth`, `/start connect_x` | Generates an X OAuth link and stores a PKCE auth session. |
| `TRACK_USERS` | `/track USERS`, `/start track-USERS` | Replaces tracked users for the chat. |
| `HIDE_REPLIES` | `/hide_replies POST_ID`, `/hide POST_ID`, `hide_replies:<post_id>` | Validates post ownership and hides stored negative replies through X. |
| `IGNORE_POST` | `/ignore POST_ID`, `ignore:<post_id>` | Sets the post status to `Ignored`. |
| `SNOOZE_MENU` | `/snooze POST_ID`, `snooze:<post_id>` | Sends a fixed snooze-duration menu. |
| `SNOOZE_POST` | `/snooze POST_ID 1h|4h|12h|24h`, `snooze_duration:<post_id>:<duration>` | Sets the post status to `Snoozed`. |
| `RESUME_POST` | `/resume POST_ID`, `resume:<post_id>` | Sets the post status back to `New`. |
| `ORDER_COMMENTS` | `/order_comments POST_ID` | Generates counter replies, asks for confirmation, then places an SMM comment order. |
| `ORDER_LIKES` | `/order_likes POST_ID AMOUNT`, `order_likes:<post_id>` | Places an SMM likes order, prompting for amount when the callback omitted it. |
| `UNKNOWN` | Anything else | Sends default help. |

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
| Comment count limits | `Build Comment Order Payload` | minimum `10`, maximum `250` | Enforced before placing comment orders. |
| Counter-reply model | `OpenAI Chat Model` | `gpt-5-mini` | Generates Lebanese Arabic counter replies for negative replies. |
| SMM provider URL | `Set Comment Service Config`, `Set Likes Service Config` | `https://smmwiz.com/api/v2` | Used by both order branches. |

## Main Branches

### Help

`Send Help Manual` and `Send Default Help` describe the bot commands and expose inline shortcuts for connecting X and starting `/track`.

### X OAuth

`Generate X OAuth Link` creates a PKCE `state`, `code_verifier`, and `code_challenge`, then `Save Auth Session` stores the state in `X Auth Sessions`. `Send Auth Link` sends a 10-minute authorization link to the Telegram chat.

The callback exchange itself is handled by `XMonitor - X OAuth Callback`, so changes to redirect URI, scopes, state shape, or session table fields must be coordinated with that workflow.

### Track Users

The tracking branch clears the chat's existing `Telegram Users` and `Tracked Users` links, parses usernames from handles, URLs, or plain text, looks each user up through X API `GET /2/users/by/username/:username`, then writes:

- `Tracked Users`: tracked X username/user ID records.
- `Telegram Users`: link between Telegram chat and tracked X user.

Tracking replaces the full tracked-user list for the chat.

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

Successful hide results upsert `Replies.status='hidden'`; failures are summarized back to Telegram. This is an X write action and should only be live-tested after explicit approval.

### Comment Orders

`ORDER_COMMENTS` loads the post and tracked user, reads stored negative replies, asks OpenAI to generate one Lebanese Arabic counter reply per reply, saves generated counter replies back to `Replies`, shows suggested comments in Telegram, then asks the user to choose `Confirm` or `Do nothing`.

On confirmation, it sends a SMMWiz `add` request with service `8404`, normalizes provider errors, inserts or updates an `Order Info` row, marks the `Posts` row as `Processing`, and sends a success or error message.

### Likes Orders

`ORDER_LIKES` validates `POST_ID` and a positive whole-number amount. Button callbacks prompt the user for the amount via `sendAndWait`. Valid requests send a SMMWiz `add` request with service `12104`, write an `Order Info` row, mark the `Posts` row as `Processing`, and notify the user.

## Data Stores

| Table | Use |
| --- | --- |
| `X Auth Sessions` | Temporary PKCE OAuth state and code verifier for `/auth_x`. |
| `X Auth Accounts` | Stored X access/refresh tokens and owner metadata. |
| `Telegram Users` | Telegram chat to tracked X user linkage. |
| `Tracked Users` | Usernames and X user IDs monitored by scheduled tracking. |
| `Posts` | Flagged posts plus status state: `New`, `Snoozed`, `Ignored`, `Processing`. |
| `Replies` | Negative replies and generated counter replies; hide branch updates reply status. |
| `Order Info` | SMM provider order tracking for comment and likes orders. |

## External Side Effects

- Sends Telegram messages, callback answers, edited messages, and `sendAndWait` prompts.
- Calls X API for user lookup, OAuth token refresh, and hiding replies.
- Calls OpenAI to generate counter replies.
- Calls SMMWiz to place comment and likes orders.
- Writes production Supabase/Postgres tables listed above.

## Configuration Risks

- The workflow export currently contains inline SMMWiz API key configuration in the order service config nodes. Do not copy the key into docs or logs. Prefer moving it into n8n credentials or another secret store before further promotion work.
- The X OAuth client ID and client secret are embedded in code nodes in the export. Treat them as sensitive configuration and avoid printing or duplicating them.
- `/order_comments`, `/order_likes`, and `hide_replies` have real external side effects. Use staging and pinned tests unless the user explicitly approves live X writes or SMM orders.

## Testing Guidance

- Use `XMonitor - Telegram Router Staging` (`oLwwjO05IcRjtF8E`) for changes first.
- Safe pinned or low-risk checks include `/help`, `/auth_x` link generation with pinned side-effect nodes, invalid command handling, and validation-only status/order input branches.
- Reuse fixtures in `tests/n8n/telegram-router-risky-pins/` for risky paths:
  - `hide-replies-success.pinData.json`
  - `order-likes-success.pinData.json`
  - `order-comments-confirm-success.pinData.json`
- Keep any new credentialed, HTTP, Telegram, OpenAI, or Supabase write node pinned in risky-path tests.

## Agent Change Guidance

- When adding a command, update `Parse Telegram Message`, `Route Telegram Intent`, help text, and staging tests together.
- When changing scheduled alert buttons, keep this router aligned with `XMonitor - Scheduled Post Tracking`.
- When changing X OAuth scopes or redirect URI, also inspect `XMonitor - X OAuth Callback`.
- When changing order fields, update `Order Info` schema/tests and the order status polling workflows.
- When changing post status semantics, update scheduled tracking suppression logic and router status confirmations together.
