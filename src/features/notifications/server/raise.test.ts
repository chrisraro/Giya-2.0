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
  behaviour: "ok" | "error" | "throw" | "throw-sync" | "email-row-fails" = "ok",
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
        const failed =
          behaviour === "error" ||
          (behaviour === "email-row-fails" && payload.channel === "email");
        const answer = failed
          ? { data: null, error: { message: "new row violates check constraint", code: "23514" } }
          : { data: { id: "notification-1" }, error: null };
        // The email insert reads its id back so it can be enqueued
        // (`.select("id").single()`); the inbox insert is awaited directly. One
        // object serves both, exactly as the real PostgREST builder does.
        return {
          select: () => ({ single: () => Promise.resolve(answer) }),
          then: (resolve: (value: { error: unknown }) => unknown) =>
            Promise.resolve({ error: answer.error }).then(resolve),
        };
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

// ===========================================================================
// The second channel
// ===========================================================================
//
// Doc 30 section 5.2 step 3 has the fan-out write one row PER CHANNEL and then
// enqueue the sends. Which kinds get an email is ../kinds.ts's decision and is
// argued there; what is pinned here is that the decision is HONOURED, and that
// the email half is best effort in the strong sense - it cannot cost the inbox
// message, which is the guaranteed channel.

describe("the email channel", () => {
  it("writes the inbox row as already sent, because there is no send to wait for", async () => {
    const fake = createFake();

    await raiseNotification({ ...input(), deps: fake.deps });

    expect(fake.inserts[0]?.payload).toMatchObject({ channel: "in_app", status: "sent" });
    expect(fake.inserts[0]?.payload.sent_at).toEqual(expect.any(String));
  });

  it("writes no email row for a kind the registry does not list email on", async () => {
    const fake = createFake();

    await raiseNotification({ ...input({ kind: "points_awarded" }), deps: fake.deps });

    expect(fake.inserts).toHaveLength(1);
  });

  it("writes a pending email row for a rejection, carrying the same words", async () => {
    const fake = createFake();

    const ok = await raiseNotification({
      ...input({
        kind: "receipt_rejected",
        title: "Already scanned",
        body: "This receipt is already on your account. Each receipt can earn points once.",
      }),
      deps: fake.deps,
    });

    expect(ok).toBe(true);
    expect(fake.inserts).toHaveLength(2);
    expect(fake.inserts[1]?.payload).toMatchObject({
      channel: "email",
      // Durable BEFORE any send is attempted, which is what makes the send
      // idempotent and replayable.
      status: "pending",
      kind: "receipt_rejected",
      title: "Already scanned",
      user_id: USER_ID,
      business_id: BUSINESS_ID,
    });
    // The email row carries no sent_at: nothing has been sent yet, and a
    // timestamp here would make the worker's own idempotency gate a lie.
    expect(fake.inserts[1]?.payload.sent_at).toBeUndefined();
  });

  // The property the whole ordering exists for. A consumer who gets the inbox
  // message and no email has been told; one who gets neither has not.
  it("CRITICAL: still reports success when the email row cannot be written", async () => {
    const fake = createFake("email-row-fails");

    const ok = await raiseNotification({
      ...input({ kind: "receipt_rejected", title: "Already scanned", body: "It is on your account." }),
      deps: fake.deps,
    });

    expect(ok).toBe(true);
    expect(fake.inserts[0]?.payload).toMatchObject({ channel: "in_app" });
  });

  // The enqueue runs with no service-role client in this suite (see the mock at
  // the top), so it returns a failure rather than publishing - which is the
  // degraded state a developer machine is actually in, and it must be silent.
  it("CRITICAL: still reports success when the send cannot be enqueued", async () => {
    const fake = createFake();

    const ok = await raiseNotification({
      ...input({ kind: "receipt_rejected", title: "Already scanned", body: "It is on your account." }),
      deps: fake.deps,
    });

    expect(ok).toBe(true);
  });
});
