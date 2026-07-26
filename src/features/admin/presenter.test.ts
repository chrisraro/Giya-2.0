// Pure presentation logic for the admin portal.
//
// The most important assertion in this file is the one that looks like
// bookkeeping: `describeSignal` re-exported here IS the business review
// presenter's function, not a copy. Doc 37's evidence contract has one
// implementation, and a fork would let an admin and a merchant read different
// sentences about the same detector.

import { describe, expect, it } from "vitest";

import { describeSignal as businessDescribeSignal } from "../receipts/review/presenter";
import {
  ADMIN_FRAUD_TABS,
  LADDER_COPY,
  MIN_REASON_LENGTH,
  clawbackCopy,
  cooldownState,
  describeActor,
  describeAuditAction,
  describeSignal,
  formatApprovalRatio,
  formatPlatformAmount,
  isAdminFraudFilter,
  isAdminReceiptFilter,
  reasonProblem,
  standingChipClass,
  standingChips,
} from "./presenter";
import type { ConsumerStandingView } from "./types";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function standing(overrides: Partial<ConsumerStandingView> = {}): ConsumerStandingView {
  return {
    receiptsTotal: 10,
    approved: 8,
    rejected: 2,
    approvalRatio: 0.8,
    priorSignals: 0,
    strikes: 0,
    devices: 1,
    businesses: 1,
    scanBlockedUntil: null,
    isSuspended: false,
    suspendedReason: null,
    ...overrides,
  };
}

describe("the evidence contract is not forked", () => {
  it("re-exports the business review presenter's describeSignal, identically", () => {
    expect(describeSignal).toBe(businessDescribeSignal);
  });
});

describe("filters", () => {
  it("accepts only the declared filter values", () => {
    expect(isAdminFraudFilter("open")).toBe(true);
    expect(isAdminFraudFilter("blocked")).toBe(true);
    expect(isAdminFraudFilter("everything")).toBe(false);
    expect(isAdminReceiptFilter("unmatched")).toBe(true);
    expect(isAdminReceiptFilter("../../etc")).toBe(false);
  });

  it("names every fraud tab", () => {
    expect(ADMIN_FRAUD_TABS.map((tab) => tab.value)).toEqual(["open", "blocked", "all"]);
  });
});

describe("formatApprovalRatio", () => {
  it("reads as a ratio when something has been decided", () => {
    expect(formatApprovalRatio(standing())).toBe("80% approved (8 of 10)");
  });

  it("says nothing has been decided rather than claiming 0%", () => {
    // 0/0 is not "0% approved". A brand new account shown 0% reads as a red
    // flag to the person deciding whether to suspend it.
    expect(formatApprovalRatio(standing({ approved: 0, rejected: 0, approvalRatio: null }))).toBe(
      "Nothing decided yet",
    );
  });
});

describe("cooldownState", () => {
  it("is inactive with no block", () => {
    expect(cooldownState(null, NOW)).toEqual({ active: false, label: "Not in cooldown" });
  });

  it("counts the remaining hours while a block is live", () => {
    const until = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    const state = cooldownState(until, NOW);
    expect(state.active).toBe(true);
    expect(state.label).toBe("Scanning blocked for 5 more hours");
  });

  it("reports a block that has already expired as over, not as live", () => {
    const until = new Date(NOW.getTime() - 3_600_000).toISOString();
    expect(cooldownState(until, NOW).active).toBe(false);
  });

  it("degrades an unparseable timestamp to no cooldown rather than throwing", () => {
    expect(cooldownState("not a date", NOW).active).toBe(false);
  });
});

