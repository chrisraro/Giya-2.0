import { getBaseRule } from "@/features/campaigns/server/repo";

import { toEarningRuleShape, type EarningRuleShape } from "../economics";
import type { CreateRewardInput, UpdateRewardInput } from "../schemas";
import type { ActionResult, CampaignOption, CampaignRow, RewardCatalogItem, RewardRow } from "../types";
import * as repo from "./repo";

// ===========================================================================
// The catalog's refusal rules.
//
// `claim_reward` (supabase/migrations/0013_reward_claim_rpcs.sql) is the only
// path by which a reward is ever claimed, and its guards run in a fixed order.
// Four of them can be decided AT SAVE TIME rather than at claim time, and when
// they can, saving a reward that trips them is not a merchant choice - it is a
// reward that is dead the moment it is written and produces a support ticket
// weeks later ("nobody can claim my free coffee"). This module refuses those
// four up front:
//
//   1. PARENT CAMPAIGN TERMINAL. The RPC's first guard requires
//      `c.status = 'active'` and `now()` inside the campaign's window. An
//      'ended' or 'archived' campaign is terminal in the lifecycle engine
//      (src/features/campaigns/lifecycle.ts) and a campaign whose `ends_at` has
//      already passed can never re-open, so a reward parented to either can
//      never answer anything but REWARD_UNAVAILABLE.
//
//   2. INVENTORY OF ZERO. Step 2 decrements `where remaining is null or
//      remaining > 0` and raises REWARD_OUT_OF_STOCK when nothing matched.
//      `total_inventory = 0` seeds `remaining = 0`. Refused in schemas.ts;
//      restated here because the edit path can also try to reach zero.
//
//   3. AN INVENTORY BELOW WHAT IS ALREADY CLAIMED. `rewards_remaining_lte_total`
//      and `remaining >= 0` make this a raw constraint violation; the merchant
//      gets a sentence instead.
//
//   4. A POINTS COST NOBODY CAN REACH. Step 3 raises POINTS_INSUFFICIENT when
//      `points_balance < points_cost`. A balance only ever grows through the
//      points engine, and the points engine mints nothing without an ACTIVE
//      BASE EARNING RULE (`points_rules` kind='base'). With no base rule every
//      customer's balance is pinned at zero forever, so any `points_cost > 0`
//      is unsatisfiable - not merely ambitious. Refused, with the fix named.
//
//      Revisit when manual points adjustments ship (doc 32 section 9.2): an
//      owner granting points by hand would be a second source of balance, and
//      this guard would then be too strict rather than exactly right.
//
// Everything else the RPC can refuse - out of stock after real claims, a
// customer at their per-reward limit, a blacklisted customer, a campaign budget
// exhausted - is a legitimate runtime outcome and is NOT second-guessed here.
// ===========================================================================

/** Lifecycle states from which a campaign can never return to 'active'. */
const TERMINAL_CAMPAIGN_STATUSES = new Set(["ended", "archived"]);

function toResult<T>(data: T | null, error: { message: string } | null): ActionResult<T> {
  if (error) return { ok: false, message: error.message };
  if (data === null) return { ok: true };
  return { ok: true, data };
}

/**
 * Restates `claim_reward`'s campaign guard (status + schedule window) as
 * something the catalog screen can render, plus the stronger `terminal`
 * question the save path needs. Pure, so it is tested directly.
 */
export function describeCampaign(campaign: CampaignRow, asOf: Date = new Date()): CampaignOption {
  const startsAt = campaign.starts_at;
  const endsAt = campaign.ends_at;
  const started = !startsAt || new Date(startsAt).getTime() <= asOf.getTime();
  const notFinished = !endsAt || new Date(endsAt).getTime() > asOf.getTime();

  return {
    id: campaign.id,
    name: campaign.name,
    type: campaign.type,
    status: campaign.status,
    startsAt,
    endsAt,
    claimable: campaign.status === "active" && started && notFinished,
    terminal: TERMINAL_CAMPAIGN_STATUSES.has(campaign.status) || !notFinished,
  };
}

