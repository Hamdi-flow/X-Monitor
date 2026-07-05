# XMonitor - Telegram Router Staging

## Purpose

Staging copy of the production Telegram router. This is the preferred workflow for agent-driven router changes and tests because it can use staging credentials and pinned data before changes are promoted to production.

## Identity

- n8n ID: `oLwwjO05IcRjtF8E`
- Environment: staging
- Active: yes
- Local export: `workflows/staging/xmonitor-codex-staging.json`
- Node count: `114`
- Last observed live update: `2026-07-05T13:02:16.895Z`
- Error workflow: `XMonitor - Staging Developer Error Alerts` (`CCzwnMyoy7UequuI`)
- Main trigger node: `Telegram Trigger`

## Relation To Production Router

This workflow mirrors [XMonitor - Telegram Router](./xmonitor-telegram-router.md): same intent parser, route structure, post status actions, hide-replies path, comment-order path, likes-order path, and order persistence shape.

Important staging deltas:

| Area | Staging value | Production value |
| --- | --- | --- |
| OAuth callback path | `/webhook/x-oauth-callback-staging` | `/webhook/x-oauth-callback` |
| OAuth scopes | includes `tweet.write` plus read/moderate/offline scopes | read/moderate/offline scopes |
| Error workflow | Staging developer error alerts | none configured in export |
| Credentials | Staging Supabase/Postgres/Telegram where configured | Production credentials |
| Hide failure visibility | Groups X hide failures by safe reason and sends a developer alert when any reply fails | Same behavior after 2026-07-05 promotion |

## Hide Replies Failure Visibility

The staging hide-replies branch asks the X hide request node to return full response status/body data and to avoid throwing on non-2xx provider responses. `Prepare Hide Result` classifies each reply result into safe categories such as missing moderation permission, rejected token, non-owner moderation attempt, reply not found, already hidden, rate limited, X unavailable, network error, or unknown rejection.

`Build Hide Summary` keeps successful output concise, but when failures occur it adds grouped user-facing reasons and sample reply IDs. Failed attempts still update `Replies.status` to `hide_failed`; successful or already-hidden replies update to `hidden`. `Build Developer Alert - Hide Failures` sends a sanitized staging developer alert only when the grouped failure count is greater than zero.

## Snooze Duration Menu

The staging router supports a two-step snooze flow for alert buttons:

1. `snooze:<post_id>` sends a new Telegram message with a fixed inline menu. The original alert message is left unchanged.
2. The menu offers `1 hour`, `4 hours`, `12 hours`, and `24 hours`.
3. Selecting an option sends `snooze_duration:<post_id>:<duration>` and updates `Posts.status` to `Snoozed`.
4. The selected duration maps directly to hourly scheduler runs: `1`, `4`, `12`, or `24` in `Posts.snooze_runs_remaining`.

Slash commands use the same rules. `/snooze POST_ID` opens the fixed menu, while `/snooze POST_ID 4h` applies a valid duration directly. Unsupported durations are rejected with a validation message.

## Testing Guidance

- Safe direct checks include `/help`, invalid commands, `/auth_x` link generation with side-effect nodes pinned, and validation failures.
- For snooze changes, pin Telegram inputs for `snooze:<post_id>`, `snooze_duration:<post_id>:12h`, invalid duration commands, and missing post IDs.
- Use `tests/n8n/telegram-router-risky-pins/` for `hide_replies`, `order_likes`, and `order_comments` paths. Hide-replies coverage includes `hide-replies-success.pinData.json` and `hide-replies-provider-error.pinData.json`.
- Keep HTTP requests, Telegram sends, Supabase writes, OpenAI generation, and SMM calls pinned when exercising risky paths without explicit live approval.
- Never run live `hide_replies`, `/order_comments`, or valid `/order_likes` from staging without explicit approval.

## Agent Change Guidance

- Make router changes here first, then mirror the minimal change into production after validation.
- If changing scheduled alert button payloads, update both scheduled tracking and the router fixtures.
- Keep local exports in `workflows/staging/xmonitor-codex-staging.json` and `workflows/active/xmonitor-telegram-router.json` aligned after promotion.
