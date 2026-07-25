import "server-only";

import { cache } from "react";
import { z } from "zod";

import { createServiceRoleClient } from "@/lib/supabase/service";

import { DEFAULT_ROUTING_THRESHOLDS } from "../confidence";
import { DEFAULT_FRAUD_REVIEW_THRESHOLD } from "../fraud";
import { PHASH_BANDS } from "../phash";
import type { PhashBands } from "../phash";
import type { RoutingThresholds } from "../types";
import { DEFAULT_VELOCITY_CAPS, VELOCITY_WINDOWS } from "../velocity";
import type { VelocityCap, VelocityWindow } from "../velocity";

// Typed reader over the `settings` table, per doc 37 ("thresholds are data,
// not code: defaults live in settings rows scope='platform', tunable without
// deploy") and doc 36 Stage 8/9. Business-scope rows override platform-scope
// rows for the same key.
//
// SERVICE ROLE, SERVER ONLY. Platform-scope rows have NO client select policy
// in supabase/migrations/0017_receipts.sql, deliberately: they are the fraud
// rulebook. fraud.velocity.* are the exact submission caps an abuser must stay
// under, fraud.phash_block_distance is the exact perceptual distance a
// re-photograph must exceed, fraud.review_threshold is the composite score to
// stay below, fraud.cooldown_strikes is how many rejections are free. The
// "server-only" import above is the build-time fence that keeps this module
// out of any client bundle; the service-role client is the only role that can
// see the rows at all.
//
// Two invariants hold no matter what the database contains:
//
//   1. This module NEVER throws. A missing row, a malformed row, an
//      unreachable database, an unconfigured service-role key: every one of
//      them degrades to the documented default and logs. The pipeline that
//      calls this decides whether a consumer earns points, and it must not be
//      taken down by a bad row in a tuning table.
//   2. A value that fails validation NEVER reaches the caller. Zod is not
//      decoration here: `value` is jsonb, so a row can legitimately hold a
//      string, an object, or null, and a string silently coerced to NaN would
//      make every fraud comparison false, which routes straight to approved.
//      Failing closed onto the default is the only safe reading.

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Everything the receipt pipeline reads out of `settings`, already shaped into
 * the exact structures the pure engines consume: `phashBands` goes to
 * `phashBand()`, `velocityCaps` to `evaluateVelocity()`, `routing` to
 * `routeReceipt()`. Deliberately NOT a key-value bag: a bag pushes the
 * key-name string, the type assertion, and the fallback decision out to every
 * call site, which is exactly where they would drift.
 */
export interface ReceiptSettings {
  /** doc 37 S1 bands. `fraud.phash_block_distance` / `fraud.phash_warn_distance`. */
  readonly phashBands: PhashBands;
  /**
   * doc 37 S4 caps, keyed by window. Only the CAP is settings-driven; the
   * severity and score of each window are code (a settings row must not be
   * able to reclassify a velocity signal, and doc 37's velocity rows are
   * `warn` by definition since batch-scanning is legitimate).
   */
  readonly velocityCaps: Record<VelocityWindow, VelocityCap>;
  /** doc 37 composite routing. `fraud.review_threshold`. */
  readonly fraudReviewThreshold: number;
  /** doc 37 consequences ladder step 2. `fraud.cooldown_strikes`. */
  readonly cooldownStrikes: number;
  /** doc 37 consequences ladder step 2. `fraud.cooldown_hours`. */
  readonly cooldownHours: number;
  /**
   * doc 36 Stage 9. `approve` / `review` come from `ocr.approve_threshold` /
   * `ocr.review_threshold`; `matchAccept` / `matchReview` are doc 36 Stage 5
   * bands with no registered settings key, so they always take the engine
   * constant. They travel together because `routeReceipt` needs all four.
   */
  readonly routing: RoutingThresholds;
  /** doc 36 Stage 4 retry budget. `ocr.max_attempts`. */
  readonly ocrMaxAttempts: number;
  /** doc 36 Stage 8 freshness window, clamped 1-30. `receipts.max_age_days`. */
  readonly maxAgeDays: number;
  /**
   * doc 36 Stage 8 amount sanity, the PLATFORM ceiling in integer centavos.
   * `receipts.max_total_centavos`.
   *
   * The fallback under a template's own `amount_sanity.max_total_centavos`,
   * not a replacement for it: a configured template bound wins in both
   * directions, and this number is what applies to the merchant who has
   * configured nothing (or to a receipt that matched no template at all).
   * Exceeding it routes to review, never to a rejection, so a business-scope
   * row raising it is the documented fix for a genuinely high-ticket merchant.
   */
  readonly maxTotalCentavos: number;
}

