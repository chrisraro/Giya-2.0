import { createClient } from "@/lib/supabase/server";

import type {
  BalanceDTO,
  ClaimableRewardDTO,
  ClaimDetailDTO,
  LedgerEntryDTO,
  MyClaimDTO,
} from "../types";

// Consumer-facing reads for the rewards/wallet slice. RLS is the real
// authorization boundary here (see supabase/migrations/0012_campaigns.sql
// for reward_claims/business_customers/points_transactions's P3 consumer-
// self policies, and rewards_public_select / campaigns_public_select for
// the public catalog reads) - same convention as
// src/features/campaigns/server/repo.ts. This layer issues plain
// single-table queries and joins them in application code (no PostgREST
// embedded-resource selects), matching every other repo in this codebase,
// then shapes rows into DTOs; it never widens what RLS already allows.

/**
 * One row of the claimable-rewards read, with the business joined in.
 *
 * Declared by hand because the generated Database types do not model PostgREST
 * embedded resources - the same reason src/features/promotions/server/repo.ts
 * shapes its embedded rows manually.
 */
type ClaimableRewardRow = {
  id: string;
  campaign_id: string;
  name: string;
  description: string | null;
  points_cost: number;
  // Nullability copied from the generated Database types, not guessed:
  // `remaining` is nullable (unlimited), `per_customer_limit` is not. Widening
  // the second to `| null` here is what made this row type stop matching
  // ClaimableRewardDTO - a hand-written type has to agree with the schema it
  // stands in for, or it is just a differently-shaped lie.
  remaining: number | null;
  per_customer_limit: number;
  business_id: string;
  businesses: { name: string; slug: string; status: string } | null;
};

/**
 * Rewards a consumer can currently claim: active, non-deleted rewards whose
 * owning campaign is 'active' AND inside its schedule window, AND whose owning
 * business is approved.
 *
 * THAT LAST CLAUSE IS NEW AND IT IS THE POINT. `rewards_public_select` is
 * `is_active = true AND deleted_at IS NULL` and `campaigns_public_select` is
 * `status = 'active' AND deleted_at IS NULL` - verified live. NEITHER LOOKS AT
 * THE OWNING BUSINESS'S STATUS. This read used to filter on exactly those two
 * things and nothing else, so a business that had not been approved could
 * create an active campaign with rewards and have them render on `/rewards`,
 * the public catalogue.
 *
 * That was always wrong and it became reachable-by-design when the portal was
 * deliberately opened to unapproved merchants: `draft` and
 * `pending_verification` businesses now build their menu, promos and rewards
 * while they wait for review, and rewards was the one of the three whose public
 * read had no business-status gate. The symptom was not even a clean leak - the
 * separate business lookup returned nothing for those rows, so the cards
 * rendered headless, with a reward name, description and points cost and no
 * shop attached.
 *
 * THE GATE IS `businesses!inner`, NOT A FILTER WE WROTE. The embed is an INNER
 * join, so PostgREST evaluates `businesses_public_select`
 * (`status = 'active' AND deleted_at IS NULL`) against the joined row and drops
 * any reward whose business the caller cannot see - server-side, before a byte
 * is returned. This is the same construct `listPublicPromotions` already uses
 * for the same reason. No migration was needed: the policy already does the
 * work once the join is inner.
 *
 * The explicit `.eq("businesses.status", "active")` and the app-layer check in
 * the map below are defense-in-depth, matching the documented convention in
 * src/features/businesses/server/public-repo.ts ("the extra filters are
 * defense-in-depth ... not the sole gate"). An outer join, a policy edit, or a
 * future embed spelled without `!inner` would each be caught by one of the
 * three.
 *
 * RLS enforces neither the campaign's starts_at/ends_at window nor the business
 * status, so both are re-checked here at the app layer, as the promotions and
 * rewards public-read comments in 0012_campaigns.sql call out.
 */
