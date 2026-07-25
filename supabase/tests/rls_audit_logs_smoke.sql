-- ============================================================================
-- rls_audit_logs_smoke.sql (pgTAP)
-- Smoke tests for 0022 audit_logs: the owner-only tenant read (and the manager
-- narrowing that distinguishes this table from the rest of the receipts
-- domain), the invisibility of platform-level rows to every tenant, the
-- ip/user_agent column fence, the client write fence at the privilege layer,
-- the append-only row trigger and the no-truncate statement trigger, the
-- service_role privilege split (INSERT stays, everything else goes), and the
-- action / entity_type shape constraints plus the mandatory admin reason. Runs
-- entirely inside one transaction and rolls back. Execute as a privileged role
-- (postgres) against a database with migrations 0001-0022 applied. pgTAP lives
-- in the extensions schema.
--
-- Fixture strategy: mirror rls_receipts_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create two tenants via register_business under set-local-role authenticated
-- capturing the returned business id, add a manager to tenant 1 for the role
-- narrowing, then seed audit rows as the privileged role, which stands in for
-- the service-role writer - the only writer this table has.
--
-- HARD RULE, carried over from the receipts suite: every fixture id is captured
-- off its own "insert ... returning" CTE. Nothing is ever looked up by name or
-- by any other global predicate over a whole table - this database also holds
-- live E2E data, and a live row sharing a fixture's request_id or action would
-- silently be picked up instead of the fixture's own row. Every count assertion
-- below is likewise scoped by a fixture id or a fixture business id, never left
-- as a bare count over a table.
--
-- Note on the privilege-fence block: each assertion aggregates the privileges a
-- role actually still holds into a sorted string, so a failure names the exact
-- privilege that leaked instead of just reporting false.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(33);

-- ---------------------------------------------------------------- fixtures
-- Four fixed test users: two business owners (the cross-tenant probe), the
-- manager of tenant 1 (the role-narrowing probe that separates this table from
-- receipts and fraud_signals), and one consumer.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('c1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-audit-owner1@example.com', '{"full_name": "Audit Owner One"}'::jsonb),
  ('c2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-audit-owner2@example.com', '{"full_name": "Audit Owner Two"}'::jsonb),
  ('c3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-audit-manager@example.com', '{"full_name": "Audit Manager"}'::jsonb),
  ('c4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-audit-consumer@example.com', '{"full_name": "Audit Consumer"}'::jsonb);

-- owner1 registers tenant 1; register_business returns the new business uuid
-- (0003), so the id is captured straight from the call, never looked up.
select set_config('request.jwt.claims',
  '{"sub": "c1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Audit Cafe', 'cafe', 'cebu', '1 Ledger Street')::text),
  true);
reset role;

-- owner2 registers tenant 2 (the cross-tenant probe)
select set_config('request.jwt.claims',
  '{"sub": "c2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Audit Rival', 'restaurant', 'manila', '2 Trail Ave')::text),
  true);
reset role;

-- the manager of tenant 1 (privileged fixture: staff membership writes are
-- service-role only until the staff module ships). doc 01's "View audit logs
-- (own tenant)" row is the single row in the Platform block where owner is
-- ticked and manager is not, and 0022's policy narrows to array['owner'] on
-- that basis; this member is what turns that narrowing into something testable
-- rather than a claim in a comment.
insert into public.business_staff (business_id, user_id, role, status)
values (current_setting('test.biz1')::uuid,
        'c3333333-3333-4333-8333-333333333333', 'manager', 'active');

