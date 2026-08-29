-- T2 staging tenancy test scaffolding. Additive only; teardown-staging.sql reverses it.
insert into public."Staff" (chat_id, label, is_active)
values ('8677383067', 'Operator (staging)', true)
on conflict (chat_id) do update set is_active = true, label = excluded.label;

insert into public."Clients" (slug, name, is_active)
values ('tenancy-test-a', 'Tenancy Test A', true),
       ('tenancy-test-b', 'Tenancy Test B', true)
on conflict (slug) do nothing;

insert into public."Client Members" (client_id, chat_id, role, receives_alerts, is_active, label)
select c.id, '9900000001', 'client', true, true, 'Tenancy Test A chat'
  from public."Clients" c where c.slug = 'tenancy-test-a'
on conflict do nothing;

insert into public."Client Members" (client_id, chat_id, role, receives_alerts, is_active, label)
select c.id, '9900000002', 'client', true, true, 'Tenancy Test B chat'
  from public."Clients" c where c.slug = 'tenancy-test-b'
on conflict do nothing;

insert into public."Tracked Users" (user_id, username, telegram_chat_id, is_active, client_id)
select 'TENANCY_TEST_A_USER', 'tenancy_test_a', '9900000001', true, c.id
  from public."Clients" c where c.slug = 'tenancy-test-a'
on conflict (user_id) do nothing;

insert into public."Tracked Users" (user_id, username, telegram_chat_id, is_active, client_id)
select 'TENANCY_TEST_B_USER', 'tenancy_test_b', '9900000002', true, c.id
  from public."Clients" c where c.slug = 'tenancy-test-b'
on conflict (user_id) do nothing;

-- Posts.client_id is overwritten authoritatively by posts_set_client from Tracked Users.
insert into public."Posts" (post_id, user_id, status, client_id)
select '9990000000000000101', 'TENANCY_TEST_A_USER', 'New', c.id
  from public."Clients" c where c.slug = 'tenancy-test-a'
on conflict (post_id) do nothing;

insert into public."Posts" (post_id, user_id, status, client_id)
select '9990000000000000202', 'TENANCY_TEST_B_USER', 'New', c.id
  from public."Clients" c where c.slug = 'tenancy-test-b'
on conflict (post_id) do nothing;
