-- ============================================================================
-- rpc_loyalty_progression_smoke.sql (pgTAP)
-- Task T4.5: doc 35 section 3 step 11 ("Loyalty card update") and doc 35
-- section 9's clawback clause ("Also unwinds loyalty progress attributable to
-- the receipt (floor at 0)"), shipped by 0078_loyalty_card_progression.sql.
--
-- Requires migrations 0001-0078. Runs entirely inside one transaction and
-- rolls back. Execute as a privileged role (postgres). pgTAP lives in the
-- extensions schema.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS SUITE IS BUILT TO CATCH
-- ---------------------------------------------------------------------------
-- Every fixture id comes from its own `returning id`; nothing is looked up by
-- name (this database also holds live data).
--
-- The specific failure mode this file is shaped against is an assertion that
-- passes for a reason other than the one it names. The two structural devices:
--
--   1. EVERY "this did not happen" assertion is paired with a "and the same
--      call DID do its other work" assertion on a DIFFERENT program of the
--      same business. One receipt advances EVERY live program at once, so a
--      card that did not move because the advance never ran at all is
--      indistinguishable from a card the cap/floor correctly refused - unless
--      a sibling card is asserted to have moved on that same call. Assertions
--      6, 26 and 33 exist for exactly that.
--
--   2. Fixtures never sit on a value where two candidate implementations
--      agree. The completion fixture OVERSHOOTS (115 against a target of 100)
--      so `>=` and `==` disagree and so "keep the carryover" and "zero it"
--      disagree. The spend fixture uses 48599 centavos so floor (485), round
--      (486) and ceil (486) disagree. The min-amount fixture uses EXACTLY the
--      configured floor so `>=` and `>` disagree. The clawback unwinds two
--      cards on one call: one floors at 0 and one does not, and the unwound
--      amount (300) is not equal to the receipt's points (70), so an unwind
--      metered in the wrong currency is visible.
--
-- Manila arithmetic used throughout (UTC+8, no DST):
--   2026-09-10T02:00Z -> 2026-09-10 10:00 Manila -> day 2026-09-10
--   2026-09-10T05:00Z -> 2026-09-10 13:00 Manila -> day 2026-09-10 (SAME)
--   2026-09-10T16:00Z -> 2026-09-11 00:00 Manila -> day 2026-09-11 (NEXT
--     Manila day while still the same UTC date - the case a naive UTC
--     comparison gets wrong, and the reason the daily-cap assertions are not
--     satisfied by a cap that resets on the UTC date)
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(70);

-- ---------------------------------------------------------------- fixtures
-- Seven users: the tenant owner, a platform admin (the clawback actor), five
-- consumers each owning one concern, and one consumer who never scans
-- anything (the negative half of the cardholder-visibility policies).
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-loy-owner@example.com', '{"full_name": "Loyalty Owner"}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-loy-ca@example.com', '{"full_name": "Visit Card Holder"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-loy-cb@example.com', '{"full_name": "Daily Cap Holder"}'::jsonb),
  ('e4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-loy-cc@example.com', '{"full_name": "Points Target Holder"}'::jsonb),
  ('e5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-loy-cd@example.com', '{"full_name": "Spend Amount Holder"}'::jsonb),
  ('e6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-loy-ce@example.com', '{"full_name": "Clawback Holder"}'::jsonb),
  ('e7777777-7777-4777-8777-777777777777', 'authenticated', 'authenticated',
   'giya-loy-cz@example.com', '{"full_name": "No Cards At All"}'::jsonb),
  ('e8888888-8888-4888-8888-888888888888', 'authenticated', 'authenticated',
   'giya-loy-admin@example.com', '{"full_name": "Loyalty Suite Admin"}'::jsonb);

insert into public.platform_admins (user_id, role, is_active)
values ('e8888888-8888-4888-8888-888888888888', 'admin', true);

select set_config('test.ca', 'e2222222-2222-4222-8222-222222222222', true),
       set_config('test.cb', 'e3333333-3333-4333-8333-333333333333', true),
       set_config('test.cc', 'e4444444-4444-4444-8444-444444444444', true),
       set_config('test.cd', 'e5555555-5555-4555-8555-555555555555', true),
       set_config('test.ce', 'e6666666-6666-4666-8666-666666666666', true),
       set_config('test.cz', 'e7777777-7777-4777-8777-777777777777', true),
       set_config('test.admin', 'e8888888-8888-4888-8888-888888888888', true);

-- the owner registers the tenant; the business id comes straight back
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Stamp Cafe', 'cafe', 'cebu', '11 Carryover Street')::text),
  true);