-- audit rows, seeded as the privileged role (stands in for the service-role
-- writer). One insert, one returning CTE; every set_config below matches on
-- request_id against "ins" only, i.e. against the three rows this very
-- statement just inserted.
--   al1 - tenant 1, a receipt approval (doc 37's receipt.review_approved)
--   al2 - tenant 2, a receipt rejection (the cross-tenant probe)
--   al3 - NO business_id: a platform-level admin action, which by 0022's policy
--         is visible to no tenant at all. Carries a reason, so it also stands
--         as the positive case for the mandatory-admin-reason constraint.
with ins as (
  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action, entity_type,
     entity_id, before, after, reason, request_id, ip, user_agent)
  values
    ('c1111111-1111-4111-8111-111111111111', 'user', 'owner',
     current_setting('test.biz1')::uuid, 'receipt.review_approved', 'receipts',
     'd0000000-0000-4000-8000-000000000001',
     '{"status": "review", "total_centavos": 124500}'::jsonb,
     '{"status": "approved", "total_centavos": 125000}'::jsonb,
     null, 'req-audit-fixture-1', '203.0.113.10'::inet, 'Mozilla/5.0 (fixture)'),
    ('c2222222-2222-4222-8222-222222222222', 'user', 'owner',
     current_setting('test.biz2')::uuid, 'receipt.review_rejected', 'receipts',
     'd0000000-0000-4000-8000-000000000002',
     '{"status": "review"}'::jsonb,
     '{"status": "rejected", "reject_reason": "fraud_suspected"}'::jsonb,
     'image matched a prior submission', 'req-audit-fixture-2',
     '203.0.113.20'::inet, 'Mozilla/5.0 (fixture)'),
    (null, 'admin', 'super_admin',
     null, 'consumer.suspended', 'profiles',
     'd0000000-0000-4000-8000-000000000003',
     '{"is_suspended": false}'::jsonb,
     '{"is_suspended": true}'::jsonb,
     'cross-business receipt fraud ring', 'req-audit-fixture-3',
     '203.0.113.30'::inet, 'Mozilla/5.0 (fixture)')
  returning id, request_id
)
select
  set_config('test.al1', (select id::text from ins where request_id = 'req-audit-fixture-1'), true),
  set_config('test.al2', (select id::text from ins where request_id = 'req-audit-fixture-2'), true),
  set_config('test.al3', (select id::text from ins where request_id = 'req-audit-fixture-3'), true);

