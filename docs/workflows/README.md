# XMonitor Workflow Documentation

This directory documents the n8n workflows used by XMonitor. The goal is to give agents enough context to make safe changes: what each workflow does, what variables matter, where external side effects happen, and which local export file maps to the live workflow.

## Documentation Order

The primary order follows `workflows/manifest.json`.

| Status | Workflow | Environment | n8n ID | Local export | Notes |
| --- | --- | --- | --- | --- | --- |
| Done | [XMonitor - Scheduled Post Tracking](./xmonitor-scheduled-post-tracking.md) | Production | `Emb26wP77eFXgnVi` | `workflows/active/xmonitor-scheduled-post-tracking.json` | Active hourly scheduler for detecting negative sentiment. |
| Done | [XMonitor - Telegram Router](./xmonitor-telegram-router.md) | Production | `cWczsttyDbTBbRAC` | `workflows/active/xmonitor-telegram-router.json` | Active Telegram command and callback router. |
| Done | [XMonitor - Moderation Queue Drain](./xmonitor-moderation-queue-drain-staging.md) | Production | `vm4UNW7OIx2zEGb4` | `workflows/active/xmonitor-moderation-queue-drain.json` | **Active.** Production drain for the hide-replies queue; webhook-triggered by a pg_cron heartbeat. Shares the staging doc. |
| Done | [XMonitor - X OAuth Callback](./xmonitor-x-oauth-callback.md) | Production | `JQ9KM3l1kRJQhWxb` | `workflows/active/xmonitor-x-oauth-callback.json` | Active X OAuth callback webhook. |
| Done | [XMonitor - Production Developer Error Alerts](./xmonitor-production-developer-error-alerts.md) | Production | `UmKr9JkZ3ec3GDH5` | `workflows/active/xmonitor-production-developer-error-alerts.json` | Production handler for unhandled workflow failures. |
| Done | [XMonitor - Telegram Router Staging](./xmonitor-telegram-router-staging.md) | Staging | `oLwwjO05IcRjtF8E` | `workflows/staging/xmonitor-codex-staging.json` | Active staging router for safe workflow changes. |
| Done | [XMonitor - Moderation Queue Drain (Staging)](./xmonitor-moderation-queue-drain-staging.md) | Staging | `xt8fLOmRvDvTdZT9` | `workflows/staging/xmonitor-moderation-queue-drain-staging.json` | **Active** (2026-08-27). Drains the hide-replies queue inside the per-token X 50/15min limit. Webhook-triggered by a pg_cron heartbeat so an idle queue costs zero n8n executions. |
| Draft | [XMonitor - Telegram Bot Command Menu Setup Staging](./xmonitor-telegram-bot-command-menu-staging.md) | Staging utility | `Rwsu0hUtYA0Ithpl` | `scripts/set-telegram-bot-commands.ps1` | Manual utility/script for setting Telegram's slash-command menu. |
| Done | [XMonitor - Scheduled Post Tracking Staging](./xmonitor-scheduled-post-tracking-staging.md) | Staging | `l4eKZucUZXzfz0H8` | `workflows/staging/xmonitor-scheduled-post-tracking-staging.json` | Inactive staging copy of scheduled tracking. |
| Done | [XMonitor - Scheduled Post Tracking Native Sentiment Staging](./xmonitor-scheduled-post-tracking-native-sentiment-staging.md) | Staging | `f2eFqB2wO91HAYMJ` | `workflows/staging/xmonitor-scheduled-post-tracking-native-sentiment-staging.json` | Inactive staging variant using deduplicated per-reply JSON-mode sentiment analysis. |
| Draft | [XMonitor - Native Sentiment Accuracy Benchmark](./xmonitor-scheduled-post-tracking-native-sentiment-accuracy.md) | Staging utility | temporary | `tests/n8n/native-sentiment-accuracy.integration.test.mjs` | Synthetic labeled examples for measuring the sentiment analysis path. |
| Draft | [XMonitor - Media Sentiment Test Bench](./xmonitor-media-sentiment-test-bench.md) | Test bench | `f1qYeYS5i8pvvKxH` | not yet exported | Read-only bench validating Option A (describe-then-label) for reply media sentiment. |
| Draft | [XMonitor - Media Sentiment Accuracy Benchmark](./xmonitor-media-sentiment-accuracy-benchmark.md) | Test bench | `F7VkkER6k85DGkmG` | `tests/n8n/media-sentiment-accuracy-cases.json` | Hand-labelled scoring of the Option A media pipeline. |
| Done | [XMonitor - Staging Developer Error Alerts](./xmonitor-staging-developer-error-alerts.md) | Staging | `CCzwnMyoy7UequuI` | `workflows/staging/xmonitor-staging-developer-error-alerts.json` | Active developer alert workflow. |
| Superseded | [XMonitor - Order Status Polling Staging](./xmonitor-order-status-polling-staging.md) | Staging | `ceX1EiVN3bFWARMu` | `workflows/staging/xmonitor-order-status-polling-staging.json` | **Inactive, superseded 2026-10-23** by the unified poller. Draft converted to webhook + secret gate + backoff, never published or live-tested; known defects left unfixed. |
| Done | [Orders - Order Status Poll (Staging)](./orders-order-status-poll.md) | Staging | `iKtxEUBYy5ZFlbaB` | `workflows/staging/orders-order-status-poll-staging.json` | **Active** (2026-10-23). One SMM order poller for X, FB and IG, webhook-triggered by the `order-status-polls` pg_cron gate only when orders are due. X rows wait on a `smmwiz_x` provider row. |
| Done | [Orders - Order Status Poll](./orders-order-status-poll.md) | Production | `XPfhrrXEOcavSb94` | `workflows/active/orders-order-status-poll.json` | **Published 2026-10-23, not yet called.** Production copy of the unified poller; waits on Vault `order_poll_secret` + `order_poll_webhook_url` and enabling cron `order-status-polls` (user steps). No error workflow yet. One doc for both environments. |
| Superseded | [XMonitor - Order Status Polling](./xmonitor-order-status-polling.md) | Production | `AqdNgOKRXG6J5zbj` | `workflows/active/xmonitor-order-status-polling.json` | **Inactive** (`active: false` in n8n listing), superseded 2026-10-23 by `XPfhrrXEOcavSb94`. |
| Active | [Sentiment Prompt Review](./sentiment-prompt-review.md) | Production | `H6ihEBBECUKYOlVE` | `workflows/active/sentiment-prompt-review-production.json` | Published 2026-10-24. Started weekly by the Claude scheduled task `sentiment-prompt-review`; applies nothing without approval. |
| Active (staging, manual) | [Sentiment Prompt Review (Staging)](./sentiment-prompt-review.md) | Staging | `L5PotNp2RD3U8BY0` | `workflows/staging/sentiment-prompt-review-staging.json` | Weekly: human labels → proposed shared-prompt edit + per-client cheat sheets, measured, emailed. Applies nothing; approval in the console or by replying to the Claude run. Generated from `tools/prompt-review/`. |
| Draft | [XMonitor - Sentiment Cheat Sheet Review Staging](./xmonitor-sentiment-cheat-sheet-review-staging.md) | Staging | `sidiEHY92PD5jwYG` | `workflows/staging/xmonitor-sentiment-cheat-sheet-review-staging.json` | **Superseded by Sentiment Prompt Review.** Inactive. Weekly job turning hand-labelled replies into a draft per-client cheat sheet for Telegram approval. Do not activate until the router handles `cheatsheet_activate:` / `cheatsheet_discard:`. |

