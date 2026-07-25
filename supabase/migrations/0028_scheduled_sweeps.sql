-- ============================================================================
-- 0028_scheduled_sweeps.sql
-- Scheduled invokers for the two sweeps that have been correct and unreachable.
--
-- Closes two long-standing debts recorded in .superpowers/sdd/progress.md:
--
--   1. public.expire_claims (0016) has never had a caller. Doc 35 section 6
--      and doc 39's schedule registry both name it as an HOURLY job, but the
--      jobs slice that was to own QStash never shipped and no QStash
--      credentials exist. Until now a claimed-but-never-redeemed reward held
--      its inventory and the consumer's points forever.
--   2. A receipt can park at status='processing' with nothing to move it. The
--      pipeline leaves it there deliberately (src/features/receipts/server/
--      process.ts handleOcrFailure) because doc 36 Stage 2 names 'processing'
--      retry-eligible, but processing is inline today so there is no later
--      attempt and no sweeper. Those receipts sit forever.
--
-- Source docs:
--   * docs/30-modules/39-background-jobs.md "Scheduling (QStash schedules)":
--     the cron registry, including `claims expiry | 7 * * * * | hourly at :07`
--     and the hourly jobs reconciler at :50.
--   * docs/30-modules/35-points-engine.md section 6 "Claim expiry sweep"
--     (queue claims.expiry_sweep, hourly, driven by reward_claims_expiry_idx).
--   * docs/30-modules/36-receipt-ocr-pipeline.md "Retry, timeouts, DLQ":
--     attempts exhausted -> receipts.status='rejected', reject_reason='manual',
--     reject_note='processing_failed'.
--   * docs/20-data/25-schema-platform.md (settings shape).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- It does not re-run OCR. pg_cron can only call SQL, and every retry decision
-- (signed URL, provider selection, attempt accounting, injection screening,
-- parse tiers) lives in TypeScript. Reimplementing any of it in plpgsql would
-- create the second pipeline that doc 36 Stage 9 exists to prevent. So the
-- receipts sweep builds only the HONEST half: it lands genuinely-dead receipts
-- in the doc 36 dead-letter state where an operator can see them, and it never
-- touches a receipt that a retry could still save.
--
-- It does not write the points ledger. expire_claims already performs its own
-- reversal correctly under the doc 35 section 5 row lock and none of it is
-- reimplemented here; this migration only schedules it. sweep_stuck_receipts
-- writes exactly one table (public.receipts) and cannot reach the ledger at
-- all: a receipt at 'processing' has no earn row by construction, because
-- award_receipt_points (0018) only runs after the terminal 'approved' write.
--
-- Conventions per 0013 / 0016 / 0018: security definer, set search_path = '',
-- fully qualified references, revoke/grant pairing, service_role only.
-- ============================================================================

