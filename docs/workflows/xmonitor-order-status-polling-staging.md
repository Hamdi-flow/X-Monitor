# XMonitor - Order Status Polling Staging

## Purpose

Inactive staging workflow that polls SMMWiz order status for saved `Order Info` rows, normalizes provider statuses, updates `Order Info` and `Posts`, and sends one final Telegram notification when an order reaches a terminal state.

## Identity

- n8n ID: `ceX1EiVN3bFWARMu`
- Environment: staging
- Active: no
- Local export: `workflows/staging/xmonitor-order-status-polling-staging.json`
- Last observed live update: `2026-08-25T09:22:10.238Z`

## Important Variables

| Variable | Location | Current value | Meaning |
| --- | --- | --- | --- |
| Schedule cadence | `Every 30 Minutes` | every `30` minutes | Poll interval. |
| Row fetch limit | `Fetch Due Order Info Rows` | `LIMIT 50` | Maximum due orders checked per run. |
| Due status filter | `Fetch Due Order Info Rows` | `pending`, `in_progress` | Only non-final active orders are polled. |
| Due time filter | `Fetch Due Order Info Rows` | `next_check_at <= now()` | Skips rows not ready for another poll. |
| Provider URL | `Attach SMM Status Config` | `https://smmwiz.com/api/v2` | SMMWiz API endpoint. |
| Retry delay | `Update Order Info Status` | `now() + interval '30 minutes'` | Next check time for non-final orders. |

## Status Mapping

`Normalize Provider Status` maps provider status text into internal values:

| Provider text contains | `normalized_status` | `Posts.status` |
| --- | --- | --- |
| `complete` | `completed` | `Done` |
| `partial` | `partial` | `Done` |
| `cancel` or `refund` | `canceled` | `Order Failed` |
| `fail`, `reject`, or `error` | `failed` | `Order Failed` |
| `progress` or `process` | `in_progress` | `Processing` |
| `pending`, `wait`, `queue`, or blank | `pending` | `Processing` |

Final statuses are `completed`, `partial`, `canceled`, and `failed`.

## Main Flow

1. `Every 30 Minutes` starts the poll.
2. `Fetch Due Order Info Rows` selects due rows from `Order Info`.
3. `Attach SMM Status Config` attaches provider URL and API key configuration.
4. `Check Provider Order Status` posts `action=status` and `order=<provider_order_id>` to SMMWiz.
5. `Normalize Provider Status` normalizes provider response, charge, start count, remains, currency, and error fields.
6. `Update Order Info Status` updates provider fields, increments `poll_attempts`, sets `last_checked_at`, and moves `next_check_at` forward for non-final statuses.
7. `Update Post Order Status` updates the related `Posts.status`.
8. `If Final And Unnotified` checks terminal status and missing `notified_at`.
9. `Send Final Order Notification` sends Telegram status.
10. `Mark Order Notification Sent` sets `notified_at`.

## Value Columns Are Never Regressed To NULL

Fixed 2026-08-25, then promoted to production the same day. `Update Order Info Status` used to write `charge`, `start_count`, `remains` and `currency` unconditionally, so any poll whose response lacked those keys — an SMMWiz error body has no `charge` — overwrote a recorded figure with `NULL`. Permanent when it landed on the transition to a final status, since the due filter stops polling the row.

All four are now `coalesce(<param>, <column>)`. `provider_status`, `normalized_status`, `status_response` and `last_error` are deliberately left unconditional: they must reflect the current poll.

Validated by three pinned runs that deliberately leave `Update Order Info Status` **unpinned** so the statement really executes — the two older fixtures pin it, which is why they could never have caught this:

| Execution | Response | Result |
| --- | --- | --- |
| `15030` | error body, no `charge`, row goes `failed` | `0.42` / `USD` / `5` / `3` all survived; `provider_status`, `normalized_status`, `last_error` updated |
| `15031` | `Completed`, no `charge`, `remains: 0` | charge survived **and** `remains` wrote `3 → 0`, so the countdown is unaffected |
| `15032` | `Completed` with real values | `0.42 → 0.98765`, `USD → EUR`, `5 → 77` — the happy path still overwrites |

Fixtures and the seed/reset/cleanup SQL are in `tests/n8n/order-status-polling-pins/`. The test row is `provider_order_id = 'coalesce-regression-1'`; delete it afterwards.

## Agent Change Guidance

- Use this staging poller to validate `Order Info` schema changes before touching production.
- Production has drifted: its `Fetch Due Order Info Rows` has no `AND next_check_at <= now()` clause, so it polls every non-final order every run. Do not assume this workflow's due filter matches production — see the production doc.
- Keep status values aligned with Telegram router order creation and production order polling.
- The workflow contains inline SMM provider key configuration in the export; do not copy it into docs or logs.
- Running it live can call SMMWiz and send Telegram messages. Use pinned HTTP/Telegram nodes unless the user approves live polling.
