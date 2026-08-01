import { describe, expect, it } from "vitest";

import {
  REVIEW_RATE_ATTENTION,
  foldRoutingBreakdown,
  formatShare,
  needsLoosening,
  reasonLabel,
} from "./routing-breakdown";
import type { RoutingTally } from "./routing-breakdown";

// D10's arithmetic. The number these functions produce is the one a decision to
// loosen a threshold on the money path will be made on, so every edge is pinned
// rather than sampled: an empty window, a window of nothing but backfill, a
// receipt that tripped several rules, and the difference between "no receipts"
// and "no reviews".

function status(key: string, tally: number): RoutingTally {
  return { kind: "status", key, tally };
}
function reason(key: string, tally: number): RoutingTally {
  return { kind: "reason", key, tally };
}

describe("foldRoutingBreakdown - the rates", () => {
  it("computes the three shares over SETTLED receipts, not over everything", () => {
    const breakdown = foldRoutingBreakdown(
      [status("approved", 70), status("review", 20), status("rejected", 10), status("pending", 50)],
      30,
    );

    expect(breakdown.total).toBe(150);
    expect(breakdown.approvalRate).toBeCloseTo(0.7);
    expect(breakdown.reviewRate).toBeCloseTo(0.2);
    expect(breakdown.rejectionRate).toBeCloseTo(0.1);
  });

  it("CRITICAL: a backed-up queue cannot dilute the review rate", () => {
    // Pending receipts have no outcome yet. Counting them in the denominator
    // would make the rate DIP exactly when the queue is filling up, which is
    // the one moment it must not lie. Same population, more pending, same rate.
    const quiet = foldRoutingBreakdown(
      [status("approved", 8), status("review", 2), status("pending", 0)],
      30,
    );
    const swamped = foldRoutingBreakdown(
      [status("approved", 8), status("review", 2), status("pending", 900)],
      30,
    );

    expect(swamped.reviewRate).toBeCloseTo(quiet.reviewRate);
    expect(swamped.total).toBe(910);
  });

  it("returns zeros rather than NaN for an empty window", () => {
    const breakdown = foldRoutingBreakdown([], 30);

    expect(breakdown.total).toBe(0);
    expect(breakdown.reviewRate).toBe(0);
    expect(breakdown.approvalRate).toBe(0);
    expect(breakdown.reasons).toEqual([]);
  });

  it("ignores a status it does not recognise instead of guessing a bucket", () => {
    const breakdown = foldRoutingBreakdown(
      [status("approved", 5), status("teleported", 99)],
      30,
    );

    expect(breakdown.total).toBe(5);
  });

  it("carries the window it was given, so the caption cannot claim a different period", () => {
    expect(foldRoutingBreakdown([], 7).windowDays).toBe(7);
  });
});

describe("foldRoutingBreakdown - the reasons", () => {
  it("sorts by count so the rule worth tuning reads first", () => {
    const breakdown = foldRoutingBreakdown(
      [
        status("review", 10),
        reason("merchant_name_mismatch", 2),
        reason("parse_confidence_low", 7),
        reason("llm_assisted_field", 4),
      ],
      30,
    );

    expect(breakdown.reasons.map((r) => r.key)).toEqual([
      "parse_confidence_low",
      "llm_assisted_field",
      "merchant_name_mismatch",
    ]);
  });

  it("breaks a tie on the key, so a reload does not reshuffle the list", () => {
    const rows = [status("review", 4), reason("amount_sanity", 2), reason("staff_self_scan", 2)];

    expect(foldRoutingBreakdown(rows, 30).reasons.map((r) => r.key)).toEqual([
      "amount_sanity",
      "staff_self_scan",
    ]);
    expect(foldRoutingBreakdown([...rows].reverse(), 30).reasons.map((r) => r.key)).toEqual([
      "amount_sanity",
      "staff_self_scan",
    ]);
  });

  it("takes shares against the REVIEW count, so overlapping rules can exceed 100%", () => {
    // A receipt can trip several rules at once and every one of them is a true
    // statement about why a human is looking. Normalising them to a pie would
    // be the lie; the panel says so in words instead.
    const breakdown = foldRoutingBreakdown(
      [
        status("approved", 90),
        status("review", 10),
        reason("parse_confidence_low", 10),
        reason("llm_assisted_field", 8),
      ],
      30,
    );

    expect(breakdown.reasons[0]?.shareOfReviewed).toBeCloseTo(1);
    expect(breakdown.reasons[1]?.shareOfReviewed).toBeCloseTo(0.8);
    const sum = breakdown.reasons.reduce((total, r) => total + r.shareOfReviewed, 0);
    expect(sum).toBeGreaterThan(1);
  });

  it("does not clamp a share above 1, so a corrupt parse_meta stays visible", () => {
    const breakdown = foldRoutingBreakdown(
      [status("review", 2), reason("amount_sanity", 5)],
      30,
    );

    expect(breakdown.reasons[0]?.shareOfReviewed).toBeGreaterThan(1);
  });

  it("flags the backfill bucket rather than letting it read as a ninth rule", () => {
    const breakdown = foldRoutingBreakdown(
      [status("review", 6), reason("unattributed", 4), reason("amount_sanity", 2)],
      30,
    );

    const backfill = breakdown.reasons.find((r) => r.key === "unattributed");
    expect(backfill?.unattributed).toBe(true);
    expect(backfill?.label).toBe("Scanned before we recorded reasons");
    expect(breakdown.reasons.find((r) => r.key === "amount_sanity")?.unattributed).toBe(false);
  });

  it("CRITICAL: unattributed history never inflates a real reason", () => {
    // The whole honesty requirement. Historical receipts carry no reason, and
    // folding them into any real one would count them as evidence for a rule
    // that may never have fired. They stay their own line.
    const breakdown = foldRoutingBreakdown(
      [status("review", 100), reason("unattributed", 100)],
      30,
    );

    expect(breakdown.reasons).toHaveLength(1);
    expect(breakdown.reasons[0]?.key).toBe("unattributed");
    expect(breakdown.reviewRate).toBeCloseTo(1);
  });
});

