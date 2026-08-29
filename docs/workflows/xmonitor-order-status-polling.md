# XMonitor - Order Status Polling

## Purpose

Production order polling workflow for SMMWiz orders created by the Telegram router. It checks due `Order Info` rows, updates order and post status, and sends final Telegram notifications once.

## Identity

- n8n ID: `AqdNgOKRXG6J5zbj`
- Environment: production
- Active: yes
- Local export: `workflows/active/xmonitor-order-status-polling.json`
- MCP availability: no, based on current workflow card settings
- Unhandled error workflow: `XMonitor - Production Developer Error Alerts` (`UmKr9JkZ3ec3GDH5`)
- Last observed live update: `2026-08-25T10:18:01.192Z`

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Every 30 Minutes` | every `30` minutes | Poll interval. |
| Row fetch limit | `Fetch Due Order Info Rows` | `LIMIT 50` | Maximum due orders checked per run. |
| Due status filter | `Fetch Due Order Info Rows` | `pending`, `in_progress` | Orders eligible for polling. |
| Provider URL | `Attach SMM Status Config` | `https://smmwiz.com/api/v2` | SMMWiz API endpoint. |
| Retry delay | `Update Order Info Status` | `30` minutes | Next check time for non-final orders. |

## Value Columns Are Never Regressed To NULL

Fixed 2026-08-25. `Update Order Info Status` used to write `charge = $5::numeric` and its three companions unconditionally. `charge` is parsed with `toNumber(firstPresent(['charge'…]))`, which returns `null` when the key is absent — and when SMMWiz answers with an error body rather than a status body there is no `charge` key at all. Every such poll therefore wrote `NULL` over a correctly recorded figure.

Usually the next poll recovered it. It was permanent when the error poll landed on the transition to a final status: the due filter is `normalized_status IN ('pending','in_progress')`, so the row stopped being polled and stayed at `charge = NULL` forever. A `completed` response that simply omitted `charge` did the same.

All four value columns are now coalesced:

```sql
charge      = coalesce($5::numeric, charge),
start_count = coalesce($6::integer, start_count),
remains     = coalesce($7::integer, remains),
currency    = coalesce($8,          currency)
```

`remains` is coalesced too. `coalesce` only substitutes when the incoming value is `NULL`, and `coalesce(0, remains)` is still `0`, so a countdown to zero is unaffected — proved by staging execution `15031`, where a `Completed` response carrying `remains: 0` and no `charge` wrote `remains 3 → 0` while `charge` survived.

`provider_status`, `normalized_status`, `status_response` and `last_error` are deliberately **not** coalesced: those must always reflect the current poll.

## Known Drift From Staging

The production `Fetch Due Order Info Rows` query has **no `AND next_check_at <= now()` clause**; the staging twin does. Production therefore polls every non-final order on every 30-minute run and `next_check_at` scheduling is effectively inert here. Confirmed live 2026-08-25 by REST readback. This is unrelated to the charge fix and has not been changed — decide deliberately whether production should adopt the due filter or staging should drop it.

The other two node differences are cosmetic: production omits `resource`/`operation` on `Send Final Order Notification` and `mode` on `Attach SMM Status Config`, because the n8n editor strips default values on save. `Update Order Info Status` is otherwise byte-identical between the two environments, which is why the staging validation of the charge fix transfers.

## Behavior

This production workflow is structurally the same as [XMonitor - Order Status Polling Staging](./xmonitor-order-status-polling-staging.md):

- Selects due `Order Info` rows with active normalized statuses.
- Calls SMMWiz `status`.
- Normalizes provider responses into `pending`, `in_progress`, `completed`, `partial`, `canceled`, or `failed`.
- Updates `Order Info` status fields, `poll_attempts`, `last_checked_at`, `next_check_at`, `last_error`, and `completed_at`.
- Updates `Posts.status` to `Processing`, `Done`, or `Order Failed`.
- Sends one Telegram notification for final statuses and marks `notified_at`.

## Data Stores

| Table | Use |
| --- | --- |
| `Order Info` | Source of SMM orders and destination for provider status fields. |
| `Posts` | Related post status is updated from order state. |

## Agent Change Guidance

- Prefer changing and validating the staging poller first.
- The workflow is **not** MCP-available: `get_workflow_details`, `test_workflow` and even `search_workflow_executions` all refuse it with "Workflow is not available in MCP". Read and edit it over the REST API (`X-N8N-API-KEY` from `keys.env`), or enable MCP access on its workflow card. The 2026-08-25 charge fix was applied by REST `PUT /api/v1/workflows/AqdNgOKRXG6J5zbj` and verified by readback; activation state and all five credential bindings survived.
- Because MCP cannot reach it, none of the `tests/n8n/order-status-polling-pins/` fixtures can be run against production. They target the staging twin only.
- Any live execution can call SMMWiz and send production Telegram notifications.
- The workflow export contains inline SMM provider key configuration; do not copy it into docs or logs.
- Keep status mapping aligned with Telegram router order creation and any user-facing status text.
