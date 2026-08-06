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
 * `receipt_date` (a full ISO instant) rendered as the Manila wall clock the
 * closed-hours signal actually compared against: `{ weekday: "Sunday", clock:
 * "2:14 AM" }`, or null on anything that does not parse.
 *
 * Derives the weekday NAME straight from the instant via `Intl` rather than
 * keeping a second `day 1..7 -> label` array here: `closed-hours.ts` already
 * derives the number from the identical instant in the identical zone via
 * `deriveLocalDayTime`, so the two are guaranteed to agree, and this module
 * needs no import of `../businesses/settings/hours.ts`'s editor-facing
 * `WEEKDAY_LABELS` (or a second copy of it) for one label.
 */
function manilaClock(iso: string | null): { weekday: string; clock: string } | null {
  if (iso === null) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(instant);

  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = find("weekday");
  const hour = find("hour");
  const minute = find("minute");
  const dayPeriod = find("dayPeriod");
  if (weekday === "" || hour === "" || minute === "") return null;

  return { weekday, clock: `${hour}:${minute}${dayPeriod === "" ? "" : ` ${dayPeriod}`}` };
}

function readRecord(evidence: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = evidence[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
      const rawReceiptDate = readString(evidence, "receipt_date");
      const receiptDate = formatDateValue(rawReceiptDate);
      const maxAgeDays = readNumber(evidence, "max_age_days");
      const verifiedAt = readString(evidence, "business_verified_at");
      // Doc 37 line 82's evidence contract for the closed-hours case:
      // `{kind, receipt_date, opening_hours_day: {day, open, close}}`.
      const openingHoursDay = readRecord(evidence, "opening_hours_day");
      const openingHoursDayNumber = openingHoursDay !== null ? readNumber(openingHoursDay, "day") : null;
      const statedOpen = openingHoursDay !== null ? readString(openingHoursDay, "open") : null;
      const statedClose = openingHoursDay !== null ? readString(openingHoursDay, "close") : null;
      const clock = kind === "closed_hours" ? manilaClock(rawReceiptDate) : null;

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
      } else if (kind === "closed_hours") {
        // doc 37 S5's third case. Non-accusatory on purpose, per the D3
        // principle merchant-check.test.tsx pins: this states a fact about
        // the printed time against the business's own stated hours, never a
        // claim about the customer.
        summary =
          clock === null
            ? "The printed time is outside this business's stated hours."
            : `Receipt time ${clock.clock} is outside this business's stated hours.`;
      } else {
        summary = `The printed date is ${receiptDate}.`;
      }

      const rows: EvidenceRow[] = [];
      if (verifiedAt !== null) {
        rows.push({ label: "Business live since", value: formatDateValue(verifiedAt) });
      }
      if (kind === "closed_hours") {
        // C2: without the window the receipt was measured against, a
        // reviewer cannot tell a real closure from hours nobody entered -
        // this is the row that makes that legible on the one screen the
        // signal exists to serve.
        rows.push({
          label: "Day",
          value: clock?.weekday ?? (openingHoursDayNumber === null ? "Unknown" : String(openingHoursDayNumber)),
        });
        if (statedOpen !== null && statedClose !== null) {
          rows.push({ label: "Stated hours", value: `${statedOpen} - ${statedClose}` });
        }
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
            "opening_hours_day",
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
// The merchant-name check (doc 36 Stage 5's foreign-receipt defence)
// ---------------------------------------------------------------------------
//
// TWO FINDINGS, RENDERED AS TWO DIFFERENT THINGS, ON PURPOSE.
//
// The pipeline routes a receipt here when the name printed at the top either
// does not look like this shop's name, or could not be read at all. Those are
// not degrees of the same problem and a reviewer does not answer them the same
// way:
//
//   * "We could not read the shop name" is a PHOTO problem. The top of a
//     receipt is the part that creases, fades and gets cropped, so this is the
//     common case. The reviewer looks at the image, sees their own logo, and
//     approves. There is nothing to learn from it - there is no header text to
//     learn - so this variant offers no alias affordance at all, which is the
//     most legible way for the two to differ.
//   * "The header reads JOLLIBEE" is a FOREIGN RECEIPT, and possibly a
//     deliberate one. The reviewer reads a name that is not theirs and
//     rejects, or recognizes their own trading name and teaches it.
//
// WHAT THE COPY MAY NOT DO. It is merchant-facing, and it never accuses the
// consumer. "We could not confirm this receipt is from your shop" is the
// register: the subject is Giya's own uncertainty, not the customer's honesty.
// The overwhelmingly common cause of both variants is a bad photograph of a
// genuine purchase, and a reviewer primed to suspect their own customer is a
// reviewer who will reject one. The CONSUMER-facing copy does not change at
// all: a receipt in review already tells them honestly that a person is
// looking at it, and nothing here reaches them.

export type MerchantCheckTone = "unreadable" | "mismatch";

export interface MerchantCheckNotice {
  tone: MerchantCheckTone;
  title: string;
  body: string;
  /** The header as read, for the "is this yours?" line. Null when unreadable. */
  headerText: string | null;
  /** The label under the header. Null when there is nothing to attribute. */
  rivalNote: string | null;
  /** Whether the one-tap "always accept this header" affordance applies. */
  canLearnAlias: boolean;
}

/**
 * The banner the decision screen shows when Stage 5 could not confirm the
 * merchant, or null when it could (or when the receipt predates the check).
 *
 * A `match` verdict returns null rather than a reassuring green box: the queue
 * is a list of things that need a decision, and a passed check is not one.
 */
/**
 * D7's notice: this receipt is in the queue because WE could not read it.
 *
 * IT IS THE ONE NOTICE WHOSE RECEIPT HAS NO PARSE AT ALL. An operator failure
 * means the OCR call never succeeded, so every field on the form below is
 * empty, there is no merchant check, no confidence and no signal. Without this
 * the reviewer opens a blank form with a photograph next to it and no idea why,
 * which is the most confusing row the queue can hold - and the likeliest
 * conclusion they would draw is that the customer submitted something broken.
 *
 * It says whose failure it was in as many words. The consumer is deliberately
 * NOT told (they get the ordinary "the store is checking this"), but the
 * merchant is doing unpaid work on our behalf and is owed the reason.
 *
 * No cause code, no quota, no vendor. `reject_note` carries
 * `ocr_operator_failure:{code}` for an operator and 0017 withholds that column
 * from the client for good reasons that do not stop applying because the reader
 * is a shop owner.
 */
export interface OperatorFailureNotice {
  title: string;
  body: string;
}

export function operatorFailureNotice(
  meta: ParseMetaView | null,
): OperatorFailureNotice | null {
  if (meta === null || !meta.reviewReasons.includes("ocr_operator_failure")) {
    return null;
  }
  return {
    title: "We could not read this one, and that is on us",
    body:
      "Our scanner did not come back for this receipt, so nothing was filled " +
      "in automatically. The photo is fine as far as we know. Read it off the " +
      "image and key in the total and the date, and the customer gets their " +
      "points as normal.",
  };
}

// ---------------------------------------------------------------------------
// The escalation notice (0036)
// ---------------------------------------------------------------------------
//
// A DIFFERENT QUESTION, AND IT HAS TO LOOK LIKE ONE. Every other receipt in
// this queue is here because a rule fired, and the reviewer's job is to judge
// the receipt. An escalated receipt is here because a CUSTOMER DISAGREED WITH
// US, and the reviewer's job is to judge OUR MACHINE. A reviewer who does not
// know which of those they are doing will read the fraud panel below and reject
// on the strength of the very signal the customer is contesting.
//
// SO IT NAMES THE MACHINE'S VERDICT AND ASKS THEM TO SECOND-GUESS IT. That is
// why `escalateReceipt` keeps `reject_reason` when it moves the row back: the
// verdict is the question, not a leftover.
//
// THE REGISTER IS THE SAME AS `merchantCheckNotice`: the subject is Giya's own
// uncertainty, never the customer's honesty. "Our reader rejected this and the
// customer says that is wrong" is a statement about us. A notice that opened
// with "this customer is disputing" would prime a reviewer to defend the
// rejection, and the whole reason this feature exists is that our rejections
// have a known error rate: OCR in this project's own testing has misread a
// TIN's `009` as `899` and "Bilao" as "Bilbao".
//
// NOTHING HERE REACHES THE CONSUMER, and nothing from the consumer reaches
// here. There is no free-text field on an escalation on purpose: a message box
// would become a channel between a customer and a shop that neither doc 15 nor
// doc 33 has a moderation story for, and the receipt photograph is the whole
// argument anyway.

export interface EscalationNotice {
  title: string;
  body: string;
  /** The machine's verdict, as a merchant-facing label. Null when none was recorded. */
  rejectedAsLabel: string | null;
}

/**
 * The banner for a receipt the customer pushed back into this queue, or null
 * for the overwhelming majority that the pipeline routed itself.
 */
export function escalationNotice(input: {
  escalated: boolean;
  rejectReason: string | null;
}): EscalationNotice | null {
  if (!input.escalated) return null;

  const rejectedAsLabel =
    input.rejectReason === null
      ? null
      : (REJECT_REASON_LABELS[input.rejectReason] ?? input.rejectReason);

  return {
    title: "Your customer asked you to look at this again",
    body:
      "We turned this receipt down and the customer thinks that was wrong, so " +
      "they sent it to you. You are the only one who can settle it: you have " +
      "the till record and you may well remember the sale. Read the photo, and " +
      "if the purchase is real, approve it and they get their points as normal.",
    rejectedAsLabel,
  };
}

export function merchantCheckNotice(
  meta: ParseMetaView | null,
  businessName: string,
): MerchantCheckNotice | null {
  const check = meta?.merchantCheck ?? null;
  if (check === null || check.verdict === "match") return null;

  if (check.verdict === "unreadable") {
    return {
      tone: "unreadable",
      title: "We could not read the shop name on this receipt",
      body:
        `Nothing legible came off the top of the photo, so we could not confirm ` +
        `it is from ${businessName}. The top of a receipt is usually the first ` +
        `part to crease or fade. Check the photo yourself: if it is your ` +
        `receipt, approve it.`,
      headerText: null,
      rivalNote: null,
      canLearnAlias: false,
    };
  }

  const rival = check.rival;
  return {
    tone: "mismatch",
    title: `We could not confirm this receipt is from ${businessName}`,
    body:
      `The name printed at the top does not look like ${businessName}. That is ` +
      `often just how a shop's receipts are headed, or a misread of a worn ` +
      `line. Check the photo: if this is how your receipts print, approve it ` +
      `and tell us to accept this header from now on.`,
    headerText: check.headerText,
    rivalNote:
      rival === null
        ? null
        : `This header also matches ${rival.name}, another business on Giya.`,
    // Nothing to learn without a header to learn, and the learn action reads
    // the string from the receipt rather than from this screen anyway.
    canLearnAlias: check.headerText !== null,
  };
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
