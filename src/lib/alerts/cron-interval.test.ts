import { describe, expect, it } from "vitest";

import { estimateMaxGapMinutes } from "./cron-interval";

// Every schedule string actually scheduled by this codebase's pg_cron
// migrations (0028, 0043, 0044, 0053, plus doc 39's schedule registry for the
// jobs other tasks are landing this same wave: balance check, cleanup jobs).
// This module's whole job is to answer "how often should this job run" from
// that exact vocabulary - not to be a general cron parser.
describe("estimateMaxGapMinutes", () => {
  it("reads a */N minute schedule as N minutes (campaigns.sweep, '*/5 * * * *')", () => {
    expect(estimateMaxGapMinutes("*/5 * * * *")).toBe(5);
  });

  it("reads a fixed-minute, wildcard-hour schedule as hourly (claims.expiry_sweep, '7 * * * *')", () => {
    expect(estimateMaxGapMinutes("7 * * * *")).toBe(60);
  });

  it("reads a fixed-minute, wildcard-hour schedule as hourly (receipts.stuck_sweep, '50 * * * *')", () => {
    expect(estimateMaxGapMinutes("50 * * * *")).toBe(60);
  });

  it("reads a fixed minute+hour schedule as daily (points.expiry_sweep, '10 18 * * *')", () => {
    expect(estimateMaxGapMinutes("10 18 * * *")).toBe(24 * 60);
  });

  it("reads a fixed minute+hour schedule as daily (points.expiry_warn, '25 18 * * *')", () => {
    expect(estimateMaxGapMinutes("25 18 * * *")).toBe(24 * 60);
  });

  it("reads a fixed minute+hour+day-of-week schedule as weekly ('15 20 * * 0')", () => {
    expect(estimateMaxGapMinutes("15 20 * * 0")).toBe(7 * 24 * 60);
  });

  it("reads a fixed minute+hour+day-of-week schedule as weekly, Saturday too ('40 19 * * 6')", () => {
    expect(estimateMaxGapMinutes("40 19 * * 6")).toBe(7 * 24 * 60);
  });

  it("returns null for a day-of-month or month restriction (unsupported shape, honest unknown)", () => {
    expect(estimateMaxGapMinutes("0 0 1 * *")).toBeNull();
    expect(estimateMaxGapMinutes("0 0 * 6 *")).toBeNull();
  });

  it("returns null for a */N hour schedule (not used anywhere today; degrade rather than guess)", () => {
    expect(estimateMaxGapMinutes("0 */2 * * *")).toBeNull();
  });

  it("returns null for a malformed schedule (wrong field count)", () => {
    expect(estimateMaxGapMinutes("* * *")).toBeNull();
    expect(estimateMaxGapMinutes("")).toBeNull();
  });

  it("returns null for */0 (guards a division/zero-interval nonsense value)", () => {
    expect(estimateMaxGapMinutes("*/0 * * * *")).toBeNull();
  });

  // B2 (review fix): the header previously claimed coverage this function
  // did not have. Every minute IS now supported (doc 39's `ai.embed_refresh`
  // retry tick); a stepped RANGE deliberately still is not.
  it("reads a bare wildcard schedule as every minute ('* * * * *', doc 39's ai.embed_refresh)", () => {
    expect(estimateMaxGapMinutes("* * * * *")).toBe(1);
  });

  it("returns null for a stepped RANGE minute ('2-57/5 * * * *') - a step from zero is supported, a step within a range is not", () => {
    expect(estimateMaxGapMinutes("2-57/5 * * * *")).toBeNull();
  });
});
