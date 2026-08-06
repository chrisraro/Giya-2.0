import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendEmail } from "@/lib/email/send";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/send";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import { estimateMaxGapMinutes } from "./cron-interval";

// =============================================================================
// checkJobHealth(): task 2.5, "make a failing scheduled job actually reach a
// human". Reads public.sweep_job_health (0028) - already the only readable
// window onto pg_cron's own run history (see that migration's header on why
// nothing else can see it) - and turns "a job has failures" or "a job has
// gone quiet" into one email per incident.
// =============================================================================
//
// -----------------------------------------------------------------------------
// WHY THIS SENDS THROUGH sendEmail() DIRECTLY, NOT THROUGH THE notify.email
// QUEUE / src/features/notifications/server/raise.ts
// -----------------------------------------------------------------------------
// The brief's recipient is "an optional env var (an ops address)" - a bare
// email string with no account behind it. Every existing delivery path in
// this codebase is addressed to a `profiles.id`: raise.ts's `userId` inserts
// a `notifications` row whose `user_id` column is `not null references
// profiles(id)` (0026), and the notify.email worker resolves the send
// address FROM THAT ROW via `auth.admin.getUserById` (src/workers/notify/
// email.ts's `readAddress`). There is no profile for "ops"; inventing one
// (a synthetic staff account with no login, no purpose but existing to
// satisfy a foreign key) would be a second identity concept for one
// throwaway address, and it is expressly out of scope - the brief asks for
// an env var, not an onboarding flow.
//
// What this module reuses instead is the one thing that actually IS "the
// email path" underneath both: `sendEmail` (src/lib/email/send.ts), the sole
// Resend integration this codebase has. `src/workers/notify/email.ts` is a
// CALLER of that function, not a second provider; this module is a second
// caller of the same function, exactly the way email.ts's own `deps.send ??
// sendEmail` is already written to be overridden. No new HTTP client, no new
// provider account, no second implementation of "send an email" - which is
// what "do not build a second email path" actually forbids.
//
// The STAFF_FACING_KINDS / consumers-row-suppression mechanism in email.ts
// (task 1.2's widening for `campaign_budget_exhausted`) is real and worth
// knowing about, but it exists to gate `notifications` ROWS addressed to
// real profiles - it has nothing to bypass here, because this path never
// creates a `notifications` row or a `profiles` lookup in the first place.
// Re-deriving it (a second STAFF_FACING-shaped set somewhere) would be
// exactly the "re-widening it a second way" the brief warns against; not
// touching that mechanism at all is how this avoids it.
//
// -----------------------------------------------------------------------------
// DEDUPE: see supabase/migrations/0058_job_health_alerts.sql's header for the
// full argument. Short version: the key is the job's own name, because that
// is the one part of "this job is currently unhealthy" that stays stable for
// exactly as long as the SAME incident is open and changes the moment it
// stops being open - unlike a failure count (always increases), a
// last_finished_at (changes every run, healthy or not) or raw error text
// (can carry a request id or timestamp and mint a "new" incident on every
// occurrence of the SAME bug). That is precisely the class of bug 0048
// shipped a fix for (task 1.3's projected-figure dedupe key), cited by name
// in the brief.
//
// -----------------------------------------------------------------------------
// TWO INDEPENDENT WAYS A JOB IS UNHEALTHY
// -----------------------------------------------------------------------------
// `failing`: its most recent recorded run did not succeed. Read from
// `last_status`, not from `failures > 0` in the window - a job that failed
// nine times yesterday and has now been succeeding for a day is HEALTHY, and
// keying on the failure count would keep alerting on the sum of its
// history rather than its current state.
//
// `stale`: it has gone quiter than its own schedule can honestly explain.
// This is the half sweep_job_health alone cannot tell an operator (the brief,
// verbatim: "a job that silently stopped being scheduled ... is the one
// sweep_job_health alone will not tell you about") - a job with zero runs in
// the window looks IDENTICAL to a job that was never registered, unless
// something also knows how often it was supposed to run. `schedule` (raw pg_
// cron syntax, straight off `cron.job`) is read through estimateMaxGapMinutes
// (./cron-interval.ts) to answer that, with a 2x-plus-5-minutes grace window
// so an on-time run near the boundary of a check cycle is never mistaken for
// a missed one.
//
// -----------------------------------------------------------------------------
// THE WINDOW: 192 HOURS, NOT sweep_job_health's OWN 24H DEFAULT
// -----------------------------------------------------------------------------
// src/lib/observability/metrics.ts calls sweep_job_health with its documented
// default (24h) because its job is "recent run history for a dashboard".
// This module's job is different: proving a WEEKLY job (this wave's
// `cleanup.devices`-shaped schedules, `M H * * D`) has gone quiet requires
// enough history to have seen at least one of its expected runs, and a 24h
// window can never contain one. 192h (8 days) is the smallest window that
// covers every cadence this codebase's schedule registry actually uses with
// one full cycle of slack. See classifyRow() below for what happens when a
// job's gap is WIDER than even this window (an honest "cannot tell" null,
// never a guess).
// =============================================================================

