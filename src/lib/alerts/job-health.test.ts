// @vitest-environment node
//
// checkJobHealth(): task 2.5's "alert a human when a scheduled job fails".
// Same three stubs every service-role suite in this codebase uses (see
// src/lib/observability/metrics.test.ts) - the module is `server-only`, its
// default deps mint a real service-role client, and every test here injects
// its own fake instead.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SendEmailInput, SendEmailResult } from "@/lib/email/send";
import type { Database } from "@/lib/supabase/types";

import { JOB_ALERT_WINDOW_HOURS, checkJobHealth } from "./job-health";
import type { JobHealthDeps } from "./job-health";

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

interface FakeHandle {
  supabase: SupabaseClient<Database>;
  setRows: (rows: SweepRowFixture[]) => void;
  state: Map<string, StateRow>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function createFakeSupabase(initialRows: SweepRowFixture[]): FakeHandle {
  const state = new Map<string, StateRow>();
  let rows = initialRows;
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const supabase = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
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
    setRows: (r: SweepRowFixture[]) => {
      rows = r;
    },
    state,
    rpcCalls,
  };
}

function healthyRow(overrides: Partial<SweepRowFixture> = {}): SweepRowFixture {
  return {
    jobname: "claims.expiry_sweep",
    schedule: "7 * * * *",
    active: true,
    runs: 24,
    failures: 0,
    last_status: "succeeded",
    last_finished_at: new Date().toISOString(),
    last_error: null,
    ...overrides,
  };
}

function failingRow(overrides: Partial<SweepRowFixture> = {}): SweepRowFixture {
  return {
    ...healthyRow(),
    failures: 5,
    last_status: "failed",
    last_error: "ERROR: connection to server was lost",
    ...overrides,
  };
}

function createSendMock(): {
  send: (input: SendEmailInput) => Promise<SendEmailResult>;
  calls: SendEmailInput[];
} {
  const calls: SendEmailInput[] = [];
  const send = (input: SendEmailInput): Promise<SendEmailResult> => {
    calls.push(input);
    return Promise.resolve({ ok: true, id: "test-send-id" });
  };
  return { send, calls };
}

const OPS_ADDRESS = "ops@giya.example";

