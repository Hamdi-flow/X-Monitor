-- T5 onboarding path — schema half.
-- docs/architecture/multi-tenant-and-web-ui.md §12b, §12e
--
-- Both Supabase projects are shared with the sibling FB Monitor project, so
-- every table is named explicitly and nothing here is schema-wide.
--
-- Two changes, both additive and both nullable, so no existing writer breaks:
--
--   1. "X Auth Sessions".client_id — the client an OAuth authorization is FOR.
--      Set by Generate X OAuth Link / Save Auth Session at /auth_x time and
--      carried through the callback onto "X Auth Accounts".client_id, which
--      T1 created but nothing has ever populated.
--
--   2. An index on "Moderation Queue".client_id. The column already exists
--      (T1) and stays FK-free by decision — the queue is written by the router
--      and drained by a workflow that must not be blocked by a client row
--      disappearing. T5 only starts populating it.
--
-- client_id is deliberately NULLABLE on both. An OAuth session whose client
-- cannot be resolved must still be storable, because failing the insert would
-- break /auth_x entirely — the same reasoning T1 applied to "Order Info".

begin;

-- 1. Which client an OAuth authorization is for -----------------------------

alter table public."X Auth Sessions"
  add column if not exists client_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'X Auth Sessions_client_id_fkey'
  ) then
    alter table public."X Auth Sessions"
      add constraint "X Auth Sessions_client_id_fkey"
      foreign key (client_id) references public."Clients"(id)
      on delete set null;
  end if;
end $$;

create index if not exists "X Auth Sessions_client_id_idx"
  on public."X Auth Sessions" (client_id);

comment on column public."X Auth Sessions".client_id is
  'Client this authorization is for. Set at /auth_x, copied onto "X Auth Accounts".client_id by the OAuth callback. Nullable: a session that cannot resolve a client must still be storable.';

-- 2. Moderation Queue.client_id becomes a real lookup key -------------------

create index if not exists "Moderation Queue_client_id_idx"
  on public."Moderation Queue" (client_id);

comment on column public."Moderation Queue".client_id is
  'Owning client, stamped from the post at enqueue time by the router. Deliberately no FK: the drain must not be blocked by a client row changing.';

-- 3. Record what telegram_chat_id now means ---------------------------------
-- T5 decision: client_id is the sole owner of a tracked account. /track no
-- longer writes telegram_chat_id, because a staff caller's chat is not the
-- client's chat and writing it would misattribute ownership. Existing values
-- are left untouched rather than nulled -- they are historically accurate --
-- and the column is scheduled for removal in T6.

comment on column public."Tracked Users".telegram_chat_id is
  'DEPRECATED as of T5 -- client_id is the sole ownership key. No longer written by /track; existing values are historical. Scheduled for removal in T6.';

commit;