/**
 * Wide enough to prove a weekly job (`M H * * D`) has gone quiet - the
 * widest cadence this codebase's schedule registry uses - with a full cycle
 * of slack. See the module header.
 */
export const JOB_ALERT_WINDOW_HOURS = 24 * 8;

/**
 * "at most a daily reminder" per the brief. An incident that stays open
 * re-alerts at most once per this interval; a check inside it is a no-op for
 * an already-known incident.
 */
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The staleness threshold is `gap * MULTIPLIER + BUFFER_MINUTES`, not the raw
 * gap: pg_cron's own scheduling jitter and this check's own cadence (it does
 * not run at the exact instant a job was due) both cost a few minutes for
 * free, and doubling the gap absorbs one whole missed cycle before calling a
 * job stale rather than firing on the very first late minute of the next
 * one.
 */
const STALE_GRACE_MULTIPLIER = 2;
const STALE_GRACE_BUFFER_MINUTES = 5;

const LOG_PREFIX = "[alerts/job-health]";

export interface JobHealthDeps {
  /** SERVICE ROLE. sweep_job_health (0028) and job_alert_state (0058) are
   * both service_role-only; see either migration's header. */
  readonly supabase: SupabaseClient<Database>;
  /** Injected in tests; defaults to the real Resend gateway. */
  readonly send?: (input: SendEmailInput) => Promise<SendEmailResult>;
  /** Injected in tests for deterministic dedupe/reminder timing. */
  readonly now?: () => Date;
  /**
   * Injectable override for tests. `undefined` (the default) resolves from
   * `process.env.OPS_ALERT_EMAIL`; an explicit `null` forces "not
   * configured" without touching the environment.
   */
  readonly opsAddress?: string | null;
}

/** The production wiring. `null` when the service-role key is absent,
 * matching every sibling module (src/lib/observability/metrics.ts,
 * src/features/notifications/server/raise.ts). */
export function defaultJobHealthDeps(): JobHealthDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) return null;
  return { supabase };
}

export type JobHealthReason = "failing" | "stale";

export interface JobIncident {
  readonly jobname: string;
  readonly schedule: string;
  readonly reason: JobHealthReason;
  readonly detail: string;
  readonly lastFinishedAt: string | null;
  /** When THIS incident began - stable across every check while it stays
   * open, per the module header's dedupe argument. */
  readonly since: string;
}

export interface JobHealthReport {
  readonly checkedAt: string;
  readonly checkedJobs: number;
  /** Every job currently unhealthy, alerted this run or not. */
  readonly unhealthy: readonly JobIncident[];
  /** The subset of `unhealthy` an alert was actually composed for this run
   * (a new incident, or an open one due its daily reminder) - independent of
   * whether it could be SENT; see `sent` and `opsAddressConfigured`. */
  readonly alerted: readonly JobIncident[];
  readonly opsAddressConfigured: boolean;
  /** How many of `alerted`'s emails the provider actually accepted. */
  readonly sent: number;
}

interface SweepRow {
  jobname: string;
  schedule: string;
  active: boolean;
  runs: number;
  failures: number;
  last_status: string | null;
  last_finished_at: string | null;
  last_error: string | null;
}

interface StateRow {
  jobname: string;
  since: string;
  last_alerted_at: string;
  last_detail: string | null;
}

/**
 * Run the check: read current job health, decide which jobs are unhealthy,
 * dedupe against `job_alert_state`, and email the ops address for every
 * genuinely new or reminder-due incident.
 *
 * NEVER THROWS. Every read degrades independently and the function still
 * returns a report - see the module header and, for the convention this
 * follows, src/lib/observability/metrics.ts's own header.
 */