/**
 * How many of a reward have already been given out, derived from the row rather
 * than counted in `reward_claims`: `claim_reward` decrements `remaining` inside
 * the same transaction as the claim insert, so `total - remaining` is exact and
 * needs no extra round trip. Unlimited stock (null) has no meaningful count.
 */
export function claimedCount(reward: Pick<RewardRow, "total_inventory" | "remaining">): number | null {
  if (reward.total_inventory === null) return null;
  const remaining = reward.remaining ?? reward.total_inventory;
  return Math.max(reward.total_inventory - remaining, 0);
}

export type RemainingDecision =
  | { ok: true; remaining: number | null }
  | { ok: false; alreadyClaimed: number };

/**
 * The new `remaining` for an inventory edit.
 *
 *   * to unlimited (null)      -> remaining null; the RPC stops counting down.
 *   * from unlimited to N      -> remaining N; there is no claimed count to
 *                                 subtract, so N is read as "N left from here".
 *   * from T to N              -> remaining N - claimed, refusing N < claimed
 *                                 rather than letting `remaining >= 0` fail as
 *                                 a raw constraint violation.
 */
export function nextRemaining(
  reward: Pick<RewardRow, "total_inventory" | "remaining">,
  newTotal: number | null,
): RemainingDecision {
  if (newTotal === null) return { ok: true, remaining: null };

  const claimed = claimedCount(reward);
  if (claimed === null) return { ok: true, remaining: newTotal };
  if (newTotal < claimed) return { ok: false, alreadyClaimed: claimed };

  return { ok: true, remaining: newTotal - claimed };
}

/**
 * Guard 4. Returns null when the cost is reachable, or the refusal message when
 * the business has no way to mint a single point.
 */
async function pointsCostUnreachable(
  businessId: string,
  pointsCost: number,
): Promise<string | null> {
  if (pointsCost <= 0) return null;

  const baseRule = await getBaseRule(businessId);
  if (baseRule) return null;

  return "Set an earning rule on the Campaigns page first. Without one nobody earns points, so a reward that costs points could never be claimed.";
}

// --------------------------------------------------------------------- reads

export interface CatalogView {
  rewards: RewardCatalogItem[];
  campaigns: CampaignOption[];
  /**
   * The active base earning rule, reduced to what ../economics.ts needs to say
   * how much spending a points cost implies. Null means no usable rule, which
   * the screen states as "nobody can earn points yet" rather than inventing a
   * figure. Read here rather than on the page so the catalog stays one await.
   */
  earningRule: EarningRuleShape | null;
}

/**
 * The catalog screen's whole payload. Returns `{ ok: false }` when EITHER read
 * failed, so the page can tell "we could not load this" apart from "you have no
 * rewards yet" - a distinction src/app/(business)/business/(portal)/menu/page.tsx
 * makes for the same reason: an empty list and a broken query look identical on
 * screen and mean opposite things.
 */
export async function loadCatalog(
  businessId: string,
  asOf: Date = new Date(),
): Promise<ActionResult<CatalogView>> {
  // The base rule is read alongside the catalog, not instead of it: a missing
  // rule is a legitimate state (it is what the "nobody can earn points yet"
  // sentence is for), so it never turns the whole page into a read failure.
  const [rewardsResult, campaignsResult, baseRule] = await Promise.all([
    repo.listRewards(businessId),
    repo.listCampaigns(businessId),
    getBaseRule(businessId),
  ]);

  if (rewardsResult.error || campaignsResult.error) {
    return {
      ok: false,
      message: rewardsResult.error?.message ?? campaignsResult.error?.message ?? "Read failed.",
    };
  }

  const campaigns = (campaignsResult.data ?? []).map((campaign) => describeCampaign(campaign, asOf));
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

  const rewards: RewardCatalogItem[] = (rewardsResult.data ?? []).map((reward) => ({
    id: reward.id,
    campaignId: reward.campaign_id,
    name: reward.name,
    description: reward.description,
    pointsCost: reward.points_cost,
    claimKind: reward.claim_kind,
    totalInventory: reward.total_inventory,
    remaining: reward.remaining,
    perCustomerLimit: reward.per_customer_limit,
    claimExpiryDays: reward.claim_expiry_days,
    terms: reward.terms,
    isActive: reward.is_active,
    createdAt: reward.created_at,
    campaign: campaignById.get(reward.campaign_id) ?? null,
  }));

  return {
    ok: true,
    data: {
      rewards,
      campaigns,
      earningRule: baseRule === null ? null : toEarningRuleShape(baseRule),
    },
  };
}