describe("reasonLabel", () => {
  it("gives every reason the pipeline can record a merchant-readable name", () => {
    const recorded = [
      "amount_sanity",
      "customer_blacklisted",
      "llm_assisted_field",
      "merchant_name_mismatch",
      "merchant_name_unreadable",
      "parse_confidence_low",
      "match_confidence_low",
      "fraud_composite",
      "staff_self_scan",
      "ocr_operator_failure",
      // 0036. The tenth reason, and the only one no rule produced.
      "consumer_escalation",
      "unattributed",
    ];

    for (const key of recorded) {
      const label = reasonLabel(key);
      expect(label, key).not.toBe(key);
      expect(label, key).toBe(label.trim());
      expect(label, key).not.toContain("_");
    }
  });

  it("names a customer escalation as its own reason rather than crediting what rejected it", () => {
    // 0036. Without its own key the escalation would be counted under whichever
    // rule rejected the receipt first, inflating a threshold with queue items
    // that threshold had nothing to do with, and the loosening ladder would be
    // tuned on a number nobody measured.
    expect(reasonLabel("consumer_escalation")).toMatch(/customer asked you to look again/i);
  });

  it("counts an escalation alongside the rule that rejected the receipt originally", () => {
    // A receipt can carry both, and both are true statements about why a human
    // is looking at it, so neither is allowed to swallow the other.
    const breakdown = foldRoutingBreakdown(
      [
        status("review", 2),
        status("approved", 8),
        reason("parse_confidence_low", 2),
        reason("consumer_escalation", 1),
      ],
      30,
    );

    const keys = breakdown.reasons.map((entry) => entry.key);
    expect(keys).toContain("consumer_escalation");
    expect(keys).toContain("parse_confidence_low");
    expect(
      breakdown.reasons.find((entry) => entry.key === "consumer_escalation")?.shareOfReviewed,
    ).toBeCloseTo(0.5);
  });

  it("says plainly that an operator failure was ours", () => {
    expect(reasonLabel("ocr_operator_failure")).toMatch(/our side/i);
  });

  it("renders an unknown key raw rather than inventing a friendly name for it", () => {
    // Reachable when the database is ahead of the deploy. Ugly and honest beats
    // a made-up label that hides a rule the reader is trying to count.
    expect(reasonLabel("some_future_reason")).toBe("some_future_reason");
  });

  it("uses no em-dashes anywhere in the vocabulary", () => {
    for (const key of ["amount_sanity", "ocr_operator_failure", "unattributed"]) {
      expect(reasonLabel(key)).not.toContain("—");
      expect(reasonLabel(key)).not.toContain("–");
    }
  });
});

describe("formatShare", () => {
  it("rounds to whole percent and invents no precision", () => {
    expect(formatShare(0.2612)).toBe("26%");
    expect(formatShare(1)).toBe("100%");
  });

  it("renders nothing and a negative as 0%", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(-1)).toBe("0%");
    expect(formatShare(Number.NaN)).toBe("0%");
  });
});

describe("needsLoosening", () => {
  it("fires above D10's quarter and not at it", () => {
    const at = foldRoutingBreakdown(
      [status("approved", 75), status("review", 25)],
      30,
    );
    const over = foldRoutingBreakdown(
      [status("approved", 74), status("review", 26)],
      30,
    );

    expect(REVIEW_RATE_ATTENTION).toBe(0.25);
    expect(needsLoosening(at)).toBe(false);
    expect(needsLoosening(over)).toBe(true);
  });

  it("never fires on a merchant who has not opened yet", () => {
    // A "needs attention" flag on an empty window is the fastest way to teach
    // an operator to ignore the flag.
    expect(needsLoosening(foldRoutingBreakdown([], 30))).toBe(false);
    expect(needsLoosening(foldRoutingBreakdown([status("pending", 3)], 30))).toBe(false);
  });
});
