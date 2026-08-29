# X-Monitor

n8n workflows that monitor X (Twitter) posts for negative reply sentiment, alert via a
Telegram bot, and act on those alerts (hide replies, place SMM orders). Production and
staging live side by side in the same n8n instance.

This file is the Claude-side operating guide. A mirror of it exists as a Codex skill at
`.codex/skills/xmonitor-workflows/` — **if you change the rules here, change them there
too**, or the two agents will diverge.

## First moves

- **Staging is the default target.** Do not modify production unless explicitly asked for
  production, promotion, or live behavior.
- Read the relevant `docs/workflows/*.md` before editing a workflow. Those docs explain
  what it does and — more importantly — where the external side effects are.
- **Live n8n is the truth.** Inspect the live workflow before editing; local exports
  drift. If docs, exports, and live n8n disagree, live n8n is current behavior. Dispatch
  the **workflow-drift-auditor** agent when you suspect drift.
- **An edit is not live until it is published.** `update_workflow` writes the *draft*.
  Triggers run the separately published active version, and `test_workflow` runs the
  draft — so a pinned suite can pass green against code no live execution will ever run.
  After every workflow edit, re-read `get_workflow_details` and compare `versionId`
  against `activeVersionId`. If they differ, the change is not live: call
  `publish_workflow`, then re-read and confirm they match. `active: true` is not
  evidence — an active workflow with a stale `activeVersionId` is running the old code.
  This has silently shipped nothing twice already (see `TASK_TODOLIST.md` production
  promotion evidence 2026-08-25 and
  `docs/workflows/xmonitor-moderation-queue-drain-staging.md` §3).
- Keep the matching local export and workflow doc in sync after any live edit. Treat docs
  and `TASK_TODOLIST.md` as part of the change, not follow-up cleanup.
- Never print secrets, access tokens, refresh tokens, API keys, or full credential bodies.
  Summarize as present or missing.

## Where things are

`docs/workflows/README.md` is the index — workflow identity, environment, n8n ID, local
export path, and status for every workflow. Start there, then read the specific doc.
`workflows/manifest.json` is the machine-readable version of the same mapping.

Main entry points:

| Workflow | n8n ID | Export |
| --- | --- | --- |
| Telegram Router Staging | `oLwwjO05IcRjtF8E` | `workflows/staging/xmonitor-codex-staging.json` |
| Scheduled Post Tracking Staging | `l4eKZucUZXzfz0H8` | `workflows/staging/xmonitor-scheduled-post-tracking-staging.json` |
| Scheduled Post Tracking (prod) | `Emb26wP77eFXgnVi` | `workflows/active/xmonitor-scheduled-post-tracking.json` |
| Telegram Router (prod) | `cWczsttyDbTBbRAC` | `workflows/active/xmonitor-telegram-router.json` |
| X OAuth Callback Staging | `gji3bQd2LdodwEJR` | webhook path `x-oauth-callback-staging` |

Scheduled Post Tracking Staging is **intentionally inactive** (`active: false`,
`activeVersionId: null`) and is driven by manual execution — do not publish it to close a
draft/active gap. Every other workflow above is expected to be active *and* published.

Staging credentials in n8n: `Supabase Staging API`, `Supabase Staging Postgres`,
`Testing Telegram API`, `Bearer Auth account`, `OpenAi account 2`.

### MCP access (Claude Code)

n8n and Supabase arrive as claude.ai connectors whose tools are **deferred and UUID-named**
— only the tool names appear at session start, inside a `<system-reminder>`, never in the
tool list. Searching for a tool called "n8n" or "supabase" finds nothing, and that is *not*
evidence the connection is broken. Load the schemas with `ToolSearch`
(`select:<full tool name>`), then call them normally. Identify them by their distinctive
tool names — `search_workflows` / `get_workflow_details` / `update_workflow` for n8n,
`list_projects` / `execute_sql` / `list_tables` for Supabase — since the UUID prefix is an
opaque connector ID. Never report n8n or Supabase MCP as unavailable without trying
`ToolSearch` first.

The `.codex/skills/xmonitor-workflows/scripts/configure-*.ps1` scripts register servers via
`codex mcp add` — **Codex CLI only, no effect on a Claude session**. Claude Code has no MCP
servers of its own in this project: no `.mcp.json`, no `mcpServers` in `~/.claude.json`.
Do not re-run those scripts to fix Claude-side MCP access. `keys.env` currently holds only
`SUPABASE_ACCESS_TOKEN` plus the Telegram bot tokens, so the n8n and `x-api` scripts would
throw on their token check regardless.

`x-api` is not connected to Claude at all — for direct X API work here, fall back to REST or
an existing workflow. The `plugin:postgres-best-practices:supabase` server does genuinely
need OAuth and reports as unauthorized every session; it is redundant with the Supabase
connector, so ignore it or authorize it via `/mcp` from an interactive `claude` terminal.

## Product conventions

- **Task intake.** Only add to `TASK_TODOLIST.md` when asked to analyze or add a task, or
  when a real decision is left unresolved. Move items to `Completed Tasks` only once
  production matches the completed behavior — staging validation alone keeps it open, with
  the staging evidence recorded in Notes.
- **Reply metrics must state their denominator.** In current alerts, hidden vs non-hidden
  counts refer to stored *analyzed negative* replies: `Replies.status = 'hidden'` vs
  stored negative replies whose status is absent or not `hidden`.
