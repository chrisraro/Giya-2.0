import { describe, it, expect } from "vitest";

import {
  MATCH_THRESHOLDS,
  matchBusiness,
  matchOutcome,
  normalizeForMatch,
  trigramSimilarity,
} from "./matching";
import type { MatchCandidate, MatchThresholds } from "./matching";

// No trigram evidence unless a test asks for it. Production injects the
// Postgres similarity() result; tests inject a fixed number so the scoring
// boundaries are exercised exactly.
const noTrigram = () => 0;
const fixedTrigram = (value: number) => () => value;

const candidate = (overrides: Partial<MatchCandidate> = {}): MatchCandidate => ({
  businessId: "biz-a",
  name: "Jolli Cafe",
  ...overrides,
});

describe("normalizeForMatch", () => {
  it("uppercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeForMatch("  Jolli   Cafe, Inc.  ")).toBe("JOLLI CAFE INC");
  });

  it("returns an empty string for punctuation-only input", () => {
    expect(normalizeForMatch("--- ... ---")).toBe("");
  });
});

describe("trigramSimilarity", () => {
  it("scores identical strings at 1", () => {
    expect(trigramSimilarity("JOLLI CAFE", "JOLLI CAFE")).toBe(1);
  });

  it("is case and punctuation insensitive like Postgres similarity()", () => {
    expect(trigramSimilarity("Jolli Cafe, Inc.", "JOLLI CAFE INC")).toBe(1);
  });

  it("is symmetric", () => {
    const a = "ALING NENAS EATERY";
    const b = "ALING NENA EATERY BRANCH";
    expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
  });

  it("scores unrelated names below the 0.4 prefilter", () => {
    expect(trigramSimilarity("JOLLI CAFE", "MERCURY DRUG")).toBeLessThan(0.4);
  });

  it("scores a near miss above the 0.4 prefilter", () => {
    expect(trigramSimilarity("JOLLI CAFE", "JOLLI CAFE CORP")).toBeGreaterThan(
      0.4,
    );
  });

  it("scores empty input at 0 without dividing by zero", () => {
    expect(trigramSimilarity("", "JOLLI CAFE")).toBe(0);
    expect(trigramSimilarity("", "")).toBe(0);
  });
});

describe("matchBusiness - no candidates", () => {
  it("returns a null business at zero confidence for an empty candidate list", () => {
    expect(
      matchBusiness({
        rawText: "JOLLI CAFE\nTOTAL 245.00",
        merchantName: "JOLLI CAFE",
        candidates: [],
        trigramSimilarity: noTrigram,
      }),
    ).toEqual({ businessId: null, confidence: 0, contradicted: false });
  });

  it("returns a null business when candidates exist but nothing matches", () => {
    expect(
      matchBusiness({
        rawText: "TOTAL 245.00",
        merchantName: "UNKNOWN STORE",
        candidates: [candidate()],
        trigramSimilarity: fixedTrigram(0.1),
      }),
    ).toEqual({ businessId: null, confidence: 0, contradicted: false });
  });
});

