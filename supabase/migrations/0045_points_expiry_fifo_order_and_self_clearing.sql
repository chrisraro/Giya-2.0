-- ============================================================================
-- 0045_points_expiry_fifo_order_and_self_clearing.sql
-- Review fix (task 1.3, I1/I2/I5): three defects in 0043's FIFO engine and
-- sweep, found by the task reviewer against a database this repo had already
-- shipped stamping and a sweep against (0042-0044).
--
-- ---------------------------------------------------------------------------
-- I1 — FIFO consumption must order by EXPIRY, not by creation, when a lot
-- never expires
-- ---------------------------------------------------------------------------
-- 0043 ordered both the cumulative window and the final result by
-- `pt.created_at, pt.id`, reasoning (correctly, in isolation) that doc 35
-- section 7 calls expiry order "monotone in created_at". That reasoning
-- silently breaks the moment a lot has NO expiry at all: `adjust`/
-- `referral_bonus` rows are admitted to the lots set but nothing stamps their
-- `expires_at` (doc 35 section 8 only promises a stamp "per the business
-- expiry policy", which does not exist yet), so they carry `expires_at is
-- null` - and 0043 ordered nulls FIRST (Postgres's default for a bare
-- ascending order by), meaning a null-expiry lot was treated as the OLDEST,
-- most-urgent-to-drain lot. Doc 35 section 7 is explicit that a null expiry
-- "never expires", i.e. sorts as +∞ - the LEAST urgent lot, drained LAST, not
-- first.
--
-- THE COUNTER-EXAMPLE (reviewer's, reproduced as a pgTAP vector below):
-- a positive `adjust` of 500 (null expiry, day 1) then an `earn` of 300
-- (expires day 400, day 2), then one `redeem` of 500. Doc 35's own FIFO
-- (expiry order, nulls last) drains the day-400 earn FIRST because it is the
-- lot that could actually be lost - remainder 0, so when day 400 arrives
-- there is nothing left to expire from it. 0043's creation-order FIFO drained
-- the null-expiry adjust first instead (it was chronologically first),
-- leaving the day-400 earn's full 300 sitting untouched - so 0043 would have
-- expired 300 points on day 400 that doc 35's own formula says were already
-- spent. This is latent today (nothing writes a positive `adjust` yet) but
-- the code was deliberately written to admit that future case and got its
-- ordering backwards for it.
--
-- THE FIX: order by `coalesce(expires_at, 'infinity'::timestamptz)` first,
-- `created_at` and `id` only as tie-breakers among lots that share an expiry
-- (in particular, among every never-expiring lot, creation order is still
-- the fair tie-break - there is no urgency signal to prefer one over
-- another). This is applied to BOTH the window's cumulative sum ordering and
-- the function's final `order by`, which must agree (the cumulative value at
-- each row only means what doc 35 section 7's telescoping argument says it
-- means - see 0043's header - if the running sum is computed in the SAME
-- order the result is read back in).
--
-- ---------------------------------------------------------------------------
-- I2 — the sweep's candidate scan was not self-clearing
-- ---------------------------------------------------------------------------
-- 0043's scan was `points_balance > 0 AND exists(a past-due earn row)`,
-- `order by business_id, consumer_id limit p_limit`. Once a pair's past-due
-- lots are fully drained, the EXISTS half stays true forever (the past-due
-- row itself never stops existing, and satisfied does not remove it - only
-- draining changes whether there is anything LEFT, and this predicate never
-- asked that question). So a pair that has nothing left to expire still
-- occupies a candidate slot on every future run, permanently. Past
-- `p_limit` such pairs (sorted alphabetically by (business_id, consumer_id)),
-- every nightly run reprocesses the SAME first `p_limit` zero-remainder
-- pairs and pairs beyond that limit are never reached - no error, no metric,
-- silent non-enforcement of a published policy on a money path.
--
-- THE FIX: add the ACTUAL exact condition to the WHERE clause -
-- `private.points_expirable_remainder(...) > 0` - so a pair drops out of
-- candidacy the moment there is genuinely nothing left for it to lose, and
-- whatever the next `p_limit` pairs are (in the same deterministic order)
-- take its slot on the next run. The EXISTS half stays as a cheap,
-- index-assisted PRE-filter (driven by `pt_expiry_idx`) so the more
-- expensive per-pair aggregate is only computed for rows that already look
-- promising, not for the whole `business_customers` table; the aggregate
-- clause is what makes the predicate CORRECT rather than merely cheap. This
-- computes the aggregate twice per surviving candidate (once to filter,
-- once inside the loop body to decide the actual write) - a named,
-- accepted cost in the same spirit as 0041's N2 note, not solved here.
-- Verified live: with `p_limit` forced small, a pair beyond that limit is
-- reached only after the earlier pairs clear on a prior run (pgTAP below).
--
-- ---------------------------------------------------------------------------
-- I5 — the expire row's rule_snapshot dropped the only audit trail this
-- design has
-- ---------------------------------------------------------------------------
-- Doc 35 section 7 is explicit that the sweep is "bookkeeping by
-- arithmetic, not per-row allocation" with "no consumption links stored" -
-- which makes the snapshot's `x_expired_sum` (doc 35's X(t)) and
-- `d_drained_sum` (D(t)) the ONLY record of what the sweep saw when it wrote
-- a given `remainder`. 0043 wrote `{engine, remainder, cutoff}` and silently
-- dropped both sums, making a past sweep's inputs unreconstructable - "why
-- did 250 points vanish" could not be answered from the ledger alone, which
-- is the one thing doc 20's "balances are derived, ledger is the
-- explanation of record" promises. Restored below, computed from the SAME
-- `private.points_lot_remainders` call the remainder itself comes from (one
-- pass, not a second implementation of X/D).
--
-- Source docs: docs/30-modules/35-points-engine.md section 7 (the FIFO
-- formula, the `+∞` null-expiry rule, the snapshot shape); 0043's own header
-- (the telescoping proof this migration's ordering fix must keep true).
-- ============================================================================

-- ---------------------------------------------------------------- private.points_lot_remainders
-- Return shape WIDENED (adds total_debit), which Postgres does not allow via
-- `create or replace` (a function's return type cannot change in place) - so
-- this is DROP then CREATE, not replace. Callers (`points_expirable_remainder`,
-- `points_next_expiry`, `points_expiry_warn`) all select specific columns by
-- NAME, never `select *`, so the extra column does not require touching them;
-- `expire_points` below is re-created specifically to READ the new column.
drop function if exists private.points_lot_remainders(uuid, uuid);

create function private.points_lot_remainders(
  p_business_id uuid,
  p_consumer_id uuid
) returns table (
  txn_id       uuid,
  created_at   timestamptz,
  expires_at   timestamptz,
  points       integer,
  remaining    integer,
  -- Review fix (I5): D, doc 35 section 7's D(t) (not actually t-dependent -
  -- see 0043's header) - repeated on every row (the same value each time,
  -- trivial cost) so a caller reading any row already has it, with no second
  -- query and no second implementation of the debit sum.
  total_debit  integer
)
language sql
stable
set search_path = ''
as $$
  with lots as (
    select pt.id, pt.created_at, pt.expires_at, pt.points,
           sum(pt.points) over (
             -- Review fix (I1): order by EXPIRY first (nulls sort as +∞ via
             -- coalesce to 'infinity'), created_at/id only as tie-breakers.
             -- See the migration header for the counter-example this closes.
             order by coalesce(pt.expires_at, 'infinity'::timestamptz), pt.created_at, pt.id
             rows between unbounded preceding and current row
           ) as cumulative
      from public.points_transactions pt
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.points > 0
       and pt.type in ('earn', 'referral_bonus', 'adjust')
  ),
  debits as (
    select coalesce(sum(-pt.points), 0)::integer as total_debit
      from public.points_transactions pt
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.points < 0
       and pt.type in ('redeem', 'adjust', 'expire', 'clawback')
  )
  select l.id, l.created_at, l.expires_at, l.points,
         least(l.points, greatest(0, (l.cumulative - d.total_debit)))::integer as remaining,
         d.total_debit
    from lots l
    cross join debits d
   -- Review fix (I1): the RESULT order must agree with the window's order -
   -- otherwise a caller reading rows "in order" (points_next_expiry, the warn
   -- job) would see them in creation order while the cumulative values were
   -- computed in expiry order, which is incoherent.
   order by coalesce(l.expires_at, 'infinity'::timestamptz), l.created_at, l.id;
$$;

revoke execute on function private.points_lot_remainders(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- public.expire_points
-- Re-created (not a bare create-or-replace no-op) for I2 (the self-clearing
-- WHERE clause) and I5 (the restored audit fields, read from the SAME
-- points_lot_remainders call the remainder comes from). Also widens the
-- candidate scan's type list to match the lots CTE's (`earn`, `referral_bonus`,
-- `adjust`) rather than `earn` alone, per I1's closing instruction: the lots
-- set and the candidate set must not be able to disagree about what counts as
-- an expiring lot.
create or replace function public.expire_points(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair       record;
  v_x_sum      integer;
  v_d_sum      integer;
  v_remainder  integer;
  v_balance    integer;
  v_expired    integer := 0;
begin
  for v_pair in
    select bc.business_id, bc.consumer_id
      from public.business_customers bc
     where bc.points_balance > 0
       -- Cheap pre-filter, index-assisted (pt_expiry_idx): is there even a
       -- past-due lot of a type this engine ever expires? Widened per I1 to
       -- match private.points_lot_remainders' own type list.
       and exists (
         select 1
           from public.points_transactions pt
          where pt.business_id = bc.business_id
            and pt.consumer_id = bc.consumer_id
            and pt.type in ('earn', 'referral_bonus', 'adjust')
            and pt.points > 0
            and pt.expires_at is not null
            and pt.expires_at <= now()
       )
       -- Review fix (I2): the EXACT, self-clearing condition - a pair whose
       -- past-due lots are already fully drained no longer matches this, so
       -- it stops occupying a candidate slot and the next p_limit pairs (in
       -- the same order) surface on the next run instead of being starved
       -- forever.
       and private.points_expirable_remainder(bc.business_id, bc.consumer_id, now()) > 0
     order by bc.business_id, bc.consumer_id
     limit p_limit
       for update of bc skip locked
  loop
    -- Review fix (I5): one call to the shared primitive gets X(t), D and the
    -- final remainder together - never a second, independent computation of
    -- any of the three.
    select coalesce(sum(r.points), 0)::integer,
           coalesce(max(r.total_debit), 0)::integer,
           coalesce(sum(r.remaining), 0)::integer
      into v_x_sum, v_d_sum, v_remainder
      from private.points_lot_remainders(v_pair.business_id, v_pair.consumer_id) r
     where r.expires_at is not null
       and r.expires_at <= now();

    if v_remainder > 0 then
      select bc.points_balance
        into v_balance
        from public.business_customers bc
       where bc.business_id = v_pair.business_id
         and bc.consumer_id = v_pair.consumer_id;

      -- Defense in depth (unchanged from 0043): never drive the balance
      -- negative even if the formula and the cache have somehow drifted.
      v_remainder := least(v_remainder, v_balance);

      if v_remainder > 0 then
        insert into public.points_transactions
          (business_id, consumer_id, type, points, balance_after, rule_snapshot)
        values
          (v_pair.business_id, v_pair.consumer_id, 'expire', -v_remainder,
           v_balance - v_remainder,
           jsonb_build_object(
             'engine', 'points/v1',
             -- Review fix (I5): doc 35 section 7's own snapshot shape,
             -- restored - the only record of what this sweep saw, since no
             -- consumption links are stored anywhere else.
             'x_expired_sum', v_x_sum,
             'd_drained_sum', v_d_sum,
             'remainder', v_remainder,
             'cutoff', now()
           ));

        update public.business_customers
           set points_balance = v_balance - v_remainder
         where business_id = v_pair.business_id
           and consumer_id = v_pair.consumer_id;

        v_expired := v_expired + 1;
      end if;
    end if;
  end loop;

  return v_expired;
end
$$;

revoke execute on function public.expire_points(integer) from public, anon, authenticated;
grant execute on function public.expire_points(integer) to service_role;
