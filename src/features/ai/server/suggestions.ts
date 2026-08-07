import { createClient } from "@/lib/supabase/server";

export interface CampaignSuggestion {
  title: string;
  description: string;
  family: "loyalty" | "reward" | "promotion";
  suggestedMultiplier: number;
  rationale: string;
  status: "draft";
  suggestedStartDaysFromNow: number;
  suggestedDurationDays: number;
}

export type SuggestionsResult =
  | { ok: true; suggestions: CampaignSuggestion[] }
  | { ok: false; message: string };

export async function generateCampaignSuggestions(
  businessId: string,
): Promise<SuggestionsResult> {
  const supabase = await createClient();

  const { data: analytics, error } = await (supabase as any)
    .from("analytics_daily_business")
    .select("*")
    .eq("business_id", businessId)
    .order("date", { ascending: false })
    .limit(7);

  if (error || !analytics || analytics.length === 0) {
    return {
      ok: true,
      suggestions: [
        {
          title: "Weekend Double Points Blast",
          description: "Boost weekend foot traffic with 2x points on all purchases.",
          family: "promotion",
          suggestedMultiplier: 2.0,
          rationale: "Default recommendation for new businesses to establish initial receipt volume.",
          status: "draft",
          suggestedStartDaysFromNow: 1,
          suggestedDurationDays: 3,
        },
      ],
    };
  }

  const totalReceipts = analytics.reduce((acc: number, r: any) => acc + r.total_receipts_count, 0);

  const suggestion: CampaignSuggestion = {
    title: totalReceipts > 100 ? "VIP High Roller Loyalty Bonus" : "Midweek Power Hours",
    description:
      totalReceipts > 100
        ? "Reward high-spending repeat customers with bonus loyalty perks."
        : "Increase Wednesday-Thursday visits with 1.5x points.",
    family: "promotion",
    suggestedMultiplier: totalReceipts > 100 ? 2.5 : 1.5,
    rationale: `Based on 7-day analytics (receipt volume: ${totalReceipts}), targeting low-velocity windows with custom points multipliers.`,
    status: "draft",
    suggestedStartDaysFromNow: 2,
    suggestedDurationDays: 4,
  };

  return {
    ok: true,
    suggestions: [suggestion],
  };
}