describe("matchBusiness - best-of scoring", () => {
  it("scores a TIN hit in raw text at 0.98", () => {
    const result = matchBusiness({
      rawText: "JOLLI CAFE CORP\nTIN: 123-456-789-000\nTOTAL 245.00",
      merchantName: null,
      candidates: [candidate({ tin: "123-456-789-000" })],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.98,
      contradicted: false,
    });
  });

  it("matches a TIN printed without separators", () => {
    const result = matchBusiness({
      rawText: "TIN 123456789000",
      merchantName: null,
      candidates: [candidate({ tin: "123-456-789-000" })],
      trigramSimilarity: noTrigram,
    });
    expect(result.confidence).toBe(0.98);
  });

  it("ignores a too-short TIN rather than treating it as identity evidence", () => {
    const result = matchBusiness({
      rawText: "ORDER 12345",
      merchantName: null,
      candidates: [candidate({ tin: "12345" })],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: null,
      confidence: 0,
      contradicted: false,
    });
  });

  it("scores a normalized alias hit at 0.95", () => {
    const result = matchBusiness({
      rawText: "JOLLI  CAFE.\nTOTAL 245.00",
      merchantName: "  Jolli  Cafe. ",
      candidates: [candidate({ merchantAliases: ["JOLLI CAFE"] })],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.95,
      contradicted: false,
    });
  });

  it("takes the best input, never the sum, within one candidate", () => {
    // TIN 0.98 and alias 0.95 on the same candidate: 0.98, not 1.93.
    const result = matchBusiness({
      rawText: "JOLLI CAFE\nTIN 123-456-789-000",
      merchantName: "JOLLI CAFE",
      candidates: [
        candidate({
          tin: "123-456-789-000",
          merchantAliases: ["JOLLI CAFE"],
        }),
      ],
      trigramSimilarity: fixedTrigram(1),
    });
    expect(result.confidence).toBe(0.98);
  });

  it("lets a TIN hit beat a weaker alias hit on another candidate", () => {
    const result = matchBusiness({
      rawText: "JOLLI CAFE\nTIN 999-888-777-000",
      merchantName: "JOLLI CAFE",
      candidates: [
        candidate({
          businessId: "biz-alias",
          merchantAliases: ["JOLLI CAFE"],
        }),
        candidate({
          businessId: "biz-tin",
          name: "Jolli Cafe Bonifacio",
          tin: "999-888-777-000",
        }),
      ],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-tin",
      confidence: 0.98,
      contradicted: false,
    });
  });
});

describe("matchBusiness - trigram prefilter boundary", () => {
  it("counts trigram evidence at exactly 0.4 similarity", () => {
    const result = matchBusiness({
      rawText: "JOLI CAFFE",
      merchantName: "JOLI CAFFE",
      candidates: [candidate()],
      trigramSimilarity: fixedTrigram(0.4),
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.36,
      contradicted: false,
    });
  });

  it("discards trigram evidence at 0.39 similarity", () => {
    const result = matchBusiness({
      rawText: "JOLI CAFFE",
      merchantName: "JOLI CAFFE",
      candidates: [candidate()],
      trigramSimilarity: fixedTrigram(0.39),
    });
    expect(result).toEqual({
      businessId: null,
      confidence: 0,
      contradicted: false,
    });
  });

  it("does not run the trigram comparison without an extracted merchant line", () => {
    const result = matchBusiness({
      rawText: "TOTAL 245.00",
      merchantName: null,
      candidates: [candidate()],
      trigramSimilarity: () => {
        throw new Error("trigramSimilarity must not be called");
      },
    });
    expect(result.businessId).toBeNull();
  });

  it("compares normalized forms, never the raw merchant line", () => {
    const seen: Array<[string, string]> = [];
    matchBusiness({
      rawText: "  Jolli   Cafe, Inc. ",
      merchantName: "  Jolli   Cafe, Inc. ",
      candidates: [candidate({ name: "Jolli Cafe" })],
      trigramSimilarity: (a, b) => {
        seen.push([a, b]);
        return 0.5;
      },
    });
    expect(seen).toEqual([["JOLLI CAFE INC", "JOLLI CAFE"]]);
  });
});

describe("matchBusiness - generic scan", () => {
  it("picks the highest scorer", () => {
    const result = matchBusiness({
      rawText: "JOLLI CAFE",
      merchantName: "JOLLI CAFE",
      candidates: [
        candidate({ businessId: "biz-weak", name: "Jolli Cafeteria" }),
        candidate({ businessId: "biz-strong", name: "Jolli Cafe" }),
      ],
      trigramSimilarity: (_a, b) => (b === "JOLLI CAFE" ? 0.9 : 0.5),
    });
    expect(result).toEqual({
      businessId: "biz-strong",
      confidence: 0.81,
      contradicted: false,
    });
  });

  it("counts the validated-template bonus when choosing the winner", () => {
    const result = matchBusiness({
      rawText: "JOLLI CAFE",
      merchantName: "JOLLI CAFE",
      candidates: [
        candidate({ businessId: "biz-plain", name: "Jolli Cafe A" }),
        candidate({
          businessId: "biz-template",
          name: "Jolli Cafe B",
          hasValidatedTemplateMatch: true,
        }),
      ],
      trigramSimilarity: (_a, b) => (b === "JOLLI CAFE A" ? 0.7 : 0.66),
    });
    // 0.9 x 0.66 = 0.594, +0.05 = 0.644 beats 0.9 x 0.7 = 0.63.
    expect(result).toEqual({
      businessId: "biz-template",
      confidence: 0.644,
      contradicted: false,
    });
  });
});

