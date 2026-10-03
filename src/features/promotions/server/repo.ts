import { isLiveAt } from "@/features/campaigns/lifecycle";
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

// Row-level liveness via the single shared rule in campaigns/lifecycle.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isLive(row: any, now: Date): boolean {
  const campaign = row.campaigns;
  if (!campaign || row.deleted_at) return false;
  return isLiveAt(
    {
      status: campaign.status,
      starts_at: campaign.starts_at ?? null,
      ends_at: campaign.ends_at ?? null,
      deleted_at: campaign.deleted_at ?? null,
    },
    now,
  );
}

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
    .is("campaigns.deleted_at", null)
    // A soft-deleted promotion must not surface even when its campaign is live.
    .is("deleted_at", null);

  if (error || !data) {
    return [];
  }

  // The schedule window (doc 34 section 3) is applied by the shared predicate:
  // status alone made scheduled and expired promotions render as "Active".
  const now = new Date();
  return data.filter((row) => isLive(row, now)).map((row) => ({
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
  const now = new Date();
  const nowIso = now.toISOString();

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
    .is("deleted_at", null)
    // Window pushed into SQL as well (starts inclusive, ends exclusive) so
    // `limit` counts live rows only; the JS predicate below stays the fence.
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`, { referencedTable: "campaigns" })
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`, { referencedTable: "campaigns" })
    .limit(limit);

  if (error || !data) {
    return [];
  }

  return data.filter((row) => isLive(row, now)).map((row) => ({
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
