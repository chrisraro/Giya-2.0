// The narrowest possible cron-gap estimator: "how many minutes can pass
// between two runs of a job on THIS schedule before that gap is itself
// evidence something is wrong". Not a general cron parser.
//
// Review fix (B2): this header previously claimed to cover "the exact
// schedule SHAPES this codebase's own pg_cron migrations ... and doc 39's
// schedule registry actually use", which was not true of two shapes doc 39
// genuinely lists (`* * * * *`, every minute - `ai.embed_refresh`'s retry
// tick - and the registry's `2-57/5 * * * *`, a stepped range rather than a
// step from zero). The former is now supported (see the wildcard-minute
// branch below); the latter deliberately is not - a step WITHIN a range
// needs a real interval calculation this function does not attempt, and
// guessing wrong here is worse than the honest `null`. The shapes this
// function actually recognises, precisely:
//
//   `*/N * * * *`   every N minutes
//   `* * * * *`     every minute
//   `M * * * *`     hourly, at minute M
//   `M H * * *`     daily, at H:M
//   `M H * * D`     weekly, at H:M on day-of-week D
//
// Every other shape (a day-of-month restriction, an hour-level `*/N`, a
// stepped RANGE like `2-57/5`, a malformed string) returns null rather than
// guessing, and the caller (job-health.ts) treats null as "no honest
// staleness call can be made for this job" and skips the staleness check
// entirely rather than risk a false alarm - the same "degrade the ONE thing
// that failed, not the whole read" discipline src/lib/observability/
// metrics.ts documents at length for its own per-field reads.

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

  // Bare wildcard minute with wildcard hour and day-of-week: every minute
  // (doc 39's `ai.embed_refresh` retry tick). Checked before the
  // NUMBER_PATTERN gate below, which "*" deliberately fails.
  if (minute === "*") {
    return hour === "*" && dayOfWeek === "*" ? 1 : null;
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
