import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// A minimal fake of the supabase-js query builder. Every filter method returns
// the builder, terminal awaits resolve the queued result for that table, and
// each `.from(table)` call takes the NEXT queued result so that two reads of
// the same table in one load (the current and previous window counts) can be
// given different answers.
const mocks = vi.hoisted(() => {
  interface QueryResult {
    data: unknown;
    error: unknown;
    count?: number | null;
  }

  const queues = new Map<string, QueryResult[]>();
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

  function makeBuilder(table: string, result: QueryResult) {
    const record = { table, filters: [] as Array<[string, unknown]> };
    calls.push(record);

    const builder: Record<string, unknown> = {};
    for (const method of ["select", "order", "limit"]) {
      builder[method] = vi.fn(() => builder);
    }
    for (const method of ["eq", "gte", "lt", "in"]) {
      builder[method] = vi.fn((column: string, value: unknown) => {
        record.filters.push([`${method}:${column}`, value]);
        return builder;
      });
    }
    builder.maybeSingle = vi.fn(async () => result);
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  }

  function from(table: string) {
    const queue = queues.get(table) ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return makeBuilder(table, next ?? { data: [], error: null, count: 0 });
  }

  return {
    queues,
    calls,
    from: vi.fn(from),
    serviceFrom: vi.fn(from),
    serviceClient: { available: true },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: mocks.from })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: vi.fn(() =>
    mocks.serviceClient.available ? { from: mocks.serviceFrom } : null,
  ),
}));

const { loadBusinessDashboard } = await import("./dashboard");

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";
const ALICE = "consumer-alice";
const BOB = "consumer-bob";

/** Fixed clock: 2026-07-26 20:00 Manila, so "today" is 2026-07-26. */
const NOW = new Date("2026-07-26T12:00:00Z");

function queue(table: string, ...results: Array<{ data?: unknown; error?: unknown; count?: number }>) {
  mocks.queues.set(
    table,
    results.map((result) => ({
      data: result.data ?? [],
      error: result.error ?? null,
      count: result.count ?? 0,
    })),
  );
}

/** The state of a brand new merchant: every table answers with nothing. */
function emptyDatabase() {
  queue("points_transactions", { data: [] }, { data: [] });
  queue("redemptions", { count: 0 }, { count: 0 });
  queue("business_customers", { count: 0 }, { count: 0 });
  queue("reward_claims", { data: [] });
  queue("rewards", { data: [] });
  queue("profiles", { data: [] });
}

function kpiByLabel(kpis: Array<{ label: string; value: string; delta: { text: string } }>, label: string) {
  const found = kpis.find((kpi) => kpi.label === label);
  if (found === undefined) throw new Error(`no KPI labelled "${label}"`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queues.clear();
  mocks.calls.length = 0;
  mocks.serviceClient.available = true;
});

// ---------------------------------------------------------------- tenancy

describe("tenancy", () => {
  it("scopes every business-owned read to the resolved business id", async () => {
    emptyDatabase();
    await loadBusinessDashboard(BUSINESS_ID, NOW);

    const tenantTables = ["points_transactions", "redemptions", "business_customers", "reward_claims"];
    const scoped = mocks.calls.filter((call) => tenantTables.includes(call.table));

    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call.filters).toContainEqual(["eq:business_id", BUSINESS_ID]);
    }
  });
});

// ---------------------------------------------------------------- empty state

