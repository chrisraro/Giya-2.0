// @vitest-environment node
//
// jose constructs Uint8Array payloads internally; jsdom (the project's
// default test environment) runs in a separate realm whose Uint8Array is
// not `instanceof` the outer Node realm's Uint8Array, which trips jose's
// internal type guards. This module is server-only with no DOM dependency,
// so run it under the plain Node environment instead.

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests.
vi.mock("server-only", () => ({}));

const TEST_SECRET = "a".repeat(32);

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "a".repeat(20),
    REDEMPTION_TOKEN_SECRET: TEST_SECRET,
  }),
}));

const redisMocks = vi.hoisted(() => ({
  setNx: vi.fn(),
  getDel: vi.fn(),
  setGet: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  setNx: redisMocks.setNx,
  getDel: redisMocks.getDel,
  setGet: redisMocks.setGet,
  del: redisMocks.del,
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

function secretKey(): Uint8Array {
  return new TextEncoder().encode(TEST_SECRET);
}

describe("mintRedemptionToken", () => {
  beforeEach(() => {
    redisMocks.setNx.mockReset();
    redisMocks.getDel.mockReset();
    redisMocks.setGet.mockReset().mockResolvedValue(null);
    redisMocks.del.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a token whose payload carries claimId, businessId, jti, and ~300s expiry", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    const { mintRedemptionToken } = await import("./token");
    const { jwtVerify } = await import("jose");

    const before = Math.floor(Date.now() / 1000);
    const minted = await mintRedemptionToken("claim-1", "biz-1");
    const after = Math.floor(Date.now() / 1000);

    const { payload } = await jwtVerify(minted.token, secretKey(), {
      algorithms: ["HS256"],
    });

    expect(payload.claimId).toBe("claim-1");
    expect(payload.businessId).toBe("biz-1");
    expect(payload.jti).toBe(minted.jti);
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp as number).toBeGreaterThanOrEqual(before + 300);
    expect(payload.exp as number).toBeLessThanOrEqual(after + 300);

    const expiresAtSeconds = Math.floor(new Date(minted.expiresAt).getTime() / 1000);
    expect(expiresAtSeconds).toBe(payload.exp);
  });

  it("stores the claimId under the jti key with a 300s TTL via setNx", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    const { mintRedemptionToken } = await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");

    expect(redisMocks.setNx).toHaveBeenCalledWith(
      `test:redeem:jti:${minted.jti}`,
      "claim-1",
      300,
    );
  });

  it("throws when setNx returns false (jti collision)", async () => {
    redisMocks.setNx.mockResolvedValue(false);
    const { mintRedemptionToken, RedemptionTokenError } = await import("./token");

    await expect(mintRedemptionToken("claim-1", "biz-1")).rejects.toThrow(
      RedemptionTokenError,
    );
  });

  it("writes the claim's pointer key to the new jti with a 300s TTL via the atomic SET...GET swap", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    redisMocks.setGet.mockResolvedValue(null);
    const { mintRedemptionToken } = await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");

    expect(redisMocks.setGet).toHaveBeenCalledWith(
      "test:redeem:claim:claim-1",
      minted.jti,
      300,
    );
  });

  it("on first mint for a claim, the pointer swap returns no previous jti and nothing is deleted", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    redisMocks.setGet.mockResolvedValue(null);
    const { mintRedemptionToken } = await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");

    expect(redisMocks.setGet).toHaveBeenCalledWith(
      "test:redeem:claim:claim-1",
      minted.jti,
      300,
    );
    expect(redisMocks.del).not.toHaveBeenCalled();
  });

  it("minting a second time for the same claim deletes the first jti key and leaves only the second live", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    redisMocks.setGet.mockResolvedValueOnce(null);
    const { mintRedemptionToken, consumeRedemptionToken } = await import("./token");

    const first = await mintRedemptionToken("claim-1", "biz-1");

    // Second mint's pointer swap returns the first jti as the previous
    // value (this is what a real Redis SET...GET would return).
    redisMocks.setGet.mockResolvedValueOnce(first.jti);
    const second = await mintRedemptionToken("claim-1", "biz-1");

    expect(redisMocks.del).toHaveBeenCalledWith(`test:redeem:jti:${first.jti}`);
    expect(redisMocks.setGet).toHaveBeenLastCalledWith(
      "test:redeem:claim:claim-1",
      second.jti,
      300,
    );

    // Consuming the now-invalidated first token fails: its jti key is gone
    // (GETDEL on it returns null, exactly as if it had been consumed).
    redisMocks.getDel.mockResolvedValueOnce(null);
    await expect(consumeRedemptionToken(first.token)).rejects.toMatchObject({
      code: "REDEMPTION_TOKEN_INVALID",
    });

    // Consuming the second (current) token still succeeds.
    redisMocks.getDel.mockResolvedValueOnce("claim-1");
    await expect(consumeRedemptionToken(second.token)).resolves.toMatchObject({
      claimId: "claim-1",
      jti: second.jti,
    });
  });

  it("does not delete anything when the pointer swap returns this mint's own jti as 'previous' (defensive no-op)", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    // Contrived: a real random jti can never collide with itself, but the
    // `previousJti !== jti` guard must not delete the code it just made
    // live if this were ever to happen.
    redisMocks.setGet.mockImplementationOnce(async (_key: string, jti: string) => jti);
    const { mintRedemptionToken } = await import("./token");

    await mintRedemptionToken("claim-1", "biz-1");

    expect(redisMocks.del).not.toHaveBeenCalled();
  });

  it("interleaved concurrent mints for the same claim leave exactly one live jti, regardless of which one's pointer swap lands at Redis first", async () => {
    redisMocks.setNx.mockResolvedValue(true);

    // Models the atomic pointer swap generically rather than assuming
    // which mint's SET...GET call "wins": whichever call reaches this mock
    // FIRST is treated as having landed at Redis first (no previous
    // pointer value); whichever lands SECOND observes the first one's jti
    // as the previous value - exactly what a real Redis SET...GET returns,
    // regardless of which mint's request actually arrives first. Running
    // both mints via Promise.all lets real promise-scheduling order (which
    // we do not control) decide who lands first; the invariant under test
    // is that the OUTCOME - exactly one live jti - holds either way.
    let firstJti: string | null = null;
    redisMocks.setGet.mockImplementation(async (_key: string, jti: string) => {
      if (firstJti === null) {
        firstJti = jti;
        return null;
      }
      return firstJti;
    });

    const { mintRedemptionToken } = await import("./token");

    const [a, b] = await Promise.all([
      mintRedemptionToken("claim-1", "biz-1"),
      mintRedemptionToken("claim-1", "biz-1"),
    ]);

    expect(a.jti).not.toBe(b.jti);
    expect(firstJti).not.toBeNull();
    const displacedJti = firstJti as string;
    const survivingJti = a.jti === displacedJti ? b.jti : a.jti;

    // Exactly one live jti: the one that landed first was displaced and
    // deleted by the other; the survivor was never deleted.
    expect(redisMocks.del).toHaveBeenCalledTimes(1);
    expect(redisMocks.del).toHaveBeenCalledWith(`test:redeem:jti:${displacedJti}`);
    expect(redisMocks.del).not.toHaveBeenCalledWith(`test:redeem:jti:${survivingJti}`);
  });
});

