import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isCampaignLive } from "@/features/campaigns/lifecycle";
import type { Campaign, CampaignType } from "@/features/campaigns/types";
import { computePoints } from "@/features/points/compute";
import { ruleConditionsSchema } from "@/features/points/conditions";
import type {
  PointsRule,
  RoundingMode,
  RuleConditions,
  RuleKind,
  RuleTier,
  RuleType,
} from "@/features/points/types";
import { expireNx, incr, redisKey } from "@/lib/redis";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import {
  parseConfidence,
  routeReceipt,
  shouldEmitLowConfidenceSignal,
} from "../confidence";
import { buildSignal, fraudVerdict } from "../fraud";
import type { FraudSignal } from "../fraud";
import { matchBusiness, trigramSimilarity } from "../matching";
import type { MatchCandidate } from "../matching";
import { parseReceipt } from "../parse";
import type { ParseConfig, ParsedReceipt } from "../parse";
import { hammingDistance, phashBand } from "../phash";
import type {
  FieldSource,
  FraudRejectReason,
  ReceiptRejectReason,
  RouteOutcome,
} from "../types";
import { evaluateVelocity } from "../velocity";
import type { VelocityCounts, VelocityWindow } from "../velocity";
import { getOcrProvider, OcrError } from "./ocr/provider";
import type { OcrBlock, OcrProvider, OcrResponse } from "./ocr/provider";
import { getReceiptSettings } from "./settings";
import type { ReceiptSettings } from "./settings";

// ===========================================================================
// The receipt processing orchestration: doc 36's Stages 2 through 10 in one
// place, ending in the award RPC (supabase/migrations/0018_award_receipt_points
// .sql), which is the second and last place in the system that writes the
// points ledger.
//
// QUEUE-SHAPED ON PURPOSE. `processReceipt` takes ONE receipt id and nothing
// else: no request context, no session, no supplied payload. Doc 36 Stage 2
// puts this behind the `ocr.process` QStash queue, and the jobs slice will
// swap today's synchronous call (from the submit endpoint) for an enqueue plus
// a Route Handler that unwraps `{receipt_id}` and calls exactly this function.
// That swap has to be mechanical, which is why every fact this function needs
// is re-read from the database under the service role rather than passed in.
//
// IT NEVER THROWS. Every failure is either a terminal receipt status or a
// retryable state the next attempt picks up (see "Failure handling" below).
// A pipeline that throws would either take down a caller that must still
// answer 202, or - once queued - retry forever on a permanent failure.
//
// ORDER OF WRITES is load-bearing and not obvious, so it is stated once here:
//
//   1. status='processing'         claim the receipt (doc 36 Stage 2)
//   2. ocr_results + ai_usage_events   evidence and metering, one row per
//                                      attempt (UNIQUE (receipt_id, attempt))
//   3. ONE update to receipts      business_id + every parsed field + both
//                                  confidences + parse_meta + the terminal
//                                  status, together
//   4. fraud_signals, receipt_line_items
//   5. award_receipt_points        approved path only, points > 0 only
//
// Step 3 is a single statement rather than "persist parse, then set status"
// for two reasons that both bite:
//   * `receipts_number_unique` (0017) is a partial unique index over status in
//     ('approved','review','processing'). Writing `receipt_number` while the
//     row is still 'processing' would raise 23505 for a receipt we are about
//     to reject as a duplicate anyway - the rejection has to land in the same
//     statement that writes the number, because rejected rows are outside the
//     index.
//   * `fraud_signals` and `receipt_line_items` both carry a composite FK
//     (receipt_id, business_id) -> receipts (id, business_id) (0017). Their
//     denormalized business_id is only insertable once the parent receipt
//     already names that tenant, so step 3 must precede step 4.
//
// Docs: docs/30-modules/36-receipt-ocr-pipeline.md (Stages 2-10, retry/DLQ),
// docs/30-modules/37-fraud-detection.md (signals S1-S9, scoring, ladder step
// 2), docs/30-modules/35-points-engine.md (award, rule_snapshot),
// docs/20-data/24-schema-receipts-ai.md (storage contract).
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Private bucket created by 0019_receipts_storage.sql. */
const RECEIPTS_BUCKET = "receipts";
/** Doc 36 Stage 4 / doc 15: 5-minute signed URL to the receipts object. */
const SIGNED_URL_TTL_SECONDS = 300;
/** Every PH paper receipt's wall clock, and the zone doc 40 defines days in. */
const RECEIPT_TIMEZONE = "Asia/Manila";
/** Doc 36 Stage 8 "Not future": `receipt_date <= now() + 24h` (TZ grace). */
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;
/** Doc 37 S1 MVP candidate set: same business, last 90 days. */
const PHASH_LOOKBACK_DAYS = 90;
/**
 * Cap on either half of the pHash candidate set. Doc 37 says candidate sets
 * are "small enough that no BK-tree is needed until [SCALE]"; this is what
 * keeps that true for a consumer with years of history, and it takes the most
 * recent rows because a replay attack reuses a recent image.
 */
const PHASH_CANDIDATE_LIMIT = 500;
/** Doc 37 consequences ladder step 2: strikes counted over 30 days. */
const COOLDOWN_WINDOW_DAYS = 30;
/** Doc 37 S7 round-number abuse: "last >= 5 approved receipts". */
const ROUND_NUMBER_STREAK = 5;
/** PHP 100.00. Doc 37 S7's `total_centavos % 10000 = 0`. */
const ROUND_NUMBER_MODULUS = 10_000;

/**
 * The statuses `receipts_number_unique` covers (0017). A number held by one of
 * these rows is a LIVE claim; a rejected row's number is free to reuse, which
 * is what makes honest resubmission after a rejection work.
 */
const LIVE_STATUSES = ["approved", "review", "processing"] as const;

/**
 * Doc 37 ladder step 2 counts "fraud-family rejections". These are exactly the
 * two reasons `fraudVerdict` can produce; `unreadable`, `too_old`,
 * `wrong_business` and `manual` are quality or matching outcomes and must
 * never accumulate toward a scan block.
 */
const FRAUD_FAMILY_REJECT_REASONS: readonly ReceiptRejectReason[] = [
  "duplicate",
  "fraud_suspected",
];

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The two Redis commands the velocity windows need (doc 37 S4). */
export interface VelocityRedis {
  incr(key: string): Promise<number>;
  expireNx(key: string, seconds: number): Promise<boolean>;
}

/**
 * Everything this module talks to that is not pure. Injected rather than
 * imported at the call sites so the whole stage chain is exercisable without a
 * database, a storage bucket, an OCR container or a Redis instance - which is
 * the only way a money path this long gets honestly tested.
 */
export interface ProcessReceiptDeps {
  /** SERVICE ROLE. Every receipt write is service-role by RLS design (0017). */
  supabase: SupabaseClient<Database>;
  ocr: OcrProvider;
  /** Business scope overrides platform scope; never throws (see settings.ts). */
  loadSettings: (businessId?: string) => Promise<ReceiptSettings>;
  redis: VelocityRedis;
  now: () => Date;
}

/**
 * The production wiring. Returns null when the service-role key is absent
 * (createServiceRoleClient's documented degraded path) or when the OCR
 * provider is half-configured, because both of those are deployment mistakes
 * that must fail loudly in the log rather than silently mis-process a receipt.
 */