reset role;

-- ---- nine campaigns, each with its own completion reward and its own
-- ---- loyalty_programs payload. Five of them are LIVE loyalty/membership
-- ---- programs; four exist only so a liveness or program_type filter has
-- ---- something to refuse:
--
--   pv  loyalty     active            visit_count    target 2   1/day   resets
--   pr  MEMBERSHIP  active            receipt_count  target 5   2/day   resets
--   pp  loyalty     active            points_target  target 100 5/day   resets
--   ps  loyalty     active            spend_amount   target 900 5/day   FREEZES
--                                     min_amount_per_stamp_centavos = 20000
--   pc  loyalty     active            CUSTOM         (doc 35 defines no
--                                                     increment for it)
--   px  loyalty     PAUSED            visit_count
--   pe  loyalty     active, ended     visit_count    (ends_at in the past)
--   pf  loyalty     active, future    visit_count    (starts_at in the future)
--   pn  PROMOTION   active            visit_count    (wrong campaign type)
--
-- `pr` is a `membership` campaign on purpose: it is the program every
-- multi-stamp assertion below reads, so an implementation that filtered on
-- `loyalty` alone fails assertions 6, 19, 20, 21 and 38 rather than passing
-- silently. `pv`'s reward carries claim_expiry_days = 14, deliberately NOT
-- the column's default of 30, so assertion 11 measures the reward's own
-- value rather than a hard-coded interval that happens to match.
do $$
declare
  v_biz    uuid := current_setting('test.biz')::uuid;
  v_camp   uuid;
  v_reward uuid;
  v_prog   uuid;
  r        record;
begin
  for r in
    select * from (values
      ('pv', 'loyalty',    'active', null::timestamptz, null::timestamptz,
       'visit_count',   2,   1, null::integer, true,  14),
      ('pr', 'membership', 'active', null, null,
       'receipt_count', 5,   2, null,          true,  30),
      ('pp', 'loyalty',    'active', null, null,
       'points_target', 100, 5, null,          true,  7),
      ('ps', 'loyalty',    'active', null, null,
       'spend_amount',  900, 5, 20000,         false, 30),
      ('pc', 'loyalty',    'active', null, null,
       'custom',        5,   5, null,          true,  30),
      ('px', 'loyalty',    'paused', null, null,
       'visit_count',   2,   5, null,          true,  30),
      ('pe', 'loyalty',    'active', null, '2026-09-01T00:00:00Z'::timestamptz,
       'visit_count',   2,   5, null,          true,  30),
      ('pf', 'loyalty',    'active', '2027-01-01T00:00:00Z'::timestamptz, null,
       'visit_count',   2,   5, null,          true,  30),
      ('pn', 'promotion',  'active', null, null,
       'visit_count',   2,   5, null,          true,  30)
    ) as t(key, camp_type, camp_status, starts_at, ends_at,
           program_type, target, max_day, min_amt, resets, expiry_days)
  loop
    insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
    values (v_biz, r.camp_type, r.camp_status, 'Stamp Program ' || r.key,
            r.starts_at, r.ends_at)
    returning id into v_camp;

    insert into public.rewards
      (business_id, campaign_id, name, points_cost, claim_kind, claim_expiry_days)
    values (v_biz, v_camp, 'Prize ' || r.key, 0, 'loyalty_completion', r.expiry_days)
    returning id into v_reward;

    insert into public.loyalty_programs
      (business_id, campaign_id, program_type, target_value, reward_id,
       min_amount_per_stamp_centavos, max_stamps_per_day, resets_on_completion)
    values (v_biz, v_camp, r.program_type, r.target, v_reward,
            r.min_amt, r.max_day, r.resets)
    returning id into v_prog;

    perform set_config('test.camp_' || r.key, v_camp::text,   true);
    perform set_config('test.rw_'   || r.key, v_reward::text, true);
    perform set_config('test.prog_' || r.key, v_prog::text,   true);
  end loop;
end $$;

-- ---- receipts. sha256 is globally unique (receipts_sha_unique), so every
-- ---- fixture carries a prefix that cannot collide with live rows. All are
-- ---- created up front; the awards below happen one at a time, in order,
-- ---- with assertions interleaved.
do $$
declare
  v_biz uuid := current_setting('test.biz')::uuid;
  v_id  uuid;
  r     record;
