import { describe, expect, it } from "vitest";

import type { ReceiptRejectReason, ReceiptStatus } from "../types";
import {
  approvedCopy,
  isPendingStatus,
  isSettledStatus,
  pendingCopy,
  receiptOutcome,
  receiptStatusLabel,
  receiptTone,
  rejectionCopy,
  reviewCopy,
  type ReceiptOutcomeCopy,
} from "./receipt-copy";

// The consumer copy matrix. This is the file that decides what a person is
// told when their money-bearing receipt is refused, so it is tested reason by
// reason rather than sampled.
//
// The last describe block is the important one: it asserts, over EVERY string
// this module can produce, that nothing from the fraud stage, the parser's
// internals or another consumer's data can appear. That property is enforced
// three ways in this codebase and this is the third:
//
//   1. 0017_receipts.sql does not grant the client SELECT on reject_note,
//      parse_meta, match_confidence, parse_confidence, sha256 or image_hash,
//      and gives consumers no policy on `fraud_signals` at all.
//   2. ReceiptListItemDTO has no field that could carry any of them, so the
//      components physically cannot be handed one.
//   3. The vocabulary assertions below, which catch the case where someone
//      writes the leak into the copy itself.

const ALL_STATUSES: readonly ReceiptStatus[] = [
  "queued",
  "processing",
  "review",
  "approved",
  "rejected",
];

const ALL_REJECT_REASONS: readonly ReceiptRejectReason[] = [
  "duplicate",
  "unreadable",
  "wrong_business",
  "too_old",
  "fraud_suspected",
  "manual",
];

describe("receiptOutcome", () => {
  it("collapses queued and processing into one pending state", () => {
    expect(receiptOutcome("queued")).toBe("pending");
    expect(receiptOutcome("processing")).toBe("pending");
  });

  it("maps the three outcomes one to one", () => {
    expect(receiptOutcome("approved")).toBe("approved");
    expect(receiptOutcome("review")).toBe("review");
    expect(receiptOutcome("rejected")).toBe("rejected");
  });
});

describe("isSettledStatus / isPendingStatus", () => {
  it("treats only approved and rejected as settled", () => {
    expect(isSettledStatus("approved")).toBe(true);
    expect(isSettledStatus("rejected")).toBe(true);
    expect(isSettledStatus("queued")).toBe(false);
    expect(isSettledStatus("processing")).toBe(false);
  });

  it("keeps watching a receipt in review, because a human can still move it", () => {
    expect(isSettledStatus("review")).toBe(false);
  });

  it("treats only queued and processing as pending, so the wallet stops polling once review is reached", () => {
    expect(isPendingStatus("queued")).toBe(true);
    expect(isPendingStatus("processing")).toBe(true);
    expect(isPendingStatus("review")).toBe(false);
    expect(isPendingStatus("approved")).toBe(false);
    expect(isPendingStatus("rejected")).toBe(false);
  });
});

describe("pendingCopy", () => {
  it("acknowledges receipt for a queued submission", () => {
    expect(pendingCopy("queued").title).toBe("Receipt received");
  });

  it('uses the calm "Reading your receipt" state while processing', () => {
    expect(pendingCopy("processing").title).toBe("Reading your receipt");
  });

  it("promises no timeline it cannot keep: no percentage, no seconds, no minutes", () => {
    for (const status of ["queued", "processing"] as const) {
      const body = pendingCopy(status).body;
      expect(body).not.toMatch(/\d+\s*%/);
      expect(body).not.toMatch(/\bsecond/i);
      expect(body).not.toMatch(/\bminute/i);
      expect(body).not.toMatch(/\bstep \d/i);
    }
  });

  it("tells the consumer it is safe to leave the screen", () => {
    expect(pendingCopy("processing").body).toMatch(/leave this screen/i);
  });

  it("offers no call to action: there is nothing to do but wait", () => {
    expect(pendingCopy("queued").action).toBeUndefined();
    expect(pendingCopy("processing").action).toBeUndefined();
  });
});

describe("reviewCopy", () => {
  it("says the store is checking it, framed as routine rather than a problem", () => {
    expect(reviewCopy().title).toBe("The store is checking this");
  });

  it("sets the honest expectation from doc 36's SLA target of under 24h", () => {
    expect(reviewCopy().body).toMatch(/within a day/i);
  });

  it("is not an error state: no failure, no problem, no sorry, no alarm", () => {
    const { title, body } = reviewCopy();
    const text = `${title} ${body}`;
    expect(text).not.toMatch(/\berror\b|\bfailed\b|\bproblem\b|\bsorry\b|\bwrong\b/i);
  });

  it("tells the consumer there is nothing left for them to do", () => {
    expect(reviewCopy().body).toMatch(/nothing you need to do/i);
  });
});

