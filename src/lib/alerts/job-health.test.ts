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

// -----------------------------------------------------------------------------
// Fixture model: TWO independent sources, matching the two RPCs
// checkJobHealth() actually calls. Deliberately NOT derived from one shared
// "failures" field - the whole point of the C2(i) fix is that
// sweep_job_health's `failures` (status <> 'succeeded', counts in-flight
// runs) and sweep_job_terminal_failures's `terminal_failures` (status =
// 'failed' only) are DIFFERENT aggregates that can legitimately disagree
// (an in-flight run: wide.last_status = 'running', terminal_failures = 0,
// simultaneously). A fixture model that could not express that disagreement
// would not be able to test the fix at all - see the "C2(i)" suite below.
// -----------------------------------------------------------------------------

interface WideRowFixture {
  jobname: string;
  schedule: string;
  active: boolean;
  runs: number;
  failures: number;
  last_status: string | null;
  last_finished_at: string | null;
  last_error: string | null;
}

interface TerminalRowFixture {
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

interface Windows {
  wide: WideRowFixture[];
  terminal: TerminalRowFixture[];
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
      if (name === "sweep_job_terminal_failures") {
        return Promise.resolve({ data: windows.terminal, error: null });
      }
      return Promise.resolve({ data: windows.wide, error: null });
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

/** Every EXPECTED_JOBS entry, healthy on both windows, as of `now`.
 * Individual tests override the ONE job under test on whichever window(s)
 * the scenario needs, isolating a single signal. */
function healthyWindows(now: Date): Windows {
  const wide = EXPECTED_JOBS.map((jobname) => ({
    jobname,
    schedule: PROD_SCHEDULES[jobname] ?? "7 * * * *",
    active: true,
    runs: 10,
    failures: 0,
    last_status: "succeeded",
    last_finished_at: now.toISOString(),
    last_error: null,
  }));
  const terminal = EXPECTED_JOBS.map((jobname) => ({
    jobname,
    terminal_runs: 10,
    terminal_failures: 0,
    last_terminal_error: null,
  }));
  return { wide, terminal };
}

function withWide(windows: Windows, jobname: string, patch: Partial<WideRowFixture>): Windows {
  return {
    ...windows,
    wide: windows.wide.map((r) => (r.jobname === jobname ? { ...r, ...patch } : r)),
  };
}

function withTerminal(windows: Windows, jobname: string, patch: Partial<TerminalRowFixture>): Windows {
  return {
    ...windows,
    terminal: windows.terminal.map((r) => (r.jobname === jobname ? { ...r, ...patch } : r)),
  };
}

function withoutWideJob(windows: Windows, jobname: string): Windows {
  return { ...windows, wide: windows.wide.filter((r) => r.jobname !== jobname) };
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

  it("a healthy sweep set (every expected job present, active, recently succeeded on both windows) produces nothing", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const fake = createFakeSupabase(healthyWindows(now));
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

  it("reads sweep_job_terminal_failures over the recent window and sweep_job_health over the wide window - two DIFFERENT functions, not one function twice", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const fake = createFakeSupabase(healthyWindows(now));

    await checkJobHealth({ supabase: fake.supabase, opsAddress: null, now: () => now });

    const byName = fake.rpcCalls.map((c) => [c.name, c.args.p_hours]);
    expect(byName).toContainEqual(["sweep_job_terminal_failures", RECENT_WINDOW_HOURS]);
    expect(byName).toContainEqual(["sweep_job_health", STALE_WINDOW_HOURS]);
    expect(fake.rpcCalls).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // C2 - classification must not false-positive on in-flight status, and
  // must not false-negative on a genuine terminal failure count.
  // ---------------------------------------------------------------------
  describe("C2: classification must not false-positive on in-flight status or false-negative on a failure count", () => {
    // C2(i), review pass 2. Root cause: sweep_job_health's own `failures`
    // column is `count(...) filter (where status <> 'succeeded')`, which
    // counts EVERY in-flight status ('starting'/'running'/'sending') as a
    // failure - confirmed against the live `prosrc`. The FIRST review-fix
    // pass read exactly that column (via a second, narrower
    // sweep_job_health call) for its flapping detector, so a job caught
    // mid-run - routine for campaigns.sweep, which runs every 5 minutes -
    // paged with a false "N of M runs failed" claim. No TypeScript
    // predicate downstream can recover a distinction the aggregate itself
    // already discarded, which is why 0061 (`sweep_job_terminal_failures`)
    // exists: it counts only `status = 'failed'`, verified live via pgTAP
    // (supabase/tests/rpc_job_health_terminal_failures_smoke.sql) to return
    // terminal_failures=0 for a job whose only run is 'running'.
    //
    // This fixture is now INTERNALLY CONSISTENT with real sweep_job_health
    // output (unlike BOTH prior versions of this test - pass 1 paired
    // last_status:'running' with a recent-window failures:0 that the real
    // function cannot produce; pass 2's fixture moved the same impossible
    // pairing onto the WIDE row instead, patching only `last_status` and
    // silently keeping `healthyWindows`'s `failures: 0` default. The
    // reviewer's mutant probe confirmed the real value sweep_job_health
    // returns for an in-flight-only job is `failures: 1` - the SAME `<>
    // 'succeeded'` filter that made 0061 necessary in the first place also
    // means the WIDE row can never show a genuine 0 here). `wide.last_status`
    // is 'running' AND `wide.failures` is realistically 1 (that column DOES
    // count the in-flight run - it is `sweep_job_health`'s, not 0061's) AND
    // `terminal.terminal_failures` is 0, because 0061's aggregate is the one
    // that, by construction, cannot see an in-flight run as a failure at all.
    //
    // MUTANT: restore bd89489's predicate (classifyKnownJob reads
    // `recentRow.failures`/`recentRow.runs`/`recentRow.last_error` off a
    // second sweep_job_health call, i.e. rename this test's `terminal_*`
    // fields back to `failures`/`runs`/`last_error` on a row the OLD code
    // would read for the recent window) against this exact fixture -> RED,
    // because the old code reads the wide row's contaminated `failures: 1`
    // and pages. Verified by mechanically restoring bd89489's
    // classifyKnownJob and re-running this file: this test and the
    // 'starting'/'sending' test both fail (false positives), while the
    // current implementation reads 0061's `terminal_failures: 0` and stays
    // silent.
    it("C2(i): does NOT page when the most recent run is merely in-flight ('running'), because sweep_job_terminal_failures correctly excludes it", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      let windows = withWide(healthyWindows(now), "campaigns.sweep", {
        last_status: "running",
        failures: 1,
        runs: 11,
      });
      windows = withTerminal(windows, "campaigns.sweep", { terminal_failures: 0, terminal_runs: 0 });
      const fake = createFakeSupabase(windows);
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

    // MUTANT: same as above, restored against each of 'starting'/'sending'
    // in turn -> RED for both (the old code's `recentRow.failures` read off
    // the contaminated wide-shaped row is 1 regardless of which in-flight
    // status produced it).
    it("does NOT page on 'starting' or 'sending' either - the same in-flight family", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      for (const status of ["starting", "sending"]) {
        let windows = withWide(healthyWindows(now), "campaigns.sweep", {
          last_status: status,
          failures: 1,
          runs: 11,
        });
        windows = withTerminal(windows, "campaigns.sweep", { terminal_failures: 0, terminal_runs: 0 });
        const fake = createFakeSupabase(windows);
        const { send, calls } = createSendMock();

        const result = await checkJobHealth({
          supabase: fake.supabase,
          send,
          opsAddress: OPS_ADDRESS,
          now: () => now,
        });

        expect(result?.unhealthy).toEqual([]);
        expect(calls).toHaveLength(0);
      }
    });

    it("DOES page when the most recent run is the terminal 'failed' state", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const windows = withWide(healthyWindows(now), "campaigns.sweep", {
        last_status: "failed",
        last_error: "ERROR: division by zero",
      });
      const fake = createFakeSupabase(windows);
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

    // The reviewer's own probe (pass 1): runs:24, failures:12,
    // last_status:"succeeded" must NOT read as zero alerts. Re-expressed
    // against the corrected function: terminal_runs=24, terminal_failures=12.
    it("DOES page when sweep_job_terminal_failures shows real terminal failures, even though the LAST run succeeded", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      let windows = withWide(healthyWindows(now), "campaigns.sweep", { last_status: "succeeded" });
      windows = withTerminal(windows, "campaigns.sweep", {
        terminal_runs: 24,
        terminal_failures: 12,
        last_terminal_error: "ERROR: connection to server was lost",
      });
      const fake = createFakeSupabase(windows);
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

    // E (review pass 3): the flapping branch's error text must come ONLY
    // from sweep_job_terminal_failures, never fall back to wideRow.last_error
    // - that column is built from the same `status <> 'succeeded'` filter as
    // sweep_job_health's `failures`, so trusting it here would reopen the
    // exact contamination path C2(i) exists to close, on the one caller left
    // that had not been checked. terminalRow.last_terminal_error is null
    // (a real, if narrow, shape - a failed run whose return_message itself
    // came back empty) while wideRow.last_error carries a DIFFERENT,
    // recognizable string that must never reach the alert.
    //
    // MUTANT: reintroduce `?? wideRow.last_error` into the flapping branch's
    // `errorText` computation (job-health.ts's classifyKnownJob, restoring
    // the exact line this review pass removed). Verified by temporarily
    // re-adding that fallback and re-running this test: it fails, because
    // the alert text then contains "STALE WIDE MESSAGE - must never leak".
    // With the fallback removed (current code), it passes.
    it("E: the flapping branch's error text never falls back to sweep_job_health's own last_error", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      let windows = withWide(healthyWindows(now), "campaigns.sweep", {
        last_status: "succeeded",
        last_error: "STALE WIDE MESSAGE - must never leak",
      });
      windows = withTerminal(windows, "campaigns.sweep", {
        terminal_runs: 5,
        terminal_failures: 1,
        last_terminal_error: null,
      });
      const fake = createFakeSupabase(windows);
      const { send, calls } = createSendMock();

      await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).not.toContain("STALE WIDE MESSAGE");
      expect(calls[0]?.text).toContain("1 of 5 runs failed in the last 24h");
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
      const lastRun = new Date(now.getTime() - 15 * 24 * 60 * 60_000);
      const windows = withWide(healthyWindows(now), "integrity.balance_check", {
        schedule: "15 20 * * 0",
        last_finished_at: lastRun.toISOString(),
      });
      const fake = createFakeSupabase(windows);
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
      const windows = withWide(healthyWindows(now), "integrity.balance_check", {
        schedule: "15 20 * * 0",
        last_finished_at: lastRun.toISOString(),
      });
      const fake = createFakeSupabase(windows);
      const { calls } = createSendMock();

      const result = await checkJobHealth({ supabase: fake.supabase, opsAddress: OPS_ADDRESS, now: () => now });

      expect(result?.unhealthy.find((i) => i.jobname === "integrity.balance_check")).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it("a job that has never run at all inside the wide window is flagged stale (hourly cadence, easy conclusive case)", async () => {
      const now = new Date("2026-08-06T12:00:00.000Z");
      const windows = withWide(healthyWindows(now), "claims.expiry_sweep", {
        last_status: null,
        last_finished_at: null,
      });
      const fake = createFakeSupabase(windows);
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
      const windows = withWide(healthyWindows(now), "campaigns.sweep", {
        last_status: "failed",
        last_error: "boom",
      });
      const fake = createFakeSupabase(windows);
      const { send, calls } = createSendMock([{ ok: false, retryable: true, reason: "resend was unreachable" }]);

      const first = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => now,
      });
      expect(first?.sent).toBe(0);
      expect(calls).toHaveLength(1);

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
      const windows = withWide(healthyWindows(now), "campaigns.sweep", {
        last_status: "failed",
        last_error: "boom",
      });
      const fake = createFakeSupabase(windows);
      const { send, calls } = createSendMock([
        { ok: false, retryable: true, reason: "resend was unreachable" },
        { ok: true, id: "delivered-1" },
      ]);

      await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });
      const soon = new Date(now.getTime() + 10_000);
      const secondCheck = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => soon,
      });
      expect(secondCheck?.sent).toBe(1);
      expect(calls).toHaveLength(2);

      const later = new Date(soon.getTime() + 5 * 60_000);
      const thirdCheck = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => later,
      });

      expect(calls).toHaveLength(2);
      expect(thirdCheck?.alerted).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // I4 - a flapping job must not page once per failing sample.
  // ---------------------------------------------------------------------
  describe("I4: a flapping job pages once, not once per failing sample", () => {
    it("6 checks alternating fail/succeed/fail/succeed/fail/succeed (all within 24h) produce exactly ONE send", async () => {
      const t0 = new Date("2026-08-06T12:00:00.000Z");
      const baseline = healthyWindows(t0);
      const fake = createFakeSupabase(baseline);
      const { send, calls } = createSendMock();

      const pattern: Array<{ status: string; terminalFailures: number }> = [
        { status: "failed", terminalFailures: 1 },
        { status: "succeeded", terminalFailures: 1 }, // recent window still shows the one failure
        { status: "failed", terminalFailures: 2 },
        { status: "succeeded", terminalFailures: 2 },
        { status: "failed", terminalFailures: 3 },
        { status: "succeeded", terminalFailures: 3 },
      ];

      for (const [i, step] of pattern.entries()) {
        const now = new Date(t0.getTime() + i * 60_000);
        let windows = withWide(baseline, "campaigns.sweep", { last_status: step.status });
        windows = withTerminal(windows, "campaigns.sweep", {
          terminal_failures: step.terminalFailures,
          terminal_runs: 5 + i,
          last_terminal_error: "ERROR: flaky upstream",
        });
        fake.setRows(windows);
        await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });
      }

      expect(calls).toHaveLength(1);
    });

    it("recovery requires a full 24h clean, not just one successful run - and then a fresh failure alerts again", async () => {
      const t0 = new Date("2026-08-06T12:00:00.000Z");
      const fake = createFakeSupabase(healthyWindows(t0));
      const { send, calls } = createSendMock();

      // Fails once.
      let windows = withWide(healthyWindows(t0), "campaigns.sweep", {
        last_status: "failed",
        last_error: "boom",
      });
      windows = withTerminal(windows, "campaigns.sweep", { terminal_failures: 1, terminal_runs: 5 });
      fake.setRows(windows);
      await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => t0 });
      expect(calls).toHaveLength(1);

      // Ten minutes later, succeeded - but the recent window still shows the
      // one terminal failure inside 24h, so this is NOT yet "recovered".
      const t1 = new Date(t0.getTime() + 10 * 60_000);
      let windows1 = withWide(healthyWindows(t1), "campaigns.sweep", { last_status: "succeeded" });
      windows1 = withTerminal(windows1, "campaigns.sweep", { terminal_failures: 1, terminal_runs: 6 });
      fake.setRows(windows1);
      const stillFlapping = await checkJobHealth({
        supabase: fake.supabase,
        send,
        opsAddress: OPS_ADDRESS,
        now: () => t1,
      });
      expect(stillFlapping?.unhealthy.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
      expect(calls).toHaveLength(1);

      // 25 hours after the LAST failure, the recent window is genuinely
      // clean (zero terminal failures in the trailing 24h) - now it clears.
      const t2 = new Date(t0.getTime() + 25 * 60 * 60_000);
      fake.setRows(healthyWindows(t2)); // every job, including campaigns.sweep, fully healthy again
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
      let windows3 = withWide(healthyWindows(t3), "campaigns.sweep", {
        last_status: "failed",
        last_error: "boom again",
      });
      windows3 = withTerminal(windows3, "campaigns.sweep", { terminal_failures: 1, terminal_runs: 3 });
      fake.setRows(windows3);
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
      const windows = withoutWideJob(healthyWindows(now), "receipts.stuck_sweep");
      const fake = createFakeSupabase(windows);
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
      const windows = withWide(healthyWindows(now), "points.expiry_warn", { active: false });
      const fake = createFakeSupabase(windows);
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
      const windows = healthyWindows(now);
      windows.wide.push({
        jobname: "old.retired_experiment",
        schedule: "0 0 * * *",
        active: false,
        runs: 0,
        failures: 0,
        last_status: null,
        last_finished_at: null,
        last_error: null,
      });
      const fake = createFakeSupabase(windows);
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
    const windows = withWide(healthyWindows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom",
    });
    const fake = createFakeSupabase(windows);
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: null, now: () => now });

    expect(result).not.toBeNull();
    expect(result?.opsAddressConfigured).toBe(false);
    expect(result?.sent).toBe(0);
    expect(calls).toHaveLength(0);
    expect(result?.unhealthy.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
    expect(result?.alerted.find((i) => i.jobname === "campaigns.sweep")).toBeDefined();
  });

  it("M5: wiring an ops address mid-incident alerts on the very next check, not after a 24h wait", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const windows = withWide(healthyWindows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom",
    });
    const fake = createFakeSupabase(windows);
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

  it("M1: the alert body also carries the duration line and the runbook pointer", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const windows = withWide(healthyWindows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom",
    });
    const fake = createFakeSupabase(windows);
    const { send, calls } = createSendMock();

    await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("Ongoing for:");
    expect(calls[0]?.text).toContain("Where to look:");
    expect(calls[0]?.text).toContain("docs/50-ops/52-monitoring-observability.md");
  });

  it("two simultaneously failing jobs each get their own alert", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    let windows = withWide(healthyWindows(now), "campaigns.sweep", {
      last_status: "failed",
      last_error: "boom-1",
    });
    windows = withWide(windows, "points.expiry_sweep", { last_status: "failed", last_error: "boom-2" });
    const fake = createFakeSupabase(windows);
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