begin
  for r in
    select * from (values
      -- CA: 09-10 twice (same Manila day), then 16:00Z = 09-11 Manila,
      -- then a BACKDATED 09-09 uploaded last.
      ('ra1', current_setting('test.ca'), '2026-09-10T02:00:00Z'::timestamptz, 30000),
      ('ra2', current_setting('test.ca'), '2026-09-10T05:00:00Z'::timestamptz, 30000),
      ('ra3', current_setting('test.ca'), '2026-09-10T16:00:00Z'::timestamptz, 30000),
      ('ra4', current_setting('test.ca'), '2026-09-09T02:00:00Z'::timestamptz, 30000),
      -- CB: three on Manila 09-14, one crossing to Manila 09-15.
      ('rb1', current_setting('test.cb'), '2026-09-14T02:00:00Z'::timestamptz, 30000),
      ('rb2', current_setting('test.cb'), '2026-09-14T03:00:00Z'::timestamptz, 30000),
      ('rb3', current_setting('test.cb'), '2026-09-14T04:00:00Z'::timestamptz, 30000),
      ('rb4', current_setting('test.cb'), '2026-09-14T16:00:00Z'::timestamptz, 30000),
      -- CC: the points_target overshoot.
      ('rc1', current_setting('test.cc'), '2026-09-12T02:00:00Z'::timestamptz, 30000),
      ('rc2', current_setting('test.cc'), '2026-09-12T03:00:00Z'::timestamptz, 30000),
      -- CD: below the floor, exactly at the floor, a non-round peso amount,
      -- the completing receipt, and one more AFTER completion.
      ('rd1', current_setting('test.cd'), '2026-09-13T02:00:00Z'::timestamptz, 19999),
      ('rd2', current_setting('test.cd'), '2026-09-13T03:00:00Z'::timestamptz, 20000),
      ('rd3', current_setting('test.cd'), '2026-09-13T04:00:00Z'::timestamptz, 48599),
      ('rd4', current_setting('test.cd'), '2026-09-13T05:00:00Z'::timestamptz, 30000),
      ('rd5', current_setting('test.cd'), '2026-09-13T06:00:00Z'::timestamptz, 30000),
      -- CE: two awarded, the first clawed back, then a third on the SAME
      -- Manila day as the clawed-back one.
      ('re1', current_setting('test.ce'), '2026-09-15T02:00:00Z'::timestamptz, 30000),
      ('re2', current_setting('test.ce'), '2026-09-15T03:00:00Z'::timestamptz, 25000),
      ('re3', current_setting('test.ce'), '2026-09-15T04:00:00Z'::timestamptz, 30000)
    ) as t(tag, usr, dt, total)
  loop
    insert into public.receipts
      (business_id, user_id, status, image_path, image_hash, sha256,
       receipt_date, total_centavos)
    values (v_biz, r.usr::uuid, 'approved',
            r.usr || '/loy-' || r.tag || '.jpg',
            'loyhash' || r.tag,
            'giya-loyalty-smoke-sha-' || r.tag,
            r.dt, r.total)
    returning id into v_id;
    perform set_config('test.' || r.tag, v_id::text, true);
  end loop;
end $$;

-- ============================================================================
-- A. The schema consolidation (0078 part 1)
--
-- 0066 ran `create table if not exists` on a table 0012 had already created,
-- so its create was a no-op and its `add column if not exists` lines bolted a
-- SECOND identity (`user_id`) and a SECOND progress model onto the same table.
-- The shipped UI read that second set; doc 35's step 11 writes the first. Both
-- tables were empty when 0078 landed, so it drops the 0066 half outright -
-- two identity columns on a money-path table is how the next writer picks the
-- wrong one.
-- ============================================================================

-- 1
select is(
  (select count(*)::integer from information_schema.columns
    where table_schema = 'public' and table_name = 'loyalty_cards'
      and column_name in ('user_id', 'stamps_count', 'stamps_target',
                          'prize_reward_name', 'is_completed', 'completed_at')),
  0,
  'the six 0066 columns are gone from loyalty_cards');

-- 2
select is(
  (select count(*)::integer from information_schema.columns
    where table_schema = 'public' and table_name = 'loyalty_cards'
      and column_name in ('consumer_id', 'program_id', 'progress',
                          'completed_count', 'last_stamp_at')),
  5,
  'the five doc 35 / 0012 columns are the ones that survive');

-- ============================================================================
-- B. CA - visit_count arithmetic, the per-Manila-day cap, the day boundary,
--    completion, and the four liveness / program-type refusals.
-- ============================================================================

select public.award_receipt_points(current_setting('test.ra1')::uuid, 10);

