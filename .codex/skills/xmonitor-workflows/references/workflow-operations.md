# XMonitor Workflow Operations Reference

Use this reference after the barebones `SKILL.md` routes you here. It carries the heavier process details that are easy to forget during workflow work.

## MCP And Credentials

- Prefer n8n MCP tools for workflow work:
  - Discover with `search_workflows`.
  - Inspect with `get_workflow_details`.
  - Modify the draft with `update_workflow`.
  - Make the draft live with `publish_workflow`; take it out of service with `unpublish_workflow`.
  - Execute/test with `test_workflow`, `execute_workflow`, and `get_execution`. Note that `test_workflow` runs the **draft**, while triggers run the published active version.
**The `configure-*.ps1` scripts and every `codex mcp` command below apply to Codex only.** They call `codex mcp add` / `codex mcp get`, which have no effect on a Claude Code session. On Claude Code, n8n and Supabase arrive as claude.ai connectors whose tools are deferred and UUID-named: only the tool names appear at session start inside a `<system-reminder>`, so they look absent until loaded with `ToolSearch` (`select:<full tool name>`). That is not an auth failure — never re-run these scripts to fix it, and never report the MCP unavailable without trying `ToolSearch` first. Claude Code has no `.mcp.json` and no `mcpServers` entry in `~/.claude.json` for this project.

- Use bearer-token authentication for the project n8n MCP. The token is stored as `N8N_MCP_ACCESS_TOKEN` in ignored `keys.env`; never put it in prompts, logs, command arguments, committed files, or `config.toml`.
- If n8n MCP returns an authentication-required error *in Codex*, run `scripts/configure-n8n-mcp.ps1`, restart Codex or the IDE when needed, and verify `codex mcp get xmonitor-staging` shows `bearer_token_env_var: N8N_MCP_ACCESS_TOKEN` before falling back to REST.
- Prefer the Supabase MCP for staging database inspection, cleanup, schema work, or SQL verification. Use bearer-token auth through `SUPABASE_ACCESS_TOKEN` in ignored `keys.env`.
- If Supabase tools are missing or report `Not logged in` *in Codex*, run `scripts/configure-supabase-mcp.ps1`, restart Codex or the IDE when needed, and verify the project-scoped server before falling back.
- Prefer the X API MCP for direct X API inspection or read-only validation when available. Register it as `x-api` with `scripts/configure-x-api-mcp.ps1`, using bearer-token auth through `X_API_MCP_ACCESS_TOKEN` and the endpoint in `X_API_MCP_URL` from ignored `keys.env`. If the server is missing, verify `codex mcp get x-api` after registration and restart Codex or the IDE before falling back to raw REST or temporary n8n workflows.
- **`keys.env` currently holds only `SUPABASE_ACCESS_TOKEN`, `STAGING_TELEGRAM_BOT_TOKEN`, and `TELEGRAM_BOT_TOKEN`.** `N8N_MCP_URL`, `N8N_MCP_ACCESS_TOKEN`, `X_API_MCP_URL`, and `X_API_MCP_ACCESS_TOKEN` are absent, so `configure-n8n-mcp.ps1` and `configure-x-api-mcp.ps1` throw on their token check before reaching `codex mcp add`. Restore those values from n8n / the X developer portal before running either script; `x-api` is unreachable from Claude Code either way.
- Direct X API MCP write operations, broad reads, token refresh actions, or any operation that could mutate X state still require explicit user approval. Never print X API MCP tokens, X bearer tokens, OAuth access tokens, refresh tokens, client secrets, or full request/response credential bodies.
- Existing staging credentials in n8n: `Supabase Staging API`, `Supabase Staging Postgres`, `Testing Telegram API`, `Bearer Auth account`, and `OpenAi account 2`.

## Known Workflow Entry Points

- Telegram router staging: `XMonitor - Telegram Router Staging`, ID `oLwwjO05IcRjtF8E`, local export `workflows/staging/xmonitor-codex-staging.json`.
- Scheduled post tracking staging: `XMonitor - Scheduled Post Tracking Staging`, ID `l4eKZucUZXzfz0H8`, local export `workflows/staging/xmonitor-scheduled-post-tracking-staging.json`, hourly schedule but **intentionally inactive** — it is driven by manual execution, so never publish it to close a draft/active gap.
- X OAuth callback staging: `XMonitor - X OAuth Callback Staging`, ID `gji3bQd2LdodwEJR`, webhook path `x-oauth-callback-staging`.
- Telegram router staging `/auth_x` currently requests X scopes `tweet.read`, `users.read`, `tweet.write`, `tweet.moderate.write`, and `offline.access`.
- For the full current list, read `docs/workflows/README.md` and `workflows/manifest.json`.

## Change Workflow

