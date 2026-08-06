-- ============================================================================
-- 0039_fixed_per_visit_excludes_clawback.sql
-- Re-review fix (task 1.1, M-a): a clawed-back fixed_per_visit earn must not
-- count as "paid" for the visit-day dedupe.
--
-- THE GAP. `private.fixed_per_visit_already_paid` (0038) treats any earn row
-- with `type = 'earn'`, `points > 0`, a matching visit day, and a
-- fixed_per_visit base that was not itself deduped as proof this visit day
-- already collected its fixed base. It did not check whether that earn was
-- later reversed. `clawback_receipt_points` (0031) never deletes or mutates
-- the original earn row - "corrections are compensating entries (reversal/
-- adjust), never mutations" (0012's own comment on the ledger's
-- immutability) - it inserts a NEW row, `type in ('clawback','reversal')`,
-- `reverses_id = <the earn's id>`, per doc 35 section 9's "at most one
-- clawback/reversal per reverses_id". So a receipt whose fraudulent earn was
-- clawed back would still be treated as "this visit day already paid its
-- fixed_per_visit base", wrongly suppressing a LEGITIMATE later receipt on
-- the same visit day.
--
-- THE FIX. Add `and not exists (select 1 from points_transactions rev where
-- rev.reverses_id = pt.id and rev.type in ('clawback', 'reversal'))` to the
-- predicate, mirroring `clawback_receipt_points`'s own idempotency check at
-- 0031 step 5 (`perform 1 ... where pt.reverses_id = v_earn.id and pt.type in
-- ('clawback', 'reversal')`) so both call sites recognize "already reversed"
-- identically.
--
-- Same signature as 0038 (`(uuid, uuid, date) returns boolean`), so this is
-- a plain `create or replace`; grants are untouched (they attach to the
-- function's identity, not its body) and `award_receipt_points` itself is
-- unchanged - it only ever calls this function by name, never restates its
-- predicate.
--
-- Source docs:
--   * docs/30-modules/35-points-engine.md section 9 (clawback clamp,
--     idempotency: "at most one clawback/reversal per reverses_id")
--   * supabase/migrations/0012_campaigns.sql (points_transactions.reverses_id:
--     "for reversal/clawback")
--   * supabase/migrations/0031_admin_access.sql (clawback_receipt_points,
--     the same reverses_id check this migration mirrors)
--   * supabase/migrations/0038_fixed_per_visit_visit_day.sql (the function
--     this migration amends)
-- ============================================================================

create or replace function private.fixed_per_visit_already_paid(
  p_business_id uuid,
  p_consumer_id uuid,
  p_visit_day   date
) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.points_transactions pt
      join public.receipts r on r.id = pt.receipt_id
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.type = 'earn'
       and pt.points > 0
       and private.manila_day(coalesce(r.receipt_date, pt.created_at)) = p_visit_day
       and pt.rule_snapshot -> 'base' ->> 'rule_type' = 'fixed_per_visit'
       and coalesce((pt.rule_snapshot -> 'base' ->> 'fixed_per_visit_deduped')::boolean, false)
             = false
       -- task 1.1 M-a: an earn that was later clawed back or reversed never
       -- actually "paid" this visit day, so it must not suppress a later,
       -- legitimate fixed_per_visit receipt on the same visit day.
       and not exists (
         select 1
           from public.points_transactions rev
          where rev.reverses_id = pt.id
            and rev.type in ('clawback', 'reversal')
       )
  );
$$;