-- 3
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  1,
  'visit_count: the first qualifying receipt creates the card at progress 1');

-- 4
select is(
  (select lc.completed_count from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  0,
  'visit_count: one stamp short of a target of 2 completes nothing');

select public.award_receipt_points(current_setting('test.ra2')::uuid, 10);

-- 5. Same Manila day as ra1, and pv allows 1 stamp per day.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  1,
  'max_stamps_per_day=1 refuses a second stamp on the same Manila day');

-- 6. THE PAIR FOR 5. `pr` allows 2 per day and is on the same business, so
-- this proves ra2's advance actually ran - without it, assertion 5 is equally
-- satisfied by an award path that never called the progression at all.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pr')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  2,
  'the same call that the 1/day cap refused still stamped the 2/day program');

select public.award_receipt_points(current_setting('test.ra3')::uuid, 10);

-- 7. ra3 is 2026-09-10T16:00Z: the SAME UTC date as ra1/ra2 and the NEXT
-- Manila day. The cap must therefore be clear again, taking pv to 2 = target,
-- completing, and (resets_on_completion) leaving 2 - 2 = 0.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  0,
  'the daily cap resets on the MANILA day boundary, not the UTC one, and the '
  'stamp it allows completes the card back to 0');

-- 8
select is(
  (select lc.completed_count from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  1,
  'completion increments completed_count exactly once');

-- 9
select is(
  (select count(*)::integer from public.reward_claims rc
    where rc.consumer_id = current_setting('test.ca')::uuid
      and rc.reward_id   = current_setting('test.rw_pv')::uuid),
  1,
  'completion creates exactly one reward_claims row for the program reward');

-- 10
select results_eq(
  format($$select rc.status, rc.points_spent from public.reward_claims rc
            where rc.consumer_id = %L::uuid and rc.reward_id = %L::uuid$$,
         current_setting('test.ca'), current_setting('test.rw_pv')),
  $$values ('claimed'::text, 0)$$,
  'the completion claim is claimed with points_spent = 0');

-- 11. rw_pv carries claim_expiry_days = 14, NOT the column default of 30, so
-- an implementation using a hard-coded 30-day interval lands outside this
-- window.
select ok(
  (select rc.expires_at > now() + interval '13 days'
            and rc.expires_at < now() + interval '15 days'
     from public.reward_claims rc
    where rc.consumer_id = current_setting('test.ca')::uuid
      and rc.reward_id   = current_setting('test.rw_pv')::uuid),
  'the completion claim expires per the reward''s own claim_expiry_days (14)');

-- 12. points_cost is 0, and 0012's points_transactions carries
-- `check (points <> 0)`: a zero-cost claim writes NO ledger row.
select is(
  (select count(*)::integer from public.points_transactions pt
    where pt.consumer_id = current_setting('test.ca')::uuid
      and pt.type = 'redeem'),
  0,
  'a zero-cost completion claim writes no redeem ledger row');

-- 13
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.consumer_id = current_setting('test.ca')::uuid),
  4,
  'three receipts produced exactly four cards - one per LIVE, non-custom program');

-- 14
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.consumer_id = current_setting('test.ca')::uuid
      and lc.program_id in (current_setting('test.prog_px')::uuid,
                            current_setting('test.prog_pe')::uuid,
                            current_setting('test.prog_pf')::uuid)),
  0,
  'a paused campaign, one past its ends_at and one before its starts_at all '
  'stamp nothing');

-- 15
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.consumer_id = current_setting('test.ca')::uuid
      and lc.program_id  = current_setting('test.prog_pc')::uuid),
  0,
  'program_type = custom has no ratified increment and stamps nothing');

-- 16
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.consumer_id = current_setting('test.ca')::uuid
      and lc.program_id  = current_setting('test.prog_pn')::uuid),
  0,
  'a loyalty_programs row hanging off a PROMOTION campaign stamps nothing');

-- ============================================================================
-- C. The backdated upload. ra4's receipt_date is 2026-09-09 - an earlier
--    Manila day than every receipt already processed - and it is awarded
--    LAST. Its own day has no stamps, so it must stamp; and last_stamp_at,
--    which means "the most recent stamp", must not travel backwards.
-- ============================================================================

select public.award_receipt_points(current_setting('test.ra4')::uuid, 10);

-- 17
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  1,
  'a backdated receipt is metered on ITS OWN Manila day, so it still stamps');

