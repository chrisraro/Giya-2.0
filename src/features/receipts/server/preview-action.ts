"use server";

import { computePoints } from "@/features/points/compute";
import type { PointsRule } from "@/features/points/types";

export interface PreviewInput {
  amountCentavos: number;
  businessTimezone?: string;
  baseRateCentavosPerPoint?: number;
  multiplier?: number;
}

export async function previewReceiptPointsAction(input: PreviewInput): Promise<{
  ok: true;
  points: number;
  basePoints: number;
  multiplierExtras: number;
} | { ok: false; message: string }> {
  try {
    const rate = input.baseRateCentavosPerPoint ?? 100;
    const baseRule: PointsRule = {
      id: "base-preview",
      rule_type: "amount_rate",
      rate_centavos_per_point: rate,
      rounding: "floor",
      kind: "base",
    };

    const candidateRules: PointsRule[] = [];
    if (input.multiplier && input.multiplier > 1) {
      candidateRules.push({
        id: "multiplier-preview",
        rule_type: "amount_rate",
        multiplier: input.multiplier,
        rounding: "floor",
        kind: "multiplier",
      });
    }

    const res = computePoints({
      amountCentavos: input.amountCentavos,
      receiptDate: new Date(),
      businessTimezone: input.businessTimezone ?? "Asia/Manila",
      baseRule,
      candidateRules,
    });

    return {
      ok: true,
      points: res.points,
      basePoints: res.breakdown.basePoints,
      multiplierExtras: res.breakdown.multiplierExtras,
    };
  } catch (err: any) {
    return { ok: false, message: err.message ?? "Preview failed" };
  }
}
