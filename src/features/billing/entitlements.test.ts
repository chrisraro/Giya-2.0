import { describe, expect, it } from "vitest";
import { checkBusinessEntitlement, PLAN_LIMITS } from "./entitlements";

describe("Billing Entitlements", () => {
  it("enforces plan limits for free tier vs growth tier", () => {
    expect(PLAN_LIMITS.free.maxActivePromotions).toBe(2);
    expect(PLAN_LIMITS.growth.maxActivePromotions).toBe(50);

    const freeCheck = checkBusinessEntitlement("free", "activePromotionsCount", 3);
    expect(freeCheck.allowed).toBe(false);
    expect(freeCheck.upgradeRequired).toBe(true);

    const growthCheck = checkBusinessEntitlement("growth", "activePromotionsCount", 3);
    expect(growthCheck.allowed).toBe(true);
  });
});