export async function checkJobHealth(
  deps: JobHealthDeps | null = defaultJobHealthDeps(),
): Promise<JobHealthReport | null> {
  if (deps === null) return null;

  const { supabase } = deps;
  const now = deps.now?.() ?? new Date();
  const send = deps.send ?? sendEmail;
  const opsAddress = resolveOpsAddress(deps);

  const { data: sweepData, error: sweepError } = await supabase.rpc("sweep_job_health", {
    p_hours: JOB_ALERT_WINDOW_HOURS,
  });

  if (sweepError !== null) {
    console.error(`${LOG_PREFIX} sweep_job_health read failed`, sweepError);
    return {
      checkedAt: now.toISOString(),
      checkedJobs: 0,
      unhealthy: [],
      alerted: [],
      opsAddressConfigured: opsAddress !== null,
      sent: 0,
    };
  }

  const rows = (sweepData ?? []) as SweepRow[];

  const { data: stateData, error: stateError } = await supabase
    .from("job_alert_state")
    .select("jobname, since, last_alerted_at, last_detail");

  if (stateError !== null) {
    // Degrades to "no incident is currently open for anyone" - every
    // unhealthy job below is then treated as new. Over-alerting once is a
    // far safer failure than a broken read silently suppressing every
    // alert forever.
    console.error(
      `${LOG_PREFIX} job_alert_state read failed; treating every unhealthy job as a new incident`,
      stateError,
    );
  }
  const stateByJob = new Map<string, StateRow>();
  for (const row of (stateData ?? []) as StateRow[]) {
    stateByJob.set(row.jobname, row);
  }

  const unhealthy: JobIncident[] = [];
  const toAlert: JobIncident[] = [];
  const upserts: StateRow[] = [];
  const clears: string[] = [];

  for (const row of rows) {
    // An intentionally unscheduled job (0028's `active` column) is not this
    // check's business - see classifyRow's header note.
    if (!row.active) continue;

    const classification = classifyRow(row, now);
    const existing = stateByJob.get(row.jobname);

    if (classification === null) {
      if (existing !== undefined) clears.push(row.jobname);
      continue;
    }

    const isNewIncident = existing === undefined;
    const since = isNewIncident ? now.toISOString() : existing.since;
    const incident: JobIncident = {
      jobname: row.jobname,
      schedule: row.schedule,
      reason: classification.reason,
      detail: classification.detail,
      lastFinishedAt: row.last_finished_at,
      since,
    };
    unhealthy.push(incident);

    const dueForReminder =
      !isNewIncident &&
      now.getTime() - Date.parse(existing.last_alerted_at) >= REMINDER_INTERVAL_MS;

    if (isNewIncident || dueForReminder) {
      toAlert.push(incident);
      upserts.push({
        jobname: row.jobname,
        since,
        last_alerted_at: now.toISOString(),
        last_detail: classification.detail,
      });
    }
  }

  // Persist dedupe-state changes before sending. Best effort: a write
  // failure here costs at most a duplicate or missed reminder on the NEXT
  // check, never silently drops the alert this run is about to send.
  await Promise.all([
    ...upserts.map(async (row) => {
      const { error } = await supabase
        .from("job_alert_state")
        .upsert(row, { onConflict: "jobname" });
      if (error !== null) {
        console.error(`${LOG_PREFIX} could not persist alert state for ${row.jobname}`, error);
      }
    }),
    ...clears.map(async (jobname) => {
      const { error } = await supabase.from("job_alert_state").delete().eq("jobname", jobname);
      if (error !== null) {
        console.error(`${LOG_PREFIX} could not clear recovered alert state for ${jobname}`, error);
      }
    }),
  ]);

  let sent = 0;
  for (const incident of toAlert) {
    if (opsAddress === null) {
      // Genuinely optional per the brief: the check still ran, still found
      // and recorded the incident, it simply has nowhere configured to send
      // it. Not an error.
      console.warn(
        `${LOG_PREFIX} ${incident.jobname}: ${incident.reason} (${incident.detail}) - OPS_ALERT_EMAIL is not configured, not sending`,
      );
      continue;
    }

    const message = composeAlert(incident, now);
    const result = await send({
      to: opsAddress,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (result.ok) {
      sent += 1;
    } else {
      console.error(`${LOG_PREFIX} alert send failed for ${incident.jobname}: ${result.reason}`);
    }
  }

  return {
    checkedAt: now.toISOString(),
    checkedJobs: rows.length,
    unhealthy,
    alerted: toAlert,
    opsAddressConfigured: opsAddress !== null,
    sent,
  };
}

/**
 * A job's health this check, or `null` when it is healthy (or its schedule's
 * shape makes a staleness call dishonest - see estimateMaxGapMinutes).
 *
 * `failing` is checked first and wins over `stale`: a job with a fresh
 * failure is a stronger, more specific fact than "has it been long enough
 * since a success", and the two are rarely both true at once (a job stale
 * enough to trip the gap check has usually stopped producing ANY run
 * details, `last_status` included).
 */
function classifyRow(
  row: SweepRow,
  now: Date,
): { reason: JobHealthReason; detail: string } | null {
  const failing = row.last_status !== null && row.last_status !== "succeeded";
  if (failing) {
    return {
      reason: "failing",
      detail: row.last_error ?? `last run did not succeed (status: ${row.last_status})`,
    };
  }

  const gapMinutes = estimateMaxGapMinutes(row.schedule);
  if (gapMinutes === null) return null; // unknown cadence shape - no honest call to make

  const thresholdMs = (gapMinutes * STALE_GRACE_MULTIPLIER + STALE_GRACE_BUFFER_MINUTES) * 60_000;

  if (row.last_finished_at !== null) {
    const sinceLastRun = now.getTime() - Date.parse(row.last_finished_at);
    if (sinceLastRun <= thresholdMs) return null;
    return {
      reason: "stale",
      detail: `no successful run observed since ${row.last_finished_at} (schedule "${row.schedule}" expects one roughly every ${gapMinutes}m)`,
    };
  }

  // No run at all inside the tracked window. Only conclusive when the
  // window is wide enough to have caught at least one expected run - see
  // the module header on why JOB_ALERT_WINDOW_HOURS is 192, not 24.
  if (thresholdMs > JOB_ALERT_WINDOW_HOURS * 3_600_000) return null;

  return {
    reason: "stale",
    detail: `no run observed in the tracked ${JOB_ALERT_WINDOW_HOURS}h window (schedule "${row.schedule}" expects one roughly every ${gapMinutes}m)`,
  };
}

/** The five plausible-email characters: local@domain.tld, no whitespace. Not
 * RFC 5322 - a local-only sanity check, same spirit as src/lib/supabase/
 * service.ts re-validating SUPABASE_SERVICE_ROLE_KEY's length itself rather
 * than trusting a schema no code path for this variable goes through (see
 * below on why OPS_ALERT_EMAIL is never added to src/lib/env.ts). */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The ops recipient, or `null` when none is configured or the configured
 * value is not plausibly an address.
 *
 * Reads `process.env.OPS_ALERT_EMAIL` DIRECTLY rather than through
 * `getServerEnv()`/src/lib/env.ts, and validates locally rather than with a
 * schema `.min()`/regex - the exact pattern src/lib/supabase/service.ts's
 * header documents for SUPABASE_SERVICE_ROLE_KEY and
 * src/app/api/internal/metrics/route.ts's header documents for
 * METRICS_TOKEN. Both explain the same failure this avoids: getServerEnv()
 * validates its WHOLE object as one unit and throws naming every missing
 * key, so routing an optional, low-stakes variable through it would let a
 * blank OPS_ALERT_EMAIL (or a typo in an unrelated required key) take down
 * every other caller of getServerEnv() - REDEMPTION_TOKEN_SECRET,
 * UPSTASH_REDIS_REST_URL, the queue publisher - over a variable those
 * callers never read. A malformed value here costs exactly one thing: this
 * one check does not send mail, and says so in the log.
 */
function resolveOpsAddress(deps: JobHealthDeps): string | null {
  if (deps.opsAddress !== undefined) return deps.opsAddress;

  const raw = process.env.OPS_ALERT_EMAIL;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!EMAIL_SHAPE.test(trimmed)) {
    console.warn(
      `${LOG_PREFIX} OPS_ALERT_EMAIL is set but is not a plausible email address; treating it as unset`,
    );
    return null;
  }
  return trimmed;
}

function composeAlert(
  incident: JobIncident,
  now: Date,
): { subject: string; text: string; html: string } {
  const duration = formatDuration(now.getTime() - Date.parse(incident.since));
  const headline =
    incident.reason === "stale"
      ? `${incident.jobname} has not run when expected`
      : `${incident.jobname} is failing`;

  const lines = [
    `Job: ${incident.jobname}`,
    `Schedule: ${incident.schedule}`,
    `Problem: ${incident.detail}`,
    `Ongoing for: ${duration} (since ${incident.since})`,
    incident.lastFinishedAt !== null
      ? `Last finished run: ${incident.lastFinishedAt}`
      : "Last finished run: none observed in the tracked window",
    "",
    "Where to look:",
    `  select * from cron.job_run_details d join cron.job j on j.jobid = d.jobid`,
    `   where j.jobname = '${incident.jobname}' order by d.start_time desc limit 20;`,
    "  (service_role only; see supabase/migrations/0028_scheduled_sweeps.sql)",
    "Runbook: docs/50-ops/52-monitoring-observability.md",
  ];

  const text = lines.join("\n");
  return {
    subject: `[Giya ops] ${headline}`,
    text,
    html: `<pre>${escapeHtml(text)}</pre>`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
