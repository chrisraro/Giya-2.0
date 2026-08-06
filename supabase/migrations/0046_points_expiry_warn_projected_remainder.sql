-- ============================================================================
-- 0046_points_expiry_warn_projected_remainder.sql
-- Review fix (task 1.3, I3/I2/M1): the warn job warned about one lot instead
-- of the doc-specified projected remainder, was not self-clearing, and its
-- check-then-insert dedupe could double-send under an overlapping run.
--
-- ---------------------------------------------------------------------------
-- I3 — warn about the FORMULA's projected remainder, not the soonest lot
-- ---------------------------------------------------------------------------
-- 0044 took the single soonest positive-remainder lot (`limit 1`) and
-- compared THAT lot's own `expires_at` against each horizon. Doc 35 section 7
-- and doc 39's queue registry both specify the SAME FORMULA evaluated at
-- `t = now()+30d` and `t = now()+7d` - the aggregate `private.
-- points_expirable_remainder`, already reused at three `asof` values per this
-- slice's own header notes - not "whichever lot happens to be nearest."
--
-- THE CONSEQUENCE, reproduced as a pgTAP vector below: lot A (10 days out, 50
-- points) and lot B (12 days out, 500 points) for the same pair. Taking only
-- the soonest lot, day 0 warns "50 pts" (A) and says nothing about B, because
-- B is shadowed by A being nearer. A expires on day 10; only on day 11, once
-- A is gone, does B become "soonest" and get its OWN first warning - one day
-- before it actually expires, both horizons firing at once, having given the
-- consumer no real lead time on the 500 points that mattered most. The
-- aggregate formula does not have this blind spot: on day 0, `points_
-- expirable_remainder(asof = now()+30d)` already returns 550 (A's 50 AND B's
-- 500, since both fall inside 30 days), so the FIRST warning correctly names
-- the full amount at risk.
--
-- WHAT THIS MEANS FOR THE MESSAGE. Losing "the soonest lot" also loses "the
-- one date to print" - an aggregate over possibly-several lots has no single
-- `expires_on` instant to name honestly. The copy now names the HORIZON
-- itself ("within the next 30 days" / "within the next 7 days") rather than
-- inventing a specific calendar date the aggregate does not actually have.
--
-- WHAT THIS MEANS FOR DEDUPE. The old dedupe key was `(pair, horizon, that
-- lot's expires_at)` - a fixed fact that, once true, stayed true forever, so
-- "one notice per lot per horizon" was a stable, natural key. The aggregate
-- has no such fixed identity: it can rise (a new lot enters the window) or
-- fall (a redemption, or the sweep taking an already-past-due portion) from
-- one day's run to the next. This migration dedupes on `(pair, kind, horizon,
-- the projected points figure itself)`: an unchanged figure on a later run is
-- the same fact already told and is skipped; a CHANGED figure is new
-- information (the consumer's real exposure moved) and is sent. This is a
-- deliberate call, stated plainly per the task brief's own standard for this
-- kind of decision: it will re-notify at the same horizon on a later day if
-- and only if the number itself has changed, which trades "notify at most
-- once, ever, per horizon" for "the number in the consumer's inbox is never
-- stale" - the latter matters more for a warning whose whole job is to be
-- acted on before a deadline.
--
-- ---------------------------------------------------------------------------
-- I2 — same self-clearing defect as the sweep (0045), same fix
-- ---------------------------------------------------------------------------
-- 0044's candidate scan had the identical shape 0045's header describes for
-- the sweep: a pair that has already been fully processed for BOTH horizons
-- still matches "exists a lot inside 30 days" forever, permanently occupying
-- a slot among `p_limit` candidates and starving pairs beyond that limit.
-- Fixed the same way: the WHERE clause now requires the projected 30-day
-- remainder to be genuinely positive, not merely "a qualifying row exists".
--
-- NAMED HONESTLY, NOT SOLVED IDENTICALLY: this fix closes the SAME hole the
-- sweep's does (a pair with truly nothing left drops out and frees a slot),
-- but it is not equally airtight for this job specifically, and the
-- difference is worth stating rather than glossing over. `expire_points`'s
-- remainder goes to exactly 0 the moment it sweeps a pair, permanently (until
-- a new earn lands) - self-clearing is complete. This job's projected
-- remainder does NOT go to 0 just because a pair was already warned; it stays
-- genuinely positive for as long as the underlying points remain real and
-- unspent, which is CORRECT (a pair that still has 500 expiring points really
-- is still a candidate every day). So if the number of pairs with a
-- simultaneously-positive projected remainder ever exceeds `p_limit` for many
-- consecutive days, some of them will not be re-evaluated on any given day -
-- not a silent-forever bug (they are reached the moment an earlier pair's
-- points are actually spent or swept, freeing a slot), but a genuine,
-- scale-dependent capacity question this fix does not resolve. Distinguished
-- here so a future reader does not assume this job got the sweep's exact,
-- complete guarantee.
--
-- ---------------------------------------------------------------------------
-- M1 — the dedupe race
-- ---------------------------------------------------------------------------
-- 0044's dedupe was a plain "not exists, then insert" with no lock, so two
-- overlapping invocations of this function could both pass the "not exists"
-- check for the same pair before either commits its insert, doubling every
-- notification. Fixed the same way `expire_points` already protects its own
-- pairs: `for update of bc skip locked` on the candidate scan, so two
-- overlapping runs partition the pair set between them rather than racing
-- the same pair. `supabase/README.md`'s claim that all four sweep-family
-- functions are safe under overlap is now true of this one too.
--
-- Source docs: docs/30-modules/35-points-engine.md section 7 ("Expiry
-- warnings", the same formula at two horizons); docs/30-modules/
-- 39-background-jobs.md (`points.expiry_warn`); 0043/0045 (the shared
-- primitive and its own self-clearing precedent).
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
  v_business_name    text;
  v_notified         integer := 0;
begin
  for v_pair in
    select bc.business_id, bc.consumer_id
      from public.business_customers bc
     where bc.points_balance > 0
       -- Cheap pre-filter (widened per I1 to match private.points_lot_
       -- remainders' own type list): is there even a lot that could fall
       -- inside the widest horizon (30 days) and hasn't already passed due
       -- (that is expire_points' job, not this one's)?
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
       -- Review fix (I2): the EXACT, self-clearing condition, mirroring
       -- 0045's fix to the sweep - a pair projected to have nothing left at
       -- the 30-day horizon drops out of candidacy entirely rather than
       -- occupying a slot forever.
       and private.points_expirable_remainder(
             bc.business_id, bc.consumer_id, now() + interval '30 days') > 0
     order by bc.business_id, bc.consumer_id
     limit p_limit
       -- Review fix (M1): same lock, same position, as expire_points and
       -- award_receipt_points - two overlapping runs partition the backlog
       -- instead of racing the same pair's dedupe check.
       for update of bc skip locked
  loop
    -- Review fix (I3): the SAME formula at both horizons, not the soonest
    -- lot's own date. `points_expirable_remainder` is the identical primitive
    -- the sweep (0045) and the wallet's own read (public.points_next_expiry)
    -- use - never a second implementation.
    v_remainder_30d := private.points_expirable_remainder(
      v_pair.business_id, v_pair.consumer_id, now() + interval '30 days');
    v_remainder_7d := private.points_expirable_remainder(
      v_pair.business_id, v_pair.consumer_id, now() + interval '7 days');

    if v_remainder_30d <= 0 and v_remainder_7d <= 0 then
      continue;
    end if;

    select b.name into v_business_name
      from public.businesses b
     where b.id = v_pair.business_id;

    if v_remainder_30d > 0 then
      if not exists (
        select 1
          from public.notifications n
         where n.user_id = v_pair.consumer_id
           and n.business_id = v_pair.business_id
           and n.kind = 'points_expiring'
           and (n.data->>'horizon') = '30d'
           and (n.data->>'points')::integer = v_remainder_30d
      ) then
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status, sent_at)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_30d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire within the next 30 days.',
          jsonb_build_object('horizon', '30d', 'points', v_remainder_30d,
                              'business_id', v_pair.business_id),
          'in_app', 'sent', now()
        );
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_30d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire within the next 30 days.',
          jsonb_build_object('horizon', '30d', 'points', v_remainder_30d,
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
           and (n.data->>'points')::integer = v_remainder_7d
      ) then
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status, sent_at)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_7d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire within the next 7 days.',
          jsonb_build_object('horizon', '7d', 'points', v_remainder_7d,
                              'business_id', v_pair.business_id),
          'in_app', 'sent', now()
        );
        insert into public.notifications
          (user_id, business_id, kind, title, body, data, channel, status)
        values (
          v_pair.consumer_id, v_pair.business_id, 'points_expiring',
          'Points expiring soon',
          v_remainder_7d::text || ' pts at ' || coalesce(v_business_name, 'a business')
            || ' expire within the next 7 days.',
          jsonb_build_object('horizon', '7d', 'points', v_remainder_7d,
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
