// @vitest-environment node
//
// checkJobHealth(): task 2.5's "alert a human when a scheduled job fails".
// Same three stubs every service-role suite in this codebase uses (see
// src/lib/observability/metrics.test.ts) - the module is `server-only`, its
// default deps mint a real service-role client, and every test here injects
// its own fake instead.

import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SendEmailInput, SendEmailResult } from "@/lib/email/send";
import type { Database } from "@/lib/supabase/types";

import { estimateMaxGapMinutes } from "./cron-interval";
import {
  EXPECTED_JOBS,
  RECENT_WINDOW_HOURS,
  STALE_WINDOW_HOURS,
  checkJobHealth,
  staleThresholdMinutes,
} from "./job-health";

interface SweepRowFixture {
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

interface Windows {
  recent: SweepRowFixture[];
  wide: SweepRowFixture[];
}

/** Both windows carry the same rows - the common case for tests that do not
 * specifically exercise the recent-vs-wide split (I1, I4, C2 direction 2). */
function sameWindow(rows: SweepRowFixture[]): Windows {
  return { recent: rows, wide: rows };
}

interface FakeHandle {
  supabase: SupabaseClient<Database>;
  setRows: (windows: Windows) => void;
  state: Map<string, StateRow>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function createFakeSupabase(initial: Windows): FakeHandle {
  const state = new Map<string, StateRow>();
  let windows = initial;
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const rows = args.p_hours === RECENT_WINDOW_HOURS ? windows.recent : windows.wide;
      return Promise.resolve({ data: rows, error: null });
    },
    from: () => ({
      select: () => Promise.resolve({ data: Array.from(state.values()), error: null }),
      upsert: (row: StateRow) => {
        state.set(row.jobname, row);
        return Promise.resolve({ error: null });
      },
      delete: () => ({
        eq: (_column: string, value: string) => {
          state.delete(value);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient<Database>;

  return {
    supabase,
    setRows: (w: Windows) => {
      windows = w;
    },
    state,
    rpcCalls,
  };
}

const PROD_SCHEDULES: Record<string, string> = {
  "campaigns.sweep": "*/5 * * * *",
  "claims.expiry_sweep": "7 * * * *",
  "integrity.balance_check": "40 18 * * *",
  "points.expiry_sweep": "10 18 * * *",
  "points.expiry_warn": "25 18 * * *",
  "receipts.stuck_sweep": "50 * * * *",
};

/** Every EXPECTED_JOBS entry, healthy, as of `now`. Individual tests override
 * or drop the ONE job under test so a single signal is isolated. */
function healthyExpectedRows(now: Date): SweepRowFixture[] {
  return EXPECTED_JOBS.map((jobname) => ({
    jobname,
    schedule: PROD_SCHEDULES[jobname] ?? "7 * * * *",
    active: true,
    runs: 10,
    failures: 0,
    last_status: "succeeded",
    last_finished_at: now.toISOString(),
    last_error: null,
  }));
}

function withOverride(
  rows: SweepRowFixture[],
  jobname: string,
  patch: Partial<SweepRowFixture>,
): SweepRowFixture[] {
  return rows.map((r) => (r.jobname === jobname ? { ...r, ...patch } : r));
}

function withoutJob(rows: SweepRowFixture[], jobname: string): SweepRowFixture[] {
  return rows.filter((r) => r.jobname !== jobname);
}

function createSendMock(outcomes: SendEmailResult[] = []): {
  send: (input: SendEmailInput) => Promise<SendEmailResult>;
  calls: SendEmailInput[];
} {
  const calls: SendEmailInput[] = [];
  let i = 0;
  const send = (input: SendEmailInput): Promise<SendEmailResult> => {
    calls.push(input);
    const outcome = outcomes[i] ?? { ok: true, id: `test-send-id-${i}` };
    i += 1;
    return Promise.resolve(outcome);
  };
  return { send, calls };
}

const OPS_ADDRESS = "ops@giya.example";

describe("checkJobHealth", () => {
  it("returns null when the service-role client is unavailable (no crash, no silent empty report)", async () => {
    const result = await checkJobHealth(null);
    expect(result).toBeNull();
  });

  it("a healthy sweep set (every expected job present, active, recently succeeded) produces nothing", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const rows = healthyExpectedRows(now);
    const fake = createFakeSupabase(sameWindow(rows));
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => now,
    });

    expect(result?.unhealthy).toEqual([]);
    expect(result?.alerted).toEqual([]);
    expect(result?.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("reads both the recent (24h) and the wide (staleness) window, and the wide window is wider than any threshold this schedule vocabulary produces", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const fake = createFakeSupabase(sameWindow(healthyExpectedRows(now)));

    await checkJobHealth({ supabase: fake.supabase, opsAddress: null, now: () => now });

    const pHours = fake.rpcCalls
      .map((c) => c.args.p_hours)
      .sort((a, b) => Number(a) - Number(b));
    expect(pHours).toEqual([RECENT_WINDOW_HOURS, STALE_WINDOW_HOURS]);
  });

  // ---------------------------------------------------------------------
  // C2 - last_status alone was wrong in both directions.
  // ---------------------------------------------------------------------
  describe("C2: classification must not false-positive on in-flight status or false-negative on a failure count", () => {
    it("does NOT page when the most recent run is merely in-flight ('running'), even with zero recent failures", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
        last_status: "running",
        failures: 0,
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send, calls } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      expect(result?.unhealthy).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it("does NOT page on 'starting' or 'sending' either - the same in-flight family", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      for (const status of ["starting", "sending"]) {
        const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
          last_status: status,
          failures: 0,
        });
        const fake = createFakeSupabase(sameWindow(rows));
        const { calls } = createSendMock();

        const result = await checkJobHealth({ supabase: fake.supabase, opsAddress: OPS_ADDRESS, now: () => now });

        expect(result?.unhealthy).toEqual([]);
        expect(calls).toHaveLength(0);
      }
    });

    it("DOES page when the most recent run is the terminal 'failed' state", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
        last_status: "failed",
        last_error: "ERROR: division by zero",
        failures: 1,
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send, calls } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      expect(result?.alerted.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toContain("ERROR: division by zero");
    });

    // The reviewer's own probe: runs:24, failures:12, last_status:"succeeded"
    // must NOT read as zero alerts.
    it("DOES page when the recent window shows real failures, even though the LAST run succeeded", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const baseline = healthyExpectedRows(now);
      const recent = withOverride(baseline, "campaigns.sweep", {
        last_status: "succeeded",
        runs: 24,
        failures: 12,
        last_error: "ERROR: connection to server was lost",
      });
      const wide = withOverride(baseline, "campaigns.sweep", { last_status: "succeeded" });
      const fake = createFakeSupabase({ recent, wide });
      const { send, calls } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      const incident = result?.alerted.find((i) => i.jobname === "campaigns.sweep");
      expect(incident).toBeDefined();
      expect(incident?.reason).toBe("failing");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toContain("12 of 24 runs failed");
      expect(calls[0]?.text).toContain("ERROR: connection to server was lost");
    });
  });

