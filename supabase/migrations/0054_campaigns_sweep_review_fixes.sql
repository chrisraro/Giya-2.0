-- ============================================================================
-- 0054_campaigns_sweep_review_fixes.sql
-- Review fixes (task 2.1) to 0053's public.sweep_campaigns. Never edit 0053 in
-- place - it is already applied (supabase/README.md's 0011b/0047 precedent) -
-- so this is a companion `create or replace function` carrying the SAME
-- signature, re-picked up by the existing `campaigns.sweep` cron job (0053)
-- without any change to its schedule row.
--
-- ---------------------------------------------------------------------------
-- I1 - the T3 skip WAS the 0045 shape, and the ordering made it worse
-- ---------------------------------------------------------------------------
-- 0053 argued (in its own header and in the task report) that a skipped
-- scheduled row - one whose business is not currently 'active' - is
-- "correctly re-selected every run" and therefore NOT the 0045 starvation
-- bug, because "not yet activated, still due" stays genuinely true of it.
-- That argument is wrong in exactly the way 0045's own header describes: it
-- treats "the row still has something it might eventually need" as if it
-- were the same thing as "the row is still occupying the sweep's WORK
-- BUDGET productively". 0053's T3 predicate was
-- `status = 'scheduled' and starts_at <= now()`, with the business-standing
-- check living INSIDE the loop body rather than the WHERE clause - so a row
-- whose business will NEVER become active again (`businesses.status`
-- includes the terminal value `'closed'`, 0002) matches that predicate
-- forever. Worse than 0045's case: 0053 orders by `starts_at`, so once such
-- a row is skipped it is never touched again, its `starts_at` never moves,
-- and it therefore sorts EARLIER than every campaign scheduled after it on
-- every subsequent run. Enough permanently-skipped rows (`p_limit` of them)
-- and every later-scheduled, gate-passing campaign silently never
-- activates - not merely delayed, exactly as unbounded as 0045's own
-- silent-non-enforcement failure mode. Latent today only because nothing in
-- `src/` can put a campaign into `scheduled` yet (the T1 `schedule` action
-- exists in `../src/features/campaigns/lifecycle.ts`'s edge table but no
-- server action calls it) - 0045's own I1 was equally latent when it was
-- fixed anyway, for the same reason: shipping a sweep that starves the
-- moment its precondition becomes reachable is not a acceptable trade against
-- fixing it now, while it costs nothing to change.
--
-- THE FIX, per 0045's own precedent: put the condition in the WHERE clause,
-- not the loop body, so an unresolvable row never enters candidacy - never
-- occupies a `p_limit` slot - in the first place. Campaign-visible semantics
-- are UNCHANGED: a due campaign on a non-active business still simply stays
-- `scheduled`, gets no audit row, raises no error, and is re-evaluated fresh
-- on every subsequent run the moment `exists(...)` starts matching again
-- (proven live: reactivating the business makes the very next run activate
-- it - see the pgTAP addition below). What changes is that the scan itself
-- now only ever returns actionable rows, so the budget can never be consumed
-- by a row that cannot be acted on.
--
-- The in-loop business-status recheck is KEPT, deliberately not deleted: the
-- WHERE clause's `exists(...)` and the per-row lock are not atomic with each
-- other (the campaigns row is locked `for update skip locked`; the
-- `businesses` row it names is not), so a business could in principle flip
-- out of `'active'` in the narrow window between the scan snapshot and this
-- row's lock. The recheck is what stops that race from activating a campaign
-- whose business just lost standing; after this fix it is a defensive
-- backstop for a race, not the sweep's primary skip mechanism, which the
-- WHERE clause now is.
--
-- ---------------------------------------------------------------------------
-- I3 - `raise notice` reached nobody
-- ---------------------------------------------------------------------------
-- NOTICE is below Postgres's default `log_min_messages = warning`, so it was
-- never written to the server log, and pg_cron's `cron.job_run_details`
-- records the command's completion status and (on failure) its error
-- string - never a NOTICE raised by a successful run. The skip message was
-- therefore unreachable by either read path 0053's own report claimed for
-- it. Changed to `raise warning`, which clears the default log threshold and
-- is readable via `mcp__supabase__get_logs` / the dashboard's Postgres logs -
-- the same severity band `sweep_stuck_receipts`/`expire_points`'s own error
-- paths use for conditions worth an operator's attention that are not
-- exceptions.
--
-- ---------------------------------------------------------------------------
-- MINOR - T7 unconditionality is now pinned by a fixture, not just asserted
-- by construction
-- ---------------------------------------------------------------------------
-- No SQL change here (T7 already had no G1 check and none is added), but the
-- pgTAP suite gained a campaign on the SUSPENDED business, `active` and past
-- `ends_at`, asserted ended anyway - so a future change that accidentally
-- added a business-standing check to T7 would fail a test rather than ship
-- silently.
--
-- Also noted, not fixed (architectural, predates this sweep): a `scheduled`
-- campaign whose `ends_at` has ALSO already passed, on a business that never
-- returns to `'active'`, is a permanent dead end - T3's (fixed) candidacy
-- requires an active business and T7 only ever scans `status in
-- ('active','paused')`, and doc 34's own edge set
-- (`../src/features/campaigns/lifecycle.ts`'s `ALLOWED_TRANSITIONS`) has no
-- `scheduled -> ended` edge at all ("a scheduled campaign is unscheduled back
-- to draft first"). Such a campaign sits `scheduled` with a stale `ends_at`
-- until a human unschedules it; the sweep has no lifecycle edge available to
-- resolve it and inventing one is out of this task's scope.
-- ============================================================================

create or replace function public.sweep_campaigns(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign        record;
  v_business_status text;
  v_processed       integer := 0;
begin
  -- ---------------------------------------------------------- T3: scheduled -> active
  -- I1 fix: `exists(... business active)` moved into the WHERE clause, so a
  -- campaign whose business cannot currently be activated never occupies a
  -- p_limit slot at all - the scan itself only ever returns actionable rows.
  for v_campaign in
    select c.id, c.business_id
      from public.campaigns c
     where c.status = 'scheduled'
       and c.starts_at <= now()
       and c.deleted_at is null
       and exists (
             select 1 from public.businesses b
              where b.id = c.business_id
                and b.status = 'active'
           )
     order by c.starts_at, c.id
     limit p_limit
       for update skip locked
  loop
    -- Race backstop only (see migration header): the exists() above is not
    -- atomic with this row's lock, so a business could flip out of 'active'
    -- in between. Re-verified here so that narrow window still cannot
    -- activate a campaign whose business just lost standing.
    select b.status
      into v_business_status
      from public.businesses b
     where b.id = v_campaign.business_id;

    if v_business_status is distinct from 'active' then
      raise warning
        '[campaigns.sweep] skip activating campaign % - business % status=%',
        v_campaign.id, v_campaign.business_id, coalesce(v_business_status, 'unknown');
      continue;
    end if;

    update public.campaigns
       set status = 'active'
     where id = v_campaign.id
       and status = 'scheduled';

    if found then
      insert into public.audit_logs
        (actor_id, actor_kind, actor_role, business_id, action,
         entity_type, entity_id, before, after, reason, request_id)
      values
        (null, 'system', null, v_campaign.business_id, 'campaign.activated',
         'campaign', v_campaign.id,
         jsonb_build_object('status', 'scheduled'),
         jsonb_build_object('status', 'active', 'trigger', 'sweep'),
         'Campaign auto-activated by campaigns.sweep: starts_at reached.',
         null);

      v_processed := v_processed + 1;
    end if;
  end loop;

  -- ---------------------------------------------------------- T7: active|paused -> ended
  -- Unchanged: unconditional (no G1 check, no exists() needed - nothing here
  -- gates on business standing by design). Both source statuses share one
  -- scan - the UPDATE's own `status = v_campaign.from_status` predicate is
  -- what keeps each row's transition self-clearing regardless of which of
  -- the two it started from.
  for v_campaign in
    select c.id, c.business_id, c.status as from_status
      from public.campaigns c
     where c.status in ('active', 'paused')
       and c.ends_at <= now()
       and c.deleted_at is null
     order by c.ends_at, c.id
     limit p_limit
       for update skip locked
  loop
    update public.campaigns
       set status = 'ended'
     where id = v_campaign.id
       and status = v_campaign.from_status;

    if found then
      insert into public.audit_logs
        (actor_id, actor_kind, actor_role, business_id, action,
         entity_type, entity_id, before, after, reason, request_id)
      values
        (null, 'system', null, v_campaign.business_id, 'campaign.ended',
         'campaign', v_campaign.id,
         jsonb_build_object('status', v_campaign.from_status),
         jsonb_build_object('status', 'ended', 'trigger', 'sweep'),
         'Campaign auto-ended by campaigns.sweep: ends_at reached.',
         null);

      v_processed := v_processed + 1;
    end if;
  end loop;

  return v_processed;
end
$$;

-- Grants unaffected by create-or-replace (privileges attach to the function
-- object, which keeps its identity across a same-signature replace); no
-- revoke/grant repeated here since 0053's already-live grant is unchanged.
-- Confirmed by the pgTAP grant matrix re-run below.
