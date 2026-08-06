import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { raiseNotification } from "@/features/notifications/server/raise";
import type { Database } from "@/lib/supabase/types";

// ===========================================================================
// Doc 34 section 5's "On exhaustion" clause (task 1.2): once a campaign's
// `max_total_points` budget is fully spent, the campaign transitions
// active -> paused as a SYSTEM actor (doc 34 T5's "system (budget exhaustion
// section 6)" trigger), an `audit_logs` row records it, and the business
// owner is notified (`campaign_budget_exhausted`, in_app + email).
//
// This is the ONE place that does all three, and it is called POST-COMMIT by
// the award path (../../receipts/server/award.ts, after `award_receipt_points`
// or `record_receipt_visit` has already returned successfully) so a
// pause/notify failure can never unwind an award that already landed. Doc 34:
// "The pause must not fail the award: award commits, pause/notify are
// post-commit best-effort with error logging" - the same contract
// `raiseNotification` already keeps for its own callers.
//
// `per_customer_limit` alone is deliberately NOT exhaustion (doc 34: "hitting
// for one consumer is not exhaustion") and never reaches this module; the
// caller (`award.ts`) only ever passes campaign ids that carry a
// `max_total_points` cap.
// ===========================================================================

const AUDIT_ACTION_PAUSED = "campaign.paused";
const AUDIT_ENTITY_TYPE = "campaign";

export interface ExhaustionDeps {
  /** SERVICE ROLE, matching the award path's own client (`AwardDeps`):
   * pausing a campaign, writing `audit_logs`, and reading `business_staff`
   * for the owner all go through tables/columns no session-scoped client
   * may touch. */
  supabase: SupabaseClient<Database>;
}