describe("approvedCopy", () => {
  it("states the awarded points and the wallet they landed in", () => {
    const copy = approvedCopy(120, "Kape Diaria");
    expect(copy.title).toBe("Points added");
    expect(copy.body).toBe("120 points are now in your Kape Diaria wallet.");
  });

  it("uses the singular for exactly one point", () => {
    expect(approvedCopy(1, "Kape Diaria").body).toBe("1 point is now in your Kape Diaria wallet.");
  });

  it("thousand-separates a large award", () => {
    expect(approvedCopy(12_500, null).body).toContain("12,500");
  });

  it("falls back to a generic wallet when the business is not resolved", () => {
    expect(approvedCopy(80, null).body).toBe("80 points are now in your wallet.");
  });

  it("never invents a number when the ledger row has not been read yet", () => {
    const copy = approvedCopy(null, "Kape Diaria");
    expect(copy.title).toBe("Receipt approved");
    expect(copy.body).not.toMatch(/\d/);
  });

  it("sends the consumer to the wallet", () => {
    expect(approvedCopy(120, "Kape Diaria").action).toEqual({
      label: "Go to wallet",
      href: "/wallet",
    });
  });

  it("distinguishes an award of zero from an award not yet read", () => {
    expect(approvedCopy(0, null).body).toContain("0 points");
    expect(approvedCopy(null, null).body).not.toContain("0");
  });
});

