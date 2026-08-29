-- T3 staging scaffolding: per-client alert routing.
--
-- Additive on top of staging-fixtures.sql, which T2 already wrote and which
-- creates clients tenancy-test-a / tenancy-test-b, their member chats
-- 9900000001 / 9900000002, their tracked accounts and one post each. Run that
-- first; this file only adds what T3 needs on top and does not recreate it.
--
-- staging-fixtures-teardown.sql already removes every row both files touch, so
-- there is no separate T3 teardown -- but see the receives_alerts note below.
--
-- Named explicitly throughout: both Supabase projects are shared with FB Monitor.

-- 1. Per-client thresholds must actually differ, or "each post judged by its own
--    client's value" is untestable. A crosses at 0.50 and needs 10 replies;
--    B crosses at 0.30 and needs 5. A post at ratio 0.40 with 8 replies then
--    alerts for B and not for A -- one input, two answers.
update public."Clients"
   set min_replies = 10,
       negative_threshold = 0.50
 where slug = 'tenancy-test-a';

update public."Clients"
   set min_replies = 5,
       negative_threshold = 0.30
 where slug = 'tenancy-test-b';

-- 2. A third client with a member who has opted out of alerts. This is the
--    receives_alerts = false row of the T3 table, and it is deliberately a
--    separate client rather than a flip on tenancy-test-b, so the "client has
--    posts but no eligible recipient" case and the "member is muted" case can
--    both be observed in the same pass.
insert into public."Clients" (slug, name, is_active, lookback_days, min_replies, negative_threshold, timezone)
values ('tenancy-test-c', 'Tenancy Test C', true, 7, 10, 0.50, 'Asia/Beirut')
on conflict (slug) do update
   set is_active = true,
       min_replies = excluded.min_replies,
       negative_threshold = excluded.negative_threshold;

insert into public."Client Members" (client_id, chat_id, role, receives_alerts, is_active, label)
select c.id, '9900000003', 'client', false, true, 'Tenancy Test C chat (alerts off)'
  from public."Clients" c where c.slug = 'tenancy-test-c'
on conflict do nothing;

insert into public."Tracked Users" (user_id, username, telegram_chat_id, is_active, client_id)
select 'TENANCY_TEST_C_USER', 'tenancy_test_c', '9900000003', true, c.id
  from public."Clients" c where c.slug = 'tenancy-test-c'
on conflict (user_id) do nothing;

insert into public."Posts" (post_id, user_id, status, client_id)
select '9990000000000000303', 'TENANCY_TEST_C_USER', 'New', c.id
  from public."Clients" c where c.slug = 'tenancy-test-c'
on conflict (post_id) do nothing;

-- 3. The "client has posts to alert but no active recipient at all" case.
--    Deactivating B's member is a one-row flip, reversed by the teardown below.
--    Apply this only for the case-4 run, then reverse it.
--
--   update public."Client Members" set is_active = false where chat_id = '9900000002';
--   update public."Client Members" set is_active = true  where chat_id = '9900000002';

-- Snapshot before running, so the restore is exact rather than assumed:
--   select slug, min_replies, negative_threshold from public."Clients"
--    where slug in ('tenancy-test-a','tenancy-test-b','tenancy-test-c','house');
--   select chat_id, is_active, receives_alerts from public."Client Members";
