-- ============================================================================
-- 0031_admin_access.sql
-- The admin half of the schema, deferred twice and now landable.
--
-- 0017 and 0022 both stop at the same sentence: "Every admin predicate in doc
-- 12 reads the platform-admin claim out of the JWT, and this project's custom
-- access token hook is NOT enabled, so a claim-based admin policy would
-- evaluate to null for every session and silently deny - a policy that looks
-- like coverage and is not." Both files therefore shipped staff-only and named
-- this migration as the follow-up.
--
-- The hook is enabled now, verified by a real sign-in round trip: the issued
-- JWT carries app_metadata.biz for a staff member, and private.is_admin()
-- reads app_metadata.is_platform_admin out of the same object. The deployed
-- private.custom_access_token_hook (pg_get_functiondef, checked against 0003
-- before this file was written) stamps BOTH halves - the biz map from
-- business_staff AND is_platform_admin/admin_role from platform_admins - so no
-- extension of the hook is needed here and none is made. What was missing was
-- never the claim; it was the policies that read it, and a platform_admins row
-- for anybody at all.
--
-- Contents:
--   1. The owner's platform_admins row (the table is empty, so without this
--      every policy below is correct and matches zero rows forever).
--   2. The admin SELECT policies 0017 and 0022 deferred, one per table, each
--      quoting the doc line it satisfies.
--   3. public.clawback_receipt_points - doc 37 consequences ladder step 5, the
--      one ladder action that writes the ledger, as a SECURITY DEFINER RPC in
--      the 0013/0016/0018 family.
--
-- Source docs: docs/30-modules/31-admin-portal.md (route inventory, the
-- reason-required pattern, section 5 the receipt/fraud queues), docs/30-modules/
-- 37-fraud-detection.md (evidence contract, consequences ladder, the reviewer
-- action -> audit mapping), docs/30-modules/35-points-engine.md section 9 (clawback
-- mechanics, clamping, residual-debt policy), docs/20-data/24-schema-receipts-ai.md
-- (line 105 "RLS: admin + staff-own-tenant read"), docs/20-data/25-schema-platform.md
-- (audit_logs "RLS: select admin", settings "platform rows admin-only"),
-- docs/10-architecture/12-multi-tenancy-rls.md (P4, private.is_admin()),
-- docs/10-architecture/15-security.md (admin actions on tenant data always
-- require a recorded reason).
--
-- Conventions, unchanged from this schema's neighbours: no PG enums, every
-- reference schema-qualified inside functions, set search_path = '', stable
-- P0001 message strings the service layer maps to copy, revoke/grant pairing at
-- the bottom of every function.
-- ============================================================================

-- ============================================================ 1. the seed
-- platform_admins is EMPTY. Every policy below is gated on
-- private.is_admin(), which reads a claim the hook only stamps for a user who
-- has a row here, so with no rows this whole migration is a no-op and the
-- portal it unlocks cannot be opened by anyone - including by the person who
-- would have to add the first row.
--
-- The owner (rarochristian029@gmail.com) is seeded as super_admin: doc 31 section 4.1
-- makes super_admin the only role that can manage platform_admins, so the
-- bootstrap row has to be one or the chain never starts.
--
-- Written as insert-select over profiles rather than as a bare values row, so
-- it is a no-op rather than a 23503 on any database where that profile does
-- not exist (a fresh local stack, a future branch database). on conflict do
-- nothing makes a replay harmless and, more importantly, means this migration
-- can never DEMOTE a role that was changed later through the admin surface.
insert into public.platform_admins (user_id, role, is_active)
select p.id, 'super_admin', true
  from public.profiles p
 where p.id = '83953765-92fc-4289-95af-803d08b8c2a9'
on conflict (user_id) do nothing;

