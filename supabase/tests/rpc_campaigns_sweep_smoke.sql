-- ============================================================================
-- rpc_campaigns_sweep_smoke.sql (pgTAP)
-- Smoke tests for 0053: public.sweep_campaigns, doc 34's T3 (scheduled ->
-- active at starts_at) and T7 (active|paused -> ended at ends_at).
--
-- Fixture strategy: identical to rpc_sweeps_smoke.sql / rpc_points_expiry_
-- smoke.sql. Insert directly into auth.users (the on_auth_user_created
-- trigger creates profiles + consumers), register two tenants via
-- register_business under set-local-role authenticated (captured from the
-- RPC's own return value, never looked up by name), then stamp one
-- business 'active' and the other 'suspended' directly as the privileged
-- role - this test is about the sweep, not the activation state machine
-- rpc_activation_smoke.sql already owns, so there is no reason to walk the
-- full submit/approve flow just to get a business.status value. Campaigns
-- are seeded directly as the privileged role too, standing in for whatever
-- got them to 'scheduled'/'active'/'paused' in the first place.
--
-- now() is transaction-frozen, which is what makes the starts_at/ends_at
-- fixtures exact: "1 hour ago" and "1 hour from now" are computed from the
-- same instant the function itself will read.
--
-- Runs entirely inside one transaction and rolls back. Execute as a
-- privileged role (postgres) against a database with migrations 0001-0053
-- applied.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(24);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('c1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-sweep-active-owner@example.com', '{"full_name": "Active Biz Owner"}'::jsonb),
  ('c2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-sweep-suspended-owner@example.com', '{"full_name": "Suspended Biz Owner"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "c1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz_active',
  (select public.register_business('Sweep Active Cafe', 'cafe', 'cebu', '1 Live Row')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "c2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz_suspended',
  (select public.register_business('Sweep Suspended Diner', 'restaurant', 'cebu', '2 Dark Row')::text),
  true);
reset role;

-- Stamp business standing directly (privileged role bypasses the businesses
-- column fence from 0033; this test is about the sweep's OWN G1 re-check,
-- not about who may write businesses.status).
update public.businesses set status = 'active'    where id = current_setting('test.biz_active')::uuid;
update public.businesses set status = 'suspended' where id = current_setting('test.biz_suspended')::uuid;

-- Seven campaigns, each proving exactly one fact:
--   1. due scheduled, active business      -> activated
--   2. future scheduled, active business    -> untouched (not due yet)
--   3. active, ends_at past                 -> ended
--   4. paused, ends_at past                 -> ended
--   5. already ended, ends_at past          -> untouched (not a candidate)
--   6. archived, ends_at past               -> untouched (not a candidate)
--   7. due scheduled, SUSPENDED business    -> SKIPPED (stays scheduled)
with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_active')::uuid, 'promotion', 'scheduled',
          'Due Scheduled', now() - interval '1 hour', null)
  returning id)
select set_config('test.due_scheduled', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_active')::uuid, 'promotion', 'scheduled',
          'Future Scheduled', now() + interval '1 day', null)
  returning id)
select set_config('test.future_scheduled', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_active')::uuid, 'promotion', 'active',
          'Active Past End', now() - interval '2 days', now() - interval '1 hour')
  returning id)
select set_config('test.active_past_end', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_active')::uuid, 'promotion', 'paused',
          'Paused Past End', now() - interval '2 days', now() - interval '30 minutes')
  returning id)
select set_config('test.paused_past_end', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_active')::uuid, 'promotion', 'ended',
          'Already Ended', now() - interval '3 days', now() - interval '1 hour')
  returning id)
select set_config('test.already_ended', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at, archived_at)
  values (current_setting('test.biz_active')::uuid, 'promotion', 'archived',
          'Already Archived', now() - interval '5 days', now() - interval '4 days', now() - interval '4 days')
  returning id)
select set_config('test.already_archived', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_suspended')::uuid, 'promotion', 'scheduled',
          'Due But Suspended Business', now() - interval '1 hour', null)
  returning id)
select set_config('test.due_suspended', (select id::text from c), true);