/** A `settings` row as the service-role read returns it. */
export interface SettingsRow {
  scope: string;
  business_id: string | null;
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Keys and defaults
// ---------------------------------------------------------------------------

const VELOCITY_KEY_BY_WINDOW: Record<VelocityWindow, string> = {
  consumer_hour: "fraud.velocity.consumer_hour",
  consumer_day: "fraud.velocity.consumer_day",
  pair_day: "fraud.velocity.pair_day",
  pair_10min: "fraud.velocity.pair_10min",
  device_day: "fraud.velocity.device_day",
};

/**
 * Every key this loader consumes, which is also exactly the `in (...)` filter
 * of the query. Doc 37's registry contains more keys than these
 * (`fraud.text_sim_warn`, `fraud.gps_warn_m`, `fraud.referral_farm_min`); they
 * belong to [V1] detectors that do not exist yet, so reading them now would be
 * inventing a contract for code nobody has written.
 */
export const RECEIPT_SETTINGS_KEYS = [
  "fraud.phash_block_distance",
  "fraud.phash_warn_distance",
  ...VELOCITY_WINDOWS.map((window) => VELOCITY_KEY_BY_WINDOW[window]),
  "fraud.review_threshold",
  "fraud.cooldown_strikes",
  "fraud.cooldown_hours",
  "ocr.approve_threshold",
  "ocr.review_threshold",
  "ocr.max_attempts",
  "receipts.max_age_days",
  "receipts.max_total_centavos",
] as const;

// Defaults imported from the pure engines wherever an engine already owns the
// number, so the two can never drift: PHASH_BANDS (doc 37 S1),
// DEFAULT_VELOCITY_CAPS (doc 37 S4), DEFAULT_FRAUD_REVIEW_THRESHOLD (doc 37
// scoring) and DEFAULT_ROUTING_THRESHOLDS (doc 36 Stage 9 and Stage 5). The
// three below have no engine constant because no pure engine consumes them;
// each matches the value migration 0017_receipts.sql seeds.
const DEFAULT_COOLDOWN_STRIKES = 3; // matches the 0017 seed (doc 37 ladder step 2)
const DEFAULT_COOLDOWN_HOURS = 24; // matches the 0017 seed (doc 37 ladder step 2)
const DEFAULT_OCR_MAX_ATTEMPTS = 3; // matches the 0017 seed (doc 36 Stage 4)
const DEFAULT_MAX_AGE_DAYS = 3; // matches the 0017 seed (doc 36 Stage 8)

/**
 * PHP 20,000.00, matching the 0025_receipt_amount_ceiling.sql seed. Doc 36
 * Stage 8's amount-sanity rule, applied when no template bound is configured.
 *
 * WHY THIS EXISTS AT ALL. Stage 8's amount rule used to read exactly one
 * value: `withinAmountSanity`, which parse.ts leaves null when the matched
 * template declared no `amount_sanity` (and there is no template at all on the
 * generic path). So an unconfigured merchant had NO ceiling on the
 * deterministic tiers, and a printed line reading `TOTAL: PHP 99,999.00` was
 * read by the tier 1 keyword scan and auto-approved. extract.ts already gives
 * the LLM tier a default bound for precisely this reason ("an unconfigured
 * merchant would otherwise be an open door"), which left the CHEAPER attack -
 * the one that needs no model call - as the unguarded one.
 *
 * WHY 20,000 AND NOT extract.ts's 10,000. The two numbers deliberately differ,
 * because they guard different populations and their false positives cost
 * different things:
 *
 *   * LLM_DEFAULT_MAX_TOTAL_CENTAVOS (PHP 10,000.00) bounds a number a
 *     LANGUAGE MODEL produced, on the small minority of receipts the
 *     deterministic tiers could not read. Refusing there leaves the field
 *     missing, and a receipt with no total was already going to a human, so a
 *     strict bound costs nothing extra. Strictness is free, so it is strict.
 *   * This one bounds a number PRINTED ON THE PAPER and read by a parser that
 *     found it at a position it recognises, on EVERY receipt the platform
 *     scans. A false positive here is a real customer waiting on a review
 *     queue for a purchase they genuinely made. Set it at PHP 10,000 and every
 *     large-party restaurant bill and every bulk resupply in the country lands
 *     in the queue.
 *
 * PHP 20,000.00 is where a single transaction at a PH food-service or small
 * retail SME - this platform's whole target market - stops being large and
 * starts being unusual enough that a human should glance at it before points
 * are minted. It is also a fifth of the PHP 99,999 an injected total reaches
 * for, so the attack the finding describes cannot clear it.
 *
 * NO FLOOR IS DEFINED, and that asymmetry is deliberate. extract.ts pairs its
 * ceiling with a PHP 1.00 minimum because a sub-peso "total" from a model is
 * evidence the model grabbed the wrong token - a statement about the
 * extraction. The deterministic tiers read a money token that is actually
 * printed, and the attack this file defends against is an INFLATED total: a
 * deflated one awards the consumer fewer points than they earned, which no
 * attacker wants. Meanwhile PHP 1.00 and PHP 5.00 purchases are the ordinary
 * case at a sari-sari store, so a floor here would buy nothing on the money
 * path and would put the smallest, most frequent legitimate transactions in
 * the review queue.
 */
const DEFAULT_MAX_TOTAL_CENTAVOS = 2_000_000;

/**
 * What the pipeline runs on when the registry is missing, unreachable, or
 * unreadable. Every number here is the documented platform default and is
 * asserted against both the engines' constants and the 0017 seed in the tests.
 */
export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  phashBands: PHASH_BANDS,
  velocityCaps: DEFAULT_VELOCITY_CAPS,
  fraudReviewThreshold: DEFAULT_FRAUD_REVIEW_THRESHOLD,
  cooldownStrikes: DEFAULT_COOLDOWN_STRIKES,
  cooldownHours: DEFAULT_COOLDOWN_HOURS,
  routing: DEFAULT_ROUTING_THRESHOLDS,
  ocrMaxAttempts: DEFAULT_OCR_MAX_ATTEMPTS,
  maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  maxTotalCentavos: DEFAULT_MAX_TOTAL_CENTAVOS,
};