-- ---------------------------------------------------------------- pg_cron
-- amendment: 0001_foundations.sql installs every extension `with schema
-- extensions`, and pg_cron cannot follow that convention. Its control file is
-- `relocatable = false` with `schema = pg_catalog`, so a `with schema
-- extensions` clause is rejected outright; the extension script then creates
-- its own `cron` schema and puts cron.job / cron.job_run_details / cron.schedule
-- there. Installing it bare is therefore the only legal form, and it is also
-- what Supabase's own dashboard toggle emits.
--
-- pg_cron is preloaded on hosted Supabase (shared_preload_libraries) and runs
-- jobs against the `postgres` database, which is this database. Jobs run as the
-- role that scheduled them, i.e. `postgres`, which owns both functions below
-- and so retains EXECUTE independently of the app-role revokes.
--
-- No grant on schema cron is issued to anon or authenticated, deliberately:
-- cron.job exposes the whole schedule and cron.job_run_details exposes every
-- error string a sweep has ever raised. The one client-reachable read is
-- public.sweep_job_health below, which is service_role only.
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- settings
-- amendment: `receipts.stuck_processing_hours` is a NEW key, not in doc 26's
-- "Non-DDL registrations" nor in doc 37's default settings registry, because
-- neither doc anticipated a database-side sweeper (both assume QStash owns
-- retry). Registered at platform scope only and read only by the sweep below.
--
-- Platform scope only, and that is a decision rather than an omission: how long
-- the platform waits before declaring a receipt dead is an operational safety
-- net, not a tenant knob. A business-scope override would let one merchant
-- shorten the window and start rejecting their own customers' genuine receipts
-- faster than the platform intends. `ocr.max_attempts`, by contrast, IS read
-- through business scope below, because the settings loader
-- (src/features/receipts/server/settings.ts) already resolves it that way and
-- the sweep must not reject a receipt whose tenant configured a larger budget
-- than the pipeline has spent.
--
-- 24 hours, and it is chosen to be far too long rather than nearly right:
--   * A legitimate OCR call is bounded by the Edge Function's own timeout,
--     seconds not hours. Nothing honest takes 24h.
--   * Doc 36's human review SLA target is < 24h, so a receipt still at
--     'processing' after a full day has already outlived the deadline that
--     governs receipts a human IS looking at.
--   * It spans any plausible transient outage, including a credential rotation
--     noticed the next morning. Rejecting a real customer's genuine purchase is
--     the failure that costs trust and cannot be undone by the consumer;
--     leaving a receipt processing for another hour costs nothing.
-- Idempotent via settings_platform_key_uniq (0017), so replaying this migration
-- never duplicates the key and never clobbers a tuned live value.
insert into public.settings (scope, key, value) values
  ('platform', 'receipts.stuck_processing_hours', '24'::jsonb)
on conflict do nothing;

-- ---------------------------------------------------------------- stuck index
-- The sweep's candidate scan, mirroring reward_claims_expiry_idx (0012), which
-- is what makes expire_claims' own scan free. Partial over the one status that
-- can be stuck, so it stays a handful of pages no matter how many receipts the
-- platform has processed, and a no-op run costs one empty index scan.
create index if not exists receipts_stuck_idx
  on public.receipts (updated_at)
  where status = 'processing';

