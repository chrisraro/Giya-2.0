-- ============================================================================
-- FILE NUMBER vs LEDGER NAME - read this before trusting either.
--
-- This file was authored as `0058_job_health_alerts.sql` and APPLIED LIVE
-- under that name: `supabase_migrations.schema_migrations` carries
-- `20260806110554 | 0058_job_health_alerts`. It was renamed to 0059 on merge
-- because task 2.2's deployment correction was authored concurrently in a
-- separate checkout and also took 0058 (`20260806111225 |
-- 0058_balance_check_deployment_correction`), and a file set with two 0058s
-- has no defined replay order.
--
-- Both are applied live, with distinct version timestamps, in the order
-- job-health-alerts then balance-check-correction. Supabase keys on the
-- timestamp, not the filename, so the live ledger is correct and unambiguous;
-- only the FILENAME changed, and the body is byte-identical to what ran.
--
-- The two are independent - this one creates `job_alert_state` and touches no
-- function the other recreates - so a fresh replay in filename order
-- (correction, then this) reaches the same schema as the live order.
--
-- Recorded here rather than silently renamed, per the same rule that governs
-- `0011b` and the 0042/0057 incidents: when the file set and the database
-- disagree about a name, the disagreement gets written down where the next
-- person will find it.
-- ============================================================================