export async function listClaimableRewards(): Promise<ClaimableRewardDTO[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rewards")
    .select(
      `id, campaign_id, name, description, points_cost, remaining, per_customer_limit, business_id,
       businesses!inner ( name, slug, status )`,
    )
    .eq("is_active", true)
    .is("deleted_at", null)
    .eq("businesses.status", "active");

  const rewards = data as unknown as ClaimableRewardRow[] | null;

  if (error || !rewards || rewards.length === 0) return [];

  const campaignIds = Array.from(new Set(rewards.map((r) => r.campaign_id)));
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, starts_at, ends_at")
    .in("id", campaignIds)
    .eq("status", "active")
    .is("deleted_at", null);

  const now = new Date();
  const liveCampaignIds = new Set(
    (campaigns ?? [])
      .filter((c) => {
        const startsOk = !c.starts_at || new Date(c.starts_at) <= now;
        const endsOk = !c.ends_at || new Date(c.ends_at) > now;
        return startsOk && endsOk;
      })
      .map((c) => c.id),
  );

  const liveRewards = rewards.filter(
    (r) =>
      liveCampaignIds.has(r.campaign_id) &&
      // The third fence, and the only one a unit test can exercise without a
      // real PostgREST. A row that arrives with no business attached, or with a
      // business that is not approved, is dropped rather than rendered with an
      // empty shop name - which is exactly how this leak presented before the
      // join was made inner: headless cards carrying a reward name, description
      // and points cost for a shop consumers were not supposed to know existed.
      r.businesses !== null &&
      r.businesses.status === "active",
  );
  if (liveRewards.length === 0) return [];

  // No second round trip for the business names: the inner join above already
  // carried them, and it had to run anyway to apply the gate. The read this
  // replaces was `.in("id", businessIds)` against `businesses`, whose own RLS
  // silently returned nothing for an unapproved shop - which is why the reward
  // still rendered while its heading vanished.
  return liveRewards.map((r) => ({
    rewardId: r.id,
    campaignId: r.campaign_id,
    name: r.name,
    description: r.description,
    pointsCost: r.points_cost,
    remaining: r.remaining,
    perCustomerLimit: r.per_customer_limit,
    businessId: r.business_id,
    businessName: r.businesses?.name ?? "",
    businessSlug: r.businesses?.slug ?? "",
  }));
}

/**
 * The caller's own reward claims (RLS: reward_claims_consumer_select),
 * newest first, with reward/business names resolved for display.
 */
export async function listMyClaims(): Promise<MyClaimDTO[]> {
  const supabase = await createClient();

  const { data: claims, error } = await supabase
    .from("reward_claims")
    .select("id, reward_id, business_id, status, points_spent, claimed_at, expires_at, redeemed_at")
    .order("claimed_at", { ascending: false });

  if (error || !claims || claims.length === 0) return [];

  const rewardIds = Array.from(new Set(claims.map((c) => c.reward_id)));
  const businessIds = Array.from(new Set(claims.map((c) => c.business_id)));

  const [{ data: rewards }, { data: businesses }] = await Promise.all([
    supabase.from("rewards").select("id, name").in("id", rewardIds),
    supabase.from("businesses").select("id, name").in("id", businessIds),
  ]);

  const rewardById = new Map((rewards ?? []).map((r) => [r.id, r]));
  const businessById = new Map((businesses ?? []).map((b) => [b.id, b]));

  return claims.map((c) => ({
    claimId: c.id,
    rewardId: c.reward_id,
    rewardName: rewardById.get(c.reward_id)?.name ?? "",
    businessId: c.business_id,
    businessName: businessById.get(c.business_id)?.name ?? "",
    status: c.status,
    pointsSpent: c.points_spent,
    claimedAt: c.claimed_at,
    expiresAt: c.expires_at,
    redeemedAt: c.redeemed_at,
  }));
}

/**
 * One claim by id, with reward/business names resolved. RLS scopes the read
 * to claims the caller may see - but that is a UNION of two policies
 * (reward_claims_consumer_select: consumer_id = auth.uid(); OR
 * reward_claims_staff_select: staff of the owning business), so a row
 * coming back here is NOT necessarily the caller's own claim. Callers that
 * must be scoped to the claim owner only (e.g. the mint-token route) must
 * check the returned consumerId themselves - see
 * src/features/rewards/server/claim-ownership.ts. This function only
 * distinguishes "no row visible to the caller at all" (returns null, doc
 * 13's 404 rule: never distinguish absent from outside-scope) from a
 * genuine query failure (throws, so callers can answer 500 instead of a
 * false 404).
 */
export async function getClaim(claimId: string): Promise<ClaimDetailDTO | null> {
  const supabase = await createClient();

  const { data: claim, error } = await supabase
    .from("reward_claims")
    .select(
      "id, reward_id, business_id, consumer_id, status, points_spent, claimed_at, expires_at, redeemed_at",
    )
    .eq("id", claimId)
    .maybeSingle();

  if (error) {
    throw new Error(`getClaim: failed to load claim ${claimId}: ${error.message}`);
  }
  if (!claim) return null;

  const [{ data: reward }, { data: business }] = await Promise.all([
    supabase.from("rewards").select("name").eq("id", claim.reward_id).maybeSingle(),
    supabase.from("businesses").select("name").eq("id", claim.business_id).maybeSingle(),
  ]);

  return {
    claimId: claim.id,
    rewardId: claim.reward_id,
    rewardName: reward?.name ?? "",
    businessId: claim.business_id,
    consumerId: claim.consumer_id,
    businessName: business?.name ?? "",
    status: claim.status,
    pointsSpent: claim.points_spent,
    claimedAt: claim.claimed_at,
    expiresAt: claim.expires_at,
    redeemedAt: claim.redeemed_at,
  };
}

