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
-- privileged role (postgres) against a database with migrations 0001-0055
-- applied. 0054 is the first review-fix pass (I1's self-clearing WHERE
-- clause, I3's raise warning); 0055 is the second (I1+I3's interaction
-- silently dropped skip visibility to zero for the ordinary case, fixed
-- with a separately-testable ineligible-count primitive) - both proven
-- below.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(33);

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

-- Eight campaigns in this batch, each proving exactly one fact (a ninth and
-- tenth pair - 'poison'/'good' - follow much further down for the I1 tight-
-- p_limit starvation proof, in their own isolated businesses):
--   1. due scheduled, active business       -> activated
--   2. future scheduled, active business    -> untouched (not due yet)
--   3. active, ends_at past                 -> ended
--   4. paused, ends_at past                 -> ended
--   5. already ended, ends_at past          -> untouched (not a candidate)
--   6. archived, ends_at past               -> untouched (not a candidate)
--   7. due scheduled, SUSPENDED business    -> SKIPPED (stays scheduled)
--   8. active, ends_at past, SUSPENDED business -> ended (T7 unconditional)
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

-- Review fix (I1 minor): T7 unconditionality is correct by construction but
-- was pinned by no fixture. An active campaign PAST ends_at on the SAME
-- suspended business as the T3 skip case above - if a G1 check ever slipped
-- into T7, this is what would catch it.
with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_suspended')::uuid, 'promotion', 'active',
          'Active Past End On Suspended Business', now() - interval '2 days', now() - interval '1 hour')
  returning id)
select set_config('test.active_past_end_suspended', (select id::text from c), true);

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

-- 2. exactly four rows genuinely transitioned (skip does not count)
select is(
  current_setting('test.processed'),
  '4',
  'the sweep transitioned exactly 4 campaigns (1 activated, 3 ended); the suspended-business SCHEDULED one is skipped, not counted');

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

-- 11-12. T7 is unconditional: ends regardless of business standing, proven
-- against the SAME suspended business the T3 skip case uses
select is(
  (select status from public.campaigns where id = current_setting('test.active_past_end_suspended')::uuid),
  'ended',
  'an active campaign past ends_at is ended even though its business is suspended (T7 has no G1 gate)');

select ok(
  exists (
    select 1 from public.audit_logs
     where entity_type = 'campaign'
       and entity_id = current_setting('test.active_past_end_suspended')::uuid
       and action = 'campaign.ended'
       and before = '{"status": "active"}'::jsonb
       and after  = '{"status": "ended", "trigger": "sweep"}'::jsonb
  ),
  'the audit row lands for the suspended-business T7 case exactly like any other');

-- 13-16. terminal statuses are never candidates in the first place
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

-- 17. idempotency, NOT proof of self-clearing on its own (round-1 finding,
-- restated so this comment stops contradicting the block below it): with
-- p_limit=200 and this few fixtures, "second run returns 0" cannot tell
-- apart "nothing left to do" from "a skipped row is still occupying a slot
-- doing no work" - genuine self-clearing under a tight budget is proven
-- separately further down. As of 0055, `due_suspended` is not even a
-- candidate at this point (0054's `exists()` excludes it while its business
-- stays suspended), so this run's 0 reflects an empty T3/T7 window, not a
-- skip contributing 0.
select is(
  public.sweep_campaigns(200)::text,
  '0',
  'a second run transitions nothing further (idempotent)');

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
                          current_setting('test.due_suspended')::uuid,
                          current_setting('test.active_past_end_suspended')::uuid)),
  '0',
  'the sweep writes no points ledger rows');

-- ------------------------------------------------------------ I1 review fix:
-- genuine self-clearing under a TIGHT p_limit, not just "second run is 0"
-- ------------------------------------------------------------------------
-- Review finding: with p_limit=200 and 8 fixtures, assertion 17 above cannot
-- tell "the transitioned rows left candidacy" from "a skipped row is still
-- occupying a slot doing no work" - both produce a second-run count of 0.
-- 0045's own suite proves its self-clearing fix with a SMALL p_limit so a
-- later pair is reached only once an earlier one clears a slot; this is the
-- same proof for T3. Two fresh, isolated businesses/campaigns (never touched
-- by anything above) so this block cannot be affected by the earlier
-- reactivation of test.biz_suspended:
--   * 'poison': business status='closed' (0002's terminal value - never
--     coming back), scheduled, starts_at 2 hours ago (SORTS FIRST).
--   * 'good': business status='active', scheduled, starts_at 1 hour ago
--     (sorts second - due, gate-passing, and would starve behind poison
--     under the pre-fix ordering-in-the-loop-body design).
-- Before the I1 fix, sweep_campaigns(1) would repeatedly select ONLY
-- 'poison' (it sorts first and the cursor's LIMIT 1 exhausts the whole
-- budget on it before 'good' is ever looked at), skip it forever, and never
-- reach 'good' - starvation, unbounded, exactly 0045's own failure shape.
-- After the fix (0054's exists() moved into the WHERE clause), 'poison'
-- never enters candidacy at all, so the single slot goes straight to 'good'.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('c3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-sweep-closed-owner@example.com', '{"full_name": "Closed Biz Owner"}'::jsonb),
  ('c4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-sweep-good-owner@example.com', '{"full_name": "Good Biz Owner"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz_closed',
  (select public.register_business('Sweep Closed Shop', 'cafe', 'cebu', '3 Dead Row')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "c4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz_good',
  (select public.register_business('Sweep Good Bistro', 'restaurant', 'cebu', '4 Bright Row')::text),
  true);
reset role;

update public.businesses set status = 'closed' where id = current_setting('test.biz_closed')::uuid;
update public.businesses set status = 'active' where id = current_setting('test.biz_good')::uuid;

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_closed')::uuid, 'promotion', 'scheduled',
          'Poison (Closed Business, Sorts First)', now() - interval '2 hours', null)
  returning id)