describe("a brand new merchant with an empty database", () => {
  it("reports real zeros and no fabricated trend", async () => {
    emptyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    for (const kpi of dashboard.kpis) {
      expect(kpi.value).toBe("0");
    }

    // Not one tile may claim a change it cannot measure.
    for (const kpi of dashboard.kpis) {
      expect(kpi.delta.text).not.toMatch(/%/);
      expect(kpi.delta.tone).toBe("muted");
    }
  });

  it("renders seven honest empty bars rather than an invented week", async () => {
    emptyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    expect(dashboard.visitsByDay).toHaveLength(7);
    expect(dashboard.visitsByDay.every((point) => point.value === 0)).toBe(true);
    expect(dashboard.visitsChartLabel).toBe(
      "Visits per day for the last 7 days, no visits recorded yet",
    );
  });

  it("has an empty activity feed and does not go looking for names", async () => {
    emptyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);

    expect(dashboard?.activity).toEqual([]);
    expect(mocks.serviceFrom).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- real data

describe("a merchant with real activity", () => {
  function busyDatabase() {
    queue(
      "points_transactions",
      {
        data: [
          // previous window (2026-07-13 .. 2026-07-19 Manila)
          { consumer_id: ALICE, points: 10, created_at: "2026-07-15T02:00:00Z" },
          { consumer_id: BOB, points: 10, created_at: "2026-07-16T02:00:00Z" },
          // current window (2026-07-20 .. 2026-07-26 Manila)
          { consumer_id: ALICE, points: 25, created_at: "2026-07-25T02:00:00Z" },
          { consumer_id: ALICE, points: 15, created_at: "2026-07-25T06:00:00Z" },
          { consumer_id: BOB, points: 20, created_at: "2026-07-26T02:00:00Z" },
        ],
      },
      {
        data: [
          {
            id: "txn-1",
            consumer_id: ALICE,
            points: 25,
            created_at: "2026-07-26T11:30:00Z",
          },
        ],
      },
    );
    queue("redemptions", { count: 6 }, { count: 4 });
    queue("business_customers", { count: 42 }, { count: 3 });
    queue("reward_claims", {
      data: [
        {
          id: "claim-1",
          consumer_id: BOB,
          reward_id: "reward-1",
          redeemed_at: "2026-07-26T10:00:00Z",
        },
      ],
    });
    queue("rewards", { data: [{ id: "reward-1", name: "Free medium brew" }] });
    queue("profiles", {
      data: [
        { id: ALICE, display_name: "Ana Bautista" },
        { id: BOB, display_name: "Noel Tiu" },
      ],
    });
  }

  it("counts visits with the doc 40 one-per-consumer-per-Manila-day rule", async () => {
    busyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    // Alice earned twice on 2026-07-25 Manila: that is ONE visit, plus Bob's on
    // the 26th. Two, never three.
    expect(kpiByLabel(dashboard.kpis, "Visits, last 7 days").value).toBe("2");
  });

  it("sums the earn ledger for points issued", async () => {
    busyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    expect(kpiByLabel(dashboard.kpis, "Points issued, last 7 days").value).toBe("60");
  });

  it("computes a genuine week-over-week change when both windows have data", async () => {
    busyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    // 60 points this window against 20 in the previous one.
    expect(kpiByLabel(dashboard.kpis, "Points issued, last 7 days").delta).toEqual({
      text: "+200% vs previous 7 days",
      tone: "trend",
    });
    // 6 redemptions against 4.
    expect(kpiByLabel(dashboard.kpis, "Redemptions, last 7 days").delta).toEqual({
      text: "+50% vs previous 7 days",
      tone: "trend",
    });
  });

  it("reports the all-time customer count with its real new-customer line", async () => {
    busyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    const customers = kpiByLabel(dashboard.kpis, "Customers, all time");
    expect(customers.value).toBe("42");
    expect(customers.delta).toEqual({ text: "+3 in the last 7 days", tone: "trend" });
  });

  it("puts each visit on its own Manila day in the chart", async () => {
    busyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    expect(dashboard.visitsByDay.map((point) => point.day)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(dashboard.visitsByDay.map((point) => point.value)).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it("builds the feed from the ledger and the claims, newest first", async () => {
    busyDatabase();
    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    expect(dashboard.activity).toEqual([
      {
        id: "earn-txn-1",
        icon: "document_scanner",
        text: "Ana Bautista earned 25 points",
        timeLabel: "30 min ago",
      },
      {
        id: "redeem-claim-1",
        icon: "redeem",
        text: "Noel Tiu redeemed Free medium brew",
        timeLabel: "2 hours ago",
      },
    ]);
  });

  it("says 'A customer' rather than inventing a name when profiles are unreadable", async () => {
    busyDatabase();
    mocks.serviceClient.available = false;

    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    expect(dashboard?.activity.map((item) => item.text)).toEqual([
      "A customer earned 25 points",
      "A customer redeemed Free medium brew",
    ]);
  });

  it("scopes the reward-name lookup to this tenant", async () => {
    busyDatabase();
    await loadBusinessDashboard(BUSINESS_ID, NOW);

    const rewardsCall = mocks.calls.find((call) => call.table === "rewards");
    expect(rewardsCall?.filters).toContainEqual(["eq:business_id", BUSINESS_ID]);
  });
});

// ---------------------------------------------------------------- truncation

describe("when the ledger read is truncated", () => {
  it("marks the figures as floors instead of reporting a partial sum as a total", async () => {
    emptyDatabase();
    queue(
      "points_transactions",
      {
        // Two rows came back; the window actually holds 9,000.
        data: [
          { consumer_id: ALICE, points: 10, created_at: "2026-07-25T02:00:00Z" },
          { consumer_id: BOB, points: 10, created_at: "2026-07-26T02:00:00Z" },
        ],
        count: 9000,
      },
      { data: [] },
    );

    const dashboard = await loadBusinessDashboard(BUSINESS_ID, NOW);
    if (dashboard === null) throw new Error("expected a dashboard");

    expect(dashboard.ledgerCapped).toBe(true);
    const visits = kpiByLabel(dashboard.kpis, "Visits, last 7 days");
    expect(visits.value).toBe("2+");
    expect(visits.delta.text).toBe("Too much activity in this window to compare");
    // A percentage over a truncated sum would be arithmetic on a floor.
    expect(visits.delta.text).not.toMatch(/%/);
  });
});

// ---------------------------------------------------------------- failure

describe("when a read fails", () => {
  it("returns null rather than printing a zero it cannot prove", async () => {
    emptyDatabase();
    queue("points_transactions", { error: { message: "boom" } }, { data: [] });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadBusinessDashboard(BUSINESS_ID, NOW)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns null when a count read fails", async () => {
    emptyDatabase();
    queue("business_customers", { error: { message: "boom" } }, { count: 0 });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadBusinessDashboard(BUSINESS_ID, NOW)).toBeNull();
    consoleError.mockRestore();
  });
});