  // ---------------------------------------------------------------------
  // I1 - the staleness window must actually be able to prove a weekly job
  // stale, both structurally and against a concrete example.
  // ---------------------------------------------------------------------
  describe("I1: the staleness window must be wide enough for the widest cadence this schedule vocabulary produces", () => {
    it("STALE_WINDOW_HOURS exceeds the weekly staleness threshold (the necessary condition for the 'found but old' branch to ever be reachable)", () => {
      const weeklyGap = estimateMaxGapMinutes("15 20 * * 0");
      expect(weeklyGap).not.toBeNull();
      const threshold = staleThresholdMinutes(weeklyGap as number);
      expect(STALE_WINDOW_HOURS * 60).toBeGreaterThan(threshold);
    });

    it("flags a weekly-cadence job stale when its last run is older than the threshold but still inside the window (positive case, not just 'does not false-positive')", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      // Weekly gap = 10080min, threshold = 10080*2+5 = 20165min = ~336.08h.
      // 15 days = 360h is past the threshold and still well inside a
      // 504h (21-day) window, so it must be VISIBLE (found, not null) and
      // judged too old.
      const lastRun = new Date(now.getTime() - 15 * 24 * 60 * 60_000);
      const rows = withOverride(healthyExpectedRows(now), "integrity.balance_check", {
        schedule: "15 20 * * 0",
        last_finished_at: lastRun.toISOString(),
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      const incident = result?.alerted.find((i) => i.jobname === "integrity.balance_check");
      expect(incident).toBeDefined();
      expect(incident?.reason).toBe("stale");
    });

    it("does NOT flag a weekly-cadence job stale merely because it has not run in the last few hours (negative case)", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const lastRun = new Date(now.getTime() - 3 * 60 * 60_000);
      const rows = withOverride(healthyExpectedRows(now), "integrity.balance_check", {
        schedule: "15 20 * * 0",
        last_finished_at: lastRun.toISOString(),
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { calls } = createSendMock();

      const result = await checkJobHealth({ supabase: fake.supabase, opsAddress: OPS_ADDRESS, now: () => now });

      expect(result?.unhealthy.find((i) => i.jobname === "integrity.balance_check")).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it("a job that has never run at all inside the wide window is flagged stale (hourly cadence, easy conclusive case)", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withOverride(healthyExpectedRows(now), "claims.expiry_sweep", {
        last_status: null,
        last_finished_at: null,
        runs: 0,
        failures: 0,
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      const incident = result?.alerted.find((i) => i.jobname === "claims.expiry_sweep");
      expect(incident?.reason).toBe("stale");
    });
  });

  // ---------------------------------------------------------------------
  // I2 - dedupe state must reflect whether the alert was actually
  // delivered, not merely attempted.
  // ---------------------------------------------------------------------
  describe("I2: a retryable send failure must not swallow the alert for 24h", () => {
    it("retries on the very next check after a failed send, even seconds later", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
        last_status: "failed",
        last_error: "boom",
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send, calls } = createSendMock([{ ok: false, retryable: true, reason: "resend was unreachable" }]);

      const first = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });
      expect(first?.sent).toBe(0);
      expect(calls).toHaveLength(1);

      // Ten seconds later - nowhere near a 24h reminder window. Must retry
      // because the first attempt never actually delivered.
      const soon = new Date(now.getTime() + 10_000);
      const second = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => soon,
      });

      expect(calls).toHaveLength(2);
      expect(second?.alerted.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
    });

    it("once a send SUCCEEDS, the normal 24h dedupe applies again", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
        last_status: "failed",
        last_error: "boom",
      });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send, calls } = createSendMock([
        { ok: false, retryable: true, reason: "resend was unreachable" },
        { ok: true, id: "delivered-1" },
      ]);

