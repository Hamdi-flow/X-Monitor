---
name: xmonitor-workflows
description: "Use when changing, creating, validating, testing, committing, or pushing XMonitor n8n workflow work in this project, especially staging workflows, Telegram router behavior, scheduled post tracking, X OAuth callback flow, Supabase-backed test data, pinned Telegram inputs, n8n MCP workflow edits, safe live validation, and deciding when validated changes should be committed and pushed."
---

# XMonitor Workflows

Use this skill for XMonitor workflow changes and validation. Keep the process simple: modify staging workflows directly through the n8n MCP when possible, test safe behavior from Codex, and use staging Supabase state plus pinned data to avoid fragile hand-made fixtures.

## Working Principles

- Treat staging as the default target. Do not modify production workflows unless the user explicitly asks.
- Prefer n8n MCP tools for workflow work:
  - Discover with `search_workflows`.
  - Inspect with `get_workflow_details`.
  - Modify with `update_workflow`.
  - Execute/test with `test_workflow`, `execute_workflow`, and `get_execution`.
- If n8n MCP returns an OAuth/authentication-required error, stop and ask the user to reauthorize the MCP connection before making workflow edits. Do not silently fall back to REST for MCP auth failures.
- If a workflow is not MCP-enabled after MCP auth is valid, use the n8n REST API from `keys.env` only when needed, and report that MCP could not access it.
- Prefer the Supabase MCP for any direct staging database inspection, cleanup, schema work, or SQL verification. The project Supabase MCP server is `supabase` at `https://mcp.supabase.com/mcp?project_ref=npytqidroqxgikaqofmq`.
- If a Supabase task comes up and Supabase MCP tools are not visible in the current Codex session, first check `codex mcp list`. If the `supabase` server is present but tools are unavailable or auth is stale, ask the user to reauthenticate/reload the MCP session before falling back to n8n-mediated database access.
- Use existing staging credentials:
  - Supabase API: `Supabase Staging API`
  - Postgres: `Supabase Staging Postgres`
  - Telegram: `Testing Telegram API`
  - X bearer: `Bearer Auth account`
  - OpenAI: `OpenAi account 2`
- Keep local exports in sync after live workflow edits when the repo has a matching file under `workflows/staging/`.
- Never print secrets, access tokens, refresh tokens, API keys, or full credential bodies. Summarize as present/missing.

## Known Staging Workflows

- Telegram router staging: `XMonitor - Telegram Router Staging`, ID `oLwwjO05IcRjtF8E`, local file `workflows/staging/xmonitor-codex-staging.json`.
- Schedule staging: `XMonitor - Scheduled Post Tracking Staging`, ID `l4eKZucUZXzfz0H8`, local file `workflows/staging/xmonitor-scheduled-post-tracking-staging.json`.
- X OAuth callback staging: `XMonitor - X OAuth Callback Staging`, ID `gji3bQd2LdodwEJR`, webhook path `x-oauth-callback-staging`.

## Change Workflow

1. Inspect the live staging workflow before editing.
2. Identify the minimum node or connection change.
3. Use `validate_node_config` before adding or replacing non-trivial nodes.
4. Apply a small `update_workflow` operation batch when MCP can access the workflow.
5. If using REST because MCP is unavailable, send only accepted public workflow fields: `name`, `nodes`, `connections`, and minimal `settings` such as `executionOrder`.
6. Re-read the workflow and verify the changed node values.
7. Update the matching local export with the same change.

## Commit And Push Workflow

Use judgment to commit and push when changes are coherent, validated, and useful to preserve remotely. Prefer this after completing a meaningful workflow change, fixture update, skill update, or repo-maintenance task. Do not wait for the user to explicitly ask when the work is complete and the risk is low.

Before committing:

1. Run `git status --short` and identify files changed by the current task.
2. Review `git diff` for touched files and avoid staging unrelated user changes.
3. Run the most relevant validation that is practical for the change:
   - Workflow edits: re-read live workflow and run pinned or safe staging tests when applicable.
   - Pin fixtures: run the relevant pinned test when practical, or validate JSON shape at minimum.
   - Skill or docs-only edits: inspect the diff; run skill validation only when the validator is available and the change is structural.
4. If validation cannot be run, commit only when the change is still low-risk and clearly explain the skipped validation.

Commit rules:

- Stage only the files that belong to the completed task.
- Use a concise present-tense message, for example `Add risky Telegram router pin fixtures`.
- Do not include secrets, credential bodies, tokens, or live API payloads in commits.
- Do not commit WIP, experimental probes, generated noise, or broad formatting churn unless the user asked for it.
- Do not commit or push if unrelated user changes are mixed into the same files and cannot be separated safely.
- Ask before committing anything that ran or enables live X writes, SMM orders, mass staging mutations, workflow activation/deactivation, or other risky external effects.

Push rules:

- After a clean commit, push the current branch when the commit represents completed useful work.
- If push fails because the remote has new commits, fetch and inspect before deciding whether to rebase/merge or ask the user.
- If push requires credentials or network approval, request approval through the shell escalation flow.
- Report the commit hash, branch, pushed status, and validation evidence in the final response.

## Testing Workflow

Prefer this order:

1. **Pinned logic test**: use `test_workflow` with pinned `Telegram Trigger` input and pin credentialed output nodes only when avoiding side effects.
2. **Safe live staging test**: allow staging Supabase reads/writes and testing Telegram sends for non-risky branches.
3. **Controlled external test**: only call X write endpoints after the user explicitly requests it and the target is staging data.
4. **Do not run SMM order paths** unless the user explicitly asks to place an order.

For Telegram router tests, pin payloads like:

```json
{
  "Telegram Trigger": [
    {
      "json": {
        "update_id": 900001,
        "message": {
          "message_id": 101,
          "from": {
            "id": 8677383067,
            "is_bot": false,
            "first_name": "Test",
            "last_name": "User",
            "language_code": "en"
          },
          "chat": {
            "id": 8677383067,
            "first_name": "Test",
            "last_name": "User",
            "type": "private"
          },
          "date": 1781631500,
          "text": "/help",
          "entities": [
            {
              "offset": 0,
              "length": 5,
              "type": "bot_command"
            }
          ]
        }
      }
    }
  ]
}
```

For callback button paths, pin `callback_query` instead of `message`, with data such as `snooze:<POST_ID>`, `resume:<POST_ID>`, `hide_replies:<POST_ID>`, or `order_likes:<POST_ID>`.

### Risky Path Pin Fixtures

Use the reusable pin fixtures in `tests/n8n/telegram-router-risky-pins/` when a test needs to reach a risky branch without live side effects:

- `hide-replies-success.pinData.json`: exercises `hide_replies:<POST_ID>` while pinning X hide, reply status update, Supabase reads, and Telegram summary output.
- `order-likes-success.pinData.json`: exercises `/order_likes POST_ID AMOUNT` while pinning Supabase reads and both SMM add/status HTTP calls.
- `order-comments-confirm-success.pinData.json`: exercises `/order_comments POST_ID`, generated counter replies, confirmation, SMM add/status calls, Supabase writes, and Telegram outputs through pinned data.

When to use these fixtures:

- Use them after any Telegram router change that can affect intent parsing, branch routing, risky path validation, result formatting, or downstream node wiring.
- Use them before promoting staging changes that touch `HIDE_REPLIES`, `ORDER_LIKES`, or `ORDER_COMMENTS`.
- Use them when the user asks whether risky paths still work but has not explicitly approved live X writes or SMM orders.
- Use them as regression coverage in addition to safe live staging tests; they prove routing and transformation logic, not external provider behavior.

How to run:

1. Read live staging with `get_workflow_details` for `oLwwjO05IcRjtF8E` before testing.
2. Load the relevant `*.pinData.json` fixture.
3. Run `test_workflow` with `workflowId: "oLwwjO05IcRjtF8E"`, `triggerNodeName: "Telegram Trigger"`, and the fixture as `pinData`.
4. If MCP reports unknown pin node names, compare against live node names and update the fixture before retrying. Do not remove pins from credentialed or HTTP nodes just to make the test run.
5. Record the execution ID and status in the final report.

Fixture safety rules:

- Keep every credentialed or side-effecting node on the risky path pinned: X HTTP requests, SMM HTTP requests, Supabase writes, Telegram sends/sendAndWait, and AI generation.
- If the workflow adds a new external node to a risky path, add a pinned response for that node before running the fixture.
- Do not treat a pinned risky-path pass as permission to run the live external action. Live X writes and SMM orders still require explicit user approval.
- Prefer fake tokens, fake order IDs, and deterministic sample rows in fixtures. Never put real secrets or credential bodies in pin data.
- If validating provider behavior itself, run a separate controlled external test only after the user explicitly asks for it.

## Supabase Test Data

- Use current staging Supabase rows instead of invented IDs when testing workflow behavior.
- Good existing examples may include:
  - X user `951803761` / `RebelHam_`
  - Post `2060604129798496702`
  - Post `2058879475094266262`
- Before mutating staging rows, snapshot the selected row fields that matter, such as `status`, `snooze_runs_remaining`, `reply_id`, and `post_id`.
- For `/auth_x`, verify callback/session behavior through staging callback execution and confirm an `X Auth Accounts` row exists for the expected X user.
- For hide-replies, require an authenticated owner account with `tweet.moderate.write`, then verify:
  - `Hide Reply On X` returns `data.hidden = true`.
  - `Replies.status` becomes `hidden`.
  - The testing Telegram summary reports hidden/failed counts.

## Risk Boundaries

Safe to run directly from Codex on staging:

- `/help`
- `/auth_x` pinned generation tests
- invalid command validation
- snooze/resume status transitions with row snapshot
- schedule staging manual execution
- Supabase-backed read checks
- pinned Telegram tests

Ask or require explicit user intent before:

- X write operations such as hiding replies.
- Any test that updates many existing staging rows.
- Any workflow activation/deactivation.

Do not run without explicit order-placement approval:

- `/order_comments`
- valid `/order_likes`
- any SMM API request node (`Place Comment Order`, `Check Comment Order Status`, `Place Likes Order`, `Check Likes Order Status`)

## Reporting

End with concise evidence:

- Workflow name and ID.
- Execution IDs.
- Input payload or command tested.
- Nodes reached or skipped.
- Rows changed and cleanup/restoration status.
- Any skipped risky branch and why.
