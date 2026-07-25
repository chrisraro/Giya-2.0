// ===========================================================================
// Pure presentation logic for the receipt review surfaces.
//
// Everything here is a total function of its arguments: no clock reads, no
// database, no React. That is what makes doc 37's evidence display contract
// testable as a contract rather than as a screenshot.
//
// The one rule that shapes this whole file: EVIDENCE IS RENDERED, NEVER
// DUMPED. Doc 37 asks for "signal rows with severity, score, and rendered
// evidence ... distance readout ... count/cap bars for velocity". A reviewer
// looking at `{"window":"pair_10min","count":3,"cap":2}` has to decode a
// schema before they can decide a receipt; a reviewer looking at "3 scans at
// this business in 10 minutes, against a cap of 2" has already decided.
// `describeSignal` below is that translation, and `evidenceRows` is its
// deliberately dull fallback for a key nothing here knows yet, because a
// signal shape added later must still render as words rather than vanish.
//
// TOKENS ONLY. Every class string returned from this file names an MD3 token
// (docs/10-architecture/16-design-system.md); no raw colour appears anywhere.
// Tertiary (Mango) is absent on purpose: it is reserved for rewards language,
// and a fraud chip is not a reward.
// ===========================================================================

import { formatPeso } from "@/lib/money";

import { SEVERITY_WEIGHT, scoreSignals } from "../fraud";
import type { FraudSeverity } from "../fraud";
import type {
  FraudSignalView,
  ParseMetaFieldView,
  ParseMetaView,
  QueueSlaState,
  ReviewQueueStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Queue age and the SLA (doc 36 Stage 9: "target < 24h", admin alert at 48h)
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Ceiling on the pending-review figure. The queue reader stops counting one
 * past this, so both the badge and the copy that says "or more" have to agree
 * on the same number; keeping it here rather than in the server-only reader is
 * what lets the client-side copy share it.
 */
export const PENDING_COUNT_CAP = 99;

/** Doc 36 Stage 9's MVP target. Past this an item is late, not yet alarming. */
export const SLA_TARGET_MS = 24 * HOUR_MS;
/** Doc 36 Stage 9: an admin is alerted when a tenant's oldest item passes this. */
export const SLA_ALERT_MS = 48 * HOUR_MS;

export interface QueueAge {
  /** Whole milliseconds waited, clamped at zero for a clock skew. */
  elapsedMs: number;
  label: string;
  state: QueueSlaState;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * How long this receipt has been waiting, as a sentence and as an SLA state.
 *
 * `now` is injected rather than read, so the queue renders identically in a
 * test and in a server component and no hydration mismatch is possible.
 */
export function queueAge(createdAtIso: string, now: Date): QueueAge {
  const created = new Date(createdAtIso).getTime();
  const elapsedMs = Number.isNaN(created) ? 0 : Math.max(0, now.getTime() - created);

  const state: QueueSlaState =
    elapsedMs >= SLA_ALERT_MS ? "overdue" : elapsedMs >= SLA_TARGET_MS ? "due" : "ok";

  if (elapsedMs < MINUTE_MS) return { elapsedMs, label: "Just arrived", state };
  if (elapsedMs < HOUR_MS) {
    return { elapsedMs, label: `Waiting ${plural(Math.floor(elapsedMs / MINUTE_MS), "minute")}`, state };
  }
  if (elapsedMs < DAY_MS) {
    return { elapsedMs, label: `Waiting ${plural(Math.floor(elapsedMs / HOUR_MS), "hour")}`, state };
  }
  return { elapsedMs, label: `Waiting ${plural(Math.floor(elapsedMs / DAY_MS), "day")}`, state };
}

/** The SLA accent. `ok` returns muted classes: the normal case is not an alert. */
export function slaChipClass(state: QueueSlaState): string {
  if (state === "overdue") return "bg-error-container text-on-error-container";
  if (state === "due") return "border border-outline bg-surface-container-highest text-on-surface";
  return "bg-surface-container-high text-on-surface-variant";
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<FraudSeverity, number> = { info: 0, warn: 1, block: 2 };

export function highestSeverity(
  signals: readonly Pick<FraudSignalView, "severity">[],
): FraudSeverity | null {
  let worst: FraudSeverity | null = null;
  for (const signal of signals) {
    if (worst === null || SEVERITY_RANK[signal.severity] > SEVERITY_RANK[worst]) {
      worst = signal.severity;
    }
  }
  return worst;
}

/**
 * Doc 37's composite, computed by the SAME function the pipeline routes on
 * (`scoreSignals`), so the number a reviewer reads is the number that put the
 * receipt in front of them.
 */
export function compositeFraudScore(
  signals: readonly Pick<FraudSignalView, "severity" | "score">[],
): number {
  return scoreSignals(signals);
}

export interface SeverityMeta {
  label: string;
  chipClass: string;
  /** Doc 37's severity weights, shown so the composite is checkable by hand. */
  weight: number;
}

export function severityMeta(severity: FraudSeverity): SeverityMeta {
  if (severity === "block") {
    return {
      label: "Blocking",
      chipClass: "bg-error-container text-on-error-container",
      weight: SEVERITY_WEIGHT.block,
    };
  }
  if (severity === "warn") {
    return {
      label: "Warning",
      chipClass: "border border-outline bg-surface-container-highest text-on-surface",
      weight: SEVERITY_WEIGHT.warn,
    };
  }
  return {
    label: "Context",
    chipClass: "bg-surface-container-high text-on-surface-variant",
    weight: SEVERITY_WEIGHT.info,
  };
}

// ---------------------------------------------------------------------------
// Confidence and per-field source chips (doc 36 Stage 9's UI contract)
// ---------------------------------------------------------------------------

export type ConfidenceTone = "high" | "medium" | "low";

/**
 * Doc 32 section 6 fixes the bands for the template test panel's confidence
 * chips (">= .9, >= .7, below") and the review screen uses the same bands so a
 * chip means one thing across the portal. The colours differ from that doc's
 * shorthand on purpose: "green / amber / red" is not a token vocabulary, and
 * this project bans anything that is not a token.
 */
export function confidenceTone(value: number): ConfidenceTone {
  if (value >= 0.9) return "high";
  if (value >= 0.7) return "medium";
  return "low";
}

export function toneChipClass(tone: ConfidenceTone): string {
  if (tone === "high") return "bg-secondary-container text-on-secondary-container";
  if (tone === "medium") return "border border-outline bg-surface-container-highest text-on-surface";
  return "bg-error-container text-on-error-container";
}

export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface FieldChip {
  /** Where the value came from: the template, a generic read, or nowhere. */
  sourceLabel: string;
  confidenceLabel: string | null;
  tone: ConfidenceTone;
}

const TIER_LABELS: Record<string, string> = {
  template: "From your template",
  heuristic: "Read from the image",
};

/**
 * The per-field source and confidence chip.
 *
 * Honest about a real limitation: `buildParseMeta` records the tier the parse
 * RAN in, not a per-field tier, and says so in its own comment ("Refining this
 * to genuine per-field provenance is a parse.ts change"). So the chip reports
 * presence per field and tier per parse, and the confidence shown beside it is
 * the receipt's `parse_confidence`, not a per-field number that does not exist.
 * Inventing one here would be worse than admitting it.
 */
export function fieldChip(
  meta: ParseMetaView | null,
  key: string,
  parseConfidence: number | null,
): FieldChip {
  const field: ParseMetaFieldView | undefined = meta?.fields[key];

  if (field === undefined) {
    return { sourceLabel: "No parse record", confidenceLabel: null, tone: "low" };
  }
  if (!field.present) {
    return { sourceLabel: "Not found", confidenceLabel: null, tone: "low" };
  }

  const tier = field.tier ?? meta?.tier ?? null;
  const sourceLabel = (tier === null ? undefined : TIER_LABELS[tier]) ?? "Read from the image";
  const confidenceLabel =
    parseConfidence === null ? null : `${formatConfidence(parseConfidence)} confident`;
  const tone: ConfidenceTone =
    parseConfidence === null
      ? tier === "template"
        ? "high"
        : "medium"
      : confidenceTone(parseConfidence);

  return { sourceLabel, confidenceLabel, tone };
}

// ---------------------------------------------------------------------------
// Evidence rendering (doc 37's display contract)
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  label: string;
  value: string;
}

/** A count-versus-cap bar. Doc 37 asks for these by name on velocity signals. */
export interface EvidenceMeter {
  label: string;
  count: number;
  cap: number;
}

export interface SignalPresentation {
  title: string;
  summary: string;
  rows: EvidenceRow[];
  meter: EvidenceMeter | null;
}

const SIGNAL_TITLES: Record<string, string> = {
  image_hash_dup: "Duplicate image",
  ocr_similarity_dup: "Similar receipt text",
  receipt_number_dup: "Duplicate receipt number",
  velocity: "Scan rate",
  timestamp_anomaly: "Date does not add up",
  gps_mismatch: "Location does not match",
  amount_anomaly: "Amount does not add up",
  ai_confidence_low: "Hard to read",
  staff_self_scan: "Submitted by your own staff",
};

const VELOCITY_WINDOW_LABELS: Record<string, string> = {
  consumer_hour: "in the last hour",
  consumer_day: "in the last day",
  pair_day: "at this business today",
  pair_10min: "at this business within 10 minutes",
  device_day: "from this device today",
};

/**
 * Keys that are never rendered as a raw row.
 *
 * `matched_consumer_id` and `matched_receipt_id` are opaque ids that would be
 * noise at best; the matched receipt is resolved into `matchedReceipt` and
 * shown properly, and the other consumer's identity is deliberately never
 * shown at all. `business_id` is the tenant the reviewer is already inside.
 */
const HIDDEN_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "matched_receipt_id",
  "matched_consumer_id",
  "business_id",
]);

