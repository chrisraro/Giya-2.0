// @vitest-environment node
//
// The fail-soft contract, which is the only thing about this module that is
// hard to get right and the only thing that costs money when it is wrong.
//
// THE PROPERTY UNDER TEST: raising a notification must never break the thing
// that triggered it. Every test below is a way for the write to go wrong -
// no credential, a rejected insert, a driver that throws, a payload the
// database would refuse - and in every one of them `raiseNotification` returns
// false instead of throwing. The final describe block states the consequence
// directly: a caller that has just minted points is not disturbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import { raiseNotification } from "./raise";
import type { RaiseNotificationDeps } from "./raise";

const USER_ID = "01980000-0000-7000-8000-0000000000c1";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";

interface FakeInsert {
  table: string;
  payload: Record<string, unknown>;
}

interface FakeSupabase {
  deps: RaiseNotificationDeps;
  inserts: FakeInsert[];
}

/**
 * A one-method fake: this module only ever inserts. `behaviour` decides what
 * the insert answers, which is the whole surface of the failure taxonomy under
 * test.
 */
function createFake(
  behaviour: "ok" | "error" | "throw" | "throw-sync" = "ok",
): FakeSupabase {
  const inserts: FakeInsert[] = [];
  const client = {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        if (behaviour === "throw-sync") {
          throw new Error("the driver exploded before the round trip");
        }
        if (behaviour === "throw") {
          return Promise.reject(new Error("socket hang up"));
        }
        if (behaviour === "error") {
          return Promise.resolve({
            error: { message: "new row violates check constraint", code: "23514" },
          });
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
  return {
    deps: { supabase: client as unknown as SupabaseClient<Database> },
    inserts,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    kind: "points_awarded" as const,
    title: "Points added",
    body: "120 points are now in your Kape Diaria wallet.",
    businessId: BUSINESS_ID,
    data: { route: "/scan/r1", params: { points: 120 } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("raiseNotification writes the row", () => {
  it("inserts one notifications row with the composed message", async () => {
    const fake = createFake();

    const ok = await raiseNotification({ ...input(), deps: fake.deps });

    expect(ok).toBe(true);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]?.table).toBe("notifications");
    expect(fake.inserts[0]?.payload).toMatchObject({
      user_id: USER_ID,
      business_id: BUSINESS_ID,
      kind: "points_awarded",
      title: "Points added",
      body: "120 points are now in your Kape Diaria wallet.",
    });
  });

  it("defaults the sender tenant to null (a platform message) and data to {}", async () => {
    const fake = createFake();

    await raiseNotification({
      userId: USER_ID,
      kind: "reward_expiring",
      title: "A reward is expiring",
      body: "Your claim expires soon.",
      deps: fake.deps,
    });

    expect(fake.inserts[0]?.payload).toMatchObject({ business_id: null, data: {} });
  });

  it("never writes read_at: a notification is born unread and that is the badge", async () => {
    const fake = createFake();

    await raiseNotification({ ...input(), deps: fake.deps });

    expect(fake.inserts[0]?.payload).not.toHaveProperty("read_at");
  });
});

describe("raiseNotification clamps rather than losing the message", () => {
  it("truncates an over-long body instead of letting 0026's check reject it", async () => {
    const fake = createFake();

    await raiseNotification({
      ...input({ body: "x".repeat(900) }),
      deps: fake.deps,
    });

    const body = fake.inserts[0]?.payload.body as string;
    expect(body.length).toBeLessThanOrEqual(600);
    expect(body.endsWith("…")).toBe(true);
  });

  it("truncates an over-long title, which a very long shop name can produce", async () => {
    const fake = createFake();

    await raiseNotification({
      ...input({ title: "Kape ".repeat(60) }),
      deps: fake.deps,
    });

    expect((fake.inserts[0]?.payload.title as string).length).toBeLessThanOrEqual(120);
  });

  it("refuses a blank message rather than writing one that says nothing", async () => {
    const fake = createFake();

    const ok = await raiseNotification({ ...input({ body: "   " }), deps: fake.deps });

    expect(ok).toBe(false);
    expect(fake.inserts).toHaveLength(0);
  });
});

// ===========================================================================
// THE CONTRACT
// ===========================================================================

describe("CRITICAL: raiseNotification never throws", () => {
  it("returns false when there is no service-role client at all", async () => {
    let result: boolean | undefined;
    await expect(
      (async () => {
        result = await raiseNotification({ ...input(), deps: null });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBe(false);
  });

  it("returns false when the database refuses the insert", async () => {
    const fake = createFake("error");

    await expect(
      raiseNotification({ ...input(), deps: fake.deps }),
    ).resolves.toBe(false);
  });

  it("returns false when the driver rejects", async () => {
    const fake = createFake("throw");

    await expect(
      raiseNotification({ ...input(), deps: fake.deps }),
    ).resolves.toBe(false);
  });

  it("returns false when the driver throws synchronously", async () => {
    const fake = createFake("throw-sync");

    await expect(
      raiseNotification({ ...input(), deps: fake.deps }),
    ).resolves.toBe(false);
  });

  it("returns false rather than throwing on a malformed input", async () => {
    const fake = createFake();

    await expect(
      raiseNotification({
        ...input({ title: undefined as unknown as string }),
        deps: fake.deps,
      }),
    ).resolves.toBe(false);
  });
});

describe("CRITICAL: a failed notification does not undo the thing it was about", () => {
  // The property stated as its caller experiences it. `award` stands in for
  // any committed side effect - the points row, the audit row, the receipt
  // status - and the assertion is that it survives every failure mode above.
  async function awardThenNotify(
    deps: RaiseNotificationDeps | null,
  ): Promise<{ pointsAwarded: number }> {
    const ledger = { pointsAwarded: 0 };
    ledger.pointsAwarded = 120; // the money write, already committed
    await raiseNotification({ ...input(), deps });
    return ledger;
  }

  it("the points award still stands when the notification write fails", async () => {
    const ledger = await awardThenNotify(createFake("error").deps);
    expect(ledger.pointsAwarded).toBe(120);
  });

  it("the points award still stands when the notification driver throws", async () => {
    const ledger = await awardThenNotify(createFake("throw").deps);
    expect(ledger.pointsAwarded).toBe(120);
  });

  it("the points award still stands when there is no notification client at all", async () => {
    const ledger = await awardThenNotify(null);
    expect(ledger.pointsAwarded).toBe(120);
  });
});
