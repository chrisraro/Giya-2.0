import { createClient } from "@/lib/supabase/server";

export interface TrendNarrativeDTO {
  headline: string;
  summary: string;
  growthPercentage: number;
  locale: "en" | "taglish";
}

export async function generateTrendNarrative(
  businessId: string,
  locale: "en" | "taglish" = "en",
): Promise<TrendNarrativeDTO> {
  const supabase = await createClient();

  const { data: records } = await (supabase as any)
    .from("analytics_daily_business")
    .select("*")
    .eq("business_id", businessId)
    .order("date", { ascending: false })
    .limit(2);

  if (!records || records.length < 2) {
    return {
      headline: locale === "taglish" ? "Simula ng magandang sales trend!" : "Early Growth Phase",
      summary:
        locale === "taglish"
          ? "Kakaumpisa pa lang ng tracking. Mag-upload ng higit pang receipts para makakita ng buong trend."
          : "Initial analytics collected. Upload more customer receipts to generate complete trend narratives.",
      growthPercentage: 0,
      locale,
    };
  }

  const todayGmv = Number(records[0].total_gmv_centavos);
  const yesterdayGmv = Number(records[1].total_gmv_centavos);
  const diff = todayGmv - yesterdayGmv;
  const pct = yesterdayGmv > 0 ? Math.round((diff / yesterdayGmv) * 100) : 0;

  if (locale === "taglish") {
    return {
      headline: pct >= 0 ? `Lumalago ang sales ng +${pct}%!` : `Bumaba ng ${Math.abs(pct)}% ang sales ngayon.`,
      summary: `Ang total spend ngayong araw ay ₱${(todayGmv / 100).toFixed(
        2,
      )}. Magandang maglunsad ng weekend promo para mas lalong tumaas ang repeat visits.`,
      growthPercentage: pct,
      locale: "taglish",
    };
  }

  return {
    headline: pct >= 0 ? `Sales up +${pct}% today!` : `Sales down ${Math.abs(pct)}% today.`,
    summary: `Total gross spend reached ₱${(todayGmv / 100).toFixed(
      2,
    )}. Consider activating a mid-week campaign to boost customer retention.`,
    growthPercentage: pct,
    locale: "en",
  };
}