-- 18
select is(
  (select lc.last_stamp_at from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ca')::uuid),
  '2026-09-10T16:00:00Z'::timestamptz,
  'last_stamp_at stays at the LATEST stamped event, not the last processed one');

-- ============================================================================
-- D. CB - max_stamps_per_day above 1, and its reset on the Manila boundary.
--    `pr` allows 2 per day; three receipts land on Manila 09-14.
-- ============================================================================

select public.award_receipt_points(current_setting('test.rb1')::uuid, 5);
select public.award_receipt_points(current_setting('test.rb2')::uuid, 5);
select public.award_receipt_points(current_setting('test.rb3')::uuid, 5);

-- 19
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pr')::uuid
      and lc.consumer_id = current_setting('test.cb')::uuid),
  2,
  'max_stamps_per_day=2 admits two stamps in a Manila day and refuses the third');

-- 20
select is(
  (select count(*)::integer
     from public.loyalty_stamps ls
     join public.loyalty_cards lc on lc.id = ls.card_id
    where lc.program_id  = current_setting('test.prog_pr')::uuid
      and lc.consumer_id = current_setting('test.cb')::uuid
      and private.manila_day(ls.event_ts) = date '2026-09-14'),
  2,
  'and the stamp ledger records exactly two events for that Manila day');

select public.award_receipt_points(current_setting('test.rb4')::uuid, 5);

-- 21. rb4 is 2026-09-14T16:00Z - still the 14th in UTC, the 15th in Manila.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pr')::uuid
      and lc.consumer_id = current_setting('test.cb')::uuid),
  3,
  'the 2/day budget refills on the Manila day boundary, not the UTC one');

-- ============================================================================
-- E. CC - points_target arithmetic, the >= comparison, and carryover.
--    40 then 75 = 115 against a target of 100.
-- ============================================================================

select public.award_receipt_points(current_setting('test.rc1')::uuid, 40);
select public.award_receipt_points(current_setting('test.rc2')::uuid, 75);

-- 22. 115 - 100 = 15. `== target_value` never fires here; zeroing the card
-- gives 0; freezing gives 100; incrementing by 1 per receipt gives 2.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pp')::uuid
      and lc.consumer_id = current_setting('test.cc')::uuid),
  15,
  'points_target adds the WHOLE receipt total, completes on >= target, and '
  'resets_on_completion keeps the 15-point carryover');

-- 23
select is(
  (select lc.completed_count from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pp')::uuid
      and lc.consumer_id = current_setting('test.cc')::uuid),
  1,
  'an overshooting receipt completes the card exactly once');

-- 24
select is(
  (select count(*)::integer from public.reward_claims rc
    where rc.consumer_id = current_setting('test.cc')::uuid
      and rc.reward_id   = current_setting('test.rw_pp')::uuid),
  1,
  'and issues exactly one completion claim');

-- ============================================================================
-- F. CD - the min_amount_per_stamp_centavos floor, spend_amount's peso
--    arithmetic, the FREEZE branch of resets_on_completion, and the stop that
--    keeps a frozen card from re-issuing its prize forever.
-- ============================================================================

select public.award_receipt_points(current_setting('test.rd1')::uuid, 3);

-- 25. rd1 is 19999 centavos against a floor of 20000.
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid),
  0,
  'a receipt one centavo below min_amount_per_stamp_centavos does not stamp');

-- 26. THE PAIR FOR 25: `pv` has no floor, so rd1's advance demonstrably ran.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid),
  1,
  'the same sub-floor receipt still stamped the program that sets no floor');

select public.award_receipt_points(current_setting('test.rd2')::uuid, 3);

-- 27. rd2 is EXACTLY the floor, so `>=` stamps and `>` would not. 20000
-- centavos = 200 pesos.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid),
  200,
  'a receipt EXACTLY at the floor qualifies, and spend_amount adds pesos');

select public.award_receipt_points(current_setting('test.rd3')::uuid, 3);

-- 28. 48599 centavos: floor -> 485, round -> 486, ceil -> 486.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid),
  685,
  'spend_amount FLOORS centavos to pesos (485, not 486)');

select public.award_receipt_points(current_setting('test.rd4')::uuid, 3);

-- 29. 685 + 300 = 985 against a target of 900, resets_on_completion = false.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid),
  900,
  'resets_on_completion=false FREEZES progress at target (not 985, not 85)');

-- 30
select is(
  (select lc.completed_count from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid),
  1,
  'the frozen card completed once');

select public.award_receipt_points(current_setting('test.rd5')::uuid, 3);