function readString(evidence: Record<string, unknown>, key: string): string | null {
  const value = evidence[key];
  return typeof value === "string" ? value : null;
}

function readNumber(evidence: Record<string, unknown>, key: string): number | null {
  const value = evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(evidence: Record<string, unknown>, key: string): boolean | null {
  const value = evidence[key];
  return typeof value === "boolean" ? value : null;
}

function humanizeKey(key: string): string {
  const words = key.replace(/_centavos$/, "").split("_");
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

function humanizeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return key.endsWith("_centavos") ? formatPeso(Math.max(0, Math.round(value))) : String(value);
  }
  if (typeof value === "string") return value;
  // Arrays and nested objects have no evidence shape in the catalog today.
  // Listing their keys beats printing a JSON blob at a reviewer.
  if (Array.isArray(value)) return `${value.length} entries`;
  return Object.keys(value as Record<string, unknown>).join(", ") || "Recorded";
}

/**
 * The dull fallback: every evidence key the specific renderers did not
 * consume, as label and value pairs. This exists so that adding a signal to
 * the catalog can never make its evidence silently invisible.
 */
export function evidenceRows(
  evidence: Record<string, unknown>,
  consumed: readonly string[],
): EvidenceRow[] {
  const skip = new Set([...consumed, ...HIDDEN_EVIDENCE_KEYS]);
  return Object.entries(evidence)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => ({ label: humanizeKey(key), value: humanizeValue(key, value) }));
}

