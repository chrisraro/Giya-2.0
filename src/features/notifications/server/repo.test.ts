// @vitest-environment node
//
// The inbox reads and the two mark-read writes.
//
// What is worth pinning here is not "the query runs" but the four decisions
// that are easy to get wrong and invisible when they are:
//   * every query constrains user_id itself rather than trusting RLS alone;
//   * the unread count is a HEAD count, not a list someone counted;
//   * mark-read only touches unread rows, so read_at keeps meaning "when you
//     first saw this" (the 90-day retention sweep counts from it);
//   * the destination comes off the ROW, never from the caller.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import {
  getMyUnreadNotificationCount,
  listMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./repo";

const USER_ID = "01980000-0000-7000-8000-0000000000c1";

interface Op {
  table: string;
  op: "select" | "update";
  columns: string;
  options: { count?: string; head?: boolean } | undefined;
  payload: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

interface Result {
  data: unknown;
  count?: number | null;
  error: { message: string } | null;
}

type Responder = (op: Op) => Result;

class Query implements PromiseLike<Result> {
  readonly op: Op;

  constructor(
    table: string,
    private readonly respond: Responder,
    private readonly record: (op: Op) => void,
  ) {
    this.op = {
      table,
      op: "select",
      columns: "*",
      options: undefined,
      payload: undefined,
      filters: [],
    };
  }

  select(columns?: string, options?: { count?: string; head?: boolean }): this {
    this.op.columns = columns ?? "*";
    if (options !== undefined) this.op.options = options;
    // A HEAD count resolves immediately rather than through .then, so the
    // awaited value has to come from the same responder either way.
    return this;
  }
  update(payload: unknown): this {
    this.op.op = "update";
    this.op.payload = payload;
    return this;
  }
  private filter(method: string, ...args: unknown[]): this {
    this.op.filters.push({ method, args });
    return this;
  }
  eq(column: string, value: unknown): this {
    return this.filter("eq", column, value);
  }
  is(column: string, value: unknown): this {
    return this.filter("is", column, value);
  }
  order(column: string, options?: unknown): this {
    return this.filter("order", column, options);
  }
  limit(count: number): this {
    return this.filter("limit", count);
  }
  maybeSingle(): this {
    return this.filter("maybeSingle");
  }

  then<T1 = Result, T2 = never>(
    onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => {
        this.record(this.op);
        const result = this.respond(this.op);
        const single = this.op.filters.some((f) => f.method === "maybeSingle");
        if (!single || result.error !== null) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { ...result, data };
      })
      .then(onFulfilled, onRejected);
  }
}

function harness(respond: Responder, userId: string | null = USER_ID) {
  const ops: Op[] = [];
  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: userId === null ? null : { id: userId } } }),
    },
    from: (table: string) => new Query(table, respond, (op) => ops.push(op)),
  });
  return { ops };
}

function eqValue(op: Op, column: string): unknown {
  return op.filters.find((f) => f.method === "eq" && f.args[0] === column)?.args[1];
}

const ROW = {
  id: "n1",
  kind: "points_awarded",
  title: "Points added",
  body: "120 points are now in your Kape Diaria wallet.",
  data: { route: "/scan/r1", params: { points: 120 } },
  business_id: "b1",
  read_at: null,
  created_at: "2026-07-26T02:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listMyNotifications", () => {
  it("returns the caller's rows, newest first, mapped to DTOs", async () => {
    const { ops } = harness(() => ({ data: [ROW], error: null }));

    const list = await listMyNotifications();

    expect(list).toEqual([
      {
        id: "n1",
        kind: "points_awarded",
        title: "Points added",
        body: "120 points are now in your Kape Diaria wallet.",
        route: "/scan/r1",
        businessId: "b1",
        readAt: null,
        createdAt: "2026-07-26T02:00:00.000Z",
      },
    ]);
    expect(eqValue(ops[0] as Op, "user_id")).toBe(USER_ID);
  });

  it("CRITICAL: constrains user_id in the query rather than trusting RLS alone", async () => {
    const { ops } = harness(() => ({ data: [], error: null }));

    await listMyNotifications();

    expect(ops[0]?.filters.some((f) => f.method === "eq" && f.args[0] === "user_id")).toBe(
      true,
    );
  });

  it("names its columns rather than selecting everything", async () => {
    const { ops } = harness(() => ({ data: [], error: null }));

    await listMyNotifications();

    expect(ops[0]?.columns).not.toBe("*");
  });

  it("drops a route that is not an app-relative path", async () => {
    harness(() => ({
      data: [{ ...ROW, data: { route: "https://evil.example" } }],
      error: null,
    }));

    const list = await listMyNotifications();

    expect(list[0]?.route).toBeNull();
  });

  it("returns an empty list for a signed-out caller and reads nothing", async () => {
    const { ops } = harness(() => ({ data: [ROW], error: null }), null);

    expect(await listMyNotifications()).toEqual([]);
    expect(ops).toHaveLength(0);
  });

  it("returns an empty list rather than throwing when the read fails", async () => {
    harness(() => ({ data: null, error: { message: "boom" } }));

    expect(await listMyNotifications()).toEqual([]);
  });
});

