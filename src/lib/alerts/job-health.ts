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
// nothing else can see it) - and turns "a job has failures", "a job has gone
// quiet" or "a job was never scheduled at all" into one email per incident.
//
// Review fix (post-merge review of the first cut): this header and the
// classifier below were rewritten to fix two false-positive/false-negative
// bugs (C2), a window that could never prove a weekly job stale (I1), a
// dedupe bug that could swallow an alert for 24h on a retryable send failure
// (I2), a flapping job paging up to 12x/day (I4), and a blind spot where a
// job that stopped being scheduled ENTIRELY was invisible (I5). Each fix is
// explained at its own point below rather than only here.
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
// -----------------------------------------------------------------------------
// DEDUPE: see supabase/migrations/0059_job_health_alerts.sql's header for the
// full argument (filed as 0059, applied live as 0058_job_health_alerts - see
// that file's own top note on the ledger-name mismatch). Short version: the
// key is the job's own name, because that is the one part of "this job is
// currently unhealthy" that stays stable for exactly as long as the SAME
// incident is open and changes the moment it stops being open - unlike a
// last_finished_at (changes every run, healthy or not) or raw error text
// (can carry a request id or timestamp and mint a "new" incident on every
// occurrence of the SAME bug). That is precisely the class of bug 0048
// shipped a fix for (task 1.3's projected-figure dedupe key), cited by name
// in the brief.
//
// One correction to that migration's own header, made HERE rather than by
// editing an applied migration (never done - see supabase/README.md's 0011b
// note): its `since` column comment implies the first alert for an incident
// can say something like "failing for 6h". It cannot. `since` is set to the
// moment THIS CHECKER first observes the problem, not to an objectively
// earlier start time sweep_job_health has no per-run timestamps to derive -
// so the FIRST alert for any incident always reports a duration near zero.
// The value the column buys is real, but it only shows up starting with the
// first 24h reminder (composeAlert()'s "Ongoing for" line), which is exactly
// when "how long has this been going on" becomes the question worth asking.
//
// -----------------------------------------------------------------------------
// THREE INDEPENDENT WAYS A JOB IS UNHEALTHY
// -----------------------------------------------------------------------------
// `not_scheduled`: an EXPECTED job (see EXPECTED_JOBS below) is either
// entirely absent from `cron.job` or present with `active=false`. This is
// the brief's headline case, verbatim: "a job that silently stopped being
// scheduled ... is the one sweep_job_health alone will not tell you about."
// Both halves matter and neither was covered by the first cut: skipping
// every `active=false` row unconditionally (as it did) means a job flipped
// inactive is silently ignored, and `cron.unschedule` removes the `cron.job`
// row ENTIRELY, so a job that vanishes that way was never even seen by a
// loop that only iterates the rows sweep_job_health returns. Checking a
// fixed EXPECTED_JOBS list against the returned set catches both.
//
// This is not hypothetical. Live on this project as of 2026-08-06,
// `cron.job_run_details` holds two genuine failures nobody has ever seen -
// `sweep_stuck_receipts` raising `ERROR: LIMIT must not be negative` on
// 2026-07-25 - belonging to a jobid `cron.job` no longer has a row for: an
// orphaned run history, simultaneously proof of the exact gap this whole
// task closes and a live instance of this specific `not_scheduled` case.
//

