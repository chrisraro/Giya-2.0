// @vitest-environment node
//
// Server-only module (service-role Supabase reads); no DOM anywhere in it, so
// it runs under plain Node like the other server modules in this codebase.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests.
vi.mock("server-only", () => ({}));

const createServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { DEFAULT_ROUTING_THRESHOLDS } from "../confidence";
import { DEFAULT_FRAUD_REVIEW_THRESHOLD } from "../fraud";
import { MATCH_THRESHOLDS } from "../matching";
import { PHASH_BANDS } from "../phash";
import { DEFAULT_VELOCITY_CAPS } from "../velocity";
import {
  DEFAULT_RECEIPT_SETTINGS,
  RECEIPT_SETTINGS_KEYS,
  getReceiptSettings,
  resolveReceiptSettings,
} from "./settings";
import type { SettingsRow } from "./settings";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function platformRow(key: string, value: unknown): SettingsRow {
  return { scope: "platform", business_id: null, key, value: value as SettingsRow["value"] };
}

function businessRow(key: string, value: unknown, businessId = BUSINESS_ID): SettingsRow {
  return {
    scope: "business",
    business_id: businessId,
    key,
    value: value as SettingsRow["value"],
  };
}

// The full platform registry exactly as supabase/migrations/0017_receipts.sql
// seeds it, used as the "healthy database" baseline.
const SEEDED_PLATFORM_ROWS: SettingsRow[] = [
  platformRow("fraud.phash_block_distance", 4),
  platformRow("fraud.phash_warn_distance", 10),
  platformRow("fraud.velocity.consumer_hour", 4),
  platformRow("fraud.velocity.consumer_day", 10),
  platformRow("fraud.velocity.pair_day", 3),
  platformRow("fraud.velocity.pair_10min", 2),
  platformRow("fraud.velocity.device_day", 12),
  platformRow("fraud.review_threshold", 0.5),
  platformRow("fraud.cooldown_strikes", 3),
  platformRow("fraud.cooldown_hours", 24),
  platformRow("ocr.approve_threshold", 0.8),
  platformRow("ocr.review_threshold", 0.5),
  platformRow("ocr.max_attempts", 3),
  platformRow("receipts.max_age_days", 3),
];

describe("DEFAULT_RECEIPT_SETTINGS drift guard", () => {
  // The whole point of these assertions: the loader's fallbacks and the pure
  // engines' exported constants are the same numbers, so a threshold can never
  // mean one thing when a settings row is present and another when it is not.
  it("uses the pHash bands the phash engine exports", () => {
    expect(DEFAULT_RECEIPT_SETTINGS.phashBands).toEqual(PHASH_BANDS);
  });

  it("uses the velocity caps the velocity engine exports", () => {
    expect(DEFAULT_RECEIPT_SETTINGS.velocityCaps).toEqual(DEFAULT_VELOCITY_CAPS);
  });

  it("uses the composite review threshold the fraud engine exports", () => {
    expect(DEFAULT_RECEIPT_SETTINGS.fraudReviewThreshold).toBe(
      DEFAULT_FRAUD_REVIEW_THRESHOLD,
    );
  });

  it("uses the routing thresholds the confidence engine exports", () => {
    expect(DEFAULT_RECEIPT_SETTINGS.routing).toEqual(DEFAULT_ROUTING_THRESHOLDS);
  });

  it("keeps the confidence engine's match bands equal to the matching engine's", () => {
    expect(DEFAULT_ROUTING_THRESHOLDS.matchAccept).toBe(MATCH_THRESHOLDS.accept);
    expect(DEFAULT_ROUTING_THRESHOLDS.matchReview).toBe(MATCH_THRESHOLDS.review);
  });

  it("matches the numbers migration 0017 seeds into the platform registry", () => {
    // Resolving the seeded rows must produce exactly the fallbacks. If the
    // seed and the fallbacks ever diverge, this fails.
    expect(resolveReceiptSettings(SEEDED_PLATFORM_ROWS)).toEqual(DEFAULT_RECEIPT_SETTINGS);
  });

  it("declares every key the seed registers that this loader consumes", () => {
    for (const row of SEEDED_PLATFORM_ROWS) {
      expect(RECEIPT_SETTINGS_KEYS).toContain(row.key);
    }
  });
});