-- 31. rd5 is the fifth receipt of a Manila day on a program that allows FIVE
-- stamps a day and only used three, so the daily cap is not what stops it:
-- a finished non-resetting card is.
select results_eq(
  format($$select lc.progress, lc.completed_count from public.loyalty_cards lc
            where lc.program_id = %L::uuid and lc.consumer_id = %L::uuid$$,
         current_setting('test.prog_ps'), current_setting('test.cd')),
  $$values (900, 1)$$,
  'a finished non-resetting card takes no further stamps and completes no '
  'second time');

-- 32
select is(
  (select count(*)::integer from public.reward_claims rc
    where rc.consumer_id = current_setting('test.cd')::uuid
      and rc.reward_id   = current_setting('test.rw_ps')::uuid),
  1,
  'and never issues a second free prize');

-- 33. THE PAIR FOR 31: rd5 did advance other programs, so 31 is not satisfied
-- by an award that skipped the progression entirely.
select is(
  (select count(*)::integer
     from public.loyalty_stamps ls
     join public.loyalty_cards lc on lc.id = ls.card_id
    where lc.program_id  = current_setting('test.prog_pp')::uuid
      and lc.consumer_id = current_setting('test.cd')::uuid
      and ls.receipt_id  = current_setting('test.rd5')::uuid),
  1,
  'the same receipt the frozen card refused still stamped the points program');

-- ============================================================================
-- G. CE - the clawback unwind. doc 35 section 9: "Also unwinds loyalty
--    progress attributable to the receipt (floor at 0)."
--
--    One clawback call unwinds four cards. Two of them are asserted:
--      pp - progress 15, this receipt contributed 70 -> FLOORS at 0
--      ps - progress 550, this receipt contributed 300 -> 250, no floor
--    The receipt's POINTS are 70 and its spend contribution is 300, so an
--    unwind metered in the wrong currency lands on neither number.
-- ============================================================================

select public.award_receipt_points(current_setting('test.re1')::uuid, 70);
select public.award_receipt_points(current_setting('test.re2')::uuid, 45);

-- 34
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pp')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  15,
  'pre-clawback: the points card sits at 15 (70 + 45, completed, reset)');

-- 35
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  550,
  'pre-clawback: the spend card sits at 550 (300 + 250)');

select public.clawback_receipt_points(
  current_setting('test.re1')::uuid,
  current_setting('test.admin')::uuid,
  'confirmed receipt forgery');

-- 36. 15 - 70 = -55. Without the floor this call would raise on
-- loyalty_cards_progress_check rather than land a negative row, so a green
-- assertion here is proof the floor is doing the work.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pp')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  0,
  'clawback floors the unwound progress at 0, never negative');

-- 37
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_ps')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  250,
  'clawback subtracts exactly what THIS receipt contributed to THIS card '
  '(300 pesos, not the receipt''s 70 points and not the whole card)');

-- 38
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pr')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  1,
  'and one receipt_count stamp, leaving the other receipt''s stamp standing');

-- 39
select is(
  (select count(*)::integer from public.loyalty_stamps ls
    where ls.receipt_id = current_setting('test.re1')::uuid
      and ls.reversed_at is not null),
  4,
  'every stamp the clawed-back receipt wrote is marked reversed');

-- 40. Scope: the neighbouring receipt's stamps are untouched.
select is(
  (select count(*)::integer from public.loyalty_stamps ls
    where ls.receipt_id = current_setting('test.re2')::uuid
      and ls.reversed_at is null),
  3,
  'and no stamp belonging to a different receipt is reversed');