- **Snooze** runs off hourly scheduler passes via `Posts.snooze_runs_remaining`, with
  fixed durations `1h`, `4h`, `12h`, `24h`. It must work from both buttons and commands:
  `snooze:<POST_ID>` opens the menu, `snooze_duration:<POST_ID>:<DURATION>` applies a
  choice, `/snooze POST_ID DURATION` applies directly, `/snooze POST_ID` opens the menu.
- **Telegram command menus** need both the default scope *and* `all_private_chats` — the
  private-chat scope silently overrides the visible menu. Prefer
  `STAGING_TELEGRAM_BOT_TOKEN` for staging setup and verify with `getMe` plus
  `getMyCommands` without printing the token.
- **Keep staging and production on the same AI model.** When you change the sentiment model
  in one environment, change it in the other in the same piece of work. A model gap makes
  staging validation meaningless as evidence for production behaviour. Both currently run
  `gpt-5.4-mini`. This applies to any probe/helper call too — keep the request body
  (including `max_completion_tokens` vs `max_tokens`) matched to the model it targets.
- Use **Node, not PowerShell**, for complex workflow JSON rewrites — nested `connections`
  arrays don't survive PowerShell's object handling.

## Change surface checklist

Changes in this project fan out further than they look. Before reporting done, check
whether you've touched everything in the relevant row:

| Change | Usually spans |
| --- | --- |
| Telegram router | parser logic, route switch outputs, action nodes, inline buttons, help/default-help text, command-menu setup, docs, exports, pinned tests |
| Scheduled tracking | X API fields/includes, reply attachment, sentiment shape, DB upserts, suppression/snooze handling, alert formatting, docs, exports, pinned scheduler tests |
| Order lifecycle | router order creation, `Order Info` schema, status poller, provider status mapping, `Posts.status`, final notification dedupe, docs, exports, SMM/Telegram pins |

Alert button payloads couple the scheduler to the router. If button callback data changes
in one, test the other.

**Promotion staging → production** must preserve production credentials, activation state,
webhook paths, and environment-specific token variables. Validate with pinned production
tests before reporting success.

## Safety

Pinned tests before live tests, always. Fixtures live in
`tests/n8n/telegram-router-risky-pins/` and `tests/n8n/order-status-polling-pins/` — read
their READMEs, they document what each fixture proves.

Safe staging checks: `/help`, invalid-command validation, pinned `/auth_x` generation,
snooze/resume row transitions with snapshots, manual schedule execution, Supabase reads.

**No approval needed for staging workflow changes:** editing a staging workflow's behavior
is ordinary work — change node logic, parameters, and wiring, and push the update to the
staging workflow in n8n without asking first. Keep the local export and workflow doc in
sync as part of the same change.

**Publishing is not activation.** Pushing a draft live on a workflow that is *already*
active is finishing your own edit, not an activation decision — do it without asking on
staging. What still needs approval is flipping a workflow between states: publishing one
that is currently inactive, or `unpublish_workflow` on an active one. On production,
publishing rides on the same approval as the production change itself — if the user asked
for the promotion, publish it; if you choose not to, say so explicitly rather than leaving
production half-published with a stale `activeVersionId`.

**Requires explicit user approval every time:** X write operations, broad staging *data*
mutations, flipping a workflow between active and inactive (see above), production
executions with side effects, and any live SMM order path. Never run `/order_comments`,
a valid `/order_likes`, or SMM API request nodes live without it. A passing pinned run on a risky path is not approval to
run it live.

Before mutating staging rows, snapshot the fields that matter (`status`,
`snooze_runs_remaining`, `reply_id`, `post_id`). Prefer existing staging rows over invented
IDs — e.g. X user `951803761` / `RebelHam_`, posts `2060604129798496702` and
`2058879475094266262`.

## Skills and agents

Shared with the sibling [FB Monitor](../FB%20Monitor/CLAUDE.md) project:

- **n8n-workflow-release** — export, version, CHANGELOG, commit gate, and the
  credential-binding trap when pushing JSON back to n8n.
- **n8n-live-test** — the pinned-first ladder, pin discipline, state snapshot/restore,
  residue tracking, evidence format.
- **execution-inspector** agent — analyzes an execution and returns a verdict instead of
  pulling large payloads into context.
- **workflow-drift-auditor** agent — live vs export vs docs comparison, read-only.

Generic n8n knowledge (expressions, code nodes, validation, error handling) is covered by
the installed `n8n-mcp-skills` plugin — reach for those rather than re-deriving.

## Report back

These four headings are the preferred default shape for closing a substantial piece of
work. This is a preference, not a rule: use a different structure whenever it genuinely
serves the answer better, and drop the scaffolding entirely on small or conversational
replies. What matters is that these four things stay easy to find, not that the headings
appear verbatim. When the format is used, skip a heading only when it is genuinely empty —
write "none" rather than dropping it silently.

**What happened** — what was actually done, with concrete evidence: workflow name and ID,
publish state after the edit (`active`, and `activeVersionId` matching `versionId`),
execution IDs, the input or command tested, important nodes reached or skipped, rows
changed and their cleanup/restoration status, local files updated, commit/push status.
State failures and skipped steps plainly.

**Actions you need to take** — things only the user can do: approvals for risky paths (X
writes, activation/deactivation, production executions with side effects, live SMM orders),
manual n8n UI steps, credentials or tokens to restore.

**Decisions you need to make** — open product or design choices deliberately left to the
user, each with the options and a recommendation. Genuinely undecided items only.

**What's left** — remaining scope, risky branches deliberately skipped and why, and
follow-ups that belong in `TASK_TODOLIST.md`.

When the user says something "didn't work" after a successful API response, verify from
*their* surface — bot identity, command scopes, actual message output, DB rows, active
version, live execution data — not just the response code.
