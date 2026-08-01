// @vitest-environment node
//
// ===========================================================================
// MERCHANT ACTIVATION: THE CHECKLIST, THE COPY, AND THE SUBMISSION.
//
// WHAT THIS SUITE IS FOR. Before this slice, `businesses.status` defaulted to
// 'draft' and nothing in the product ever moved it. Every consumer-facing read
// filters `status='active'`, so a merchant who signed up, finished onboarding
// and got a working-looking portal was invisible to every consumer forever,
// with no error anywhere. The tests below are the two halves of the fix:
//
//   1. THE MIRROR. `isUsableBaseRule` must agree with
//      `private.has_usable_base_rule` (migration 0033) case for case. A
//      checklist that ticks the box while the RPC refuses the submission is
//      worse than no checklist, because the merchant cannot tell which of the
//      two is wrong. Those tests are marked CRITICAL.
//   2. THE TRUTH. Every sentence this feature puts on screen is a function of
//      facts read that request, and the tests pin the ones that were wrong
//      before: no claim of a review that is not happening, and no silence about
//      a rejection.
// ===========================================================================

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import {
  activationBannerCopy,
  buildActivationChecklist,
  describeBaseRule,
  formatSubmittedOn,
  isUsableBaseRule,
  sentBackReason,
  submissionNoteProblem,
} from "./presenter";
import { submitForReview } from "./server/submit";
import type { ActivationFacts, BaseRuleShape, VerificationRound } from "./types";

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";
const ACTOR_ID = "5a2c1e7b-1111-4111-8111-111111111111";

function facts(overrides: Partial<ActivationFacts> = {}): ActivationFacts {
  return {
    businessId: BUSINESS_ID,
    status: "draft",
    hasEarningRule: false,
    hasMenuItem: false,
    hasStorefrontDetails: false,
    latestRound: null,
    ...overrides,
  };
}

function rule(overrides: Partial<BaseRuleShape> = {}): BaseRuleShape {
  return {
    rule_type: "amount_rate",
    rate_centavos_per_point: 10000,
    fixed_points: null,
    tiers: null,
    ...overrides,
  };
}

