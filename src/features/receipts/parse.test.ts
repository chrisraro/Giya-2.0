import { describe, it, expect } from "vitest";

import {
  RECEIPT_TIMEZONE,
  extractAmounts,
  extractDate,
  extractLineItems,
  extractMerchantName,
  extractReceiptNumber,
  parseCentavos,
  parseReceipt,
} from "./parse";
import type { OcrBlock, ParseConfig, ParseInput } from "./parse";

// Realistic PH receipt fixtures. These are the whole point of this suite: the
// stub OCR provider (spec section 2) must never be the only thing the parser
// has ever seen, or swapping in PaddleOCR would exercise untested code.

// A Jollibee-style thermal POS slip: VAT block, right-aligned money column,
// MM/dd/yyyy plus an adjoining HH:mm token, OR number with leading zeros.
const POS_RECEIPT = [
  "JOLLI CAFE",
  "SM CITY CEBU BRANCH",
  "TIN 123-456-789-000",
  "OR# 0012345",
  "07/24/2026 13:42",
  "",
  "2 CHICKENJOY 1PC      82.00    164.00",
  "1 JOLLY SPAGHETTI     59.00     59.00",
  "1 REG FRIES           45.00     45.00",
  "",
  "VATable Sales                  239.29",
  "VAT (12%)                       28.71",
  "TOTAL                          268.00",
  "CASH                           300.00",
  "CHANGE                          32.00",
  "",
  "THIS SERVES AS AN OFFICIAL RECEIPT",
].join("\n");

const POS_CONFIG: ParseConfig = {
  merchant_aliases: ["JOLLI CAFE", "JOLLI CAFE CORP", "JOLLICAFE"],
  tin: "123-456-789-000",
  receipt_no_regex: "(?:SI|OR|INV)[#:\\s-]*([0-9]{4,12})",
  date_formats: ["MM/dd/yyyy", "MM-dd-yy", "MMM dd, yyyy"],
  total_keywords: ["TOTAL", "AMOUNT DUE", "TOTAL DUE"],
  subtotal_keywords: ["SUBTOTAL", "VATable Sales"],
  tax_keywords: ["VAT", "12% VAT", "VAT Amount"],
  layout_anchors: {
    header: { y: [0.0, 0.15] },
    line_items: { y: [0.25, 0.7] },
    totals: { y: [0.7, 0.92], align: "right" },
    footer_keywords: ["THIS SERVES AS", "OFFICIAL RECEIPT"],
  },
  line_item_pattern:
    "^(?<qty>\\d+)\\s+(?<name>.+?)\\s+(?<amount>[\\d,]+\\.\\d{2})$",
  amount_sanity: { min_total_centavos: 1000, max_total_centavos: 2000000 },
};

// A handwritten carinderia order pad: no VAT, whole-peso amounts with no
// decimal point at all, pre-printed pad number, M/d/yy date.
const PAD_RECEIPT = [
  "ALING NENA'S EATERY",
  "Poblacion, Dumaguete City",
  "",
  "No. 04821          7/24/26",
  "",
  "2  Sinigang na Baboy      280",
  "1  Rice                    30",
  "3  Softdrinks              45",
  "",
  "TOTAL                     355",
  "Salamat po!",
].join("\n");

const PAD_CONFIG: ParseConfig = {
  merchant_aliases: ["ALING NENA'S", "ALING NENAS EATERY"],
  receipt_no_regex: "No[.:\\s]*([0-9]{3,6})",
  date_formats: ["M/d/yy", "M-d-yyyy"],
  total_keywords: ["TOTAL", "TTL"],
  tax_keywords: [],
  layout_anchors: { totals: { y: [0.6, 1.0] } },
  handwriting: { min_block_conf: 0.35, digits_only_amounts: true },
  amount_sanity: { min_total_centavos: 2000, max_total_centavos: 500000 },
};

// A faded thermal slip: the merchant line and the total survived, the date and
// the receipt number did not. This is the common real-world degradation.
const FADED_RECEIPT = [
  "M4NANG R05A CAR1NDER1A",
  "Purok 3, Bacolod City",
  "",
  "0R No ....",
  ".. / .. / ....",
  "",
  "Pancit          85.00",
  "?????           ??.??",
  "",
  "TOTAL          185.00",
].join("\n");

// Nothing survived. Every extractor must return null and none may throw.
const GARBLED_RECEIPT = ["~~~~~~~~", "### ??? ###", ".  .  .", "|||"].join("\n");

// 05/06/2026 reads as May 6 (MM/dd) or June 5 (dd/MM); both are real dates.
const AMBIGUOUS_RECEIPT = [
  "BOTIKA NG BAYAN",
  "Rizal Ave, Iloilo City",
  "OR# 000912",
  "05/06/2026",
  "TOTAL   P1,245.00",
].join("\n");

const input = (overrides: Partial<ParseInput> = {}): ParseInput => ({
  rawText: POS_RECEIPT,
  ...overrides,
});

// Manila is UTC+8 with no DST, so a wall-clock time maps to exactly one UTC
// instant and the expectations below can be written literally.
const manilaInstant = (iso: string): Date => new Date(iso);