-- ============================================================ 2. admin policies
--
-- ONE NOTE THAT APPLIES TO EVERY POLICY BELOW, stated once here rather than
-- six times: an admin is the `authenticated` database role, exactly like a
-- consumer and exactly like a business owner. A policy grants ROWS; it cannot
-- grant COLUMNS, because column privileges are role-wide (0017 spends four
-- paragraphs on this and 0022 repeats it). So on the two tables that revoked
-- their table-level SELECT and re-granted a column list - receipts and
-- audit_logs - these policies widen which rows an admin sees and change
-- nothing about which columns. `parse_meta`, both confidences, `reject_note`,
-- `sha256` and `image_hash` on receipts, and `ip`/`user_agent` on audit_logs,
-- stay outside the grant for every client audience including this one.
--
-- That is not a gap this migration is working around; it is the same
-- conclusion 0017 reached for staff, and the admin portal reaches it the same
-- way: the review surfaces read through the service role with the tenancy (or,
-- here, the admin) predicate applied in code, and these policies are what make
-- the DIRECT client reads - the ones a future admin API route or a client-side
-- lookup would make - correct rather than silently empty.
--
-- private.is_admin() is `stable` and claim-based, so it is inlined by the
-- planner and costs one jsonb lookup per query, not per row (doc 12: "stable +
-- claim-based means the planner can inline these"). It is deliberately NOT
-- table-truth: doc 12 fixes claims as the RLS-layer authorization hint and
-- reserves table verification for the destructive-permission checks the
-- SERVICE layer makes. src/features/admin/access.ts is that server-side table
-- check, and it is what gates the portal itself.

-- ------------------------------------------------------------ receipts
-- doc 24 line 105 and doc 31 section 5: the admin receipt queue is platform-wide.
--
-- The row this policy exists for is the one 0017 warned about by name: "an
-- unmatched receipt (business_id null) is invisible to every tenant, and there
-- is no admin policy to catch it either". There is now. The pipeline is still
-- required to write a best-guess business_id before routing to review (that
-- warning stands and nothing here relaxes it), but a receipt that ends up
-- tenant-less for any reason is no longer a row that no audience on this
-- database can select.
create policy receipts_admin_select on public.receipts
  for select to authenticated
  using (private.is_admin());

-- ------------------------------------------------------------ receipt_line_items
-- The parsed split behind an admin receipt decision. Same audience, same
-- reason; a decision screen that shows the total but not the items it is
-- supposed to add up to is not evidence.
create policy rli_admin_select on public.receipt_line_items
  for select to authenticated
  using (private.is_admin());

-- ------------------------------------------------------------ ocr_results
-- doc 31 section 8's OCR monitoring and the raw text behind a fraud call. Never
-- consumer-readable and that is unchanged: this adds an audience, it does not
-- widen the existing one.
create policy ocr_results_admin_select on public.ocr_results
  for select to authenticated
  using (private.is_admin());

-- ------------------------------------------------------------ fraud_signals
-- doc 24 line 105 ("admin + staff-own-tenant read") completed. This is THE
-- policy of this migration: doc 37's admin fraud queue is platform-wide by
-- construction - a duplicate ring spans consumers and tenants, so a query that
-- can only see one tenant's signals cannot see a ring at all - and the staff
-- policy 0017 shipped is scoped to `business_id`, which is precisely the
-- column a cross-tenant pattern is not constant in.
create policy fraud_signals_admin_select on public.fraud_signals
  for select to authenticated
  using (private.is_admin());

-- ------------------------------------------------------------ ai_usage_events
-- doc 31 section 8's AI cost monitoring ("top spenders vs budget caps"), which is a
-- comparison ACROSS tenants and therefore unanswerable from the staff policy.
create policy ai_usage_events_admin_select on public.ai_usage_events
  for select to authenticated
  using (private.is_admin());

-- ------------------------------------------------------------ settings
-- doc 25: "platform rows admin-only". 0017 gave the platform scope no client
-- policy at all and said why in eighteen lines: those rows are the fraud
-- rulebook, and a `scope = 'platform'` predicate would publish the velocity
-- caps, the pHash bands and the composite threshold to every signed-in
-- consumer. That argument is about the AUDIENCE, not about the scope
-- predicate: is_admin() names the one audience doc 25 assigns the rows to, and
-- 0017's closing instruction (never re-introduce a bare scope predicate) is
-- honoured - `scope = 'platform'` appears here only as a narrowing beside the
-- admin test, never as the test itself.
--
-- Still no write policy for anyone. Threshold tuning is an audited admin
-- service-role write when doc 31 section 7's settings screen lands; a policy that let
-- the client role write these rows would let anyone who ever holds an admin
-- claim turn fraud detection off without leaving an audit row.
create policy settings_admin_select on public.settings
  for select to authenticated
  using (scope = 'platform' and private.is_admin());

-- ------------------------------------------------------------ audit_logs
-- doc 25: "RLS: select admin; select owner where business_id matches". 0022
-- shipped the owner half and left an `-- amendment:` block explaining that the
-- admin half could not be written yet. This is that half.
--
-- The rows this unlocks are exactly the ones 0022 identified as reachable by
-- nobody: "a platform-level row (business_id null) is visible to NO tenant ...
-- those rows are admin and system actions (suspensions, feature-flag flips,
-- cross-tenant fraud decisions) and doc 25 assigns them to the admin audience,
-- which this file cannot serve". Every consequence-ladder action in this slice
-- writes one of those rows, so without this policy the admin portal would be
-- writing an audit trail that only the service role could ever read back.
--
-- SELECT only, emphatically. The table is append-only at three layers
-- (privilege revoke, row trigger, statement trigger) and nothing here touches
-- any of them: an admin who can read the record of their own actions is
-- oversight, and an admin who can edit it is the threat doc 15 lists as item 6.
create policy audit_logs_admin_select on public.audit_logs
  for select to authenticated
  using (private.is_admin());

-- ============================================================ 3. clawback
-- doc 37 consequences ladder step 5, doc 35 section 9 "Fraud clawback".
--
-- WHY THIS IS AN RPC AND NOT TYPESCRIPT. Three writes have to agree or the
-- ledger is wrong: the compensating points_transactions row (whose
-- balance_after must be computed under the same per-pair lock every other
-- ledger writer takes), the business_customers cache that mirrors it, and the
-- receipt's own status. doc 35 principle 1 makes the ledger append-only and
-- principle 5 makes `balance_after >= 0` a database check, so a clamped
-- clawback computed in application code between two round trips is a race
-- against every concurrent redeem on the same pair. 0013, 0016 and 0018 all
-- settled this the same way and this function is deliberately unoriginal.
--
-- WHAT IT DELIBERATELY DOES NOT DO, so the omissions are decisions and not
-- oversights:
--   * no rule math, exactly as 0018 - the amount clawed back is derived from
--     the ORIGINAL earn row, never recomputed. Recomputation is the bug that
--     lets a rules change turn a clawback into a partial refund.
--   * no loyalty-card unwind (doc 35 section 9 "unwinds loyalty progress"). There is
--     no loyalty_cards table yet; 0018 skipped card advancement for the same
--     reason and named the addition as additive.
--   * no negative campaign attribution for analytics (doc 35 section 9's last clause).
--     analytics_daily_business does not exist yet either.
--   * no notification. doc 37 step 5 does not register one, and doc 33's
--     consumer copy matrix is explicitly out of scope for the admin slice.
--
-- LOCK ORDER, against the three existing ledger writers:
--   claim_reward   (0013): business_customers -> campaigns -> rewards
--   expire_claims  (0016): reward_claims -> business_customers -> rewards
--   award_receipt_points (0018): receipts -> business_customers
--   this function:               receipts -> business_customers
-- Identical to 0018's, which is the point: a clawback and an award of the SAME
-- receipt serialize on the receipt row, so a clawback can never interleave
-- with the award it is reversing and read a balance that is about to change.
create or replace function public.clawback_receipt_points(
  p_receipt_id uuid,
  p_actor_id   uuid,
  p_reason     text,
  p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt      record;
  v_earn         record;
  v_balance      integer;
  v_clawed       integer;
  v_shortfall    integer;
  v_txn_id       uuid;
  v_reason       text;
  v_admin_role   text;
begin
  -- Step 1: inputs. The reason is checked FIRST and separately, before
  -- anything is read, because doc 15 states it twice as a security control and
  -- doc 31 section 11 makes it the pattern for "any write touching tenant/user data".
  -- audit_logs_admin_reason_required would catch a blank one at the very end of
  -- this function anyway; catching it here means the caller gets
  -- CLAWBACK_REASON_REQUIRED instead of a 23514 raised after the ledger row was
  -- already written and rolled back.
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_REASON_REQUIRED';
  end if;
  if p_receipt_id is null or p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_INPUT_INVALID';
  end if;

  -- Step 2: the actor is an ACTIVE platform admin, by TABLE TRUTH.
  --
  -- This function is SECURITY DEFINER and granted to service_role only, so the
  -- claim that gates the policies above is not available and would be the
  -- wrong thing to trust here anyway: doc 12 fixes claims as RLS hints that
  -- refresh at most hourly, and requires that "destructive-permission checks
  -- (staff removal, suspension) also verify against the table server-side".
  -- Clawing back points is the most destructive action in this slice, and an
  -- admin deactivated ten minutes ago still holds a valid claim.
  select pa.role into v_admin_role
    from public.platform_admins pa
   where pa.user_id = p_actor_id and pa.is_active = true;
  if v_admin_role is null or v_admin_role = 'support' then
    -- doc 01's matrix: `support` is read-only everywhere and never mutates.
    raise exception using errcode = 'P0001', message = 'CLAWBACK_FORBIDDEN';
  end if;

  -- Step 3: load and lock the receipt (0018's step 2, same reason - it
  -- serializes a concurrent award or a concurrent second clawback here rather
  -- than letting them race further down).
  select r.id, r.business_id, r.user_id, r.status, r.total_centavos
    into v_receipt
    from public.receipts r
   where r.id = p_receipt_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'RECEIPT_NOT_FOUND';
  end if;

  -- Step 4: the earn row this reverses. doc 37 registers CLAWBACK_INVALID_STATE
  -- for exactly two conditions and this is the first: "No earn row for the
  -- receipt". A receipt that was never awarded has nothing to claw back, and
  -- the correct action on it is an ordinary review rejection.
  select pt.id, pt.points, pt.business_id, pt.consumer_id
    into v_earn
    from public.points_transactions pt
   where pt.receipt_id = p_receipt_id
     and pt.type = 'earn';
  if not found then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_INVALID_STATE';
  end if;

  -- Step 5: the second condition - "or already reversed". pt_receipt_earn_once
  -- guarantees at most one earn per receipt, so at most one row may point at
  -- it; doc 35 section 9 states the idempotency requirement as "at most one
  -- clawback/reversal per reverses_id (service check inside the pair lock)".
  -- The check is here rather than after the pair lock because the RECEIPT lock
  -- taken in step 3 already serializes every caller reaching this line for this
  -- receipt, and the earn row is reachable only through it.
  perform 1
     from public.points_transactions pt
    where pt.reverses_id = v_earn.id
      and pt.type in ('clawback', 'reversal');
  if found then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_INVALID_STATE';
  end if;

  -- Step 6: lock the pair and read the balance under it (doc 35 section 5: "the row
  -- lock IS the correctness guarantee for balance_after"). The pair row must
  -- exist - 0018 created it before writing the earn - so a missing one is a
  -- corrupted ledger, not a case to paper over.
  select bc.points_balance into v_balance
    from public.business_customers bc
   where bc.business_id = v_earn.business_id
     and bc.consumer_id = v_earn.consumer_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- Step 7: the clamp. doc 35 section 9: "points = -min(original_earn_points,
  -- current_balance) - clamped; the ledger never drives a balance negative".
  -- The shortfall is NOT carried as debt (section 9's residual-debt policy); it is
  -- recorded in the audit row's `after` as doc 35 names it, and doc 37's
  -- consequences ladder handles the repeat case through segments and
  -- suspension rather than through a negative balance.
  v_clawed    := least(v_earn.points, v_balance);
  v_shortfall := v_earn.points - v_clawed;

  -- The fully-spent case. points_transactions has `check (points <> 0)`, so
  -- when the balance is already zero there is NO ledger row that can be
  -- written - a zero-point clawback is not a smaller correction, it is an
  -- invalid one. doc 35's worked example stops one step short of this (balance
  -- 100, earn 970 -> row of -100, shortfall 870); this is the same case with
  -- the balance at 0, and the honest handling is to write no ledger row, record
  -- the whole earn as shortfall, and still reject the receipt. Skipping the
  -- rejection instead would leave a receipt confirmed fraudulent sitting at
  -- status='approved'.
  if v_clawed > 0 then
    insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after,
       receipt_id, reverses_id, actor_id)
    values
      (v_earn.business_id, v_earn.consumer_id, 'clawback', -v_clawed,
       v_balance - v_clawed, p_receipt_id, v_earn.id, p_actor_id)
    returning id into v_txn_id;

    -- Step 8: the CRM cache, same transaction (doc 35 section 3 step 10's counterpart
    -- on the way down). points_balance mirrors the ledger exactly. The two
    -- lifetime counters are unwound by the ORIGINAL amounts and floored at zero
    -- per doc 35 section 9 ("floor at 0"): they are sums over history, and the history
    -- entry they summed is now known to be fraudulent, so leaving them inflated
    -- would keep a fraudulent receipt influencing segment and cohort reporting
    -- forever. greatest(...) is what makes the floor structural rather than a
    -- hope about ordering.
    --
    -- visit_count is deliberately NOT decremented. doc 40 defines a visit as a
    -- distinct (user, business, Manila day) with >= 1 approved receipt, so one
    -- receipt out of several on the same day is not one visit, and the counter
    -- is a cache doc 40 recomputes from the receipts table - where this receipt
    -- is about to stop being approved. Guessing at a decrement here would
    -- corrupt a number that heals itself.
    update public.business_customers bc
       set points_balance          = v_balance - v_clawed,
           lifetime_points         = greatest(0, bc.lifetime_points - v_earn.points),
           lifetime_spend_centavos = greatest(
                                       0,
                                       bc.lifetime_spend_centavos
                                         - coalesce(v_receipt.total_centavos, 0)
                                     )
     where bc.business_id = v_earn.business_id
       and bc.consumer_id = v_earn.consumer_id;
  else
    -- Balance already zero: the cache's points_balance is right as it stands,
    -- but the lifetime counters still carry the fraudulent earn and are unwound
    -- on the same argument as above.
    update public.business_customers bc
       set lifetime_points         = greatest(0, bc.lifetime_points - v_earn.points),
           lifetime_spend_centavos = greatest(
                                       0,
                                       bc.lifetime_spend_centavos
                                         - coalesce(v_receipt.total_centavos, 0)
                                     )
     where bc.business_id = v_earn.business_id
       and bc.consumer_id = v_earn.consumer_id;
  end if;

  -- Step 9: the receipt. doc 37 ladder step 5: "receipt -> rejected/
  -- fraud_suspected with reviewed_by set". Note what is NOT written:
  -- reject_note stays untouched. The admin's reason is free text that may name
  -- another consumer or another tenant's receipt (that is usually the whole
  -- finding), and reject_note is read back by the business review queue; the
  -- reason belongs in audit_logs, whose read audience is the tenant owner for
  -- their own rows and the admin for everything.
  --
  -- Moving to 'rejected' also releases this receipt's number from
  -- receipts_number_unique (0017 excludes rejected rows from that index), which
  -- is correct: if the number was claimed fraudulently, the honest holder of
  -- the same printed receipt must be able to claim it afterwards.
  update public.receipts r
     set status        = 'rejected',
         reject_reason = 'fraud_suspected',
         reviewed_by   = p_actor_id,
         reviewed_at   = now(),
         updated_by    = p_actor_id
   where r.id = p_receipt_id;

  -- Step 10: the audit row, INSIDE the transaction.
  --
  -- This is the one thing this function does that src/features/receipts/server/
  -- review.ts could not: that service writes its audit row through PostgREST as
  -- a separate statement and spends a long comment justifying the ordering it
  -- had to choose. Here the ledger write and its justification commit or roll
  -- back together, so an unauditable clawback is not a race that has to be lost
  -- gracefully - it is unreachable.
  --
  -- actor_kind='admin' makes `reason` mandatory at the database layer
  -- (audit_logs_admin_reason_required, 0022); step 1 above is the same check
  -- moved early enough to produce a useful error.
  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action,
     entity_type, entity_id, before, after, reason, request_id)
  values
    (p_actor_id, 'admin', v_admin_role, v_earn.business_id,
     'fraud.clawback_applied', 'receipt', p_receipt_id,
     jsonb_build_object(
       'status', v_receipt.status,
       'points_balance', v_balance,
       'earn_points', v_earn.points
     ),
     jsonb_build_object(
       'status', 'rejected',
       'reject_reason', 'fraud_suspected',
       'points_balance', v_balance - v_clawed,
       'clawed_points', v_clawed,
       -- doc 35 section 9 names this key: "recorded in the audit trail (audit_logs
       -- action='points.clawback', after.shortfall_points)". The ACTION verb
       -- follows 0022's registry instead, which lists fraud.clawback_applied by
       -- name from doc 37's reviewer-action mapping; the two docs disagree only
       -- about the verb and 0022 is the one this database's shape constraint
       -- and index were written against.
       'shortfall_points', v_shortfall,
       'transaction_id', v_txn_id
     ),
     v_reason, p_request_id);

  return jsonb_build_object(
    'transaction_id',   v_txn_id,
    'earn_points',      v_earn.points,
    'clawed_points',    v_clawed,
    'shortfall_points', v_shortfall,
    'balance_after',    v_balance - v_clawed
  );
end
$$;

-- Service-role only, narrower than 0013's consumer-callable RPCs and identical
-- in posture to 0018: this function moves points and rejects a receipt, so no
-- consumer and no business staff member may ever reach it. The only caller is
-- the admin consequences service running under the service key, which resolves
-- the actor from the session and passes it as p_actor_id - a value step 2
-- re-verifies against platform_admins rather than trusting.
revoke execute on function public.clawback_receipt_points(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.clawback_receipt_points(uuid, uuid, text, text)
  to service_role;
