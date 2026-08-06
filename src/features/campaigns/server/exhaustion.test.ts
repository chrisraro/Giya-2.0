// @vitest-environment node
//
// Doc 34 section 5's "On exhaustion" clause (task 1.2): pause + audit +
// notify, called post-commit by the award path. Pinned here: the pause is
// idempotent (status='active' predicate), the audit row is a system actor,
// the owner lookup and notification kind, and that every failure mode logs
// and continues rather than throwing - the award this runs after is already
// committed and cannot be unwound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

const raiseNotificationMock = vi.fn().mockResolvedValue(true);
vi.mock("@/features/notifications/server/raise", () => ({
  raiseNotification: (...args: unknown[]) => raiseNotificationMock(...args),
}));

import type { Database } from "@/lib/supabase/types";
import { pauseExhaustedCampaigns } from "./exhaustion";

// ===========================================================================
// A tiny fake Supabase client. Every `.from(table)` call returns a chainable
// query object; `.eq`/`.gt`/`.select`/`.update` all return `this`, and both
// `.maybeSingle()` and plain `await` resolve to whatever the table's fixture
// says. Recorded ops let tests assert exactly what was written.
// ===========================================================================

interface FakeError {
  message: string;
}
interface FakeResult {
  data: unknown;
  error: FakeError | null;
}
interface RecordedOp {
  table: string;
  kind: "select" | "update" | "insert";
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

function createFakeSupabase(input: {
  campaign?: { id: string; business_id: string; name: string; status: string; budget: unknown } | null;
  campaignReadError?: FakeError;
  pointsSum?: number;
  pointsReadError?: FakeError;
  updateMatchesRow?: boolean; // false = lost the race (0 rows)
  updateError?: FakeError;
  auditError?: FakeError;
  owner?: { user_id: string } | null;
  ownerReadError?: FakeError;
}): { client: SupabaseClient<Database>; ops: RecordedOp[] } {
  const ops: RecordedOp[] = [];

  function chain(table: string, kind: RecordedOp["kind"], payload: unknown, resolve: () => FakeResult) {
    const filters: Array<[string, ...unknown[]]> = [];
    const op: RecordedOp = { table, kind, payload, filters };
    ops.push(op);
    const builder = {
      eq(...args: unknown[]) {
        filters.push(["eq", ...args]);
        return builder;
      },
      is(...args: unknown[]) {
        filters.push(["is", ...args]);
        return builder;
      },
      gt(...args: unknown[]) {
        filters.push(["gt", ...args]);
        return builder;
      },
      select(...args: unknown[]) {
        filters.push(["select", ...args]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(resolve());
      },
      then(onFulfilled?: (value: FakeResult) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const client = {
    from: (table: string) => ({
      select: (...selectArgs: unknown[]) =>
        chain(table, "select", undefined, () => {
          if (table === "campaigns") {
            if (input.campaignReadError !== undefined) {
              return { data: null, error: input.campaignReadError };
            }
            return { data: input.campaign ?? null, error: null };
          }
          if (table === "points_transactions") {
            if (input.pointsReadError !== undefined) {
              return { data: null, error: input.pointsReadError };
            }
            const sum = input.pointsSum ?? 0;
            return { data: sum > 0 ? [{ points: sum }] : [], error: null };
          }
          if (table === "business_staff") {
            if (input.ownerReadError !== undefined) {
              return { data: null, error: input.ownerReadError };
            }
            return { data: input.owner === undefined ? null : input.owner, error: null };
          }
          return { data: null, error: null };
        }),
      update: (payload: unknown) =>
        chain(table, "update", payload, () => {
          if (input.updateError !== undefined) return { data: null, error: input.updateError };
          const matched = input.updateMatchesRow ?? true;
          return { data: matched ? { id: input.campaign?.id ?? "x" } : null, error: null };
        }),
      insert: (payload: unknown) =>
        chain(table, "insert", payload, () => ({
          data: null,
          error: table === "audit_logs" ? (input.auditError ?? null) : null,
        })),
    }),
  };

  return { client: client as unknown as SupabaseClient<Database>, ops };
}

const CAMPAIGN_ID = "01980000-0000-7000-8000-0000000000ca";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";
const OWNER_ID = "01980000-0000-7000-8000-0000000000o1";

function activeCampaign(overrides: Partial<{ status: string; budget: unknown }> = {}) {
  return {
    id: CAMPAIGN_ID,
    business_id: BUSINESS_ID,
    name: "Capped Promo",
    status: "active",
    budget: { max_total_points: 100 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  raiseNotificationMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pauseExhaustedCampaigns", () => {
  it("pauses, audits, and notifies the owner when the running total has reached the cap", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      owner: { user_id: OWNER_ID },
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    const update = ops.find((op) => op.table === "campaigns" && op.kind === "update");
    expect(update?.payload).toEqual({ status: "paused" });
    expect(update?.filters).toContainEqual(["eq", "id", CAMPAIGN_ID]);
    expect(update?.filters).toContainEqual(["eq", "status", "active"]);

    const audit = ops.find((op) => op.table === "audit_logs" && op.kind === "insert");
    expect(audit?.payload).toMatchObject({
      actor_id: null,
      actor_kind: "system",
      business_id: BUSINESS_ID,
      action: "campaign.paused",
      entity_type: "campaign",
      entity_id: CAMPAIGN_ID,
    });

    expect(raiseNotificationMock).toHaveBeenCalledTimes(1);
    expect(raiseNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER_ID,
        kind: "campaign_budget_exhausted",
        businessId: BUSINESS_ID,
      }),
    );
  });

  it("pauses when the running total has overshot the cap (not just met it)", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 130,
      owner: { user_id: OWNER_ID },
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    expect(ops.some((op) => op.table === "campaigns" && op.kind === "update")).toBe(true);
  });

  it("does nothing when the running total has not yet reached the cap", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 60,
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    expect(ops.some((op) => op.kind === "update")).toBe(false);
    expect(ops.some((op) => op.table === "audit_logs")).toBe(false);
    expect(raiseNotificationMock).not.toHaveBeenCalled();
  });

  it("does nothing when the campaign is already paused (idempotent)", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign({ status: "paused" }),
      pointsSum: 999,
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    // Never even reads the running total: status is checked first.
    expect(ops.some((op) => op.table === "points_transactions")).toBe(false);
    expect(ops.some((op) => op.kind === "update")).toBe(false);
    expect(raiseNotificationMock).not.toHaveBeenCalled();
  });

  it("does nothing when the campaign carries no max_total_points cap", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign({ budget: { per_customer_limit: 1 } }),
      pointsSum: 999,
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    expect(ops.some((op) => op.table === "points_transactions")).toBe(false);
    expect(ops.some((op) => op.kind === "update")).toBe(false);
  });

