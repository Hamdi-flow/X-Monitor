-- Reverse setup-staging.sql. Deliberately does NOT drop the Staff row:
-- that is the operator's cross-client grant, not test scaffolding.
-- Named explicitly throughout - both Supabase projects are shared with FB Monitor.
delete from public."Replies"
 where post_id in ('9990000000000000101', '9990000000000000202');

delete from public."Order Info"
 where post_id in ('9990000000000000101', '9990000000000000202');

delete from public."Posts"
 where post_id in ('9990000000000000101', '9990000000000000202');

delete from public."Tracked Users"
 where user_id in ('TENANCY_TEST_A_USER', 'TENANCY_TEST_B_USER');

delete from public."Client Members"
 where chat_id in ('9900000001', '9900000002');

delete from public."Clients"
 where slug in ('tenancy-test-a', 'tenancy-test-b');

-- T3 additions (staging-fixtures-t3.sql). Same rule: the Staff row is kept.
delete from public."Replies"
 where post_id = '9990000000000000303';

delete from public."Order Info"
 where post_id = '9990000000000000303';

delete from public."Posts"
 where post_id = '9990000000000000303';

delete from public."Tracked Users"
 where user_id = 'TENANCY_TEST_C_USER';

delete from public."Client Members"
 where chat_id = '9900000003';

delete from public."Clients"
 where slug = 'tenancy-test-c';

-- Reverse the case-4 flip if it was left applied.
update public."Client Members"
   set is_active = true
 where chat_id in ('9900000001', '9900000002');
