# XMonitor - Staging Developer Error Alerts

## Purpose

Staging error workflow that receives n8n workflow error events and sends a compact Telegram alert to the developer chat. Staging workflows can point their `errorWorkflow` setting at this workflow so failures are visible without searching n8n execution logs.

## Identity

- n8n ID: `CCzwnMyoy7UequuI`
- Environment: staging
- Active: yes
- Local export: `workflows/staging/xmonitor-staging-developer-error-alerts.json`
- Last observed live update: `2026-06-16T18:32:52.889Z`
- Trigger node: `Error Trigger`

## Main Flow

1. `Error Trigger` receives an n8n error event.
2. `Build Developer Error Alert` extracts workflow name, execution ID, mode, last node, started timestamp, and error message.
3. `Send Developer Error Alert` sends the alert to Telegram with HTML parse mode.

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Developer chat ID | `Build Developer Error Alert`, `DEVELOPER_CHAT_ID` | hard-coded chat ID | Alert recipient. |
| Error message cap | `Build Developer Error Alert` | `1500` characters | Prevents very large stack traces from producing huge Telegram messages. |
| Parse mode | `Send Developer Error Alert` | `HTML` | Allows bold heading and line formatting. |

## Agent Change Guidance

- If changing the developer chat recipient, update every workflow-specific developer alert node too; several workflows also hard-code a chat ID directly.
- Keep the alert concise enough for Telegram.
- This workflow is only useful when other staging workflows have `errorWorkflow` set to `CCzwnMyoy7UequuI`.
- Avoid adding secrets or full payload dumps to error messages.