/**
 * The caller's business_customers rows (their balance at every business
 * they have a relationship with), with business name/slug resolved.
 *
 * Throws on a genuine query error rather than returning `[]` for it - same
 * split as `getMyBalanceForBusiness` below, and for the same reason, made
 * sharper by that fix: `groupRewardsByBusiness` now gates affordability on
 * whether a business appears in this list AT ALL, so `[]` on a transient DB
 * error would silently render the WHOLE `/rewards` catalogue plain with
 * every Claim button enabled - the exact tap-then-POINTS_INSUFFICIENT defect
 * this feature exists to remove, just reached through a different door.
 * Failing open here is not a safe default; failing loud is the caller's
 * signal to degrade deliberately (see `/rewards/page.tsx`'s `.catch()`).
 */
export async function getMyBalances(): Promise<BalanceDTO[]> {
  const supabase = await createClient();

  const { data: balances, error } = await supabase
    .from("business_customers")
    .select("business_id, points_balance, lifetime_points");

  if (error) {
    throw new Error(`getMyBalances: failed to load balances: ${error.message}`);
  }
  if (!balances || balances.length === 0) return [];

  const businessIds = Array.from(new Set(balances.map((b) => b.business_id)));
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name, slug")
    .in("id", businessIds);
  const businessById = new Map((businesses ?? []).map((b) => [b.id, b]));

  return balances.map((b) => {
    const business = businessById.get(b.business_id);
    return {
      businessId: b.business_id,
      businessName: business?.name ?? "",
      businessSlug: business?.slug ?? "",
      pointsBalance: b.points_balance,
      lifetimePoints: b.lifetime_points,
    };
  });
}

/**
 * The caller's points balance at ONE business, or null when they have no
 * `business_customers` row there (never earned/visited). Scoped to a single
 * business_id rather than reusing getMyBalances(): `/b/[slug]` is a public
 * page a signed-out visitor can load too, so this only ever costs one narrow
 * query for one business's worth of use, never a wallet-wide read.
 *
 * `consumerId` MUST be passed and filtered on explicitly - RLS alone is not
 * enough here. `business_customers_staff_select` (0011:57) grants
 * owner/manager/marketing staff SELECT over EVERY customer row at their own
 * business, not just their own; without this filter, an owner viewing their
 * own `/b/[slug]` with exactly one customer row would get THAT CUSTOMER's
 * balance back as if it were their own (and `.maybeSingle()` would error
 * outright with several rows). Same defense-in-depth convention documented at
 * the top of `public-repo.ts`: RLS is the real gate, this filter is not the
 * only one.
 *
 * Throws on a genuine query failure rather than returning null for it - null
 * means "no relationship row" (a common, real state), not "something went
 * wrong". Conflating the two would render a transient DB error as a
 * confidently wrong "0 points" to a consumer who may have thousands. Same
 * split as `getClaim` above.
 *
 * Callers on a page a signed-out visitor can reach (like `/b/[slug]`) should
 * still only call this when a user is actually signed in: skipping the call
 * entirely for a signed-out visitor avoids a query that could only ever
 * answer null (RLS scopes business_customers_consumer_select to
 * `authenticated`).
 */
export async function getMyBalanceForBusiness(
  businessId: string,
  consumerId: string,
): Promise<number | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_customers")
    .select("points_balance")
    .eq("business_id", businessId)
    .eq("consumer_id", consumerId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `getMyBalanceForBusiness: failed to load balance for business ${businessId}: ${error.message}`,
    );
  }
  return data ? data.points_balance : null;
}

/**
 * The caller's points_transactions ledger (RLS: pt_consumer_select), newest
 * first, optionally filtered to one business.
 */
export async function listMyLedger(businessId?: string): Promise<LedgerEntryDTO[]> {
  const supabase = await createClient();

  let query = supabase
    .from("points_transactions")
    .select("id, business_id, type, points, balance_after, created_at, claim_id, campaign_id")
    .order("created_at", { ascending: false });

  if (businessId) {
    query = query.eq("business_id", businessId);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((t) => ({
    id: t.id,
    businessId: t.business_id,
    type: t.type,
    points: t.points,
    balanceAfter: t.balance_after,
    createdAt: t.created_at,
    claimId: t.claim_id,
    campaignId: t.campaign_id,
  }));
}