describe("getMyUnreadNotificationCount", () => {
  it("counts unread rows without fetching any of them", async () => {
    const { ops } = harness(() => ({ data: null, count: 7, error: null }));

    expect(await getMyUnreadNotificationCount()).toBe(7);
    expect(ops[0]?.options).toMatchObject({ count: "exact", head: true });
    expect(
      ops[0]?.filters.some((f) => f.method === "is" && f.args[0] === "read_at"),
    ).toBe(true);
  });

  it("returns zero, which renders no badge, when the count cannot be read", async () => {
    harness(() => ({ data: null, count: null, error: { message: "boom" } }));

    expect(await getMyUnreadNotificationCount()).toBe(0);
  });

  it("returns zero for a signed-out caller", async () => {
    harness(() => ({ data: null, count: 9, error: null }), null);

    expect(await getMyUnreadNotificationCount()).toBe(0);
  });
});

describe("markNotificationRead", () => {
  it("writes read_at and answers with the row's own destination", async () => {
    const { ops } = harness(() => ({ data: { data: { route: "/scan/r1" } }, error: null }));

    expect(await markNotificationRead("n1")).toEqual({ route: "/scan/r1" });

    const write = ops[0] as Op;
    expect(write.op).toBe("update");
    expect(Object.keys(write.payload as object)).toEqual(["read_at"]);
    expect(eqValue(write, "user_id")).toBe(USER_ID);
  });

  it("CRITICAL: only touches unread rows, so read_at keeps meaning first seen", async () => {
    const { ops } = harness(() => ({ data: { data: {} }, error: null }));

    await markNotificationRead("n1");

    expect(
      (ops[0] as Op).filters.some((f) => f.method === "is" && f.args[0] === "read_at"),
    ).toBe(true);
  });

  it("still answers with the destination when the row was already read", async () => {
    // First statement (the conditional update) matches nothing; the fallback
    // read supplies the route so an already-read notification still opens.
    let call = 0;
    harness(() => {
      call += 1;
      return call === 1
        ? { data: null, error: null }
        : { data: { data: { route: "/scan/r1" } }, error: null };
    });

    expect(await markNotificationRead("n1")).toEqual({ route: "/scan/r1" });
  });

  it("answers null for someone else's notification, indistinguishably from a missing one", async () => {
    harness(() => ({ data: null, error: null }));

    expect(await markNotificationRead("n-not-mine")).toBeNull();
  });

  it("answers null rather than throwing when the write fails", async () => {
    harness(() => ({ data: null, error: { message: "boom" } }));

    expect(await markNotificationRead("n1")).toBeNull();
  });
});

describe("markAllNotificationsRead", () => {
  it("marks every unread row of the caller's and reports how many moved", async () => {
    const { ops } = harness(() => ({ data: [{ id: "n1" }, { id: "n2" }], error: null }));

    expect(await markAllNotificationsRead()).toBe(2);

    const write = ops[0] as Op;
    expect(write.op).toBe("update");
    expect(eqValue(write, "user_id")).toBe(USER_ID);
    expect(write.filters.some((f) => f.method === "is" && f.args[0] === "read_at")).toBe(
      true,
    );
    // No id filter: this is the batch variant, scoped by recipient alone.
    expect(eqValue(write, "id")).toBeUndefined();
  });

  it("reports zero when there was nothing to mark", async () => {
    harness(() => ({ data: [], error: null }));

    expect(await markAllNotificationsRead()).toBe(0);
  });

  it("reports zero rather than throwing when the write fails", async () => {
    harness(() => ({ data: null, error: { message: "boom" } }));

    expect(await markAllNotificationsRead()).toBe(0);
  });
});