-- ---------------------------------------------------------------- owner view
select set_config('request.jwt.claims',
  '{"sub": "c1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 1. the owner of tenant 1 reads their own tenant's audit trail (P1). Pinned to
--    the fixture business id rather than left as a bare count, so live E2E rows
--    cannot inflate it.
select is(
  (select count(*)::int from public.audit_logs
    where business_id = current_setting('test.biz1')::uuid),
  1,
  'owner reads own-tenant audit rows (P1 owner select)');

-- 2. and none of tenant 2's. before/after and reason on a rejection name the
--    detector and the reviewer's conclusion; that is tenant-private.
select is(
  (select count(*)::int from public.audit_logs
    where business_id = current_setting('test.biz2')::uuid),
  0,
  'owner cannot read another tenant audit rows (P1 cross-tenant deny)');

-- 3. a platform-level row (business_id null) is visible to NO tenant:
--    is_active_staff(null, ...) matches nothing, and there is no admin policy
--    to catch it (the access token hook is disabled). Those rows are service-
--    role reads until the hook lands.
select is(
  (select count(*)::int from public.audit_logs
    where id = current_setting('test.al3')::uuid),
  0,
  'owner cannot read a platform-level audit row (null business_id is nobody''s tenant)');

-- 4. the column fence: ip is the actor's network address, captured for the
--    security record, not for tenant consumption. The row is the owner's own
--    tenant; the column still raises.
select throws_ok(
  $$select ip from public.audit_logs
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'owner cannot select audit_logs.ip even on own-tenant rows (column grant fence)');

-- 5. same for the device fingerprint
select throws_ok(
  $$select user_agent from public.audit_logs
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'owner cannot select audit_logs.user_agent even on own-tenant rows (column grant fence)');

-- 6. while the whole allowlist - everything an owner audit screen renders -
--    reads cleanly
select lives_ok(
  $$select id, actor_id, actor_kind, actor_role, business_id,
           action, entity_type, entity_id, before, after,
           reason, request_id, created_at
      from public.audit_logs
     where business_id = current_setting('test.biz1')::uuid$$,
  'owner reads every allowlisted audit_logs column');

-- 7. no client insert policy AND no client insert privilege: forging an audit
--    row is a hard 42501, not a silent zero-row result
select throws_ok(
  $$insert into public.audit_logs
      (actor_id, actor_kind, business_id, action, entity_type)
    values ('c1111111-1111-4111-8111-111111111111', 'user',
            current_setting('test.biz1')::uuid, 'receipt.review_approved', 'receipts')$$,
  '42501',
  null,
  'owner cannot insert an audit row (service-role write fence)');

-- 8. and cannot rewrite one. This is the assertion the whole table exists for:
--    an audit trail the audited party can edit records nothing.
select throws_ok(
  $$update public.audit_logs set reason = 'looked fine to me'
     where id = current_setting('test.al1')::uuid$$,
  '42501',
  null,
  'owner cannot update an audit row (append-only privilege fence)');

-- 9. nor delete one
select throws_ok(
  $$delete from public.audit_logs where id = current_setting('test.al1')::uuid$$,
  '42501',
  null,
  'owner cannot delete an audit row (append-only privilege fence)');

reset role;

-- ---------------------------------------------------------------- role narrowing: manager
-- The manager is an ACTIVE member of tenant 1 and is exactly the audience 0017
-- granted receipts, fraud_signals and ai_usage_events to. Only the role list on
-- this table denies them, which is doc 01's matrix read literally: a manager
-- decides receipts, and the audit log is the record kept of those decisions.
select set_config('request.jwt.claims',
  '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 10.
select is(
  (select count(*)::int from public.audit_logs
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'manager of the tenant cannot read audit rows (owner-only narrowing, doc 01)');

reset role;

-- ---------------------------------------------------------------- consumer view
select set_config('request.jwt.claims',
  '{"sub": "c4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;

-- 11. a consumer is a SUBJECT of these rows, never an audience: there is no
--     consumer policy at all, so the trail is empty for them
select is(
  (select count(*)::int from public.audit_logs
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'consumer reads no audit rows (no consumer policy)');

-- 12. and cannot write one either
select throws_ok(
  $$insert into public.audit_logs
      (actor_id, actor_kind, business_id, action, entity_type)
    values ('c4444444-4444-4444-8444-444444444444', 'user',
            current_setting('test.biz1')::uuid, 'receipt.review_approved', 'receipts')$$,
  '42501',
  null,
  'consumer cannot insert an audit row (service-role write fence)');

reset role;

-- ---------------------------------------------------------------- anon
-- doc 12 requires the anon row of the matrix to be stated explicitly, not
-- inferred from "no policy". The table-level select grant is gone and anon gets
-- no column allowlist, so anon does not get an empty result - it gets 42501.
set local role anon;

-- 13.
select throws_ok(
  $$select id from public.audit_logs$$,
  '42501',
  null,
  'anon cannot select audit_logs at all (table grant revoked, no column allowlist)');

-- 14.
select throws_ok(
  $$insert into public.audit_logs (actor_kind, action, entity_type)
    values ('system', 'receipt.review_approved', 'receipts')$$,
  '42501',
  null,
  'anon cannot insert an audit row');

reset role;

-- ---------------------------------------------------------------- privilege fence
-- RLS gates row DML only. It never sees TRUNCATE and it never applies to
-- service_role, so the privilege layer is the only fence for both.

-- 15/16. no client writes of any kind
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.audit_logs', p)),
  null::text,
  'anon holds no write privilege on audit_logs');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.audit_logs', p)),
  null::text,
  'authenticated holds no write privilege on audit_logs');

-- 17. the column fence at the privilege layer
select ok(
  not has_table_privilege('anon', 'public.audit_logs', 'SELECT'),
  'anon holds no SELECT privilege on audit_logs (no column allowlist granted)');

-- 18/19. and the two columns withheld from the one client audience there is
select ok(
  not has_column_privilege('authenticated', 'public.audit_logs', 'ip', 'SELECT'),
  'authenticated holds no SELECT privilege on audit_logs.ip (actor network address)');

select ok(
  not has_column_privilege('authenticated', 'public.audit_logs', 'user_agent', 'SELECT'),
  'authenticated holds no SELECT privilege on audit_logs.user_agent (device fingerprint)');

-- 20. the fence that reaches service_role. It is the WRITER, so INSERT stays and
--     nothing else does: the process that writes the trail must not be able to
--     rewrite what it wrote a moment ago.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.audit_logs', p)),
  'INSERT',
  'service_role keeps exactly INSERT on audit_logs (no update, delete or truncate)');

-- ---------------------------------------------------------------- service_role live
set local role service_role;

-- 21. the writer can write
select lives_ok(
  $$insert into public.audit_logs
      (actor_id, actor_kind, actor_role, business_id, action, entity_type,
       entity_id, after, request_id)
    values ('c1111111-1111-4111-8111-111111111111', 'user', 'owner',
            current_setting('test.biz1')::uuid, 'receipt.review_rejected',
            'receipts', 'd0000000-0000-4000-8000-000000000004',
            '{"status": "rejected"}'::jsonb, 'req-audit-service-role')$$,
  'service_role inserts an audit row (it is the writer)');

-- 22/23. and cannot touch it afterwards. The privilege check fires before the
--        trigger, so this is 42501 rather than the trigger's P0001.
select throws_ok(
  $$update public.audit_logs set reason = 'rewritten by the writer'
     where id = current_setting('test.al1')::uuid$$,
  '42501',
  null,
  'service_role cannot update an audit row (append-only privilege fence)');

select throws_ok(
  $$delete from public.audit_logs where id = current_setting('test.al1')::uuid$$,
  '42501',
  null,
  'service_role cannot delete an audit row (append-only privilege fence)');

reset role;

-- ---------------------------------------------------------------- append-only triggers
-- These run as the privileged role, which is the point: the revokes strip
-- update/delete/truncate from anon, authenticated AND service_role, so the
-- triggers are the layer that catches whoever still holds the privilege - the
-- table owner, any future misgrant. Nothing below is reachable by a client role.

-- 24.
select throws_ok(
  $$update public.audit_logs set reason = 'tampered'
     where id = current_setting('test.al1')::uuid$$,
  'P0001',
  null,
  'audit rows cannot be updated even by the table owner (append-only trigger)');

-- 25.
select throws_ok(
  $$delete from public.audit_logs where id = current_setting('test.al1')::uuid$$,
  'P0001',
  null,
  'audit rows cannot be deleted even by the table owner (append-only trigger)');

-- 26. the row trigger above does NOT fire on TRUNCATE, and nothing references
--     audit_logs so no foreign key would refuse the statement first. The
--     statement-level trigger is genuinely the last line, and a bulk wipe is
--     the shape the worst case actually takes.
select throws_ok(
  $$truncate public.audit_logs$$,
  'P0001',
  null,
  'audit_logs cannot be truncated (statement-level trigger)');

-- ---------------------------------------------------------------- constraints
-- 27. action is dot-namespaced by constraint. The VOCABULARY lives in the code
--     registry (doc 25) so a new verb never needs a migration; the SHAPE is
--     asserted here so 'receipt.review_approved' cannot drift into 'approve'.
select throws_ok(
  $$insert into public.audit_logs (actor_kind, action, entity_type)
    values ('system', 'approve', 'receipts')$$,
  '23514',
  null,
  'an undotted action is rejected (audit_logs_action_shape)');

-- 28. pinned to the constraint, so this cannot pass for the wrong reason
select throws_like(
  $$insert into public.audit_logs (actor_kind, action, entity_type)
    values ('system', 'ReceiptReviewApproved', 'receipts')$$,
  '%audit_logs_action_shape%',
  'the 23514 above came from audit_logs_action_shape specifically');

-- 29. entity_type is a table name; the shape stops 'Receipts' / 'public.receipts'
--     variants fragmenting the entity-history index
select throws_ok(
  $$insert into public.audit_logs (actor_kind, action, entity_type)
    values ('system', 'receipt.review_approved', 'public.receipts')$$,
  '23514',
  null,
  'a qualified or capitalized entity_type is rejected (audit_logs_entity_type_shape)');

-- 30. doc 15: admin actions on tenant data ALWAYS require a recorded reason.
--     doc 25 calls it service-enforced; a check constraint makes it structural,
--     which is safe here precisely because the table is append-only.
select throws_ok(
  $$insert into public.audit_logs
      (actor_kind, actor_role, action, entity_type, entity_id)
    values ('admin', 'super_admin', 'consumer.suspended', 'profiles',
            'd0000000-0000-4000-8000-000000000005')$$,
  '23514',
  null,
  'an admin audit row with no reason is rejected (mandatory reason, doc 15)');

-- 31. pinned to the constraint
select throws_like(
  $$insert into public.audit_logs
      (actor_kind, actor_role, action, entity_type, entity_id)
    values ('admin', 'super_admin', 'fraud.clawback_applied', 'points_transactions',
            'd0000000-0000-4000-8000-000000000006')$$,
  '%audit_logs_admin_reason_required%',
  'the 23514 above came from audit_logs_admin_reason_required specifically');

-- 32. and whitespace does not count as a reason: it satisfies "not null" and
--     records nothing, which is the exact shape a caller reaches for when the
--     constraint is in the way
select throws_ok(
  $$insert into public.audit_logs
      (actor_kind, actor_role, action, entity_type, entity_id, reason)
    values ('admin', 'super_admin', 'consumer.suspended', 'profiles',
            'd0000000-0000-4000-8000-000000000007', '   ')$$,
  '23514',
  null,
  'a whitespace-only reason is rejected (audit_logs_reason_not_blank)');

-- 33. while a real reason is accepted
select lives_ok(
  $$insert into public.audit_logs
      (actor_kind, actor_role, action, entity_type, entity_id, reason, request_id)
    values ('admin', 'super_admin', 'consumer.suspended', 'profiles',
            'd0000000-0000-4000-8000-000000000008',
            'confirmed cross-business receipt fraud', 'req-audit-admin-ok')$$,
  'an admin audit row carrying a reason is accepted');

select * from finish();

rollback;