      await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now }); // fails
      const soon = new Date(now.getTime() + 10_000);
      const secondCheck = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => soon,
      }); // succeeds
      expect(secondCheck?.sent).toBe(1);
      expect(calls).toHaveLength(2);

      // Five minutes after the SUCCESSFUL delivery, still well under 24h.
      const later = new Date(soon.getTime() + 5 * 60_000);
      const thirdCheck = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => later,
      });

      expect(calls).toHaveLength(2); // no third attempt
      expect(thirdCheck?.alerted).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // I4 - a flapping job must not page once per failing sample.
  // ---------------------------------------------------------------------
  describe("I4: a flapping job pages once, not once per failing sample", () => {
    it("6 checks alternating fail/succeed/fail/succeed/fail/succeed (all within 24h) produce exactly ONE send", async () => {
      const t0 = new Date("2026-08-06T12:00:00.000Z");
      const baseline = healthyExpectedRows(t0);
      const fake = createFakeSupabase(sameWindow(baseline));
      const { send, calls } = createSendMock();

      const pattern: Array<{ status: string; failures: number }> = [
        { status: "failed", failures: 1 },
        { status: "succeeded", failures: 1 }, // recent window still shows the one failure
        { status: "failed", failures: 2 },
        { status: "succeeded", failures: 2 },
        { status: "failed", failures: 3 },
        { status: "succeeded", failures: 3 },
      ];

      for (const [i, step] of pattern.entries()) {
        const now = new Date(t0.getTime() + i * 60_000);
        const rows = withOverride(baseline, "campaigns.sweep", {
          last_status: step.status,
          failures: step.failures,
          runs: 5 + i,
          last_error: "ERROR: flaky upstream",
        });
        fake.setRows(sameWindow(rows));
        await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });
      }

      expect(calls).toHaveLength(1);
    });

    it("recovery requires a full 24h clean, not just one successful run - and then a fresh failure alerts again", async () => {
      const t0 = new Date("2026-08-06T12:00:00.000Z");
      const baseline = healthyExpectedRows(t0);
      const fake = createFakeSupabase(sameWindow(baseline));
      const { send, calls } = createSendMock();

      // Fails once.
      fake.setRows(
        sameWindow(
          withOverride(baseline, "campaigns.sweep", {
            last_status: "failed",
            failures: 1,
            last_error: "boom",
          }),
        ),
      );
      await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => t0 });
      expect(calls).toHaveLength(1);

      // Ten minutes later, succeeded - but the recent window still shows the
      // one failure inside 24h, so this is NOT yet "recovered".
      const t1 = new Date(t0.getTime() + 10 * 60_000);
      fake.setRows(
        sameWindow(withOverride(baseline, "campaigns.sweep", { last_status: "succeeded", failures: 1 })),
      );
      const stillFlapping = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => t1,
      });
      expect(stillFlapping?.unhealthy.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
      expect(calls).toHaveLength(1); // no new send - still the same incident

      // 25 hours after the LAST failure, the recent window is genuinely
      // clean (zero failures in the trailing 24h) - now it clears. Every
      // OTHER expected job's `last_finished_at` is refreshed to `t2` too:
      // the point of this step is campaigns.sweep's own recovery, not an
      // incidental staleness alert on its five siblings whose fixture
      // timestamps would otherwise still be anchored 25h in the past.
      const t2 = new Date(t0.getTime() + 25 * 60 * 60_000);
      fake.setRows(
        sameWindow(
          withOverride(healthyExpectedRows(t2), "campaigns.sweep", {
            last_status: "succeeded",
            failures: 0,
          }),
        ),
      );
      const recovered = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => t2,
      });
      expect(recovered?.unhealthy).toEqual([]);
      expect(fake.state.has("campaigns.sweep")).toBe(false);

      // A fresh failure afterwards is a genuinely new incident.
      const t3 = new Date(t2.getTime() + 5 * 60_000);
      fake.setRows(
        sameWindow(
          withOverride(healthyExpectedRows(t3), "campaigns.sweep", {
            last_status: "failed",
            failures: 1,
            last_error: "boom again",
          }),
        ),
      );
      const recurred = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => t3,
      });
      expect(calls).toHaveLength(2);
      expect(recurred?.alerted.find((i) => i.jobname === "campaigns.sweep")?.since).toBe(t3.toISOString());
    });
  });

  // ---------------------------------------------------------------------
  // I5 - a job that stopped being scheduled at all must be caught, in both
  // the "unscheduled entirely" and "flipped inactive" shapes.
  // ---------------------------------------------------------------------
  describe("I5: an expected job that silently stopped being scheduled must be caught", () => {
    it("alerts when an expected job has NO cron.job row at all (as cron.unschedule leaves it)", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withoutJob(healthyExpectedRows(now), "receipts.stuck_sweep");
      const fake = createFakeSupabase(sameWindow(rows));
      const { send, calls } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      const incident = result?.alerted.find((i) => i.jobname === "receipts.stuck_sweep");
      expect(incident).toBeDefined();
      expect(incident?.reason).toBe("not_scheduled");
      expect(calls.some((c) => c.text.includes("receipts.stuck_sweep"))).toBe(true);
    });

    it("alerts when an expected job is present but active=false", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = withOverride(healthyExpectedRows(now), "points.expiry_warn", { active: false });
      const fake = createFakeSupabase(sameWindow(rows));
      const { send } = createSendMock();

      const result = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });

      const incident = result?.alerted.find((i) => i.jobname === "points.expiry_warn");
      expect(incident?.reason).toBe("not_scheduled");
    });

    it("does NOT alert on an unexpected job that is simply inactive (not this check's business)", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const rows = [
        ...healthyExpectedRows(now),
        {
          jobname: "old.retired_experiment",
          schedule: "0 0 * * *",
          active: false,
          runs: 0,
          failures: 0,
          last_status: null,
          last_finished_at: null,
          last_error: null,
        },
      ];
      const fake = createFakeSupabase(sameWindow(rows));
      const { calls } = createSendMock();

      const result = await checkJobHealth({ supabase: fake.supabase, opsAddress: OPS_ADDRESS, now: () => now });

      expect(result?.unhealthy.find((i) => i.jobname === "old.retired_experiment")).toBeUndefined();
      expect(calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // No ops address configured.
  // ---------------------------------------------------------------------
  it("no ops address configured: no send, no throw, and the check still reports and tracks the incident", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom",
    });
    const fake = createFakeSupabase(sameWindow(rows));
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: null, now: () => now });

    expect(result).not.toBeNull();
    expect(result?.opsAddressConfigured).toBe(false);
    expect(result?.sent).toBe(0);
    expect(calls).toHaveLength(0);
    expect(result?.unhealthy.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
    expect(result?.alerted.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
  });

  // M5: once an address IS configured, an incident that opened while
  // unconfigured is told about on the very next check, not up to 24h later -
  // the same ALERT_NOT_YET_DELIVERED mechanism I2 relies on.
  it("M5: wiring an ops address mid-incident alerts on the very next check, not after a 24h wait", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom",
    });
    const fake = createFakeSupabase(sameWindow(rows));
    const { send, calls } = createSendMock();

    const unconfigured = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: null,
      now: () => now,
    });
    expect(unconfigured?.sent).toBe(0);
    expect(calls).toHaveLength(0);

    const soon = new Date(now.getTime() + 60_000);
    const configured = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => soon,
    });

    expect(configured?.sent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  // M4: an unexpected exception anywhere in the check must not propagate.
  it("M4: never throws, even when the underlying read explodes unexpectedly", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const supabase = {
      rpc: () => {
        throw new Error("driver fault");
      },
      from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
    } as unknown as SupabaseClient<Database>;

    const result = await checkJobHealth({ supabase, opsAddress: OPS_ADDRESS, now: () => now });
    expect(result).not.toBeNull();
    expect(result?.unhealthy).toEqual([]);
  });

  // M1: the parts of the composed alert beyond "job name + failure detail"
  // are asserted, not merely present in the implementation unobserved.
  it("M1: the alert body also carries the duration line and the runbook pointer", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom",
    });
    const fake = createFakeSupabase(sameWindow(rows));
    const { send, calls } = createSendMock();

    await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("Ongoing for:");
    expect(calls[0]?.text).toContain("Where to look:");
    expect(calls[0]?.text).toContain("docs/50-ops/52-monitoring-observability.md");
  });

  it("two simultaneously failing jobs each get their own alert", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    let rows = withOverride(healthyExpectedRows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom-1",
    });
    rows = withOverride(rows, "points.expiry_sweep", { last_status: "failed", last_error: "boom-2" });
    const fake = createFakeSupabase(sameWindow(rows));
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => now,
    });

    expect(result?.alerted).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.subject).join(" ")).toContain("campaigns.sweep");
    expect(calls.map((c) => c.subject).join(" ")).toContain("points.expiry_sweep");
  });
});
