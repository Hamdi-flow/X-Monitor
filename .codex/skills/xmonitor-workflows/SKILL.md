---
name: xmonitor-workflows
description: "Use when changing, creating, validating, testing, committing, or pushing XMonitor n8n workflow work in this project, especially staging workflows, Telegram router behavior, scheduled post tracking, X OAuth callback flow, Supabase-backed test data, pinned Telegram inputs, n8n MCP workflow edits, safe live validation, and deciding when validated changes should be committed and pushed."
---

# XMonitor Workflows

Use this skill for XMonitor n8n workflow work. Keep this file as the compact operating guide: use `docs/workflows/` for workflow facts, local exports for exact graph state, and `references/workflow-operations.md` for detailed MCP, testing, risk, and commit procedure.

## First Move

- Treat staging as the default target. Do not modify production unless the user explicitly asks for production, promotion, or live behavior.
- Read the relevant `docs/workflows/*.md` file before editing a workflow; docs explain what the workflow does and where side effects are.
- Inspect the live workflow before editing when MCP or REST access is available; local exports can drift.
- If docs, exports, and live n8n disagree, treat live n8n as current behavior and update docs/exports after the change.
- An edit is not live until it is published. `update_workflow` writes the draft; triggers run the separately published active version and `test_workflow` runs the draft, so pinned tests can pass against code no live execution will ever run. After every workflow edit, re-read `get_workflow_details` and compare `versionId` against `activeVersionId`; if they differ, call `publish_workflow` and re-read to confirm they match. `active: true` is not evidence — an active workflow with a stale `activeVersionId` is running the old code.
- Scheduled Post Tracking Staging (`l4eKZucUZXzfz0H8`) is intentionally inactive and manually executed; do not publish it to close a draft/active gap. Every other main workflow is expected to be active and published.
- Keep the matching local export and workflow docs in sync after live workflow edits.
- Keep the project paper trail current as part of every completed workflow task: update `TASK_TODOLIST.md`, `docs/workflows/*.md`, `docs/workflows/README.md`, relevant fixtures/scripts, and any local exports whose behavior changed before reporting done.
- Never print secrets, access tokens, refresh tokens, API keys, or full credential bodies. Summarize as present or missing.

## Intent And Scope

- If the user asks to analyze, triage, or add a task, update `TASK_TODOLIST.md` with assumptions, open questions, risk boundaries, and validation ideas; do not implement unless they ask to proceed.
- If the user asks to implement, continue, fix, validate, promote, commit, or push, carry the work through edit, verification, local sync, and concise evidence instead of stopping at a plan.
- Ask clarifying questions only when a product decision cannot be inferred safely or when a test/change would create external side effects. Otherwise, inspect docs/live state and make a conservative staging-first assumption.
- When a user reports that something "didn't work" after a successful API response, verify from the user's surface too: bot identity, Telegram command scopes, message output, DB rows, active version, or live execution data as applicable.

## Required References

- For any non-trivial workflow edit, test, promotion, commit, push, MCP auth issue, Supabase inspection, or risky path validation, read `references/workflow-operations.md`.
- For workflow identity and behavior, start from `docs/workflows/README.md`, then read the specific workflow doc.
- For Telegram router risky path tests, use `tests/n8n/telegram-router-risky-pins/README.md` and the relevant pin fixture.
- For order status polling tests, use `tests/n8n/order-status-polling-pins/` when applicable.

## Product Conventions

- Use `TASK_TODOLIST.md` for task intake when the user asks to analyze or add a task. Preserve resolved decisions there and remove stale open questions once answered.
- After implementing or promoting a task, move finished todo items to `Completed Tasks`, add validation evidence and commit IDs when available, and remove stale open questions instead of leaving obsolete task state behind.
- Scheduled post reply metrics must state the denominator clearly. In current alerts, hidden/non-hidden counts refer to stored analyzed negative replies: `Replies.status = 'hidden'` vs stored negative replies whose status is absent or not `hidden`.
- Snooze uses hourly scheduler runs through `Posts.snooze_runs_remaining`. Current fixed duration options are `1h`, `4h`, `12h`, and `24h`.
- Snooze must support both button and command flows: `snooze:<POST_ID>` opens the menu, `snooze_duration:<POST_ID>:<DURATION>` applies a choice, `/snooze POST_ID DURATION` applies directly, and `/snooze POST_ID` opens the menu.
- When Telegram router syntax or behavior changes, update parser logic, buttons, help/default-help text, Telegram command menu setup, docs, exports, and tests together.
- For Telegram bot command menus, set and verify both default scope and `all_private_chats`; private-chat scope can override the visible menu.
- Prefer `STAGING_TELEGRAM_BOT_TOKEN` for staging Telegram command-menu setup and verify with Telegram `getMe` plus `getMyCommands` without printing tokens.
- Keep staging and production on the same AI model. When you change the sentiment model in one environment, change it in the other as part of the same work; a model gap makes staging validation meaningless as evidence for production behaviour. Both currently run `gpt-5.4-mini`. This applies to probe/helper calls too — keep the request body (including `max_completion_tokens` vs `max_tokens`) matched to the model it targets.
- Use Node rather than PowerShell for complex n8n workflow JSON rewrites where nested `connections` arrays must be preserved.

