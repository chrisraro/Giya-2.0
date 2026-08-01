-- ============================================================================
-- rpc_activation_smoke.sql (pgTAP)
-- Smoke tests for 0033: the merchant activation lifecycle, the column fence on
-- public.businesses, and the earning-rule precondition.
--
-- THE ASSERTION THIS SUITE EXISTS FOR is the pair at "activate: the
-- precondition": a business sitting in pending_verification with no usable base
-- earning rule CANNOT be activated, and the same business one rule later can.
-- Everything else here is the fencing that makes that pair mean something -
-- because a precondition enforced only on the approval path is worthless if the
-- owner can write `status` themselves, which until 0033 they could.
--
-- The shape of every fence assertion is the same pair 0031's suite uses and for
-- the same reason: the session that is REFUSED is a real owner of a real tenant
-- with a real claim, so a failure reads as "this fence held" rather than as
-- "this session could not do anything anyway". The granted-column assertions
-- beside the refused ones are what prove the fence is a fence and not a wall.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0033 applied. pgTAP
-- lives in the extensions schema.
--
-- HARD RULE, inherited from rls_receipts_smoke.sql and rls_admin_smoke.sql:
-- every fixture id is captured off its own "insert ... returning" CTE or off the
-- RPC that created it. Nothing is looked up by name or by any predicate over a
-- whole table - this database also holds the live demo tenant
-- (kape-bicolandia-naga, already active), and a suite that counted businesses
-- by status would both corrupt its own assertions and be corrupted by the next
-- real merchant to sign up. Every count below is scoped to a fixture id.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(52);

-- ---------------------------------------------------------------- fixtures
-- Five users: a platform admin, a support-role admin (doc 01's read-only row of
-- the matrix, which both decision RPCs must refuse), two business owners, and a
-- consumer who owns nothing (the "no membership at all" actor).
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('d1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-act-admin@example.com', '{"full_name": "Activation Admin"}'::jsonb),
  ('d2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-act-support@example.com', '{"full_name": "Activation Support"}'::jsonb),
  ('d3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-act-owner1@example.com', '{"full_name": "Activation Owner One"}'::jsonb),
  ('d4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-act-owner2@example.com', '{"full_name": "Activation Owner Two"}'::jsonb),
  ('d5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-act-consumer@example.com', '{"full_name": "Activation Consumer"}'::jsonb);

insert into public.platform_admins (user_id, role, is_active)
values
  ('d1111111-1111-4111-8111-111111111111', 'admin', true),
  ('d2222222-2222-4222-8222-222222222222', 'support', true);