export function defaultProcessReceiptDeps(): ProcessReceiptDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts/process] SUPABASE_SERVICE_ROLE_KEY is not configured; cannot process receipts",
    );
    return null;
  }
  try {
    return {
      supabase,
      ocr: getOcrProvider(),
      loadSettings: getReceiptSettings,
      redis: { incr, expireNx },
      now: () => new Date(),
    };
  } catch (error) {
    console.error("[receipts/process] OCR provider is misconfigured", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  business_id: string | null;
  user_id: string;
  status: string;
  image_path: string;
  image_hash: string;
  device_id: string | null;
  created_at: string;
}

export interface TemplateRow {
  id: string;
  source_kind: string;
  parse_config: Json;
}

export interface SelectedTemplate {
  id: string;
  sourceKind: string;
  config: ParseConfig;
}

interface PostgrestFailure {
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Round-trip through JSON exactly as the wire would. Used for every jsonb
 * column this module writes (`evidence`, `parse_meta`, `rule_snapshot`): it
 * drops `undefined` keys, proves the value is serializable before it reaches
 * the driver, and keeps the stored document identical to the one reasoned
 * about here.
 */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/** numeric(4,3) is the domain of both confidence columns (0017). Rounding here
 * means the value routed on and the value a reviewer reads back are the same
 * number; `routeReceipt` quantizes to the same precision internally. */
function toStoredConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isUniqueViolation(error: PostgrestFailure | null): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

/** The Asia/Manila calendar day of an instant, as `YYYY-MM-DD`. Doc 40's
 * timezone canon, and the bucket every daily velocity window is keyed by. */
function manilaDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RECEIPT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * `image_path` is bucket-relative (`{user_id}/{uuid}.jpg`, doc 15 / spec 3.3),
 * but doc 36 Stage 1 writes the same path once as `receipts/{user_id}/...`.
 * Accept both. A user id is a uuid and can never be the literal "receipts", so
 * stripping the prefix cannot corrupt a legitimate path.
 */
function toObjectPath(imagePath: string): string {
  const prefix = `${RECEIPTS_BUCKET}/`;
  return imagePath.startsWith(prefix) ? imagePath.slice(prefix.length) : imagePath;
}

// ---------------------------------------------------------------------------
// parse_config sanitization
// ---------------------------------------------------------------------------
//
// `receipt_templates.parse_config` is jsonb authored by business staff in the
// portal, so nothing about its shape is guaranteed. parse.ts is already
// defensive about the two untrusted REGEX fields (length caps, a nested
// quantifier check, bounded input), but it reasonably assumes that a keyword
// list contains strings: a number in `total_keywords` would reach
// `String.prototype.trim` and throw, taking down the receipt.
//
// Sanitizing here rather than trusting the column keeps that failure mode out
// of the pipeline entirely, and it degrades per FIELD: one malformed key drops
// only itself, never the whole template.
//
// One distinction is preserved deliberately: an EMPTY `tax_keywords` array is
// meaningful (parse.ts reads it as "non-VAT business, skip the 12% check"), so
// empty arrays survive while non-arrays become absent.

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function verticalBand(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const top = optionalNumber(value[0]);
  const bottom = optionalNumber(value[1]);
  if (top === undefined || bottom === undefined) return undefined;
  return [top, bottom];
}

function layoutRegion(value: unknown): { y?: [number, number]; align?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const region: { y?: [number, number]; align?: string } = {};
  const band = verticalBand(value.y);
  if (band !== undefined) region.y = band;
  const align = optionalString(value.align);
  if (align !== undefined) region.align = align;
  return region;
}

export function sanitizeParseConfig(raw: unknown): ParseConfig {
  const source = isRecord(raw) ? raw : {};
  const config: ParseConfig = {};

  const aliases = stringArray(source.merchant_aliases);
  if (aliases !== undefined) config.merchant_aliases = aliases;
  const tin = optionalString(source.tin);
  if (tin !== undefined) config.tin = tin;
  const receiptNoRegex = optionalString(source.receipt_no_regex);
  if (receiptNoRegex !== undefined) config.receipt_no_regex = receiptNoRegex;
  const dateFormats = stringArray(source.date_formats);
  if (dateFormats !== undefined) config.date_formats = dateFormats;
  const totalKeywords = stringArray(source.total_keywords);
  if (totalKeywords !== undefined) config.total_keywords = totalKeywords;
  const subtotalKeywords = stringArray(source.subtotal_keywords);
  if (subtotalKeywords !== undefined) config.subtotal_keywords = subtotalKeywords;
  const taxKeywords = stringArray(source.tax_keywords);
  if (taxKeywords !== undefined) config.tax_keywords = taxKeywords;
  const lineItemPattern = optionalString(source.line_item_pattern);
  if (lineItemPattern !== undefined) config.line_item_pattern = lineItemPattern;

  if (isRecord(source.layout_anchors)) {
    const anchors: NonNullable<ParseConfig["layout_anchors"]> = {};
    const header = layoutRegion(source.layout_anchors.header);
    if (header !== undefined) anchors.header = header;
    const lineItems = layoutRegion(source.layout_anchors.line_items);
    if (lineItems !== undefined) anchors.line_items = lineItems;
    const totals = layoutRegion(source.layout_anchors.totals);
    if (totals !== undefined) anchors.totals = totals;
    const footerKeywords = stringArray(source.layout_anchors.footer_keywords);
    if (footerKeywords !== undefined) anchors.footer_keywords = footerKeywords;
    config.layout_anchors = anchors;
  }

  if (isRecord(source.amount_sanity)) {
    const bounds: NonNullable<ParseConfig["amount_sanity"]> = {};
    const min = optionalNumber(source.amount_sanity.min_total_centavos);
    if (min !== undefined) bounds.min_total_centavos = min;
    const max = optionalNumber(source.amount_sanity.max_total_centavos);
    if (max !== undefined) bounds.max_total_centavos = max;
    config.amount_sanity = bounds;
  }

  if (isRecord(source.handwriting)) {
    const handwriting: NonNullable<ParseConfig["handwriting"]> = {};
    const minBlockConf = optionalNumber(source.handwriting.min_block_conf);
    if (minBlockConf !== undefined) handwriting.min_block_conf = minBlockConf;
    if (typeof source.handwriting.digits_only_amounts === "boolean") {
      handwriting.digits_only_amounts = source.handwriting.digits_only_amounts;
    }
    config.handwriting = handwriting;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Stage 6 - template selection
// ---------------------------------------------------------------------------

/**
 * Doc 36 Stage 6's layout heuristics, applied to what the OCR service actually
 * returned: dense monospaced lines plus a VAT block means `pos`; a letterhead
 * with "INVOICE"/"SI No." means `invoice`; low block alignment plus low OCR
 * confidence means `handwritten`.
 */
export function detectSourceKind(response: {
  rawText: string;
  blocks: OcrBlock[];
  meanConfidence: number;
}): "pos" | "invoice" | "handwritten" {
  const text = response.rawText.toUpperCase();
  const leftEdges = response.blocks.map((block) => block.bbox[0]);
  const distinctLeftEdges = new Set(leftEdges).size;
  // A POS or an invoice prints from a fixed left margin, so nearly every block
  // shares a handful of x origins. A pad written by hand does not.
  const alignmentRatio =
    leftEdges.length === 0 ? 0 : 1 - (distinctLeftEdges - 1) / leftEdges.length;

  if (response.meanConfidence < 0.6 && alignmentRatio < 0.6) return "handwritten";
  if (/\bINVOICE\b/.test(text) || /\bSI\s*NO\b/.test(text)) return "invoice";
  return "pos";
}

/**
 * Doc 36 Stage 6 selection: score each active validated template of the
 * matched business by its `source_kind` layout heuristic and by the fraction
 * of its `layout_anchors` that are actually present, highest scorer wins.
 *
 * Two readings the doc leaves open, decided here:
 *
 *   * A business with exactly ONE active validated template always wins with
 *     it, score irrelevant. There is nothing to disambiguate, and refusing to
 *     use it would throw away the receipt_no_regex and date_formats the owner
 *     configured precisely so their receipts parse.
 *   * With SEVERAL templates and no distinguishing evidence at all (every
 *     score 0), no winner is declared and the generic tier runs. Picking one
 *     arbitrarily would apply another layout's regexes to this receipt, which
 *     silently mis-parses rather than under-parses.
 */
export function selectTemplate(
  templates: readonly TemplateRow[],
  response: { rawText: string; blocks: OcrBlock[]; meanConfidence: number },
): SelectedTemplate | null {
  if (templates.length === 0) return null;

  const only = templates[0];
  if (templates.length === 1 && only !== undefined) {
    return {
      id: only.id,
      sourceKind: only.source_kind,
      config: sanitizeParseConfig(only.parse_config),
    };
  }

  const detectedKind = detectSourceKind(response);
  const haystack = response.rawText.toUpperCase();

  let best: { template: SelectedTemplate; score: number } | null = null;
  for (const row of templates) {
    const config = sanitizeParseConfig(row.parse_config);
    const anchors = config.layout_anchors?.footer_keywords ?? [];
    const anchorHits = anchors.filter((keyword) =>
      haystack.includes(keyword.toUpperCase()),
    ).length;
    const anchorScore = anchors.length === 0 ? 0 : anchorHits / anchors.length;
    const kindScore = row.source_kind === detectedKind ? 1 : 0;
    const score = 0.5 * anchorScore + 0.5 * kindScore;

    if (best === null || score > best.score) {
      best = {
        template: { id: row.id, sourceKind: row.source_kind, config },
        score,
      };
    }
  }

  if (best === null || best.score <= 0) return null;
  return best.template;
}

// ---------------------------------------------------------------------------
// Stage 8 - validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  /** Set when doc 36 Stage 8 rejects outright. */
  rejection: ReceiptRejectReason | null;
  /** Amount sanity: doc 36 Stage 8 routes these to a human, never rejects. */
  forceReview: boolean;
  /** History and context rows, folded into the fraud pass. */
  signals: FraudSignal[];
}

export function validateParsedReceipt(input: {
  parsed: ParsedReceipt;
  now: Date;
  maxAgeDays: number;
  businessVerifiedAt: Date | null;
}): ValidationResult {
  const { parsed, now, maxAgeDays, businessVerifiedAt } = input;
  const signals: FraudSignal[] = [];

  // Readability (doc 36 Stage 8 row 1). A receipt with no total cannot be
  // priced, and one with neither a date nor a number cannot be told apart from
  // any other receipt at that store.
  const readable =
    parsed.totalCentavos !== null &&
    (parsed.receiptDate !== null || parsed.receiptNumber !== null);
  if (!readable) {
    return { rejection: "unreadable", forceReview: false, signals };
  }

  const receiptDate = parsed.receiptDate;
  if (receiptDate !== null) {
    // Not future (doc 36 Stage 8 row 3): a signal, explicitly NOT a rejection.
    if (receiptDate.getTime() > now.getTime() + FUTURE_GRACE_MS) {
      signals.push(
        buildSignal("timestamp_future_dated", {
          kind: "future_dated",
          receipt_date: receiptDate.toISOString(),
          grace_hours: 24,
        }),
      );
    }

    // Freshness (row 2) and postdates-activation (row 4) both reject as
    // too_old, and doc 37 S5 wants a history row when they do.
    const freshnessFloor = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    if (receiptDate.getTime() < freshnessFloor) {
      signals.push(
        buildSignal("timestamp_too_old", {
          kind: "stale",
          receipt_date: receiptDate.toISOString(),
          max_age_days: maxAgeDays,
        }),
      );
      return { rejection: "too_old", forceReview: false, signals };
    }

    if (
      businessVerifiedAt !== null &&
      receiptDate.getTime() < businessVerifiedAt.getTime()
    ) {
      signals.push(
        buildSignal("timestamp_too_old", {
          kind: "predates_activation",
          receipt_date: receiptDate.toISOString(),
          business_verified_at: businessVerifiedAt.toISOString(),
        }),
      );
      return { rejection: "too_old", forceReview: false, signals };
    }
  }
  // A dateless receipt that passed readability on its number alone cannot be
  // tested for freshness at all. Doc 36 Stage 8 states both date rules in
  // terms of `receipt_date`, so an absent date skips them rather than failing
  // them; the missing date has already cost 0.20 of parse_confidence, which is
  // where that uncertainty is meant to be priced.

  // Amount sanity (row 6): route to review, never reject. `withinAmountSanity`
  // is null when the template declared no bounds.
  const forceReview = parsed.withinAmountSanity === false;

  return { rejection: null, forceReview, signals };
}

// ---------------------------------------------------------------------------
// Stage 7 fraud - velocity windows
// ---------------------------------------------------------------------------

interface VelocityWindowSpec {
  window: VelocityWindow;
  key: string;
  ttlSeconds: number;
}

function velocityWindowSpecs(input: {
  now: Date;
  userId: string;
  businessId: string | null;
  deviceId: string | null;
}): VelocityWindowSpec[] {
  const { now, userId, businessId, deviceId } = input;
  const day = manilaDay(now);
  const hourBucket = String(Math.floor(now.getTime() / 3_600_000));
  const tenMinuteBucket = String(Math.floor(now.getTime() / 600_000));

  const specs: VelocityWindowSpec[] = [
    {
      window: "consumer_hour",
      key: redisKey("receipts", "velocity", "consumer_hour", userId, hourBucket),
      ttlSeconds: 3_600,
    },
    {
      window: "consumer_day",
      key: redisKey("receipts", "velocity", "consumer_day", userId, day),
      ttlSeconds: 86_400,
    },
  ];

  if (businessId !== null) {
    specs.push(
      {
        window: "pair_day",
        key: redisKey("receipts", "velocity", "pair_day", userId, businessId, day),
        ttlSeconds: 86_400,
      },
      {
        window: "pair_10min",
        key: redisKey(
          "receipts",
          "velocity",
          "pair_10min",
          userId,
          businessId,
          tenMinuteBucket,
        ),
        ttlSeconds: 600,
      },
    );
  }

  if (deviceId !== null) {
    specs.push({
      window: "device_day",
      key: redisKey("receipts", "velocity", "device_day", deviceId, day),
      ttlSeconds: 86_400,
    });
  }

  return specs;
}

/**
 * Doc 37 S4's five sliding windows. Counts include the receipt being
 * processed, which is what makes the doc's own evidence example
 * (`{"window":"pair_10min","count":3,"cap":2}`) read correctly.
 *
 * FAILS OPEN, per window. Doc 37 is explicit that these counters are a hot
 * path and "losing Redis loses speed, never truth" (D4). A window whose INCR
 * failed is left ABSENT rather than zero: `evaluateVelocity` skips absent
 * windows, so an outage can neither manufacture a fraud signal nor suppress
 * the other four. This is the one detector that fails open; every other one in
 * this file reads Postgres, where an error is a real error.
 */
async function collectVelocityCounts(
  redis: VelocityRedis,
  specs: readonly VelocityWindowSpec[],
): Promise<VelocityCounts> {
  const counts: Partial<Record<VelocityWindow, number>> = {};
  for (const spec of specs) {
    try {
      const count = await redis.incr(spec.key);
      // Self-healing TTL, same argument as src/lib/rate-limit.ts: EXPIRE NX is
      // idempotent, so a key that lost its TTL repairs itself on the next scan
      // instead of counting up forever.
      await redis.expireNx(spec.key, spec.ttlSeconds);
      counts[spec.window] = count;
    } catch (error) {
      console.warn(
        `[receipts/process] velocity window "${spec.window}" unavailable; skipping it`,
        error,
      );
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

export interface PointsRuleRow {
  id: string;
  campaign_id: string | null;
  kind: string;
  rule_type: string;
  rate_centavos_per_point: number | null;
  fixed_points: number | null;
  tiers: Json | null;
  multiplier: number | null;
  bonus_points: number | null;
  conditions: Json;
  rounding: string;
}

export interface CampaignRow {
  id: string;
  type: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  priority: number;
  is_stackable: boolean;
}

const RULE_KINDS: readonly RuleKind[] = ["base", "multiplier", "bonus"];
const RULE_TYPES: readonly RuleType[] = [
  "amount_rate",
  "fixed_per_visit",
  "fixed_per_receipt",
  "tiered_amount",
];
const ROUNDING_MODES: readonly RoundingMode[] = ["floor", "round", "ceil"];

/**
 * Zod hands back an object whose optional keys are PRESENT with the value
 * `undefined`; `exactOptionalPropertyTypes` (on for this project) treats that
 * as different from an absent key. Rebuild explicitly so an unset condition is
 * genuinely absent, which is what `evaluateConditions` tests for.
 */
function toRuleConditions(parsed: {
  days?: number[] | undefined;
  time_from?: string | undefined;
  time_to?: string | undefined;
  min_amount_centavos?: number | undefined;
  birthday?: boolean | undefined;
  first_visit?: boolean | undefined;
}): RuleConditions {
  const conditions: RuleConditions = {};
  if (parsed.days !== undefined) conditions.days = parsed.days;
  if (parsed.time_from !== undefined) conditions.time_from = parsed.time_from;
  if (parsed.time_to !== undefined) conditions.time_to = parsed.time_to;
  if (parsed.min_amount_centavos !== undefined) {
    conditions.min_amount_centavos = parsed.min_amount_centavos;
  }
  if (parsed.birthday !== undefined) conditions.birthday = parsed.birthday;
  if (parsed.first_visit !== undefined) conditions.first_visit = parsed.first_visit;
  return conditions;
}

function toTiers(raw: Json | null): RuleTier[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tiers: RuleTier[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const min = optionalNumber(entry.min_centavos);
    const points = optionalNumber(entry.points);
    if (min === undefined || points === undefined) continue;
    const max = optionalNumber(entry.max_centavos);
    tiers.push({ minCentavos: min, maxCentavos: max ?? null, points });
  }
  return tiers.length > 0 ? tiers : undefined;
}

/**
 * A `points_rules` row as the pure engine wants it. Returns null for a row the
 * engine could not evaluate (an unknown kind/type/rounding, i.e. a value the
 * check constraints should have refused): dropping it under-awards, whereas
 * guessing a default would mint points from a row nobody authored.
 */
export function toPointsRule(row: PointsRuleRow): PointsRule | null {
  const kind = RULE_KINDS.find((candidate) => candidate === row.kind);
  const ruleType = RULE_TYPES.find((candidate) => candidate === row.rule_type);
  const rounding = ROUNDING_MODES.find((candidate) => candidate === row.rounding);
  if (kind === undefined || ruleType === undefined || rounding === undefined) {
    return null;
  }

  const parsedConditions = ruleConditionsSchema.safeParse(row.conditions ?? {});
  const rule: PointsRule = {
    id: row.id,
    kind,
    rule_type: ruleType,
    rounding,
    // A conditions blob that fails the DSL schema is treated as "always
    // applies" ONLY for the base rule's sake; for a multiplier or bonus that
    // would over-award, so the rule is dropped instead.
    conditions: parsedConditions.success ? toRuleConditions(parsedConditions.data) : {},
  };
  if (!parsedConditions.success && kind !== "base") return null;

  if (row.rate_centavos_per_point !== null) {
    rule.rate_centavos_per_point = row.rate_centavos_per_point;
  }
  if (row.fixed_points !== null) rule.fixed_points = row.fixed_points;
  const tiers = toTiers(row.tiers);
  if (tiers !== undefined) rule.tiers = tiers;
  if (row.multiplier !== null) rule.multiplier = row.multiplier;
  if (row.bonus_points !== null) rule.bonus_points = row.bonus_points;

  return rule;
}

/**
 * Doc 34 section 6 stacking, in its minimal form: campaign-attached candidate
 * rules are considered in campaign priority order (lower number wins, doc 34),
 * the first campaign always applies, and a later campaign joins it only when
 * every campaign involved is `is_stackable`. A non-stackable campaign
 * therefore applies alone.
 *
 * Rules with no campaign (business-default multipliers and bonuses) always
 * apply: they are not campaign offers and have nothing to stack against.
 *
 * This is deliberately conservative. Doc 34's full stacking engine is not part
 * of this slice and no shared pure implementation exists yet; handing every
 * live candidate to `computePoints` instead would silently ignore
 * `is_stackable` and OVER-award, which on a ledger is the expensive direction
 * to be wrong in.
 */
export function resolveStacking<T extends { campaignId: string | null }>(
  candidates: readonly T[],
  campaigns: ReadonlyMap<string, CampaignRow>,
): T[] {
  const ordered = [...candidates].sort((a, b) => {
    const left = a.campaignId === null ? null : campaigns.get(a.campaignId);
    const right = b.campaignId === null ? null : campaigns.get(b.campaignId);
    const leftPriority = left?.priority ?? Number.NEGATIVE_INFINITY;
    const rightPriority = right?.priority ?? Number.NEGATIVE_INFINITY;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (a.campaignId ?? "").localeCompare(b.campaignId ?? "");
  });

  const applied: T[] = [];
  const acceptedCampaignIds = new Set<string>();
  let acceptedIsExclusive = false;

  for (const candidate of ordered) {
    if (candidate.campaignId === null) {
      applied.push(candidate);
      continue;
    }
    if (acceptedCampaignIds.has(candidate.campaignId)) {
      applied.push(candidate);
      continue;
    }
    if (acceptedIsExclusive) continue;

    const campaign = campaigns.get(candidate.campaignId);
    if (campaign === undefined) continue;
    if (acceptedCampaignIds.size > 0 && !campaign.is_stackable) continue;

    acceptedCampaignIds.add(candidate.campaignId);
    if (!campaign.is_stackable) acceptedIsExclusive = true;
    applied.push(candidate);
  }

  return applied;
}

// ---------------------------------------------------------------------------
// The award RPC
// ---------------------------------------------------------------------------

interface AwardReceiptPointsArgs {
  p_receipt_id: string;
  p_points: number;
  p_rule_snapshot: Json;
  p_campaign_id: string | null;
  p_expires_at: string | null;
}

/**
 * `award_receipt_points` landed in 0018, AFTER the last regeneration of
 * src/lib/supabase/types.ts (which already carries every 0017 table but no
 * 0018 function), so the generated `Database["public"]["Functions"]` union does
 * not name it yet. This structural type is the 0018 signature verbatim and is
 * the single place the client is narrowed; regenerating the types deletes it.
 */
interface AwardRpcClient {
  rpc(
    name: "award_receipt_points",
    args: AwardReceiptPointsArgs,
  ): PromiseLike<{ data: unknown; error: PostgrestFailure | null }>;
}

// Every P0001 message 0018 raises. Each one is a distinct operational fact,
// and none of them may take the pipeline down: the receipt is already
// 'approved' in the database by the time the RPC is called, so the worst case
// is an approved receipt whose award needs support attention, which is
// recoverable, whereas a thrown error would strand the whole job.
const AWARD_ERROR_HANDLING: Record<string, string> = {
  // The idempotent case: a replayed job, or a race between two workers. The
  // pt_receipt_earn_once index did its job and there is nothing to fix.
  RECEIPT_ALREADY_AWARDED: "info",
  // Someone moved the receipt out of 'approved' between our update and the
  // RPC, or nulled its business/user. Nothing was minted; a reviewer decides.
  RECEIPT_NOT_AWARDABLE: "warn",
  // Doc 37 ladder step 3. The blacklist is checked before routing, so reaching
  // here means the segment changed mid-flight.
  CUSTOMER_BLACKLISTED: "warn",
  CUSTOMER_RECORD_MISSING: "error",
  // Guarded against upstream (points > 0 is checked before calling), so this
  // is a bug in this file if it ever appears.
  AWARD_POINTS_INVALID: "error",
  AWARD_RECEIPT_ID_REQUIRED: "error",
};

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

/**
 * Turn one queued receipt into an outcome, and - when that outcome is
 * `approved` and the business's rules price it above zero - into points.
 *
 * Queue-shaped: the id is the entire input, so the jobs slice can call this
 * from a QStash Route Handler with no other change (doc 36 Stage 2).
 *
 * Idempotent by status: a receipt that is not `queued` or `processing` is
 * acked and ignored, exactly as doc 36 Stage 2 requires. Re-running an
 * approved receipt therefore awards nothing a second time, and the
 * `pt_receipt_earn_once` index in the database is the backstop under that.
 */
export async function processReceipt(
  receiptId: string,
  deps: ProcessReceiptDeps | null = defaultProcessReceiptDeps(),
): Promise<void> {
  if (deps === null) return;

  try {
    await runPipeline(receiptId, deps);
  } catch (error) {
    // Last-resort net. Anything reaching here is unexpected (a driver fault, a
    // programming error), and the receipt is left in whatever state the last
    // successful write put it in. If that state is 'processing' the next
    // attempt picks it straight back up, because 'processing' is explicitly
    // retry-eligible in doc 36 Stage 2.
    // TODO(queue): once the jobs slice owns retries, rethrow here so QStash
    // sees a non-2xx and applies its backoff instead of relying on a later
    // sweep to notice the row.
    console.error(`[receipts/process] unexpected failure on receipt ${receiptId}`, error);
  }
}

async function runPipeline(receiptId: string, deps: ProcessReceiptDeps): Promise<void> {
  const { supabase, now } = deps;

  // ---- Stage 2: load and claim -------------------------------------------
  const { data: receipt, error: loadError } = await supabase
    .from("receipts")
    .select(
      "id, business_id, user_id, status, image_path, image_hash, device_id, created_at",
    )
    .eq("id", receiptId)
    .maybeSingle<ReceiptRow>();

  if (loadError !== null) {
    console.error(`[receipts/process] could not load receipt ${receiptId}`, loadError);
    return;
  }
  if (receipt === null) {
    console.warn(`[receipts/process] receipt ${receiptId} does not exist; acking`);
    return;
  }

  // Doc 36 Stage 2, verbatim: "if receipts.status is not queued/processing,
  // ack and exit". This is the whole of the job-level idempotency guarantee -
  // a redelivered QStash message, a double-click on a retry button, or a
  // second worker all land here and stop, so an already-approved receipt can
  // never be re-parsed, re-scored, or re-awarded.
  if (receipt.status !== "queued" && receipt.status !== "processing") {
    console.info(
      `[receipts/process] receipt ${receiptId} is already '${receipt.status}'; acking`,
    );
    return;
  }

  const settings = await deps.loadSettings(receipt.business_id ?? undefined);

  if (receipt.status === "queued") {
    const { error } = await supabase
      .from("receipts")
      .update({ status: "processing" })
      .eq("id", receiptId)
      .eq("status", "queued");
    if (error !== null) {
      console.error(`[receipts/process] could not claim receipt ${receiptId}`, error);
      return;
    }
  }

  // ---- Stages 3 and 4: signed URL, OCR, evidence -------------------------
  const attempt = await nextAttemptNumber(supabase, receiptId);

  let response: OcrResponse;
  try {
    response = await runOcr(deps, receipt, attempt);
  } catch (error) {
    await handleOcrFailure({ deps, receipt, attempt, settings, error });
    return;
  }

  const recorded = await recordOcrAttempt(supabase, receiptId, attempt, response);
  if (!recorded) return;
  await recordUsageEvent(supabase, receipt, attempt);

  // ---- Stages 5 to 7: templates, parse, matching -------------------------
  const templates = await loadTemplates(supabase, receipt.business_id);
  const template = selectTemplate(templates, response);
  const parsed = parseReceipt({
    rawText: response.rawText,
    blocks: response.blocks,
    ...(template === null ? {} : { config: template.config }),
  });

  const business = await loadBusiness(supabase, receipt.business_id);
  const candidates = buildMatchCandidates(business, templates, template);
  const match = matchBusiness({
    rawText: response.rawText,
    merchantName: parsed.merchantName,
    preBoundBusinessId: receipt.business_id,
    candidates,
    trigramSimilarity,
    thresholds: {
      accept: settings.routing.matchAccept,
      review: settings.routing.matchReview,
    },
  });
  const matchedBusinessId = match.businessId;

  // ---- Stage 8: validation -----------------------------------------------
  const businessVerifiedAt =
    business === null || business.verified_at === null
      ? null
      : new Date(business.verified_at);
  const validation = validateParsedReceipt({
    parsed,
    now: now(),
    maxAgeDays: settings.maxAgeDays,
    businessVerifiedAt,
  });

  // ---- Stage 8.5: fraud (doc 37) -----------------------------------------
  const customer = await loadCustomerPair(supabase, matchedBusinessId, receipt.user_id);
  const fraudSignals = await collectFraudSignals({
    deps,
    receipt,
    settings,
    parsed,
    response,
    matchedBusinessId,
    templateSourceKind: template?.sourceKind ?? null,
  });
  const signals = [...validation.signals, ...fraudSignals];
  const verdict = fraudVerdict(signals, settings.fraudReviewThreshold);

  // ---- Stage 9: confidence and routing -----------------------------------
  const confidence = parseConfidence({
    total: fieldSource(parsed.totalCentavos),
    date: fieldSource(parsed.receiptDate),
    receiptNumber: fieldSource(parsed.receiptNumber),
    meanOcrConfidence: response.meanConfidence,
    vatConsistent: parsed.vatConsistent,
  });

  // Doc 37 ladder step 3: a blacklisted customer's future receipts at that
  // business "force review". Checked HERE rather than after the award RPC
  // refuses with CUSTOMER_BLACKLISTED, because by then the receipt is already
  // 'approved' and would have to be walked backwards through a transition the
  // state machine does not draw.
  const blacklisted = customer?.segment === "blacklisted";
  const outcome = resolveOutcome({
    routed: routeReceipt({
      parseConfidence: confidence,
      matchConfidence: match.confidence,
      fraud: verdict,
      thresholds: settings.routing,
    }),
    validationRejection: validation.rejection,
    forceReview: validation.forceReview || blacklisted,
    matchedBusinessId,
  });

  // ---- Stage 10 preparation: price the receipt before writing 'approved' --
  const award =
    outcome.status === "approved" && matchedBusinessId !== null
      ? await priceReceipt({
          supabase,
          businessId: matchedBusinessId,
          receipt,
          parsed,
          isFirstVisit: (customer?.visit_count ?? 0) === 0,
        })
      : null;

  // ---- The single receipts write -----------------------------------------
  const parseMeta = buildParseMeta({
    parsed,
    match,
    template,
    response,
    attempt,
    confidence,
  });
  const persisted = await persistOutcome({
    supabase,
    receiptId,
    matchedBusinessId,
    parsed,
    templateId: template?.id ?? null,
    matchConfidence: match.confidence,
    parseConfidence: confidence,
    parseMeta,
    outcome,
    // The award RPC sets processed_at itself (0018 step 7), so the awarding
    // path deliberately leaves it null here rather than writing it twice and
    // having the two values disagree by a few milliseconds.
    processedAt: award !== null && award.points > 0 ? null : now(),
    now: now(),
  });

  const finalOutcome = persisted.outcome;
  if (persisted.duplicateNumber) {
    signals.push(
      buildSignal("receipt_number_live_conflict", {
        receipt_number: parsed.receiptNumber,
        detected_by: "receipts_number_unique",
      }),
    );
  }

  // ---- Evidence children (parent tenancy is now written) -----------------
  await writeFraudSignals(supabase, receipt, matchedBusinessId, signals);
  await writeLineItems(supabase, receipt.id, matchedBusinessId, parsed);

  // ---- Stage 10: the award ------------------------------------------------
  if (finalOutcome.status === "approved" && award !== null) {
    await awardPoints(supabase, receipt.id, award);
  }

  // ---- Doc 37 consequences ladder step 2 ---------------------------------
  if (
    finalOutcome.status === "rejected" &&
    FRAUD_FAMILY_REJECT_REASONS.includes(finalOutcome.reason)
  ) {
    await applyCooldownIfEarned(deps, receipt.user_id, settings);
  }

  console.info(
    `[receipts/process] receipt ${receiptId} -> ${finalOutcome.status}` +
      (finalOutcome.status === "rejected" ? ` (${finalOutcome.reason})` : "") +
      ` parse=${confidence} match=${match.confidence} signals=${signals.length}`,
  );
}

function fieldSource(value: unknown): FieldSource {
  // No LLM parse-assist tier at MVP (doc 36 Stage 7 tier 3 is [V1]), so every
  // extracted field is deterministic and therefore `validated`; `llm_assisted`
  // stays unused until that tier lands.
  return value === null || value === undefined ? "missing" : "validated";
}

// ---------------------------------------------------------------------------
// Outcome resolution
// ---------------------------------------------------------------------------

/**
 * Merge doc 36 Stage 8's terminal validation failures, doc 36 Stage 9's
 * confidence routing (already merged with doc 37's fraud table inside
 * `routeReceipt`), and the two "force a human to look" rules.
 *
 * Precedence, in order:
 *
 *  1. A fraud `block` outranks a validation rejection. It is the same argument
 *     confidence.ts makes for blocks outranking `unreadable`: a block is a
 *     deterministic statement about the SUBMISSION (this exact image or this
 *     exact number has been claimed already), while `too_old` or `unreadable`
 *     are statements about the paper or our own read of it. It is also the
 *     reason the cooldown ladder counts, and letting an abuser launder a
 *     duplicate into a softer reason by submitting a stale photo would be a
 *     hole.
 *  2. A validation rejection outranks everything else and is terminal.
 *  3. Otherwise the routed outcome, upgraded from `approved` to `review` when
 *     something demands a human (amount sanity, blacklisted customer).
 *  4. A `review` outcome with no business id is impossible by construction
 *     (match confidence 0 rejects as wrong_business first) and is converted
 *     anyway, because 0017 states the consequence in the schema itself: no RLS
 *     audience on this database can select a receipt whose business_id is
 *     null, so such a row would sit in a queue nobody can open, forever.
 */
export function resolveOutcome(input: {
  routed: RouteOutcome;
  validationRejection: ReceiptRejectReason | null;
  forceReview: boolean;
  matchedBusinessId: string | null;
}): RouteOutcome {
  const { routed, validationRejection, forceReview, matchedBusinessId } = input;

  let outcome: RouteOutcome = routed;
  if (routed.status === "rejected" && isFraudFamily(routed.reason)) {
    outcome = routed;
  } else if (validationRejection !== null) {
    outcome = { status: "rejected", reason: validationRejection };
  } else if (forceReview && routed.status === "approved") {
    outcome = { status: "review" };
  }

  if (outcome.status === "review" && matchedBusinessId === null) {
    return { status: "rejected", reason: "wrong_business" };
  }
  return outcome;
}

function isFraudFamily(reason: ReceiptRejectReason): reason is FraudRejectReason {
  return reason === "duplicate" || reason === "fraud_suspected";
}

// ---------------------------------------------------------------------------
// OCR stage
// ---------------------------------------------------------------------------

async function nextAttemptNumber(
  supabase: SupabaseClient<Database>,
  receiptId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("ocr_results")
    .select("attempt")
    .eq("receipt_id", receiptId)
    .order("attempt", { ascending: false })
    .limit(1);

  if (error !== null) {
    console.error(
      `[receipts/process] could not read attempt history for ${receiptId}`,
      error,
    );
  }
  const rows = (data ?? []) as Array<{ attempt: number }>;
  return (rows[0]?.attempt ?? 0) + 1;
}

async function runOcr(
  deps: ProcessReceiptDeps,
  receipt: ReceiptRow,
  attempt: number,
): Promise<OcrResponse> {
  const { data, error } = await deps.supabase.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(toObjectPath(receipt.image_path), SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    // Doc 36 "Retry, timeouts, DLQ" lists signed-URL expiry among the
    // RETRYABLE failures, and the image itself is never re-requested from the
    // consumer: a later attempt simply mints a fresh URL. Raised as an OcrError
    // so the attempt accounting below has one taxonomy to reason about.
    throw new OcrError("OCR_UNAVAILABLE", "Could not sign the receipt image URL", {
      retryable: true,
      ...(error === null ? {} : { cause: error }),
    });
  }

  return deps.ocr.ocr({
    // Correlates the container's log line with this exact attempt.
    requestId: `receipt-${receipt.id}-attempt-${attempt}`,
    imageUrl: data.signedUrl,
    preprocess: "auto",
    langs: ["en"],
    returnBlocks: true,
  });
}

async function recordOcrAttempt(
  supabase: SupabaseClient<Database>,
  receiptId: string,
  attempt: number,
  response: OcrResponse,
): Promise<boolean> {
  const { error } = await supabase.from("ocr_results").insert({
    receipt_id: receiptId,
    attempt,
    engine: response.engine,
    engine_version: response.engineVersion,
    raw_text: response.rawText,
    blocks: toJson(response.blocks),
    mean_confidence: toStoredConfidence(response.meanConfidence),
    preprocess_ops: response.preprocessOps,
    duration_ms: response.durationMs,
  });

  if (error === null) return true;

  if (isUniqueViolation(error)) {
    // UNIQUE (receipt_id, attempt) fired: another worker is already on this
    // attempt. Stop rather than racing it - doc 36 Stage 2's idempotency
    // contract is that a duplicate worker acks and exits.
    console.warn(
      `[receipts/process] attempt ${attempt} of receipt ${receiptId} already recorded; another worker owns it`,
    );
    return false;
  }
  console.error(
    `[receipts/process] could not record OCR attempt ${attempt} for ${receiptId}`,
    error,
  );
  return false;
}

/**
 * Doc 36 Stage 4: one `ai_usage_events` row per OCR call, so cost metering is
 * never retrofitted. `units=1` is one page.
 */
async function recordUsageEvent(
  supabase: SupabaseClient<Database>,
  receipt: ReceiptRow,
  attempt: number,
): Promise<void> {
  const { error } = await supabase.from("ai_usage_events").insert({
    business_id: receipt.business_id,
    user_id: receipt.user_id,
    kind: "ocr",
    units: 1,
    ref_id: receipt.id,
  });
  if (error !== null) {
    // Metering must never decide a receipt's fate: a lost meter row costs a
    // reporting cent, a failed receipt costs a customer.
    console.error(
      `[receipts/process] could not meter OCR attempt ${attempt} for ${receipt.id}`,
      error,
    );
  }
}

interface OcrFailureInput {
  deps: ProcessReceiptDeps;
  receipt: ReceiptRow;
  attempt: number;
  settings: ReceiptSettings;
  error: unknown;
}

/**
 * Doc 36 "Retry, timeouts, DLQ". Three outcomes, and the receipt is never left
 * in a state no future attempt can reach:
 *
 *   * IMAGE_UNREADABLE (422) is non-retryable and "falls through to the
 *     confidence/rejection path immediately" -> rejected / unreadable.
 *   * Any retryable failure with attempts left is left at status='processing',
 *     which doc 36 Stage 2 names as retry-eligible, so the next delivery
 *     resumes at the next attempt number.
 *   * Attempts exhausted -> rejected / manual with reject_note
 *     'processing_failed', the DLQ contract.
 */
async function handleOcrFailure(input: OcrFailureInput): Promise<void> {
  const { deps, receipt, attempt, settings, error } = input;
  const ocrError = error instanceof OcrError ? error : null;
  const code = ocrError?.code ?? "OCR_BAD_RESPONSE";
  // An unrecognized throw is treated as retryable: it is more likely a
  // transient fault than a permanent property of this image, and the attempt
  // budget bounds how long that optimism can last.
  const retryable = ocrError?.retryable ?? true;
  const message = error instanceof Error ? error.message : String(error);

  // Metered only when the service actually answered. A timeout or an
  // unreachable host consumed no page, and billing a call that never landed
  // would corrupt the very budget this meter exists to enforce.
  if (ocrError !== null && ocrError.status !== undefined) {
    await recordUsageEvent(deps.supabase, receipt, attempt);
  }

  // A24.1: `ocr_results.error` is per-attempt, which is exactly what makes
  // ocr.max_attempts countable. The row also keeps the attempt slot taken, so
  // a retry cannot silently reuse the number.
  const { error: insertError } = await deps.supabase.from("ocr_results").insert({
    receipt_id: receipt.id,
    attempt,
    // The engine that WOULD have answered. engine_version is genuinely unknown
    // on a failed call, and inventing one would pollute the version histogram
    // the OCR quality dashboards read.
    engine: deps.ocr.name === "stub" ? "stub" : "paddleocr",
    engine_version: "unknown",
    error: `${code}: ${message}`,
  });
  if (insertError !== null && !isUniqueViolation(insertError)) {
    console.error(
      `[receipts/process] could not record failed OCR attempt ${attempt} for ${receipt.id}`,
      insertError,
    );
  }

  if (code === "OCR_IMAGE_UNREADABLE") {
    await finalizeWithoutParse(deps, receipt.id, {
      status: "rejected",
      reason: "unreadable",
    });
    return;
  }

  // An OPERATOR failure, not a receipt failure. The provider marks both of
  // these non-retryable because retrying the same call is pointless, and it is
  // right about the call - but that is a statement about the credential, not
  // about this photograph. Rejecting here would burn every receipt submitted
  // during a token rotation, and no consumer action could recover them, so
  // they wait at 'processing' until the environment is fixed. The attempt
  // budget deliberately does not apply.
  if (code === "OCR_AUTH_FAILED" || code === "OCR_MISCONFIGURED") {
    console.error(
      `[receipts/process] OCR credentials are wrong (${code}); receipt ${receipt.id} is parked at 'processing' until they are fixed`,
    );
    return;
  }

  if (!retryable || attempt >= settings.ocrMaxAttempts) {
    console.error(
      `[receipts/process] receipt ${receipt.id} exhausted OCR attempts (${attempt}/${settings.ocrMaxAttempts}): ${code}`,
    );
    await finalizeWithoutParse(
      deps,
      receipt.id,
      { status: "rejected", reason: "manual" },
      "processing_failed",
    );
    return;
  }

  console.warn(
    `[receipts/process] receipt ${receipt.id} OCR attempt ${attempt} failed retryably (${code}); leaving it processing`,
  );
}

async function finalizeWithoutParse(
  deps: ProcessReceiptDeps,
  receiptId: string,
  outcome: Extract<RouteOutcome, { status: "rejected" }>,
  rejectNote?: string,
): Promise<void> {
  const { error } = await deps.supabase
    .from("receipts")
    .update({
      status: outcome.status,
      reject_reason: outcome.reason,
      reject_note: rejectNote ?? null,
      processed_at: deps.now().toISOString(),
    })
    .eq("id", receiptId);
  if (error !== null) {
    console.error(
      `[receipts/process] could not finalize receipt ${receiptId} as ${outcome.reason}`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadTemplates(
  supabase: SupabaseClient<Database>,
  businessId: string | null,
): Promise<TemplateRow[]> {
  if (businessId === null) return [];
  const { data, error } = await supabase
    .from("receipt_templates")
    .select("id, source_kind, parse_config")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .not("validated_at", "is", null)
    .is("deleted_at", null)
    .order("id", { ascending: true });

  if (error !== null) {
    // A template read failure degrades to the generic parse tier, which is a
    // worse parse, never a wrong one.
    console.error(
      `[receipts/process] could not load templates for business ${businessId}`,
      error,
    );
    return [];
  }
  return (data ?? []) as TemplateRow[];
}

interface BusinessRow {
  id: string;
  name: string;
  verified_at: string | null;
}

async function loadBusiness(
  supabase: SupabaseClient<Database>,
  businessId: string | null,
): Promise<BusinessRow | null> {
  if (businessId === null) return null;
  const { data, error } = await supabase
    .from("businesses")
    .select("id, name, verified_at")
    .eq("id", businessId)
    .maybeSingle<BusinessRow>();
  if (error !== null) {
    console.error(`[receipts/process] could not load business ${businessId}`, error);
    return null;
  }
  return data;
}

/**
 * Doc 36 Stage 5's candidate set.
 *
 * MVP is the pre-bound scan: the consumer scanned from a business page, so
 * there is exactly one candidate and matching runs as VERIFICATION. The
 * generic scan (no business_id, candidates scored across every active
 * business) is [V1] in doc 36 and is deliberately not implemented: with no
 * candidates `matchBusiness` returns a null business id, and `routeReceipt`
 * turns a match confidence of 0 into rejected / wrong_business - which is
 * precisely the behaviour 0017's own comment demands, rather than parking an
 * unmatchable receipt in a review queue no audience can read.
 */
function buildMatchCandidates(
  business: BusinessRow | null,
  templates: readonly TemplateRow[],
  selected: SelectedTemplate | null,
): MatchCandidate[] {
  if (business === null) return [];

  const aliases: string[] = [];
  let tin: string | null = null;
  for (const row of templates) {
    const config = sanitizeParseConfig(row.parse_config);
    aliases.push(...(config.merchant_aliases ?? []));
    if (tin === null && config.tin !== undefined) tin = config.tin;
  }

  return [
    {
      businessId: business.id,
      name: business.name,
      tin,
      merchantAliases: aliases,
      // Doc 36 Stage 5's "+0.05 for a validated-template structural match":
      // a template of this business won Stage 6 selection.
      hasValidatedTemplateMatch: selected !== null,
    },
  ];
}

interface CustomerPairRow {
  segment: string;
  visit_count: number;
}

async function loadCustomerPair(
  supabase: SupabaseClient<Database>,
  businessId: string | null,
  consumerId: string,
): Promise<CustomerPairRow | null> {
  if (businessId === null) return null;
  const { data, error } = await supabase
    .from("business_customers")
    .select("segment, visit_count")
    .eq("business_id", businessId)
    .eq("consumer_id", consumerId)
    .maybeSingle<CustomerPairRow>();
  if (error !== null) {
    console.error(
      `[receipts/process] could not load the customer pair for ${businessId}`,
      error,
    );
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Fraud detectors (doc 37 S1, S3, S4, S5, S7, S8, S9)
// ---------------------------------------------------------------------------

interface FraudInput {
  deps: ProcessReceiptDeps;
  receipt: ReceiptRow;
  settings: ReceiptSettings;
  parsed: ParsedReceipt;
  response: OcrResponse;
  matchedBusinessId: string | null;
  templateSourceKind: string | null;
}

async function collectFraudSignals(input: FraudInput): Promise<FraudSignal[]> {
  const signals: FraudSignal[] = [];

  signals.push(...(await detectImageHashDuplicate(input)));
  signals.push(...(await detectReceiptNumberDuplicate(input)));

  const counts = await collectVelocityCounts(
    input.deps.redis,
    velocityWindowSpecs({
      now: input.deps.now(),
      userId: input.receipt.user_id,
      businessId: input.matchedBusinessId,
      deviceId: input.receipt.device_id,
    }),
  );
  signals.push(...evaluateVelocity(counts, input.settings.velocityCaps));

  signals.push(...(await detectAmountAnomalies(input)));

  // S8: doc 36 Stage 9's trailing note. Never blocks; contextualizes review.
  if (shouldEmitLowConfidenceSignal(input.response.meanConfidence)) {
    signals.push(
      buildSignal("ai_mean_confidence_low", {
        mean_confidence: input.response.meanConfidence,
      }),
    );
  }

  signals.push(...(await detectStaffSelfScan(input)));

  return signals;
}

/**
 * S1 layer 2, the perceptual half (layer 1 is `receipts_sha_unique`, enforced
 * synchronously at submit and never reaching this pipeline).
 *
 * Candidate set is doc 37's MVP scope: the same consumer over all time, plus
 * the same business over 90 days. Platform-wide widening is [V1].
 *
 * Two readings the doc leaves open, decided here:
 *
 *   * Only the NEAREST neighbour produces a signal. `evidence` is specified as
 *     a single `matched_receipt_id`, one row per neighbour would flood the
 *     review UI on a busy store, and the nearest match dominates the composite
 *     anyway (a block beats every warn).
 *   * Receipts already in status 'rejected' are EXCLUDED from the candidate
 *     set, mirroring the live-status predicate of `receipts_number_unique`. A
 *     rejected receipt holds no claim on anything, and doc 36 is explicit that
 *     a consumer whose receipt was rejected "may resubmit"; without this
 *     exclusion a re-photograph of the same paper would be blocked as a
 *     duplicate of the very row that told them to try again.
 */
async function detectImageHashDuplicate(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, settings, matchedBusinessId } = input;
  const hash = receipt.image_hash;
  if (hash.length === 0) return [];

  const neighbours = new Map<string, { id: string; user_id: string; image_hash: string }>();

  const consumerHistory = await deps.supabase
    .from("receipts")
    .select("id, user_id, image_hash")
    .eq("user_id", receipt.user_id)
    .neq("id", receipt.id)
    .neq("status", "rejected")
    .order("created_at", { ascending: false })
    .limit(PHASH_CANDIDATE_LIMIT);

  if (consumerHistory.error !== null) {
    console.error("[receipts/process] pHash consumer history read failed", consumerHistory.error);
  }
  for (const row of (consumerHistory.data ?? []) as Array<{
    id: string;
    user_id: string;
    image_hash: string;
  }>) {
    neighbours.set(row.id, row);
  }

  if (matchedBusinessId !== null) {
    const businessHistory = await deps.supabase
      .from("receipts")
      .select("id, user_id, image_hash")
      .eq("business_id", matchedBusinessId)
      .gte("created_at", daysAgo(deps.now(), PHASH_LOOKBACK_DAYS))
      .neq("id", receipt.id)
      .neq("status", "rejected")
      .order("created_at", { ascending: false })
      .limit(PHASH_CANDIDATE_LIMIT);

    if (businessHistory.error !== null) {
      console.error(
        "[receipts/process] pHash business history read failed",
        businessHistory.error,
      );
    }
    for (const row of (businessHistory.data ?? []) as Array<{
      id: string;
      user_id: string;
      image_hash: string;
    }>) {
      neighbours.set(row.id, row);
    }
  }

  let nearest: { id: string; userId: string; distance: number } | null = null;
  for (const row of neighbours.values()) {
    let distance: number;
    try {
      distance = hammingDistance(hash, row.image_hash);
    } catch {
      // A malformed stored hash is a data problem, not this receipt's problem.
      continue;
    }
    if (nearest === null || distance < nearest.distance) {
      nearest = { id: row.id, userId: row.user_id, distance };
    }
  }
  if (nearest === null) return [];

  const band = phashBand(nearest.distance, settings.phashBands);
  if (band === null) return [];

  return [
    buildSignal(
      band.severity === "block" ? "phash_near_identical" : "phash_similar",
      {
        matched_receipt_id: nearest.id,
        hamming_distance: nearest.distance,
        matched_consumer_id: nearest.userId,
        // Doc 37: a 0-4 match across consumers is simultaneously ring evidence.
        cross_consumer: nearest.userId !== receipt.user_id,
      },
    ),
  ];
}

/**
 * S3. `receipts_number_unique` is the DB backstop; this detector exists so the
 * conflict is EXPLAINED (which receipt, whose, live or already rejected)
 * rather than surfacing as a bare 23505, and so a cross-consumer conflict is
 * recorded as ring evidence.
 */
async function detectReceiptNumberDuplicate(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, parsed, matchedBusinessId } = input;
  const number = parsed.receiptNumber;
  if (number === null || matchedBusinessId === null) return [];

  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id, user_id, status")
    .eq("business_id", matchedBusinessId)
    .eq("receipt_number", number)
    .neq("id", receipt.id)
    .limit(50);

  if (error !== null) {
    console.error("[receipts/process] receipt-number duplicate read failed", error);
    return [];
  }

  const rows = (data ?? []) as Array<{ id: string; user_id: string; status: string }>;
  const live = rows.find((row) =>
    (LIVE_STATUSES as readonly string[]).includes(row.status),
  );
  const target = live ?? rows[0];
  if (target === undefined) return [];

  return [
    buildSignal(
      live === undefined
        ? "receipt_number_prior_rejected"
        : "receipt_number_live_conflict",
      {
        matched_receipt_id: target.id,
        receipt_number: number,
        matched_consumer_id: target.user_id,
        cross_consumer: target.user_id !== receipt.user_id,
      },
    ),
  ];
}

/**
 * S7. Two of the doc's three patterns are implemented here:
 *
 *   * Outlier total, via the template's `amount_sanity.max_total_centavos`.
 *     Doc 37's preferred input is the business's trailing-90d p99 of approved
 *     totals from a daily rollup; that rollup belongs to the analytics slice
 *     and does not exist, so the doc's own documented fallback is used.
 *   * Round-number abuse on handwritten pads.
 *
 * The third (total vs the sum of line items) is emitted as `info` when the
 * receipt carries a complete set of priced line items. PH receipts are
 * VAT-INCLUSIVE, so item prices already carry VAT and the sum is compared
 * against `total_centavos`, not against `subtotal_centavos`; the doc says only
 * "beyond VAT tolerance" and does not say which.
 */
async function detectAmountAnomalies(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, parsed, matchedBusinessId, templateSourceKind } = input;
  const signals: FraudSignal[] = [];
  const total = parsed.totalCentavos;

  if (parsed.withinAmountSanity === false && total !== null) {
    signals.push(
      buildSignal("amount_outlier_total", {
        observed_centavos: total,
        source: "template_amount_sanity",
      }),
    );
  }

  if (total !== null && parsed.lineItems.length > 0) {
    const priced = parsed.lineItems.filter((item) => item.lineTotalCentavos !== null);
    if (priced.length === parsed.lineItems.length) {
      const sum = priced.reduce((acc, item) => acc + (item.lineTotalCentavos ?? 0), 0);
      const tolerance = Math.max(5, total * 0.005);
      if (Math.abs(sum - total) > tolerance) {
        signals.push(
          buildSignal("amount_total_vs_line_items", {
            observed_centavos: total,
            line_items_centavos: sum,
          }),
        );
      }
    }
  }

  if (
    templateSourceKind === "handwritten" &&
    matchedBusinessId !== null &&
    total !== null &&
    total % ROUND_NUMBER_MODULUS === 0
  ) {
    const { data, error } = await deps.supabase
      .from("receipts")
      .select("total_centavos")
      .eq("business_id", matchedBusinessId)
      .eq("user_id", receipt.user_id)
      .eq("status", "approved")
      .neq("id", receipt.id)
      .order("created_at", { ascending: false })
      .limit(ROUND_NUMBER_STREAK);

    if (error !== null) {
      console.error("[receipts/process] round-number streak read failed", error);
    } else {
      const rows = (data ?? []) as Array<{ total_centavos: number | null }>;
      const allRound =
        rows.length === ROUND_NUMBER_STREAK &&
        rows.every(
          (row) =>
            row.total_centavos !== null &&
            row.total_centavos % ROUND_NUMBER_MODULUS === 0,
        );
      if (allRound) {
        signals.push(
          buildSignal("amount_round_number_streak", {
            pattern: "round_numbers",
            streak: rows.length + 1,
          }),
        );
      }
    }
  }

  return signals;
}

/**
 * S9. Self-dealing staff are threat-model item 1. `business_staff.user_id` and
 * `receipts.user_id` are comparable because both ultimately key on
 * `profiles.id` (consumers.id references profiles.id, 0002).
 *
 * The signal's severity is `warn`, but `fraudVerdict` routes it to review
 * unconditionally, regardless of composite - which is why a receipt that is
 * perfect in every other respect still stops here.
 */
async function detectStaffSelfScan(input: FraudInput): Promise<FraudSignal[]> {
  const { deps, receipt, matchedBusinessId } = input;
  if (matchedBusinessId === null) return [];

  const { data, error } = await deps.supabase
    .from("business_staff")
    .select("id, role")
    .eq("business_id", matchedBusinessId)
    .eq("user_id", receipt.user_id)
    .eq("status", "active")
    .maybeSingle<{ id: string; role: string }>();

  if (error !== null) {
    console.error("[receipts/process] staff self-scan read failed", error);
    return [];
  }
  if (data === null) return [];

  return [
    buildSignal("staff_self_scan", {
      business_id: matchedBusinessId,
      staff_role: data.role,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function buildParseMeta(input: {
  parsed: ParsedReceipt;
  match: { confidence: number; contradicted: boolean };
  template: SelectedTemplate | null;
  response: OcrResponse;
  attempt: number;
  confidence: number;
}): Json {
  const tier = input.template === null ? "heuristic" : "template";
  // A24.2 asks for {field: {tier, conf}}. parse.ts does not report which tier
  // produced each individual field - it composes the template and generic
  // tiers inside one call - so `tier` here is the tier the parse RAN in, and
  // `present` is what the review UI's per-field chips actually key on.
  // Refining this to genuine per-field provenance is a parse.ts change and is
  // deliberately not smuggled into this orchestration.
  const field = (value: unknown): Json => ({ tier, present: value !== null });

  return toJson({
    engine: "parse/v1",
    template_id: input.template?.id ?? null,
    template_source_kind: input.template?.sourceKind ?? null,
    tier,
    parse_confidence: input.confidence,
    fields: {
      merchant_name: field(input.parsed.merchantName),
      receipt_number: field(input.parsed.receiptNumber),
      receipt_date: field(input.parsed.receiptDate),
      subtotal_centavos: field(input.parsed.subtotalCentavos),
      tax_centavos: field(input.parsed.taxCentavos),
      total_centavos: field(input.parsed.totalCentavos),
    },
    vat_consistent: input.parsed.vatConsistent,
    within_amount_sanity: input.parsed.withinAmountSanity,
    date_ambiguous: input.parsed.dateAmbiguous,
    notes: input.parsed.notes,
    match: {
      confidence: input.match.confidence,
      contradicted: input.match.contradicted,
    },
    ocr: {
      engine: input.response.engine,
      engine_version: input.response.engineVersion,
      mean_confidence: input.response.meanConfidence,
      attempt: input.attempt,
      preprocess_ops: input.response.preprocessOps,
    },
  });
}

interface PersistInput {
  supabase: SupabaseClient<Database>;
  receiptId: string;
  matchedBusinessId: string | null;
  parsed: ParsedReceipt;
  templateId: string | null;
  matchConfidence: number;
  parseConfidence: number;
  parseMeta: Json;
  outcome: RouteOutcome;
  processedAt: Date | null;
  now: Date;
}

/**
 * The one write that moves the receipt to its terminal status AND persists
 * every parsed field, both confidences and parse_meta - on the review and
 * rejected paths just as much as on the approved one, because the review UI
 * renders exactly those columns and a reviewer with an empty form is a
 * reviewer who cannot work.
 */
async function persistOutcome(
  input: PersistInput,
): Promise<{ outcome: RouteOutcome; duplicateNumber: boolean }> {
  const { parsed, outcome } = input;

  const payload = {
    business_id: input.matchedBusinessId,
    merchant_name: parsed.merchantName,
    receipt_number: parsed.receiptNumber,
    receipt_date: parsed.receiptDate?.toISOString() ?? null,
    subtotal_centavos: parsed.subtotalCentavos,
    tax_centavos: parsed.taxCentavos,
    total_centavos: parsed.totalCentavos,
    template_id: input.templateId,
    match_confidence: toStoredConfidence(input.matchConfidence),
    parse_confidence: toStoredConfidence(input.parseConfidence),
    parse_meta: input.parseMeta,
    status: outcome.status,
    reject_reason: outcome.status === "rejected" ? outcome.reason : null,
    processed_at: input.processedAt?.toISOString() ?? null,
  };

  const { error } = await input.supabase
    .from("receipts")
    .update(payload)
    .eq("id", input.receiptId);

  if (error === null) return { outcome, duplicateNumber: false };

  if (!isUniqueViolation(error)) {
    console.error(
      `[receipts/process] could not persist the outcome of receipt ${input.receiptId}`,
      error,
    );
    return { outcome, duplicateNumber: false };
  }

  // The only unique index this statement can violate is
  // `receipts_number_unique`: another receipt took a LIVE claim on this
  // (business_id, receipt_number) between our detector's read and this write.
  // The database has just told us the deterministic truth doc 37 S3 describes,
  // so honour it - and note that a 'rejected' row is outside the partial
  // index, which is exactly why the retry below can succeed.
  console.warn(
    `[receipts/process] receipt ${input.receiptId} lost a race on receipts_number_unique; rejecting as duplicate`,
  );
  const { error: retryError } = await input.supabase
    .from("receipts")
    .update({
      ...payload,
      status: "rejected",
      reject_reason: "duplicate",
      // The award path leaves processed_at null for the RPC to write; there is
      // no award now, so this rejection has to stamp it itself.
      processed_at: (input.processedAt ?? input.now).toISOString(),
    })
    .eq("id", input.receiptId);

  if (retryError !== null) {
    console.error(
      `[receipts/process] could not reject receipt ${input.receiptId} as a duplicate`,
      retryError,
    );
  }
  return {
    outcome: { status: "rejected", reason: "duplicate" },
    duplicateNumber: true,
  };
}

/**
 * Doc 37's philosophy line, implemented literally: every tripped detector
 * writes a row "including on receipts that end up approved". Scoring history
 * is how thresholds get tuned and slow-burn abusers get caught, so an approved
 * receipt's warn rows are the whole point rather than noise.
 *
 * One batch insert with `business_id` and `consumer_id` denormalized, per doc
 * 37's execution note (`fraud_signals_consumer_idx` serves the per-consumer
 * history the cooldown ladder reads).
 */
async function writeFraudSignals(
  supabase: SupabaseClient<Database>,
  receipt: ReceiptRow,
  matchedBusinessId: string | null,
  signals: readonly FraudSignal[],
): Promise<void> {
  if (signals.length === 0) return;

  const { error } = await supabase.from("fraud_signals").insert(
    signals.map((signal) => ({
      business_id: matchedBusinessId,
      receipt_id: receipt.id,
      consumer_id: receipt.user_id,
      signal: signal.signal,
      severity: signal.severity,
      score: signal.score,
      evidence: toJson(signal.evidence),
    })),
  );

  if (error !== null) {
    // Never fatal: the receipt's outcome is already written and correct. A
    // lost signal row costs future tuning accuracy, not this consumer's points.
    console.error(
      `[receipts/process] could not write fraud signals for receipt ${receipt.id}`,
      error,
    );
  }
}

/**
 * Doc 36 Stage 7's line items. Deleted and re-inserted rather than merged
 * because a reprocess re-parses from a NEW OCR attempt and the previous split
 * is not evidence - 0017 says so in as many words, which is why service_role
 * keeps delete on this table and not on `ocr_results` or `fraud_signals`.
 *
 * `product_id` fuzzy linkage against the business's catalogue is deliberately
 * left null: doc 36 states plainly that line items are analytics enrichment
 * and "never a gate on approval", so the trigram product match belongs with
 * the analytics work rather than in the award path.
 */
async function writeLineItems(
  supabase: SupabaseClient<Database>,
  receiptId: string,
  matchedBusinessId: string | null,
  parsed: ParsedReceipt,
): Promise<void> {
  const { error: deleteError } = await supabase
    .from("receipt_line_items")
    .delete()
    .eq("receipt_id", receiptId);
  if (deleteError !== null) {
    console.error(
      `[receipts/process] could not clear line items for receipt ${receiptId}`,
      deleteError,
    );
    return;
  }

  if (parsed.lineItems.length === 0) return;

  const { error } = await supabase.from("receipt_line_items").insert(
    parsed.lineItems.map((item) => ({
      business_id: matchedBusinessId,
      receipt_id: receiptId,
      raw_text: item.rawText,
      qty: item.qty,
      unit_price_centavos: item.unitPriceCentavos,
      line_total_centavos: item.lineTotalCentavos,
      sort: item.sort,
    })),
  );
  if (error !== null) {
    console.error(
      `[receipts/process] could not write line items for receipt ${receiptId}`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Stage 10 - pricing and award
// ---------------------------------------------------------------------------

interface AwardPlan {
  points: number;
  ruleSnapshot: Json;
  campaignId: string | null;
  expiresAt: string | null;
}

/**
 * Runs the SHARED pure engine (doc 35 section 11 requires exactly one
 * implementation, serving both the consumer's optimistic preview and this
 * award) over the business's active rules.
 *
 * Returns a plan with `points: 0` rather than null when there is nothing to
 * award, so the caller can still record that pricing ran.
 */
async function priceReceipt(input: {
  supabase: SupabaseClient<Database>;
  businessId: string;
  receipt: ReceiptRow;
  parsed: ParsedReceipt;
  isFirstVisit: boolean;
}): Promise<AwardPlan> {
  const empty: AwardPlan = {
    points: 0,
    ruleSnapshot: toJson({ engine: "points/v1", total_points: 0, base: null }),
    campaignId: null,
    expiresAt: null,
  };

  const { data, error } = await input.supabase
    .from("points_rules")
    .select(
      "id, campaign_id, kind, rule_type, rate_centavos_per_point, fixed_points, tiers, multiplier, bonus_points, conditions, rounding",
    )
    .eq("business_id", input.businessId)
    .eq("is_active", true)
    .is("deleted_at", null);

  if (error !== null) {
    console.error(
      `[receipts/process] could not load points rules for business ${input.businessId}`,
      error,
    );
    return empty;
  }

  const rows = (data ?? []) as PointsRuleRow[];
  const baseRow = rows.find((row) => row.kind === "base");
  const baseRule = baseRow === undefined ? null : toPointsRule(baseRow);
  if (baseRule === null) {
    // No active base rule means the business has not configured earning at all
    // (`points_rules_one_base` guarantees at most one). That is a legitimate
    // configuration, not an error: the receipt is still a real, approved
    // purchase and still belongs in the consumer's history and the tenant's
    // analytics. See the zero-point handling in `awardPoints`.
    console.info(
      `[receipts/process] business ${input.businessId} has no active base points rule; approving receipt ${input.receipt.id} with 0 points`,
    );
    return empty;
  }

  // Doc 35 section 2: conditions are evaluated at receipts.receipt_date, never
  // at processing time. A dateless receipt falls back to created_at, which is
  // the same event_ts rule doc 40 gives and the same one 0018 uses for the
  // visit day, so the two can never disagree.
  const receiptDate = input.parsed.receiptDate ?? new Date(input.receipt.created_at);

  const campaignIds = [
    ...new Set(
      rows
        .filter((row) => row.kind !== "base")
        .map((row) => row.campaign_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const campaigns = await loadCampaigns(input.supabase, campaignIds);

  const candidates: Array<{ campaignId: string | null; rule: PointsRule }> = [];
  for (const row of rows) {
    if (row.kind === "base") continue;
    const rule = toPointsRule(row);
    if (rule === null) continue;
    if (row.campaign_id !== null) {
      const campaign = campaigns.get(row.campaign_id);
      if (campaign === undefined) continue;
      if (!isCampaignLive(toEngineCampaign(campaign), receiptDate)) continue;
    }
    candidates.push({ campaignId: row.campaign_id, rule });
  }

  const applied = resolveStacking(candidates, campaigns);
  const timezone =
    applied
      .map((candidate) =>
        candidate.campaignId === null
          ? undefined
          : campaigns.get(candidate.campaignId)?.timezone,
      )
      .find((zone): zone is string => zone !== undefined) ?? RECEIPT_TIMEZONE;

  const result = computePoints({
    amountCentavos: input.parsed.totalCentavos ?? 0,
    receiptDate,
    businessTimezone: timezone,
    baseRule,
    candidateRules: applied.map((candidate) => candidate.rule),
    visitContext: { isFirstVisit: input.isFirstVisit },
  });

  // Doc 35 step 9: campaign_id on the ledger row is "the primary applied
  // campaign or null". `resolveStacking` already emitted the candidates in
  // campaign priority order, so the first one that names a campaign is it.
  const campaignId =
    applied.find((candidate) => candidate.campaignId !== null)?.campaignId ?? null;

  return {
    points: result.points,
    ruleSnapshot: enrichRuleSnapshot({
      snapshot: result.ruleSnapshot,
      receipt: input.receipt,
      parsed: input.parsed,
      applied,
      campaigns,
    }),
    campaignId,
    // Doc 35 section 3 sets expires_at from "the base rule's expiry setting",
    // which lives under that doc's "Schema deltas proposed" and has no column
    // on `points_rules` (0012). Until that column exists there is no policy to
    // read, and null is the documented "never expires".
    expiresAt: null,
  };
}

async function loadCampaigns(
  supabase: SupabaseClient<Database>,
  campaignIds: readonly string[],
): Promise<Map<string, CampaignRow>> {
  const campaigns = new Map<string, CampaignRow>();
  if (campaignIds.length === 0) return campaigns;

  const { data, error } = await supabase
    .from("campaigns")
    .select("id, type, status, starts_at, ends_at, timezone, priority, is_stackable")
    .in("id", [...campaignIds])
    .is("deleted_at", null);

  if (error !== null) {
    console.error("[receipts/process] could not load campaigns for pricing", error);
    return campaigns;
  }
  for (const row of (data ?? []) as CampaignRow[]) {
    campaigns.set(row.id, row);
  }
  return campaigns;
}

function toEngineCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    type: row.type as CampaignType,
    // isCampaignLive only reads status/startsAt/endsAt; a status outside the
    // enum can never equal "active", so it is safely inert.
    status: row.status as Campaign["status"],
    startsAt: row.starts_at === null ? null : new Date(row.starts_at),
    endsAt: row.ends_at === null ? null : new Date(row.ends_at),
    timezone: row.timezone,
    budget: {},
  };
}

/**
 * `computePoints` returns the pure half of doc 35's frozen `rule_snapshot`
 * shape and says so in its own comment: "campaign_id, priority, and
 * is_stackable are added by the caller/service layer, which owns campaign
 * resolution". This is that caller. It also adds `computed_at` and the
 * `receipt` block, which the pure engine cannot know.
 */
function enrichRuleSnapshot(input: {
  snapshot: unknown;
  receipt: ReceiptRow;
  parsed: ParsedReceipt;
  applied: ReadonlyArray<{ campaignId: string | null; rule: PointsRule }>;
  campaigns: ReadonlyMap<string, CampaignRow>;
}): Json {
  const campaignByRuleId = new Map<string, CampaignRow | null>();
  for (const candidate of input.applied) {
    if (candidate.rule.id === undefined) continue;
    campaignByRuleId.set(
      candidate.rule.id,
      candidate.campaignId === null
        ? null
        : (input.campaigns.get(candidate.campaignId) ?? null),
    );
  }

  const decorate = (entries: unknown): Json => {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => {
      if (!isRecord(entry)) return toJson(entry);
      const ruleId = typeof entry.rule_id === "string" ? entry.rule_id : null;
      const campaign = ruleId === null ? undefined : campaignByRuleId.get(ruleId);
      return toJson({
        ...entry,
        campaign_id: campaign?.id ?? null,
        priority: campaign?.priority ?? null,
        is_stackable: campaign?.is_stackable ?? null,
      });
    }) as Json;
  };

  const base = isRecord(input.snapshot) ? input.snapshot : {};
  return toJson({
    ...base,
    computed_at: new Date().toISOString(),
    receipt: {
      id: input.receipt.id,
      total_centavos: input.parsed.totalCentavos,
      receipt_date: input.parsed.receiptDate?.toISOString() ?? null,
    },
    multipliers: decorate(base.multipliers),
    bonuses: decorate(base.bonuses),
  });
}

/**
 * The MONEY write. Everything before this point has been reversible; this is
 * the point where a consumer's balance changes.
 *
 * ZERO POINTS DELIBERATELY SKIPS THE RPC. 0018 step 1 raises
 * AWARD_POINTS_INVALID for `p_points <= 0`, and it is right to: a zero-point
 * earn row would violate the ledger's `points <> 0` check and would say
 * nothing. But zero is a legitimate outcome here, not a failure - a business
 * with no active base rule, an earning floor the receipt does not clear
 * (`min_amount_centavos`), or a tier table that stops below this amount all
 * price a real purchase at nothing. The receipt stays APPROVED because it is
 * approved: it is a genuine, validated purchase that belongs in the consumer's
 * history, in `receipts_biz_status_idx` reporting, and in the store's
 * analytics. Calling the RPC to have it refuse would turn a normal
 * configuration into an error log and, worse, would tempt someone to "fix" it
 * by rejecting the receipt.
 */
async function awardPoints(
  supabase: SupabaseClient<Database>,
  receiptId: string,
  plan: AwardPlan,
): Promise<void> {
  if (plan.points <= 0) {
    console.info(
      `[receipts/process] receipt ${receiptId} priced at 0 points; approved without a ledger row`,
    );
    return;
  }

  const client = supabase as unknown as AwardRpcClient;
  const { data, error } = await client.rpc("award_receipt_points", {
    p_receipt_id: receiptId,
    p_points: plan.points,
    p_rule_snapshot: plan.ruleSnapshot,
    p_campaign_id: plan.campaignId,
    p_expires_at: plan.expiresAt,
  });

  if (error === null) {
    console.info(
      `[receipts/process] receipt ${receiptId} awarded ${plan.points} points (ledger row ${String(data)})`,
    );
    return;
  }

  const severity = AWARD_ERROR_HANDLING[error.message] ?? "error";
  const line = `[receipts/process] award refused for receipt ${receiptId}: ${error.message}`;
  if (severity === "info") {
    console.info(line);
  } else if (severity === "warn") {
    console.warn(line);
  } else {
    console.error(line, error);
  }

  // Nothing is rolled back and the receipt keeps status='approved'. Only
  // RECEIPT_ALREADY_AWARDED is benign; the rest leave an approved receipt with
  // no ledger row, which `processed_at is null` makes findable - that column
  // is exactly what 0018 calls the difference between "approved and paid" and
  // "approved, award pending".
  if (severity !== "info") {
    const { error: noteError } = await supabase
      .from("receipts")
      .update({ reject_note: `award_failed:${error.message}` })
      .eq("id", receiptId);
    if (noteError !== null) {
      console.error(
        `[receipts/process] could not annotate the failed award of ${receiptId}`,
        noteError,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Doc 37 consequences ladder, step 2
// ---------------------------------------------------------------------------

/**
 * "3 fraud-family rejections / 30 days (`fraud.cooldown_strikes`) -> 24h scan
 * block (`fraud.cooldown_hours`)". Automatic, auto-expiring, audited.
 *
 * Doc 37's parenthetical says the strikes are "counted from
 * fraud_signals_consumer_idx", but a signal is not a rejection: an approved
 * receipt with three warn rows would otherwise strike a consumer who did
 * nothing wrong, and one rejection carrying four signals would strike them
 * four times over. The count is therefore taken over REJECTIONS - the noun the
 * sentence actually uses - reading `receipts` for this consumer's
 * `duplicate`/`fraud_suspected` rows inside the window. The receipt just
 * rejected is already written, so it counts itself, which is what makes the
 * third strike (not the fourth) fire the block.
 */
async function applyCooldownIfEarned(
  deps: ProcessReceiptDeps,
  consumerId: string,
  settings: ReceiptSettings,
): Promise<void> {
  const now = deps.now();

  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id")
    .eq("user_id", consumerId)
    .eq("status", "rejected")
    .in("reject_reason", [...FRAUD_FAMILY_REJECT_REASONS])
    .gte("created_at", daysAgo(now, COOLDOWN_WINDOW_DAYS))
    // Only "did we reach the threshold" matters, so the read stops there.
    .limit(settings.cooldownStrikes);

  if (error !== null) {
    console.error("[receipts/process] cooldown strike count failed", error);
    return;
  }

  const strikes = (data ?? []).length;
  if (strikes < settings.cooldownStrikes) return;

  const blockedUntil = new Date(now.getTime() + settings.cooldownHours * 3_600_000);

  const { data: consumer, error: readError } = await deps.supabase
    .from("consumers")
    .select("scan_blocked_until")
    .eq("id", consumerId)
    .maybeSingle<{ scan_blocked_until: string | null }>();

  if (readError !== null) {
    console.error("[receipts/process] could not read the existing cooldown", readError);
    return;
  }

  // Never shorten an existing block. A longer cooldown may have been applied
  // by an admin (ladder step 2 is also a manual action), and re-running the
  // pipeline over an old receipt must not hand an abuser an early release.
  const existing =
    consumer?.scan_blocked_until === undefined || consumer.scan_blocked_until === null
      ? null
      : new Date(consumer.scan_blocked_until);
  if (existing !== null && existing.getTime() >= blockedUntil.getTime()) return;

  const { error: writeError } = await deps.supabase
    .from("consumers")
    .update({ scan_blocked_until: blockedUntil.toISOString() })
    .eq("id", consumerId);

  if (writeError !== null) {
    console.error("[receipts/process] could not apply the scan cooldown", writeError);
    return;
  }

  // TODO(audit): the jobs/platform slice adds `audit_logs`; doc 37 requires a
  // `fraud.cooldown_applied` row here once that table exists.
  console.warn(
    `[receipts/process] consumer ${consumerId} hit ${strikes} fraud-family rejections in ${COOLDOWN_WINDOW_DAYS} days; scanning blocked until ${blockedUntil.toISOString()}`,
  );
}
