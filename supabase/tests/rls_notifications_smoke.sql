-- ============================================================================
-- rls_notifications_smoke.sql (pgTAP)
-- Smoke tests for 0026 notifications: the P2 recipient read, the cross-user
-- deny, the client insert fence, the ONE client write this table has (read_at)
-- and the column fence that makes it the only one, the row trigger that
-- restates that fence for the roles the grant cannot reach, the no-truncate
-- statement trigger, the service_role privilege split (insert/update/delete
-- stay, truncate goes), the anon deny, and the kind / title / body constraints.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0026 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy mirrors rls_audit_logs_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create one tenant via register_business under set-local-role authenticated
-- capturing the returned business id, then seed notification rows as the
-- privileged role, which stands in for the service-role writer - the only
-- writer this table has.
--
-- HARD RULE, carried over from the receipts and audit suites: every fixture id
-- is captured off its own "insert ... returning" CTE. Nothing is ever looked up
-- by name or by any other global predicate over a whole table - this database
-- also holds live E2E data, and a live row sharing a fixture's title or kind
-- would silently be picked up instead of the fixture's own row. Every count
-- assertion below is scoped by a fixture id or a fixture user id, never left as
-- a bare count over a table.
--
-- Note on the "zero rows changed" assertions: an UPDATE that no policy admits
-- is not an error, it is zero affected rows. Those cases therefore assert the
-- row's VALUE afterwards (read back as the privileged role), which is the only
-- thing that distinguishes "denied" from "applied".
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(29);

-- ---------------------------------------------------------------- fixtures
-- Three fixed test users: the recipient, a second consumer (the cross-user
-- probe), and a business owner (the tenant that sends).
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-notif-recipient@example.com', '{"full_name": "Notif Recipient"}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-notif-stranger@example.com', '{"full_name": "Notif Stranger"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-notif-owner@example.com', '{"full_name": "Notif Owner"}'::jsonb);

-- the owner registers the sending tenant; register_business returns the new
-- business uuid (0003), so the id is captured straight from the call.
select set_config('request.jwt.claims',
  '{"sub": "e3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Notif Cafe', 'cafe', 'cebu', '9 Inbox Street')::text),
  true);
reset role;

-- notification rows, seeded as the privileged role (stands in for the
-- service-role writer). One insert, one returning CTE.
--   n1 - the recipient's, UNREAD, an award
--   n2 - the recipient's, already READ, a rejection carrying the consumer-safe
--        copy (nothing from the fraud stage; that property is asserted in the
--        TypeScript suite, where the copy matrix lives)
--   n3 - the STRANGER's, unread. The cross-user probe.
with ins as (
  insert into public.notifications
    (user_id, business_id, kind, title, body, data, read_at)
  values
    ('e1111111-1111-4111-8111-111111111111', current_setting('test.biz')::uuid,
     'points_awarded', 'Points added',
     '120 points are now in your Notif Cafe wallet.',
     '{"route": "/scan/d0000000-0000-4000-8000-000000000001", "params": {"receipt_id": "d0000000-0000-4000-8000-000000000001", "points": 120}}'::jsonb,
     null),
    ('e1111111-1111-4111-8111-111111111111', current_setting('test.biz')::uuid,
     'receipt_rejected', 'Already scanned',
     'This receipt is already on your account. Each receipt can earn points once.',
     '{"route": "/scan/d0000000-0000-4000-8000-000000000002", "params": {"receipt_id": "d0000000-0000-4000-8000-000000000002"}}'::jsonb,
     now()),
    ('e2222222-2222-4222-8222-222222222222', current_setting('test.biz')::uuid,
     'receipt_in_review', 'The store is checking this',
     'Some receipts get a quick look from a person before points are added.',
     '{"route": "/scan/d0000000-0000-4000-8000-000000000003", "params": {"receipt_id": "d0000000-0000-4000-8000-000000000003"}}'::jsonb,
     null)
  returning id, user_id, kind
)
select
  set_config('test.n1', (select id::text from ins where kind = 'points_awarded'), true),
  set_config('test.n2', (select id::text from ins where kind = 'receipt_rejected'), true),
  set_config('test.n3', (select id::text from ins where kind = 'receipt_in_review'), true);

-- ---------------------------------------------------------------- recipient view
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 1. the recipient reads their own inbox (P2 select). Pinned to the fixture
--    user id rather than left as a bare count, so live E2E rows cannot inflate
--    it.
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e1111111-1111-4111-8111-111111111111'::uuid),
  2,
  'recipient reads their own notifications (P2 owner select)');

-- 2. and none of anybody else's. This is the whole point of the table's RLS:
--    an inbox is addressed mail.
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e2222222-2222-4222-8222-222222222222'::uuid),
  0,
  'recipient cannot read another user notifications (P2 cross-user deny)');

