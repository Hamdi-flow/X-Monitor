# Sentiment Prompt Review

## Purpose

Once a week, turn the human sentiment labels saved from the monitor console ("Sentiment
wrong?") into a **proposed** edit of the shared sentiment prompt (`"Sentiment Prompts"`) and
per-client, per-platform cheat sheets (`"Sentiment Cheat Sheets"`), measure the proposal with the
production classifier, and email a visual report. **It never applies anything.** A proposal waits
as `pending` until a person approves it in the console (Prompts > Prompt reviews) or by replying
`approve <id>` to the Claude run that started it.

It replaces the August draft `XMonitor - Sentiment Cheat Sheet Review Staging` (`sidiEHY92PD5jwYG`,
never activated).

## Identity

| | Staging | Production |
| --- | --- | --- |
| n8n | `Sentiment Prompt Review (Staging)` `L5PotNp2RD3U8BY0`, unpublished, run with `executionMode: manual` | `Sentiment Prompt Review` `H6ihEBBECUKYOlVE`, published 2026-10-24 (`activeVersionId` `e482f615-b0d1-4d27-9e53-de606d78a573`), run with `executionMode: production` |
| Export | `workflows/staging/sentiment-prompt-review-staging.json` | `workflows/active/sentiment-prompt-review-production.json` |
| Started by | Claude scheduled task `sentiment-prompt-review-staging` (manual only) | Claude scheduled task `sentiment-prompt-review`, Mondays 09:00 local |
| Supabase | `npytqidroqxgikaqofmq` | `jxnzdxyhoakpfmkbjdeq` |
| Email | `hamdisaid123@gmail.com` through `Gmail OAuth2 API` (the Monitor Auditor gateway's sender) | same |

**Never edit the Code nodes in n8n.** They are generated: `tools/prompt-review/lib.js` plus
`tools/prompt-review/nodes/*`, assembled by `node tools/prompt-review/build-workflow.mjs <env>`.
After pushing a change, save `get_workflow_details` to a file and run
`node tools/prompt-review/compare-live.mjs <env> <file>`; it must say "live matches local build".
Tests: `node --test tools/prompt-review/tests/lib.test.mjs tools/prompt-review/tests/pipeline.test.mjs tools/prompt-review/tests/meta-cheat-sheets.test.mjs`.

## Node chain

| Node | Role |
| --- | --- |
| `Review Request` | Webhook, n8n OAuth2 auth (only the MCP / owner can start it). Body `{ min_new_labels?: 3, stability_size?: 100 }`. |
| `Collect Labels` | One SQL statement, one row: every human label on X/FB/IG with owner, post, comment, model and human label; 100 random unlabelled comments from the 1000 newest (stability set); prompt rows; active cheat sheets; active non-blank client stances (`"Client Stances"`); clients; the review id it will use. |
| `Plan Review` | New labels = labelled after the last review that proposed something. Fewer than `min_new_labels` → `skipped`. Otherwise builds the reviewer request; comment text goes in as JSON inside `<data>`, `<` escaped. Client stances go in as `client_stances_read_only`, and the system message says they are set by staff, must not be changed, and that cheat-sheet rules should cover only what the stance does not. |
| `Propose Edit` | OpenAI Chat Completions, `gpt-6-astra` (OpenAI's most capable model; the run is weekly, so quality over cost, ~$1-3 a run), `reasoning_effort: xhigh` (the API rejects `max` for this model on Chat Completions), strict `json_schema` response format, no tools. 30-minute HTTP timeout; the workflow's 40-minute limit is the instance maximum. Changed from `gpt-5.4` on 2026-10-24. |
| `Check Proposal` | Applies find/replace edits (each `find` must occur once), form checks per row (placeholders kept, not empty, at most 25% of words changed), cheat-sheet checks (including "repeats the client stance"); emits one classifier item per (comment, current / candidate prompt), each with the client's stance ahead of its sheet. Nothing valid left → `no_change`. |
| `Classify Sentiment` + `OpenAI Sentiment Model` | The monitors' node and options (`gpt-5.4-mini`, temperature from the row, batches of 5). The system prompt per item is composed exactly as `Resolve Sentiment Prompts` + `Build Analysis Plan` do (pinned by `lib.test.mjs` against the X monitor's own Resolve code). |
| `Build Record` | Scores (accuracy before/after, fixed, broken, stability flips), renders the report (git-style diff, "what the new prompt now catches"), builds the INSERT. |
| `Record Review` → `Send Report` → `Finish Review` → `Mark Emailed` | Stores the row, emails it, stamps `email_sent_at` / `email_error`, returns the run summary the Claude task reads. |

## Client stance (2026-10-24)

The monitors put a client's active stance ahead of its cheat sheet in `{{cheat_sheet_block}}`
(`About this client (stance vN). Use it to judge whether a comment is for or against the
account owner:` + the trimmed stance, a blank line, then the sheet; braces doubled). The review
measures the same block: `prCheatSheetBlock(platform, sheet, stance)` in `lib.js`, pinned
against each monitor's own `Build Analysis Plan` code by `tests/meta-cheat-sheets.test.mjs`
(X from `workflows/staging/`, FB / IG from the sibling repos' exports when they carry the
stance code). A client with no stance gets the byte-identical old block.

The review can never write a stance: it is not in the answer schema, the stance is identical
under both variants, and Check Proposal drops a proposed sheet that contains the stance text
("repeats the client stance"). The stance versions measured are stored in
`metrics.client_stances` and listed in one line at the foot of the report.

Production needs `db/migrations/2026-10-24-client-stances.sql` applied before this version of
the workflow is published there: `Collect Labels` reads `"Client Stances"`.

## Limits worth knowing

- **Images are not stored**, so every comment is re-labelled from its text. A `comment_image` edit
  is reported as NOT measured.
- X stores no reply author, so X replies are never treated as written by the owner when measured.
- Production had 11 labels on 2026-10-24 (X 4, IG 7, FB 0): most weeks will be `skipped` until
  people label more.
- Approval refuses (PT409) if a prompt row or an active cheat sheet changed after the review read it.

## Validation (staging, 2026-10-24)

- Execution `52395`: 14 seeded labels → review #1 `pending`, accuracy 50% → 64.3% (2 fixed,
  0 broken), 2/100 stability flips, email sent. Rejected in the console (no history rows written).
- FB / IG cheat-sheet slots: pinned executions `52408` (FB) and `52409` (IG); see their CHANGELOGs.
- Client stance: `52577` (review #9, reviewer received both staging stances read-only) and
  `52579` (pinned reviewer answer on real staging rows: every House Account classifier prompt
  carries stance v1 ahead of its sheet, a sheet copying the stance was dropped).