describe("parseCentavos", () => {
  it("converts the doc 36 canonical token 1,245.00 to 124500 centavos", () => {
    expect(parseCentavos("1,245.00")).toBe(124500);
  });

  it("handles peso prefixes", () => {
    expect(parseCentavos("P268.00")).toBe(26800);
    expect(parseCentavos("PHP 1,245.00")).toBe(124500);
    expect(parseCentavos("₱268.00")).toBe(26800);
    expect(parseCentavos("₱ 1,000,000.00")).toBe(100000000);
  });

  it("ignores trailing junk such as PH VAT class letters", () => {
    expect(parseCentavos("268.00T")).toBe(26800);
    expect(parseCentavos("  45.00  ")).toBe(4500);
  });

  it("treats a bare integer as whole pesos", () => {
    expect(parseCentavos("355")).toBe(35500);
    expect(parseCentavos("30")).toBe(3000);
  });

  it("pads a single-digit fraction rather than mis-scaling it", () => {
    expect(parseCentavos("12.5")).toBe(1250);
  });

  it("never introduces float drift on the classic binary-repr offenders", () => {
    // 0.1 + 0.2 style breakage: 1145.30 * 100 is 114529.99999999999 in IEEE754.
    expect(parseCentavos("1,145.30")).toBe(114530);
    expect(parseCentavos("8.29")).toBe(829);
    expect(parseCentavos("1.10")).toBe(110);
    expect(Number.isInteger(parseCentavos("1,145.30"))).toBe(true);
  });

  it("returns null for non-money text", () => {
    expect(parseCentavos("TOTAL")).toBeNull();
    expect(parseCentavos("")).toBeNull();
    expect(parseCentavos("....")).toBeNull();
  });

  it("does not read a percentage as money", () => {
    expect(parseCentavos("12%")).toBeNull();
  });

  it("does not read a TIN run as money", () => {
    expect(parseCentavos("123-456-789-000")).toBeNull();
  });
});

describe("extractMerchantName", () => {
  it("matches a template alias and returns the raw header line", () => {
    expect(extractMerchantName(input({ config: POS_CONFIG }))).toBe("JOLLI CAFE");
  });

  it("matches an alias that differs only by punctuation and casing", () => {
    expect(
      extractMerchantName({ rawText: PAD_RECEIPT, config: PAD_CONFIG }),
    ).toBe("ALING NENA'S EATERY");
  });

  it("falls back to the first meaningful header line with no template", () => {
    expect(extractMerchantName(input())).toBe("JOLLI CAFE");
  });

  it("skips leading noise lines that carry no letters", () => {
    expect(
      extractMerchantName({ rawText: "*** ###\n---\nMANG INASAL\nTIN 001" }),
    ).toBe("MANG INASAL");
  });

  it("skips BIR metadata lines when hunting for the merchant", () => {
    expect(
      extractMerchantName({ rawText: "TIN 123-456-789-000\nVAT REG TIN\nTOKYO TOKYO" }),
    ).toBe("TOKYO TOKYO");
  });

  it("collapses OCR whitespace noise in the returned name", () => {
    expect(extractMerchantName({ rawText: "  GOLDILOCKS   BAKESHOP  \nTIN 1" })).toBe(
      "GOLDILOCKS BAKESHOP",
    );
  });

  it("still finds a partly garbled merchant line", () => {
    expect(extractMerchantName({ rawText: FADED_RECEIPT })).toBe(
      "M4NANG R05A CAR1NDER1A",
    );
  });

  it("returns null when no line looks like a name", () => {
    expect(extractMerchantName({ rawText: GARBLED_RECEIPT })).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractMerchantName({ rawText: "" })).toBeNull();
  });
});

describe("extractReceiptNumber", () => {
  it("prefers the template receipt_no_regex and keeps its capture group", () => {
    expect(extractReceiptNumber(input({ config: POS_CONFIG }))).toBe("0012345");
  });

  it("preserves leading zeros from a handwritten pad number", () => {
    // The value participates in receipts_number_unique; "04821" and "4821"
    // must not collapse to the same key.
    expect(
      extractReceiptNumber({ rawText: PAD_RECEIPT, config: PAD_CONFIG }),
    ).toBe("04821");
  });

  it("falls back to the generic PH pattern with the significant prefix kept", () => {
    expect(extractReceiptNumber({ rawText: POS_RECEIPT })).toBe("OR0012345");
  });

  it("recognises each generic prefix", () => {
    expect(extractReceiptNumber({ rawText: "SI 000123" })).toBe("SI000123");
    expect(extractReceiptNumber({ rawText: "INV: 0004567" })).toBe("INV0004567");
    expect(extractReceiptNumber({ rawText: "RECEIPT NO. 8891" })).toBe("RECEIPT8891");
    expect(extractReceiptNumber({ rawText: "TRANS: 010203" })).toBe("TRANS010203");
  });

  it("normalizes separators and case but never digits", () => {
    expect(extractReceiptNumber({ rawText: "or # 000912" })).toBe("OR000912");
    expect(extractReceiptNumber({ rawText: "OR.000912" })).toBe("OR000912");
  });

  it("ignores runs shorter than three digits", () => {
    expect(extractReceiptNumber({ rawText: "OR# 12" })).toBeNull();
  });

  it("falls back to the generic pattern when the template regex misses", () => {
    expect(
      extractReceiptNumber({
        rawText: "OR# 0012345",
        config: { receipt_no_regex: "PAD[.:\\s]*([0-9]{3,6})" },
      }),
    ).toBe("OR0012345");
  });

  it("falls back to the generic pattern when the template regex is invalid", () => {
    expect(
      extractReceiptNumber({
        rawText: "OR# 0012345",
        config: { receipt_no_regex: "([0-9]{3," },
      }),
    ).toBe("OR0012345");
  });

  it("refuses a template regex with a nested quantifier (ReDoS guard)", () => {
    // (a+)+ style patterns are the classic catastrophic-backtracking shape.
    expect(
      extractReceiptNumber({
        rawText: "OR# 0012345",
        config: { receipt_no_regex: "(\\d+)+$" },
      }),
    ).toBe("OR0012345");
  });

  it("refuses an over-long template regex (ReDoS guard)", () => {
    expect(
      extractReceiptNumber({
        rawText: "OR# 0012345",
        config: { receipt_no_regex: `(?:${"a|".repeat(150)}b)([0-9]{3,6})` },
      }),
    ).toBe("OR0012345");
  });

  it("returns null when nothing resembles a receipt number", () => {
    expect(extractReceiptNumber({ rawText: GARBLED_RECEIPT })).toBeNull();
    expect(extractReceiptNumber({ rawText: FADED_RECEIPT })).toBeNull();
    expect(extractReceiptNumber({ rawText: "" })).toBeNull();
  });
});

