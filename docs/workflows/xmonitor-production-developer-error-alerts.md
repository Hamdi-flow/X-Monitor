# XMonitor - Production Developer Error Alerts

## Purpose

Production error workflow that receives n8n workflow error events and sends a compact Telegram alert to the developer chat. Production workflows should point their `settings.errorWorkflow` value at this workflow so unhandled failures are visible without searching n8n execution logs.

## Identity

- n8n ID: `UmKr9JkZ3ec3GDH5`
- Environment: production
- Active: no, by design for an Error Trigger workflow
- Local export: `workflows/active/xmonitor-production-developer-error-alerts.json`
- Telegram credential: `TrackedUsersManager`
- Last observed live update: `2026-07-07T17:15:56.388Z`

## Linked Production Workflows

The following production workflows were verified on 2026-07-07 with `settings.errorWorkflow = UmKr9JkZ3ec3GDH5`:

| Workflow | n8n ID | Live update |
| --- | --- | --- |
| `XMonitor - Scheduled Post Tracking` | `Emb26wP77eFXgnVi` | `2026-07-07T17:16:19.539Z` |
| `XMonitor - Telegram Router` | `cWczsttyDbTBbRAC` | `2026-07-07T17:16:20.606Z` |
| `XMonitor - X OAuth Callback` | `JQ9KM3l1kRJQhWxb` | `2026-07-07T17:16:21.845Z` |
| `XMonitor - Order Status Polling` | `AqdNgOKRXG6J5zbj` | `2026-07-07T17:16:22.668Z` |

## Main Flow

1. `Error Trigger` receives the n8n error event from the failed workflow.
2. `Build Production Error Alert` extracts workflow name, workflow ID, execution ID, execution URL, mode, last node, started timestamp, and error message.
3. `Send Production Error Alert` sends the alert to Telegram with HTML parse mode.

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Developer chat ID | `Build Production Error Alert`, `DEVELOPER_CHAT_ID` | hard-coded chat ID | Alert recipient. |
| Error message cap | `Build Production Error Alert` | `1500` characters | Prevents very large stack traces from producing huge Telegram messages. |
| Message cap | `Build Production Error Alert` | `3900` characters | Keeps the final alert below Telegram message limits. |
| Parse mode | `Send Production Error Alert` | `HTML` | Allows bold heading and escaped line formatting. |

## Validation

- MCP node configuration validation passed for all three nodes before creation.
- MCP full-workflow validation passed before creation.
- Pinned execution `3901` built a production error alert from synthetic input while the Telegram send node was pinned, so no live Telegram message was sent.
- Live REST readback on 2026-07-07 confirmed all four production workflows point at this workflow through `settings.errorWorkflow`.
- A live production failure was intentionally not triggered because it would send a production Telegram alert.

## Agent Change Guidance

- Keep production workflows pointed at this production-specific handler, not the staging developer alert workflow.
- If changing message fields, keep the HTML escaping and message caps in place.
- If changing the Telegram credential or recipient, run a pinned validation before allowing live alerts.
- If a new production workflow is added, set its `settings.errorWorkflow` to `UmKr9JkZ3ec3GDH5` and update this document, the workflow export, and `TASK_TODOLIST.md`.
