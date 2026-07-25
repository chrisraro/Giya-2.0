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
}));

vi.mock("@/lib/redis", () => ({
  setNx: redisMocks.setNx,
  getDel: redisMocks.getDel,
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

function secretKey(): Uint8Array {
  return new TextEncoder().encode(TEST_SECRET);
}

describe("mintRedemptionToken", () => {
  beforeEach(() => {
    redisMocks.setNx.mockReset();
    redisMocks.getDel.mockReset();
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
});

describe("consumeRedemptionToken", () => {
  beforeEach(() => {
    redisMocks.setNx.mockReset();
    redisMocks.getDel.mockReset();
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
});