select set_config('test.poison', (select id::text from c), true);

with c as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz_good')::uuid, 'promotion', 'scheduled',
          'Good (Active Business, Sorts Second)', now() - interval '1 hour', null)
  returning id)
select set_config('test.good', (select id::text from c), true);

-- 20. one call, p_limit=1: the fixed scan excludes 'poison' from candidacy
-- entirely (exists() false), so the single slot goes straight to 'good'.
select is(
  public.sweep_campaigns(1)::text,
  '1',
  'p_limit=1 activates the gate-passing campaign directly - the closed-business one never occupies the slot');

-- 21. 'good' is now active
select is(
  (select status from public.campaigns where id = current_setting('test.good')::uuid),
  'active',
  'the gate-passing campaign activated even though a permanently-ineligible one sorts earlier');

-- 22. 'poison' was never touched - still scheduled, business still closed.
-- (Softened per round-2 review: this status check alone shows "not
-- activated", not the internal MECHANISM by which that happened - both the
-- pre- and post-0054 implementations leave a non-eligible row `scheduled`,
-- so "excluded from candidacy" would claim more than one status read can
-- prove. The count-based assertions below are what actually distinguish the
-- two mechanisms.)
select is(
  (select status from public.campaigns where id = current_setting('test.poison')::uuid),
  'scheduled',
  'the closed-business campaign is left scheduled (not activated)');

-- 23. the audit row landed for 'good'
select ok(
  exists (
    select 1 from public.audit_logs
     where entity_type = 'campaign'
       and entity_id = current_setting('test.good')::uuid
       and action = 'campaign.activated'
       and after = '{"status": "active", "trigger": "sweep"}'::jsonb
  ),
  'the audit row for the formerly-starved campaign is correct');

-- 24. no audit row was ever written for 'poison'
select ok(
  not exists (select 1 from public.audit_logs
    where entity_type = 'campaign' and entity_id = current_setting('test.poison')::uuid),
  'no audit row for the closed-business campaign - it was never a candidate');

-- ------------------------------------------------------- I1 (0055) review fix:
-- the observability lost when I1 (0054) moved the skip out of the loop body
-- ------------------------------------------------------------------------
-- 0054's `exists()` fix made T3's WHERE clause the primary skip mechanism,
-- which means the in-loop `raise warning` (0054's I3 fix) now fires only
-- inside the sub-millisecond race window between the scan and the row lock -
-- for the ORDINARY case (a due campaign on a suspended/closed business,
-- which is exactly what 'poison' is right now) it never executes at all.
-- 0055 restores visibility with ONE `raise warning` per run carrying a
-- COUNT of due-but-ineligible campaigns, computed by a separate, directly
-- testable primitive (`private.campaigns_sweep_ineligible_count`) that does
-- not touch p_limit or the transition budget. pgTAP cannot capture a RAISE
-- statement's text, so what is proven here is the number that statement is
-- built from - the same principle `rpc_points_expiry_smoke.sql` uses for
-- `expire_points`'s internal sums (private.points_lot_remainders).
--
-- 25. exactly one campaign is due, scheduled, and ineligible right now:
-- 'poison' (closed business). 'due_suspended' already activated earlier in
-- this script (its business was reactivated); 'future_scheduled' is not due.
select is(
  private.campaigns_sweep_ineligible_count()::text,
  '1',
  'private.campaigns_sweep_ineligible_count reports exactly the one due-but-ineligible campaign');

-- 26. private, revoked from every role including service_role (0045's own
-- precedent for a helper only a definer function - already running as
-- owner - or a privileged test session ever needs to call directly)
select ok(
  not has_function_privilege('anon', 'private.campaigns_sweep_ineligible_count()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.campaigns_sweep_ineligible_count()', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.campaigns_sweep_ineligible_count()', 'EXECUTE'),
  'private.campaigns_sweep_ineligible_count is reachable by no client or service role');

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
