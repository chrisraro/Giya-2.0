export type PlanTier = "free" | "starter" | "growth" | "enterprise";

export interface PlanLimitsDTO {
  maxActivePromotions: number;
  maxStaffAccounts: number;
  aiDailyCostMicrosCap: number;
  advancedAnalyticsEnabled: boolean;
  metaPublishingEnabled: boolean;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimitsDTO> = {
  free: {
    maxActivePromotions: 2,
    maxStaffAccounts: 2,
    aiDailyCostMicrosCap: 500_000, // $0.50/day
    advancedAnalyticsEnabled: false,
    metaPublishingEnabled: false,
  },
  starter: {
    maxActivePromotions: 10,
    maxStaffAccounts: 5,
    aiDailyCostMicrosCap: 2_000_000, // $2.00/day
    advancedAnalyticsEnabled: true,
    metaPublishingEnabled: false,
  },
  growth: {
    maxActivePromotions: 50,
    maxStaffAccounts: 20,
    aiDailyCostMicrosCap: 10_000_000, // $10.00/day
    advancedAnalyticsEnabled: true,
    metaPublishingEnabled: true,
  },
  enterprise: {
    maxActivePromotions: 999_999,
    maxStaffAccounts: 999_999,
    aiDailyCostMicrosCap: 100_000_000, // $100.00/day
    advancedAnalyticsEnabled: true,
    metaPublishingEnabled: true,
  },
};

export type EntitlementMetric = "activePromotionsCount" | "staffAccountsCount";

export function checkBusinessEntitlement(
  plan: PlanTier,
  metric: EntitlementMetric,
  currentCount: number,
): { allowed: boolean; upgradeRequired: boolean; limit: number } {
  const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

  if (metric === "activePromotionsCount") {
    const allowed = currentCount < limits.maxActivePromotions;
    return { allowed, upgradeRequired: !allowed, limit: limits.maxActivePromotions };
  }

  if (metric === "staffAccountsCount") {
    const allowed = currentCount < limits.maxStaffAccounts;
    return { allowed, upgradeRequired: !allowed, limit: limits.maxStaffAccounts };
  }

  return { allowed: true, upgradeRequired: false, limit: 999_999 };
}