-- ---------------------------------------------------- sweep_stuck_receipts
-- Doc 36 "Retry, timeouts, DLQ", the half a database can honestly do alone.
--
-- WHAT IT CAN SEE that the application cannot: a receipt nobody is holding.
-- WHAT IT CANNOT DO: re-run OCR. So the only move available is the terminal
-- one, and the whole design is about being sure before making it.
--
-- Three independent conditions must ALL hold before a receipt is touched, and
-- each is there to stop a different way of being wrong:
--
--   1. status = 'processing'. Anything else is already terminal, and the
--      predicate is repeated on the UPDATE so a receipt that finished between
--      the scan and the write is left exactly as the pipeline finished it.
--   2. updated_at older than receipts.stuck_processing_hours. `updated_at` is
--      maintained by the touch_receipts trigger (0017) and, on a processing
--      row, is when the pipeline claimed it: process.ts writes status
--      'processing' once and nothing else updates the row until the terminal
--      write. So this is genuinely "time since last progress", not "time since
--      submission". A merely SLOW receipt is never swept.
--   3. The attempt budget is spent: max(ocr_results.attempt) >= the effective
--      ocr.max_attempts for that receipt's business. This is the same
--      comparison handleOcrFailure makes before it writes the dead-letter
--      state itself, so the sweep can only ever reach the conclusion the
--      pipeline would have reached had it been able to run again.
--
-- A receipt with NO ocr_results row at all (attempts 0) is therefore never
-- swept, since ocr.max_attempts is clamped to at least 1. That is deliberate:
-- zero attempts means the pipeline died before it even recorded an attempt, so
-- there is no evidence that this image was ever the problem, and the honest
-- answer is to leave it for a human rather than to reject it on a guess. The
-- operator sees it in the same query that reads this function's own health.
--
-- IDEMPOTENT AND CONCURRENCY-SAFE, by the 0016 argument exactly:
--   * `for update skip locked` partitions the backlog between overlapping
--     runs and never blocks on a row the live pipeline is writing.
--   * The candidate predicate is `status = 'processing'` and the write flips
--     that status, so a receipt swept once can never be selected again.
--   * The UPDATE re-asserts `status = 'processing'`, so a receipt the app
--     finalized in the same instant is a no-op rather than an overwrite; the
--     counter only counts rows this call actually moved.
--   * A run with no candidates returns 0. That is the correct result, not a
--     failure, and it is what every run should return on a healthy platform.
--
-- Returns how many receipts it moved to the dead-letter state.
create or replace function public.sweep_stuck_receipts(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stuck_hours  integer;
  v_max_attempts integer;
  v_receipt_id   uuid;
  v_swept        integer := 0;
begin
  -- Thresholds are data, not code (doc 37: "defaults live in settings rows
  -- scope='platform', tunable without deploy"). Both reads fall back to the
  -- seeded default rather than failing, and both are clamped, because a
  -- malformed or hostile settings value must not be able to widen the sweep:
  -- a 0-hour window would reject every receipt mid-flight, and a 0-attempt
  -- budget would reject every receipt that has not yet had a single OCR call.
  select nullif(s.value #>> '{}', '')::integer
    into v_stuck_hours
    from public.settings s
   where s.scope = 'platform'
     and s.key = 'receipts.stuck_processing_hours';
  v_stuck_hours := greatest(coalesce(v_stuck_hours, 24), 1);

  select nullif(s.value #>> '{}', '')::integer
    into v_max_attempts
    from public.settings s
   where s.scope = 'platform'
     and s.key = 'ocr.max_attempts';
  v_max_attempts := greatest(coalesce(v_max_attempts, 3), 1);

  for v_receipt_id in
    select r.id
      from public.receipts r
     where r.status = 'processing'
       and r.updated_at <= now() - make_interval(hours => v_stuck_hours)
       -- Condition 3. Both halves are scalar subqueries so the row lock below
       -- applies to public.receipts alone: neither ocr_results nor settings is
       -- locked by this sweep.
       and coalesce(
             (select max(o.attempt)
                from public.ocr_results o
               where o.receipt_id = r.id),
             0)
           >= coalesce(
                -- Business scope wins, matching the settings loader's own
                -- precedence. A tenant that raised its own retry budget must
                -- not have its receipts declared dead at the platform number.
                (select nullif(bs.value #>> '{}', '')::integer
                   from public.settings bs
                  where bs.scope = 'business'
                    and bs.business_id = r.business_id
                    and bs.key = 'ocr.max_attempts'),
                v_max_attempts)
     order by r.updated_at
     limit p_limit
       for update skip locked
  loop
    -- Doc 36's dead-letter contract, verbatim, and identical to what
    -- finalizeWithoutParse writes on the same path: rejected / manual, with
    -- the internal note naming the cause. reject_note is withheld from the
    -- client by 0017's column grant, so 'processing_failed' stays operator
    -- vocabulary and the consumer sees the ordinary 'manual' copy.
    --
    -- reviewed_by / reviewed_at stay null. No human decided this, and writing
    -- a reviewer would put a fiction into the one column the review UI reads
    -- to tell an automatic outcome from a human one.
    update public.receipts
       set status       = 'rejected',
           reject_reason = 'manual',
           reject_note   = 'processing_failed',
           processed_at  = now()
     where id = v_receipt_id
       and status = 'processing';
    if found then
      v_swept := v_swept + 1;
    end if;
  end loop;

  return v_swept;
end
$$;

-- System sweep, service_role ONLY, exactly the 0016 pairing. No consumer and
-- no staff member may reject a receipt by calling this: rejection is either the
-- pipeline's decision or a reviewer's through reviewReceipt, both of which
-- write an outcome someone is accountable for.
revoke execute on function public.sweep_stuck_receipts(integer) from public, anon, authenticated;
grant execute on function public.sweep_stuck_receipts(integer) to service_role;

-- ---------------------------------------------------------- sweep_job_health
-- amendment: not in any doc. A cron job that fails silently is worse than no
-- cron job, and cron.job_run_details is not readable by the roles that would
-- notice: pg_cron enables row level security on it with the policy
-- `username = current_user`, so service_role selecting the table directly sees
-- nothing at all, while anon and authenticated hold no grant on schema cron by
-- design (the error strings are operational detail). A security definer owned
-- by postgres is therefore the only way to surface run outcomes without
-- widening access to the scheduler itself.
--
-- Returns one row per scheduled job with its outcome history over the window,
-- newest run first. `failures` and `last_error` are the two columns an alert
-- would key on. Every job is returned, not just this migration's two, so a job
-- added later is visible here without editing this function.
create or replace function public.sweep_job_health(p_hours integer default 24)
returns table (
  jobname          text,
  schedule         text,
  active           boolean,
  runs             bigint,
  failures         bigint,
  last_status      text,
  last_finished_at timestamptz,
  last_error       text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.jobname::text,
         j.schedule::text,
         j.active,
         count(d.runid)                                          as runs,
         count(d.runid) filter (where d.status <> 'succeeded')    as failures,
         (array_agg(d.status order by d.start_time desc)
            filter (where d.status is not null))[1]::text         as last_status,
         max(d.end_time)                                          as last_finished_at,
         -- The most recent FAILING message, not the most recent message: a
         -- failure followed by a successful run must still be readable, since
         -- an hourly job that fails every other run is broken.
         (array_agg(d.return_message order by d.start_time desc)
            filter (where d.status <> 'succeeded'))[1]::text      as last_error
    from cron.job j
    left join cron.job_run_details d
      on d.jobid = j.jobid
     and d.start_time >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
   group by j.jobname, j.schedule, j.active
   order by j.jobname;
$$;

revoke execute on function public.sweep_job_health(integer) from public, anon, authenticated;
grant execute on function public.sweep_job_health(integer) to service_role;

-- ---------------------------------------------------------------- schedules
-- cron.schedule upserts on (jobname, username), so re-running this migration
-- updates the existing job rather than creating a second one. Both jobs are
-- single statements whose functions are individually idempotent, so a run that
-- overlaps its predecessor (or the live application) is safe by construction.
--
-- CADENCE 1: claims expiry, `7 * * * *`.
-- Taken verbatim from doc 39's schedule registry, and it is right against the
-- TTL. A claim's life is rewards.claim_expiry_days (0012: default 30, check
-- constraint 1 to 365), so the SHORTEST TTL the schema permits is 24 hours.
-- Hourly means a lapsed claim holds its inventory and the consumer's points for
-- at most one extra hour, i.e. at most 1/24 of the tightest legal TTL and about
-- 1/720 of the default. Sweeping more often (every 5 minutes, say) would run 12
-- times the scans to shave an already-sub-hour hold; sweeping daily would, on a
-- 1-day TTL, leave the last unit of a reward's inventory locked for as long
-- again as the claim was ever valid. :07 also keeps the offset stagger doc 39
-- specifies (temp cleanup at :23, reconciler at :50).
--
-- CADENCE 2: stuck receipts, `50 * * * *`.
-- amendment: doc 39's queue registry has no receipts sweeper, because it
-- assumed QStash would retry. :50 is the slot doc 39 gives the hourly jobs
-- reconciler, which is what this is: the honest half of one.
-- Hourly against a 24-hour threshold means 23 runs in 24 find nothing, and that
-- is the intended shape. The scan is one partial-index probe, so an empty run
-- is free, and the payoff is bounded discovery latency: once a receipt crosses
-- the threshold it reaches the operator's queue within the hour instead of
-- within a day. Running it daily would add up to 24 hours to a delay that is
-- already deliberately long; running it every 5 minutes would buy nothing,
-- because the threshold, not the cadence, is what decides when a receipt is
-- declared dead.
select cron.schedule(
  'claims.expiry_sweep',
  '7 * * * *',
  $job$select public.expire_claims(200);$job$
);

select cron.schedule(
  'receipts.stuck_sweep',
  '50 * * * *',
  $job$select public.sweep_stuck_receipts(200);$job$
);