-- ------------------------------------------------------------ preconditions
-- 1. the widened partial index exists and covers 'paused' (0012's original
--    predicate excluded it; the sweep's T7 scan needs it for paused rows)
select ok(
  (select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'campaigns_active_window_idx')
  ilike '%paused%',
  'campaigns_active_window_idx predicate now includes paused');

-- ------------------------------------------------------------ the sweep
select set_config('test.processed', public.sweep_campaigns(200)::text, true);

-- 2. exactly three rows genuinely transitioned (skip does not count)
select is(
  current_setting('test.processed'),
  '3',
  'the sweep transitioned exactly 3 campaigns (1 activated, 2 ended); the suspended-business one is skipped, not counted');

-- 3-4. T3: due + active business -> activated
select is(
  (select status from public.campaigns where id = current_setting('test.due_scheduled')::uuid),
  'active',
  'a due scheduled campaign on an active business is activated');

select ok(
  exists (
    select 1 from public.audit_logs
     where entity_type = 'campaign'
       and entity_id = current_setting('test.due_scheduled')::uuid
       and action = 'campaign.activated'
       and actor_kind = 'system'
       and actor_id is null
       and before = '{"status": "scheduled"}'::jsonb
       and after  = '{"status": "active", "trigger": "sweep"}'::jsonb
  ),
  'the audit row reuses campaign.activated with actor_kind=system and after.trigger=sweep');

-- 5-6. not due yet -> untouched, no audit row
select is(
  (select status from public.campaigns where id = current_setting('test.future_scheduled')::uuid),
  'scheduled',
  'a scheduled campaign whose starts_at is still in the future is left untouched');

select ok(
  not exists (
    select 1 from public.audit_logs
     where entity_type = 'campaign' and entity_id = current_setting('test.future_scheduled')::uuid
  ),
  'no audit row is written for the not-yet-due campaign');

-- 7-8. T7: active past ends_at -> ended
select is(
  (select status from public.campaigns where id = current_setting('test.active_past_end')::uuid),
  'ended',
  'an active campaign past its ends_at is ended');

select ok(
  exists (
    select 1 from public.audit_logs
     where entity_type = 'campaign'
       and entity_id = current_setting('test.active_past_end')::uuid
       and action = 'campaign.ended'
       and actor_kind = 'system'
       and before = '{"status": "active"}'::jsonb
       and after  = '{"status": "ended", "trigger": "sweep"}'::jsonb
  ),
  'the audit row reuses campaign.ended, before.status=active, after.trigger=sweep');

-- 9-10. T7: paused past ends_at -> ended (the paused source, proving the
-- widened index and the shared scan both actually reach it)
select is(
  (select status from public.campaigns where id = current_setting('test.paused_past_end')::uuid),
  'ended',
  'a paused campaign past its ends_at is also ended');

select ok(
  exists (
    select 1 from public.audit_logs
     where entity_type = 'campaign'
       and entity_id = current_setting('test.paused_past_end')::uuid
       and action = 'campaign.ended'
       and before = '{"status": "paused"}'::jsonb
       and after  = '{"status": "ended", "trigger": "sweep"}'::jsonb
  ),
  'the audit row correctly records before.status=paused for the paused source');

-- 11-14. terminal statuses are never candidates in the first place
select is(
  (select status from public.campaigns where id = current_setting('test.already_ended')::uuid),
  'ended',
  'an already-ended campaign is not touched');
select ok(
  not exists (select 1 from public.audit_logs
    where entity_type = 'campaign' and entity_id = current_setting('test.already_ended')::uuid),
  'no audit row for the already-ended campaign');

select is(
  (select status from public.campaigns where id = current_setting('test.already_archived')::uuid),
  'archived',
  'an archived campaign is not touched');
select ok(
  not exists (select 1 from public.audit_logs
    where entity_type = 'campaign' and entity_id = current_setting('test.already_archived')::uuid),
  'no audit row for the archived campaign');

-- 15-16. G1: a due scheduled campaign on a non-active business is SKIPPED,
-- not activated and not errored
select is(
  (select status from public.campaigns where id = current_setting('test.due_suspended')::uuid),
  'scheduled',
  'a due scheduled campaign on a suspended business is left scheduled (skipped, not activated)');

select ok(
  not exists (select 1 from public.audit_logs
    where entity_type = 'campaign' and entity_id = current_setting('test.due_suspended')::uuid),
  'no audit row is written for a skipped campaign - nothing happened to it');

-- 17. self-clearing: a second run finds nothing new to do. The skipped
-- campaign is still a legitimate candidate (business still suspended) but
-- contributes 0 to the count every time, so this proves the transitioned
-- rows dropped out of candidacy rather than proving the scan is empty.
select is(
  public.sweep_campaigns(200)::text,
  '0',
  'a second run transitions nothing further (self-clearing)');

-- 18-19. reactivating the business un-skips the campaign on the NEXT run -
-- proving the skip re-checks live standing rather than caching a verdict
update public.businesses set status = 'active' where id = current_setting('test.biz_suspended')::uuid;

select is(
  public.sweep_campaigns(200)::text,
  '1',
  'once the business regains active standing, the previously-skipped campaign activates on the next run');

select is(
  (select status from public.campaigns where id = current_setting('test.due_suspended')::uuid),
  'active',
  'the formerly-skipped campaign is now active');

-- ------------------------------------------------------------ the schedule
select is(
  (select schedule from cron.job where jobname = 'campaigns.sweep'),
  '*/5 * * * *',
  'campaigns.sweep runs every 5 minutes per doc 34/39');

select ok(
  (select active from cron.job where jobname = 'campaigns.sweep')
  and (select command from cron.job where jobname = 'campaigns.sweep')
      = 'select public.sweep_campaigns(200);',
  'campaigns.sweep is active and calls the sweep function directly');

-- ------------------------------------------------------------ ledger untouched
-- The sweep writes campaigns.status and audit_logs only, never the ledger.
select is(
  (select count(*)::text from public.points_transactions
    where campaign_id in (current_setting('test.due_scheduled')::uuid,
                          current_setting('test.active_past_end')::uuid,
                          current_setting('test.paused_past_end')::uuid,
                          current_setting('test.due_suspended')::uuid)),
  '0',
  'the sweep writes no points ledger rows');

-- ------------------------------------------------------------ grants
select ok(
  not has_function_privilege('anon', 'public.sweep_campaigns(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.sweep_campaigns(integer)', 'EXECUTE'),
  'anon and authenticated cannot execute sweep_campaigns');

select ok(
  has_function_privilege('service_role', 'public.sweep_campaigns(integer)', 'EXECUTE'),
  'service_role can execute sweep_campaigns');

select * from finish();

rollback;
