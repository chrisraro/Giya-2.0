// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests -
// same precedent as src/features/rewards/server/token.test.ts and
// src/features/integrations/meta/server/state.test.ts.
import { readFileSync } from "node:fs";
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

// Review fix M7: the three tests above (length, alphabet, no repeats across
// 50 calls) all pass for a token filled by `Math.random()` instead of
// `randomBytes` - non-cryptographic randomness is still random, still 32
// bytes, still base64url-safe. What those tests cannot tell apart is WHICH
// entropy SOURCE produced the bytes, and that is the entire security
// property this module exists for (see its own header: "an attacker cannot
// guess a live one" - `Math.random()`'s PRNG state is not cryptographically
// unpredictable).
//
// A RUNTIME spy on `node:crypto` was tried first (`vi.mock("node:crypto",
// ...)`, delegating to `importOriginal()`) and does not work in this
// project's vitest setup: the mock factory itself runs (confirmed via a
// debug log), but `token.ts`'s own `import { randomBytes } from
// "node:crypto"` binding never observes the wrapper - Node built-ins are
// evidently resolved outside whatever module graph `vi.mock` intercepts
// here, a known class of limitation for native ESM built-ins. Rather than
// spend further budget on vitest/pool configuration to make that work, this
// pins the SOURCE statically instead: read the compiled TypeScript source
// and assert it imports `randomBytes` from `"node:crypto"` and contains no
// `Math.random` fallback. Less elegant than a runtime spy, but reliable, and
// it catches exactly the mutant class M7 named.
describe("generateInviteToken's entropy source (source-level, see comment above)", () => {
  it("imports randomBytes from node:crypto and never references Math.random", () => {
    // Mutant: swapping the import for a `Math.random()`-based fill (or any
    // other non-crypto PRNG) changes what this file contains, which is
    // exactly what this test reads.
    const source = readFileSync("src/features/businesses/staff/server/token.ts", "utf8");

    expect(source).toMatch(/import\s*\{\s*randomBytes\s*\}\s*from\s*"node:crypto"/);
    expect(source).not.toMatch(/Math\.random/);
  });

  it("review fix R5: generateInviteToken's RETURN EXPRESSION is randomBytes's own output, not merely an unused import sitting nearby", () => {
    // The test above is shallower than it reads (the review's own words):
    // importing `randomBytes` and never writing `Math.random` is satisfied
    // by, for example, a monotonic counter -
    //
    //   let n = 0;
    //   export function generateInviteToken(): string {
    //     n += 1;
    //     return Buffer.alloc(32).fill(0).map((_, i) => (i === 31 ? n : 0))
    //       ...toString("base64url");
    //   }
    //
    // - which imports `randomBytes`, never mentions `Math.random`, and
    //   still passes every test above (fixed length, url-safe alphabet, and
    //   even "never repeats" for the first 50 calls) while being exactly
    //   "sequential", which the module's own header explicitly rules out
    //   ("Not a uuid: a v4 uuid is 122 bits with a recognisable shape...").
    // This asserts the RETURN STATEMENT ITSELF calls `randomBytes` and
    // pipes its output straight to the returned string - a positive,
    // structural pin on what is actually returned, not an absence check on
    // what ISN'T.
    const source = readFileSync("src/features/businesses/staff/server/token.ts", "utf8");

    expect(source).toMatch(
      /return\s+randomBytes\(\s*TOKEN_BYTES\s*\)\.toString\(\s*"base64url"\s*\)\s*;/,
    );
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
