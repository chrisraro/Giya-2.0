// Pure presentation logic for the review surfaces.
//
// The interesting half of this suite is `describeSignal`: doc 37's display
// contract says evidence is RENDERED, and the only way to hold that line over
// time is to assert, per signal type, that the sentence a reviewer reads
// contains the numbers they need and that no raw jsonb key survives into it.

import { describe, expect, it } from "vitest";

import {
  QUEUE_TABS,
  REJECT_REASON_LABELS,
  REJECT_REASON_ORDER,
  SLA_ALERT_MS,
  SLA_TARGET_MS,
  compositeFraudScore,
  confidenceTone,
  describeSignal,
  evidenceRows,
  fieldChip,
  formatAmount,
  formatConfidence,
  formatDate,
  formatDateTime,
  highestSeverity,
  operatorFailureNotice,
  queueAge,
  severityMeta,
  slaChipClass,
  toneChipClass,
} from "./presenter";
import type { FraudSignalView, ParseMetaView } from "./types";

const NOW = new Date("2026-07-25T12:00:00.000Z");

function signal(overrides: Partial<FraudSignalView> = {}): FraudSignalView {
  return {
    id: "sig",
    signal: "velocity",
    severity: "warn",
    score: 0.7,
    evidence: {},
    createdAt: "2026-07-24T02:00:00.000Z",
    matchedReceipt: null,
    matchedReceiptOutsideTenant: false,
    ...overrides,
  };
}

describe("queueAge", () => {
  it("reads as a sentence at every scale", () => {
    expect(queueAge("2026-07-25T11:59:40.000Z", NOW).label).toBe("Just arrived");
    expect(queueAge("2026-07-25T11:40:00.000Z", NOW).label).toBe("Waiting 20 minutes");
    expect(queueAge("2026-07-25T11:00:00.000Z", NOW).label).toBe("Waiting 1 hour");
    expect(queueAge("2026-07-25T09:00:00.000Z", NOW).label).toBe("Waiting 3 hours");
    expect(queueAge("2026-07-23T12:00:00.000Z", NOW).label).toBe("Waiting 2 days");
  });

  it("maps doc 36's 24h target and 48h alert onto the SLA states", () => {
    const fresh = new Date(NOW.getTime() - SLA_TARGET_MS + 1000).toISOString();
    const late = new Date(NOW.getTime() - SLA_TARGET_MS).toISOString();
    const alarming = new Date(NOW.getTime() - SLA_ALERT_MS).toISOString();

    expect(queueAge(fresh, NOW).state).toBe("ok");
    expect(queueAge(late, NOW).state).toBe("due");
    expect(queueAge(alarming, NOW).state).toBe("overdue");
  });

  it("never reports a negative age from a clock skew", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(queueAge(future, NOW).elapsedMs).toBe(0);
    expect(queueAge("not a date", NOW).elapsedMs).toBe(0);
  });

  it("gives the steady state no accent", () => {
    expect(slaChipClass("ok")).not.toContain("error");
    expect(slaChipClass("overdue")).toContain("error-container");
  });
});

describe("severity and the composite", () => {
  it("ranks block above warn above info", () => {
    expect(highestSeverity([signal({ severity: "info" }), signal({ severity: "warn" })])).toBe(
      "warn",
    );
    expect(
      highestSeverity([signal({ severity: "warn" }), signal({ severity: "block" })]),
    ).toBe("block");
    expect(highestSeverity([])).toBeNull();
  });

  it("scores with doc 37's weights and clamps at one", () => {
    // 0.5 x 0.4 = 0.2
    expect(compositeFraudScore([{ severity: "warn", score: 0.5 }])).toBe(0.2);
    expect(
      compositeFraudScore([
        { severity: "warn", score: 0.7 },
        { severity: "block", score: 1 },
      ]),
    ).toBe(1);
  });

  it("labels severities without borrowing the rewards palette", () => {
    for (const severity of ["info", "warn", "block"] as const) {
      expect(severityMeta(severity).chipClass).not.toContain("tertiary");
    }
    expect(severityMeta("block").weight).toBe(1);
    expect(severityMeta("warn").weight).toBe(0.4);
  });
});

