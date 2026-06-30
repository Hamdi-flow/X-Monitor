# XMonitor Task Todo List

Use this file for planned XMonitor work that needs design notes, complexity
estimates, and validation steps before implementation.

## Task Intake Rule

Only add a new task to this todo list when the user explicitly asks for it to be
added. For ordinary requests, analyze and execute the work in the conversation
without creating a todo entry.

When the user explicitly asks to add a task, capture the task design, estimated
complexity, validation plan, open questions for the user, and any risky approval
points. Keep active items under `Open Tasks`, and move finished items to
`Completed Tasks` only after the change has been moved to the production
workflows. Staging validation alone is not enough for completion; keep those
items open and record the staging validation details in `Notes`.

## Complexity Scale

- `S`: documentation-only or narrowly scoped change.
- `M`: local workflow or test change with limited external coordination.
- `L`: live workflow, credential, database, or Git-history work with higher risk.

## Task Template

### Task title

- Status: done
- Priority: low | medium | high | critical
- Complexity: `S` | `M` | `L`
- Source: issue, request, doc, workflow, or date

Design:

1. Describe the intended implementation approach.
2. List the main files, workflows, tables, or systems involved.
3. Note approval points or risky side effects.

Validation:

- List the tests, pinned workflow runs, live checks, or document reviews needed.
- Note any cleanup or rollback checks.

Open Questions:

- List questions for the user that must be resolved before safe execution.
- Write `None` when the task can proceed without clarification.

Notes:

- Capture constraints, follow-up ideas, or things not to forget.

## Open Tasks

### Finalize snooze menu tests and deploy to production

- Status: open
- Priority: high
- Complexity: `L`
- Source: request, 2026-06-30

Design:

1. Finish validation for the staging Telegram snooze duration menu, including callback rendering, duration selection, invalid selections, and missing post IDs.
2. Confirm the scheduled tracker resumes snoozed posts correctly after the selected duration expires.
3. Promote the validated snooze menu behavior from staging to production only after staging evidence is complete and production deployment is explicitly intended.
4. Keep the local workflow exports and workflow documentation aligned with the final staging and production behavior.

Validation:

- Re-run the pinned Telegram router tests for `snooze:<post_id>`, valid `snooze_duration:<post_id>:<duration>`, invalid duration, and missing post ID.
- Run or pin the scheduled tracking expiration logic to prove `snooze_runs_remaining` decrements and the post resumes at the expected time.
- Re-read staging after changes and compare the local export before promotion.
- After production deployment, re-read production and run safe production checks that do not create broad database mutations.

Open Questions:

- Confirm when to promote the snooze menu from staging to production.

Notes:

- Staging Telegram router `oLwwjO05IcRjtF8E` was updated on 2026-06-30 with fixed options `1h`, `4h`, `12h`, and `24h`.
- Existing pinned validation executions: `3265` for menu rendering, `3266` for valid `12h`, `3267` for invalid duration rejection, and `3269` for missing post ID rejection.

### Finalize metrics tests and document X reply retrieval limits

- Status: open
- Priority: high
- Complexity: `M`
- Source: request, 2026-06-30

Design:

1. Finish scheduled monitoring metric validation for single-post and multi-post cases.
2. Document exactly which X replies the scheduled tracker currently retrieves, including endpoint/query behavior, ordering, filters, and pagination behavior.
3. Identify the current reply retrieval limit and whether the workflow is limited by X API parameters, pagination handling, n8n node behavior, database schema, runtime cost, or rate limits.
4. Define the safest next step for expanding the reply limit without increasing cost or API risk unexpectedly.

Validation:

- Re-run pinned metric tests covering total replies, analyzed replies, negative replies, hidden negative replies, and visible negative replies.
- Verify live staging metric output against Supabase rows for at least one representative tracked post.
- Inspect the X reply retrieval node and any pagination or limit settings in the scheduled tracker workflow.
- Record the current limit, the reason for the limit, and the proposed expansion path in workflow docs or notes.

Open Questions:

- None.

Notes:

- Existing staging metric validation includes pinned executions `3263`, `3270`, `3276`, and live staging execution `3278`.
- Live staging execution `3278` sent Telegram message `79` for post `2060604129798496702` with total replies `32`, analyzed replies `25`, negative replies `16`, hidden negative replies `16`, and visible negative replies `0`.

### Avoid re-querying already processed replies in scheduled tracker

- Status: open
- Priority: high
- Complexity: `M`
- Source: request, 2026-06-30

Design:

1. Reduce scheduled tracker cost by skipping X replies that have already been retrieved and processed in prior runs.
2. Inspect the current scheduled tracker flow for how replies are fetched, stored, deduplicated, analyzed, and counted.
3. Prefer an incremental retrieval strategy based on stable reply IDs, timestamps, or the latest processed marker if supported by the current X API query shape.
4. Preserve metric correctness when skipping previously processed replies, especially total replies, analyzed replies, negative replies, and hidden or visible negative reply counts.

Validation:

- Run pinned scheduled tracker tests where some replies already exist in Supabase and some are new.
- Verify already processed replies are not sent through duplicate retrieval, sentiment analysis, or write paths when avoidable.
- Confirm metrics remain accurate after an incremental run.
- Compare expected API calls, OpenAI calls, and database writes before and after the optimization.

Open Questions:

- None.

Notes:

- The implementation should not trade lower OpenAI cost for much higher X API cost. Confirm the retrieval limit and pagination behavior before changing the query pattern.

### Show clearer hide-reply failure reasons

- Status: open
- Priority: high
- Complexity: `M`
- Source: request, 2026-06-30

Design:

1. Improve hide-reply transparency so Telegram output explains why hiding a reply failed when a failure occurs.
2. Inspect the Telegram router hide-replies path, including X moderation responses, Supabase reply status updates, and final Telegram summary formatting.
3. Capture provider error details safely without leaking credentials, raw tokens, or overly noisy response bodies.
4. Surface actionable failure categories such as missing auth, insufficient X scope, non-owner moderation attempt, reply not found, already hidden, rate limit, or provider/network error.

Validation:

- Add or update pinned Telegram router tests for hide-reply provider errors and partial failures.
- Verify successful hide output remains concise and unchanged except where useful.
- Verify failure output includes per-reply or summarized reasons that match the captured provider response.
- Confirm no secrets, bearer tokens, credential IDs, or full raw response bodies appear in Telegram output, pin data, docs, or logs.

Open Questions:

- None.

Notes:

- Existing fixture `tests/n8n/telegram-router-risky-pins/order-comments-provider-error.pinData.json` may be a useful pattern for provider-error pin coverage, but hide-replies needs its own targeted fixture if one is not already present.

## Completed Tasks

_No completed tasks currently._