-- Two tenants, ids captured straight off the RPC's return value. Both land on
-- status='draft', which is the whole problem 0033 exists to solve.
select set_config('request.jwt.claims',
  '{"sub": "d3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.vbiz1',
  (select public.register_business('Activation Suite Cafe', 'cafe', 'naga', '1 Rule Street')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.vbiz2',
  (select public.register_business('Activation Suite Rival', 'restaurant', 'naga', '2 Rule Ave')::text),
  true);
reset role;

select is(
  (select status from public.businesses where id = current_setting('test.vbiz1')::uuid),
  'draft',
  'register_business still lands a new tenant on draft (0002 default, unchanged by 0033)');

-- Tenant 1 gets a usable base rule; tenant 2 deliberately gets none yet.
with ins as (
  insert into public.points_rules
    (business_id, campaign_id, kind, rule_type, rate_centavos_per_point, rounding, is_active)
  values
    (current_setting('test.vbiz1')::uuid, null, 'base', 'amount_rate', 10000, 'floor', true)
  returning id
)
select set_config('test.vrule1', (select id::text from ins), true);

select ok(
  private.has_usable_base_rule(current_setting('test.vbiz1')::uuid),
  'has_usable_base_rule is true for an amount_rate rule that carries its rate');
select ok(
  not private.has_usable_base_rule(current_setting('test.vbiz2')::uuid),
  'has_usable_base_rule is false for a tenant with no base rule at all');

-- The half-filled rule is the accident more likely than no rule: points_rules
-- constrains rate_centavos_per_point > 0 only WHEN PRESENT, so an amount_rate
-- row with a null rate satisfies every table constraint and awards nothing.
with ins as (
  insert into public.points_rules
    (business_id, campaign_id, kind, rule_type, rate_centavos_per_point, rounding, is_active)
  values
    (current_setting('test.vbiz2')::uuid, null, 'base', 'amount_rate', null, 'floor', true)
  returning id
)
select set_config('test.vrule2', (select id::text from ins), true);

select ok(
  not private.has_usable_base_rule(current_setting('test.vbiz2')::uuid),
  'an amount_rate base rule with a NULL rate is not usable (the silent-zero shape)');

-- ============================================================ column fence
-- Privilege layer, asserted directly. These four columns are what
-- supabase/README.md carried as owed debt: "owner updates could touch
-- businesses.status / verified_at / plan".
select is(
  has_column_privilege('authenticated', 'public.businesses', 'status', 'update'),
  false,
  'businesses.status is outside the authenticated update grant');
select is(
  has_column_privilege('authenticated', 'public.businesses', 'verified_at', 'update'),
  false,
  'businesses.verified_at is outside the authenticated update grant');
select is(
  has_column_privilege('authenticated', 'public.businesses', 'plan', 'update'),
  false,
  'businesses.plan is outside the authenticated update grant');
select is(
  has_column_privilege('authenticated', 'public.businesses', 'suspended_reason', 'update'),
  false,
  'businesses.suspended_reason is outside the authenticated update grant');
-- And the fence is a fence, not a wall: the profile columns the settings screen
-- writes are still granted.
select is(
  has_column_privilege('authenticated', 'public.businesses', 'name', 'update'),
  true,
  'businesses.name is still writable by the merchant (the store profile survives)');
select is(
  has_column_privilege('authenticated', 'public.businesses', 'opening_hours', 'update'),
  true,
  'businesses.opening_hours is still writable by the merchant');
select is(
  has_column_privilege('anon', 'public.businesses', 'name', 'update'),
  false,
  'anon holds no update privilege on businesses at all');

-- Runtime, as the owner's own session. The claim carries app_metadata.biz
-- exactly as the token hook stamps it, so businesses_staff_update MATCHES this
-- row: the refusal below is the column privilege, not a policy that missed.
select set_config('request.jwt.claims',
  format('{"sub": "d3333333-3333-4333-8333-333333333333", "role": "authenticated",
           "app_metadata": {"biz": {"%s": "owner"}}}', current_setting('test.vbiz1')),
  true);
set local role authenticated;

select throws_ok(
  $$update public.businesses set status = 'active'
     where id = current_setting('test.vbiz1')::uuid$$,
  '42501',
  null,
  'AN OWNER CANNOT ACTIVATE THEMSELVES: writing businesses.status raises 42501');

select throws_ok(
  $$update public.businesses set verified_at = now()
     where id = current_setting('test.vbiz1')::uuid$$,
  '42501',
  null,
  'an owner cannot stamp their own verified_at');

select throws_ok(
  $$update public.businesses set plan = 'enterprise'
     where id = current_setting('test.vbiz1')::uuid$$,
  '42501',
  null,
  'an owner cannot upgrade their own plan');

select lives_ok(
  $$update public.businesses set name = 'Activation Suite Cafe (renamed)'
     where id = current_setting('test.vbiz1')::uuid$$,
  'the same owner session still edits its own store profile');

select is(
  (select name from public.businesses where id = current_setting('test.vbiz1')::uuid),
  'Activation Suite Cafe (renamed)',
  'and the profile edit actually landed, so the refusals above are about COLUMNS');

reset role;

-- ============================================================ function fences
select is(
  has_function_privilege('authenticated', 'public.submit_business_for_review(uuid,uuid,text,text)', 'execute'),
  false,
  'submit_business_for_review is not executable by authenticated');
select is(
  has_function_privilege('service_role', 'public.submit_business_for_review(uuid,uuid,text,text)', 'execute'),
  true,
  'submit_business_for_review is executable by service_role');
select is(
  has_function_privilege('authenticated', 'public.activate_business(uuid,uuid,text,text)', 'execute'),
  false,
  'A NON-ADMIN CANNOT EXECUTE THE ACTIVATION RPC: authenticated has no execute');
select is(
  has_function_privilege('anon', 'public.activate_business(uuid,uuid,text,text)', 'execute'),
  false,
  'activate_business is not executable by anon');
select is(
  has_function_privilege('service_role', 'public.activate_business(uuid,uuid,text,text)', 'execute'),
  true,
  'activate_business is executable by service_role');
select is(
  has_function_privilege('authenticated', 'public.reject_business_verification(uuid,uuid,text,text)', 'execute'),
  false,
  'reject_business_verification is not executable by authenticated');

-- ============================================================ submit: guards
select throws_ok(
  format($$select public.submit_business_for_review(%L::uuid, %L::uuid)$$,
         current_setting('test.vbiz2'), 'd4444444-4444-4444-8444-444444444444'),
  'P0001', 'ACTIVATION_NO_EARNING_RULE',
  'a tenant with no usable earning rule cannot even ask for review');

select throws_ok(
  format($$select public.submit_business_for_review(%L::uuid, %L::uuid)$$,
         current_setting('test.vbiz1'), 'd4444444-4444-4444-8444-444444444444'),
  'P0001', 'SUBMIT_FORBIDDEN',
  'another tenant''s owner cannot submit this tenant for review');

select throws_ok(
  format($$select public.submit_business_for_review(%L::uuid, %L::uuid)$$,
         current_setting('test.vbiz1'), 'd5555555-5555-4555-8555-555555555555'),
  'P0001', 'SUBMIT_FORBIDDEN',
  'a user with no membership at all is refused by table truth');

-- ============================================================ submit: success
select set_config('test.vsub1',
  (public.submit_business_for_review(
     current_setting('test.vbiz1')::uuid,
     'd3333333-3333-4333-8333-333333333333',
     'Permits are with the city hall, photos to follow.',
     'req-act-submit-1'))::text, true);

select is(
  (select status from public.businesses where id = current_setting('test.vbiz1')::uuid),
  'pending_verification',
  'submitting moves the tenant to pending_verification');

select is(
  (select status from public.business_verifications
    where id = (current_setting('test.vsub1')::jsonb->>'verification_id')::uuid),
  'pending',
  'and opens a business_verifications round (doc 32 section 2.2)');

select is(
  (select actor_kind from public.audit_logs
    where action = 'business.review_submitted'
      and entity_id = current_setting('test.vbiz1')::uuid),
  'user',
  'the submission audit row is actor_kind=user: the merchant is not an admin');

select throws_ok(
  format($$select public.submit_business_for_review(%L::uuid, %L::uuid)$$,
         current_setting('test.vbiz1'), 'd3333333-3333-4333-8333-333333333333'),
  'P0001', 'SUBMIT_INVALID_STATE',
  'a second submission is refused rather than splitting the queue into two rows');

-- ============================================================ activate: guards
select throws_ok(
  format($$select public.activate_business(%L::uuid, %L::uuid, '   ')$$,
         current_setting('test.vbiz1'), 'd1111111-1111-4111-8111-111111111111'),
  'P0001', 'ACTIVATION_REASON_REQUIRED',
  'a blank reason is refused before anything is read (doc 15 reason-required)');

select throws_ok(
  format($$select public.activate_business(%L::uuid, %L::uuid, 'looks fine to me')$$,
         current_setting('test.vbiz1'), 'd3333333-3333-4333-8333-333333333333'),
  'P0001', 'ACTIVATION_FORBIDDEN',
  'the tenant''s own owner cannot activate their tenant through the RPC either');

select throws_ok(
  format($$select public.activate_business(%L::uuid, %L::uuid, 'looks fine to me')$$,
         current_setting('test.vbiz1'), 'd2222222-2222-4222-8222-222222222222'),
  'P0001', 'ACTIVATION_FORBIDDEN',
  'the support role is refused (doc 01 matrix: support never mutates)');

-- ============================================================ activate: THE precondition
-- The owner deletes their earning rule while the review is open. This is the
-- race a TypeScript check before a separate write cannot close, and it is why
-- the check lives inside the transaction that flips the status.
update public.points_rules
   set deleted_at = now(), is_active = false
 where id = current_setting('test.vrule1')::uuid;

select throws_ok(
  format($$select public.activate_business(%L::uuid, %L::uuid, 'permits check out, approving')$$,
         current_setting('test.vbiz1'), 'd1111111-1111-4111-8111-111111111111'),
  'P0001', 'ACTIVATION_NO_EARNING_RULE',
  'ACTIVATION WITHOUT AN ACTIVE BASE RULE IS REFUSED, at the database, inside the transaction');

select is(
  (select status from public.businesses where id = current_setting('test.vbiz1')::uuid),
  'pending_verification',
  'and the refusal wrote nothing: the tenant is still awaiting review');

-- ============================================================ activate: success
update public.points_rules
   set deleted_at = null, is_active = true
 where id = current_setting('test.vrule1')::uuid;

select set_config('test.vact1',
  (public.activate_business(
     current_setting('test.vbiz1')::uuid,
     'd1111111-1111-4111-8111-111111111111',
     'Mayor''s permit and sample receipt verified against the city registry.',
     'req-act-activate-1'))::text, true);

select is(
  (select status from public.businesses where id = current_setting('test.vbiz1')::uuid),
  'active',
  'ACTIVATION WITH AN ACTIVE BASE RULE SUCCEEDS: the tenant is live');

select ok(
  (select verified_at is not null from public.businesses
    where id = current_setting('test.vbiz1')::uuid),
  'verified_at is stamped, which is the column no owner can write');

select is(
  (select status from public.business_verifications
    where id = (current_setting('test.vsub1')::jsonb->>'verification_id')::uuid),
  'approved',
  'the open round is closed as approved in the same transaction');

select is(
  (select decided_by from public.business_verifications
    where id = (current_setting('test.vsub1')::jsonb->>'verification_id')::uuid),
  'd1111111-1111-4111-8111-111111111111'::uuid,
  'and names the admin who decided it');

select is(
  (select reason from public.audit_logs
    where action = 'business.activated' and entity_id = current_setting('test.vbiz1')::uuid),
  'Mayor''s permit and sample receipt verified against the city registry.',
  'THE AUDIT ROW CARRIES THE REASON, written in the same transaction as the status');

select is(
  (select actor_kind from public.audit_logs
    where action = 'business.activated' and entity_id = current_setting('test.vbiz1')::uuid),
  'admin',
  'the audit row is actor_kind=admin, which is what makes reason mandatory in the database');

select is(
  (select actor_role from public.audit_logs
    where action = 'business.activated' and entity_id = current_setting('test.vbiz1')::uuid),
  'admin',
  'actor_role snapshots the authority the action was taken under, read from platform_admins');

select throws_ok(
  format($$select public.activate_business(%L::uuid, %L::uuid, 'approving again')$$,
         current_setting('test.vbiz1'), 'd1111111-1111-4111-8111-111111111111'),
  'P0001', 'ACTIVATION_INVALID_STATE',
  'an already-active tenant cannot be activated twice');

-- ============================================================ reject
-- Tenant 2 finally sets a usable rule, submits, and is sent back.
update public.points_rules
   set rate_centavos_per_point = 5000
 where id = current_setting('test.vrule2')::uuid;

select set_config('test.vsub2',
  (public.submit_business_for_review(
     current_setting('test.vbiz2')::uuid,
     'd4444444-4444-4444-8444-444444444444',
     null,
     'req-act-submit-2'))::text, true);

select throws_ok(
  format($$select public.reject_business_verification(%L::uuid, %L::uuid, 'no')$$,
         current_setting('test.vbiz2'), 'd2222222-2222-4222-8222-222222222222'),
  'P0001', 'REJECTION_FORBIDDEN',
  'the support role cannot reject either');

select set_config('test.vrej2',
  (public.reject_business_verification(
     current_setting('test.vbiz2')::uuid,
     'd1111111-1111-4111-8111-111111111111',
     'The address on the permit does not match the address on the listing.',
     'req-act-reject-2'))::text, true);

select is(
  (select status from public.businesses where id = current_setting('test.vbiz2')::uuid),
  'draft',
  'a rejection sends the tenant back to draft, where everything is editable again');

select is(
  (select status from public.business_verifications
    where id = (current_setting('test.vsub2')::jsonb->>'verification_id')::uuid),
  'rejected',
  'and closes the round as rejected');

select is(
  (select reason from public.audit_logs
    where action = 'business.verification_rejected'
      and entity_id = current_setting('test.vbiz2')::uuid),
  'The address on the permit does not match the address on the listing.',
  'the rejection audit row carries the mandatory reason');

select throws_ok(
  format($$select public.reject_business_verification(%L::uuid, %L::uuid, 'again')$$,
         current_setting('test.vbiz2'), 'd1111111-1111-4111-8111-111111111111'),
  'P0001', 'REJECTION_INVALID_STATE',
  'a tenant already sent back cannot be rejected a second time');

-- THE REASON THE MERCHANT CAN SEE. business_verifications_staff_select (0002)
-- is what makes doc 32 section 2.2's "shows admin decision_reason verbatim"
-- possible, so it is asserted from the OWNER'S OWN SESSION rather than from the
-- privileged role that wrote it.
select set_config('request.jwt.claims',
  format('{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated",
           "app_metadata": {"biz": {"%s": "owner"}}}', current_setting('test.vbiz2')),
  true);
set local role authenticated;

select is(
  (select decision_reason from public.business_verifications
    where business_id = current_setting('test.vbiz2')::uuid),
  'The address on the permit does not match the address on the listing.',
  'THE MERCHANT READS WHY THEY WERE SENT BACK, under their own session');

reset role;

-- ============================================================ admin reads
-- 0033's two SELECT policies. A tenant awaiting review matches neither
-- businesses_public_select (active only) nor businesses_staff_select
-- (membership), so before this policy an admin's own session could not see the
-- rows their queue is made of.
select set_config('request.jwt.claims',
  '{"sub": "d1111111-1111-4111-8111-111111111111", "role": "authenticated",
    "app_metadata": {"is_platform_admin": true, "admin_role": "admin"}}', true);
set local role authenticated;

select is(
  (select count(*) from public.businesses where id = current_setting('test.vbiz2')::uuid),
  1::bigint,
  'an admin session reads a DRAFT tenant it has no membership of');

select is(
  (select count(*) from public.business_verifications
    where business_id = current_setting('test.vbiz2')::uuid),
  1::bigint,
  'an admin session reads that tenant''s verification round');

reset role;

-- The other half of the pair: a real owner of a real tenant still sees only
-- their own, so the two assertions above are about the admin claim and not
-- about a policy of `using (true)`.
select set_config('request.jwt.claims',
  format('{"sub": "d3333333-3333-4333-8333-333333333333", "role": "authenticated",
           "app_metadata": {"biz": {"%s": "owner"}}}', current_setting('test.vbiz1')),
  true);
set local role authenticated;

select is(
  (select count(*) from public.businesses where id = current_setting('test.vbiz2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s draft business row');

select is(
  (select count(*) from public.business_verifications
    where business_id = current_setting('test.vbiz2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s verification round');

reset role;

select * from finish();
rollback;
