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
| n8n | `Sentiment Prompt Review (Staging)` `L5PotNp2RD3U8BY0`, unpublished, run with `executionMode: manual` | not created yet (needs approval) |
| Export | `workflows/staging/sentiment-prompt-review-staging.json` | `workflows/active/sentiment-prompt-review-production.json` (generated, not in n8n) |
| Started by | Claude scheduled task `sentiment-prompt-review-staging` (manual only) | Claude scheduled task, weekly (not created yet) |
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
| `Collect Labels` | One SQL statement, one row: every human label on X/FB/IG with owner, post, comment, model and human label; 100 random unlabelled comments from the 1000 newest (stability set); prompt rows; active cheat sheets; clients; the review id it will use. |
| `Plan Review` | New labels = labelled after the last review that proposed something. Fewer than `min_new_labels` → `skipped`. Otherwise builds the reviewer request; comment text goes in as JSON inside `<data>`, `<` escaped. |
| `Propose Edit` | OpenAI Chat Completions, `gpt-6-astra` (OpenAI's most capable model; the run is weekly, so quality over cost, ~$1-3 a run), `reasoning_effort: max`, strict `json_schema` response format, no tools. 30-minute HTTP timeout; the workflow's 40-minute limit is the instance maximum. Changed from `gpt-5.4` on 2026-10-24. |
| `Check Proposal` | Applies find/replace edits (each `find` must occur once), form checks per row (placeholders kept, not empty, at most 25% of words changed), cheat-sheet checks; emits one classifier item per (comment, current / candidate prompt). Nothing valid left → `no_change`. |
| `Classify Sentiment` + `OpenAI Sentiment Model` | The monitors' node and options (`gpt-5.4-mini`, temperature from the row, batches of 5). The system prompt per item is composed exactly as `Resolve Sentiment Prompts` + `Build Analysis Plan` do (pinned by `lib.test.mjs` against the X monitor's own Resolve code). |
| `Build Record` | Scores (accuracy before/after, fixed, broken, stability flips), renders the report (git-style diff, "what the new prompt now catches"), builds the INSERT. |
| `Record Review` → `Send Report` → `Finish Review` → `Mark Emailed` | Stores the row, emails it, stamps `email_sent_at` / `email_error`, returns the run summary the Claude task reads. |

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