describe("matchBusiness - validated template bonus", () => {
  it("adds 0.05 to an alias hit", () => {
    const result = matchBusiness({
      rawText: "JOLLI CAFE",
      merchantName: "JOLLI CAFE",
      candidates: [
        candidate({
          merchantAliases: ["JOLLI CAFE"],
          hasValidatedTemplateMatch: true,
        }),
      ],
      trigramSimilarity: noTrigram,
    });
    expect(result.confidence).toBe(1);
  });

  it("caps at 1.0 rather than exceeding it", () => {
    const result = matchBusiness({
      rawText: "TIN 123-456-789-000",
      merchantName: null,
      candidates: [
        candidate({
          tin: "123-456-789-000",
          hasValidatedTemplateMatch: true,
        }),
      ],
      trigramSimilarity: noTrigram,
    });
    // 0.98 + 0.05 = 1.03 -> 1.0
    expect(result.confidence).toBe(1);
  });

  it("does not award the bonus when there is no match at all", () => {
    const result = matchBusiness({
      rawText: "TOTAL 245.00",
      merchantName: "UNKNOWN",
      candidates: [candidate({ hasValidatedTemplateMatch: true })],
      trigramSimilarity: fixedTrigram(0.1),
    });
    expect(result).toEqual({
      businessId: null,
      confidence: 0,
      contradicted: false,
    });
  });
});