1. Read the relevant workflow doc and local export.
2. Inspect the live workflow before editing.
3. Identify the minimum node, parameter, or connection change.
4. Use `validate_node_config` before adding or replacing non-trivial nodes.
5. Apply a small `update_workflow` operation batch when MCP can access the workflow.
6. If REST is needed because MCP cannot access the workflow, send only public accepted fields: `name`, `nodes`, `connections`, and minimal `settings` such as `executionOrder`.
7. Re-read the workflow and verify changed node values and connections.
8. Confirm the change is actually live: `get_workflow_details` must show `activeVersionId` equal to `versionId`. If they differ the edit is sitting in an unpublished draft — call `publish_workflow` and re-read to confirm. Skip only for workflows that are intentionally inactive.
9. Update the matching local export and workflow docs.

## Documentation And Todo Upkeep

Treat documentation and task state as part of the change, not as follow-up cleanup.

- Update `TASK_TODOLIST.md` when a task is added, clarified, implemented, promoted, validated, blocked, or completed.
- Move completed items from `Open Tasks` to `Completed Tasks` only when the production state matches the completed behavior, then record validation evidence, execution IDs, commit IDs, and any residual risk.
- Update the relevant `docs/workflows/*.md` file whenever command syntax, node behavior, credentials, side effects, schedules, tables, button payloads, or validation guidance changes.
- Update `docs/workflows/README.md` when workflow identity, status, local export paths, documentation status, or agent-wide notes change.
- Keep scripts, pin fixtures, workflow exports, and docs consistent with each other before reporting success.

## Testing Workflow

Prefer this order:

1. Pinned logic test: use `test_workflow` with pinned trigger input and pin side-effecting outputs.
2. Safe live staging test: allow staging Supabase reads/writes and testing Telegram sends only for non-risky branches.
3. Controlled external test: only call X write endpoints after explicit user approval and only with staging data.
4. SMM order tests: never run live order placement unless the user explicitly approves it.

For Telegram router command tests, pin `Telegram Trigger` with a `message` payload. For callback button paths, pin `callback_query` with callback data such as `snooze:<POST_ID>`, `snooze_duration:<POST_ID>:24h`, `resume:<POST_ID>`, `hide_replies:<POST_ID>`, or `order_likes:<POST_ID>`.

Keep every credentialed or side-effecting node pinned on risky paths: X HTTP requests, SMM HTTP requests, Supabase writes, Telegram sends/sendAndWait, and AI generation. If a workflow adds a new external node to a risky path, add a pinned response for that node before running the fixture.

Do not treat a pinned risky-path pass as permission to run the live external action. Live X writes and SMM orders still require explicit user approval.

## Reusable Pin Fixtures

Use `tests/n8n/telegram-router-risky-pins/` after Telegram router changes that can affect intent parsing, branch routing, risky path validation, result formatting, or downstream node wiring.

- `hide-replies-success.pinData.json`: exercises `hide_replies:<POST_ID>` while pinning X hide, reply status update, Supabase reads, and Telegram summary output.
- `order-likes-success.pinData.json`: exercises `/order_likes POST_ID AMOUNT` while pinning Supabase reads and SMM add/status calls.
- `order-comments-confirm-success.pinData.json`: exercises `/order_comments POST_ID`, generated counter replies, confirmation, SMM add/status calls, Supabase writes, and Telegram outputs.

If MCP reports unknown pin node names, compare the fixture against live node names and update the fixture. Do not remove pins from credentialed or HTTP nodes just to make the test run.

## Supabase Test Data

- Use current staging Supabase rows instead of invented IDs when testing workflow behavior.
- Useful existing examples may include X user `951803761` / `RebelHam_`, post `2060604129798496702`, and post `2058879475094266262`.
- Before mutating staging rows, snapshot selected fields that matter, such as `status`, `snooze_runs_remaining`, `reply_id`, and `post_id`.
- For `/auth_x`, verify callback/session behavior through staging callback execution and confirm an `X Auth Accounts` row exists for the expected X user.
- For hide-replies, require an authenticated owner account with `tweet.moderate.write`, then verify `Hide Reply On X` returns `data.hidden = true`, `Replies.status` becomes `hidden`, and the Telegram summary reports hidden/failed counts.

## Commit And Push Workflow

Use judgment to commit and push when changes are coherent, validated, and useful to preserve remotely. Prefer this after completing a meaningful workflow change, fixture update, skill update, or repo-maintenance task. Do not commit WIP, generated noise, broad formatting churn, secrets, credential bodies, tokens, or live API payloads.

Before committing:

1. Run `git status --short` and identify files changed by the current task.
2. Review `git diff` for touched files and avoid staging unrelated user changes.
3. Run the most relevant practical validation:
   - Workflow edits: re-read live workflow and run pinned or safe staging tests when applicable.
   - Pin fixtures: run the relevant pinned test when practical, or validate JSON shape at minimum.
   - Skill or docs-only edits: inspect the diff; run skill validation only when available and useful.
4. Stage only files that belong to the completed task.

Push after a clean commit when the commit represents completed useful work. If the remote has new commits, fetch and inspect before deciding whether to rebase/merge or ask the user. Ask before committing anything that ran or enables live X writes, SMM orders, mass staging mutations, workflow activation/deactivation, or other risky external effects.
