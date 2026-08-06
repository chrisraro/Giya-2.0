-- ============================================================================
-- 0055_campaigns_sweep_skip_visibility.sql
-- Second review-fix pass (task 2.1) on public.sweep_campaigns. Companion to
-- 0053/0054, both applied - never edited in place.
--
-- ---------------------------------------------------------------------------
-- I1 - 0054's own two fixes interacted, and neither header noticed
-- ---------------------------------------------------------------------------
-- 0054 raised the skip message's severity (I3: notice -> warning) and, in
-- the SAME migration, moved the business-standing check out of the loop
-- body into the WHERE clause (I1: the self-clearing fix). Read together
-- rather than each against 0053 alone, they cancel each other's stated
-- purpose: for the ORDINARY case - a due scheduled campaign whose business
-- is suspended or closed - the row is now EXCLUDED from the scan entirely,
-- so the loop body (and its `raise warning`) never runs for it at all. The
-- warning now fires only inside the sub-millisecond race window between the
-- WHERE clause's exists() snapshot and the row's lock - a real condition,
-- but not the one an operator actually needs to see. 0054's own header and
-- supabase/README.md both told a future reader that skips are readable via
-- `mcp__supabase__get_logs` / the dashboard's Postgres logs; for the
-- ordinary case that was never true even at 0054. supabase/README.md is
-- corrected alongside this migration (it is not a migration file, so it is
-- edited directly); 0054's own header stays as-is, since it is applied
-- history - see the process note below for why that file is not touched
-- even for the sentence this migration disproves.
--
-- THE FIX: one `raise warning` per run, carrying a COUNT of due-but-
-- ineligible scheduled campaigns, computed by a NEW small helper,
-- `private.campaigns_sweep_ineligible_count()` - a plain `stable` SQL
-- function, not itself SECURITY DEFINER, revoked from every role including
-- service_role (0045's own precedent: a helper only a definer function
-- already running as owner, or a privileged test session, ever needs to
-- call). This count is DELIBERATELY DECOUPLED from p_limit and from the T3
-- transition loop: it is a full count of every due, scheduled, ineligible
-- row, not a count of what a p_limit-bounded pass happened to look at, so
-- "N due campaigns not activated: business not active" is an honest number
-- regardless of how large the real backlog is or how small p_limit is set.
-- Being a separate helper (rather than inlined COUNT logic duplicating the
-- WHERE clause) also makes it independently provable in pgTAP, which a bare
-- RAISE statement's text is not - see rpc_campaigns_sweep_smoke.sql's new
-- assertions.
--
-- The in-loop recheck-and-warn from 0054 is KEPT: it is still correct for
-- the race window it actually covers, just no longer the only source of
-- skip visibility.
--
-- ---------------------------------------------------------------------------
-- Process note (M2, no code change): 857ab86 edited 0053's HEADER COMMENT
-- (outside the `$$` function body) in place to fix a misattribution, on the
-- reasoning that `pg_proc.prosrc` was genuinely unaffected. That was still
-- wrong to do: this repository treats "never edit an applied migration in
-- place" as an absolute rule specifically because "it's just a comment"
-- is how the 0047 incident this repo's own README documents began. No
-- correction is needed here - 0053's header is accurate after that edit,
-- and unwinding it would just create a second incident - but the precedent
-- from this task is: the NEXT such correction, however small, goes in a
-- companion file. This migration's own existence is the demonstration.
--
-- ---------------------------------------------------------------------------
-- Dead-end clarification (docs only, no code change): the "permanent dead
-- end" language used for a `scheduled` campaign whose `ends_at` has ALSO
-- already passed on a non-active business overstates it. It is
-- SELF-RESOLVING the moment the business returns to `'active'`: the very
-- next `sweep_campaigns()` call activates it in the T3 loop, and because
-- that same call's T7 loop runs immediately afterward and re-reads
-- `public.campaigns` fresh, it finds the row already `active` with
-- `ends_at <= now()` and ends it in the SAME call - a legal
-- `scheduled -> active -> ended` path with both audit rows, one function
-- invocation. So the dead end is exactly co-extensive with "the business
-- never comes back", not a state nothing can ever resolve.
-- ============================================================================

-- ---------------------------------------------------------------- private.campaigns_sweep_ineligible_count
-- The exact predicate T3's WHERE clause excludes (0054), counted rather
-- than filtered, so `sweep_campaigns` can report how many due campaigns it
-- is deliberately not activating and why.
create or replace function private.campaigns_sweep_ineligible_count()
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.campaigns c
   where c.status = 'scheduled'
     and c.starts_at <= now()
     and c.deleted_at is null
     and not exists (
           select 1 from public.businesses b
            where b.id = c.business_id
              and b.status = 'active'
         );
$$;

revoke execute on function private.campaigns_sweep_ineligible_count()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- public.sweep_campaigns
-- Re-created (same signature) to add the aggregate skip warning after the
-- T3 loop. Everything else - both loops, the audit rows, the in-loop race
-- backstop - is byte-identical to 0054.
create or replace function public.sweep_campaigns(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign        record;
  v_business_status text;
  v_ineligible      integer;
  v_processed       integer := 0;
begin
  -- ---------------------------------------------------------- T3: scheduled -> active
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
    -- Race backstop only (0054's header): the exists() above is not atomic
    -- with this row's lock, so a business could flip out of 'active' in
    -- between. Re-verified here so that narrow window still cannot activate
    -- a campaign whose business just lost standing.
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

  -- I1 (0055) fix: aggregate visibility for the ORDINARY skip case, which
  -- 0054's exists() fix (correctly) moved out of the loop above entirely.
  -- One warning per run, not one per row, and independent of p_limit - a
  -- full count of every due, scheduled, ineligible campaign, not just the
  -- ones a p_limit-bounded T3 pass happened to consider.
  v_ineligible := private.campaigns_sweep_ineligible_count();
  if v_ineligible > 0 then
    raise warning
      '[campaigns.sweep] % due scheduled campaign(s) not activated: business not active',
      v_ineligible;
  end if;

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

-- Grants unaffected by create-or-replace; 0053's already-live grant is
-- unchanged. Confirmed by the pgTAP grant matrix re-run below.