describe("checkJobHealth", () => {
  it("returns null when the service-role client is unavailable (no crash, no silent empty report)", async () => {
    const result = await checkJobHealth(null);
    expect(result).toBeNull();
  });

  it("a healthy sweep set produces nothing", async () => {
    const fake = createFakeSupabase([healthyRow(), healthyRow({ jobname: "receipts.stuck_sweep", schedule: "50 * * * *" })]);
    const { send, calls } = createSendMock();
    const deps: JobHealthDeps = { supabase: fake.supabase, send, opsAddress: OPS_ADDRESS };

    const result = await checkJobHealth(deps);

    expect(result?.unhealthy).toEqual([]);
    expect(result?.alerted).toEqual([]);
    expect(result?.sent).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("calls sweep_job_health with a window wide enough to cover a weekly cadence", async () => {
    const fake = createFakeSupabase([healthyRow()]);
    const deps: JobHealthDeps = { supabase: fake.supabase, opsAddress: null };

    await checkJobHealth(deps);

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]?.name).toBe("sweep_job_health");
    expect(fake.rpcCalls[0]?.args.p_hours).toBe(JOB_ALERT_WINDOW_HOURS);
    // A weekly job needs at least 7 days of window to ever be provably stale.
    expect(JOB_ALERT_WINDOW_HOURS).toBeGreaterThanOrEqual(7 * 24);
  });

  it("a failing job produces one alert whose body names the job and the failure detail", async () => {
    const fake = createFakeSupabase([failingRow({ jobname: "campaigns.sweep" })]);
    const { send, calls } = createSendMock();
    const now = new Date("2026-08-06T12:00:00.000Z");
    const deps: JobHealthDeps = { supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now };

    const result = await checkJobHealth(deps);

    expect(result?.alerted).toHaveLength(1);
    expect(result?.alerted[0]?.jobname).toBe("campaigns.sweep");
    expect(result?.sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe(OPS_ADDRESS);
    // The whole deliverable per the brief: content, not just "a send happened".
    expect(calls[0]?.subject).toContain("campaigns.sweep");
    expect(calls[0]?.text).toContain("campaigns.sweep");
    expect(calls[0]?.text).toContain("ERROR: connection to server was lost");
  });

  it("the same failure on the next check produces no second alert", async () => {
    const fake = createFakeSupabase([failingRow({ jobname: "campaigns.sweep" })]);
    const { send, calls } = createSendMock();
    const t0 = new Date("2026-08-06T12:00:00.000Z");

    await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => t0 });
    expect(calls).toHaveLength(1);

    // Five minutes later, same failure still standing.
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    const result2 = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => t1,
    });

    expect(calls).toHaveLength(1); // still just the one send
    expect(result2?.alerted).toEqual([]);
    // But the incident is still reported as unhealthy - it did not vanish,
    // it was just already told about.
    expect(result2?.unhealthy).toHaveLength(1);
    expect(result2?.unhealthy[0]?.jobname).toBe("campaigns.sweep");
  });

  it("an incident open for over 24h earns a reminder, not silence", async () => {
    const fake = createFakeSupabase([failingRow({ jobname: "campaigns.sweep" })]);
    const { send, calls } = createSendMock();
    const t0 = new Date("2026-08-06T12:00:00.000Z");

    await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => t0 });
    expect(calls).toHaveLength(1);

    const t1 = new Date(t0.getTime() + 25 * 60 * 60_000); // +25h, still failing
    const result2 = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => t1,
    });

    expect(calls).toHaveLength(2); // the reminder
    expect(result2?.alerted).toHaveLength(1);
    // The incident's own start time is preserved across the reminder - "how
    // long it has been failing" must count from the ORIGINAL failure.
    expect(result2?.alerted[0]?.since).toBe(t0.toISOString());
  });

  it("a cleared-then-recurring failure produces a new alert, not silence", async () => {
    const fake = createFakeSupabase([failingRow({ jobname: "campaigns.sweep" })]);
    const { send, calls } = createSendMock();
    const t0 = new Date("2026-08-06T12:00:00.000Z");

    await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => t0 });
    expect(calls).toHaveLength(1);

    // Recovers.
    const t1 = new Date(t0.getTime() + 10 * 60_000);
    fake.setRows([
      healthyRow({
        jobname: "campaigns.sweep",
        schedule: "*/5 * * * *",
        last_finished_at: t1.toISOString(),
      }),
    ]);
    const recovered = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => t1,
    });
    expect(recovered?.unhealthy).toEqual([]);
    expect(fake.state.has("campaigns.sweep")).toBe(false); // dedupe state reset

    // Fails again, minutes later - well within the 24h reminder window, so
    // this MUST be treated as new, not suppressed as a reminder-not-due.
    const t2 = new Date(t1.getTime() + 5 * 60_000);
    fake.setRows([failingRow({ jobname: "campaigns.sweep", schedule: "*/5 * * * *" })]);
    const result3 = await checkJobHealth({
      supabase: fake.supabase,
      send,
      opsAddress: OPS_ADDRESS,
      now: () => t2,
    });

    expect(calls).toHaveLength(2);
    expect(result3?.alerted).toHaveLength(1);
    expect(result3?.alerted[0]?.since).toBe(t2.toISOString());
  });

  it("a job that has not run within its expected interval alerts, even with no failed run on record", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const staleRow: SweepRowFixture = {
      jobname: "claims.expiry_sweep",
      schedule: "7 * * * *", // hourly
      active: true,
      runs: 1,
      failures: 0,
      last_status: "succeeded", // its last run succeeded...
      last_finished_at: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(), // ...3h ago
      last_error: null,
    };
    const fake = createFakeSupabase([staleRow]);
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });

    expect(result?.alerted).toHaveLength(1);
    expect(result?.alerted[0]?.reason).toBe("stale");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("claims.expiry_sweep");
  });

  it("does not falsely call a weekly job stale just because it has not run in the last few hours", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const weeklyRow: SweepRowFixture = {
      jobname: "cleanup.devices",
      schedule: "15 20 * * 0", // weekly, Sunday
      active: true,
      runs: 1,
      failures: 0,
      last_status: "succeeded",
      last_finished_at: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(), // only 3h ago
      last_error: null,
    };
    const fake = createFakeSupabase([weeklyRow]);
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS, now: () => now });

    expect(result?.unhealthy).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("no ops address configured: no send, no throw, and the check still reports the incident", async () => {
    const fake = createFakeSupabase([failingRow({ jobname: "campaigns.sweep" })]);
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: null });

    expect(result).not.toBeNull();
    expect(result?.opsAddressConfigured).toBe(false);
    expect(result?.sent).toBe(0);
    expect(calls).toHaveLength(0);
    // The check still did its job: it saw and would-have-alerted the incident.
    expect(result?.unhealthy).toHaveLength(1);
    expect(result?.alerted).toHaveLength(1);
  });

  it("an inactive job is never alerted on, even if its last recorded run failed", async () => {
    const fake = createFakeSupabase([failingRow({ jobname: "old.retired_sweep", active: false })]);
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS });

    expect(result?.unhealthy).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("two simultaneously failing jobs each get their own alert", async () => {
    const fake = createFakeSupabase([
      failingRow({ jobname: "campaigns.sweep" }),
      failingRow({ jobname: "points.expiry_sweep", schedule: "10 18 * * *" }),
    ]);
    const { send, calls } = createSendMock();

    const result = await checkJobHealth({ supabase: fake.supabase, send, opsAddress: OPS_ADDRESS });

    expect(result?.alerted).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.subject).join(" ")).toContain("campaigns.sweep");
    expect(calls.map((c) => c.subject).join(" ")).toContain("points.expiry_sweep");
  });
});
