-- ============================================================================
-- 0053_campaigns_sweep.sql
-- The `campaigns.sweep` job: closes doc 34's two time-driven transitions that
-- had nothing firing them. `service.ts`'s `emitLifecycleEvent` has carried
-- `// TODO(api): wire analytics + the ends_at sweep worker (doc 39)` since
-- task 1.7 - a merchant who schedules a campaign for next Monday got nothing
-- on Monday, and a campaign whose `ends_at` passed kept reading `active` to
-- any caller that checks status alone (isCampaignLive additionally checks the
-- window, so consumer-facing liveness was never wrong - but the portal list,
-- the admin queue and every other status-only reader were).
--
-- T3 `scheduled -> active` at `starts_at`, T7 `active|paused -> ended` at
-- `ends_at` (docs/30-modules/34-campaign-engine.md section 2, the sweep
-- worker subsection). Same idiom as 0028's two sweeps and 0043/0045's points
-- expiry sweep: SECURITY DEFINER, service_role only, `for update skip
-- locked`, ordered + limited candidate scan, self-clearing by construction.
--
-- ---------------------------------------------------------------------------
-- WHY T3 DOES NOT RE-RUN THE FULL ACTIVATION GATE SET
-- ---------------------------------------------------------------------------
-- Doc 34's table entry for T3 says "G1-G3 re-checked (cheap subset)", but this
-- task's brief narrows that deliberately to G1 alone (business standing).
-- G2 (payload completeness) and G3 (schedule sanity) were already true at
-- schedule time and are properties of rows the sweep itself is not
-- authorized to fix if they somehow regressed (a payload row soft-deleted
-- after scheduling is a merchant-portal problem, not something a robot
-- should paper over by activating anyway or by silently unscheduling). G1 is
-- different in kind: `businesses.status` is exactly the one gate input that
-- can change AFTER scheduling for a reason that has nothing to do with the
-- campaign - the business can be suspended. (Doc 34's own T5 already gives
-- "system" a pause trigger, though for a different cause - budget exhaustion,
-- section 6, task 1.2's exhaustion.ts - not business standing; the point
-- carried over here is only that "system" acting on a live campaign is
-- already a precedented shape in this state machine, not that T5 shares this
-- specific reason.) A business that has lost `active` status must not have a
-- campaign switched on by a robot; the campaign is left `scheduled` and
-- re-evaluated on the next tick, exactly as it would be if the merchant had
-- not yet clicked "activate now" themselves.
--
-- T7 (`ends_at -> ended`) carries no such gate, on either edge of doc 34's
-- table or this brief: an ended window ends regardless of business standing,
-- because "ended" is a downgrade, not a grant of anything.
--
-- ---------------------------------------------------------------------------
-- SELF-CLEARING, PER 0045'S LESSON
-- ---------------------------------------------------------------------------
-- 0045 shipped a sweep (`expire_points`) whose candidate predicate stayed
-- true forever for a pair that had nothing left to expire, silently starving
-- every pair beyond `p_limit`. The two candidate scans here cannot repeat
-- that shape: each predicate is `status = <source> AND <time column> <= now()`,
-- and the only thing either loop body does to a processed row is flip
-- `status` via an UPDATE that re-asserts the very predicate that selected it.
-- A row this sweep transitions can therefore never match its own scan again -
-- there is no second condition (like 0043's EXISTS-only past-due check) that
-- could stay satisfied after the transition already happened. The one case
-- that is NOT self-clearing by design is a SKIPPED row (G1 failed): it stays
-- `status = 'scheduled'` and is correctly re-selected every run, because
-- "not yet activated, still due" remains true of it until the business
-- either regains `active` standing or a human intervenes - that is not the
-- 0045 bug, it is the intended behaviour this brief asks for in section 3.
--
-- ---------------------------------------------------------------------------
-- INDEX
-- ---------------------------------------------------------------------------
-- 0012's `campaigns_active_window_idx` already covers the T3 scan
-- (`status = 'scheduled' and starts_at <= now()`) but its predicate is
-- `status in ('scheduled','active')`, which excludes `paused` rows entirely -
-- a paused-past-ends_at candidate could never be found through it. Widened
-- here (drop + create, since a partial index predicate cannot be altered in
-- place) to `status in ('scheduled','active','paused')`, covering both scans
-- this migration adds without touching 0012's file.
-- ============================================================================

drop index if exists public.campaigns_active_window_idx;
create index campaigns_active_window_idx on public.campaigns (status, starts_at, ends_at)
  where status in ('scheduled','active','paused') and deleted_at is null;   -- campaigns.sweep (34/39)

-- ---------------------------------------------------------------- sweep_campaigns
-- Doc 34 section 2 T3/T7. Reuses the app's own `campaign.<transition>` audit
-- vocabulary (`src/features/campaigns/server/audit.ts`'s
-- CAMPAIGN_LIFECYCLE_ACTIONS - 'campaign.activated' / 'campaign.ended') and the
-- `after.trigger` discriminator task 1.7 introduced ('manual' for every
-- staff-initiated transition in service.ts; 'sweep' here), rather than
-- inventing a parallel verb like 'campaign.activated_by_sweep' that would
-- fragment the same vocabulary 0022/task 1.7 unified. `actor_kind = 'system'`,
-- `actor_id`/`actor_role` null - 0022/0012's documented meaning of
-- "system/worker", matching `exhaustion.ts`'s post-commit pause row exactly.
--
-- Two independent candidate scans, each bounded by p_limit (so a caller
-- controls both halves' chunk size the way 0028/0043's single-scan sweeps
-- control theirs), returning the combined count of rows actually
-- transitioned (skipped rows are not counted - nothing happened to them).
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
  for v_campaign in
    select c.id, c.business_id
      from public.campaigns c
     where c.status = 'scheduled'
       and c.starts_at <= now()
       and c.deleted_at is null
     order by c.starts_at, c.id
     limit p_limit
       for update skip locked
  loop
    select b.status
      into v_business_status
      from public.businesses b
     where b.id = v_campaign.business_id;

    -- G1 only (see migration header): a business that is not currently
    -- 'active' must not have this campaign switched on by the sweep. Left
    -- 'scheduled' - re-evaluated next tick, never errored, never activated.
    if v_business_status is distinct from 'active' then
      raise notice
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
  -- Unconditional (no G1 check): an ended window ends regardless of business
  -- standing. Both source statuses share one scan - the UPDATE's own
  -- `status = v_campaign.from_status` predicate is what keeps each row's
  -- transition self-clearing regardless of which of the two it started from.
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

-- System sweep, service_role ONLY - the 0016/0028/0043 pairing. No merchant
-- and no consumer may flip a campaign's lifecycle status by calling this
-- directly; every legitimate transition either goes through
-- src/features/campaigns/server/service.ts (staff-initiated, 'manual') or
-- this function (time-driven, 'sweep').
revoke execute on function public.sweep_campaigns(integer) from public, anon, authenticated;
grant execute on function public.sweep_campaigns(integer) to service_role;

-- ---------------------------------------------------------------- schedule
-- Doc 34 section 3's sweep-worker subsection: "queue campaigns.sweep ...
-- every 5 minutes". cron.schedule upserts on (jobname, username), so
-- re-running this migration updates the existing job rather than duplicating
-- it, matching 0028's own idempotency note.
select cron.schedule(
  'campaigns.sweep',
  '*/5 * * * *',
  $job$select public.sweep_campaigns(200);$job$
);