  it("does nothing when the campaign row is gone (soft-deleted or never existed)", async () => {
    const { client, ops } = createFakeSupabase({ campaign: null });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    expect(ops.some((op) => op.kind === "update")).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("skips audit + notify (but does not throw) when the update matched zero rows (lost the pause race)", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      updateMatchesRow: false,
      owner: { user_id: OWNER_ID },
    });

    await expect(
      pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]),
    ).resolves.toBeUndefined();

    expect(ops.some((op) => op.table === "audit_logs")).toBe(false);
    expect(raiseNotificationMock).not.toHaveBeenCalled();
  });

  it("never throws when the campaign read errors", async () => {
    const { client } = createFakeSupabase({ campaignReadError: { message: "boom" } });

    await expect(
      pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("never throws when the points_transactions sum read errors", async () => {
    const { client } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsReadError: { message: "boom" },
    });

    await expect(
      pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]),
    ).resolves.toBeUndefined();
  });

  it("never throws when the pause update itself errors", async () => {
    const { client } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      updateError: { message: "boom" },
    });

    await expect(
      pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]),
    ).resolves.toBeUndefined();
  });

  it("still pauses when the audit insert fails (best-effort audit, the pause stands)", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      auditError: { message: "boom" },
      owner: { user_id: OWNER_ID },
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    expect(ops.some((op) => op.table === "campaigns" && op.kind === "update")).toBe(true);
    expect(raiseNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("still pauses and audits when no active owner is found (nothing to notify)", async () => {
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      owner: null,
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]);

    expect(ops.some((op) => op.table === "audit_logs")).toBe(true);
    expect(raiseNotificationMock).not.toHaveBeenCalled();
  });

  it("never throws when the owner lookup errors", async () => {
    const { client } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      ownerReadError: { message: "boom" },
    });

    await expect(
      pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID]),
    ).resolves.toBeUndefined();
    expect(raiseNotificationMock).not.toHaveBeenCalled();
  });

  it("does nothing for an empty campaign id list", async () => {
    const { client, ops } = createFakeSupabase({});

    await pauseExhaustedCampaigns({ supabase: client }, []);

    expect(ops).toHaveLength(0);
    expect(raiseNotificationMock).not.toHaveBeenCalled();
  });

  it("processes each campaign id in the list against the (shared, in this fake) fixture", async () => {
    // Two distinct ids sharing the same fixture campaign: the point of this
    // test is that the function iterates the WHOLE list rather than stopping
    // after the first (a bug here would leave the second id's pause/audit
    // never attempted), not that each id resolves to different fixture data.
    const other = "01980000-0000-7000-8000-0000000000cb";
    const { client, ops } = createFakeSupabase({
      campaign: activeCampaign(),
      pointsSum: 100,
      owner: { user_id: OWNER_ID },
    });

    await pauseExhaustedCampaigns({ supabase: client }, [CAMPAIGN_ID, other]);

    expect(ops.filter((op) => op.table === "campaigns" && op.kind === "select")).toHaveLength(2);
    expect(ops.filter((op) => op.table === "campaigns" && op.kind === "update")).toHaveLength(2);
    expect(raiseNotificationMock).toHaveBeenCalledTimes(2);
  });
});
