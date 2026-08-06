// The narrowest possible cron-gap estimator: "how many minutes can pass
// between two runs of a job on THIS schedule before that gap is itself
// evidence something is wrong". Not a general cron parser - it only has to
// answer that question for the exact schedule SHAPES this codebase's own
// pg_cron migrations (0028, 0043, 0044, 0053) and doc 39's schedule registry
// actually use: `*/N * * * *`, `M * * * *`, `M H * * *`, and `M H * * D`.
//
// Every other shape (a day-of-month restriction, a `*/N` hour, a malformed
// string) returns null rather than guessing, and the caller (job-health.ts)
// treats null as "no honest staleness call can be made for this job" and
// skips the staleness check entirely rather than risk a false alarm - the
// same "degrade the ONE thing that failed, not the whole read" discipline
// src/lib/observability/metrics.ts documents at length for its own per-field
// reads.

const FIELD_COUNT = 5;

const STEP_PATTERN = /^\*\/(\d+)$/;
const NUMBER_PATTERN = /^\d+$/;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/**
 * The maximum minutes that should ever separate two runs of a job on this
 * schedule, or `null` when the schedule's shape is not one this estimator
 * recognises.
 */
export function estimateMaxGapMinutes(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== FIELD_COUNT) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // This codebase's registry never restricts day-of-month or month; a job
  // that did would need a real calendar to reason about ("runs the 1st of
  // every month" has a gap that varies 28-31 days), which is outside what a
  // minute-count estimator can honestly answer.
  if (dayOfMonth !== "*" || month !== "*") return null;

  const stepMatch = STEP_PATTERN.exec(minute);
  if (stepMatch !== null) {
    // `*/N` minutes only makes sense combined with wildcard hour and
    // wildcard day-of-week; nothing in this codebase pairs it with either.
    if (hour !== "*" || dayOfWeek !== "*") return null;
    const step = Number(stepMatch[1]);
    return step > 0 ? step : null;
  }

  if (!NUMBER_PATTERN.test(minute)) return null; // e.g. an hour-level `*/N`

  if (hour === "*") {
    // A fixed minute, wildcard hour and wildcard day-of-week: runs once an
    // hour, every hour. (`*/N` hours is not a shape this registry uses; see
    // the header - it falls through to the final `return null` below.)
    return dayOfWeek === "*" ? MINUTES_PER_HOUR : null;
  }

  if (!NUMBER_PATTERN.test(hour)) return null;

  if (dayOfWeek === "*") return MINUTES_PER_DAY;
  if (/^[0-6]$/.test(dayOfWeek)) return MINUTES_PER_WEEK;

  return null;
}