describe("consumeRedemptionToken", () => {
  beforeEach(() => {
    redisMocks.setNx.mockReset();
    redisMocks.getDel.mockReset();
    redisMocks.setGet.mockReset().mockResolvedValue(null);
    redisMocks.del.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds and returns the payload when getDel returns the matching claimId", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    redisMocks.getDel.mockResolvedValue("claim-1");
    const { mintRedemptionToken, consumeRedemptionToken } = await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");
    const result = await consumeRedemptionToken(minted.token);

    expect(result).toEqual({ claimId: "claim-1", businessId: "biz-1", jti: minted.jti });
    expect(redisMocks.getDel).toHaveBeenCalledWith(`test:redeem:jti:${minted.jti}`);
  });

  it("throws REDEMPTION_TOKEN_INVALID when getDel returns null (replay: already consumed)", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    const { mintRedemptionToken, consumeRedemptionToken, RedemptionTokenError } =
      await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");

    // First consume succeeds (key existed)...
    redisMocks.getDel.mockResolvedValueOnce("claim-1");
    await consumeRedemptionToken(minted.token);

    // ...second consume of the SAME token replays it: GETDEL now returns
    // null because the key was already deleted. This is the core anti-
    // replay guarantee and the single most important test in this module.
    redisMocks.getDel.mockResolvedValueOnce(null);
    await expect(consumeRedemptionToken(minted.token)).rejects.toThrow(
      RedemptionTokenError,
    );
    await expect(consumeRedemptionToken(minted.token)).rejects.toMatchObject({
      code: "REDEMPTION_TOKEN_INVALID",
    });
  });

  it("rejects a token with a tampered signature", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    const { mintRedemptionToken, consumeRedemptionToken, RedemptionTokenError } =
      await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");
    const parts = minted.token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -2)}zz`;

    await expect(consumeRedemptionToken(tampered)).rejects.toThrow(RedemptionTokenError);
    expect(redisMocks.getDel).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({
      claimId: "claim-1",
      businessId: "biz-1",
      jti: "expired-jti",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(nowSeconds - 600)
      .setExpirationTime(nowSeconds - 300)
      .sign(secretKey());

    const { consumeRedemptionToken, RedemptionTokenError } = await import("./token");

    await expect(consumeRedemptionToken(expiredToken)).rejects.toThrow(
      RedemptionTokenError,
    );
    expect(redisMocks.getDel).not.toHaveBeenCalled();
  });

  it("rejects when the stored claimId does not match the token's claimId", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    redisMocks.getDel.mockResolvedValue("some-other-claim");
    const { mintRedemptionToken, consumeRedemptionToken, RedemptionTokenError } =
      await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");

    await expect(consumeRedemptionToken(minted.token)).rejects.toThrow(
      RedemptionTokenError,
    );
  });

  it("does not touch the pointer key on consume (left to expire on its own TTL - see comment in source)", async () => {
    redisMocks.setNx.mockResolvedValue(true);
    redisMocks.getDel.mockResolvedValue("claim-1");
    const { mintRedemptionToken, consumeRedemptionToken } = await import("./token");

    const minted = await mintRedemptionToken("claim-1", "biz-1");
    redisMocks.del.mockClear();
    await consumeRedemptionToken(minted.token);

    // A blind DEL of the pointer here could destroy a pointer a concurrent
    // newer mint for the same claim just wrote via its own atomic
    // SET...GET swap; the fix removes the delete entirely and lets the
    // pointer's own TTL clean it up.
    expect(redisMocks.del).not.toHaveBeenCalled();
  });
});