// `failing`: checked TWO ways, because one signal alone is wrong in both
// directions (the review's finding, C2):
//   1. The most recent run's own status is the terminal 'failed' state.
//      NOT `!== 'succeeded'` - pg_cron's `cron.job_run_details.status` also
//      passes through 'starting', 'running' and 'sending' before landing on
//      'succeeded' or 'failed', and a check that lands mid-run must not page
//      on an in-flight status that will resolve on its own.
//   2. Genuine, TERMINAL failures happened recently even though the MOST
//      RECENT run happened to succeed (or is in flight) - an
//      intermittently-flapping job, e.g. one failing every other run. This
//      is read from a SEPARATE RPC call, `public.sweep_job_terminal_failures`
//      (0061) - NOT a second call to sweep_job_health with a narrower
//      window, which was the first review-fix pass's own mistake (C2,
//      second finding): sweep_job_health's `failures` column is `count(...)
//      filter (where status <> 'succeeded')`, and every in-flight status
//      satisfies that filter too, so a TypeScript predicate reading it can
//      never tell "genuinely failed" from "simply still running" - the
//      distinction is destroyed before it reaches application code, no
//      matter what window the RPC is called with. `campaigns.sweep` runs
//      every 5 minutes, so a check landing mid-run is routine, and the first
//      fix (reading `sweep_job_health.failures` over a 24h window) paged on
//      it every time. `sweep_job_terminal_failures` counts only `status =
//      'failed'` - see that migration's header for why this could not be
//      fixed by editing 0028 and had to be a new function.
//
//      RECENT_WINDOW_HOURS (24h, matching sweep_job_health's own documented
//      default and 0028's "the window" framing) still bounds this call, and
//      that bound is still what makes "genuinely recovered" a meaningful,
//      non-flappy signal (I4 below): a 24h-bounded TERMINAL failure count
//      ages OUT after a full day failure-free, without ever keying on the
//      ever-growing whole-history failure count the first cut's header
//      correctly rejected.
//
// `stale`: gone quieter than its own schedule can honestly explain - see
// classifyKnownJob() and the STALE_WINDOW_HOURS note below for the window-
// math fix (I1).
//
// -----------------------------------------------------------------------------
// WHY RECOVERY REQUIRES A CLEAN 24H, NOT JUST ONE SUCCESSFUL RUN (I4)
// -----------------------------------------------------------------------------
// The first cut cleared a job's dedupe state (and so was willing to alert
// again) the instant its MOST RECENT run succeeded. For a job flapping every
// other run, that is a fresh "new incident" on every single failure: the
// review's probe found 3 sends across 6 checks alternating fail/succeed/fail.
// Recovery now requires the SAME 24h window used for the flapping check
// above to show zero failures - so a flapping job's incident stays open
// (and reminder-throttled) for as long as it keeps flapping, and clears only
// once it has gone a full day clean. This is a real, deliberate trade
// (recovery lags a genuine last-minute fix by up to 24h) made in exchange
// for the alerting channel not becoming something an operator learns to
// ignore.
// =============================================================================

/**
 * The window `public.sweep_job_terminal_failures` (0061) is called with for
 * "has this job genuinely failed recently", independent of the wide
 * staleness window below. Matches sweep_job_health's own documented default
 * and src/lib/observability/metrics.ts's SWEEP_HEALTH_WINDOW_HOURS - this is
 * "the window" 0028's header already establishes as the unit doc 39 reasons
 * about failures in.
 */
export const RECENT_WINDOW_HOURS = 24;

/**
 * The wide window used ONLY for staleness (has this job gone quiet longer
 * than its own schedule explains).
 *
 * Review fix (I1): the first cut used 192h (8 days) and its own header
 * claimed that was "the smallest window that covers every cadence ... with
 * one full cycle of slack" - false for the one cadence (weekly) it was
 * chosen for. The bug is structural, not a rounding error: a job's
 * `last_finished_at` can only be VISIBLE within whatever window this module
 * asks sweep_job_health for, which means the "found but old" staleness
 * branch below can only ever fire when the window is WIDER than the
 * staleness threshold itself - and the first cut's window was narrower than
 * its own weekly threshold (11520 min of window vs a 20165 min threshold),
 * making that branch dead code for the one cadence it existed to catch.
 *
 * 504h (21 days) is chosen the same way `staleThresholdMinutes` is chosen
 * below: comfortably ABOVE the widest threshold this codebase's schedule
 * shapes produce (weekly, `M H * * D`: 10080 min gap * 2 + 5 = 20165 min =
 * ~336h), with a margin (168h, another full week) so a job whose last run
 * sits right at the threshold boundary is still visible in the "found but
 * old" branch rather than falling into the coarser "not found at all"
 * branch. See job-health.test.ts's "I1" suite, which pins the arithmetic
 * directly rather than trusting this comment.
 */
export const STALE_WINDOW_HOURS = 24 * 21;

