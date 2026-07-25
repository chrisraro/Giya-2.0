import type {
  Business,
  Campaign,
  CampaignAction,
  CampaignStatus,
  CampaignType,
  GateFailure,
  GateResult,
  PayloadPresence,
} from "./types";

// Pure campaign lifecycle engine, per docs/30-modules/34-campaign-engine.md
// section 2 (state machine), the activation-gate table (G1-G5), and
// section 3 (live-window semantics). ZERO IO: the API routes, server
// actions, and the sweep worker all call these same functions with data
// they loaded themselves; DB transactions, audit rows, cache invalidation,
// and enqueued side effects live in the service layer.

// Allowed edges, exactly doc 34 T1-T8. T9 "duplicate" creates a new draft
// row and is not a transition of the source. Notably absent by design:
// no ended -> active (relaunch is duplicate), no scheduled -> ended or
// scheduled -> archived (a scheduled campaign is unscheduled back to draft
// first), no active/paused -> archived (they must end first), and archived
// has no outgoing edges (terminal).
const ALLOWED_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["scheduled", "active", "archived"], // T1, T2, T8
  scheduled: ["active", "draft"], // T3, T4
  active: ["paused", "ended"], // T5, T7
  paused: ["active", "ended"], // T6, T7
  ended: ["archived"], // T8
  archived: [], // terminal
};