-- 3. not even by naming the row id directly
select is(
  (select count(*)::int from public.notifications
    where id = current_setting('test.n3')::uuid),
  0,
  'recipient cannot read a stranger notification by id');

-- 4. every column of their own row reads cleanly: unlike receipts (0017) and
--    audit_logs (0022) there is no withheld-column set on the read side. The
--    whole message is the recipient's to see, which is what a message is.
select lives_ok(
  $$select id, user_id, business_id, kind, title, body, data, read_at, created_at
      from public.notifications
     where user_id = 'e1111111-1111-4111-8111-111111111111'::uuid$$,
  'recipient reads every notifications column on their own rows');

-- 5. the unread count, which is what the badge renders and what
--    notifications_user_unread_idx exists for
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e1111111-1111-4111-8111-111111111111'::uuid
      and read_at is null),
  1,
  'unread count sees only the recipient own unread rows');

-- 6. THE one client write: mark read.
select lives_ok(
  $$update public.notifications set read_at = now()
     where id = current_setting('test.n1')::uuid$$,
  'recipient marks their own notification read (read_at column grant)');

reset role;

-- 7. and it actually landed (read back privileged, so RLS cannot mask it)
select isnt(
  (select read_at from public.notifications where id = current_setting('test.n1')::uuid),
  null,
  'the mark-read write persisted');

set local role authenticated;

-- 8. un-reading is permitted and deliberate: it is the recipient own read
--    state, and no invariant says a read message stays read
select lives_ok(
  $$update public.notifications set read_at = null
     where id = current_setting('test.n1')::uuid$$,
  'recipient may un-read their own notification');

-- 9. THE FENCE. A row-level policy chooses which ROWS an update may touch,
--    never which COLUMNS, so without the column grant this would be permitted
--    by notifications_owner_update - on the recipient own row. A recipient who
--    can rewrite the body can fabricate what a shop told them, and the rows
--    worth rewriting are exactly the ones worth disputing.
select throws_ok(
  $$update public.notifications set body = 'The store awarded you 50,000 points.'
     where id = current_setting('test.n1')::uuid$$,
  '42501',
  null,
  'recipient cannot edit the body of their own notification (column grant fence)');

-- 10. same for the title
select throws_ok(
  $$update public.notifications set title = 'Points added'
     where id = current_setting('test.n2')::uuid$$,
  '42501',
  null,
  'recipient cannot edit the title of their own notification (column grant fence)');

-- 11. and for kind, which drives the icon, the tone and the deep link: a
--     client-writable kind would let a rejection re-render as an award
select throws_ok(
  $$update public.notifications set kind = 'points_awarded'
     where id = current_setting('test.n2')::uuid$$,
  '42501',
  null,
  'recipient cannot change the kind of their own notification (column grant fence)');

-- 12. and for the deep-link payload
select throws_ok(
  $$update public.notifications set data = '{"route": "/wallet"}'::jsonb
     where id = current_setting('test.n2')::uuid$$,
  '42501',
  null,
  'recipient cannot rewrite the data payload (column grant fence)');

-- 13. and they cannot re-address a message to themselves. Two layers say no:
--     user_id is outside the column grant (42501 fires first) and the policy
--     with check would refuse the resulting row anyway.
select throws_ok(
  $$update public.notifications set user_id = 'e1111111-1111-4111-8111-111111111111'::uuid
     where id = current_setting('test.n3')::uuid$$,
  '42501',
  null,
  'recipient cannot re-address a notification to themselves (column grant fence)');

-- 14. no client insert policy AND no client insert privilege. A notification a
--     consumer can write is a notification that proves nothing.
select throws_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('e1111111-1111-4111-8111-111111111111'::uuid, 'points_awarded',
            'Points added', '9,999 points are now in your wallet.')$$,
  '42501',
  null,
  'recipient cannot insert a notification (service-role write fence)');

-- 15. and no delete: the inbox has no delete affordance and retention is the
--     cleanup job under the service role
select throws_ok(
  $$delete from public.notifications where id = current_setting('test.n1')::uuid$$,
  '42501',
  null,
  'recipient cannot delete a notification (no client delete privilege)');

reset role;

-- ---------------------------------------------------------------- stranger view
-- The cross-user probe from the other side: marking someone else read is not
-- an error, it is zero affected rows (the policy admits no row), so the
-- assertion has to be about the VALUE afterwards.
select set_config('request.jwt.claims',
  '{"sub": "e2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

-- 16. n1 is the recipient's, and unread again after assertion 8.
select lives_ok(
  $$update public.notifications set read_at = now()
     where id = current_setting('test.n1')::uuid$$,
  'a stranger mark-read on someone else row raises nothing (RLS matches zero rows)');

reset role;

-- 17. and changed nothing: n1 is still unread, read back as the privileged role
--     so RLS cannot mask the answer.
select is(
  (select read_at from public.notifications where id = current_setting('test.n1')::uuid),
  null,
  'a stranger cannot mark another user notification read (policy denies the row)');

-- ---------------------------------------------------------------- anon
-- doc 12 requires the anon row of the matrix to be stated explicitly, not
-- inferred from "no policy". A personal inbox has no anonymous audience, so the
-- table grant is gone: anon does not get an empty list that reads as "you have
-- no notifications", it gets 42501.
set local role anon;

-- 18.
select throws_ok(
  $$select id from public.notifications$$,
  '42501',
  null,
  'anon cannot select notifications at all (table grant revoked)');

-- 19.
select throws_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('e1111111-1111-4111-8111-111111111111'::uuid, 'points_awarded',
            'Points added', 'Anonymous forgery.')$$,
  '42501',
  null,
  'anon cannot insert a notification');