describe("resolveReceiptSettings", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to every default when no rows exist at all", () => {
    expect(resolveReceiptSettings([])).toEqual(DEFAULT_RECEIPT_SETTINGS);
  });

  it("falls back per key: a single missing row does not disturb the others", () => {
    const rows = SEEDED_PLATFORM_ROWS.filter((row) => row.key !== "fraud.review_threshold");
    const settings = resolveReceiptSettings(rows);

    expect(settings.fraudReviewThreshold).toBe(DEFAULT_FRAUD_REVIEW_THRESHOLD);
    expect(settings.maxAgeDays).toBe(DEFAULT_RECEIPT_SETTINGS.maxAgeDays);
  });

  it("reads tuned platform values", () => {
    const settings = resolveReceiptSettings([
      platformRow("fraud.review_threshold", 0.35),
      platformRow("fraud.velocity.pair_10min", 5),
      platformRow("ocr.approve_threshold", 0.9),
    ]);

    expect(settings.fraudReviewThreshold).toBe(0.35);
    expect(settings.velocityCaps.pair_10min.cap).toBe(5);
    expect(settings.routing.approve).toBe(0.9);
  });

  it("keeps the severity and score of a velocity window when only its cap is tuned", () => {
    // Severity and score are code (doc 37 S4), never settings; a tuned cap
    // must not silently reclassify the signal.
    const settings = resolveReceiptSettings([platformRow("fraud.velocity.pair_day", 9)]);

    expect(settings.velocityCaps.pair_day).toEqual({
      cap: 9,
      severity: DEFAULT_VELOCITY_CAPS.pair_day.severity,
      score: DEFAULT_VELOCITY_CAPS.pair_day.score,
    });
  });

  describe("business scope overrides platform scope", () => {
    it("prefers the business row for the same key", () => {
      const settings = resolveReceiptSettings(
        [
          platformRow("fraud.velocity.pair_day", 3),
          businessRow("fraud.velocity.pair_day", 8),
        ],
        BUSINESS_ID,
      );

      expect(settings.velocityCaps.pair_day.cap).toBe(8);
    });

    it("keeps the platform value for keys the business did not override", () => {
      const settings = resolveReceiptSettings(
        [
          platformRow("fraud.velocity.pair_day", 3),
          platformRow("fraud.review_threshold", 0.4),
          businessRow("fraud.velocity.pair_day", 8),
        ],
        BUSINESS_ID,
      );

      expect(settings.fraudReviewThreshold).toBe(0.4);
    });

    it("ignores a business row belonging to a different business", () => {
      const settings = resolveReceiptSettings(
        [
          platformRow("receipts.max_age_days", 3),
          businessRow("receipts.max_age_days", 14, "22222222-2222-4222-8222-222222222222"),
        ],
        BUSINESS_ID,
      );

      expect(settings.maxAgeDays).toBe(3);
    });

    it("ignores business rows entirely when no business is in scope", () => {
      const settings = resolveReceiptSettings([
        platformRow("receipts.max_age_days", 3),
        businessRow("receipts.max_age_days", 14),
      ]);

      expect(settings.maxAgeDays).toBe(3);
    });

    it("falls back to the platform value when the business override is malformed", () => {
      const settings = resolveReceiptSettings(
        [
          platformRow("fraud.review_threshold", 0.4),
          businessRow("fraud.review_threshold", "0.9"),
        ],
        BUSINESS_ID,
      );

      expect(settings.fraudReviewThreshold).toBe(0.4);
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe("malformed jsonb falls back instead of throwing", () => {
    const badValues: Array<[string, unknown]> = [
      ["a string where a number belongs", "0.9"],
      ["null", null],
      ["a boolean", true],
      ["an object", { value: 0.9 }],
      ["an array", [0.9]],
      ["NaN-ish text", "not-a-number"],
      ["a negative threshold", -0.2],
      ["a threshold above 1", 1.4],
    ];

    for (const [label, value] of badValues) {
      it(`falls back for ${label}`, () => {
        const settings = resolveReceiptSettings([
          platformRow("fraud.review_threshold", value),
        ]);

        expect(settings.fraudReviewThreshold).toBe(DEFAULT_FRAUD_REVIEW_THRESHOLD);
        expect(console.warn).toHaveBeenCalled();
      });
    }

    it("never throws on a wholly garbage registry", () => {
      const garbage = RECEIPT_SETTINGS_KEYS.map((key) => platformRow(key, "garbage"));

      expect(() => resolveReceiptSettings(garbage)).not.toThrow();
      expect(resolveReceiptSettings(garbage)).toEqual(DEFAULT_RECEIPT_SETTINGS);
    });

    it("falls back for a negative velocity cap", () => {
      const settings = resolveReceiptSettings([
        platformRow("fraud.velocity.consumer_day", -1),
      ]);

      expect(settings.velocityCaps.consumer_day.cap).toBe(
        DEFAULT_VELOCITY_CAPS.consumer_day.cap,
      );
    });

    it("falls back for a fractional count where an integer is required", () => {
      const settings = resolveReceiptSettings([
        platformRow("fraud.cooldown_strikes", 2.5),
        platformRow("ocr.max_attempts", 1.5),
      ]);

      expect(settings.cooldownStrikes).toBe(DEFAULT_RECEIPT_SETTINGS.cooldownStrikes);
      expect(settings.ocrMaxAttempts).toBe(DEFAULT_RECEIPT_SETTINGS.ocrMaxAttempts);
    });

    it("falls back for a pHash distance outside the 64-bit hash range", () => {
      const settings = resolveReceiptSettings([
        platformRow("fraud.phash_block_distance", 65),
      ]);

      expect(settings.phashBands.blockDistance).toBe(PHASH_BANDS.blockDistance);
    });

    it("ignores keys this loader does not consume", () => {
      expect(() =>
        resolveReceiptSettings([platformRow("fraud.gps_warn_m", 2000)]),
      ).not.toThrow();
    });
  });

  describe("receipts.max_age_days clamp (doc 36 Stage 8: clamp 1-30)", () => {
    it("clamps at the low end", () => {
      expect(resolveReceiptSettings([platformRow("receipts.max_age_days", 0)]).maxAgeDays).toBe(1);
      expect(resolveReceiptSettings([platformRow("receipts.max_age_days", -7)]).maxAgeDays).toBe(1);
    });

    it("clamps at the high end", () => {
      expect(
        resolveReceiptSettings([platformRow("receipts.max_age_days", 90)]).maxAgeDays,
      ).toBe(30);
    });

    it("passes an in-range value through untouched at both boundaries", () => {
      expect(resolveReceiptSettings([platformRow("receipts.max_age_days", 1)]).maxAgeDays).toBe(1);
      expect(resolveReceiptSettings([platformRow("receipts.max_age_days", 30)]).maxAgeDays).toBe(30);
      expect(resolveReceiptSettings([platformRow("receipts.max_age_days", 14)]).maxAgeDays).toBe(14);
    });

    it("still falls back when the value is not a number at all", () => {
      expect(
        resolveReceiptSettings([platformRow("receipts.max_age_days", "14")]).maxAgeDays,
      ).toBe(DEFAULT_RECEIPT_SETTINGS.maxAgeDays);
    });
  });
});

describe("getReceiptSettings", () => {
  let capturedFilters: Array<{ method: string; args: unknown[] }>;

  function fakeClient(result: { data: SettingsRow[] | null; error: unknown }) {
    const builder = {
      select: (...args: unknown[]) => {
        capturedFilters.push({ method: "select", args });
        return builder;
      },
      in: (...args: unknown[]) => {
        capturedFilters.push({ method: "in", args });
        return builder;
      },
      is: (...args: unknown[]) => {
        capturedFilters.push({ method: "is", args });
        return Promise.resolve(result);
      },
      or: (...args: unknown[]) => {
        capturedFilters.push({ method: "or", args });
        return Promise.resolve(result);
      },
    };
    return {
      from: (...args: unknown[]) => {
        capturedFilters.push({ method: "from", args });
        return builder;
      },
    };
  }

  beforeEach(() => {
    capturedFilters = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    createServiceRoleClient.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads through the service role, not a user-scoped client", async () => {
    createServiceRoleClient.mockReturnValue(fakeClient({ data: SEEDED_PLATFORM_ROWS, error: null }));

    await getReceiptSettings();

    expect(createServiceRoleClient).toHaveBeenCalled();
    expect(capturedFilters[0]).toEqual({ method: "from", args: ["settings"] });
  });

  it("returns the resolved settings for the platform scope", async () => {
    createServiceRoleClient.mockReturnValue(fakeClient({ data: SEEDED_PLATFORM_ROWS, error: null }));

    await expect(getReceiptSettings()).resolves.toEqual(DEFAULT_RECEIPT_SETTINGS);
  });

  it("restricts the query to platform rows when no business is in scope", async () => {
    createServiceRoleClient.mockReturnValue(fakeClient({ data: [], error: null }));

    await getReceiptSettings();

    expect(capturedFilters.at(-1)).toEqual({ method: "is", args: ["business_id", null] });
  });

  it("widens the query to the business rows when a business is in scope", async () => {
    createServiceRoleClient.mockReturnValue(fakeClient({ data: [], error: null }));

    await getReceiptSettings(BUSINESS_ID);

    const last = capturedFilters.at(-1);
    expect(last?.method).toBe("or");
    expect(String(last?.args[0])).toContain(BUSINESS_ID);
  });

  it("applies a business override end to end", async () => {
    createServiceRoleClient.mockReturnValue(
      fakeClient({
        data: [...SEEDED_PLATFORM_ROWS, businessRow("fraud.velocity.pair_10min", 6)],
        error: null,
      }),
    );

    const settings = await getReceiptSettings(BUSINESS_ID);

    expect(settings.velocityCaps.pair_10min.cap).toBe(6);
  });

  it("ignores a business id that is not a uuid rather than interpolating it into a filter", async () => {
    createServiceRoleClient.mockReturnValue(fakeClient({ data: SEEDED_PLATFORM_ROWS, error: null }));

    const settings = await getReceiptSettings("not-a-uuid,injected.filter");

    expect(capturedFilters.at(-1)?.method).toBe("is");
    expect(settings).toEqual(DEFAULT_RECEIPT_SETTINGS);
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back to the defaults when the service role key is not configured", async () => {
    createServiceRoleClient.mockReturnValue(null);

    await expect(getReceiptSettings()).resolves.toEqual(DEFAULT_RECEIPT_SETTINGS);
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back to the defaults when the query errors", async () => {
    createServiceRoleClient.mockReturnValue(
      fakeClient({ data: null, error: { message: "permission denied" } }),
    );

    await expect(getReceiptSettings()).resolves.toEqual(DEFAULT_RECEIPT_SETTINGS);
    expect(console.error).toHaveBeenCalled();
  });

  it("falls back to the defaults when the client itself throws", async () => {
    createServiceRoleClient.mockImplementation(() => {
      throw new Error("network down");
    });

    await expect(getReceiptSettings()).resolves.toEqual(DEFAULT_RECEIPT_SETTINGS);
    expect(console.error).toHaveBeenCalled();
  });

  it("does not cache across calls, so a retuned threshold is live without a deploy", async () => {
    createServiceRoleClient.mockReturnValue(
      fakeClient({ data: [platformRow("fraud.review_threshold", 0.4)], error: null }),
    );
    expect((await getReceiptSettings()).fraudReviewThreshold).toBe(0.4);

    createServiceRoleClient.mockReturnValue(
      fakeClient({ data: [platformRow("fraud.review_threshold", 0.7)], error: null }),
    );
    expect((await getReceiptSettings()).fraudReviewThreshold).toBe(0.7);
  });
});
