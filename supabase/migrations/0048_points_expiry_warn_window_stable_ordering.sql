-- ============================================================================
-- 0048_points_expiry_warn_window_stable_ordering.sql
-- Review fix (task 1.3, re-review N2/N3/N4): the warn job's candidate order
-- starved urgent pairs under a persistent backlog, its dedupe key produced a
-- nightly duplicate for any multi-lot consumer, and it dropped the date the
-- brief requires the copy to state.
--
-- ---------------------------------------------------------------------------
-- N2 — order by URGENCY (soonest in-window expiry), not UUID
-- ---------------------------------------------------------------------------
-- 0046 ordered candidates `by bc.business_id, bc.consumer_id` - a fixed,
-- content-free sort. Under a persistent backlog (more simultaneously-eligible
-- pairs than `p_limit`), the same alphabetically-first pairs occupy every
-- slot on every run, and pairs sorting later are corrected by 0045's own
-- self-clearing fix for the SWEEP but not for THIS job: a pair's projected
-- remainder does not go to zero just because it was already warned about, so
-- it keeps its slot for as long as it is genuinely still eligible - which,
-- for a lot inside a 30-day window, can be up to 30 consecutive days. A pair
-- past `p_limit` in that state is never re-evaluated at all: not delayed,
-- skipped. Net effect at scale: the sweep reliably reaches everyone (0045),
-- the warn job does not, so people who were never warned still lose points.
--
-- Fixed by ordering on urgency instead: `min(expires_at)` among each pair's
-- in-window lots, ascending. Whoever is closest to losing points is served
-- first, which turns the residual into a bounded fairness question (a pair
-- far from its deadline waits its turn) rather than permanent starvation
-- keyed on an arbitrary UUID.
--
-- ---------------------------------------------------------------------------
-- N3 — the dedupe key must be WINDOW-STABLE, not the projected figure
-- ---------------------------------------------------------------------------
-- 0046 deduped on `(pair, horizon, the projected points figure)`. That figure
-- moves for two independent, routine reasons that have nothing to do with a
-- genuinely new fact worth telling someone:
--   1. the window's right edge sweeps forward every night, admitting whatever
--      lot's `expires_at` newly falls inside it - a consumer who earned on
--      several consecutive days ~11 months ago has a DIFFERENT lot enter the
--      band each night, so the aggregate keeps growing and keeps producing a
--      brand new dedupe key. Every single night. Forever, until every lot in
--      the run has entered the window.
--   2. `expire_points` runs 15 minutes earlier every night and can shrink an
--      earlier remainder; a consumer redemption changes it too - so a
--      consumer who does exactly what the warning told them to (spend before
--      losing the points) gets RE-notified for complying, in the one channel
--      `src/features/notifications/kinds.ts` itself calls unrecallable.
--
-- The fix keys on the SOONEST in-window lot's own `expires_at` instead - the
-- same value N2's ordering now uses, and the same shared FIFO primitive
-- (`private.points_lot_remainders`) every other read in this slice already
-- goes through. This value is WINDOW-STABLE by construction: because lots
-- enter the window in ascending expiry order (never displacing an earlier
-- one - a newly-admitted lot is, by definition, later than whatever was
-- already inside), the "soonest lot" for a pair does not change on a given
-- night just because the aggregate grew behind it. It changes only when that
-- lot ITSELF is actually swept (`expire_points` takes it, or the consumer
-- spends it down to zero) and a later lot becomes the new soonest - which is
-- exactly the moment a fresh notice is warranted, because the thing the
-- consumer was told about is now a DIFFERENT lot with a different deadline.
--
-- The projected AMOUNT (the two-horizon aggregate remainder, the actual fix
-- from the ORIGINAL review's I3) is unchanged and still what the copy states
-- - only the DEDUPE KEY and the DATE (below) now come from the soonest lot,
-- never the aggregate.
--
-- ---------------------------------------------------------------------------
-- N4 — restore a date to the copy and the payload
-- ---------------------------------------------------------------------------
-- The task brief requires the copy to state "the amount, the business, and
-- the date." 0046's rewrite (chasing the ORIGINAL I3 finding) dropped the
-- date entirely ("expire within the next 30 days", `data` carrying no date
-- field at all) because an AGGREGATE has no single instant to name honestly.
-- The soonest-lot value N3 now computes anyway supplies exactly that date -
-- concrete, honest (it is a real lot's real expiry), and reused rather than
-- invented: `data.expires_on` (doc 35 section 7's own vocabulary: "positive
-- projected remainder -> notification kind='points_expiring' ({points,
-- expires_on})") and the copy now reads "{points} pts at {business} expire by
-- {date}."
--
-- Source docs: docs/30-modules/35-points-engine.md section 7; 0043/0045 (the
-- shared FIFO primitive this reuses, never reimplemented); 0046 (the
-- projected-remainder fix this keeps, only the key/date derivation changes).
-- ============================================================================

create or replace function public.points_expiry_warn(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair            record;
  v_remainder_30d    integer;
  v_remainder_7d     integer;
  v_soonest          record;
  v_business_name    text;
  v_notified         integer := 0;
begin
  for v_pair in
    select bc.business_id, bc.consumer_id
      from public.business_customers bc
     where bc.points_balance > 0
       and exists (
         select 1
           from public.points_transactions pt
          where pt.business_id = bc.business_id
            and pt.consumer_id = bc.consumer_id
            and pt.type in ('earn', 'referral_bonus', 'adjust')
            and pt.points > 0
            and pt.expires_at is not null
            and pt.expires_at > now()
            and pt.expires_at <= now() + interval '30 days'
       )
       and private.points_expirable_remainder(
             bc.business_id, bc.consumer_id, now() + interval '30 days') > 0
     -- N2: urgency order, not UUID order. The soonest in-window lot for each
     -- pair, ascending - a correlated scalar subquery (cheap relative to the
     -- self-clearing filter above, and driven by the same pt_expiry_idx the
     -- EXISTS clause already uses).
     order by (
       select min(pt.expires_at)
         from public.points_transactions pt
        where pt.business_id = bc.business_id
          and pt.consumer_id = bc.consumer_id
          and pt.type in ('earn', 'referral_bonus', 'adjust')
          and pt.points > 0
          and pt.expires_at is not null
          and pt.expires_at > now()
          and pt.expires_at <= now() + interval '30 days'
     ) asc
     limit p_limit
       for update of bc skip locked
  loop
    v_remainder_30d := private.points_expirable_remainder(
      v_pair.business_id, v_pair.consumer_id, now() + interval '30 days');
    v_remainder_7d := private.points_expirable_remainder(
      v_pair.business_id, v_pair.consumer_id, now() + interval '7 days');

    if v_remainder_30d <= 0 and v_remainder_7d <= 0 then
      continue;
    end if;

    -- N3/N4: the soonest lot that still has a positive remainder and has not
    -- yet passed due - the SAME primitive `public.points_next_expiry` (the
    -- wallet's own read) uses, so the date named here is the same date the
    -- wallet already shows. Defensive `if not found`: the candidate scan and
    -- the aggregate check above make this exist in the ordinary case, but a
    -- concurrent write between them must not crash the loop over one pair.
    select r.expires_at, r.remaining
      into v_soonest
      from private.points_lot_remainders(v_pair.business_id, v_pair.consumer_id) r
     where r.remaining > 0
       and r.expires_at is not null
       and r.expires_at > now()
     order by r.expires_at asc, r.txn_id asc
     limit 1;

    if not found then
      continue;
    end if;

    select b.name into v_business_name
      from public.businesses b
     where b.id = v_pair.business_id;

    if v_remainder_30d > 0 then
      -- N3: dedupe on the WINDOW-STABLE soonest-lot date, never the moving
      -- aggregate figure.
      if not exists (
        select 1
          from public.notifications n
         where n.user_id = v_pair.consumer_id
           and n.business_id = v_pair.business_id
           and n.kind = 'points_expiring'
           and (n.data->>'horizon') = '30d'
           and (n.data->>'expires_on')::timestamptz = v_soonest.expires_at
      ) then
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status, sent_at)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_30d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire by ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY') || '.',
          jsonb_build_object('horizon', '30d', 'points', v_remainder_30d,
                              'expires_on', v_soonest.expires_at,
                              'business_id', v_pair.business_id),
          'in_app', 'sent', now()
        );
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_30d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire by ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY') || '.',
          jsonb_build_object('horizon', '30d', 'points', v_remainder_30d,
                              'expires_on', v_soonest.expires_at,
                              'business_id', v_pair.business_id),
          'email', 'pending'
        );
        v_notified := v_notified + 1;
      end if;
    end if;

    if v_remainder_7d > 0 then
      if not exists (
        select 1
          from public.notifications n
         where n.user_id = v_pair.consumer_id
           and n.business_id = v_pair.business_id
           and n.kind = 'points_expiring'
           and (n.data->>'horizon') = '7d'
           and (n.data->>'expires_on')::timestamptz = v_soonest.expires_at
      ) then
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status, sent_at)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_7d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire by ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY') || '.',
          jsonb_build_object('horizon', '7d', 'points', v_remainder_7d,
                              'expires_on', v_soonest.expires_at,
                              'business_id', v_pair.business_id),
          'in_app', 'sent', now()
        );
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_7d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire by ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY') || '.',
          jsonb_build_object('horizon', '7d', 'points', v_remainder_7d,
                              'expires_on', v_soonest.expires_at,
                              'business_id', v_pair.business_id),
          'email', 'pending'
        );
        v_notified := v_notified + 1;
      end if;
    end if;
  end loop;

  return v_notified;
end
$$;

revoke execute on function public.points_expiry_warn(integer) from public, anon, authenticated;
grant execute on function public.points_expiry_warn(integer) to service_role;