describe("extractDate", () => {
  it("reads MM/dd/yyyy with an adjoining HH:mm and returns the UTC instant", () => {
    // 2026-07-24 13:42 Asia/Manila (UTC+8) = 2026-07-24T05:42:00Z
    const hit = extractDate(input({ config: POS_CONFIG }));
    expect(hit).not.toBeNull();
    expect(hit?.date.toISOString()).toBe("2026-07-24T05:42:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("assumes 12:00 Manila when no time token adjoins", () => {
    // 2026-07-24 12:00 Manila = 2026-07-24T04:00:00Z
    const hit = extractDate({ rawText: "SUKI MART\n07/24/2026\nTOTAL 100.00" });
    expect(hit?.date.toISOString()).toBe("2026-07-24T04:00:00.000Z");
  });

  it("picks up a time token on the line immediately after the date", () => {
    const hit = extractDate({ rawText: "07/24/2026\n09:05\nTOTAL 100.00" });
    expect(hit?.date.toISOString()).toBe("2026-07-24T01:05:00.000Z");
  });

  it("understands 12-hour clock tokens with a meridiem", () => {
    expect(
      extractDate({ rawText: "07/24/2026 07:30 PM" })?.date.toISOString(),
    ).toBe("2026-07-24T11:30:00.000Z");
    expect(
      extractDate({ rawText: "07/24/2026 12:15 AM" })?.date.toISOString(),
    ).toBe("2026-07-23T16:15:00.000Z");
  });

  it("accepts the two-digit-year PH convention", () => {
    expect(extractDate({ rawText: "07/24/26" })?.date.toISOString()).toBe(
      "2026-07-24T04:00:00.000Z",
    );
  });

  it("accepts dash and dot separators for the same format", () => {
    expect(extractDate({ rawText: "07-24-2026" })?.date.toISOString()).toBe(
      "2026-07-24T04:00:00.000Z",
    );
    expect(extractDate({ rawText: "07.24.2026" })?.date.toISOString()).toBe(
      "2026-07-24T04:00:00.000Z",
    );
  });

  it("accepts MMM dd, yyyy", () => {
    expect(extractDate({ rawText: "JUL 24, 2026" })?.date.toISOString()).toBe(
      "2026-07-24T04:00:00.000Z",
    );
    expect(extractDate({ rawText: "Mar 03, 2026" })?.date.toISOString()).toBe(
      "2026-03-03T04:00:00.000Z",
    );
  });

  it("accepts ISO yyyy-MM-dd without treating it as day-first", () => {
    const hit = extractDate({ rawText: "2026-05-06" });
    expect(hit?.date.toISOString()).toBe("2026-05-06T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("uses dd/MM/yyyy only when the day slot disambiguates", () => {
    // 13 cannot be a month, so this is 13 May, unambiguously.
    const hit = extractDate({ rawText: "13/05/2026" });
    expect(hit?.date.toISOString()).toBe("2026-05-13T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("uses MM/dd/yyyy when the second slot disambiguates", () => {
    const hit = extractDate({ rawText: "05/13/2026" });
    expect(hit?.date.toISOString()).toBe("2026-05-13T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("flags a two-way date and takes the older reading (05/06/2026)", () => {
    // MM/dd = 6 May, dd/MM = 5 June. Older wins: 6 May.
    const hit = extractDate({ rawText: AMBIGUOUS_RECEIPT });
    expect(hit?.date.toISOString()).toBe("2026-05-06T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(true);
  });

  it("takes the older reading even when it is the dd/MM one (06/05/2026)", () => {
    // MM/dd = 5 June, dd/MM = 6 May. Older wins: 6 May.
    const hit = extractDate({ rawText: "06/05/2026" });
    expect(hit?.date.toISOString()).toBe("2026-05-06T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(true);
  });

  it("is unambiguous when both readings land on the same day", () => {
    const hit = extractDate({ rawText: "05/05/2026" });
    expect(hit?.date.toISOString()).toBe("2026-05-05T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("treats a template-declared format as authoritative, never ambiguous", () => {
    // The business told us its POS prints MM/dd/yyyy, so 05/06 is 6 May and
    // there is nothing to review.
    const hit = extractDate({
      rawText: "05/06/2026",
      config: { date_formats: ["MM/dd/yyyy"] },
    });
    expect(hit?.date.toISOString()).toBe("2026-05-06T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("honours a template format the defaults would never try (d/M/yyyy)", () => {
    const hit = extractDate({
      rawText: "06/05/2026",
      config: { date_formats: ["d/M/yyyy"] },
    });
    expect(hit?.date.toISOString()).toBe("2026-05-06T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("honours the handwritten pad's M/d/yy template format", () => {
    const hit = extractDate({ rawText: PAD_RECEIPT, config: PAD_CONFIG });
    expect(hit?.date.toISOString()).toBe("2026-07-24T04:00:00.000Z");
    expect(hit?.ambiguous).toBe(false);
  });

  it("falls back to the defaults when the template formats all miss", () => {
    const hit = extractDate({
      rawText: "07/24/2026",
      config: { date_formats: ["MMM dd, yyyy"] },
    });
    expect(hit?.date.toISOString()).toBe("2026-07-24T04:00:00.000Z");
  });

  it("rejects impossible calendar dates rather than clamping them", () => {
    expect(extractDate({ rawText: "31/02/2026" })).toBeNull();
    expect(extractDate({ rawText: "13/13/2026" })).toBeNull();
    expect(extractDate({ rawText: "00/00/2026" })).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(extractDate({ rawText: "02/29/2024" })?.date.toISOString()).toBe(
      "2024-02-29T04:00:00.000Z",
    );
    expect(extractDate({ rawText: "02/29/2026" })).toBeNull();
  });

  it("does not mistake a TIN or a serial number for a date", () => {
    expect(extractDate({ rawText: "TIN 123-456-789-000\nMIN 20081226123456789" })).toBeNull();
  });

  it("returns null on unreadable and empty input", () => {
    expect(extractDate({ rawText: FADED_RECEIPT })).toBeNull();
    expect(extractDate({ rawText: GARBLED_RECEIPT })).toBeNull();
    expect(extractDate({ rawText: "" })).toBeNull();
  });

  it("resolves against an injected timezone when one is supplied", () => {
    expect(RECEIPT_TIMEZONE).toBe("Asia/Manila");
    expect(
      extractDate({ rawText: "07/24/2026", timeZone: "UTC" })?.date.toISOString(),
    ).toBe("2026-07-24T12:00:00.000Z");
  });
});

describe("extractAmounts", () => {
  it("reads the VAT block off a POS slip and passes the 12% sanity check", () => {
    expect(extractAmounts(input({ config: POS_CONFIG }))).toEqual({
      subtotalCentavos: 23929,
      taxCentavos: 2871,
      totalCentavos: 26800,
      vatConsistent: true,
    });
  });

  it("reads the same slip with generic heuristics and no template", () => {
    expect(extractAmounts(input())).toEqual({
      subtotalCentavos: 23929,
      taxCentavos: 2871,
      totalCentavos: 26800,
      vatConsistent: true,
    });
  });

  it("keeps thousands separators out of the centavos value", () => {
    expect(extractAmounts({ rawText: "TOTAL 1,245.00" }).totalCentavos).toBe(124500);
    expect(extractAmounts({ rawText: "TOTAL 12,345.67" }).totalCentavos).toBe(1234567);
  });

  it("returns integer centavos for every field", () => {
    const amounts = extractAmounts(input({ config: POS_CONFIG }));
    for (const value of [
      amounts.subtotalCentavos,
      amounts.taxCentavos,
      amounts.totalCentavos,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("does not read the 12 in a VAT label as an amount", () => {
    expect(extractAmounts({ rawText: "VAT (12%) 28.71\nTOTAL 268.00" }).taxCentavos).toBe(
      2871,
    );
  });

  it("classifies VATable Sales as subtotal, not as tax", () => {
    const amounts = extractAmounts({
      rawText: "VATable Sales 239.29\nVAT Amount 28.71\nTOTAL 268.00",
    });
    expect(amounts.subtotalCentavos).toBe(23929);
    expect(amounts.taxCentavos).toBe(2871);
  });

  it("classifies SUBTOTAL as subtotal even though it contains TOTAL", () => {
    const amounts = extractAmounts({ rawText: "SUBTOTAL 239.29\nTOTAL 268.00" });
    expect(amounts.subtotalCentavos).toBe(23929);
    expect(amounts.totalCentavos).toBe(26800);
  });

  it("ignores counting lines that merely contain the word TOTAL", () => {
    const amounts = extractAmounts({ rawText: "TOTAL ITEMS 3\nTOTAL 268.00" });
    expect(amounts.totalCentavos).toBe(26800);
  });

  it("ignores VAT EXEMPT and ZERO RATED lines when reading tax", () => {
    const amounts = extractAmounts({
      rawText: "VAT EXEMPT SALES 0.00\nZERO RATED SALES 0.00\nVAT AMOUNT 28.71\nTOTAL 268.00",
    });
    expect(amounts.taxCentavos).toBe(2871);
  });

  it("does not treat CASH or CHANGE as the total", () => {
    const amounts = extractAmounts({ rawText: "TOTAL 268.00\nCASH 500.00\nCHANGE 232.00" });
    expect(amounts.totalCentavos).toBe(26800);
  });

  it("prefers the highest-priority total keyword", () => {
    const amounts = extractAmounts({
      rawText: "TOTAL 500.00\nDISCOUNT 50.00\nAMOUNT DUE 450.00",
    });
    expect(amounts.totalCentavos).toBe(45000);
  });

  it("honours template total_keywords priority order over the generic order", () => {
    const amounts = extractAmounts({
      rawText: "AMOUNT DUE 450.00\nTOTAL 500.00",
      config: { total_keywords: ["TOTAL", "AMOUNT DUE"] },
    });
    expect(amounts.totalCentavos).toBe(50000);
  });

  it("takes the last money token on a totals line (right-aligned column)", () => {
    expect(extractAmounts({ rawText: "TOTAL 3 268.00" }).totalCentavos).toBe(26800);
  });

  it("falls back to the largest amount near the foot when no keyword matched", () => {
    const amounts = extractAmounts({
      rawText: ["SARI SARI STORE", "Item A 20.00", "Item B 35.00", "55.00"].join("\n"),
    });
    expect(amounts.totalCentavos).toBe(5500);
  });

  it("reads whole-peso handwritten amounts when digits_only_amounts is set", () => {
    expect(
      extractAmounts({ rawText: PAD_RECEIPT, config: PAD_CONFIG }).totalCentavos,
    ).toBe(35500);
  });

  it("skips the VAT check entirely for a non-VAT template", () => {
    const amounts = extractAmounts({ rawText: PAD_RECEIPT, config: PAD_CONFIG });
    expect(amounts.taxCentavos).toBeNull();
    expect(amounts.vatConsistent).toBe(false);
    expect(amounts.totalCentavos).toBe(35500);
  });

  it("does not null a subtotal on a non-VAT template", () => {
    const amounts = extractAmounts({
      rawText: "SUBTOTAL 300.00\nTOTAL 355.00",
      config: { tax_keywords: [] },
    });
    expect(amounts.subtotalCentavos).toBe(30000);
    expect(amounts.taxCentavos).toBeNull();
    expect(amounts.vatConsistent).toBe(false);
  });

  it("passes the VAT check inside the 5-centavo absolute tolerance", () => {
    // Exact 12/112 of 26800 is 2871.43; 2871 is 0.43 centavos off.
    const amounts = extractAmounts({
      rawText: "VATable Sales 239.29\nVAT 28.71\nTOTAL 268.00",
    });
    expect(amounts.vatConsistent).toBe(true);
  });

  it("passes the VAT check inside the 0.5 percent relative tolerance", () => {
    // total 1,000,000.00 -> expected VAT 107,142.86; 107,150.00 is 7.14 pesos
    // off, well inside 0.5 percent (535.71) but far outside 5 centavos.
    const amounts = extractAmounts({
      rawText: "VATable Sales 892850.00\nVAT 107150.00\nTOTAL 1000000.00",
    });
    expect(amounts.vatConsistent).toBe(true);
  });

  it("keeps the total and nulls the subtotal when only the sum check fails", () => {
    // Ratio holds (28.71 of 268.00) but 218.00 + 28.71 is not 268.00.
    const amounts = extractAmounts({
      rawText: "VATable Sales 218.00\nVAT 28.71\nTOTAL 268.00",
    });
    expect(amounts.totalCentavos).toBe(26800);
    expect(amounts.taxCentavos).toBe(2871);
    expect(amounts.subtotalCentavos).toBeNull();
    expect(amounts.vatConsistent).toBe(false);
  });

  it("keeps the total and nulls the tax when the 12 percent ratio fails", () => {
    const amounts = extractAmounts({
      rawText: "VATable Sales 239.29\nVAT 12.00\nTOTAL 268.00",
    });
    expect(amounts.totalCentavos).toBe(26800);
    expect(amounts.taxCentavos).toBeNull();
    expect(amounts.subtotalCentavos).toBe(23929);
    expect(amounts.vatConsistent).toBe(false);
  });

  it("nulls both sub-fields when neither corroborates the total", () => {
    const amounts = extractAmounts({
      rawText: "VATable Sales 100.00\nVAT 5.00\nTOTAL 268.00",
    });
    expect(amounts.totalCentavos).toBe(26800);
    expect(amounts.taxCentavos).toBeNull();
    expect(amounts.subtotalCentavos).toBeNull();
    expect(amounts.vatConsistent).toBe(false);
  });

  it("never guesses a missing sub-field from the total", () => {
    const amounts = extractAmounts({ rawText: "TOTAL 268.00" });
    expect(amounts.totalCentavos).toBe(26800);
    expect(amounts.subtotalCentavos).toBeNull();
    expect(amounts.taxCentavos).toBeNull();
    expect(amounts.vatConsistent).toBe(false);
  });

  it("checks the ratio alone when the subtotal is missing", () => {
    const amounts = extractAmounts({ rawText: "VAT 28.71\nTOTAL 268.00" });
    expect(amounts.taxCentavos).toBe(2871);
    expect(amounts.vatConsistent).toBe(true);
  });

  it("nulls a lone tax that fails the ratio", () => {
    const amounts = extractAmounts({ rawText: "VAT 99.00\nTOTAL 268.00" });
    expect(amounts.taxCentavos).toBeNull();
    expect(amounts.totalCentavos).toBe(26800);
    expect(amounts.vatConsistent).toBe(false);
  });

  it("cannot run the check without a total, and nulls nothing", () => {
    const amounts = extractAmounts({ rawText: "VATable Sales 239.29\nVAT 28.71" });
    expect(amounts.totalCentavos).toBeNull();
    expect(amounts.subtotalCentavos).toBe(23929);
    expect(amounts.taxCentavos).toBe(2871);
    expect(amounts.vatConsistent).toBe(false);
  });

  it("reads what survives on a faded slip", () => {
    const amounts = extractAmounts({ rawText: FADED_RECEIPT });
    expect(amounts.totalCentavos).toBe(18500);
    expect(amounts.taxCentavos).toBeNull();
  });

  it("returns all nulls for garbled and empty input", () => {
    expect(extractAmounts({ rawText: GARBLED_RECEIPT })).toEqual({
      subtotalCentavos: null,
      taxCentavos: null,
      totalCentavos: null,
      vatConsistent: false,
    });
    expect(extractAmounts({ rawText: "" }).totalCentavos).toBeNull();
  });
});

describe("extractLineItems", () => {
  it("splits a POS slip into qty / name / unit price / line total", () => {
    expect(extractLineItems(input())).toEqual([
      {
        rawText: "2 CHICKENJOY 1PC      82.00    164.00",
        qty: 2,
        unitPriceCentavos: 8200,
        lineTotalCentavos: 16400,
        sort: 0,
      },
      {
        rawText: "1 JOLLY SPAGHETTI     59.00     59.00",
        qty: 1,
        unitPriceCentavos: 5900,
        lineTotalCentavos: 5900,
        sort: 1,
      },
      {
        rawText: "1 REG FRIES           45.00     45.00",
        qty: 1,
        unitPriceCentavos: 4500,
        lineTotalCentavos: 4500,
        sort: 2,
      },
    ]);
  });

  it("does not read the 1 in CHICKENJOY 1PC as money", () => {
    const items = extractLineItems(input());
    expect(items[0]?.lineTotalCentavos).toBe(16400);
  });

  it("uses the template line_item_pattern named groups when supplied", () => {
    const items = extractLineItems({
      rawText: "3 PANCIT CANTON 1,245.00",
      config: {
        line_item_pattern:
          "^(?<qty>\\d+)\\s+(?<name>.+?)\\s+(?<amount>[\\d,]+\\.\\d{2})$",
      },
    });
    expect(items).toEqual([
      {
        rawText: "3 PANCIT CANTON 1,245.00",
        qty: 3,
        unitPriceCentavos: 41500,
        lineTotalCentavos: 124500,
        sort: 0,
      },
    ]);
  });

  it("leaves unit price null when the line total does not divide evenly", () => {
    const items = extractLineItems({ rawText: "3 SIOMAI 100.00" });
    expect(items[0]?.qty).toBe(3);
    expect(items[0]?.lineTotalCentavos).toBe(10000);
    expect(items[0]?.unitPriceCentavos).toBeNull();
  });

  it("handles a line with no quantity column", () => {
    const items = extractLineItems({ rawText: "HALO HALO SPECIAL     120.00" });
    expect(items).toEqual([
      {
        rawText: "HALO HALO SPECIAL     120.00",
        qty: null,
        unitPriceCentavos: null,
        lineTotalCentavos: 12000,
        sort: 0,
      },
    ]);
  });

  it("reads a qty x unit form", () => {
    const items = extractLineItems({ rawText: "2 x COKE MISMO   35.00   70.00" });
    expect(items[0]?.qty).toBe(2);
    expect(items[0]?.unitPriceCentavos).toBe(3500);
    expect(items[0]?.lineTotalCentavos).toBe(7000);
  });

  it("splits handwritten whole-peso pad lines", () => {
    const items = extractLineItems({ rawText: PAD_RECEIPT, config: PAD_CONFIG });
    expect(items).toEqual([
      {
        rawText: "2  Sinigang na Baboy      280",
        qty: 2,
        unitPriceCentavos: 14000,
        lineTotalCentavos: 28000,
        sort: 0,
      },
      {
        rawText: "1  Rice                    30",
        qty: 1,
        unitPriceCentavos: 3000,
        lineTotalCentavos: 3000,
        sort: 1,
      },
      {
        rawText: "3  Softdrinks              45",
        qty: 3,
        unitPriceCentavos: 1500,
        lineTotalCentavos: 4500,
        sort: 2,
      },
    ]);
  });

  it("numbers sort contiguously from zero", () => {
    const items = extractLineItems(input());
    expect(items.map((item) => item.sort)).toEqual([0, 1, 2]);
  });

  it("never emits totals, tax, payment or metadata lines as items", () => {
    const raw = extractLineItems(input()).map((item) => item.rawText).join(" ");
    for (const banned of ["TOTAL", "VAT", "CASH", "CHANGE", "TIN", "OFFICIAL RECEIPT"]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("never emits the date or receipt-number line as an item", () => {
    const items = extractLineItems({ rawText: PAD_RECEIPT, config: PAD_CONFIG });
    expect(items.map((item) => item.rawText)).not.toContain(
      "No. 04821          7/24/26",
    );
  });

  it("falls back to the generic split when the template pattern is unusable", () => {
    const items = extractLineItems({
      rawText: "2 CHICKENJOY 1PC      82.00    164.00",
      config: { line_item_pattern: "^(\\d+)+(.*)$" },
    });
    expect(items[0]?.qty).toBe(2);
    expect(items[0]?.lineTotalCentavos).toBe(16400);
  });

  it("returns an empty list for garbled and empty input", () => {
    expect(extractLineItems({ rawText: GARBLED_RECEIPT })).toEqual([]);
    expect(extractLineItems({ rawText: "" })).toEqual([]);
  });
});

describe("bbox-aware extraction", () => {
  // One block per OCR line, as PaddleOCR returns them (doc 36 Stage 4).
  // The page is 930px tall, so the template's normalized y ranges resolve to:
  // header 0-139, line_items 232-651, totals 651-855.
  const blocks: OcrBlock[] = [
    { text: "TOTAL DUE 1.00 OFF ANY MEAL", bbox: [30, 70, 320, 100], conf: 0.9 },
    { text: "JOLLI CAFE", bbox: [40, 20, 300, 60], conf: 0.98 },
    { text: "2 CHICKENJOY 1PC 82.00 164.00", bbox: [30, 300, 320, 330], conf: 0.95 },
    { text: "VATable Sales 239.29", bbox: [30, 760, 320, 790], conf: 0.94 },
    { text: "VAT (12%) 28.71", bbox: [30, 800, 320, 830], conf: 0.93 },
    { text: "TOTAL 268.00", bbox: [30, 840, 320, 870], conf: 0.97 },
    { text: "THIS SERVES AS AN OFFICIAL RECEIPT", bbox: [30, 900, 320, 930], conf: 0.9 },
  ];
  const rawText = blocks.map((block) => block.text).join("\n");

  it("seeks totals inside the totals region and ignores a header decoy", () => {
    // Text-only, the header promo wins on keyword priority (TOTAL DUE beats
    // TOTAL); with the layout anchors it is outside the totals band.
    expect(extractAmounts({ rawText }).totalCentavos).toBe(100);
    expect(
      extractAmounts({ rawText, blocks, config: POS_CONFIG }).totalCentavos,
    ).toBe(26800);
  });

  it("still reads the VAT block from the totals region", () => {
    expect(extractAmounts({ rawText, blocks, config: POS_CONFIG })).toEqual({
      subtotalCentavos: 23929,
      taxCentavos: 2871,
      totalCentavos: 26800,
      vatConsistent: true,
    });
  });

  it("reads the header region top-down, not in block array order", () => {
    // The decoy is listed first in `blocks` but sits lower on the page.
    expect(
      extractMerchantName({
        rawText,
        blocks,
        config: { layout_anchors: { header: { y: [0.0, 0.15] } } },
      }),
    ).toBe("JOLLI CAFE");
  });

  it("honours the header band boundaries", () => {
    // Narrowing the band past JOLLI CAFE's centre leaves only the decoy,
    // proving the band is really filtering rather than the order carrying it.
    expect(
      extractMerchantName({
        rawText,
        blocks,
        config: { layout_anchors: { header: { y: [0.06, 0.15] } } },
      }),
    ).toBe("TOTAL DUE 1.00 OFF ANY MEAL");
  });

  it("takes line items from the line_items region only", () => {
    const items = extractLineItems({ rawText, blocks, config: POS_CONFIG });
    expect(items).toHaveLength(1);
    expect(items[0]?.rawText).toBe("2 CHICKENJOY 1PC 82.00 164.00");
  });

  it("drops blocks below the handwriting min_block_conf floor", () => {
    const noisy: OcrBlock[] = [
      ...blocks,
      { text: "TOTAL 999.00", bbox: [30, 845, 320, 875], conf: 0.2 },
    ];
    const config: ParseConfig = {
      ...POS_CONFIG,
      handwriting: { min_block_conf: 0.35 },
    };
    expect(extractAmounts({ rawText, blocks: noisy, config }).totalCentavos).toBe(26800);
  });

  it("falls back to raw text when blocks are present but anchors are not", () => {
    expect(extractAmounts({ rawText, blocks }).totalCentavos).toBe(100);
  });

  it("derives its text from blocks when rawText is empty", () => {
    expect(extractMerchantName({ rawText: "", blocks })).toBe(
      "TOTAL DUE 1.00 OFF ANY MEAL",
    );
  });

  it("does not divide by zero on degenerate bboxes", () => {
    const flat: OcrBlock[] = [{ text: "TOTAL 268.00", bbox: [0, 0, 0, 0], conf: 1 }];
    expect(() =>
      extractAmounts({ rawText: "TOTAL 268.00", blocks: flat, config: POS_CONFIG }),
    ).not.toThrow();
  });
});

describe("parseReceipt", () => {
  it("composes every field for the POS fixture with its template", () => {
    const parsed = parseReceipt(input({ config: POS_CONFIG }));
    expect(parsed.merchantName).toBe("JOLLI CAFE");
    expect(parsed.receiptNumber).toBe("0012345");
    expect(parsed.receiptDate?.toISOString()).toBe("2026-07-24T05:42:00.000Z");
    expect(parsed.dateAmbiguous).toBe(false);
    expect(parsed.subtotalCentavos).toBe(23929);
    expect(parsed.taxCentavos).toBe(2871);
    expect(parsed.totalCentavos).toBe(26800);
    expect(parsed.vatConsistent).toBe(true);
    expect(parsed.lineItems).toHaveLength(3);
    expect(parsed.withinAmountSanity).toBe(true);
    expect(parsed.notes).toEqual([]);
  });

  it("composes every field for the handwritten pad with its template", () => {
    const parsed = parseReceipt({ rawText: PAD_RECEIPT, config: PAD_CONFIG });
    expect(parsed.merchantName).toBe("ALING NENA'S EATERY");
    expect(parsed.receiptNumber).toBe("04821");
    expect(parsed.receiptDate?.toISOString()).toBe("2026-07-24T04:00:00.000Z");
    expect(parsed.totalCentavos).toBe(35500);
    expect(parsed.taxCentavos).toBeNull();
    expect(parsed.vatConsistent).toBe(false);
    expect(parsed.lineItems).toHaveLength(3);
    expect(parsed.withinAmountSanity).toBe(true);
    expect(parsed.notes).toEqual([]);
  });

  it("parses a template-less receipt through the generic heuristics alone", () => {
    const parsed = parseReceipt(input());
    expect(parsed.merchantName).toBe("JOLLI CAFE");
    expect(parsed.receiptNumber).toBe("OR0012345");
    expect(parsed.totalCentavos).toBe(26800);
    expect(parsed.withinAmountSanity).toBeNull();
  });

  it("notes an ambiguous date so the caller can raise a review flag", () => {
    const parsed = parseReceipt({ rawText: AMBIGUOUS_RECEIPT });
    expect(parsed.receiptDate?.toISOString()).toBe("2026-05-06T04:00:00.000Z");
    expect(parsed.dateAmbiguous).toBe(true);
    expect(parsed.notes).toContain("date_ambiguous");
    expect(parsed.totalCentavos).toBe(124500);
    expect(parsed.receiptNumber).toBe("OR000912");
  });

  it("notes an inconsistent VAT block", () => {
    const parsed = parseReceipt({
      rawText: "SUKI MART\nVATable Sales 100.00\nVAT 5.00\nTOTAL 268.00",
    });
    expect(parsed.totalCentavos).toBe(26800);
    expect(parsed.notes).toContain("vat_inconsistent");
  });

  it("notes a total outside the template amount_sanity bounds", () => {
    const parsed = parseReceipt({
      rawText: "SUKI MART\nTOTAL 5.00",
      config: { amount_sanity: { min_total_centavos: 1000, max_total_centavos: 2000000 } },
    });
    expect(parsed.totalCentavos).toBe(500);
    expect(parsed.withinAmountSanity).toBe(false);
    expect(parsed.notes).toContain("amount_out_of_range");
  });

  it("accepts a total exactly on both amount_sanity bounds", () => {
    const bounds = { min_total_centavos: 1000, max_total_centavos: 2000000 };
    expect(
      parseReceipt({ rawText: "TOTAL 10.00", config: { amount_sanity: bounds } })
        .withinAmountSanity,
    ).toBe(true);
    expect(
      parseReceipt({ rawText: "TOTAL 20,000.00", config: { amount_sanity: bounds } })
        .withinAmountSanity,
    ).toBe(true);
  });

  it("degrades to nulls on a faded slip without losing what survived", () => {
    const parsed = parseReceipt({ rawText: FADED_RECEIPT });
    expect(parsed.merchantName).toBe("M4NANG R05A CAR1NDER1A");
    expect(parsed.totalCentavos).toBe(18500);
    expect(parsed.receiptDate).toBeNull();
    expect(parsed.receiptNumber).toBeNull();
    expect(parsed.dateAmbiguous).toBe(false);
  });

  it("returns an all-null candidate for garbled input and does not throw", () => {
    const parsed = parseReceipt({ rawText: GARBLED_RECEIPT });
    expect(parsed).toEqual({
      merchantName: null,
      receiptNumber: null,
      receiptDate: null,
      dateAmbiguous: false,
      subtotalCentavos: null,
      taxCentavos: null,
      totalCentavos: null,
      vatConsistent: false,
      lineItems: [],
      withinAmountSanity: null,
      notes: [],
    });
  });

  it("survives empty, whitespace-only and control-character input", () => {
    for (const rawText of ["", "   ", "\n\n\t\n", " "]) {
      expect(() => parseReceipt({ rawText })).not.toThrow();
      expect(parseReceipt({ rawText }).totalCentavos).toBeNull();
    }
  });

  it("survives an empty block list and an empty config object", () => {
    expect(() => parseReceipt({ rawText: POS_RECEIPT, blocks: [], config: {} })).not.toThrow();
    expect(parseReceipt({ rawText: POS_RECEIPT, blocks: [], config: {} }).totalCentavos).toBe(
      26800,
    );
  });

  it("survives a pathological wall of text without hanging", () => {
    // Bounded input is the real ReDoS defence: the parser caps how much text
    // it feeds to any regex, business-authored ones especially.
    const wall = `${"9".repeat(50000)}\n${"A ".repeat(50000)}`;
    const started = Date.now();
    const parsed = parseReceipt({
      rawText: wall,
      config: {
        receipt_no_regex: "([0-9]{3,12})",
        line_item_pattern: "^(?<qty>\\d+)\\s+(?<name>.+?)\\s+(?<amount>[\\d,]+)$",
      },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(parsed).toBeDefined();
  });

  it("never returns a fractional centavo anywhere", () => {
    const parsed = parseReceipt(input({ config: POS_CONFIG }));
    const values = [
      parsed.subtotalCentavos,
      parsed.taxCentavos,
      parsed.totalCentavos,
      ...parsed.lineItems.flatMap((item) => [
        item.unitPriceCentavos,
        item.lineTotalCentavos,
      ]),
    ];
    for (const value of values) {
      if (value !== null) expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("is pure: the same input yields an equal result every time", () => {
    const first = parseReceipt(input({ config: POS_CONFIG }));
    const second = parseReceipt(input({ config: POS_CONFIG }));
    expect(first).toEqual(second);
    expect(first.receiptDate?.getTime()).toBe(
      manilaInstant("2026-07-24T05:42:00.000Z").getTime(),
    );
  });

  it("does not mutate the input it was given", () => {
    const config: ParseConfig = { ...POS_CONFIG };
    const snapshot = JSON.stringify(config);
    const raw = POS_RECEIPT;
    parseReceipt({ rawText: raw, config });
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});
