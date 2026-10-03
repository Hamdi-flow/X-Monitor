-- Replies: record when a stored reply no longer exists on X
--
-- WHY. Nothing ever removed or flagged a reply that was deleted on X (by its
-- author, or with a suspended account). On 2026-10-03, 16 of the 130 stored
-- replies on production post 2070901606007062940 returned tombstones from X,
-- and 14 of 29 production posts held more stored replies than X reported. Those
-- dead rows inflated stored totals, negative counts, the negative ratio's
-- denominator, and hide-failure counts.
--
-- WHAT. Two nullable columns, nothing removed:
--   deleted_on_x_at       set once, when the existence check finds X no longer
--                         serves the reply. Never cleared by the checker.
--   existence_checked_at  last time the checker asked X about this reply, so
--                         the checker can work through the backlog and re-check
--                         on a slow cadence instead of every run.
-- Rows are kept (not deleted) so moderation history and audit stay intact.
--
-- READERS. "XMonitor - Reply Existence Check" writes both. The scheduler's
-- `Get Stored Post Counts` and `Get Reply Status Counts`, and X-Monitor-Console,
-- exclude rows where deleted_on_x_at IS NOT NULL.
--
-- Behaviour-neutral on its own: both columns default to NULL, so every
-- existing query and upsert keeps working unchanged until its reader is updated.
--
-- Applied: staging npytqidroqxgikaqofmq 2026-10-03.

alter table public."Replies"
  add column if not exists deleted_on_x_at timestamptz,
  add column if not exists existence_checked_at timestamptz;

comment on column public."Replies".deleted_on_x_at is
  'When the existence check found this reply no longer served by X (deleted or account gone). NULL = believed live.';
comment on column public."Replies".existence_checked_at is
  'Last time the existence check asked X about this reply. NULL = never checked.';

-- The checker's work queue: live replies, never or least recently checked first.
create index if not exists replies_existence_queue_idx
  on public."Replies" (existence_checked_at nulls first)
  where deleted_on_x_at is null;
