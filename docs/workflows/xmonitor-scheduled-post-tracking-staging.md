# XMonitor - Scheduled Post Tracking Staging

## Purpose

Inactive staging copy of scheduled post tracking. It scans tracked X users, analyzes replies, stores flagged posts/replies in staging data stores, and sends staging Telegram alerts. It is the preferred place to validate scheduler changes before touching production.

## Identity

- n8n ID: `l4eKZucUZXzfz0H8`
- Environment: staging
- Active: no
- Local export: `workflows/staging/xmonitor-scheduled-post-tracking-staging.json`
- Last observed live update: `2026-06-28T11:50:54.611Z`
- Error workflow: `XMonitor - Staging Developer Error Alerts` (`CCzwnMyoy7UequuI`)

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Schedule Trigger` | every `1` hour | Same cadence as production. |
| Lookback window | `Build X API Query`, `DAYS_AGO` | `7` days | X search start time. |
| Minimum replies | `Keep Posts With 10+ Replies` | `>= 10` | Minimum reply count before analysis. |
| Negative threshold | `Calculate/Filter Sentiment Counts` | `negative_ratio >= 0.5` | Minimum negative reply ratio for alerts. |
| X post limit | `Get posts of tracked users` | `max_results=50` | X post search result limit. |
| Post author lookup | `Get posts of tracked users` and `Filter Suppressed Posts` | `expansions=author_id`, `user.fields=id,name,username` | Enriches alert posts with the X author username/name. |
| X reply limit | `Get Replies` | `max_results=200` | Reply search result limit. |
| Hidden/visible negative counts | `Get Reply Status Counts` | Current negative reply IDs joined to `Replies.status` | Counts hidden and visible replies within the current negative-reply set for the Telegram alert. |
| OpenAI model | `Analyze Sentiment with ChatGPT` | `gpt-4o-mini` | Staging uses a cheaper model than the production export observed earlier. |

## Relation To Production Scheduler

The structure mirrors [XMonitor - Scheduled Post Tracking](./xmonitor-scheduled-post-tracking.md): suppression advancement, tracked-user loading, X search, reply analysis, post/reply upserts, hidden/non-hidden reply counting, Telegram alerts, and scheduler developer alerts.

Primary staging differences:

- It is inactive and intended for manual or pinned validation.
- It uses staging credentials where configured.
- It routes handled scheduler errors to staging developer alerts.
- Its sentiment model is `gpt-4o-mini`, while the production export currently documents `gpt-5.4`.

## Agent Change Guidance

- Change and validate scheduler behavior here first.
- If changing alert callback data, update the staging Telegram router and risky-path fixtures too.
- If changing thresholds or schedule cadence, update both staging and production docs once promoted.
- Manual execution can read/write staging Supabase, call X/OpenAI, and send staging Telegram messages unless nodes are pinned.
- Telegram negative-sentiment alerts use a professional, metric-first HTML layout that displays post author, total X replies, analyzed replies, negative replies, and hidden/visible counts within those negative replies.
