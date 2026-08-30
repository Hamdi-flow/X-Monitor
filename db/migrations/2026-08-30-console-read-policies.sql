-- Read-only RLS policies for `authenticated`, preparing for client logins
--
-- Implements docs/architecture/multi-tenant-and-web-ui.md section 5, under decision #11
-- ("Client logins: not now, plan for it -- opening up later is issuing an account, not an
-- audit").
--
-- WHY THIS CANNOT BREAK ANYTHING. Every table below already has RLS enabled with ZERO
-- policies, which in Postgres means deny-all: today only `service_role` and the `postgres`
-- role can read them, and both bypass RLS entirely. n8n uses service_role. The console
-- reads server-side with the service key. Neither is affected by a policy. This migration
-- is therefore strictly additive -- it grants read access that literally nobody has today,
-- to a role (`authenticated`) that currently has no members with any client link. Applying
-- it changes the result of no query anyone runs today.
--
-- READ-ONLY, DELIBERATELY. There are NO insert/update/delete policies for `authenticated`
-- on any table, and there must not be. Supabase's default grants already give
-- `authenticated` full DML privileges on public tables -- RLS is the only thing standing
-- in the way, so a single write policy is the whole gate. Section 5: "A browser that can
-- UPDATE Posts directly can snooze a post without an audit row, and can desync
-- Posts.status from what the Telegram alert message shows." Every write goes through n8n.
--
-- "X Auth Accounts" IS DELIBERATELY ABSENT AND MUST STAY ABSENT. It holds access_token and
-- refresh_token in plaintext columns. It gets no policy, at any privilege, ever. The
-- console needs connection STATUS, which the existing console_x_connections view already
-- derives as booleans without exposing a token. (Consequence worth knowing: that view is
-- security_invoker, so under RLS it returns zero rows to `authenticated` until a
-- definer-side, tenant-filtered source is built for it. Today the console reads it
-- server-side with the service key, so nothing regresses.)
--
-- DEVIATION FROM SECTION 5, DELIBERATE. Section 5 keys acting_client_ids() on the "App
-- Users" and "Client Access" tables from section 4.1. Neither exists, and neither is
-- needed: "Client Members".app_user_id -- already shipped in T1 and already a FK to
-- auth.users -- is the same edge. Decision #1 requires the operator to be a member of
-- EVERY client, so operator membership already carries the cross-client reach that
-- "App Users".is_staff was there to provide, and "Client Access".role (owner/editor/
-- viewer) is unused by read-only policies. "App Users" and "Client Access" are therefore
-- DEFERRED until logins are real; build them then, if the role vocabulary is actually
-- wanted, and repoint this one function.
--
-- No row has app_user_id set in either environment today, so the function returns the
-- empty set for every caller and each policy below currently matches zero rows.
--
-- BOTH SUPABASE PROJECTS ARE SHARED WITH THE SIBLING FB MONITOR PROJECT. Every policy
-- below names exactly one table. No FB *, IG *, Muse * or Copycat * table is touched, and
-- there is no schema-wide GRANT, ALTER or policy statement anywhere in this file.
--
-- Applied: staging npytqidroqxgikaqofmq, then production jxnzdxyhoakpfmkbjdeq, 2026-08-30.

begin;

-- security definer so the function can read "Client Members" without being subject to the
-- policy that is itself defined in terms of this function -- that would recurse.
-- set search_path = '' so a caller cannot shadow "Client Members" with their own relation;
-- everything inside is therefore schema-qualified.
-- (select auth.uid()) is wrapped in a subselect so Postgres evaluates it ONCE PER
-- STATEMENT via an InitPlan rather than once per row.
create or replace function public.acting_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cm.client_id
  from public."Client Members" cm
  where cm.app_user_id = (select auth.uid())
    and cm.is_active
$$;

comment on function public.acting_client_ids() is
  'Client ids the current authenticated user may READ. Keyed on "Client Members".'
  'app_user_id; see 2026-08-30-console-read-policies.sql for why not "Client Access". '
  'Read-only authorization only -- writes go through n8n, never through RLS.';

revoke all on function public.acting_client_ids() from public, anon;
grant execute on function public.acting_client_ids() to authenticated;

-- One select-only policy per tenant table. Same shape everywhere; the only variation is
-- "Clients", which is keyed on its own id rather than a client_id column.

drop policy if exists "read own client" on public."Clients";
create policy "read own client" on public."Clients"
  for select to authenticated
  using (id in (select public.acting_client_ids()));

drop policy if exists "read own client" on public."Client Members";
create policy "read own client" on public."Client Members"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

drop policy if exists "read own client" on public."Tracked Users";
create policy "read own client" on public."Tracked Users"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

drop policy if exists "read own client" on public."Posts";
create policy "read own client" on public."Posts"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

drop policy if exists "read own client" on public."Replies";
create policy "read own client" on public."Replies"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

drop policy if exists "read own client" on public."Order Info";
create policy "read own client" on public."Order Info"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

-- client_id is nullable on both of the tables below. A NULL client_id therefore matches no
-- policy and the row stays invisible -- fail closed, which is the behaviour we want.
drop policy if exists "read own client" on public."Moderation Queue";
create policy "read own client" on public."Moderation Queue"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

drop policy if exists "read own client" on public."Action Log";
create policy "read own client" on public."Action Log"
  for select to authenticated
  using (client_id in (select public.acting_client_ids()));

commit;