## Change Surface Checklist

- Telegram router changes usually span parser logic, route switch outputs, action nodes, inline buttons, help/default-help text, command-menu setup, docs, exports, and pinned tests.
- Scheduled tracking changes usually span X API fields/includes, reply attachment, sentiment shape, DB upserts, suppression/snooze handling, alert formatting, docs, exports, and pinned scheduler tests.
- Order lifecycle changes usually span Telegram router order creation, `Order Info` schema, order status poller, provider status mapping, `Posts.status`, final notification dedupe, docs, exports, and SMM/Telegram pins.
- Promotion from staging to production must preserve production credentials, activation state, webhook paths, and environment-specific token variables; validate with pinned production tests before reporting success.
- Workflow utility scripts are part of the product surface when users rely on them, especially Telegram command setup and MCP configuration scripts.
- For direct X API MCP access, use the project server name `x-api`. Configure it with `scripts/configure-x-api-mcp.ps1`, using ignored `keys.env` values `X_API_MCP_URL` and `X_API_MCP_ACCESS_TOKEN`, then restart Codex or the IDE and verify with `codex mcp get x-api`. Both values are currently missing from `keys.env`, so the script throws until they are restored, and `x-api` is Codex-only — it is not reachable from Claude Code.
- `configure-*.ps1` and `codex mcp` are Codex-only. On Claude Code, n8n and Supabase are deferred UUID-named connectors that must be loaded with `ToolSearch` before use; missing tool names there are not an auth failure. See `references/workflow-operations.md`.

## Safety Defaults

- Prefer pinned workflow tests before live tests.
- Safe staging checks include `/help`, invalid command validation, pinned `/auth_x` generation, snooze/resume row transitions with snapshots, schedule manual execution, Supabase-backed reads, and pinned Telegram tests.
- Change staging workflow behavior without asking first: node logic, parameters, and wiring edits pushed to the staging workflow in n8n are ordinary work, with the local export and workflow doc updated in the same change.
- Publishing is not activation. Pushing a draft live on a workflow that is already active is finishing your own edit — do it without asking on staging. Flipping a workflow between states (publishing an inactive one, `unpublish_workflow` on an active one) still needs approval. On production, publishing rides on the same approval as the production change itself; if you choose not to publish, say so rather than leaving production half-published with a stale `activeVersionId`.
- Require explicit user intent before X write operations, broad staging *data* mutations, flipping a workflow between active and inactive, production executions with side effects, or any live SMM order path.
- Never run `/order_comments`, valid `/order_likes`, or SMM API request nodes live unless the user explicitly approves order placement.

## Report Back

These four headings are the preferred default shape for closing a substantial piece of work. This is a preference, not a rule: use a different structure whenever it genuinely serves the answer better, and drop the scaffolding entirely on small or conversational replies. What matters is that these four things stay easy to find, not that the headings appear verbatim. When the format is used, skip a heading only when it is genuinely empty — write "none" rather than dropping it silently.

**What happened** — what was actually done, with concrete evidence: workflow name and ID, publish state after the edit (`active`, and `activeVersionId` matching `versionId`), execution IDs, the input payload or command tested, important nodes reached or skipped, rows changed and their cleanup/restoration status, local files updated, commit/push status. State failures and skipped steps plainly.

**Actions you need to take** — things only the user can do: approvals for risky paths (X writes, activation/deactivation, production executions with side effects, live SMM orders), manual n8n UI steps, credentials or tokens to restore.

**Decisions you need to make** — open product or design choices deliberately left to the user, each with the options and a recommendation. Genuinely undecided items only.

**What's left** — remaining scope, risky branches deliberately skipped and why, and follow-ups that belong in `TASK_TODOLIST.md`.