describe("matchBusiness - pre-bound receipts are verified, never re-bound", () => {
  it("floors a pre-bound match at 0.85 when there is no other evidence", () => {
    const result = matchBusiness({
      rawText: "TOTAL 245.00",
      merchantName: null,
      preBoundBusinessId: "biz-a",
      candidates: [candidate()],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.85,
      contradicted: false,
    });
  });

  it("keeps the floor when the pre-bound business is not among the candidates", () => {
    const result = matchBusiness({
      rawText: "TOTAL 245.00",
      merchantName: null,
      preBoundBusinessId: "biz-ghost",
      candidates: [],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-ghost",
      confidence: 0.85,
      contradicted: false,
    });
  });

  it("keeps the floor when its own evidence is weaker than the floor", () => {
    const result = matchBusiness({
      rawText: "JOLI CAFFE",
      merchantName: "JOLI CAFFE",
      preBoundBusinessId: "biz-a",
      candidates: [candidate()],
      trigramSimilarity: fixedTrigram(0.5),
    });
    // 0.9 x 0.5 = 0.45, below the 0.85 floor.
    expect(result.confidence).toBe(0.85);
  });

  it("raises above the floor on its own strong evidence", () => {
    const result = matchBusiness({
      rawText: "TIN 123-456-789-000",
      merchantName: null,
      preBoundBusinessId: "biz-a",
      candidates: [candidate({ tin: "123-456-789-000" })],
      trigramSimilarity: noTrigram,
    });
    expect(result.confidence).toBe(0.98);
  });

  it("adds the validated-template bonus on top of the floor", () => {
    const result = matchBusiness({
      rawText: "TOTAL 245.00",
      merchantName: null,
      preBoundBusinessId: "biz-a",
      candidates: [candidate({ hasValidatedTemplateMatch: true })],
      trigramSimilarity: noTrigram,
    });
    expect(result.confidence).toBe(0.9);
  });

  it("flags contradiction and retains the pre-bound id when a TIN names another business", () => {
    const result = matchBusiness({
      rawText: "MERCURY DRUG\nTIN 999-888-777-000",
      merchantName: "MERCURY DRUG",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate(),
        candidate({
          businessId: "biz-other",
          name: "Mercury Drug",
          tin: "999-888-777-000",
        }),
      ],
      trigramSimilarity: noTrigram,
    });
    expect(result.businessId).toBe("biz-a");
    expect(result.contradicted).toBe(true);
    expect(result.confidence).toBeLessThan(MATCH_THRESHOLDS.review);
    expect(matchOutcome(result.confidence)).toBe("wrong_business");
  });

  it("flags contradiction when an alias names another business", () => {
    const result = matchBusiness({
      rawText: "MERCURY DRUG",
      merchantName: "MERCURY DRUG",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate(),
        candidate({
          businessId: "biz-other",
          name: "Mercury Drug",
          merchantAliases: ["MERCURY DRUG"],
        }),
      ],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0,
      contradicted: true,
    });
  });

  it("never returns a business id other than the pre-bound one", () => {
    const result = matchBusiness({
      rawText: "MERCURY DRUG\nTIN 999-888-777-000",
      merchantName: "MERCURY DRUG",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate({
          businessId: "biz-other",
          name: "Mercury Drug",
          tin: "999-888-777-000",
          hasValidatedTemplateMatch: true,
        }),
      ],
      trigramSimilarity: fixedTrigram(1),
    });
    expect(result.businessId).toBe("biz-a");
    expect(result.contradicted).toBe(true);
  });

  it("treats absence of evidence as no contradiction", () => {
    const result = matchBusiness({
      rawText: "TOTAL 245.00",
      merchantName: "SOMETHING ELSE",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate(),
        candidate({ businessId: "biz-other", name: "Mercury Drug" }),
      ],
      trigramSimilarity: fixedTrigram(0.2),
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.85,
      contradicted: false,
    });
  });

  it("treats a strong trigram hit on another business as weak evidence, not contradiction", () => {
    const result = matchBusiness({
      rawText: "MERCURY DRUG",
      merchantName: "MERCURY DRUG",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate(),
        candidate({ businessId: "biz-other", name: "Mercury Drug" }),
      ],
      trigramSimilarity: (_a, b) => (b === "MERCURY DRUG" ? 1 : 0),
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.85,
      contradicted: false,
    });
  });

  it("does not contradict when the pre-bound business has strong evidence of its own", () => {
    const result = matchBusiness({
      rawText: "JOLLI CAFE\nTIN 123-456-789-000\nDELIVERED BY MERCURY DRUG",
      merchantName: "JOLLI CAFE",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate({
          tin: "123-456-789-000",
          merchantAliases: ["JOLLI CAFE"],
        }),
        candidate({
          businessId: "biz-other",
          name: "Mercury Drug",
          tin: "999-888-777-000",
        }),
      ],
      trigramSimilarity: noTrigram,
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.98,
      contradicted: false,
    });
  });

  it("honours an injected accept threshold when judging contradiction", () => {
    // Accept raised above 0.98: no evidence is strong enough to contradict.
    const thresholds: MatchThresholds = { accept: 0.99, review: 0.5 };
    const result = matchBusiness({
      rawText: "MERCURY DRUG\nTIN 999-888-777-000",
      merchantName: "MERCURY DRUG",
      preBoundBusinessId: "biz-a",
      candidates: [
        candidate(),
        candidate({
          businessId: "biz-other",
          name: "Mercury Drug",
          tin: "999-888-777-000",
        }),
      ],
      trigramSimilarity: noTrigram,
      thresholds,
    });
    expect(result).toEqual({
      businessId: "biz-a",
      confidence: 0.85,
      contradicted: false,
    });
  });
});

describe("matchOutcome", () => {
  it("exposes the doc 36 Stage 5 defaults", () => {
    expect(MATCH_THRESHOLDS).toEqual({ accept: 0.85, review: 0.5 });
  });

  it("accepts at and above 0.85", () => {
    expect(matchOutcome(0.85)).toBe("accept");
    expect(matchOutcome(1)).toBe("accept");
  });

  it("reviews from 0.5 up to but not including 0.85", () => {
    expect(matchOutcome(0.5)).toBe("review");
    expect(matchOutcome(0.849)).toBe("review");
  });

  it("routes below 0.5 to wrong_business", () => {
    expect(matchOutcome(0.499)).toBe("wrong_business");
    expect(matchOutcome(0)).toBe("wrong_business");
  });

  it("honours injected thresholds", () => {
    const thresholds: MatchThresholds = { accept: 0.9, review: 0.6 };
    expect(matchOutcome(0.85, thresholds)).toBe("review");
    expect(matchOutcome(0.9, thresholds)).toBe("accept");
    expect(matchOutcome(0.59, thresholds)).toBe("wrong_business");
  });
});