// ---------------------------------------------------------------------------
// Per-key validation
// ---------------------------------------------------------------------------

// A probability-shaped threshold. Outside 0-1 it is not a tuning choice, it is
// a mistake: a review threshold of 1.4 can never be reached and silently
// disables fraud routing altogether.
const unitInterval = z.number().min(0).max(1);

// A pHash hamming distance. 64 is every bit of the hash differing
// (phash.ts PHASH_BITS), so nothing above it can be meaningful.
const hammingDistance = z.number().int().min(0).max(64);

// A behavioural window cap. Zero is allowed (every scan in the window trips
// the signal, a legitimate lockdown setting for one abused business); negative
// is not, since `count > cap` would then fire on the very first receipt with
// no way to read that as intent.
const windowCap = z.number().int().min(0).max(100_000);

const strikeCount = z.number().int().min(1).max(100);
// Upper bound of one year. The cooldown auto-expires by design (doc 37 step 2
// is "automatic, auto-expiring, audited"); a fat-fingered 100000 would be an
// unaudited permanent ban, which is step 4's decision, not this row's.
const cooldownHours = z.number().int().min(1).max(8_760);
const attemptCount = z.number().int().min(1).max(10);
// Validated as any integer, then clamped: doc 36 Stage 8 specifies "clamp
// 1-30" for this key specifically, so an out-of-range number is a value to
// bound rather than a value to reject.
const ageDays = z.number().int();

