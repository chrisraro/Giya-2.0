// Pure business matching, per docs/30-modules/36-receipt-ocr-pipeline.md
// Stage 5. ZERO IO: no DB, no network. The caller loads the candidate set
// (Postgres prefilters it with the businesses_name_trgm GIN index) and hands
// it in, together with the trigram similarity function to use.
//
// The one behaviour to protect above all others: a pre-bound receipt (scanned
// from a business page, business_id already set) is VERIFIED here, never
// silently re-bound. matchBusiness can lower its confidence and raise the
// contradicted flag, but it can never hand back a different business id.

// Local types for now. A sibling task is introducing
// src/features/receipts/types.ts for shared fraud types; nothing in this
// module overlaps it (no severity, no signal score), so there is nothing to
// reuse yet. It did not exist when this file was written.

export interface MatchCandidate {
  businessId: string;
  name: string;
  // Template parse_config.tin. Digits and separators as printed.
  tin?: string | null;
  // Template parse_config.merchant_aliases.
  merchantAliases?: string[];
  // Stage 6 structural match against a validated template of this business.
  hasValidatedTemplateMatch?: boolean;
}

export interface MatchThresholds {
  // match_confidence >= accept -> auto-accept the binding.
  accept: number;
  // match_confidence >= review (but < accept) -> human review.
  // Below review -> wrong_business.
  review: number;
}

export interface MatchBusinessInput {
  // Full OCR text of the receipt (doc 36 Stage 4 raw_text).
  rawText: string;
  // The extracted merchant line (doc 36 Stage 7), null when extraction failed.
  merchantName: string | null;
  // Set for the common pre-bound scan; null/undefined for a generic scan.
  preBoundBusinessId?: string | null;
  candidates: MatchCandidate[];
  // Injected because in production this is Postgres pg_trgm similarity(),
  // which is authoritative. See trigramSimilarity below.
  trigramSimilarity: (a: string, b: string) => number;
  thresholds?: MatchThresholds;
}

export interface MatchBusinessResult {
  businessId: string | null;
  confidence: number;
  // True only for a pre-bound receipt whose image carries strong identity
  // evidence for a different business. The caller routes these to
  // rejected / wrong_business.
  contradicted: boolean;
}

export type MatchOutcome = "accept" | "review" | "wrong_business";

// Doc 36 Stage 5 defaults. Overridable from the settings table.
export const MATCH_THRESHOLDS: MatchThresholds = { accept: 0.85, review: 0.5 };

// Doc 36 Stage 5 scoring table (best-of, not additive).
const TIN_SCORE = 0.98;
const ALIAS_SCORE = 0.95;
const TRIGRAM_WEIGHT = 0.9;
const TRIGRAM_PREFILTER = 0.4;
const PRE_BOUND_FLOOR = 0.85;
const VALIDATED_TEMPLATE_BONUS = 0.05;
const MAX_CONFIDENCE = 1;

// A PH TIN is 9 base digits plus a 3 to 5 digit branch code. Anything shorter
// is not identity evidence, and a short numeric string would match far too
// much of a receipt's raw text.
const MIN_TIN_DIGITS = 9;

// Confidence carried by a contradicted pre-bound receipt: none. The only
// strong identity evidence on the image names a different business, so we
// have nothing supporting the binding we are obliged to keep. Zero is below
// any sane review threshold, so routing lands on wrong_business.
const CONTRADICTED_CONFIDENCE = 0;

// Comparison form for every string in this module: uppercase, punctuation
// replaced by a single space, whitespace collapsed. The raw form never
// reaches a comparison.
export function normalizeForMatch(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// Punctuation and whitespace removed entirely, so "TIN: 123-456-789-000" and
// "TIN 123456789000" both contain the same digit run.
function compactAlphanumeric(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

// Confidence is persisted to receipts.match_confidence. Four decimals keeps
// float noise (0.9 * 0.4 = 0.36000000000000004) out of the column and out of
// threshold comparisons.
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// Pure JS approximation of Postgres pg_trgm similarity(): each word is padded
// with two leading spaces and one trailing space, split into trigrams, and
// the two distinct trigram sets are compared by Jaccard index.
//
// The Postgres function is AUTHORITATIVE - it is what the GIN index uses to
// prefilter candidates, and its unicode/word-boundary handling is its own.
// This implementation exists so callers and tests have a default and so
// offline scoring is possible; it is injected, never assumed.
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length === 0) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      grams.add(padded.slice(i, i + 3));
    }
  }
  return grams;
}

// Doc 36 Stage 5 routing table, applied by the caller to match_confidence.
export function matchOutcome(
  confidence: number,
  thresholds: MatchThresholds = MATCH_THRESHOLDS,
): MatchOutcome {
  if (confidence >= thresholds.accept) return "accept";
  if (confidence >= thresholds.review) return "review";
  return "wrong_business";
}

