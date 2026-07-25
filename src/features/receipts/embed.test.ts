// @vitest-environment node
//
// embed.ts is a server-side client plus two pure helpers, with no DOM
// dependency, so it runs under plain Node like the other server modules here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getServerEnvMock } = vi.hoisted(() => ({
  getServerEnvMock: vi.fn<() => Record<string, string | undefined>>(() => ({})),
}));

// @/lib/env validates the client schema at module scope, which no test here
// has any business satisfying. The mock also lets the env-default tests drive
// HF_TOKEN and HF_EMBED_MODEL directly.
vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: getServerEnvMock,
}));

import {
  DEFAULT_HF_EMBED_MODEL,
  EMBEDDING_DIMENSIONS,
  HF_EMBED_BASE_URL,
  cosineSimilarity,
  embedText,
  normalizeLayoutText,
} from "./embed";

beforeEach(() => {
  getServerEnvMock.mockReturnValue({});
  // embed.ts logs every fail-soft branch on purpose; silence it so a green run
  // stays readable.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Shop A, total 150.00. */
const SHOP_A_150 = `KAPE DIARIA COFFEE
123 Mabini St, Makati City
TIN 004-123-456-000
--------------------------------
OR# 004512
07/24/2026  14:32
--------------------------------
2 x Barako Brew            90.00
1 x Pandesal Bilao         44.64
--------------------------------
VATABLE SALES             133.93
VAT 12%                    16.07
TOTAL                     150.00
CASH                      200.00
CHANGE                     50.00
--------------------------------
THIS SERVES AS AN OFFICIAL RECEIPT
SALAMAT PO`;

/** Shop A again, a much bigger basket: total 890.00. Same layout, same
 * vocabulary, every single amount different. */
const SHOP_A_890 = `KAPE DIARIA COFFEE
123 Mabini St, Makati City
TIN 004-123-456-000
--------------------------------
OR# 007731
08/02/2026  09:05
--------------------------------
4 x Cold Brew Litro       620.00
3 x Ensaymada             174.64
--------------------------------
VATABLE SALES             794.64
VAT 12%                    95.36
TOTAL                     890.00
CASH                    1,000.00
CHANGE                    110.00
--------------------------------
THIS SERVES AS AN OFFICIAL RECEIPT
SALAMAT PO`;

/** A different shop entirely, whose total (155.00) is close to shop A's
 * 150.00. A vector that encodes the transaction rather than the layout would
 * be pulled towards this one. */
const SHOP_B_155 = `BOTIKA NG BAYAN PHARMACY
Unit 5 Quezon Ave, Quezon City
TIN 009-887-654-000
Sales Invoice No. 88231
Date: 07/25/2026
================================
QTY  DESCRIPTION         AMOUNT
1    Paracetamol 500mg    55.00
1    Amoxicillin Capsule 100.00
================================
AMOUNT DUE                155.00
VAT-EXEMPT SALES          155.00
PAYMENT: GCASH            155.00
================================
PLEASE KEEP YOUR INVOICE`;

// ---------------------------------------------------------------------------
// normalizeLayoutText
// ---------------------------------------------------------------------------

describe("normalizeLayoutText - what it strips", () => {
  it("replaces money amounts in every printed form with a constant placeholder", () => {
    const result = normalizeLayoutText(
      "TOTAL 150.00\nGRAND TOTAL P1,245.00\nAMOUNT DUE PHP 99\nCHANGE ₱50.00",
    );

    expect(result).toBe(
      "TOTAL <AMT>\nGRAND TOTAL <AMT>\nAMOUNT DUE <AMT>\nCHANGE <AMT>",
    );
    expect(result).not.toMatch(/\d/);
  });

  it("replaces dates, both numeric and spelled, with a constant placeholder", () => {
    expect(normalizeLayoutText("DATE: 07/24/2026")).toBe("DATE: <DATE>");
    expect(normalizeLayoutText("DATE 2026-07-24")).toBe("DATE <DATE>");
    expect(normalizeLayoutText("Issued July 24, 2026")).toBe("ISSUED <DATE>");
    expect(normalizeLayoutText("24 Jul 2026")).toBe("<DATE>");
  });

  it("replaces clock times with a constant placeholder", () => {
    expect(normalizeLayoutText("14:32")).toBe("<TIME>");
    expect(normalizeLayoutText("Time 09:05:11 AM")).toBe("TIME <TIME>");
  });

  it("replaces receipt, invoice and TIN numbers while keeping their labels", () => {
    expect(normalizeLayoutText("OR# 004512")).toBe("OR <REF>");
    expect(normalizeLayoutText("Sales Invoice No. 88231")).toBe("SALES INVOICE <REF>");
    expect(normalizeLayoutText("TIN 004-123-456-000")).toBe("TIN <REF>");
    expect(normalizeLayoutText("MIN 12345678901234")).toBe("MIN <REF>");
  });

  it("replaces leading quantity columns on line-item lines", () => {
    expect(normalizeLayoutText("2 x Barako Brew 90.00")).toBe("<QTY> BARAKO BREW <AMT>");
    expect(normalizeLayoutText("12 Ensaymada 240.00")).toBe("<QTY> ENSAYMADA <AMT>");
  });

  it("does not read a street number as a quantity, because a header line has no money column", () => {
    expect(normalizeLayoutText("123 Mabini St, Makati City")).toBe(
      "<NUM> MABINI ST, MAKATI CITY",
    );
  });

  it("leaves no transaction digits anywhere in a whole receipt", () => {
    // Percent labels are the one deliberate exception; see the "keeps" block.
    const withoutPercentLabels = (raw: string): string =>
      normalizeLayoutText(raw).replace(/\d{1,3}(?:\.\d+)?%/g, "");

    expect(withoutPercentLabels(SHOP_A_150)).not.toMatch(/\d/);
    expect(withoutPercentLabels(SHOP_A_890)).not.toMatch(/\d/);
    expect(withoutPercentLabels(SHOP_B_155)).not.toMatch(/\d/);
  });
});

describe("normalizeLayoutText - what it keeps", () => {
  it("keeps the merchant name line and the header text", () => {
    const result = normalizeLayoutText(SHOP_A_150);

    expect(result.split("\n")[0]).toBe("KAPE DIARIA COFFEE");
    expect(result).toContain("MABINI ST, MAKATI CITY");
  });

  it("keeps the keyword labels that distinguish one layout from another", () => {
    const result = normalizeLayoutText(SHOP_A_150);

    for (const label of ["TOTAL", "VATABLE SALES", "VAT", "CASH", "CHANGE"]) {
      expect(result).toContain(label);
    }
  });

  it("keeps a percentage, because '12% VAT' is a label and not an amount", () => {
    expect(normalizeLayoutText("VAT 12%  16.07")).toBe("VAT 12% <AMT>");
  });

  it("keeps footer text", () => {
    const result = normalizeLayoutText(SHOP_A_150);

    expect(result).toContain("THIS SERVES AS AN OFFICIAL RECEIPT");
    expect(result).toContain("SALAMAT PO");
  });

  it("keeps separator lines, canonicalized so length and rule character do not matter", () => {
    expect(normalizeLayoutText("--------------------------------")).toBe("---");
    expect(normalizeLayoutText("================================")).toBe("---");
    expect(normalizeLayoutText(SHOP_A_150).split("\n").filter((line) => line === "---")).toHaveLength(4);
  });

  it("keeps the order of the lines, which is the layout", () => {
    const lines = normalizeLayoutText(SHOP_A_150).split("\n");

    expect(lines.indexOf("KAPE DIARIA COFFEE")).toBeLessThan(lines.indexOf("VATABLE SALES <AMT>"));
    expect(lines.indexOf("VATABLE SALES <AMT>")).toBeLessThan(lines.indexOf("TOTAL <AMT>"));
    expect(lines.indexOf("TOTAL <AMT>")).toBeLessThan(lines.indexOf("SALAMAT PO"));
  });

  it("uppercases, collapses whitespace and drops blank lines", () => {
    expect(normalizeLayoutText("  Kape   Diaria \n\n\n   \n  Coffee  ")).toBe(
      "KAPE DIARIA\nCOFFEE",
    );
  });
});

describe("normalizeLayoutText - totality", () => {
  it("is idempotent", () => {
    for (const raw of [SHOP_A_150, SHOP_A_890, SHOP_B_155]) {
      const once = normalizeLayoutText(raw);
      expect(normalizeLayoutText(once)).toBe(once);
    }
  });

  it("returns an empty string for empty and whitespace-only input", () => {
    expect(normalizeLayoutText("")).toBe("");
    expect(normalizeLayoutText("   \n\t\n  ")).toBe("");
  });

  it("does not throw on garbage", () => {
    const garbage = [
      " ",
      "???!!!###@@@",
      "9".repeat(5_000),
      "ñÑ₱ 你好 🧾",
      "-".repeat(2_000),
      `${"x".repeat(400)}\n`.repeat(1_000),
    ];

    for (const raw of garbage) {
      expect(() => normalizeLayoutText(raw)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The discrimination test: this is the reason normalizeLayoutText exists
// ---------------------------------------------------------------------------
//
// The vectors below are a deterministic LOCAL bag of words, not Hugging Face
// output, and that is deliberate: the thing under test is the normalization,
// not the model. A term-frequency vector over a shared vocabulary is the
// crudest possible embedding, so if the normalization already separates shops
// under it, it is separating on layout vocabulary and structure rather than on
// anything the model happens to smooth over.

function bagOfWords(texts: readonly string[]): number[][] {
  const vocabulary = new Map<string, number>();
  const tokenized = texts.map((text) => text.split(/\s+/).filter((token) => token.length > 0));

  for (const tokens of tokenized) {
    for (const token of tokens) {
      if (!vocabulary.has(token)) vocabulary.set(token, vocabulary.size);
    }
  }

  return tokenized.map((tokens) => {
    const vector = new Array<number>(vocabulary.size).fill(0);
    for (const token of tokens) {
      const index = vocabulary.get(token);
      if (index !== undefined) vector[index] = (vector[index] ?? 0) + 1;
    }
    return vector;
  });
}

describe("normalizeLayoutText - discrimination (the point of the function, measured with a deterministic local bag-of-words vector rather than the HF model, because what is under test is the normalization)", () => {
  it("puts two same-shop receipts with different totals closer together than either is to a different shop with a similar total", () => {
    const [a150, a890, b155] = bagOfWords(
      [SHOP_A_150, SHOP_A_890, SHOP_B_155].map(normalizeLayoutText),
    );

    expect(a150).toBeDefined();
    expect(a890).toBeDefined();
    expect(b155).toBeDefined();
    if (a150 === undefined || a890 === undefined || b155 === undefined) return;

    const sameShop = cosineSimilarity(a150, a890);
    const crossShopFrom150 = cosineSimilarity(a150, b155);
    const crossShopFrom890 = cosineSimilarity(a890, b155);

    expect(sameShop).toBeGreaterThan(crossShopFrom150);
    expect(sameShop).toBeGreaterThan(crossShopFrom890);
  });

  it("pulls the two same-shop receipts together, which is exactly the distance the amounts were adding", () => {
    const normalized = bagOfWords([SHOP_A_150, SHOP_A_890, SHOP_B_155].map(normalizeLayoutText));
    const raw = bagOfWords([SHOP_A_150, SHOP_A_890, SHOP_B_155]);

    const [normalizedA150, normalizedA890] = normalized;
    const [rawA150, rawA890] = raw;
    expect(normalizedA150).toBeDefined();
    expect(normalizedA890).toBeDefined();
    expect(rawA150).toBeDefined();
    expect(rawA890).toBeDefined();
    if (
      normalizedA150 === undefined ||
      normalizedA890 === undefined ||
      rawA150 === undefined ||
      rawA890 === undefined
    ) {
      return;
    }

    // Two receipts from the same shop, same layout, same vocabulary, every
    // amount different. Whatever similarity normalization adds here is
    // similarity the transaction values were destroying.
    expect(cosineSimilarity(normalizedA150, normalizedA890)).toBeGreaterThan(
      cosineSimilarity(rawA150, rawA890),
    );
  });

  it("makes the totals line of two same-shop receipts byte-identical, so the amounts cannot drive the geometry at all", () => {
    // The structural reason the assertion above holds. If amounts survived,
    // "TOTAL 150.00" and "TOTAL 890.00" would be two different tokens pulling
    // the same shop's receipts apart, while shop B's "155.00" sat next to shop
    // A's "150.00" pulling different shops together.
    const totalsLine = (raw: string): string | undefined =>
      normalizeLayoutText(raw)
        .split("\n")
        .find((line) => line.startsWith("TOTAL"));

    expect(totalsLine(SHOP_A_150)).toBe("TOTAL <AMT>");
    expect(totalsLine(SHOP_A_890)).toBe("TOTAL <AMT>");
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  it("returns 1 for parallel vectors of different magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([3, 0, 0], [0, 0, 7])).toBeCloseTo(0, 12);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 12);
  });

  it("matches a hand-computed value", () => {
    // dot = 1*4 + 2*5 + 3*6 = 32; |a| = sqrt(14); |b| = sqrt(77).
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(
      32 / (Math.sqrt(14) * Math.sqrt(77)),
      12,
    );
  });

  it("throws on mismatched lengths rather than comparing a prefix", () => {
    expect(() => cosineSimilarity(new Array<number>(384).fill(1), new Array<number>(512).fill(1))).toThrow(
      /equal length/,
    );
  });

  it("throws on empty vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow(/non-empty/);
  });

  it("returns 0 for a zero vector rather than NaN", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("stays inside [-1, 1]", () => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.05);
    expect(cosineSimilarity(vector, vector)).toBeLessThanOrEqual(1);
    expect(cosineSimilarity(vector, vector)).toBeGreaterThanOrEqual(-1);
  });
});

// ---------------------------------------------------------------------------
// embedText
// ---------------------------------------------------------------------------

const TOKEN = "hf_test_token";

function vectorOf(length: number): number[] {
  return Array.from({ length }, (_value, index) => (index % 7) / 10);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchReturning(response: Response): typeof fetch {
  return vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;
}

/** A fetch that never settles until its abort signal fires. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  })) as unknown as typeof fetch;

describe("embedText - request shape", () => {
  it("posts the text to the feature-extraction pipeline with a bearer token", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(vectorOf(EMBEDDING_DIMENSIONS))),
    ) as unknown as typeof fetch;

    await embedText("TOTAL <AMT>", { token: TOKEN, fetchImpl });

    const mock = vi.mocked(fetchImpl);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] ?? [];

    expect(url).toBe(
      `${HF_EMBED_BASE_URL}/${DEFAULT_HF_EMBED_MODEL}/pipeline/feature-extraction`,
    );
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ inputs: "TOTAL <AMT>" });
  });

  it("uses HF_TOKEN and HF_EMBED_MODEL from the server env when no options are given", async () => {
    getServerEnvMock.mockReturnValue({
      HF_TOKEN: "hf_from_env",
      HF_EMBED_MODEL: "sentence-transformers/other-model",
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(vectorOf(EMBEDDING_DIMENSIONS))),
    ) as unknown as typeof fetch;

    await embedText("TOTAL <AMT>", { fetchImpl });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(
      `${HF_EMBED_BASE_URL}/sentence-transformers/other-model/pipeline/feature-extraction`,
    );
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer hf_from_env");
  });
});

describe("embedText - response shapes", () => {
  it("parses a flat array of 384 numbers", async () => {
    const expected = vectorOf(EMBEDDING_DIMENSIONS);

    const result = await embedText("TOTAL <AMT>", {
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse(expected)),
    });

    expect(result).toEqual(expected);
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("parses a nested [[...384]] array", async () => {
    const expected = vectorOf(EMBEDDING_DIMENSIONS);

    const result = await embedText("TOTAL <AMT>", {
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse([expected])),
    });

    expect(result).toEqual(expected);
  });

  it("returns null for an unpooled multi-row response", async () => {
    const body = [vectorOf(EMBEDDING_DIMENSIONS), vectorOf(EMBEDDING_DIMENSIONS)];

    await expect(
      embedText("TOTAL <AMT>", { token: TOKEN, fetchImpl: fetchReturning(jsonResponse(body)) }),
    ).resolves.toBeNull();
  });

  it("returns null for a body that is not an array of numbers at all", async () => {
    await expect(
      embedText("TOTAL <AMT>", {
        token: TOKEN,
        fetchImpl: fetchReturning(jsonResponse({ error: "Model is loading" })),
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a non-JSON body", async () => {
    const response = new Response("<html>502 Bad Gateway</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

    await expect(
      embedText("TOTAL <AMT>", { token: TOKEN, fetchImpl: fetchReturning(response) }),
    ).resolves.toBeNull();
  });
});

describe("embedText - dimension guard", () => {
  it("returns null when the model answers with the wrong dimension, so a 512-vector never reaches a vector(384) column", async () => {
    const result = await embedText("TOTAL <AMT>", {
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse(vectorOf(512))),
    });

    expect(result).toBeNull();
  });

  it("returns null for a short vector too", async () => {
    await expect(
      embedText("TOTAL <AMT>", {
        token: TOKEN,
        fetchImpl: fetchReturning(jsonResponse(vectorOf(EMBEDDING_DIMENSIONS - 1))),
      }),
    ).resolves.toBeNull();
  });

  it("returns null when a value is not finite", async () => {
    // JSON has no NaN, but a provider can send null inside the array.
    const body = vectorOf(EMBEDDING_DIMENSIONS);
    const withNull: Array<number | null> = [...body];
    withNull[10] = null;

    await expect(
      embedText("TOTAL <AMT>", {
        token: TOKEN,
        fetchImpl: fetchReturning(jsonResponse(withNull)),
      }),
    ).resolves.toBeNull();
  });
});

describe("embedText - fail-soft on every failure", () => {
  it.each([401, 403, 429, 500, 503])("returns null on status %i", async (status) => {
    const result = await embedText("TOTAL <AMT>", {
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse({ error: "nope" }, status)),
    });

    expect(result).toBeNull();
  });

  it("returns null on a timeout", async () => {
    const result = await embedText("TOTAL <AMT>", {
      token: TOKEN,
      timeoutMs: 5,
      fetchImpl: hangingFetch,
    });

    expect(result).toBeNull();
  });

  it("returns null when the host is unreachable", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

    await expect(embedText("TOTAL <AMT>", { token: TOKEN, fetchImpl })).resolves.toBeNull();
  });

  it("returns null without calling out when no token is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(embedText("TOTAL <AMT>", { fetchImpl })).resolves.toBeNull();
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("returns null without calling out for empty or whitespace-only text", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(embedText("", { token: TOKEN, fetchImpl })).resolves.toBeNull();
    await expect(embedText("   \n  ", { token: TOKEN, fetchImpl })).resolves.toBeNull();
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing when the server env itself is unreadable", async () => {
    getServerEnvMock.mockImplementation(() => {
      throw new Error("Invalid or missing server environment variables");
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(embedText("TOTAL <AMT>", { fetchImpl })).resolves.toBeNull();
  });
});

describe("EMBEDDING_DIMENSIONS", () => {
  it("is 384, pinned to the model and to the vector(384) column", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384);
    expect(DEFAULT_HF_EMBED_MODEL).toBe("sentence-transformers/all-MiniLM-L6-v2");
  });
});