/**
 * "at most a daily reminder" per the brief. An incident that stays open
 * re-alerts at most once per this interval; a check inside it is a no-op for
 * an already-known incident UNLESS the previous alert attempt did not
 * actually reach anyone - see the I2 note on ALERT_NOT_YET_DELIVERED below.
 */
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The staleness threshold for a job whose expected gap is `gapMinutes`: the
 * gap itself, doubled, plus a small fixed buffer. Doubling absorbs one whole
 * missed cycle (pg_cron jitter and this check's own cadence both cost a few
 * minutes for free) before calling a job stale, rather than firing on the
 * very first late minute of the next one. Exported so its relationship to
 * STALE_WINDOW_HOURS can be asserted directly rather than trusted - see the
 * comment on that constant.
 */
export function staleThresholdMinutes(gapMinutes: number): number {
  return gapMinutes * STALE_GRACE_MULTIPLIER + STALE_GRACE_BUFFER_MINUTES;
}

const STALE_GRACE_MULTIPLIER = 2;
const STALE_GRACE_BUFFER_MINUTES = 5;

/**
 * Sentinel `last_alerted_at` meaning "an alert was owed but never confirmed
 * delivered" - the epoch, which is always more than REMINDER_INTERVAL_MS in
 * the past, so the very next check retries unconditionally rather than
 * waiting out a reminder window for a message nobody received.
 *
 * Review fix (I2): the first cut persisted `last_alerted_at = now()` BEFORE
 * attempting the send, so a retryable Resend failure (or simply no
 * OPS_ALERT_EMAIL configured yet) silently started the 24h dedupe clock for
 * an alert that was never actually delivered - the exact opposite of what
 * its own comment claimed. State is now written AFTER the send attempt,
 * using its real outcome: `now()` on confirmed delivery, this sentinel on
 * anything else (send failure OR no address configured). The sentinel also
 * directly fixes M5 (an operator wiring OPS_ALERT_EMAIL in mid-incident
 * hears about it on the very next check, not up to 24h later), because it is
 * the same "was this incident ever actually told to anyone" question either
 * way.
 */
const ALERT_NOT_YET_DELIVERED = new Date(0).toISOString();

/**
 * Every job doc 39's schedule registry (plus task 2.2's `integrity.
 * balance_check`, 0056-0058) actually schedules via pg_cron TODAY, confirmed
 * live against `cron.job` on 2026-08-06. This is deliberately the live set,
 * not the aspirational one: doc 39 also lists `cleanup.devices`,
 * `fraud.ring_sweep` and a weekly `integrity.balance_check {mode:'full'}`
 * that no migration has scheduled yet, and listing a job here that does not
 * exist would page every single check forever with "not scheduled" for
 * something nobody ever intended to schedule today.
 *
 * This is the registry I5 requires: sweep_job_health only reports on rows
 * `cron.job` currently HAS, so a job removed by `cron.unschedule` (which
 * deletes the row outright, unlike `active=false`) is invisible to a loop
 * that only iterates what came back. Comparing this fixed list against the
 * returned set catches that; comparing each returned row's `active` flag
 * against membership in this list catches the OTHER half (flipped inactive
 * without being unscheduled).
 *
 * A job added to pg_cron later without an entry here is invisible to THIS
 * specific check (the "did it go missing" one) but still fully covered by
 * the `failing` / `stale` checks below, which iterate every ACTIVE row
 * sweep_job_health returns regardless of this list - so the failure mode of
 * forgetting to update this list is "a newly-added job's own disappearance
 * goes unnoticed", not "a newly-added job's failures go unnoticed".
 */
export const EXPECTED_JOBS: readonly string[] = [
  "campaigns.sweep",
  "claims.expiry_sweep",
  "integrity.balance_check",
  "points.expiry_sweep",
  "points.expiry_warn",
  "receipts.stuck_sweep",
];

const LOG_PREFIX = "[alerts/job-health]";

