# XMonitor - Scheduled Post Tracking

## Purpose

Production workflow that periodically scans X posts from tracked users, finds posts with enough replies, labels reply sentiment with OpenAI, stores posts and negative replies in Supabase/Postgres, and sends Telegram alerts for posts where at least half the analyzed replies are negative.

## Identity

- n8n ID: `Emb26wP77eFXgnVi`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-scheduled-post-tracking.json`
- Live description: `Production scheduled post tracking workflow using production Supabase/Postgres/Telegram credentials and shared X/OpenAI credentials.`
- Last observed live update: `2026-06-30T18:21:23.996Z`

## Schedule And Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Schedule Trigger` | every `1` hour | Runs the whole tracking process hourly. |
| Lookback window | `Build X API Query` code, `DAYS_AGO` | `7` days | X search `start_time` is set to now minus this many UTC days. |
| Tracked users source | `Get Tracked Users` | Supabase table `Tracked Users` | The workflow builds an X query from each non-empty `username`. |
| X post search limit | `Get posts of tracked users` | `max_results=50` | Fetches up to 50 matching posts per run from X search/all. |
| Minimum replies | `Keep Posts With 10+ Replies` | `public_metrics.reply_count >= 10` | Posts below this reply count do not get reply sentiment analysis. |
| X reply search limit | `Get Replies` | `max_results=500` | Fetches up to 500 replies for the collected conversations. |
| Negative threshold | `Calculate/Filter Sentiment Counts` | `negative_ratio >= 0.5` | Only posts with at least 50% negative replies continue to storage and notification. |
| OpenAI model | `Analyze Sentiment with ChatGPT` | `gpt-5.4` | Labels every reply as `Positive`, `Negative`, or `Neutral`. |
| Developer alert recipient | `Build Scheduler Developer Alert` | hard-coded chat ID | Used when scheduler validation fails or no Telegram recipients are configured. |

## Main Flow

1. `Schedule Trigger` runs hourly.
2. `Advance Post Suppression State` reads suppressed post IDs from `Posts`, decrements `snooze_runs_remaining` for snoozed posts, and moves expired snoozes back to `New`.
3. `Get Tracked Users` loads all rows from Supabase `Tracked Users`.
4. `Build X API Query` builds an X query like `from:user1 OR from:user2`, using a 7-day start time. If no usernames exist, it emits a handled scheduler alert instead of calling X.
5. `Get posts of tracked users` calls X API `https://api.x.com/2/tweets/search/all`.
6. `Split Out Posts`, `Filter Suppressed Posts`, and `Keep Posts With 10+ Replies` reduce the candidates to unsuppressed posts with at least 10 replies.
7. `Build Replies Query`, `Wait`, and `Get Replies` fetch replies for the remaining conversations.
8. `Attach replies to posts` groups replies under their source post and carries post author plus X total reply count forward.
9. `Analyze Sentiment with ChatGPT` labels replies.
10. `Calculate/Filter Sentiment Counts` calculates positive, neutral, negative, total analyzed, and total X reply counts, then keeps only posts with `negative_ratio >= 0.5`.
11. `Prepare Post Data` and `Insert or update posts` upsert matching posts into `Posts`.
12. `Flatten All Replies`, `Filter Negative Replies`, `Prepare Reply Data`, and `Insert or update replies` upsert only negative replies into `Replies`.
13. `Get Reply Status Counts` counts hidden and visible negative replies for the current negative reply IDs by joining against `Replies.status`.
14. `Get Telegram Users` loads all Telegram recipients.
15. `Build Negative Alert Notification` creates one alert per recipient and post.
16. `If Notifications Ready` either sends Telegram alerts or sends a developer alert.

## Data Stores

| Table | Use |
| --- | --- |
| `Tracked Users` | Source of X usernames to monitor. |
| `Posts` | Stores posts that crossed the negative sentiment threshold; also stores suppression state via `status` and `snooze_runs_remaining`. |
| `Replies` | Stores negative replies for alerted posts, keyed by `reply_id`. |
| `Telegram Users` | Source of alert recipients via `chat_id`. |

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
| Negative posts found but no Telegram users | `Build Negative Alert Notification` emits `scheduler_alert_type: NO_TELEGRAM_RECIPIENTS`; `If Notifications Ready` routes to developer alert. |

## Agent Change Guidance

- Prefer making changes in `XMonitor - Scheduled Post Tracking Staging` first, then mirror to production after validation.
- If changing cadence, edit `Schedule Trigger`; keep this document's schedule row in sync.
- If changing the monitored time window, update `DAYS_AGO` in `Build X API Query`.
- If changing the sensitivity of alerts, update both the 10-reply filter and/or `negative_ratio >= 0.5` threshold intentionally.
- If changing alert buttons, inspect the Telegram router and its staging fixtures before promoting.
- If changing database writes, check the `Posts` and `Replies` schema assumptions and run a safe staging validation.
- If testing this production workflow directly, expect live X/OpenAI calls, production DB writes, and Telegram sends. Use staging or pin external nodes unless the user explicitly approves live side effects.
