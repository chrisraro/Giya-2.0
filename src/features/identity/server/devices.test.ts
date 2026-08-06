import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `public.user_devices` was ENTIRELY DEAD before this slice: the table, its RLS
// policy, its partial index and a receipts.device_id foreign key all existed and
// `grep` across src/ returned zero references. Nobody's device was ever
// registered, so the device list nobody could reach would have been empty for
// everybody anyway.
//
// THE DESIGN DECISION THIS FILE PINS: WHAT IS A DEVICE?
//
// `user_devices` has exactly one unique key - `fcm_token` - and this slice does
// not build push (that is Wave 7), so every row it writes has a null token and
// the unique key does nothing. Something else has to answer "is this the same
// device signing in again?", and if nothing does, every sign-in appends a row
// and the list becomes a login log.
//
// The rule chosen is `(user_id, platform, user_agent)`, and the reason is that
// it is the only identity available that is stable ACROSS sessions and distinct
// BETWEEN browsers. A session id changes on every refresh. An IP address changes
// between mobile data and wifi and is shared behind CGNAT. The user agent is the
// one thing the same browser on the same machine sends every time.
//
// Its two costs, accepted deliberately:
//
//   * Two identical browsers on two identical machines collapse into one row.
//     The consequence is one list entry where there should be two, which is a
//     less bad failure than an unbounded list of duplicates that makes the
//     revoke control useless.
//   * A browser upgrade changes the version string and therefore the identity,
//     so an upgraded browser appears as a new device. That is honest - it is a
//     new client build - and the old row ages out visibly by `last_seen_at`.
//
// There is no unique INDEX behind this rule and there deliberately is no
// migration adding one (T3.4b writes no SQL). Two logins racing in the same
// millisecond can therefore both miss the read and both insert. That is a
// duplicate row, not corruption, and the next login updates whichever it finds.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  headers: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  limit: vi.fn(),
  order: vi.fn(),
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  /** Resolves every chain that ends without an explicit terminal call. */
  terminal: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

const { deleteDevice, listMyDevices, registerDevice } = await import("./devices");

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const NOW = new Date("2026-08-06T12:00:00.000Z");

/** The chain object every PostgREST builder call returns. Thenable, so a chain
 *  that ends on `.eq()` or `.order()` resolves like a real query does. */
function chain(): Record<string, unknown> {
  const self: Record<string, unknown> = {
    select: mocks.select,
    eq: mocks.eq,
    limit: mocks.limit,
    order: mocks.order,
    maybeSingle: mocks.maybeSingle,
    insert: mocks.insert,
    update: mocks.update,
    delete: mocks.del,
    then: (resolve: (value: unknown) => unknown) => resolve(mocks.terminal),
  };
  return self;
}