interface CampaignRow {
  id: string;
  business_id: string;
  name: string;
  status: string;
  budget: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `campaigns.budget->>'max_total_points'` (doc 34 section 5), or null when
 * absent/not a positive integer - the same parsing `resolveCampaignBudgets`
 * in `../../receipts/server/award.ts` uses, restated here rather than
 * imported so this module has no dependency on the receipts slice. */
function maxTotalPoints(budget: unknown): number | null {
  if (!isRecord(budget)) return null;
  const raw = budget.max_total_points;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * For each candidate campaign id, re-checks its `max_total_points` budget
 * AFTER the award that just committed and pauses + audits + notifies any
 * that are now fully spent (running total >= cap). Idempotent: a campaign a
 * concurrent award already paused (or that this same call already handled)
 * is left alone rather than re-paused or re-notified.
 *
 * NEVER THROWS. Every candidate is handled independently and defensively so
 * one campaign's failure (an unreadable row, a failed notification) cannot
 * stop the rest from being checked.
 */
export async function pauseExhaustedCampaigns(
  deps: ExhaustionDeps,
  campaignIds: readonly string[],
): Promise<void> {
  for (const campaignId of campaignIds) {
    try {
      await pauseOneIfExhausted(deps, campaignId);
    } catch (error) {
      console.error(
        `[campaigns/exhaustion] unexpected failure checking budget exhaustion for campaign ${campaignId}`,
        error,
      );
    }
  }
}

async function pauseOneIfExhausted(deps: ExhaustionDeps, campaignId: string): Promise<void> {
  const { data: campaign, error: readError } = await deps.supabase
    .from("campaigns")
    .select("id, business_id, name, status, budget")
    .eq("id", campaignId)
    .is("deleted_at", null)
    .maybeSingle<CampaignRow>();

  if (readError !== null) {
    console.error(
      `[campaigns/exhaustion] could not read campaign ${campaignId} to check budget exhaustion`,
      readError,
    );
    return;
  }
  if (campaign === null) return; // soft-deleted or otherwise gone; nothing to pause

  // Already paused/ended/archived (by this same call for a sibling receipt,
  // by a concurrent award, or by a human): nothing to do. This is also the
  // idempotency guard against re-notifying an already-paused campaign.
  if (campaign.status !== "active") return;

  const cap = maxTotalPoints(campaign.budget);
  if (cap === null) return; // the cap was raised or removed since this receipt priced

  const { data: rows, error: sumError } = await deps.supabase
    .from("points_transactions")
    .select("points")
    .eq("campaign_id", campaignId)
    .gt("points", 0);

  if (sumError !== null) {
    console.error(
      `[campaigns/exhaustion] could not sum awarded points for campaign ${campaignId}`,
      sumError,
    );
    return;
  }

  const awarded = (rows ?? []).reduce((sum: number, row) => {
    const points = (row as { points: unknown }).points;
    return sum + (typeof points === "number" ? points : 0);
  }, 0);
  if (awarded < cap) return; // budget still has room; nothing to pause

  // Optimistic, exactly like campaigns/server/repo.ts's setCampaignStatus:
  // the `status = 'active'` predicate is the concurrency guard, not an
  // in-memory check. Only the request that still finds it 'active' flips it;
  // a concurrent caller pausing the SAME campaign for a sibling receipt
  // matches zero rows and does nothing more below.
  const { data: updated, error: updateError } = await deps.supabase
    .from("campaigns")
    .update({ status: "paused" })
    .eq("id", campaignId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (updateError !== null) {
    console.error(
      `[campaigns/exhaustion] could not pause exhausted campaign ${campaignId}`,
      updateError,
    );
    return;
  }
  if (updated === null) return; // lost the race to pause it; another call already did

  await writeAuditRow(deps, campaign);
  await notifyOwner(deps, campaign);

  console.info(
    `[campaigns/exhaustion] campaign ${campaignId} auto-paused: max_total_points budget exhausted`,
  );
}

/**
 * `campaign.paused`, actor_kind='system' (0022's registered vocabulary; the
 * doc 34 T5 "system (budget exhaustion)" trigger). `actor_id` stays null -
 * 0022/0012's documented meaning of "system/worker" - and no `reason` guard
 * applies to it: 0022's `audit_logs_admin_reason_required` check is scoped to
 * `actor_kind = 'admin'` alone, so a system row needs no admin-style
 * justification text, though one is supplied anyway for a legible audit trail.
 *
 * Best-effort: the pause itself already committed by the time this runs, and
 * an unaudited pause (logged loudly) is a smaller loss than pretending the
 * pause never happened.
 */
async function writeAuditRow(deps: ExhaustionDeps, campaign: CampaignRow): Promise<void> {
  const { error } = await deps.supabase.from("audit_logs").insert({
    actor_id: null,
    actor_kind: "system",
    business_id: campaign.business_id,
    action: AUDIT_ACTION_PAUSED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: campaign.id,
    before: { status: "active" },
    after: { status: "paused", reason: "budget_exhausted" },
    reason: "Campaign auto-paused: its max_total_points budget is fully spent.",
  });

  if (error !== null) {
    console.error(
      `[campaigns/exhaustion] could not write the audit row for campaign ${campaign.id}'s auto-pause`,
      error,
    );
  }
}

/**
 * Notifies the business owner (`business_staff` role='owner', status='active'
 * - the same `business_staff_one_owner` invariant the schema enforces, so
 * this lookup is at most one row) via the `campaign_budget_exhausted`
 * notification kind (in_app + email, `../../notifications/kinds.ts`).
 *
 * Copy is plain and non-accusatory, per the notifications conventions: it
 * names the campaign and the fact (budget spent), not a failure, and points
 * the owner at the one screen where they can act (raise the budget or end the
 * campaign).
 */
async function notifyOwner(deps: ExhaustionDeps, campaign: CampaignRow): Promise<void> {
  const { data: owner, error } = await deps.supabase
    .from("business_staff")
    .select("user_id")
    .eq("business_id", campaign.business_id)
    .eq("role", "owner")
    .eq("status", "active")
    .maybeSingle<{ user_id: string }>();

  if (error !== null) {
    console.error(
      `[campaigns/exhaustion] could not find the owner of business ${campaign.business_id} to notify of campaign ${campaign.id}'s auto-pause`,
      error,
    );
    return;
  }
  if (owner === null) return; // no active owner on record; nothing to notify

  await raiseNotification({
    userId: owner.user_id,
    kind: "campaign_budget_exhausted",
    title: "A campaign paused itself",
    body: `${campaign.name} reached its points budget and has been paused automatically. Raise the budget or end the campaign to resume it.`,
    businessId: campaign.business_id,
    data: {
      route: "/business/campaigns",
      params: { campaign_id: campaign.id },
    },
    deps: { supabase: deps.supabase },
  });
}