// -------------------------------------------------------------------- writes

export async function createReward(
  businessId: string,
  input: CreateRewardInput,
  asOf: Date = new Date(),
): Promise<ActionResult<RewardRow>> {
  // Guard 1. The campaign id arrives from the form, so it is re-read scoped to
  // the resolved tenant: a campaign id belonging to another business must miss
  // here, not be trusted because it parsed as a uuid.
  const campaign = await repo.getCampaign(businessId, input.campaignId);
  if (!campaign) {
    return { ok: false, message: "That campaign is not one of yours." };
  }

  const described = describeCampaign(campaign, asOf);
  if (described.terminal) {
    return {
      ok: false,
      message: "That campaign has finished, so nobody could ever claim this reward. Pick a live campaign.",
    };
  }

  // Guard 4.
  const unreachable = await pointsCostUnreachable(businessId, input.pointsCost);
  if (unreachable) return { ok: false, message: unreachable };

  const { data, error } = await repo.insertReward(businessId, {
    campaignId: input.campaignId,
    name: input.name,
    description: input.description ?? null,
    pointsCost: input.pointsCost,
    totalInventory: input.totalInventory ?? null,
    perCustomerLimit: input.perCustomerLimit,
    claimExpiryDays: input.claimExpiryDays,
    terms: input.terms ?? null,
  });

  return toResult(data, error);
}

export async function updateReward(
  businessId: string,
  input: UpdateRewardInput,
): Promise<ActionResult<RewardRow>> {
  const existing = await repo.getReward(businessId, input.rewardId);
  if (!existing) {
    return { ok: false, message: "That reward is not one of yours." };
  }

  // Guard 4 again: an edit can raise the cost just as a create can set it.
  const unreachable = await pointsCostUnreachable(businessId, input.pointsCost);
  if (unreachable) return { ok: false, message: unreachable };

  // Guard 3.
  const decision = nextRemaining(existing, input.totalInventory ?? null);
  if (!decision.ok) {
    return {
      ok: false,
      message: `Customers have already claimed ${decision.alreadyClaimed} of these, so stock cannot go below ${decision.alreadyClaimed}.`,
    };
  }

  const { data, error } = await repo.updateReward(businessId, input.rewardId, {
    name: input.name,
    description: input.description ?? null,
    points_cost: input.pointsCost,
    total_inventory: input.totalInventory ?? null,
    remaining: decision.remaining,
    per_customer_limit: input.perCustomerLimit,
    claim_expiry_days: input.claimExpiryDays,
    terms: input.terms ?? null,
  });

  return toResult(data, error);
}

/**
 * Activation is not gated the way creation is. Deactivating is always allowed
 * (it is how a merchant pulls a reward), and re-activating a reward whose stock
 * ran out or whose campaign ended is a visible, reversible state the list marks
 * rather than a silent trap - the merchant can see the "Out of stock" and
 * "Campaign finished" chips on the same card as the button.
 */
export async function setRewardActive(
  businessId: string,
  rewardId: string,
  isActive: boolean,
): Promise<ActionResult<RewardRow>> {
  const { data, error } = await repo.setRewardActive(businessId, rewardId, isActive);
  return toResult(data, error);
}