-- 41. Stated, not accidental: the prize may already be in the consumer's
-- hands (or redeemed at a counter), so doc 35's clause - which names PROGRESS
-- only - is implemented as progress only.
select is(
  (select lc.completed_count from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pp')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  1,
  'the completion itself is NOT unwound: completed_count stands');

-- 42
select is(
  (select al.after->>'loyalty_stamps_unwound' from public.audit_logs al
    where al.entity_id = current_setting('test.re1')::uuid
      and al.action    = 'fraud.clawback_applied'),
  '4',
  'the clawback audit row records how many stamps it unwound');

-- ============================================================================
-- H. A reversed stamp releases the day slot it occupied. Same posture as
--    0039's fixed_per_visit exclusion: a clawed-back earn never actually paid,
--    so a clawed-back stamp never actually stamped.
-- ============================================================================

select public.award_receipt_points(current_setting('test.re3')::uuid, 5);

-- 43. re3 is on Manila 09-15, the same day as the clawed-back re1, on a
-- program that allows ONE stamp per day. re1's stamp is reversed, so the slot
-- is free.
select is(
  (select lc.progress from public.loyalty_cards lc
    where lc.program_id  = current_setting('test.prog_pv')::uuid
      and lc.consumer_id = current_setting('test.ce')::uuid),
  1,
  'a reversed stamp stops counting against max_stamps_per_day for its day');

-- ============================================================================
-- I. Row-level security. `pv`'s campaign is paused and its reward deactivated
--    FIRST, so the two cardholder policies are the only thing that can still
--    return those rows to the consumer holding the card - the public policies
--    (campaign active / reward is_active) are both false by then.
-- ============================================================================

update public.campaigns set status = 'paused'
 where id = current_setting('test.camp_pv')::uuid;
update public.rewards set is_active = false
 where id = current_setting('test.rw_pv')::uuid;

select set_config('request.jwt.claims',
  format('{"sub": "%s", "role": "authenticated"}', current_setting('test.ca')), true);
set local role authenticated;

-- 44. CA's own stamps: ra1 wrote 4 (pv/pr/pp/ps), ra2 wrote 3 (pv capped),
-- ra3 wrote 4, ra4 wrote 3 (ps was frozen by then). 4 + 3 + 4 + 3 = 14.
select is(
  (select count(*)::integer from public.loyalty_stamps ls
    where ls.consumer_id = current_setting('test.ca')::uuid),
  14,
  'a consumer reads their own stamp ledger');

-- 45
select is(
  (select count(*)::integer from public.loyalty_stamps ls
    where ls.consumer_id = current_setting('test.ce')::uuid),
  0,
  'and none of another consumer''s stamps');

-- 46
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.consumer_id = current_setting('test.ca')::uuid),
  4,
  'a consumer reads their own cards through consumer_id (0066''s user_id '
  'policy is gone with the column)');

-- 47
select is(
  (select count(*)::integer from public.loyalty_cards lc
    where lc.consumer_id = current_setting('test.ce')::uuid),
  0,
  'and none of another consumer''s cards');

-- 48
select is(
  (select count(*)::integer from public.loyalty_programs lp
    where lp.id = current_setting('test.prog_pv')::uuid),
  1,
  'a cardholder still reads the program behind their card after the campaign '
  'is paused');

-- 49
select is(
  (select count(*)::integer from public.rewards r
    where r.id = current_setting('test.rw_pv')::uuid),
  1,
  'and still reads the prize behind it after the reward is deactivated');

-- 50
select throws_ok(
  format($$update public.loyalty_cards set progress = 999 where consumer_id = %L::uuid$$,
         current_setting('test.ca')),
  '42501',
  null,
  'a consumer cannot write their own card');

-- 51
select throws_ok(
  format($$insert into public.loyalty_stamps
             (business_id, card_id, program_id, consumer_id, receipt_id, delta, event_ts)
           values (%L::uuid, %L::uuid, %L::uuid, %L::uuid, %L::uuid, 99, now())$$,
         current_setting('test.biz'),
         (select lc.id from public.loyalty_cards lc
           where lc.program_id = current_setting('test.prog_pv')::uuid
             and lc.consumer_id = current_setting('test.ca')::uuid),
         current_setting('test.prog_pv'),
         current_setting('test.ca'),
         current_setting('test.ra1')),
  '42501',
  null,
  'and cannot forge a stamp');

reset role;

select set_config('request.jwt.claims',
  format('{"sub": "%s", "role": "authenticated"}', current_setting('test.cz')), true);
set local role authenticated;

-- 52. The negative half of 48: a consumer holding no card sees neither.
select is(
  (select count(*)::integer from public.loyalty_programs lp
    where lp.id = current_setting('test.prog_pv')::uuid),
  0,
  'a consumer with no card does NOT see the paused campaign''s program');

-- 53. The negative half of 49.
select is(
  (select count(*)::integer from public.rewards r
    where r.id = current_setting('test.rw_pv')::uuid),
  0,
  'and does not see the deactivated prize');

reset role;

-- ============================================================================
-- J. Shape constraints on the stamp ledger.
-- ============================================================================

-- 54. (card_id, receipt_id) is unique, so this pair is deliberately one that
-- does NOT already exist - CB's points card and one of CA's receipts - so the
-- 23514 measured here is the delta check and not a unique violation arriving
-- first.
select throws_ok(
  format($$insert into public.loyalty_stamps
             (business_id, card_id, program_id, consumer_id, receipt_id, delta, event_ts)
           values (%L::uuid, %L::uuid, %L::uuid, %L::uuid, %L::uuid, -1, now())$$,
         current_setting('test.biz'),
         (select lc.id from public.loyalty_cards lc
           where lc.program_id = current_setting('test.prog_pp')::uuid
             and lc.consumer_id = current_setting('test.cb')::uuid),
         current_setting('test.prog_pp'),
         current_setting('test.cb'),
         current_setting('test.ra1')),
  '23514',
  null,
  'a stamp can never carry a negative delta - a reversal sets reversed_at, it '
  'does not write a negative row');