export interface JobHealthDeps {
  /** SERVICE ROLE. sweep_job_health (0028) and job_alert_state (0058/filed as
   * 0059) are both service_role-only; see either migration's header. */
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

export type JobHealthReason = "failing" | "stale" | "not_scheduled";

export interface JobIncident {
  readonly jobname: string;
  readonly schedule: string;
  readonly reason: JobHealthReason;
  readonly detail: string;
  readonly lastFinishedAt: string | null;
  /** When THIS incident began - stable across every check while it stays
   * open, per the module header's dedupe argument. See the header correction
   * on what this does and does not tell you about the FIRST alert. */
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

/** public.sweep_job_terminal_failures (0061)'s row shape - deliberately NOT
 * SweepRow's `failures`/`last_error`, which count in-flight runs too. See
 * the module header (C2) and that migration's own header for why this is a
 * separate function rather than a second field on the existing one. */
interface TerminalFailureRow {
  jobname: string;
  terminal_runs: number;
  terminal_failures: number;
  last_terminal_error: string | null;
}

interface StateRow {
  jobname: string;
  since: string;
  last_alerted_at: string;
  last_detail: string | null;
}

/** Never returns null/undefined shape surprises - the shared empty report for
 * every early-exit path (an RPC failure, or an unexpected throw under M4). */
function emptyReport(now: Date, opsAddressConfigured: boolean): JobHealthReport {
  return {
    checkedAt: now.toISOString(),
    checkedJobs: 0,
    unhealthy: [],
    alerted: [],
    opsAddressConfigured,
    sent: 0,
  };
}

/**
 * Run the check: read current job health (both windows), decide which jobs
 * are unhealthy, dedupe against `job_alert_state`, and email the ops address
 * for every genuinely new or reminder-due incident.
 *
 * NEVER THROWS (M4: this is now actually true, not only claimed - the whole
 * body below the null-deps guard runs inside a try/catch that degrades to
 * `emptyReport` on anything unexpected, the same shape every early-return
 * below already used for an RPC failure specifically).
 */
export async function checkJobHealth(
  deps: JobHealthDeps | null = defaultJobHealthDeps(),
): Promise<JobHealthReport | null> {
  if (deps === null) return null;

  const now = deps.now?.() ?? new Date();
  const opsAddress = resolveOpsAddress(deps);

  try {
    return await runCheck(deps, now, opsAddress);
  } catch (error) {
    console.error(`${LOG_PREFIX} unexpected failure running the check`, error);
    return emptyReport(now, opsAddress !== null);
  }
}

async function runCheck(
  deps: JobHealthDeps,
  now: Date,
  opsAddress: string | null,
): Promise<JobHealthReport> {
  const { supabase } = deps;
  const send = deps.send ?? sendEmail;

  const [terminalResult, wideResult] = await Promise.all([
    supabase.rpc("sweep_job_terminal_failures", { p_hours: RECENT_WINDOW_HOURS }),
    supabase.rpc("sweep_job_health", { p_hours: STALE_WINDOW_HOURS }),
  ]);

  if (terminalResult.error !== null || wideResult.error !== null) {
    console.error(
      `${LOG_PREFIX} sweep_job_health/sweep_job_terminal_failures read failed`,
      terminalResult.error ?? wideResult.error,
    );
    return emptyReport(now, opsAddress !== null);
  }

  const wideRows = (wideResult.data ?? []) as SweepRow[];
  const terminalRows = (terminalResult.data ?? []) as TerminalFailureRow[];
  const wideByJob = new Map(wideRows.map((r) => [r.jobname, r] as const));
  const terminalByJob = new Map(terminalRows.map((r) => [r.jobname, r] as const));

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

  // Every job worth a verdict this run: everything sweep_job_health returned
  // (evaluated for failing/stale) UNION every job this codebase expects to
  // exist (evaluated for not_scheduled even when cron.job has no row for it
  // at all - see EXPECTED_JOBS's header on why that union is required).
  const allJobNames = new Set<string>([...EXPECTED_JOBS, ...wideRows.map((r) => r.jobname)]);

  const unhealthy: JobIncident[] = [];
  const toAlert: JobIncident[] = [];
  const clears: string[] = [];

  for (const jobname of allJobNames) {
    const wideRow = wideByJob.get(jobname);
    const isExpected = EXPECTED_JOBS.includes(jobname);

    let classification: { reason: JobHealthReason; detail: string } | null;

    if (isExpected && (wideRow === undefined || !wideRow.active)) {
      classification = {
        reason: "not_scheduled",
        detail:
          wideRow === undefined
            ? `expected job "${jobname}" has no cron.job entry at all - check whether it was cron.unschedule()'d`
            : `job "${jobname}" is registered in cron.job but marked inactive (active=false)`,
      };
    } else if (wideRow === undefined || !wideRow.active) {
      // An unexpected job, intentionally inactive or simply not one this
      // check tracks. Not this check's business.
      continue;
    } else {
      classification = classifyKnownJob(wideRow, terminalByJob.get(jobname), now);
    }

    const existing = stateByJob.get(jobname);

    if (classification === null) {
      if (existing !== undefined) clears.push(jobname);
      continue;
    }

    const isNewIncident = existing === undefined;
    const since = isNewIncident ? now.toISOString() : existing.since;
    const incident: JobIncident = {
      jobname,
      schedule: wideRow?.schedule ?? "(not registered)",
      reason: classification.reason,
      detail: classification.detail,
      lastFinishedAt: wideRow?.last_finished_at ?? null,
      since,
    };
    unhealthy.push(incident);

    const dueForReminder =
      !isNewIncident &&
      now.getTime() - Date.parse(existing.last_alerted_at) >= REMINDER_INTERVAL_MS;

    if (isNewIncident || dueForReminder) {
      toAlert.push(incident);
    }
  }

  // Recovery clears immediately, independent of send outcomes below - a
  // healthy job's state row is stale information the moment it is read.
  await Promise.all(
    clears.map(async (jobname) => {
      const { error } = await supabase.from("job_alert_state").delete().eq("jobname", jobname);
      if (error !== null) {
        console.error(`${LOG_PREFIX} could not clear recovered alert state for ${jobname}`, error);
      }
    }),
  );

  // Review fix (I2): state is written AFTER the send attempt and reflects
  // its REAL outcome - see ALERT_NOT_YET_DELIVERED's header. This is the
  // one loop that decides both "did we tell anyone" and "do we owe a state
  // write", so the two can never disagree the way they did in the first cut.
  let sent = 0;
  for (const incident of toAlert) {
    let delivered = false;

    if (opsAddress === null) {
      // Genuinely optional per the brief: the check still ran, still found
      // and recorded the incident, it simply has nowhere configured to send
      // it. Not an error - but also not "delivered", so the sentinel below
      // makes sure the very next check (once an address IS configured)
      // retries rather than waiting out a reminder window for nothing.
      console.warn(
        `${LOG_PREFIX} ${incident.jobname}: ${incident.reason} (${incident.detail}) - OPS_ALERT_EMAIL is not configured, not sending`,
      );
    } else {
      const message = composeAlert(incident, now);
      const result = await send({
        to: opsAddress,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });

      if (result.ok) {
        delivered = true;
        sent += 1;
      } else {
        console.error(`${LOG_PREFIX} alert send failed for ${incident.jobname}: ${result.reason}`);
      }
    }

    const { error } = await supabase.from("job_alert_state").upsert(
      {
        jobname: incident.jobname,
        since: incident.since,
        last_alerted_at: delivered ? now.toISOString() : ALERT_NOT_YET_DELIVERED,
        last_detail: incident.detail,
      } satisfies StateRow,
      { onConflict: "jobname" },
    );
    if (error !== null) {
      console.error(`${LOG_PREFIX} could not persist alert state for ${incident.jobname}`, error);
    }
  }

  return {
    checkedAt: now.toISOString(),
    checkedJobs: allJobNames.size,
    unhealthy,
    alerted: toAlert,
    opsAddressConfigured: opsAddress !== null,
    sent,
  };
}

/**
 * A KNOWN, ACTIVE job's health this check (the not_scheduled case is decided
 * by the caller, before this is reached), or `null` when it is healthy (or
 * its schedule's shape makes a staleness call dishonest - see
 * estimateMaxGapMinutes).
 *
 * Order matters and is deliberate: a definitive terminal failure (1) beats a
 * recent-window flap (2) beats staleness (3), because each is a strictly
 * more specific fact than the one after it, and a job cannot be BOTH stale
 * (has not run) and failing (has run and it went badly) at once.
 */
function classifyKnownJob(
  wideRow: SweepRow,
  terminalRow: TerminalFailureRow | undefined,
  now: Date,
): { reason: JobHealthReason; detail: string } | null {
  // 1. Terminal failure on the most recent recorded run. NOT `!==
  //    'succeeded'` - see the module header (C2): 'starting', 'running' and
  //    'sending' are real, common, in-flight values of the same column and
  //    must never read as a failure.
  if (wideRow.last_status === "failed") {
    return {
      reason: "failing",
      detail: wideRow.last_error ?? "the most recent recorded run failed",
    };
  }

  // 2. Flapping: the most recent run happened to succeed (or is in flight),
  //    but GENUINE, TERMINAL failures happened within the last
  //    RECENT_WINDOW_HOURS. Read from `sweep_job_terminal_failures` (0061),
  //    NOT from sweep_job_health's `failures` - see the module header (C2)
  //    and that migration's own header for why `failures` as 0028 defines
  //    it (`status <> 'succeeded'`) cannot be used here at all: it counts
  //    an in-flight run as a failure, so a job merely caught mid-run by this
  //    check would page. `terminal_failures` counts only `status = 'failed'`.
  const terminalFailures = terminalRow?.terminal_failures ?? 0;
  if (terminalFailures > 0) {
    const terminalRuns = terminalRow?.terminal_runs ?? terminalFailures;
    const errorText = terminalRow?.last_terminal_error ?? wideRow.last_error;
    const summary = `${terminalFailures} of ${terminalRuns} runs failed in the last ${RECENT_WINDOW_HOURS}h`;
    return {
      reason: "failing",
      detail: errorText !== null ? `${errorText} (${summary})` : summary,
    };
  }

  // 3. Staleness.
  const gapMinutes = estimateMaxGapMinutes(wideRow.schedule);
  if (gapMinutes === null) return null; // unknown cadence shape - no honest call to make

  const thresholdMs = staleThresholdMinutes(gapMinutes) * 60_000;

  if (wideRow.last_finished_at !== null) {
    const sinceLastRun = now.getTime() - Date.parse(wideRow.last_finished_at);
    if (sinceLastRun <= thresholdMs) return null;
    return {
      reason: "stale",
      detail: `no successful run observed since ${wideRow.last_finished_at} (schedule "${wideRow.schedule}" expects one roughly every ${gapMinutes}m)`,
    };
  }

  // No run at all inside the tracked window. Only conclusive when the
  // window is wide enough to have caught at least one expected run - see
  // STALE_WINDOW_HOURS's header on why it is 504, not 192.
  if (thresholdMs > STALE_WINDOW_HOURS * 3_600_000) return null;

  return {
    reason: "stale",
    detail: `no run observed in the tracked ${STALE_WINDOW_HOURS}h window (schedule "${wideRow.schedule}" expects one roughly every ${gapMinutes}m)`,
  };
}

/** The five plausible-email characters: local@domain.tld, no whitespace. Not
 * RFC 5322 - a local-only sanity check, same spirit as src/lib/supabase/
 * service.ts re-validating SUPABASE_SERVICE_ROLE_KEY's length itself rather
 * than trusting a schema no code path for this variable goes through. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The ops recipient, or `null` when none is configured or the configured
 * value is not plausibly an address.
 *
 * Review fix (I3): OPS_ALERT_EMAIL IS declared in src/lib/env.ts's
 * serverEnvSchema (`z.string().optional()`, no `.min()`/format constraint) -
 * what the METRICS_TOKEN precedent the brief pointed at actually does. What
 * the brief's constraint bans is a length/format FLOOR in the schema (a
 * `.min()` there would make getServerEnv() throw its whole object for every
 * OTHER caller - REDEMPTION_TOKEN_SECRET, UPSTASH_REDIS_REST_URL, the queue
 * publisher - on a truncated or malformed value of a variable those callers
 * never read). This function still reads `process.env.OPS_ALERT_EMAIL`
 * DIRECTLY rather than through `getServerEnv()`, for the same reason
 * METRICS_TOKEN's own reader does (see src/app/api/internal/metrics/
 * route.ts's `readMetricsToken` and its comment): the declaration keeps
 * env.ts the single inventory of server variables, but going through
 * getServerEnv() for the READ would let an unrelated required key's absence
 * take this check down too.
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
      : incident.reason === "not_scheduled"
        ? `${incident.jobname} is not scheduled`
        : `${incident.jobname} is failing`;

  const lines = [
    `Job: ${incident.jobname}`,
    `Schedule: ${incident.schedule}`,
    `Problem: ${incident.detail}`,
    // "Ongoing for" is time since THIS CHECKER first detected the problem,
    // not necessarily since it began - see the module header. The first
    // alert for any incident will always read close to 0m; the number
    // becomes meaningful starting with the first 24h reminder.
    `Ongoing for: ${duration} (first detected by this check at ${incident.since})`,
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