interface CandidateEvidence {
  candidate: MatchCandidate;
  // Best-of over the evidence inputs, before the template bonus.
  score: number;
  // A TIN or alias hit: identity evidence naming this business outright,
  // as opposed to a fuzzy name resemblance.
  strongIdentity: boolean;
}

export function matchBusiness(input: MatchBusinessInput): MatchBusinessResult {
  const thresholds = input.thresholds ?? MATCH_THRESHOLDS;
  const compactText = compactAlphanumeric(input.rawText);
  const normalizedMerchant =
    input.merchantName === null ? "" : normalizeForMatch(input.merchantName);

  const evidence = input.candidates.map((candidate) =>
    scoreCandidate(candidate, compactText, normalizedMerchant, input, thresholds),
  );

  const preBoundId = input.preBoundBusinessId ?? null;
  if (preBoundId !== null) {
    return verifyPreBound(preBoundId, evidence);
  }
  return pickBest(evidence);
}

function scoreCandidate(
  candidate: MatchCandidate,
  compactText: string,
  normalizedMerchant: string,
  input: MatchBusinessInput,
  thresholds: MatchThresholds,
): CandidateEvidence {
  const scores: number[] = [];
  let strongIdentity = false;

  // TIN printed anywhere in the raw text.
  const tinDigits = candidate.tin === undefined || candidate.tin === null
    ? ""
    : digitsOnly(candidate.tin);
  if (tinDigits.length >= MIN_TIN_DIGITS && compactText.includes(tinDigits)) {
    scores.push(TIN_SCORE);
    if (TIN_SCORE >= thresholds.accept) strongIdentity = true;
  }

  // Exact hit, after normalization, of the extracted merchant line against a
  // template alias. Deliberately not a raw-text search: an alias appearing
  // somewhere in the body (a delivery partner, a mall name) is not identity.
  if (
    normalizedMerchant.length > 0 &&
    (candidate.merchantAliases ?? []).some(
      (alias) => normalizeForMatch(alias) === normalizedMerchant,
    )
  ) {
    scores.push(ALIAS_SCORE);
    if (ALIAS_SCORE >= thresholds.accept) strongIdentity = true;
  }

  // Fuzzy name resemblance, below the prefilter it counts for nothing.
  if (normalizedMerchant.length > 0) {
    const similarity = input.trigramSimilarity(
      normalizedMerchant,
      normalizeForMatch(candidate.name),
    );
    if (similarity >= TRIGRAM_PREFILTER) {
      scores.push(TRIGRAM_WEIGHT * similarity);
    }
  }

  return {
    candidate,
    score: scores.length === 0 ? 0 : Math.max(...scores),
    strongIdentity,
  };
}

// match_confidence = max(inputs), then +0.05 for a validated-template
// structural match, capped at 1.0. No match means no bonus.
function withTemplateBonus(evidence: CandidateEvidence, score: number): number {
  if (score <= 0) return 0;
  const bonus = evidence.candidate.hasValidatedTemplateMatch === true
    ? VALIDATED_TEMPLATE_BONUS
    : 0;
  return round4(Math.min(MAX_CONFIDENCE, score + bonus));
}

// Pre-bound scan: verification, not re-binding. The returned businessId is
// always the pre-bound one.
function verifyPreBound(
  preBoundId: string,
  evidence: CandidateEvidence[],
): MatchBusinessResult {
  const own = evidence.find((e) => e.candidate.businessId === preBoundId);
  const contradicting = evidence.some(
    (e) => e.candidate.businessId !== preBoundId && e.strongIdentity,
  );

  // Strong identity evidence for another business, and none for this one:
  // the floor is voided and the receipt is routed to wrong_business. Note
  // the asymmetry - strong evidence for the pre-bound business rebuts a
  // rival hit (a receipt can legitimately name more than one company),
  // while a merely similar name elsewhere never contradicts anything.
  if (contradicting && (own === undefined || !own.strongIdentity)) {
    return {
      businessId: preBoundId,
      confidence: CONTRADICTED_CONFIDENCE,
      contradicted: true,
    };
  }

  // No contradiction: the floor applies. Absence of evidence is not
  // contradiction, so a pre-bound receipt with nothing extracted still sits
  // at the floor.
  const base = Math.max(own?.score ?? 0, PRE_BOUND_FLOOR);
  const confidence = own === undefined
    ? round4(Math.min(MAX_CONFIDENCE, base))
    : withTemplateBonus(own, base);
  return { businessId: preBoundId, confidence, contradicted: false };
}

// Generic scan: highest final scorer wins, ties broken by candidate order.
function pickBest(evidence: CandidateEvidence[]): MatchBusinessResult {
  let best: { businessId: string; confidence: number } | null = null;
  for (const item of evidence) {
    const confidence = withTemplateBonus(item, item.score);
    if (confidence <= 0) continue;
    if (best === null || confidence > best.confidence) {
      best = { businessId: item.candidate.businessId, confidence };
    }
  }
  if (best === null) {
    return { businessId: null, confidence: 0, contradicted: false };
  }
  return { ...best, contradicted: false };
}