function formatDateValue(value: string | null): string {
  if (value === null) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

/**
 * One fraud signal as a reviewer should read it. The switch is on the
 * `fraud_signals.signal` value rather than on the catalog case, because the
 * database stores the type and the case is a build-time concept.
 */
export function describeSignal(signal: FraudSignalView): SignalPresentation {
  const evidence = signal.evidence;
  const title = SIGNAL_TITLES[signal.signal] ?? humanizeKey(signal.signal);

  switch (signal.signal) {
    case "velocity": {
      const window = readString(evidence, "window");
      const count = readNumber(evidence, "count");
      const cap = readNumber(evidence, "cap");
      const where = (window === null ? undefined : VELOCITY_WINDOW_LABELS[window]) ?? "in this window";
      const summary =
        count === null || cap === null
          ? `Scanning went past the allowed rate ${where}.`
          : `${plural(count, "scan")} ${where}, against an allowance of ${cap}.`;
      return {
        title,
        summary,
        rows: evidenceRows(evidence, ["window", "count", "cap"]),
        meter: count === null || cap === null ? null : { label: where, count, cap },
      };
    }

    case "image_hash_dup":
    case "ocr_similarity_dup": {
      const distance = readNumber(evidence, "hamming_distance");
      const crossConsumer = readBoolean(evidence, "cross_consumer");
      const rows: EvidenceRow[] = [];
      if (distance !== null) {
        rows.push({
          label: "Image difference",
          // dctPhash is a 64-bit hash, so the distance is out of 64 and a
          // reviewer needs the denominator to know that 4 is very close.
          value: `${distance} of 64 bits, so the two photos are ${distance <= 4 ? "all but identical" : "closely alike"}`,
        });
      }
      if (crossConsumer === true) {
        rows.push({
          label: "Account",
          value: "The earlier receipt was submitted by a different customer",
        });
      }
      const summary =
        distance === null
          ? "This photo closely resembles a receipt already on file."
          : `This photo is ${distance} bits away from a receipt already on file.`;
      return {
        title,
        summary,
        rows: [...rows, ...evidenceRows(evidence, ["hamming_distance", "cross_consumer"])],
        meter: null,
      };
    }

    case "receipt_number_dup": {
      const number = readString(evidence, "receipt_number");
      const crossConsumer = readBoolean(evidence, "cross_consumer");
      const rows: EvidenceRow[] = [];
      if (number !== null) rows.push({ label: "Receipt number", value: number });
      if (crossConsumer === true) {
        rows.push({
          label: "Account",
          value: "The earlier claim on this number came from a different customer",
        });
      }
      return {
        title,
        summary:
          signal.severity === "block"
            ? "Another live receipt at this business already claims this number."
            : "This number was used by an earlier receipt that was rejected.",
        rows: [...rows, ...evidenceRows(evidence, ["receipt_number", "cross_consumer"])],
        meter: null,
      };
    }

    case "timestamp_anomaly": {
      const kind = readString(evidence, "kind");
      const receiptDate = formatDateValue(readString(evidence, "receipt_date"));
      const maxAgeDays = readNumber(evidence, "max_age_days");
      const verifiedAt = readString(evidence, "business_verified_at");

      let summary: string;
      if (kind === "future_dated") {
        summary = `The printed date is ${receiptDate}, which is in the future.`;
      } else if (kind === "stale") {
        summary =
          maxAgeDays === null
            ? `The printed date is ${receiptDate}, older than scans are accepted for.`
            : `The printed date is ${receiptDate}, more than ${plural(maxAgeDays, "day")} old.`;
      } else if (kind === "predates_activation") {
        summary = `The printed date is ${receiptDate}, before this business went live on Giya.`;
      } else {
        summary = `The printed date is ${receiptDate}.`;
      }

      const rows: EvidenceRow[] = [];
      if (verifiedAt !== null) {
        rows.push({ label: "Business live since", value: formatDateValue(verifiedAt) });
      }
      return {
        title,
        summary,
        rows: [
          ...rows,
          ...evidenceRows(evidence, [
            "kind",
            "receipt_date",
            "max_age_days",
            "business_verified_at",
          ]),
        ],
        meter: null,
      };
    }

    case "amount_anomaly": {
      const observed = readNumber(evidence, "observed_centavos");
      const lineItems = readNumber(evidence, "line_items_centavos");
      const streak = readNumber(evidence, "streak");
      const rows: EvidenceRow[] = [];

      let summary: string;
      if (lineItems !== null && observed !== null) {
        summary = `The total does not match the items on the receipt.`;
        rows.push({ label: "Printed total", value: formatPeso(observed) });
        rows.push({ label: "Items add up to", value: formatPeso(lineItems) });
      } else if (streak !== null) {
        summary = `The last ${plural(streak, "receipt")} from this customer were all round numbers.`;
      } else if (observed !== null) {
        summary = `${formatPeso(observed)} is far above what this business usually rings up.`;
        rows.push({ label: "Total on this receipt", value: formatPeso(observed) });
      } else {
        summary = "The amount looks unusual for this business.";
      }

      return {
        title,
        summary,
        rows: [
          ...rows,
          ...evidenceRows(evidence, [
            "observed_centavos",
            "line_items_centavos",
            "streak",
            "pattern",
            "source",
          ]),
        ],
        meter: null,
      };
    }

    case "ai_confidence_low": {
      const mean = readNumber(evidence, "mean_confidence");
      return {
        title,
        summary:
          mean === null
            ? "The reader was not confident about this image."
            : `The reader was ${formatConfidence(mean)} confident across the whole image, so check the fields carefully.`,
        rows: evidenceRows(evidence, ["mean_confidence"]),
        meter: null,
      };
    }

    case "staff_self_scan": {
      const role = readString(evidence, "staff_role");
      return {
        title,
        summary:
          role === null
            ? "The person who submitted this receipt is on your staff, so a second person has to look at it."
            : `The person who submitted this receipt is a ${role} at this business, so a second person has to look at it.`,
        rows: evidenceRows(evidence, ["staff_role"]),
        meter: null,
      };
    }

    default:
      return {
        title,
        summary: "The detector recorded the values below.",
        rows: evidenceRows(evidence, []),
        meter: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Status and reason copy
// ---------------------------------------------------------------------------

export const REJECT_REASON_LABELS: Record<string, string> = {
  duplicate: "Already scanned",
  unreadable: "Could not be read",
  wrong_business: "Not from this business",
  too_old: "Too old to accept",
  fraud_suspected: "Looks fraudulent",
  manual: "Other reason",
};

/**
 * The reason list the Reject dialog offers, in the order a reviewer decides
 * in: the ordinary quality outcomes first, the two that feed doc 37's cooldown
 * ladder last, so a fraud answer is a deliberate choice rather than the first
 * radio in the list.
 */
export const REJECT_REASON_ORDER = [
  "unreadable",
  "wrong_business",
  "too_old",
  "manual",
  "duplicate",
  "fraud_suspected",
] as const;

/** The two reasons that advance a consumer's strike count (server/cooldown.ts). */
export const FRAUD_FAMILY_REASONS: ReadonlySet<string> = new Set([
  "duplicate",
  "fraud_suspected",
]);

export const QUEUE_TABS: ReadonlyArray<{ value: ReviewQueueStatus; label: string }> = [
  { value: "review", label: "Needs review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

/** Peso for display, tolerant of the null the parser leaves on a missing field. */
export function formatAmount(centavos: number | null): string {
  return centavos === null ? "Not found" : formatPeso(centavos);
}

/** `YYYY-MM-DD`, the only date format that is unambiguous to everyone. */
export function formatDate(iso: string | null): string {
  return formatDateValue(iso);
}

/** `YYYY-MM-DD HH:MM` in UTC, for the decision timestamps in history. */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return "Not recorded";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 10)} ${parsed.toISOString().slice(11, 16)} UTC`;
}