-- ============================================================================
-- 0058_job_health_alerts.sql
-- job_alert_state: the dedupe memory behind task 2.5's "alert a human when a
-- scheduled job fails" check.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- public.sweep_job_health (0028) has existed since the sweeps shipped and
-- progress.md records the gap plainly: "nothing alerts on failures>0 -
-- sweep_job_health is the query, there is no alerting surface yet." The
-- TypeScript checker this migration supports (src/lib/alerts/job-health.ts)
-- is that surface. It runs periodically (an external scheduler, not pg_cron -
-- pg_cron can only call SQL and this check must send email through the
-- existing Resend gateway), and a periodic, stateless serverless invocation
-- has no memory of its own: without a durable row, every run would look like
-- the first sighting of whatever is currently wrong, and "one alert per
-- incident" (the brief's requirement) would be impossible to tell apart from
-- "one alert per check".
--
-- ---------------------------------------------------------------------------
-- THE DEDUPE KEY IS THE JOB NAME, AND ONLY THE JOB NAME - THIS IS THE LESSON
-- 0048 SHIPPED, APPLIED HERE ON PURPOSE
-- ---------------------------------------------------------------------------
-- 0048's header (task 1.3, N3) records a dedupe key that moved for reasons
-- unrelated to whether the underlying situation was new: the points-expiry
-- warning keyed on a projected figure that drifted every night as a window
-- edge advanced, so a consumer who never did anything got re-notified in a
-- channel this codebase's own registry (src/features/notifications/kinds.ts)
-- calls unrecallable. The fix there keyed on the one value that is stable for
-- as long as the SAME situation persists (the soonest lot's own expires_at)
-- and changes only when the situation genuinely changes.
--
-- This table applies the same rule. The primary key is `jobname` alone - not
-- `jobname + last_error text` (a provider that includes a request id or a
-- timestamp in its error string would mint a "new" incident on every single
-- failure of the SAME bug, the exact 0048 defect one layer over), not
-- `jobname + failure count` (the count increases every run by construction,
-- so it can never repeat and dedupe would never fire at all), and not
-- `jobname + last_finished_at` (changes on every run, healthy or not, for the
-- same reason). "This job is currently unhealthy" is a fact about the job,
-- not about which run most recently proved it, so the job's own name is the
-- only part of the state that is stable for exactly as long as the incident
-- is the same incident - and a row's ABSENCE is what "healthy" means, so the
-- key resets for free the moment the checker deletes it on recovery, with no
-- separate status column to fall out of sync with reality.
--
-- ---------------------------------------------------------------------------
-- WHAT EACH COLUMN IS FOR
-- ---------------------------------------------------------------------------
--   since           when THIS incident started - set once, on the row's
--                   first insert, and never touched again while the row
--                   exists. This is what lets the alert honestly say "failing
--                   for 6h" instead of "failing since the last time I
--                   happened to check".
--   last_alerted_at when the checker last actually composed an alert for this
--                   incident. The brief: "A job failing every hour for a day
--                   is one alert plus, at most, a daily reminder - not
--                   twenty-four." The checker compares now() against this
--                   column (in TypeScript, not SQL - see job-health.ts) to
--                   decide whether the ongoing incident has earned its next
--                   reminder.
--   last_detail     the most recent failure text or staleness description,
--                   kept for an operator inspecting this table directly; not
--                   read back by the checker's own dedupe logic.
--
-- A row's PRESENCE is "currently unhealthy and already alerted at least
-- once"; its ABSENCE is "healthy, or never yet seen as unhealthy". The
-- checker deletes the row the moment a job's sweep_job_health read comes back
-- healthy, which is the reset the brief requires ("resets when it clears")
-- and is also why there is no separate boolean status column here to
-- disagree with the row's own existence.
--
-- ---------------------------------------------------------------------------
-- THE FENCE: SERVICE ROLE ONLY, NO POLICIES AT ALL - THE 0029 SHAPE
-- ---------------------------------------------------------------------------
-- Every reader and writer of this table is the alert checker itself, running
-- under the service role exactly like `jobs` (0029). There is no client
-- audience, so RLS is enabled with ZERO policies (a loud 42501 rather than a
-- silent empty set) and the privileges are revoked underneath it, same
-- reasoning as 0029's header states at length: a leaked read here would tell
-- a client which of the platform's own sweeps are currently broken, which is
-- exactly the kind of operational fact 0029 already keeps behind this same
-- fence for `jobs`.
-- ============================================================================

create table public.job_alert_state (
  -- The dedupe key. See the header: stable for the life of one incident,
  -- resets by the row simply being deleted on recovery.
  jobname         text primary key check (btrim(jobname) <> ''),

  -- When this incident was first observed. Immutable after insert; only a
  -- fresh incident (a fresh row, after the previous one was deleted on
  -- recovery) ever gets a new value here.
  since           timestamptz not null,

  -- When the checker last actually composed an alert (the first sighting, or
  -- the most recent daily reminder while the incident is still open).
  last_alerted_at timestamptz not null,

  -- Free text for an operator reading this table directly. Not part of the
  -- dedupe decision - see the header on why the decision must not depend on
  -- anything that varies run to run.
  last_detail     text,

  updated_at      timestamptz not null default now()
);
alter table public.job_alert_state enable row level security;

create trigger touch_job_alert_state
  before update on public.job_alert_state
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------- policies
-- NONE. Deliberately - see the header. RLS is enabled so the absence of a
-- policy is a DENY rather than an oversight.

-- ---------------------------------------------------------------- fence 1 of 2
-- Privilege layer, client roles. Supabase grants every privilege on a new
-- public table to anon and authenticated by default (0029's header states
-- this plainly), so without this a client would reach RLS and get a polite
-- empty set instead of the loud "you may not look at this" that is the
-- honest answer.
revoke select, insert, update, delete, truncate on public.job_alert_state
  from anon, authenticated;

-- ---------------------------------------------------------------- fence 2 of 2
-- Privilege layer, service_role. SELECT / INSERT / UPDATE / DELETE all stay:
-- the checker reads current state, inserts a new incident, refreshes
-- last_alerted_at on a reminder, and deletes the row on recovery - that is
-- its whole lifecycle. TRUNCATE goes, mirroring every other service-role
-- table in this schema (0022, 0026, 0029): no legitimate operation empties
-- this table in one statement, and the checker's own recovery path is a
-- per-row delete, never a bulk one.
revoke truncate on public.job_alert_state from service_role;

-- Statement trigger restating the TRUNCATE revoke at the layer that survives
-- a future re-grant, same shape as 0022/0026/0029's and here for the same
-- reason: a row-level trigger never fires on TRUNCATE at all.
create or replace function private.job_alert_state_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'job_alert_state cannot be truncated (per-row delete only, see 0058)';
end
$$;

create trigger job_alert_state_no_truncate
  before truncate on public.job_alert_state
  for each statement execute function private.job_alert_state_no_truncate();
