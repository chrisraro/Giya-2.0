// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests -
// same precedent as src/features/rewards/server/token.test.ts and
// src/features/integrations/meta/server/state.test.ts.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { generateInviteToken, inviteExpiresAt, INVITE_TTL_DAYS } = await import("./token");

describe("generateInviteToken", () => {
  it("is unguessable: 32 bytes of entropy, base64url-encoded", () => {
    // Mutant this catches: shrinking TOKEN_BYTES (e.g. to 16, or to a uuid's
    // 16 bytes rendered as text) would still pass a bare truthiness check.
    // Asserting the actual decoded length pins the entropy, not just "some
    // string came back".
    const token = generateInviteToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("uses the URL-safe alphabet (no +, /, or = padding)", () => {
    // Mutant: swapping base64url for plain base64 would still produce a
    // same-length string but could emit '+', '/' or '=', which is not safe to
    // drop into a URL path segment unescaped.
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats across calls", () => {
    // Mutant: a hardcoded or seeded (non-random) token would fail this.
    const tokens = new Set(Array.from({ length: 50 }, () => generateInviteToken()));
    expect(tokens.size).toBe(50);
  });
});

describe("inviteExpiresAt", () => {
  it("is exactly INVITE_TTL_DAYS (7) days after the given instant", () => {
    // Mutant: off-by-one on the day math (e.g. +6 or +8 days, or using
    // getDate() and drifting across a month boundary) is caught by pinning
    // the exact millisecond delta against the imported constant.
    const from = new Date("2026-08-01T00:00:00.000Z");
    const expires = new Date(inviteExpiresAt(from));

    expect(INVITE_TTL_DAYS).toBe(7);
    expect(expires.getTime() - from.getTime()).toBe(INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  });

  it("defaults to now when no instant is given", () => {
    // Mutant: forgetting the default parameter (always requiring `from`)
    // would be a compile error, not a silent bug - but a mutant that ignores
    // the passed-in `from` entirely and always uses `new Date()` is caught by
    // the fixed-instant test above already producing a stable delta; this
    // test instead pins that calling with no argument does not throw and
    // lands close to "now", not at the epoch.
    const before = Date.now();
    const expires = new Date(inviteExpiresAt()).getTime();
    const after = Date.now();

    expect(expires).toBeGreaterThan(before);
    expect(expires - before).toBeLessThan(INVITE_TTL_DAYS * 24 * 60 * 60 * 1000 + 5000);
    expect(expires).toBeGreaterThan(after - 1000);
  });
});