## Other Live n8n Workflows Seen

These exist in n8n but are not currently listed in `workflows/manifest.json`.

| Workflow | n8n ID | Active | MCP available | Notes |
| --- | --- | --- | --- | --- |
| ChatGPTAgentTest | `eBDpIFQiRgXgNPFI` | No | No | Old test workflow; not exported locally. |
| V2 - Fixes | `1cqfirUF8k7g0T0K` | No | No | Old test workflow tagged `Test`; not exported locally. |
| XMonitor - Telegram Router Tarek's copy | `y186BvZnuWWjHgpn` | No | No | Old router copy; not exported locally. |
| XMonitor - Telegram Router TAREK's NEW copy | `fO46JHDF8LtIFcAo` | No | No | Old router copy; not exported locally. |

## Agent Change Notes

- Treat staging workflows as the default edit target unless the user explicitly asks for production changes.
- Inspect live n8n before editing when MCP is available, then keep the matching local export in sync.
- Keep this documentation set, `TASK_TODOLIST.md`, local workflow exports, scripts, and pin fixtures current with each completed workflow change before reporting the work as done.
- When production behavior changes, update the relevant workflow doc and move any completed task from `Open Tasks` to `Completed Tasks` with validation evidence.
- Do not run workflows that can place SMM orders, write to X, or send production Telegram messages without explicit approval.
- Do not document or expose secrets from exported workflow JSON. If a node contains an inline key, describe the configuration risk without copying the value.