// The platform amount ceiling, in integer centavos. Rejected rather than
// clamped, because doc 36 registers no clamp for this key and the two failure
// directions are not symmetric: a fractional or negative value is a typo, and
// anything above PHP 10,000,000.00 is not a merchant with big tills, it is a
// ceiling switched off by accident - which is exactly the state this key exists
// to make impossible. Falling back to the documented default and logging is the
// only reading that cannot silently disable the check.
const totalCeilingCentavos = z.number().int().min(1).max(1_000_000_000);

const MAX_AGE_DAYS_MIN = 1;
const MAX_AGE_DAYS_MAX = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Candidate values for a key, in precedence order (highest first). Kept as
 * separate scopes rather than pre-merged so that a malformed business override
 * falls through to the valid platform row underneath it, instead of shadowing
 * it and dropping the whole key to its hardcoded default. The broken thing is
 * the override; the platform row is still good.
 */
interface ScopedValues {
  readonly business: ReadonlyMap<string, unknown>;
  readonly platform: ReadonlyMap<string, unknown>;
}

/**
 * Bucket the rows by scope. Rows for another business, or business rows when
 * no business is in scope, are dropped: the service-role read is not
 * RLS-filtered, so this is the only thing standing between one tenant's
 * override and another tenant's pipeline.
 */
function collapseRows(rows: readonly SettingsRow[], businessId?: string): ScopedValues {
  const platform = new Map<string, unknown>();
  const business = new Map<string, unknown>();

  for (const row of rows) {
    if (row.scope === "platform" && row.business_id === null) {
      platform.set(row.key, row.value);
      continue;
    }
    if (
      row.scope === "business" &&
      businessId !== undefined &&
      row.business_id === businessId
    ) {
      business.set(row.key, row.value);
    }
  }

  return { business, platform };
}

/**
 * Validate one key: business scope, then platform scope, then the hardcoded
 * default, taking the first candidate that parses and logging every one that
 * does not. The log is the point: a threshold silently reverting is
 * indistinguishable from a threshold that was never tuned, and the operator
 * who typed "0.9" into a jsonb column needs to find out.
 */
function readValue<T>(
  values: ScopedValues,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  for (const [scope, source] of [
    ["business", values.business],
    ["platform", values.platform],
  ] as const) {
    if (!source.has(key)) continue;

    const raw = source.get(key);
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;

    console.warn(
      `[receipt-settings] ignoring malformed ${scope}-scope value for "${key}"`,
      { value: raw, issues: parsed.error.issues.map((issue) => issue.message) },
    );
  }

  return fallback;
}

/**
 * Pure resolution of rows into the typed settings object. Exported separately
 * from the loader so the precedence, validation and clamping rules are
 * testable without a database, and so a future admin preview screen can show
 * what a proposed row set would resolve to.
 */
