import type { FraudSignal, FraudSeverity } from "./fraud";

// Pure velocity-window evaluation, per
// docs/30-modules/37-fraud-detection.md S4 ("too much, too fast").
// ZERO IO: the sliding-window counters live in Upstash Redis on the hot
// path and are always recomputable from `receipts` (D4), but this module
// only ever sees the numbers. Given counts and caps it emits the
// fraud_signals rows; scoring and routing are fraud.ts's job.

export type VelocityWindow =
  | "consumer_hour"
  | "consumer_day"
  | "pair_day"
  | "pair_10min"
  | "device_day";

// Emission order, so a receipt's signal rows are stable regardless of the
// order the caller's Redis pipeline resolved in. Same order as doc 37's
// S4 table.
export const VELOCITY_WINDOWS: readonly VelocityWindow[] = [
  "consumer_hour",
  "consumer_day",
  "pair_day",
  "pair_10min",
  "device_day",
];

// Velocity signals never block. Doc 37 is explicit: these are behavioral
// caps that fire earlier than the transport rate limit and "route to
// *review*, never block - batch-scanning a week of receipts after
// onboarding is legitimate and common". Excluding "block" from the type
// makes that a compile-time guarantee, so no settings row or business
// override can turn a burst of honest scanning into a rejection.
export type VelocitySeverity = Exclude<FraudSeverity, "block">;

export interface VelocityCap {
  readonly cap: number;
  readonly severity: VelocitySeverity;
  readonly score: number;
}

// Counts as the caller resolved them. A window may be absent, and a
// pipeline against cold Redis keys may hand back an explicit undefined;
// both mean "not evaluated" (see evaluateVelocity).
export type VelocityCounts = {
  readonly [W in VelocityWindow]?: number | undefined;
};

// Doc 37 S4 defaults, also the seeded `settings` rows
// fraud.velocity.{consumer_hour,consumer_day,pair_day,pair_10min,device_day}.
// pair_day and pair_10min accept a business-scope override.
export const DEFAULT_VELOCITY_CAPS: Record<VelocityWindow, VelocityCap> = {
  consumer_hour: { cap: 4, severity: "warn", score: 0.5 },
  consumer_day: { cap: 10, severity: "warn", score: 0.6 },
  pair_day: { cap: 3, severity: "warn", score: 0.5 },
  pair_10min: { cap: 2, severity: "warn", score: 0.7 },
  device_day: { cap: 12, severity: "warn", score: 0.6 },
};

// Emit one `velocity` signal per breached window.
//
// Boundary: the cap is an allowance, not a ceiling to stop at, so a
// breach is `count > cap`, not `count >= cap`. Doc 37's "Consumer / hour:
// Cap 4" reads as "four scans an hour is fine"; flagging the fourth would
// punish the exact behaviour the doc calls legitimate. The doc's own
// evidence example settles it: `{"window": "pair_10min", "count": 3,
// "cap": 2}` - the signal fires at 3 against a cap of 2, i.e. one past
// the allowance.
//
// Missing counts are simply not evaluated. An absent window is unknown,
// never a zero-breach and never an error: losing Redis loses speed, never
// truth, and a cold counter must not manufacture a fraud signal.
export function evaluateVelocity(
  counts: VelocityCounts,
  caps: Record<VelocityWindow, VelocityCap> = DEFAULT_VELOCITY_CAPS,
): FraudSignal[] {
  const signals: FraudSignal[] = [];
  for (const window of VELOCITY_WINDOWS) {
    const count = counts[window];
    if (count === undefined) continue;
    const { cap, severity, score } = caps[window];
    if (count <= cap) continue;
    signals.push({
      signal: "velocity",
      severity,
      score,
      evidence: { window, count, cap },
    });
  }
  return signals;
}