function requestFrom(userAgent: string | null) {
  mocks.headers.mockResolvedValue({ get: (name: string) => (name === "user-agent" ? userAgent : null) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  mocks.terminal.data = null;
  mocks.terminal.error = null;

  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  requestFrom(CHROME_WINDOWS);

  mocks.select.mockImplementation(() => chain());
  mocks.eq.mockImplementation(() => chain());
  mocks.limit.mockImplementation(() => chain());
  mocks.order.mockImplementation(() => chain());
  mocks.update.mockImplementation(() => chain());
  mocks.del.mockImplementation(() => chain());
  mocks.insert.mockResolvedValue({ error: null });
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

  mocks.from.mockImplementation((table: string) => {
    if (table === "user_devices") return chain();
    throw new Error(`unexpected table: ${table}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerDevice", () => {
  it("registers a web device for the caller", async () => {
    await registerDevice();

    expect(mocks.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      platform: "web",
      user_agent: CHROME_WINDOWS,
      last_seen_at: NOW.toISOString(),
    });
  });

  it("CRITICAL: leaves fcm_token unset - this slice does not build push", async () => {
    // fcm_token is `unique`, so writing a placeholder into it would make the
    // SECOND consumer to register collide with the first. Wave 7 owns it.
    await registerDevice();

    expect(Object.keys(mocks.insert.mock.calls[0]?.[0] ?? {})).not.toContain("fcm_token");
  });

  it("CRITICAL: a second sign-in from the same browser UPDATES the one row", async () => {
    // The whole point of the identity rule. Without it every sign-in appends a
    // row and the device list becomes a login log nobody can act on.
    mocks.maybeSingle.mockResolvedValue({ data: { id: "device-1" }, error: null });

    await registerDevice();

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ last_seen_at: NOW.toISOString() });
    expect(mocks.eq).toHaveBeenCalledWith("id", "device-1");
  });

  it("CRITICAL: looks the device up by user, platform AND user agent", async () => {
    await registerDevice();

    expect(mocks.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(mocks.eq).toHaveBeenCalledWith("platform", "web");
    expect(mocks.eq).toHaveBeenCalledWith("user_agent", CHROME_WINDOWS);
  });

  it("gives a different browser on the same account its own row", async () => {
    requestFrom(SAFARI_IPHONE);

    await registerDevice();

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_agent: SAFARI_IPHONE }),
    );
  });

  it("CRITICAL: registers nothing at all when the request carries no user agent", async () => {
    // Without a user agent there is no identity, so every sign-in would append
    // one more indistinguishable row. Registering nothing is the honest answer:
    // the consumer sees no device rather than a growing pile of unnameable ones.
    requestFrom(null);

    await registerDevice();

    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("registers nothing when there is no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    await registerDevice();

    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("stores and matches on the SAME truncated user agent", async () => {
    // A header is caller-controlled and unbounded; `user_agent` is `text`.
    // Truncating on write without truncating on lookup would mean the row is
    // never found again and a row is appended on every single sign-in.
    const huge = `${CHROME_WINDOWS} ${"x".repeat(5000)}`;
    requestFrom(huge);

    await registerDevice();

    const stored = (mocks.insert.mock.calls[0]?.[0] as { user_agent: string }).user_agent;
    const lookedUp = mocks.eq.mock.calls.find((call) => call[0] === "user_agent")?.[1];
    expect(stored.length).toBeLessThan(huge.length);
    expect(lookedUp).toBe(stored);
  });

  it("CRITICAL: never throws, whatever the database says", async () => {
    // This runs on the sign-in path. A device row that could not be written is
    // not a reason to fail somebody's login.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.insert.mockResolvedValue({ error: { message: "deadlock detected" } });

    await expect(registerDevice()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("never throws when even the lookup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } });

    await expect(registerDevice()).resolves.toBeUndefined();
    // A failed lookup must NOT fall through to an insert: that is how a
    // transient blip turns into a duplicate row.
    expect(mocks.insert).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("listMyDevices", () => {
  const ROWS = [
    {
      id: "device-1",
      platform: "web",
      user_agent: CHROME_WINDOWS,
      last_seen_at: "2026-08-06T11:00:00.000Z",
    },
    {
      id: "device-2",
      platform: "web",
      user_agent: SAFARI_IPHONE,
      last_seen_at: "2026-08-04T11:00:00.000Z",
    },
  ];

  beforeEach(() => {
    mocks.terminal.data = ROWS;
    mocks.terminal.error = null;
  });

  it("CRITICAL: renders a readable summary, never the raw user agent", async () => {
    const result = await listMyDevices();

    expect(result).toEqual({
      ok: true,
      devices: [
        { id: "device-1", summary: "Chrome on Windows", lastSeen: "1 hour ago", isCurrent: true },
        { id: "device-2", summary: "Safari on iPhone", lastSeen: "2 days ago", isCurrent: false },
      ],
    });
  });

  it("CRITICAL: marks the device the request came from, and only that one", async () => {
    requestFrom(SAFARI_IPHONE);

    const result = await listMyDevices();

    expect(result.ok && result.devices.map((device) => device.isCurrent)).toEqual([false, true]);
  });

  it("marks nothing current when the request carries no user agent", async () => {
    requestFrom(null);

    const result = await listMyDevices();

    expect(result.ok && result.devices.every((device) => !device.isCurrent)).toBe(true);
  });

  it("asks for the newest first", async () => {
    await listMyDevices();

    expect(mocks.order).toHaveBeenCalledWith("last_seen_at", { ascending: false });
  });

  it("scopes the read to the caller's own rows", async () => {
    await listMyDevices();

    expect(mocks.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("CRITICAL: no devices is ok:true with an empty list", async () => {
    // Empty is a real state a consumer can be in and it has its own screen.
    mocks.terminal.data = [];

    expect(await listMyDevices()).toEqual({ ok: true, devices: [] });
  });

  it("CRITICAL: a failed query is ok:false, which is NOT the same as no devices", async () => {
    // The two must never render the same screen. Telling somebody they have no
    // registered devices when the query timed out invites them to conclude
    // nothing is signed in anywhere.
    mocks.terminal.data = null;
    mocks.terminal.error = { message: "canceling statement due to statement timeout" };

    expect(await listMyDevices()).toEqual({ ok: false });
  });

  it("returns ok:false with no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    expect(await listMyDevices()).toEqual({ ok: false });
  });
});

describe("deleteDevice", () => {
  it("CRITICAL: deletes the row - revoking is a delete, not a flag", async () => {
    // 0017_receipts.sql makes receipts.device_id `on delete set null` with the
    // comment "so a consumer can delete a device at any time". That is the
    // designed semantics and this follows it.
    mocks.maybeSingle.mockResolvedValue({
      data: { user_agent: SAFARI_IPHONE, platform: "web" },
      error: null,
    });

    const result = await deleteDevice("device-2");

    expect(mocks.del).toHaveBeenCalled();
    expect(mocks.eq).toHaveBeenCalledWith("id", "device-2");
    expect(result).toEqual({ ok: true, wasCurrent: false });
  });

  it("CRITICAL: never sets is_revoked instead of deleting", async () => {
    // `is_revoked` exists in 0002 and is read by NOTHING. Writing it would look
    // like a revoke and leave the row in the list and in every foreign key.
    mocks.maybeSingle.mockResolvedValue({
      data: { user_agent: SAFARI_IPHONE, platform: "web" },
      error: null,
    });

    await deleteDevice("device-2");

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("scopes the delete to the caller's own row", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { user_agent: SAFARI_IPHONE, platform: "web" },
      error: null,
    });

    await deleteDevice("device-2");

    expect(mocks.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("CRITICAL: reports that the removed device was the one being used", async () => {
    // The caller turns this into a real sign-out. Getting it wrong either signs
    // somebody out of a session they were not removing, or leaves them looking
    // at a device list that no longer contains the device they are on.
    mocks.maybeSingle.mockResolvedValue({
      data: { user_agent: CHROME_WINDOWS, platform: "web" },
      error: null,
    });

    expect(await deleteDevice("device-1")).toEqual({ ok: true, wasCurrent: true });
  });

  it("returns ok:false when the row is not the caller's or no longer exists", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    expect(await deleteDevice("device-9")).toEqual({ ok: false });
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("returns ok:false when the delete itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.maybeSingle.mockResolvedValue({
      data: { user_agent: SAFARI_IPHONE, platform: "web" },
      error: null,
    });
    mocks.terminal.error = { message: "permission denied for table user_devices" };

    expect(await deleteDevice("device-2")).toEqual({ ok: false });
    consoleError.mockRestore();
  });

  it("returns ok:false with no session and deletes nothing", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    expect(await deleteDevice("device-1")).toEqual({ ok: false });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

// THE AGREEMENT TEST. Deleting a device row is only safe because 0017 says the
// receipts that point at it survive it. If that FK ever became `on delete
// restrict` or a bare reference, deleteDevice would start raising 23503 against
// receipts the consumer cannot reach, edit or remove - a dead end they could
// never clear, which is the exact failure 0017's own comment says it chose this
// action to avoid.
describe("the foreign key that makes a delete safe", () => {
  it("CRITICAL: receipts.device_id is `on delete set null`", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase", "migrations", "0017_receipts.sql"),
      "utf8",
    );

    expect(sql).toMatch(
      /device_id\s+uuid\s+references public\.user_devices\(id\) on delete set null/,
    );
  });
});