describe("standingChips", () => {
  it("says a clean record is clean, in one chip", () => {
    const chips = standingChips(standing(), NOW);
    expect(chips).toEqual([{ label: "No fraud signals", tone: "neutral" }]);
  });

  it("puts suspension and a live cooldown first, in the alarm tone", () => {
    const chips = standingChips(
      standing({
        isSuspended: true,
        scanBlockedUntil: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        strikes: 4,
        priorSignals: 9,
      }),
      NOW,
    );
    expect(chips[0]?.label).toBe("Suspended platform-wide");
    expect(chips[0]?.tone).toBe("alarm");
    expect(chips[1]?.tone).toBe("alarm");
    expect(chips.some((chip) => chip.label === "4 fraud rejections in 30 days")).toBe(true);
  });

  it("escalates the strike chip at doc 37's threshold of three", () => {
    expect(standingChips(standing({ strikes: 2 }), NOW)[0]?.tone).toBe("attention");
    expect(standingChips(standing({ strikes: 3 }), NOW)[0]?.tone).toBe("alarm");
  });

  it("only mentions devices and businesses when there is more than one of either", () => {
    const single = standingChips(standing(), NOW);
    expect(single.some((chip) => chip.label.includes("device"))).toBe(false);
    const many = standingChips(standing({ devices: 3, businesses: 4 }), NOW);
    expect(many.some((chip) => chip.label === "3 devices")).toBe(true);
    expect(many.some((chip) => chip.label === "Scans at 4 businesses")).toBe(true);
  });

  it("returns token class names, never a raw colour", () => {
    for (const tone of ["neutral", "attention", "alarm"] as const) {
      expect(standingChipClass(tone)).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });
});

describe("clawbackCopy", () => {
  it("offers the action with the points at stake named", () => {
    const view = clawbackCopy({ kind: "eligible", earnPoints: 120 });
    expect(view.available).toBe(true);
    expect(view.summary).toContain("120 points");
  });

  it("distinguishes never-awarded from already-reversed", () => {
    // Doc 37 registers one error code for both. They lead an admin to
    // completely different next steps, so they get different sentences.
    const never = clawbackCopy({ kind: "never_awarded" });
    const already = clawbackCopy({ kind: "already_reversed", clawedPoints: 40 });
    expect(never.available).toBe(false);
    expect(already.available).toBe(false);
    expect(never.summary).not.toBe(already.summary);
    expect(already.summary).toContain("40 points");
  });
});

describe("LADDER_COPY", () => {
  it("maps every action to doc 37's audit verb", () => {
    expect(LADDER_COPY.cooldown_apply.auditAction).toBe("fraud.cooldown_applied");
    expect(LADDER_COPY.cooldown_lift.auditAction).toBe("fraud.cooldown_lifted");
    expect(LADDER_COPY.suspend.auditAction).toBe("consumer.suspended");
    expect(LADDER_COPY.clawback.auditAction).toBe("fraud.clawback_applied");
  });

  it("marks the three destructive steps and neither reversal", () => {
    expect(LADDER_COPY.cooldown_apply.destructive).toBe(true);
    expect(LADDER_COPY.suspend.destructive).toBe(true);
    expect(LADDER_COPY.clawback.destructive).toBe(true);
    expect(LADDER_COPY.cooldown_lift.destructive).toBe(false);
    expect(LADDER_COPY.unsuspend.destructive).toBe(false);
  });
});

describe("reasonProblem", () => {
  it("refuses an empty or whitespace-only reason", () => {
    expect(reasonProblem("")).not.toBeNull();
    expect(reasonProblem("      ")).not.toBeNull();
  });

  it("refuses a reason too short to be worth reading later", () => {
    expect(reasonProblem("dupe")).not.toBeNull();
    expect(reasonProblem("x".repeat(MIN_REASON_LENGTH))).toBeNull();
  });

  it("refuses a reason past the column's practical ceiling", () => {
    expect(reasonProblem("x".repeat(1001))).not.toBeNull();
  });

  it("accepts a real justification", () => {
    expect(reasonProblem("matched a receipt submitted at another business")).toBeNull();
  });
});

describe("audit vocabulary", () => {
  it("names the registered verbs", () => {
    expect(describeAuditAction("fraud.clawback_applied")).toBe("Points clawed back");
    expect(describeAuditAction("receipt.review_rejected")).toBe("Rejected in review");
  });

  it("humanises a verb a later slice registers, rather than rendering nothing", () => {
    expect(describeAuditAction("flag.updated")).toBe("Flag updated");
  });

  it("attributes system and worker rows to Giya rather than to a missing name", () => {
    expect(describeActor("system", null)).toBe("Giya (automatic)");
    expect(describeActor("worker", "ignored")).toBe("Giya (automatic)");
    expect(describeActor("admin", "Ops Lead")).toBe("Ops Lead");
    expect(describeActor("admin", null)).toBe("Unknown");
  });
});

describe("formatPlatformAmount", () => {
  it("says a missing total was not read rather than showing zero pesos", () => {
    expect(formatPlatformAmount(null)).toBe("Not read");
    expect(formatPlatformAmount(12500)).toContain("125");
  });
});