describe("confidence chips", () => {
  it("uses doc 32's bands", () => {
    expect(confidenceTone(0.95)).toBe("high");
    expect(confidenceTone(0.9)).toBe("high");
    expect(confidenceTone(0.7)).toBe("medium");
    expect(confidenceTone(0.69)).toBe("low");
  });

  it("renders as whole percent", () => {
    expect(formatConfidence(0.824)).toBe("82%");
  });

  it("never reaches for a raw colour", () => {
    for (const tone of ["high", "medium", "low"] as const) {
      expect(toneChipClass(tone)).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });
});

describe("fieldChip", () => {
  const meta: ParseMetaView = {
    engine: "parse/v1",
    tier: "heuristic",
    templateId: null,
    fields: {
      merchant_name: { tier: "template", present: true },
      receipt_number: { tier: "heuristic", present: true },
      receipt_date: { tier: "heuristic", present: false },
    },
    vatConsistent: true,
    withinAmountSanity: true,
    dateAmbiguous: false,
    notes: [],
    ocrMeanConfidence: 0.7,
    merchantCheck: null,
    reviewReasons: [],
  };

  it("names the source per field", () => {
    expect(fieldChip(meta, "merchant_name", 0.95).sourceLabel).toBe("From your template");
    expect(fieldChip(meta, "receipt_number", 0.95).sourceLabel).toBe("Read from the image");
  });

  it("says a field was not found rather than showing a confidence for nothing", () => {
    const chip = fieldChip(meta, "receipt_date", 0.95);
    expect(chip.sourceLabel).toBe("Not found");
    expect(chip.confidenceLabel).toBeNull();
    expect(chip.tone).toBe("low");
  });

  it("degrades when parse_meta is absent entirely", () => {
    expect(fieldChip(null, "total_centavos", 0.9).sourceLabel).toBe("No parse record");
  });

  it("carries the receipt's parse confidence into the chip", () => {
    expect(fieldChip(meta, "merchant_name", 0.82).confidenceLabel).toBe("82% confident");
    expect(fieldChip(meta, "merchant_name", null).confidenceLabel).toBeNull();
  });
});

describe("describeSignal renders evidence rather than dumping it", () => {
  it("turns a velocity window into a count against a cap, with a meter", () => {
    const view = describeSignal(
      signal({ signal: "velocity", evidence: { window: "pair_10min", count: 3, cap: 2 } }),
    );

    expect(view.title).toBe("Scan rate");
    expect(view.summary).toBe(
      "3 scans at this business within 10 minutes, against an allowance of 2.",
    );
    expect(view.meter).toEqual({
      label: "at this business within 10 minutes",
      count: 3,
      cap: 2,
    });
    // The raw keys never survive into the rendered rows.
    expect(view.rows).toEqual([]);
  });

  it("gives a duplicate its distance readout and its denominator", () => {
    const view = describeSignal(
      signal({
        signal: "image_hash_dup",
        severity: "block",
        score: 1,
        evidence: {
          matched_receipt_id: "r2",
          hamming_distance: 2,
          matched_consumer_id: "c9",
          cross_consumer: true,
        },
      }),
    );

    expect(view.summary).toContain("2 bits away");
    expect(view.rows.map((row) => row.label)).toEqual(["Image difference", "Account"]);
    expect(view.rows[0]?.value).toContain("of 64 bits");
    expect(view.rows[1]?.value).toContain("different customer");
  });

  it("never prints the other consumer's id or the matched receipt id", () => {
    const view = describeSignal(
      signal({
        signal: "receipt_number_dup",
        severity: "block",
        evidence: {
          matched_receipt_id: "receipt-uuid-here",
          matched_consumer_id: "consumer-uuid-here",
          receipt_number: "0012345",
          cross_consumer: true,
        },
      }),
    );

    const rendered = JSON.stringify(view);
    expect(rendered).not.toContain("receipt-uuid-here");
    expect(rendered).not.toContain("consumer-uuid-here");
    expect(rendered).toContain("0012345");
  });

  it("explains each timestamp anomaly kind differently", () => {
    const future = describeSignal(
      signal({
        signal: "timestamp_anomaly",
        evidence: { kind: "future_dated", receipt_date: "2026-08-01T00:00:00.000Z", grace_hours: 24 },
      }),
    );
    expect(future.summary).toContain("in the future");

    const stale = describeSignal(
      signal({
        signal: "timestamp_anomaly",
        evidence: { kind: "stale", receipt_date: "2026-01-01T00:00:00.000Z", max_age_days: 30 },
      }),
    );
    expect(stale.summary).toContain("more than 30 days old");

    const predates = describeSignal(
      signal({
        signal: "timestamp_anomaly",
        evidence: {
          kind: "predates_activation",
          receipt_date: "2026-01-01T00:00:00.000Z",
          business_verified_at: "2026-06-01T00:00:00.000Z",
        },
      }),
    );
    expect(predates.summary).toContain("before this business went live");
    expect(predates.rows).toContainEqual({ label: "Business live since", value: "2026-06-01" });
  });

  it("renders the closed-hours case with the brief's own worked example, non-accusatory", () => {
    const view = describeSignal(
      signal({
        signal: "timestamp_anomaly",
        evidence: { kind: "closed_hours", receipt_time: "02:14", weekday: 7 },
      }),
    );

    expect(view.summary).toBe(
      "Receipt time 2:14 AM is outside this business's stated hours.",
    );
    expect(view.rows).toContainEqual({ label: "Day", value: "Sunday" });
    // Raw jsonb keys never survive into a row.
    expect(view.rows.map((row) => row.label)).not.toContain("Receipt time");
    expect(view.rows.map((row) => row.label)).not.toContain("Weekday");

    const accusatory = /fraud|fake|stole|stolen|cheat|lying|lied|scam|dishonest/i;
    expect(`${view.title} ${view.summary}`).not.toMatch(accusatory);
  });

  it("degrades gracefully when the closed-hours evidence carries no receipt_time", () => {
    const view = describeSignal(
      signal({ signal: "timestamp_anomaly", evidence: { kind: "closed_hours" } }),
    );
    expect(view.summary).toBe("The printed time is outside this business's stated hours.");
  });

  it("formats amount evidence as pesos, not centavos", () => {
    const view = describeSignal(
      signal({
        signal: "amount_anomaly",
        evidence: { observed_centavos: 19_000, line_items_centavos: 12_000 },
      }),
    );

    expect(view.rows).toContainEqual({ label: "Printed total", value: "₱190.00" });
    expect(view.rows).toContainEqual({ label: "Items add up to", value: "₱120.00" });
  });

  it("turns a low OCR confidence into a percentage", () => {
    const view = describeSignal(
      signal({ signal: "ai_confidence_low", severity: "info", evidence: { mean_confidence: 0.61 } }),
    );
    expect(view.summary).toContain("61% confident");
  });

  it("names the staff role on a self scan", () => {
    const view = describeSignal(
      signal({ signal: "staff_self_scan", evidence: { staff_role: "manager", business_id: "b1" } }),
    );
    expect(view.summary).toContain("manager at this business");
    // business_id is the tenant the reviewer is already inside; it is hidden.
    expect(view.rows).toEqual([]);
  });

  it("still renders a signal shape it has never seen, as labelled rows", () => {
    const view = describeSignal(
      signal({ signal: "gps_mismatch", evidence: { distance_m: 4200, opted_in: true } }),
    );

    expect(view.rows).toContainEqual({ label: "Distance m", value: "4200" });
    expect(view.rows).toContainEqual({ label: "Opted in", value: "Yes" });
  });
});

describe("evidenceRows", () => {
  it("hides the id-shaped keys and humanizes the rest", () => {
    const rows = evidenceRows(
      {
        matched_receipt_id: "r",
        matched_consumer_id: "c",
        business_id: "b",
        some_total_centavos: 12_345,
        nested: { a: 1, b: 2 },
        listy: [1, 2, 3],
      },
      [],
    );

    expect(rows).toEqual([
      { label: "Some total", value: "₱123.45" },
      { label: "Nested", value: "a, b" },
      { label: "Listy", value: "3 entries" },
    ]);
  });
});

describe("formatting helpers", () => {
  it("distinguishes a missing amount from zero", () => {
    expect(formatAmount(null)).toBe("Not found");
    expect(formatAmount(0)).toBe("₱0.00");
  });

  it("formats dates unambiguously", () => {
    expect(formatDate("2026-07-24T05:45:00.000Z")).toBe("2026-07-24");
    expect(formatDate(null)).toBe("Not recorded");
    expect(formatDateTime("2026-07-24T05:45:00.000Z")).toBe("2026-07-24 05:45 UTC");
  });
});

describe("copy hygiene", () => {
  const everyString = [
    ...Object.values(REJECT_REASON_LABELS),
    ...QUEUE_TABS.map((tab) => tab.label),
    describeSignal(signal({ signal: "velocity", evidence: { window: "consumer_day", count: 12, cap: 10 } }))
      .summary,
    describeSignal(signal({ signal: "staff_self_scan", evidence: { staff_role: "owner" } })).summary,
    describeSignal(signal({ signal: "image_hash_dup", evidence: { hamming_distance: 1 } })).summary,
  ];

  it.each(everyString)("%s uses no em-dash", (text) => {
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("offers every reject reason the enum allows, fraud reasons last", () => {
    expect([...REJECT_REASON_ORDER].sort()).toEqual(
      Object.keys(REJECT_REASON_LABELS).sort(),
    );
    expect(REJECT_REASON_ORDER.slice(-2)).toEqual(["duplicate", "fraud_suspected"]);
  });
});

// ---------------------------------------------------------------------------
// D7: the reviewer's notice for a receipt WE failed to read
// ---------------------------------------------------------------------------

function parseMetaWith(reviewReasons: string[]): ParseMetaView {
  return {
    engine: null,
    tier: null,
    templateId: null,
    fields: {},
    vatConsistent: null,
    withinAmountSanity: null,
    dateAmbiguous: null,
    notes: [],
    ocrMeanConfidence: null,
    merchantCheck: null,
    reviewReasons,
  };
}

describe("operatorFailureNotice", () => {
  it("explains the empty form when the pipeline failed on our side", () => {
    // This is the one receipt in the queue with NO parse at all: the OCR call
    // never came back, so every field is blank and there is no merchant check,
    // no confidence and no signal. Without the notice a reviewer opens a blank
    // form beside a photograph and concludes the customer sent something broken.
    const notice = operatorFailureNotice(parseMetaWith(["ocr_operator_failure"]));

    expect(notice).not.toBeNull();
    expect(notice?.title).toMatch(/on us/i);
    expect(notice?.body).toMatch(/key in the total and the date/i);
  });

  it("is absent for every other reason a receipt reaches a human", () => {
    expect(operatorFailureNotice(parseMetaWith([]))).toBeNull();
    expect(operatorFailureNotice(parseMetaWith(["merchant_name_mismatch"]))).toBeNull();
    expect(operatorFailureNotice(parseMetaWith(["parse_confidence_low", "amount_sanity"]))).toBeNull();
    expect(operatorFailureNotice(null)).toBeNull();
  });

  it("still fires when the operator failure is one reason among several", () => {
    expect(
      operatorFailureNotice(parseMetaWith(["ocr_operator_failure", "customer_blacklisted"])),
    ).not.toBeNull();
  });

  it("CRITICAL: names no vendor, no quota and no cause code", () => {
    // reject_note carries `ocr_operator_failure:{code}` for an operator, and
    // 0017 withholds that column from the client for reasons that do not stop
    // applying because the reader happens to be a shop owner.
    const notice = operatorFailureNotice(parseMetaWith(["ocr_operator_failure"]));
    const text = `${notice?.title ?? ""} ${notice?.body ?? ""}`;

    expect(text).not.toMatch(/google|vision|quota|credit|billing|token|OCR_/i);
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("does not blame the photograph", () => {
    const notice = operatorFailureNotice(parseMetaWith(["ocr_operator_failure"]));

    expect(notice?.body).toMatch(/photo is fine/i);
    expect(notice?.body).not.toMatch(/blurry|unreadable|bad photo|retake/i);
  });
});
