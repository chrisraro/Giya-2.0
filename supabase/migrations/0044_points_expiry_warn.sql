-- ============================================================================
-- 0044_points_expiry_warn.sql
-- Task 1.3, step 3: the expiry warning sweep (doc 35 section 7's "Expiry
-- warnings" / doc 39's `points.expiry_warn`) - runs the SAME shared FIFO
-- primitive 0043 built (`private.points_lot_remainders`), at horizons +30d and
-- +7d, and raises `kind='points_expiring'` once per (pair, horizon, lot).
--
-- WHY A NEW NOTIFICATION KIND, REGISTERED HERE, NOT JUST IN TYPESCRIPT. 0026's
-- header explains why `notifications.kind` is an enumerated CHECK rather than
-- free text (unlike `audit_logs.action`): a notification write is fail-soft,
-- so the enum is CHEAP to enforce and worth enforcing, catching a typo'd kind
-- before it renders as a blank inbox row. `campaign_budget_exhausted` (0040)
-- is the precedent for widening it; this migration repeats that exact shape
-- (drop the auto-named check, re-add it with one more value) for
-- `points_expiring`, and `src/features/notifications/kinds.ts` gains the
-- matching registry entry in the same commit (kinds.test.ts pins the two
-- lists never drifting apart).
--
-- WHY THIS SWEEP WRITES `notifications` ROWS DIRECTLY IN SQL RATHER THAN
-- CALLING src/features/notifications/server/raise.ts. pg_cron can only invoke
-- SQL (0028's own header makes exactly this point about OCR retries: "pg_cron
-- can only call SQL ... reimplementing any of it in plpgsql would create the
-- second pipeline doc 36 exists to prevent"). raise.ts's OWN job is composing
-- copy and fanning out to the `notify.email` queue via `src/lib/queue/
-- publish.ts`'s `enqueue()` - there is no SQL-reachable entry point into
-- either, and there will not be one until a pg_net-based callout is a
-- deliberate, separately-reviewed decision (none of this codebase's existing
-- sweeps make that call today). So this migration writes the TWO rows raise.ts
-- would have written - `channel='in_app', status='sent', sent_at=now()` (the
-- guaranteed channel, doc 30 section 5.2 step 3) and `channel='email',
-- status='pending'` (doc 30's fan-out shape) - directly, under the same
-- SECURITY DEFINER posture every other system writer in this file already
-- has. This is HONEST about what it does and does not achieve, stated plainly
-- rather than glossed over:
--   * the in_app row is a COMPLETE delivery - it appears in the recipient's
--     inbox the moment this sweep runs, exactly as if raise.ts had written it;
--   * the email row is DURABLE but UNSENT - nothing enqueues a `notify.email`
--     job for it, because that would mean a raw INSERT into `public.jobs`
--     from SQL, which doc 39 states "only via src/lib/queue/enqueue.ts, never
--     raw ... calls from features" (a rule written about QStash's SDK, but the
--     REASON - one enqueue path, one place that can drift from the row it
--     writes - applies just as much to a raw jobs insert from plpgsql). A
--     pending email row is therefore accepted as this task's honest stopping
--     point, matching `expire_claims`'s own precedent of shipping the sweep
--     without doc 35's `notify kind='reward_claim_expired'` half (0016's
--     header: no notify call at all). The gap here is narrower than that one
--     (the in_app row DOES land) and is a smaller, separate follow-up: a
--     worker or reconciler that scans `notifications` rows `channel='email'
--     and status='pending' and kind='points_expiring'` and calls `enqueue()`
--     for them, the same shape doc 39's hourly reconciler already covers for
--     `jobs` rows with no message id.
--
-- DEDUPE, STATED EXACTLY (task brief: "one notice per lot horizon: 30d and
-- 7d, no duplicates"). There is no `jobs.dedupe_key` in play here (this sweep
-- never touches `jobs`, per the note above), so the marker is the
-- notification's OWN `data` payload: `{lot_expires_at, horizon}` identifies
-- "this specific lot, at this specific horizon" and a `not exists` guard
-- before each insert makes a second run of the sweep - the same day, or any
-- later day before the lot's `expires_at` passes - a correct no-op. Warning
-- about the SAME lot again at the OTHER horizon (30d, then again at 7d) is
-- deliberately NOT deduped against itself: those are two distinct, useful
-- messages ("a month left" vs "a week left"), which is exactly why `horizon`
-- is part of the key and not a filter that suppresses the second one.
--
-- WHY THE SOONEST LOT ONLY, NOT EVERY LOT. `public.points_next_expiry` (0043)
-- already answers "what is the next thing to expire" for the wallet; this
-- sweep asks the identical question for the identical reason - a consumer
-- with three expiring lots needs to know about the NEXT one to act on, and a
-- pair that clears its soonest lot's warning still gets warned about the
-- next-soonest lot on a LATER run, once ITS OWN expires_at enters the
-- horizon window. Warning about every lot at once would be the inbox
-- equivalent of the campaign_id N+1 problem 0041 fixed on the write side.
--
-- Source docs: docs/30-modules/35-points-engine.md section 7 ("Expiry
-- warnings [V1]"); docs/30-modules/39-background-jobs.md (`points.expiry_warn`,
-- daily, `25 18 * * *` UTC = 02:25 Manila, immediately after the expiry sweep);
-- docs/30-modules/30-platform-core.md section 5.2 (the fan-out shape this
-- mirrors); src/features/notifications/server/raise.ts (the TypeScript
-- version of the same two-row shape, for reference - not called from here);
-- src/features/notifications/kinds.ts (the registry entry landing alongside).
-- ============================================================================

-- ---------------------------------------------------------------- notifications.kind
alter table public.notifications
  drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'points_awarded',
    'receipt_rejected',
    'receipt_in_review',
    'reward_claimed',
    'reward_expiring',
    'campaign_budget_exhausted',
    'points_expiring'
  ));