describe("rejectionCopy - the full matrix", () => {
  it("duplicate: says it is already on the account and explains the once-only rule", () => {
    const copy = rejectionCopy("duplicate");
    expect(copy.title).toBe("Already scanned");
    expect(copy.body).toBe(
      "This receipt is already on your account. Each receipt can earn points once.",
    );
    expect(copy.action).toEqual({ label: "See my receipts", href: "/receipts" });
  });

  it("duplicate: never names the earlier receipt or whose it was", () => {
    const copy = rejectionCopy("duplicate");
    const text = `${copy.title} ${copy.body}`;
    expect(text).not.toMatch(/\bmatch(ed|es)?\b|\banother (user|consumer|customer|person)\b/i);
    expect(text).not.toMatch(/\bid\b|\breceipt #|\bhash\b/i);
  });

  it("unreadable: offers a retake with actionable photo coaching", () => {
    const copy = rejectionCopy("unreadable");
    expect(copy.title).toBe("We could not read this photo");
    expect(copy.body).toMatch(/brighter light/i);
    expect(copy.action).toEqual({ label: "Take another photo", href: "/scan" });
  });

  it("wrong_business: names the mismatch without naming what it was matched against", () => {
    const copy = rejectionCopy("wrong_business");
    expect(copy.title).toBe("This looks like a different store");
    expect(copy.body).toMatch(/does not seem to be from the store/i);
    expect(copy.action).toEqual({ label: "Scan again", href: "/scan" });
    // No merchant name, no confidence, no threshold.
    expect(copy.body).not.toMatch(/\bconfidence\b|\bscore\b|\bsimilar/i);
  });

  it("too_old: explains the window without quoting a number it cannot know", () => {
    const copy = rejectionCopy("too_old");
    expect(copy.title).toBe("Past the scanning window");
    expect(copy.body).not.toMatch(/\d+\s*(day|hour|week)/i);
    expect(copy.action).toEqual({ label: "Back to wallet", href: "/wallet" });
  });

  it("fraud_suspected: neutral, non-accusatory, and mentions no check, rule or score", () => {
    const copy = rejectionCopy("fraud_suspected");
    expect(copy.title).toBe("We could not accept this receipt");
    expect(copy.body).toBe(
      "No points were added for this one. If you think that is not right, the store can take another look at it for you.",
    );
    const text = `${copy.title} ${copy.body}`;
    expect(text).not.toMatch(/fraud|suspect|abuse|cheat|violat|flag|check|rule|score|policy/i);
    expect(text).not.toMatch(/\byou (tried|attempted)\b/i);
  });

  it("CRITICAL - fraud_suspected: offers NO retake, so a rejection cannot be iterated against", () => {
    const copy = rejectionCopy("fraud_suspected");
    expect(copy.action?.href).not.toBe("/scan");
    expect(copy.action).toEqual({ label: "Back to wallet", href: "/wallet" });
  });

  it("manual: generic and recoverable, since it also covers a failed processing attempt", () => {
    const copy = rejectionCopy("manual");
    expect(copy.title).toBe("We could not accept this receipt");
    expect(copy.action).toEqual({ label: "Take another photo", href: "/scan" });
    // Never surfaces the internal reject_note ('processing_failed' for the
    // dead-letter path), which the client cannot read in the first place.
    expect(copy.body).not.toMatch(/processing_failed|attempt|ocr|queue|worker/i);
  });

  it("null reason still renders a complete explanation rather than a blank card", () => {
    const copy = rejectionCopy(null);
    expect(copy.title).toBeTruthy();
    expect(copy.body).toBeTruthy();
  });

  it("an unrecognised reason falls back to the generic copy instead of crashing", () => {
    const copy = rejectionCopy("some_future_reason" as ReceiptRejectReason);
    expect(copy.title).toBe("We could not accept this receipt");
  });

  it("covers every value of the receipt_reject_reason enum with a title, a body and an icon", () => {
    for (const reason of ALL_REJECT_REASONS) {
      const copy = rejectionCopy(reason);
      expect(copy.title, reason).toBeTruthy();
      expect(copy.body, reason).toBeTruthy();
      expect(copy.icon, reason).toBeTruthy();
    }
  });

  it("gives duplicate and unreadable distinct titles, so the two are never confused", () => {
    const titles = ALL_REJECT_REASONS.map((reason) => rejectionCopy(reason).title);
    expect(new Set(titles).size).toBeGreaterThanOrEqual(5);
  });
});

describe("receiptStatusLabel", () => {
  it("labels a queued or processing receipt with no points amount at all", () => {
    expect(receiptStatusLabel("queued")).toBe("Processing receipt");
    expect(receiptStatusLabel("processing")).toBe("Processing receipt");
    expect(receiptStatusLabel("processing")).not.toMatch(/\d/);
    expect(receiptStatusLabel("processing")).not.toMatch(/pts|points/i);
  });

  it("labels review and approved", () => {
    expect(receiptStatusLabel("review")).toBe("Being reviewed by the store");
    expect(receiptStatusLabel("approved")).toBe("Points added");
  });

  it("labels a rejection with its own reason title", () => {
    expect(receiptStatusLabel("rejected", "duplicate")).toBe("Already scanned");
    expect(receiptStatusLabel("rejected", "unreadable")).toBe("We could not read this photo");
    expect(receiptStatusLabel("rejected", "fraud_suspected")).toBe(
      "We could not accept this receipt",
    );
  });

  it("labels a rejection with no reason without leaving the row blank", () => {
    expect(receiptStatusLabel("rejected")).toBeTruthy();
  });
});

describe("receiptTone", () => {
  it("reserves the reward tone (mango) for an approved receipt", () => {
    expect(receiptTone("approved")).toBe("reward");
    for (const status of ALL_STATUSES.filter((s) => s !== "approved")) {
      expect(receiptTone(status), status).not.toBe("reward");
    }
  });

  it("keeps a rejection muted rather than loud", () => {
    expect(receiptTone("rejected")).toBe("muted");
  });
});

// ---------------------------------------------------------------------------
// The leak sweep
// ---------------------------------------------------------------------------

function everyCopyString(): { where: string; text: string }[] {
  const entries: { where: string; text: string }[] = [];

  function add(where: string, copy: ReceiptOutcomeCopy): void {
    entries.push({ where: `${where}.title`, text: copy.title });
    entries.push({ where: `${where}.body`, text: copy.body });
    if (copy.action) entries.push({ where: `${where}.action`, text: copy.action.label });
  }

  add("pendingCopy(queued)", pendingCopy("queued"));
  add("pendingCopy(processing)", pendingCopy("processing"));
  add("reviewCopy", reviewCopy());
  add("approvedCopy(120)", approvedCopy(120, "Kape Diaria"));
  add("approvedCopy(null)", approvedCopy(null, null));
  for (const reason of ALL_REJECT_REASONS) {
    add(`rejectionCopy(${reason})`, rejectionCopy(reason));
  }
  add("rejectionCopy(null)", rejectionCopy(null));

  for (const status of ALL_STATUSES) {
    entries.push({ where: `label(${status})`, text: receiptStatusLabel(status) });
  }
  for (const reason of ALL_REJECT_REASONS) {
    entries.push({
      where: `label(rejected,${reason})`,
      text: receiptStatusLabel("rejected", reason),
    });
  }

  return entries;
}

describe("no fraud internals and no parser internals reach the consumer", () => {
  // Vocabulary drawn from doc 37's signal catalog, doc 36's Stage 9
  // confidence model, and the columns 0017 deliberately withholds. If a
  // future copy edit reaches for any of these words, this test is the alarm.
  const FORBIDDEN = [
    /\bfraud\b/i,
    /\bsignal\b/i,
    /\bscore\b/i,
    /\bconfidence\b/i,
    /\bthreshold\b/i,
    /\bvelocity\b/i,
    /\bhash\b/i,
    /\bphash\b/i,
    /\bsha256\b/i,
    /\bhamming\b/i,
    /\bduplicate of\b/i,
    /\bmatched receipt\b/i,
    /\banother (user|consumer|customer|account)\b/i,
    /\breject_note\b/i,
    /\bparse_meta\b/i,
    /\bocr\b/i,
    /\bparse[_ ]confidence\b/i,
    /\bmatch[_ ]confidence\b/i,
    /\bgps\b/i,
    /\bdevice\b/i,
    /\bsuspicious\b/i,
    /\bblocked\b/i,
    /\bbanned\b/i,
  ];

  it.each(everyCopyString())("$where contains no fraud or parser vocabulary", ({ text }) => {
    for (const pattern of FORBIDDEN) {
      expect(text, `matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(everyCopyString())("$where uses no em-dash", ({ text }) => {
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it.each(everyCopyString())("$where is non-empty and trimmed", ({ text }) => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toBe(text.trim());
  });
});