-- ============================================================================
-- K. The grant matrix. Per-role and independent: Supabase grants EXECUTE on
--    new public-schema functions to service_role via PROJECT-LEVEL DEFAULT
--    PRIVILEGES at CREATE time, entirely separately from whatever the
--    migration revokes from public/anon, so "has SOME assertion" is not the
--    property that matters.
-- ============================================================================

-- 55
select ok(
  not has_function_privilege('anon',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)', 'EXECUTE'),
  'anon cannot execute award_receipt_points');

-- 56
select ok(
  not has_function_privilege('authenticated',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)', 'EXECUTE'),
  'authenticated cannot execute award_receipt_points');

-- 57
select ok(
  has_function_privilege('service_role',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)', 'EXECUTE'),
  'service_role can execute award_receipt_points');

-- 58
select ok(
  not has_function_privilege('anon',
    'public.clawback_receipt_points(uuid, uuid, text, text)', 'EXECUTE'),
  'anon cannot execute clawback_receipt_points');

-- 59
select ok(
  not has_function_privilege('authenticated',
    'public.clawback_receipt_points(uuid, uuid, text, text)', 'EXECUTE'),
  'authenticated cannot execute clawback_receipt_points');

-- 60
select ok(
  has_function_privilege('service_role',
    'public.clawback_receipt_points(uuid, uuid, text, text)', 'EXECUTE'),
  'service_role can execute clawback_receipt_points');

-- 61
select ok(
  not has_function_privilege('anon', 'public.claim_reward(uuid)', 'EXECUTE'),
  'anon cannot execute claim_reward');

-- 62
select ok(
  has_function_privilege('authenticated', 'public.claim_reward(uuid)', 'EXECUTE'),
  'authenticated can still execute claim_reward after 0078 re-creates it');

-- 63. 0052's hygiene sweep revoked this and a create-or-replace must not
-- silently hand it back.
select ok(
  not has_function_privilege('service_role', 'public.claim_reward(uuid)', 'EXECUTE'),
  'service_role still cannot execute claim_reward');

-- 64
select ok(
  not has_function_privilege('anon',
    'private.advance_loyalty_cards(uuid, uuid, uuid, timestamptz, integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'private.advance_loyalty_cards(uuid, uuid, uuid, timestamptz, integer, integer)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'private.advance_loyalty_cards(uuid, uuid, uuid, timestamptz, integer, integer)', 'EXECUTE'),
  'private.advance_loyalty_cards is reachable by no client or service role');

-- 65
select ok(
  not has_function_privilege('anon',
    'private.unwind_loyalty_stamps(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'private.unwind_loyalty_stamps(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'private.unwind_loyalty_stamps(uuid)', 'EXECUTE'),
  'private.unwind_loyalty_stamps is reachable by no client or service role');

-- 66
select ok(
  not has_function_privilege('anon',
    'private.write_reward_claim(uuid, uuid, uuid, integer, integer, integer, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'private.write_reward_claim(uuid, uuid, uuid, integer, integer, integer, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'private.write_reward_claim(uuid, uuid, uuid, integer, integer, integer, uuid, uuid)', 'EXECUTE'),
  'private.write_reward_claim is reachable by no client or service role');

-- 67
select ok(
  has_function_privilege('authenticated',
    'private.holds_loyalty_card_for_program(uuid)', 'EXECUTE'),
  'authenticated can execute holds_loyalty_card_for_program (its policy needs it)');

-- 68
select ok(
  not has_function_privilege('anon',
    'private.holds_loyalty_card_for_program(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'private.holds_loyalty_card_for_program(uuid)', 'EXECUTE'),
  'and no one else can');

-- 69
select ok(
  has_function_privilege('authenticated',
    'private.holds_loyalty_card_for_reward(uuid)', 'EXECUTE'),
  'authenticated can execute holds_loyalty_card_for_reward (its policy needs it)');

-- 70
select ok(
  not has_function_privilege('anon',
    'private.holds_loyalty_card_for_reward(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'private.holds_loyalty_card_for_reward(uuid)', 'EXECUTE'),
  'and no one else can');

select * from finish();

rollback;
