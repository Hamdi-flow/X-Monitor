# XMonitor - Reply Existence Check Staging

## Purpose

Asks X which stored replies still exist and stamps `Replies.deleted_on_x_at` on the ones X no
longer serves (deleted by the author, or the account is gone). Nothing is deleted from the
database; flagged rows are excluded from the scheduler's stored counts and from the console.

Added 2026-10-03 after the database-versus-X validation: 16 of 130 stored replies on production
post `2070901606007062940` were tombstones on X, and 14 of 29 posts held more stored replies than
X reported.

## Identity

| Field | Value |
| --- | --- |
| n8n workflow | `XMonitor - Reply Existence Check Staging` |
| n8n ID | `Tb1RiS7cDTCYFJJs` |
| Environment | Staging |
| Local export | `workflows/staging/xmonitor-reply-existence-check-staging.json` |
| Status | **Inactive** (`activeVersionId: null`). Activating it is a decision for the user — it spends X API reads. |
| Schema | `db/migrations/2026-10-03-replies-deleted-on-x.sql` (`deleted_on_x_at`, `existence_checked_at`, partial index) |

## Production

| Field | Value |
| --- | --- |
| n8n workflow | `XMonitor - Reply Existence Check` |
| n8n ID | `dgC7UqaGAzYpZGbL` |
| Status | **Active**, published `281124cd-9c53-4844-a9f1-0c137177dfe3` (`activeVersionId` = `versionId`), activated 2026-10-03 at the user's request |
| Local export | `workflows/active/xmonitor-reply-existence-check.json` |
| Credentials | `Supabase Account` (production Postgres), `Bearer Auth account` (shared X) |
| First run | manual execution `41037`: 200 checked, 3 marked deleted, 6 `Authorization Error` recorded as checked only |

## Flow

1. `Daily Existence Check` — schedule, 04:00 daily (inert while inactive).
2. `Get Replies To Check` — up to **200** replies with `deleted_on_x_at IS NULL` and never
   checked or checked more than **30 days** ago, never-checked first.
3. `Chunk Reply Ids` — groups of 100 (the `GET /2/tweets` limit).
4. `Look Up Replies On X` — `GET https://api.x.com/2/tweets?ids=…` with `Bearer Auth account`,
   3 tries 5 s apart.
5. `Classify Lookup Results` — `resource-not-found` → deleted. Any other error (seen:
   `not-authorized-for-resource`, protected accounts) is recorded as checked, **not** deleted.
6. `Mark Existence Results` — stamps `existence_checked_at` on every checked reply; sets
   `deleted_on_x_at` once, never clears it.

## Cost

At most 2 lookup calls and 200 post reads per run. Production's 1,236 replies take ~7 daily
runs to cover once, then ~41 reads/day at the 30-day cadence. Billing model is still an open
question in `TASK_TODOLIST.md`; tune `LIMIT 200` / `30 days` in `Get Replies To Check`.

## Not wired

- No error workflow: `XMonitor - Staging Developer Error Alerts` (`CCzwnMyoy7UequuI`) rejects it
  under its default "same owner" caller policy. Allowlisting it means changing that workflow's
  caller policy, which could cut off its existing callers — left for a deliberate change.
- The moderation drain still tries to hide replies that are deleted on X (they fail).

## Verification

| Execution | Result |
| --- | --- |
| `41027` (manual, staging) | Success. 184 checked, 2 marked deleted (`Not Found Error`), 3 `Authorization Error` recorded as checked only. 2 lookup calls. |
