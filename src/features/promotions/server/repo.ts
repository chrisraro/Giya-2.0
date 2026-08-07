import { createClient } from "@/lib/supabase/server";

export type PublicPromotion = {
  id: string;
  campaignId: string;
  businessId: string;
  name: string;
  description: string | null;
  offerKind: string;
  percentOff: number | null;
  amountOffCentavos: number | null;
  freebieText: string | null;
  terms: string | null;
  redemptionHint: string | null;
  startsAt: string | null;
  endsAt: string | null;
  businessName?: string;
  businessSlug?: string;
};

export async function getActivePromotionsForBusiness(businessId: string): Promise<PublicPromotion[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("promotions")
    .select(`
      id,
      campaign_id,
      business_id,
      offer_kind,
      percent_off,
      amount_off_centavos,
      freebie_text,
      terms,
      redemption_hint,
      campaigns!inner (
        name,
        description,
        starts_at,
        ends_at,
        status,
        deleted_at
      )
    `)
    .eq("business_id", businessId)
    .eq("campaigns.status", "active")
    .is("campaigns.deleted_at", null);

  if (error || !data) {
    return [];
  }

  return data.map((row: any) => ({
    id: row.id,
    campaignId: row.campaign_id,
    businessId: row.business_id,
    name: row.campaigns?.name ?? "Special Offer",
    description: row.campaigns?.description ?? null,
    offerKind: row.offer_kind,
    percentOff: row.percent_off,
    amountOffCentavos: row.amount_off_centavos,
    freebieText: row.freebie_text,
    terms: row.terms,
    redemptionHint: row.redemption_hint,
    startsAt: row.campaigns?.starts_at ?? null,
    endsAt: row.campaigns?.ends_at ?? null,
  }));
}

export async function listPublicPromotions(limit = 10): Promise<PublicPromotion[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("promotions")
    .select(`
      id,
      campaign_id,
      business_id,
      offer_kind,
      percent_off,
      amount_off_centavos,
      freebie_text,
      terms,
      redemption_hint,
      campaigns!inner (
        name,
        description,
        starts_at,
        ends_at,
        status,
        deleted_at
      ),
      businesses!inner (
        name,
        slug
      )
    `)
    .eq("campaigns.status", "active")
    .is("campaigns.deleted_at", null)
    .limit(limit);

  if (error || !data) {
    return [];
  }

  return data.map((row: any) => ({
    id: row.id,
    campaignId: row.campaign_id,
    businessId: row.business_id,
    name: row.campaigns?.name ?? "Special Offer",
    description: row.campaigns?.description ?? null,
    offerKind: row.offer_kind,
    percentOff: row.percent_off,
    amountOffCentavos: row.amount_off_centavos,
    freebieText: row.freebie_text,
    terms: row.terms,
    redemptionHint: row.redemption_hint,
    startsAt: row.campaigns?.starts_at ?? null,
    endsAt: row.campaigns?.ends_at ?? null,
    businessName: row.businesses?.name,
    businessSlug: row.businesses?.slug,
  }));
}