export function canTransition(
  from: CampaignStatus,
  to: CampaignStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// Maps to the API's 409 CAMPAIGN_INVALID_STATE (doc 34 section 9).
export class CampaignTransitionError extends Error {
  readonly code = "CAMPAIGN_INVALID_STATE";
  readonly from: CampaignStatus;
  readonly action: CampaignAction;

  constructor(from: CampaignStatus, action: CampaignAction) {
    super(`Cannot ${action} a campaign in status '${from}'`);
    this.name = "CampaignTransitionError";
    this.from = from;
    this.action = action;
  }
}

// Each action encodes its doc 34 trigger edges: target status plus the
// statuses the trigger may fire from. Sources are narrower than the raw
// edge set on purpose: draft -> active exists as an edge, but only the
// 'activate' trigger uses it; 'resume' fires from paused alone (T6).
const ACTION_EDGES: Record<
  CampaignAction,
  { readonly target: CampaignStatus; readonly sources: readonly CampaignStatus[] }
> = {
  schedule: { target: "scheduled", sources: ["draft"] }, // T1
  activate: { target: "active", sources: ["draft", "scheduled"] }, // T2, T3
  unschedule: { target: "draft", sources: ["scheduled"] }, // T4
  pause: { target: "paused", sources: ["active"] }, // T5
  resume: { target: "active", sources: ["paused"] }, // T6
  end: { target: "ended", sources: ["active", "paused"] }, // T7
  archive: { target: "archived", sources: ["draft", "ended"] }, // T8
};

// Resolve the status an action moves the campaign to, or throw
// CampaignTransitionError when the action is invalid from the current
// status. Both the trigger table and the raw edge set must agree.
export function nextStatus(
  campaign: Pick<Campaign, "status">,
  action: CampaignAction,
): CampaignStatus {
  const edge = ACTION_EDGES[action];
  if (
    !edge.sources.includes(campaign.status) ||
    !canTransition(campaign.status, edge.target)
  ) {
    throw new CampaignTransitionError(campaign.status, action);
  }
  return edge.target;
}

// G2: type -> required payload rows (doc 34 section 1 mapping table).
// Row-internal validity (offer values, prize reward liveness flags) is
// enforced by the payload schemas at save time; this pure gate checks
// presence per the mapping. Returns null when complete, else a message.
function payloadIncompleteReason(
  type: CampaignType,
  payload: PayloadPresence,
): string | null {
  switch (type) {
    case "promotion":
    case "discount":
    case "seasonal":
    case "holiday":
    case "event":
      return payload.hasPromotion
        ? null
        : `A '${type}' campaign requires a promotions row`;
    case "reward":
      return payload.rewardCount >= 1
        ? null
        : "A 'reward' campaign requires at least one active reward";
    case "loyalty":
    case "membership":
      if (!payload.hasLoyaltyProgram) {
        return `A '${type}' campaign requires a loyalty program`;
      }
      return payload.hasLoyaltyPrize
        ? null
        : `A '${type}' campaign's loyalty program requires a live prize reward`;
    case "birthday":
      return payload.pointsRuleCount >= 1 || payload.rewardCount >= 1
        ? null
        : "A 'birthday' campaign requires a points rule and/or a reward";
    case "referral":
      return payload.pointsRuleCount >= 1
        ? null
        : "A 'referral' campaign requires a referral points rule";
  }
}

// Activation gates G1-G4 for T1/T2/T6 (doc 34 section 2). All gates run;
// failures are collected, never short-circuited, so the portal can show
// everything wrong at once. `now` is passed in (never read from the
// clock) to keep this pure and deterministic.
//
// G5 targeting sanity (audience schema + ref_cities existence, code
// VALIDATION_FAILED) is [V1] and needs reference-data IO, so it is
// intentionally not evaluated here; the service layer adds it when
// audience targeting ships.
//
// G4's warn-only consistency checks (max_redemptions vs summed reward
// inventory, max_total_points vs largest single award) need payload rows
// this function does not receive; only the hard positive-integer shape
// check is enforced here, matching budgetSchema.
export function activationGates(
  campaign: Campaign,
  payload: PayloadPresence,
  business: Business,
  now: Date,
): GateResult {
  const failures: GateFailure[] = [];

  // G1 business standing.
  if (business.status !== "active") {
    failures.push({
      code: "BUSINESS_NOT_VERIFIED",
      message: `Business must be active to run campaigns (status is '${business.status}')`,
    });
  }

  // G2 payload completeness.
  const incomplete = payloadIncompleteReason(campaign.type, payload);
  if (incomplete !== null) {
    failures.push({ code: "CAMPAIGN_PAYLOAD_INCOMPLETE", message: incomplete });
  }

  // G3 schedule sanity. Comparisons are on absolute instants; the
  // campaign timezone only matters for wall-clock input and recurrence.
  const scheduleProblems: string[] = [];
  const { startsAt, endsAt } = campaign;
  if (startsAt !== null && endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    scheduleProblems.push("endsAt must be after startsAt");
  }
  if (endsAt !== null && endsAt.getTime() <= now.getTime()) {
    scheduleProblems.push("endsAt must be in the future");
  }
  if (campaign.status === "scheduled") {
    if (startsAt === null) {
      scheduleProblems.push("a scheduled campaign requires startsAt");
    } else if (startsAt.getTime() < now.getTime()) {
      scheduleProblems.push("a scheduled campaign's startsAt must not be in the past");
    }
  }
  if (scheduleProblems.length > 0) {
    failures.push({
      code: "CAMPAIGN_SCHEDULE_INVALID",
      message: scheduleProblems.join("; "),
    });
  }

  // G4 budget sanity: every present key must be a positive integer
  // (budgetSchema, doc 34 section 5). One failure covers all bad keys.
  const budgetProblems: string[] = [];
  const budgetKeys = [
    "maxTotalPoints",
    "maxRedemptions",
    "perCustomerLimit",
  ] as const;
  for (const key of budgetKeys) {
    const value = campaign.budget[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      budgetProblems.push(`${key} must be a positive integer (got ${value})`);
    }
  }
  if (budgetProblems.length > 0) {
    failures.push({
      code: "CAMPAIGN_BUDGET_INVALID",
      message: budgetProblems.join("; "),
    });
  }

  return { ok: failures.length === 0, failures };
}

// Is the campaign live at the given instant? Doc 34 section 3: status
// must be 'active' and `at` must fall inside [startsAt, endsAt) with a
// null bound meaning open-ended. The end bound is EXCLUSIVE (at >=
// ends_at is not live), matching the doc's isCampaignLive snippet and the
// sweep's `ends_at <= now()` end condition. startsAt/endsAt are absolute
// instants (timestamptz), so this window check is timezone-agnostic;
// campaign.timezone matters only for recurrence evaluation, which is
// [V1] and deferred (a recurrence, when it ships, further gates liveness
// inside the envelope without ever flipping status).
export function isCampaignLive(campaign: Campaign, at: Date): boolean {
  if (campaign.status !== "active") return false;
  if (campaign.startsAt !== null && at.getTime() < campaign.startsAt.getTime()) {
    return false;
  }
  if (campaign.endsAt !== null && at.getTime() >= campaign.endsAt.getTime()) {
    return false;
  }
  return true;
}
