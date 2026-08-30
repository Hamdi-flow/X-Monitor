-- "Action Log": the audit trail decision #8 chose instead of Telegram mirroring
--
-- Implements the table in docs/architecture/multi-tenant-and-web-ui.md section 4.1, and
-- closes the schema half of decision #11 entry #8 ("Client action visibility -> console
-- only. No Telegram mirroring. `Action Log` is the record."). That decision has been
-- recorded as taken since 2026-08-24 while the table it names did not exist, so the
-- control it promised -- a client acts, and you can see what they did -- was unfulfilled.
--
-- WHAT THIS IS. One table plus its two read indexes, and the foreign key that
-- "Moderation Queue".action_id has been missing since the queue was built
-- (db/migrations/2026-08-26-moderation-queue.sql). That column is a uuid that has always
-- pointed at a table which did not exist; nothing enforced it and nothing could.
--
-- WHAT THIS IS NOT. Nothing writes to this table. The action points live in the Telegram
-- router, which is off limits while the T4 isolation proof runs against it, so wiring the
-- writes is a separate follow-up. Until that lands the table is correct, empty, and inert:
-- creating it changes no workflow's behaviour, because no workflow names it.
--
-- BOTH SUPABASE PROJECTS ARE SHARED WITH THE SIBLING FB MONITOR PROJECT. Every statement
-- below names its table explicitly. There is no schema-wide statement here.
--
-- Applied: staging npytqidroqxgikaqofmq, then production jxnzdxyhoakpfmkbjdeq, 2026-08-30.

begin;

create table if not exists public."Action Log" (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null unique,
  client_id        uuid not null references public."Clients"(id) on delete cascade,
  action           text not null,
  post_id          text,
  params           jsonb not null default '{}'::jsonb,
  channel          text not null
                     check (channel in ('telegram','web','system')),
  actor_chat_id    text,
  actor_user_id    uuid references auth.users(id) on delete set null,
  status           text not null default 'queued'
                     check (status in ('queued','running','succeeded','partial','failed','denied')),
  result           jsonb not null default '{}'::jsonb,
  error_category   text,
  error_message    text,
  n8n_execution_id text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

comment on table public."Action Log" is
  'Audit trail and async action state for every moderation/order action, from either front '
  'end. Decision #8 (multi-tenant-and-web-ui.md section 11). Created 2026-08-30; NOT YET '
  'WRITTEN BY ANY WORKFLOW -- the router action points are a follow-up.';
comment on column public."Action Log".idempotency_key is
  'Shared guard for both front ends. SMMWiz has no cancel, so order.* actions must never '
  'be replayable (limits-and-capacity.md section 7).';
comment on column public."Action Log".result is
  'Decision #15 requires the enqueue-time Telegram message_id to live here, so the drain '
  'can edit the original alert in place.';

create index if not exists action_log_client_created_idx
  on public."Action Log"(client_id, created_at desc);
create index if not exists action_log_post_idx
  on public."Action Log"(post_id, created_at desc);

-- Same posture as every other tenant table: RLS on. Read policies for `authenticated`
-- arrive in 2026-08-30-console-read-policies.sql; n8n uses service_role and is unaffected.
alter table public."Action Log" enable row level security;

-- The foreign key "Moderation Queue".action_id should have had from the start.
-- ON DELETE SET NULL, not CASCADE: an audit row is append-only and should never be
-- deleted, but if one ever is, it must not take queued hide work with it. Both
-- "Moderation Queue" tables are empty in both environments, so this validates instantly.
alter table public."Moderation Queue"
  drop constraint if exists "Moderation Queue_action_id_fkey";
alter table public."Moderation Queue"
  add constraint "Moderation Queue_action_id_fkey"
  foreign key (action_id) references public."Action Log"(id)
  on delete set null on update cascade;

commit;