reset role;

-- ---------------------------------------------------------------- privilege fence
-- RLS gates row DML only. It never sees TRUNCATE and it never applies to
-- service_role, so the privilege layer is the only fence for both. Each
-- assertion aggregates the privileges a role actually still holds into a sorted
-- string, so a failure names the exact privilege that leaked.

-- 20.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.notifications', p)),
  null::text,
  'anon holds no write privilege on notifications');

-- 21. authenticated holds no TABLE-level update. The column grant is invisible
--     to has_table_privilege, which is exactly the distinction being asserted:
--     the client write path is one column wide.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.notifications', p)),
  null::text,
  'authenticated holds no table-level write privilege on notifications');

-- 22. read_at is the ONE column it may write
select is(
  (select string_agg(c.column_name, ',' order by c.column_name)
     from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'notifications'
      and has_column_privilege('authenticated', 'public.notifications',
                               c.column_name, 'UPDATE')),
  'read_at',
  'authenticated may update exactly one column of notifications: read_at');

-- 23. the service_role split. INSERT (it is the writer), UPDATE (reserved for
--     the delivery slice, and pinned by the row trigger regardless) and DELETE
--     (doc 30 section 5.7 retention deletes read in_app rows after 90 days -
--     the deliberate difference from audit_logs, which no one may ever delete)
--     stay. TRUNCATE goes: no operation empties every recipient inbox at once.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.notifications', p)),
  'DELETE,INSERT,UPDATE',
  'service_role keeps insert, update and delete on notifications but not truncate');

-- ---------------------------------------------------------------- triggers
-- These run as the privileged role, which is the point: the column grant fences
-- `authenticated` and nothing else, so the trigger is the layer that catches
-- whoever still holds a table-wide UPDATE - the table owner, the service role,
-- any future misgrant. This is NOT 0022's blanket append-only trigger: the
-- read_at write above had to keep working, and it does.

-- 24.
select throws_ok(
  $$update public.notifications set body = 'rewritten after delivery'
     where id = current_setting('test.n1')::uuid$$,
  'P0001',
  null,
  'a notification message cannot be edited even by the table owner (read_at-only trigger)');

-- 25. while the mark-read write the inbox depends on still passes the same
--     trigger. Asserting this is the difference between the right fence and a
--     blanket immutability trigger, which would have broken the feature.
select lives_ok(
  $$update public.notifications set read_at = now()
     where id = current_setting('test.n1')::uuid$$,
  'read_at may still be written through the trigger (this is not append-only)');

-- 26. bulk wipe. The row trigger does not fire on TRUNCATE and nothing
--     references notifications, so the statement trigger is the last line.
select throws_ok(
  $$truncate public.notifications$$,
  'P0001',
  null,
  'notifications cannot be truncated (statement-level trigger)');

-- ---------------------------------------------------------------- constraints
-- 27. `kind` is a VALUE check here, against 0022's shape-only call on
--     audit_logs.action, and the difference is where the write sits: an audit
--     row is the last statement of a money transaction, so a 23514 there rolls
--     back the award; a notification write is fail-soft by construction, so a
--     23514 here costs one message. That inversion is what makes enumerating
--     the vocabulary safe on this table.
select throws_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('e1111111-1111-4111-8111-111111111111'::uuid, 'campaign_push',
            'Half price today', 'Come in before 6pm.')$$,
  '23514',
  null,
  'an unregistered kind is rejected (notifications_kind_check)');

-- 28. an empty title satisfies `not null` and renders as a notification that
--     says nothing, which is worse than no notification at all
select throws_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('e1111111-1111-4111-8111-111111111111'::uuid, 'points_awarded',
            '   ', 'Points are in your wallet.')$$,
  '23514',
  null,
  'a blank title is rejected (notifications_title_check)');

-- 29. and the body cap is UI truth: the inbox clamps, so anything past it
--     would be stored, shipped and never read
select throws_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('e1111111-1111-4111-8111-111111111111'::uuid, 'points_awarded',
            'Points added', repeat('x', 601))$$,
  '23514',
  null,
  'an over-long body is rejected (notifications_body_check)');

select * from finish();

rollback;
