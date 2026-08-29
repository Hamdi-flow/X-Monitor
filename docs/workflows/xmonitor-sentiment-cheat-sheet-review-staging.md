# XMonitor - Sentiment Cheat Sheet Review Staging

## Purpose

Weekly job that turns hand-labelled replies into a **draft** per-client sentiment cheat
sheet and sends it to Telegram for a human to approve. It is the write half of the sentiment
feedback loop; the read half lives in the scheduler (see
[Scheduled Post Tracking Staging](./xmonitor-scheduled-post-tracking-staging.md),
"Per-Client Sentiment Cheat Sheet").

The loop:

1. Reviewers hand-label stored replies in `Replies.manual_sentiment` (Supabase table editor).
2. This workflow reads those labels weekly, and asks the model to update that client's rules
   so they would have fixed the replies the classifier got wrong.
3. The result is stored as a **draft**. It changes nothing.
4. A human presses Activate in Telegram. Only then does it reach live labelling.

## Identity

- n8n ID: `sidiEHY92PD5jwYG`
- Environment: staging
- Active: **no** - created inactive on purpose, see Before Activating below
- Local export: `workflows/staging/xmonitor-sentiment-cheat-sheet-review-staging.json`
- Error workflow: `XMonitor - Staging Developer Error Alerts` (`CCzwnMyoy7UequuI`)
- Created: 2026-08-29

## Node Chain

| Node | Role |
| --- | --- |
| `Weekly Trigger` | Mondays 09:00. |
| `Collect Labelled Replies` | One row per active client with `>= 15` labels. |
| `Build Generator Prompt` | Splits disagreements from agreements, formats both. |
| `Generate Cheat Sheet Draft` | `gpt-5.4-mini`, JSON mode, returns `rules_text` + `changes`. |
| `Parse Draft` | Zips client context back onto the model output; rejects empty rules. |
| `Store Draft Cheat Sheet` | Inserts a `draft` row, version computed inside the INSERT. |
| `Build Review Notification` | One message per (client, recipient) with Activate / Discard. |
| `Send Cheat Sheet For Review` | Telegram, HTML, inline keyboard. |

## Important Decisions

**It builds on the ACTIVE sheet, not the newest one.** `Collect Labelled Replies` filters
`status = 'active'`. Selecting the highest version regardless of status would stack each
week's draft on top of the previous week's *unapproved* draft, compounding changes a human
deliberately rejected. This was a real bug in the first version, caught by running the query
against seeded labels and seeing the placeholder draft come back as `current_rules`.

**Minimum 15 labels per client.** Below that a "pattern" is noise. A client under the
threshold is simply skipped and waits a week - `Collect Labelled Replies` returns 0 rows and
nothing downstream runs. There is deliberately **no** `alwaysOutputData` here: "nothing to do
this week" is the correct silent outcome.

**200 most recent labels per client**, via `row_number() OVER (PARTITION BY client_id)`, so a
busy client cannot starve a quiet one, and the prompt stays bounded.

**Full regeneration, not incremental.** Each run rebuilds the sheet from the whole recent
label set rather than appending to the previous sheet. Incremental edits drift; a full
rebuild against the current evidence does not.

**Disagreements are listed separately from agreements.** Agreements confirm the model is
already right and teach nothing. Burying the wrong ones among them spends the context window
on examples that cannot change a rule. Agreements are still included, capped at 20, purely as
"do not break these".

**The version number is computed inside the INSERT** (`COALESCE(MAX(version), 0) + 1`), so
two runs cannot collide on `sentiment_cheat_sheets_client_version_key`.

## Before Activating

**The Activate / Discard buttons do not work yet.** They emit callback data
`cheatsheet_activate:<draft_id>` and `cheatsheet_discard:<draft_id>`, but the staging Telegram
router does not handle those callbacks. Until it does, pressing them does nothing.

Activating this workflow before the router handles them would send reviewers a message with
two dead buttons. Either add the router handlers first, or accept that activation is done by
hand in Supabase for now:

```sql
-- Retire the current active sheet and promote a draft, atomically.
BEGIN;
UPDATE public."Sentiment Cheat Sheets" SET status = 'retired'
 WHERE client_id = '<client-uuid>' AND status = 'active';
UPDATE public."Sentiment Cheat Sheets" SET status = 'active', activated_at = now()
 WHERE id = '<draft-uuid>';
COMMIT;
```

The one-active-per-client rule is enforced by `sentiment_cheat_sheets_one_active_idx`, so
promoting a second sheet without retiring the first fails loudly rather than silently running
two.

## Validation

Pinned execution `18748` on 2026-08-29, status success. `Weekly Trigger`,
`Collect Labelled Replies`, `Generate Cheat Sheet Draft`, `Store Draft Cheat Sheet` and
`Send Cheat Sheet For Review` were all pinned, so the run made no OpenAI call, wrote no rows
and sent no Telegram message. It proves the three code nodes:

- `Build Generator Prompt` split 6 examples into 4 disagreements and 2 agreements, with
  reviewer notes attached.
- `Parse Draft` extracted `rules_text` and `changes` and re-attached client context by index.
- `Build Review Notification` produced correct HTML (`=>` escaped to `=&gt;`), the right
  version line, and both callback payloads.

The SQL in `Collect Labelled Replies` cannot be proved by a pinned run - `test_workflow` pins
credentialed nodes - so it was run directly against staging Supabase instead. 16 replies were
temporarily labelled (6 deliberate disagreements), the query returned exactly one row with
`label_count: 16`, `disagreement_count: 6`, 16 examples and the correct `chat_ids`, and all 16
rows were then restored to NULL. Post-restore check: `still_labelled: 0`, `still_stamped: 0`,
`still_attributed: 0`. No residue.

That seeding run also confirmed the `replies_touch_manual_label` trigger stamps
`manual_labeled_at` on all 16 rows without the reviewer supplying it.

## Not Yet Done

- Telegram router handlers for `cheatsheet_activate:` / `cheatsheet_discard:`.
- A benchmark gate. The intent is that a draft carries a `benchmark_accuracy` before anyone
  activates it, but the accuracy harness
  (`tests/n8n/native-sentiment-accuracy.integration.test.mjs`) has never produced a live score
  - every run so far died on OpenAI rate limits. Until it does, Activate is a judgement call
  on reading the rules, not a measured decision.
- Production promotion, including the migration
  `db/migrations/2026-08-29-sentiment-manual-labels.sql`, which is applied to staging only.
- Rule quality is entirely unvalidated. It has never run against real reviewer labels, because
  none exist yet.

## Agent Change Guidance

- Never let this workflow write `status = 'active'`. The human gate is the whole point.
- If you change the callback data strings, change the router in the same piece of work.
- Keep `Collect Labelled Replies` filtered on `status = 'active'`.
