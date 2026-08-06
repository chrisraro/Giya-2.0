-- ============================================================================
-- 0049_points_expiry_warn_honest_deadline.sql
-- Re-review fix (task 1.3, finding I-A): the expiry warning stated an
-- aggregate amount against a single lot's date, which is a false deadline.
--
-- THE DEFECT. `v_remainder_30d` is the expirable remainder over the WHOLE
-- 30-day window. `v_soonest.expires_at` is the date of the FIRST lot in that
-- window. 0048 joined them with the words "expire by":
--
--     550 pts at Expiry Cafe expire by Mar 03, 2027.
--
-- when the window held 50 pts due Mar 03 and 500 pts due Mar 05. Only 50
-- expire by the stated date. Worse, the wallet reads the same
-- `points_next_expiry` primitive this task deliberately single-sourced, and
-- correctly shows 50 against Mar 03 - so the two consumer surfaces stated
-- different numbers for the same deadline. Doc 35 section 7 and the published
-- consumer terms both make the stated wording binding; a number that is
-- wrong in the consumer's favour is still wrong, and "your points expire
-- sooner than they do" is exactly the kind of claim that reads as a trap.
--
-- BOTH HORIZONS, not just 30d. The re-review judged the 7d branch safe on the
-- grounds that a positive 7d remainder forces the soonest lot to be within 7
-- days. That is true of the DATE and says nothing about the AMOUNT: two lots
-- four days apart inside the same week reproduce the defect exactly. Fixed
-- here for both.
--
-- THE FIX. When the soonest lot IS the entire window, the simple sentence is
-- true and stays (this is the common single-lot case). Otherwise the date is
-- stated against its own lot's amount - which agrees with the wallet by
-- construction, since both come from `points_lot_remainders` - and the window
-- total becomes a separate, correctly-qualified clause:
--
--     50 pts at Expiry Cafe expire on Mar 03, 2027, and 550 pts within the
--     next 30 days.
--
-- "expire by" also became "expire on", because the date now belongs to a
-- specific lot rather than bounding a set.
--
-- `data.expires_on` is unchanged and still carries the soonest lot's date: it
-- is the window-stable dedupe key 0048 introduced for finding N3, and that
-- design is correct and deliberately untouched here.
--
-- Signature unchanged, so this is a plain `create or replace`; grants attach
-- to the function's identity, not its body, and are restated below only
-- because this file recreates the function.
--
-- Source docs:
--   * docs/30-modules/35-points-engine.md section 7 (warn payload {points,
--     expires_on}; "same formula at t = now()+30d and +7d")
--   * src/app/(marketing)/terms/page.tsx ("When points expire" - the binding
--     published wording)
--   * supabase/migrations/0048_... (the window-stable dedupe key kept here)
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
  v_body_30d         text;
  v_body_7d          text;
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

    -- I-A: the amount and the date must come from the SAME set. The remainder
    -- is the aggregate over the whole horizon window; `v_soonest` is only the
    -- FIRST lot in it. Joining them with "expire by" states a deadline that is
    -- false whenever the window holds more than one lot - "550 pts expire by
    -- Mar 03" when only 50 do - and it contradicts the wallet, which reads the
    -- same `points_next_expiry` primitive and shows 50 against that date.
    --
    -- This applies to BOTH horizons. The re-review judged the 7d branch safe
    -- because a positive 7d remainder forces the soonest lot to be <= 7 days
    -- out; that is true of the DATE and says nothing about the AMOUNT. Two
    -- lots four days apart inside the same week reproduce the defect exactly.
    --
    -- When the soonest lot IS the whole window, the simple sentence is both
    -- true and the friendliest, so it is kept. Otherwise the date is stated
    -- against its own lot's amount (agreeing with the wallet) and the window
    -- total is stated as a separate, correctly-qualified clause.
    v_body_30d := case
      when v_soonest.remaining = v_remainder_30d then
        v_remainder_30d::text || ' pts at ' || coalesce(v_business_name, 'a business')
          || ' expire on ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY') || '.'
      else
        v_soonest.remaining::text || ' pts at ' || coalesce(v_business_name, 'a business')
          || ' expire on ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY')
          || ', and ' || v_remainder_30d::text || ' pts within the next 30 days.'
    end;

    v_body_7d := case
      when v_soonest.remaining = v_remainder_7d then
        v_remainder_7d::text || ' pts at ' || coalesce(v_business_name, 'a business')
          || ' expire on ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY') || '.'
      else
        v_soonest.remaining::text || ' pts at ' || coalesce(v_business_name, 'a business')
          || ' expire on ' || to_char(v_soonest.expires_at, 'Mon DD, YYYY')
          || ', and ' || v_remainder_7d::text || ' pts within the next 7 days.'
    end;

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
          v_body_30d,
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
          v_body_30d,
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
          v_body_7d,
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
          v_body_7d,
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