-- ---------------------------------------------------------------- points_expiry_warn
create or replace function public.points_expiry_warn(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair          record;
  v_lot           record;
  v_horizon       record;
  v_business_name text;
  v_notified      integer := 0;
begin
  -- Candidate scan: a pair with a positive balance and at least one earn row
  -- whose expires_at falls inside the WIDEST horizon this job warns at (30
  -- days) but has not yet passed - a lot already past due belongs to the
  -- expiry sweep (0043), not this warning.
  for v_pair in
    select bc.business_id, bc.consumer_id
      from public.business_customers bc
     where bc.points_balance > 0
       and exists (
         select 1
           from public.points_transactions pt
          where pt.business_id = bc.business_id
            and pt.consumer_id = bc.consumer_id
            and pt.type = 'earn'
            and pt.expires_at is not null
            and pt.expires_at > now()
            and pt.expires_at <= now() + interval '30 days'
       )
     order by bc.business_id, bc.consumer_id
     limit p_limit
  loop
    -- The soonest expiring lot with a positive remainder, via the SAME shared
    -- primitive the sweep (0043) and the wallet (0043's public.
    -- points_next_expiry) both read - the number this message states is the
    -- number the sweep will eventually take and the number the wallet already
    -- shows.
    select r.expires_at, r.remaining
      into v_lot
      from private.points_lot_remainders(v_pair.business_id, v_pair.consumer_id) r
     where r.remaining > 0
       and r.expires_at is not null
       and r.expires_at > now()
     order by r.expires_at asc, r.txn_id asc
     limit 1;

    -- The candidate scan is a pre-filter (0043's own note on its sibling
    -- sweep applies here too): a pair can match it while its actual soonest
    -- POSITIVE-remainder lot is further out or already fully consumed by a
    -- redemption since the earn landed. Nothing to warn about, correctly.
    if not found then
      continue;
    end if;

    select b.name into v_business_name
      from public.businesses b
     where b.id = v_pair.business_id;

    for v_horizon in
      select * from (values ('30d', interval '30 days'), ('7d', interval '7 days'))
        as h(label, span)
    loop
      if v_lot.expires_at > now() + v_horizon.span then
        continue;
      end if;

      -- Dedupe (see header): this exact lot, at this exact horizon, for this
      -- consumer, has not already been warned about.
      --
      -- Compared as `timestamptz`, NOT as text on both sides: jsonb's own
      -- serialization of a timestamptz value (via jsonb_build_object below)
      -- uses ISO 8601 with a literal `T` separator
      -- ("2026-08-06T04:25:11.661531+00:00"), which is NOT the same string
      -- `v_lot.expires_at::text` would produce (Postgres's native output,
      -- "2026-08-06 04:25:11.661531+00" - a space, and a two-character zone
      -- offset). A text-to-text comparison between the two NEVER matches,
      -- which is exactly the shape of bug this cast closes: every run would
      -- otherwise believe nothing had been warned about yet and duplicate
      -- both rows. Casting `data->>'lot_expires_at'` back to `timestamptz`
      -- compares the same INSTANT regardless of which function produced
      -- which string.
      if exists (
        select 1
          from public.notifications n
         where n.user_id = v_pair.consumer_id
           and n.business_id = v_pair.business_id
           and n.kind = 'points_expiring'
           and (n.data->>'lot_expires_at')::timestamptz = v_lot.expires_at
           and (n.data->>'horizon') = v_horizon.label
      ) then
        continue;
      end if;

      -- The guaranteed channel (doc 30 section 5.2 step 3): sent immediately,
      -- no send to wait for - raise.ts's own in_app row, restated here because
      -- pg_cron cannot reach raise.ts (see header).
      insert into public.notifications
        (user_id, business_id, kind, title, body, data, channel, status, sent_at)
      values (
        v_pair.consumer_id, v_pair.business_id, 'points_expiring',
        'Points expiring soon',
        v_lot.remaining::text || ' pts at ' || coalesce(v_business_name, 'a business')
          || ' expire on ' || to_char(v_lot.expires_at, 'Mon DD, YYYY') || '.',
        jsonb_build_object(
          'lot_expires_at', v_lot.expires_at,
          'horizon', v_horizon.label,
          'points', v_lot.remaining,
          'business_id', v_pair.business_id
        ),
        'in_app', 'sent', now()
      );

      -- The email row (doc 30 section 5.2 step 3's second half): durable and
      -- pending, per the header's honest statement of what this sweep does
      -- and does not achieve for this channel.
      insert into public.notifications
        (user_id, business_id, kind, title, body, data, channel, status)
      values (
        v_pair.consumer_id, v_pair.business_id, 'points_expiring',
        'Points expiring soon',
        v_lot.remaining::text || ' pts at ' || coalesce(v_business_name, 'a business')
          || ' expire on ' || to_char(v_lot.expires_at, 'Mon DD, YYYY') || '.',
        jsonb_build_object(
          'lot_expires_at', v_lot.expires_at,
          'horizon', v_horizon.label,
          'points', v_lot.remaining,
          'business_id', v_pair.business_id
        ),
        'email', 'pending'
      );

      v_notified := v_notified + 1;
    end loop;
  end loop;

  return v_notified;
end
$$;

-- System sweep, service_role ONLY, matching expire_points (0043) and every
-- other scheduler-invoked function in this schema.
revoke execute on function public.points_expiry_warn(integer) from public, anon, authenticated;
grant execute on function public.points_expiry_warn(integer) to service_role;

-- ---------------------------------------------------------------- schedule
-- Doc 39's registered slot: `25 18 * * *` UTC = 02:25 Manila, immediately
-- after the expiry sweep itself (02:10) so a lot the sweep just expired can
-- never ALSO be warned about in the same run.
select cron.schedule(
  'points.expiry_warn',
  '25 18 * * *',
  $job$select public.points_expiry_warn(200);$job$
);