export function resolveReceiptSettings(
  rows: readonly SettingsRow[],
  businessId?: string,
): ReceiptSettings {
  const values = collapseRows(rows, businessId);

  const velocityCaps = {} as Record<VelocityWindow, VelocityCap>;
  for (const window of VELOCITY_WINDOWS) {
    const fallback = DEFAULT_VELOCITY_CAPS[window];
    velocityCaps[window] = {
      cap: readValue(values, VELOCITY_KEY_BY_WINDOW[window], windowCap, fallback.cap),
      severity: fallback.severity,
      score: fallback.score,
    };
  }

  return {
    phashBands: {
      blockDistance: readValue(
        values,
        "fraud.phash_block_distance",
        hammingDistance,
        PHASH_BANDS.blockDistance,
      ),
      warnDistance: readValue(
        values,
        "fraud.phash_warn_distance",
        hammingDistance,
        PHASH_BANDS.warnDistance,
      ),
    },
    velocityCaps,
    fraudReviewThreshold: readValue(
      values,
      "fraud.review_threshold",
      unitInterval,
      DEFAULT_FRAUD_REVIEW_THRESHOLD,
    ),
    cooldownStrikes: readValue(
      values,
      "fraud.cooldown_strikes",
      strikeCount,
      DEFAULT_COOLDOWN_STRIKES,
    ),
    cooldownHours: readValue(
      values,
      "fraud.cooldown_hours",
      cooldownHours,
      DEFAULT_COOLDOWN_HOURS,
    ),
    routing: {
      approve: readValue(
        values,
        "ocr.approve_threshold",
        unitInterval,
        DEFAULT_ROUTING_THRESHOLDS.approve,
      ),
      review: readValue(
        values,
        "ocr.review_threshold",
        unitInterval,
        DEFAULT_ROUTING_THRESHOLDS.review,
      ),
      // No registered settings key (doc 36 Stage 5 states these as fixed
      // bands), so the engine constant is the only source.
      matchAccept: DEFAULT_ROUTING_THRESHOLDS.matchAccept,
      matchReview: DEFAULT_ROUTING_THRESHOLDS.matchReview,
    },
    ocrMaxAttempts: readValue(
      values,
      "ocr.max_attempts",
      attemptCount,
      DEFAULT_OCR_MAX_ATTEMPTS,
    ),
    maxAgeDays: clamp(
      readValue(values, "receipts.max_age_days", ageDays, DEFAULT_MAX_AGE_DAYS),
      MAX_AGE_DAYS_MIN,
      MAX_AGE_DAYS_MAX,
    ),
    // Business scope wins here by the same `readValue` precedence every other
    // key uses, which is the whole point: a merchant who genuinely rings up
    // more than the platform default raises their own bound once, and the
    // ceiling stays a review trigger rather than becoming a business rule.
    maxTotalCentavos: readValue(
      values,
      "receipts.max_total_centavos",
      totalCeilingCentavos,
      DEFAULT_MAX_TOTAL_CENTAVOS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const businessIdSchema = z.string().uuid();

async function loadReceiptSettings(businessId?: string): Promise<ReceiptSettings> {
  let scopedBusinessId: string | undefined;
  if (businessId !== undefined) {
    // The id is interpolated into a PostgREST `or` filter below, so it is
    // validated as a uuid first. Every caller passes a value that came out of
    // our own database, but "every caller" is a property of today's code, not
    // of the function, and the cost of being wrong is a filter-injected read
    // through the service role.
    const parsed = businessIdSchema.safeParse(businessId);
    if (parsed.success) {
      scopedBusinessId = parsed.data;
    } else {
      console.warn(
        "[receipt-settings] ignoring a business id that is not a uuid; reading platform scope only",
      );
    }
  }

  try {
    const supabase = createServiceRoleClient();
    if (supabase === null) {
      console.warn(
        "[receipt-settings] SUPABASE_SERVICE_ROLE_KEY is not configured; using default thresholds",
      );
      return DEFAULT_RECEIPT_SETTINGS;
    }

    const query = supabase
      .from("settings")
      .select("scope, business_id, key, value")
      .in("key", [...RECEIPT_SETTINGS_KEYS]);

    const { data, error } =
      scopedBusinessId === undefined
        ? await query.is("business_id", null)
        : await query.or(`business_id.is.null,business_id.eq.${scopedBusinessId}`);

    if (error !== null) {
      console.error("[receipt-settings] read failed, using default thresholds", error);
      return DEFAULT_RECEIPT_SETTINGS;
    }

    return resolveReceiptSettings(data ?? [], scopedBusinessId);
  } catch (unexpected) {
    console.error("[receipt-settings] read threw, using default thresholds", unexpected);
    return DEFAULT_RECEIPT_SETTINGS;
  }
}

/**
 * The pipeline's settings reader. Business-scope rows override platform-scope
 * rows; anything missing or malformed degrades to DEFAULT_RECEIPT_SETTINGS.
 *
 * Memoized with React `cache`, which dedupes for the lifetime of ONE request
 * and nothing longer. That is the whole requirement: a single receipt's
 * processing reads thresholds at the validate, fraud and route stages, and
 * those three reads should be one query, while doc 37's premise is that a
 * threshold retuned in the database is live WITHOUT A DEPLOY. A module-level
 * or TTL cache would trade that premise away for a query we do not need to
 * save; there is deliberately no TTL here.
 *
 * Outside a request scope (the queue worker that doc 36 Stage 2 anticipates)
 * React `cache` degrades to calling straight through, so the worker simply
 * pays for its reads. Slower, never stale, and never wrong.
 */
export const getReceiptSettings = cache(loadReceiptSettings);