function round(overrides: Partial<VerificationRound> = {}): VerificationRound {
  return {
    id: "round-1",
    status: "pending",
    decisionReason: null,
    decidedAt: null,
    createdAt: "2026-07-29T02:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

describe("isUsableBaseRule mirrors private.has_usable_base_rule", () => {
  it("accepts an amount_rate rule that carries its rate", () => {
    expect(isUsableBaseRule(rule())).toBe(true);
  });

  it("CRITICAL: rejects an amount_rate rule with a null rate", () => {
    // points_rules constrains `rate_centavos_per_point > 0` only WHEN PRESENT,
    // so this row satisfies every database constraint, awards nothing, and
    // makes computeBasePoints throw. It is the likeliest accident of the three,
    // and the whole reason this predicate is not `rule !== null`.
    expect(isUsableBaseRule(rule({ rate_centavos_per_point: null }))).toBe(false);
  });

  it("accepts fixed_per_visit and fixed_per_receipt with points, rejects them without", () => {
    for (const ruleType of ["fixed_per_visit", "fixed_per_receipt"]) {
      expect(
        isUsableBaseRule(
          rule({ rule_type: ruleType, rate_centavos_per_point: null, fixed_points: 5 }),
        ),
      ).toBe(true);
      expect(
        isUsableBaseRule(
          rule({ rule_type: ruleType, rate_centavos_per_point: null, fixed_points: null }),
        ),
      ).toBe(false);
    }
  });

  it("accepts tiered_amount only with a non-empty tier array", () => {
    const tiered = { rule_type: "tiered_amount", rate_centavos_per_point: null, fixed_points: null };
    expect(isUsableBaseRule({ ...tiered, tiers: [{ minCentavos: 0, points: 5 }] })).toBe(true);
    expect(isUsableBaseRule({ ...tiered, tiers: [] })).toBe(false);
    expect(isUsableBaseRule({ ...tiered, tiers: null })).toBe(false);
  });

  it("rejects no rule at all and an unknown rule type", () => {
    expect(isUsableBaseRule(null)).toBe(false);
    expect(isUsableBaseRule(rule({ rule_type: "something_new" }))).toBe(false);
  });
});

describe("describeBaseRule", () => {
  it("describes each usable shape in the merchant's own terms", () => {
    expect(describeBaseRule(rule())).toBe("1 point per ₱100.00 spent");
    expect(
      describeBaseRule(
        rule({ rule_type: "fixed_per_visit", rate_centavos_per_point: null, fixed_points: 3 }),
      ),
    ).toBe("3 points per visit");
  });

  it("returns null for exactly the shapes isUsableBaseRule rejects", () => {
    // The two must not disagree: a rule the checklist calls unusable must not
    // get a sentence on the admin's queue saying what it awards.
    expect(describeBaseRule(rule({ rate_centavos_per_point: null }))).toBeNull();
    expect(describeBaseRule(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

describe("buildActivationChecklist", () => {
  it("CRITICAL: makes the earning rule the only requirement", () => {
    const checklist = buildActivationChecklist(facts());
    const required = checklist.items.filter((item) => item.required);
    expect(required.map((item) => item.id)).toEqual(["earning_rule"]);
  });

  it("blocks submission while the earning rule is missing", () => {
    const checklist = buildActivationChecklist(facts());
    expect(checklist.canSubmit).toBe(false);
    expect(checklist.blocking.map((item) => item.id)).toEqual(["earning_rule"]);
  });

  it("allows submission with a rule, even with no menu and no photo", () => {
    const checklist = buildActivationChecklist(facts({ hasEarningRule: true }));
    expect(checklist.canSubmit).toBe(true);
    expect(checklist.blocking).toEqual([]);
  });

  it("never offers submission from a status the RPC would refuse", () => {
    for (const status of ["pending_verification", "active", "suspended", "closed"] as const) {
      const checklist = buildActivationChecklist(facts({ status, hasEarningRule: true }));
      expect(checklist.canSubmit).toBe(false);
    }
  });

  it("marks the advisory items done when they are done", () => {
    const checklist = buildActivationChecklist(
      facts({ hasEarningRule: true, hasMenuItem: true, hasStorefrontDetails: true }),
    );
    expect(checklist.items.every((item) => item.done)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

describe("activationBannerCopy", () => {
  it("says nothing at all for a live business", () => {
    expect(activationBannerCopy(facts({ status: "active", hasEarningRule: true }))).toBeNull();
  });

  it("CRITICAL: never claims documents are under review", () => {
    // The original bug: a `draft` merchant was told "Your documents are under
    // review" when nothing had been submitted and no reviewer existed. No
    // branch of this function may say it, in any status, because this product
    // still collects no documents.
    for (const status of ["draft", "pending_verification", "suspended", "closed"] as const) {
      const copy = activationBannerCopy(facts({ status }));
      expect(copy?.message ?? "").not.toMatch(/documents/i);
    }
  });

  it("tells a draft with nothing set that it is not shown to customers", () => {
    const copy = activationBannerCopy(facts());
    expect(copy?.tone).toBe("warning");
    expect(copy?.message).toMatch(/not shown to customers/i);
  });

  it("tells a ready draft that it can ask for review", () => {
    const copy = activationBannerCopy(facts({ hasEarningRule: true }));
    expect(copy?.tone).toBe("info");
    expect(copy?.message).toMatch(/ready to ask for review/i);
  });

  it("CRITICAL: does not stay silent about a rejection", () => {
    const copy = activationBannerCopy(
      facts({
        hasEarningRule: true,
        latestRound: round({ status: "rejected", decisionReason: "Address mismatch." }),
      }),
    );
    expect(copy?.tone).toBe("warning");
    expect(copy?.message).toMatch(/sent back/i);
  });

  it("says a pending submission is with the team and asks nothing of the merchant", () => {
    const copy = activationBannerCopy(
      facts({ status: "pending_verification", hasEarningRule: true, latestRound: round() }),
    );
    expect(copy?.message).toMatch(/with the Giya team/i);
  });
});

describe("sentBackReason", () => {
  it("returns the admin's text verbatim for a refused round", () => {
    expect(
      sentBackReason(round({ status: "rejected", decisionReason: "The permit is expired." })),
    ).toBe("The permit is expired.");
  });

  it("treats revision_requested as sent back too", () => {
    expect(sentBackReason(round({ status: "revision_requested", decisionReason: "Reupload." }))).toBe(
      "Reupload.",
    );
  });

  it("returns null for a pending or approved round, and for a blank reason", () => {
    expect(sentBackReason(round())).toBeNull();
    expect(sentBackReason(round({ status: "approved", decisionReason: "Fine." }))).toBeNull();
    expect(sentBackReason(round({ status: "rejected", decisionReason: "   " }))).toBeNull();
    expect(sentBackReason(null)).toBeNull();
  });
});

describe("small formatters", () => {
  it("formats a submission date unambiguously and refuses to guess", () => {
    expect(formatSubmittedOn("2026-07-29T02:00:00.000Z")).toBe("2026-07-29");
    expect(formatSubmittedOn("not a date")).toBeNull();
    expect(formatSubmittedOn(null)).toBeNull();
  });

  it("accepts an empty applicant note, because it is optional", () => {
    expect(submissionNoteProblem("")).toBeNull();
    expect(submissionNoteProblem("   ")).toBeNull();
    expect(submissionNoteProblem("x".repeat(1001))).toMatch(/under 1000/);
  });
});

// ---------------------------------------------------------------------------
// The submission
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function harness(result: { data?: unknown; error?: { message: string } | null }) {
  const calls: RpcCall[] = [];
  const supabase = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
  return {
    calls,
    deps: { supabase: supabase as unknown as SupabaseClient<Database> },
  };
}

describe("submitForReview", () => {
  it("calls the RPC with the session-resolved actor and returns the round id", async () => {
    const h = harness({ data: { verification_id: "round-9", status: "pending_verification" } });

    const outcome = await submitForReview(
      { businessId: BUSINESS_ID, actorId: ACTOR_ID, note: "Permits at city hall.", requestId: "req-1" },
      h.deps,
    );

    expect(outcome).toEqual({ ok: true, verificationId: "round-9" });
    expect(h.calls[0]?.fn).toBe("submit_business_for_review");
    expect(h.calls[0]?.args).toMatchObject({
      p_business_id: BUSINESS_ID,
      p_actor_id: ACTOR_ID,
      p_note: "Permits at city hall.",
      p_request_id: "req-1",
    });
  });

  it("omits the note entirely when there is none, so the RPC default applies", async () => {
    const h = harness({ data: { verification_id: "round-9" } });
    await submitForReview(
      { businessId: BUSINESS_ID, actorId: ACTOR_ID, note: "   ", requestId: "req-1" },
      h.deps,
    );
    expect(h.calls[0]?.args).not.toHaveProperty("p_note");
  });

  it("CRITICAL: turns the no-rule refusal into an instruction, not an error code", async () => {
    const h = harness({ error: { message: "ACTIVATION_NO_EARNING_RULE" } });
    const outcome = await submitForReview(
      { businessId: BUSINESS_ID, actorId: ACTOR_ID, note: null, requestId: "req-1" },
      h.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("NO_EARNING_RULE");
    expect(outcome.message).toMatch(/earn points first/i);
  });

  it("maps every other stable RPC message to its own code", async () => {
    const cases = [
      ["SUBMIT_FORBIDDEN", "FORBIDDEN"],
      ["BUSINESS_NOT_FOUND", "NOT_FOUND"],
      ["SUBMIT_INVALID_STATE", "INVALID_STATE"],
      ["something nobody registered", "WRITE_FAILED"],
    ] as const;

    for (const [message, code] of cases) {
      const h = harness({ error: { message } });
      const outcome = await submitForReview(
        { businessId: BUSINESS_ID, actorId: ACTOR_ID, note: null, requestId: "req-1" },
        h.deps,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe(code);
    }
  });

  it("reports an unreadable success as success, because the transaction committed", async () => {
    // The business IS submitted whatever the return shape looks like. Calling
    // this a failure would invite a second submission and SUBMIT_INVALID_STATE.
    const h = harness({ data: "not an object" });
    const outcome = await submitForReview(
      { businessId: BUSINESS_ID, actorId: ACTOR_ID, note: null, requestId: "req-1" },
      h.deps,
    );
    expect(outcome).toEqual({ ok: true, verificationId: null });
  });

  it("refuses to act at all with no service-role client", async () => {
    const outcome = await submitForReview(
      { businessId: BUSINESS_ID, actorId: ACTOR_ID, note: null, requestId: "req-1" },
      null,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});
