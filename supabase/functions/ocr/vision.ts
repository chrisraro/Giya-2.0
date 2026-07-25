// Google Cloud Vision `fullTextAnnotation` -> doc 36 Stage 4's `raw_text` and
// `blocks`.
//
// WHY THIS FILE EXISTS AT ALL, AND WHY IT IS THE MOST IMPORTANT FILE IN THE
// OCR PATH.
//
// Vision's `fullTextAnnotation.text` is NOT the receipt as printed. It is the
// concatenation of Vision's own paragraph segmentation, and on a receipt that
// segmentation splits the right-aligned money column away from its label. The
// measured output for the KAPE DIARIA test receipt (2026-07-26, live call,
// page confidence 0.98) contains, verbatim:
//
//     TOTAL
//     150.00
//     CASH
//     200.00
//
// Feed that to src/features/receipts/parse.ts and the money is wrong. Its
// `extractAmounts` looks for a total keyword and then reads the amount ON THAT
// SAME LINE (`amountOnLine`). "TOTAL" alone carries no amount, so no total
// keyword hit survives, and the tier-2 last resort fires: "the largest amount
// near the foot of the receipt". That is 200.00, the CASH tendered. The parser
// returns 20000 centavos where the truth is 15000 - a silent 33% over-award on
// every single receipt, with `vatConsistent` flipping false as the only weak
// signal that anything happened. Nobody would notice from the outside; the
// receipt would auto-approve and the ledger would be wrong.
//
// So the geometry is not an optional extra that unlocks a nice-to-have tier.
// Reconstructing the printed lines from word-level coordinates is what makes
// Vision safe to award money from at all. `fullTextAnnotation.text` is never
// returned as `raw_text`.
//
// PURE AND DEPENDENCY-FREE ON PURPOSE. No Deno globals, no imports, no IO. The
// Edge Function imports it, and so does the regression test in
// src/features/receipts/server/ocr/vision-lines.test.ts, which replays the real
// recorded Vision response for that receipt through here and through
// `parseReceipt` and asserts 15000, not 20000. One implementation, tested where
// the rest of the repo's tests live.

// ---------------------------------------------------------------------------
// The subset of the Vision v1 response we read
// ---------------------------------------------------------------------------
//
// Everything is optional because this is another company's JSON. A field that
// stops arriving must degrade this module, never crash it: an OCR read that
// throws is a receipt that cannot be processed, whereas an OCR read missing a
// confidence is a receipt that processes with one fewer input.

/** Vision returns either absolute pixel `vertices` or `normalizedVertices`
 * (0-1 floats), depending on feature and API surface. Both shapes are handled;
 * see `collectWords`. */
export interface VisionVertex {
  x?: number;
  y?: number;
}

export interface VisionBoundingPoly {
  vertices?: VisionVertex[];
  normalizedVertices?: VisionVertex[];
}

export interface VisionSymbol {
  text?: string;
  confidence?: number;
  property?: { detectedBreak?: { type?: string } };
}

export interface VisionWord {
  boundingBox?: VisionBoundingPoly;
  symbols?: VisionSymbol[];
  confidence?: number;
}

export interface VisionParagraph {
  words?: VisionWord[];
  confidence?: number;
}

export interface VisionBlock {
  boundingBox?: VisionBoundingPoly;
  paragraphs?: VisionParagraph[];
  confidence?: number;
  blockType?: string;
}

export interface VisionPage {
  width?: number;
  height?: number;
  blocks?: VisionBlock[];
  confidence?: number;
}

export interface VisionFullTextAnnotation {
  text?: string;
  pages?: VisionPage[];
}

// ---------------------------------------------------------------------------
// What we hand back
// ---------------------------------------------------------------------------

/** One reconstructed printed line, in doc 36 Stage 4's `blocks` shape.
 * `bbox` is `[x0, y0, x1, y1]` in the ORIGINAL image frame (never the
 * deskewed one), because that is the frame a reviewer's crop and any future
 * overlay are drawn in. */
export interface ReconstructedLine {
  text: string;
  bbox: [number, number, number, number];
  conf: number;
}

export interface ReconstructedDocument {
  /** The printed lines, joined with "\n". This is `raw_text`. */
  text: string;
  /** One entry per printed line, top to bottom. This is `blocks`. */
  blocks: ReconstructedLine[];
  /** Vision's own measured confidence, never a placeholder. */
  meanConfidence: number;
  /** The skew we corrected for, in degrees, positive clockwise. Reported so a
   * quality regression on tilted photos is diagnosable from the stored trace
   * rather than by guessing. */
  skewDegrees: number;
  /** How many words carried geometry. Zero means we found no text. */
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Tuning constants. Every one of them is a RATIO, never a pixel count.
// ---------------------------------------------------------------------------

/**
 * Two words share a printed line when their vertical extents overlap by at
 * least this fraction of the SHORTER of the two heights.
 *
 * Ratio, not pixels, and measured against the shorter height, so it adapts to
 * font size instead of assuming one. A receipt's header is often twice the
 * body size and a phone photo can be any resolution at all; a fixed pixel
 * tolerance would shred the body text of a high-resolution scan and merge the
 * header of a low-resolution one.
 *
 * Why overlap rather than "midpoints within N pixels". A short word - a
 * comma, a "1", the ")" closing "VAT (12%)" - has a box far shorter than the
 * line it sits on, and its midpoint sits well below a capital letter's. A
 * midpoint-distance rule scaled by that word's own tiny height would cut it
 * off its own line. Overlap divided by the SHORTER height is 1.0 for exactly
 * that case (the short box is entirely inside the line's band) and negative
 * for the line above or below, which is the discrimination we actually want.
 *
 * 0.5 is the natural threshold: more than half of the smaller glyph must lie
 * inside the other's band. On the measured receipt, body lines are ~8px tall
 * and ~20px apart, so adjacent lines score about -1.5 and same-line words
 * score 0.8-1.0. There is no near-miss anywhere in that data, which is the
 * point of choosing the discriminating axis rather than tuning a threshold.
 */
const LINE_OVERLAP_RATIO = 0.5;

/**
 * Words separated by a horizontal gap of at least this fraction of the line's
 * glyph height get a space between them; anything tighter is concatenated.
 *
 * This exists because Vision splits words at places a receipt does not:
 * "OR" "#" "004512" are three words with 1px gaps, and "VAT" "(" "12" "%" ")"
 * are five. Joining every pair with a space would produce "OR # 004512" and
 * "VAT ( 12 % )", and the second one matters for money: a bare "12" separated
 * by spaces is a token the money regex can read as PHP 12.00 where "12%" is
 * explicitly excluded by its own lookahead.
 *
 * The rule is geometric rather than a lookup of Vision's `detectedBreak`
 * because `detectedBreak` is exactly the signal that is wrong here - Vision
 * marks LINE_BREAK after "TOTAL" and again after "150.00", which is the defect
 * this module exists to undo. `detectedBreak` is consulted only to CONFIRM a
 * space (an explicit SPACE is honoured), never to force a break.
 *
 * 0.25 sits far from both populations in the measured data: intra-word gaps
 * are 0-1px against an 8px glyph height (ratio <= 0.13) and inter-word gaps
 * are 2-4px (ratio >= 0.25), while the money column gap is 37px (4.6).
 */
const WORD_GAP_RATIO = 0.25;

/**
 * Fewest words that may vote on the page's skew angle. Below this the median
 * is not a median, it is one word's rounding error, so no rotation is applied.
 * A receipt with two legible words has no total to find either way.
 *
 * THERE IS DELIBERATELY NO UPPER BOUND ON THE ANGLE ITSELF. The first draft of
 * this file refused to deskew past 20 degrees, on the theory that a larger
 * angle means a sideways photo rather than a tilted one and should not be
 * trusted. The regression test for that ceiling is what disproved it: at 45
 * degrees the reconstruction did not fail safe, it fell back to the raw frame,
 * grouped words across four different printed lines, and still handed the
 * parser a number - 20000 centavos, the CASH line, the exact defect this
 * module exists to remove. A guard that turns a correctable input into a
 * confidently wrong one is worse than no guard.
 *
 * The angle is also correctable at any magnitude, which is the substantive
 * reason. Vision detects page orientation itself and emits each word's quad
 * with corner 0 at the top-left IN READING ORDER, so a receipt photographed
 * sideways produces word quads at ~90 degrees and the median recovers exactly
 * that. Undoing it is a rigid rotation, not a guess.
 */
const MIN_SKEW_SAMPLES = 3;

/**
 * A word's top edge must be at least this multiple of the median glyph height
 * to vote on the skew angle. A single-character box is nearly square, so its
 * top-edge direction is dominated by rounding in Vision's integer vertices;
 * multi-character words carry a real baseline direction.
 */
const SKEW_SAMPLE_MIN_WIDTH_RATIO = 1.5;

/**
 * Reported as `mean_confidence` when Vision returns text but reports no
 * confidence anywhere - no page confidence, no block confidence, no word
 * confidence.
 *
 * This is the ONE place the old hf-vlm value survives, and it survives for the
 * same reason it was chosen there: it is the neutral midpoint and it states
 * "no evidence either way about character-level accuracy". Downstream both
 * consumers behave correctly on it - `shouldEmitLowConfidenceSignal(0.5)` is
 * false because the comparison is a strict `<`, so the info signal keeps its
 * meaning, and in `parseConfidence` the OCR term contributes exactly half its
 * 0.30 weight, leaving the three field terms to decide routing.
 *
 * It is a fallback now rather than the normal case. Vision reported 0.98 on
 * every path (page, block, word) in the measured call, so reaching this line
 * means the API changed shape under us.
 */
const CONFIDENCE_UNREPORTED = 0.5;

// ---------------------------------------------------------------------------
// Word extraction
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

interface RawWord {
  text: string;
  /** The four corners as Vision gave them, in the original image frame,
   * corner 0 = top-left in READING order, so `corners[1] - corners[0]` is the
   * text direction. That is what makes skew estimation possible. */
  corners: Point[];
  /** Vision's per-word confidence, or null when it reported none. */
  conf: number | null;
  /** Weight for the per-line confidence mean: a 15-character word should not
   * count the same as a "1". */
  weight: number;
  /** `detectedBreak.type` of the word's last symbol, or null. */
  breakType: string | null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The four corners of a bounding poly, in the original image frame.
 *
 * Vision returns `vertices` (absolute pixels) on `images:annotate` and
 * `normalizedVertices` (0-1 floats) on some other surfaces and, in practice,
 * on responses where it could not determine the image dimensions. Both are
 * handled. Normalized coordinates are scaled by the page's width and height
 * when the page reports them; when it does not, they are left in 0-1 space,
 * which costs nothing here because EVERY rule in this file is a ratio and the
 * one consumer of the absolute values (`layout_anchors` in parse.ts) itself
 * normalizes by the lowest block edge.
 */
function toCorners(
  poly: VisionBoundingPoly | undefined,
  scaleX: number,
  scaleY: number,
): Point[] | null {
  const absolute = poly?.vertices;
  if (Array.isArray(absolute) && absolute.length >= 4) {
    const points: Point[] = [];
    for (const vertex of absolute) {
      // A vertex ON the top or left edge omits its zero: Vision uses proto3
      // default-value elision, so `{y: 22}` means x = 0. Defaulting to 0 is
      // reading the wire format correctly, not papering over a gap.
      points.push({ x: isFiniteNumber(vertex.x) ? vertex.x : 0, y: isFiniteNumber(vertex.y) ? vertex.y : 0 });
    }
    return points;
  }

  const normalized = poly?.normalizedVertices;
  if (Array.isArray(normalized) && normalized.length >= 4) {
    const points: Point[] = [];
    for (const vertex of normalized) {
      points.push({
        x: (isFiniteNumber(vertex.x) ? vertex.x : 0) * scaleX,
        y: (isFiniteNumber(vertex.y) ? vertex.y : 0) * scaleY,
      });
    }
    return points;
  }

  return null;
}

function wordText(word: VisionWord): { text: string; breakType: string | null; symbols: number } {
  const symbols = word.symbols ?? [];
  let text = "";
  let breakType: string | null = null;
  for (const symbol of symbols) {
    if (typeof symbol.text === "string") text += symbol.text;
    const type = symbol.property?.detectedBreak?.type;
    breakType = typeof type === "string" ? type : null;
  }
  return { text, breakType, symbols: symbols.length };
}

/**
 * Every word on every page, flattened.
 *
 * VISION'S OWN BLOCK AND PARAGRAPH STRUCTURE IS DISCARDED HERE, DELIBERATELY.
 * That structure is the bug: it is what puts "TOTAL" in one block and "150.00"
 * in another. Only the words and their coordinates are evidence about what was
 * printed; the grouping is Vision's opinion about it, and this module forms its
 * own.
 */
function collectWords(annotation: VisionFullTextAnnotation): RawWord[] {
  const words: RawWord[] = [];
  for (const page of annotation.pages ?? []) {
    const scaleX = isFiniteNumber(page.width) && page.width > 0 ? page.width : 1;
    const scaleY = isFiniteNumber(page.height) && page.height > 0 ? page.height : 1;
    for (const block of page.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const word of paragraph.words ?? []) {
          const corners = toCorners(word.boundingBox, scaleX, scaleY);
          if (corners === null) continue;
          const { text, breakType, symbols } = wordText(word);
          if (text.length === 0) continue;
          // Per-word confidence when Vision gives one, else the paragraph's,
          // else the block's. Falling UP the tree is honest: a paragraph
          // confidence really is a statement about the words inside it.
          const conf = isFiniteNumber(word.confidence)
            ? word.confidence
            : isFiniteNumber(paragraph.confidence)
              ? paragraph.confidence
              : isFiniteNumber(block.confidence)
                ? block.confidence
                : null;
          words.push({
            text,
            corners,
            conf,
            weight: Math.max(1, symbols),
            breakType,
          });
        }
      }
    }
  }
  return words;
}

// ---------------------------------------------------------------------------
// Skew
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function axisAlignedHeight(corners: Point[]): number {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of corners) {
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }
  return bottom - top;
}

/**
 * The document's skew, in radians, from the words' own quadrilaterals.
 *
 * Vision returns each word's box as a quad whose first two corners are the top
 * edge IN READING ORDER, so `corner1 - corner0` is the direction the text runs.
 * On a tilted photo every word's top edge tilts by the same angle, so the
 * MEDIAN of those angles is the page skew and is immune to the handful of
 * words Vision boxes oddly. A mean would not be: one badly boxed word on a
 * 40-word receipt can move a mean by degrees.
 *
 * Returns 0 (meaning "do not rotate") only when too few words qualify to make
 * a median meaningful. Any angle a real median produces is applied, however
 * large; see MIN_SKEW_SAMPLES for why there is no ceiling.
 */
function estimateSkewRadians(words: RawWord[]): number {
  const heights: number[] = [];
  for (const word of words) heights.push(axisAlignedHeight(word.corners));
  const medianHeight = median(heights);
  const minWidth = medianHeight * SKEW_SAMPLE_MIN_WIDTH_RATIO;

  const angles: number[] = [];
  for (const word of words) {
    const start = word.corners[0];
    const end = word.corners[1];
    if (start === undefined || end === undefined) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.sqrt(dx * dx + dy * dy) < minWidth) continue;
    angles.push(Math.atan2(dy, dx));
  }

  if (angles.length < MIN_SKEW_SAMPLES) return 0;
  const skew = median(angles);
  return Number.isFinite(skew) ? skew : 0;
}

// ---------------------------------------------------------------------------
// Line grouping
// ---------------------------------------------------------------------------

interface PlacedWord extends RawWord {
  /** Deskewed frame. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Original frame, for the reported bbox. */
  originalX0: number;
  originalY0: number;
  originalX1: number;
  originalY1: number;
}

function place(word: RawWord, skewRadians: number): PlacedWord {
  const cos = Math.cos(-skewRadians);
  const sin = Math.sin(-skewRadians);

  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let originalX0 = Number.POSITIVE_INFINITY;
  let originalY0 = Number.POSITIVE_INFINITY;
  let originalX1 = Number.NEGATIVE_INFINITY;
  let originalY1 = Number.NEGATIVE_INFINITY;

  for (const point of word.corners) {
    if (point.x < originalX0) originalX0 = point.x;
    if (point.y < originalY0) originalY0 = point.y;
    if (point.x > originalX1) originalX1 = point.x;
    if (point.y > originalY1) originalY1 = point.y;

    const x = point.x * cos - point.y * sin;
    const y = point.x * sin + point.y * cos;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
    if (x < left) left = x;
    if (x > right) right = x;
  }

  return {
    ...word,
    top,
    bottom,
    left,
    right,
    originalX0,
    originalY0,
    originalX1,
    originalY1,
  };
}

interface OpenLine {
  words: PlacedWord[];
  /** Running mean of the members' tops and bottoms. A running MEAN rather than
   * the union of the spans, so one oversized word (a logo glyph, a smear
   * Vision boxed generously) cannot inflate the band and start swallowing the
   * line below it. */
  top: number;
  bottom: number;
}

/** Fraction of the shorter height by which two vertical spans overlap.
 * Negative when they do not overlap at all, which is what makes the single
 * comparison in `groupIntoLines` sufficient. */
function overlapRatio(aTop: number, aBottom: number, bTop: number, bBottom: number): number {
  const overlap = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  const shorter = Math.min(aBottom - aTop, bBottom - bTop);
  // A degenerate zero-height box (Vision has been seen to emit them for a
  // stray mark) would divide by zero. Treat any overlap at all as belonging.
  if (!(shorter > 0)) return overlap >= 0 ? 1 : -1;
  return overlap / shorter;
}

/**
 * Words to printed lines.
 *
 * Sorting by vertical midpoint first makes a line's members CONTIGUOUS in the
 * sort order, which is what lets the grouping be a single greedy pass against
 * the current line rather than an all-pairs search. That contiguity is exactly
 * what deskewing buys: on a 5-degree tilt across a 460px-wide receipt the two
 * ends of one printed line differ by 40px of raw y, five times the glyph
 * height, so in the raw frame adjacent lines interleave and no greedy pass can
 * work. In the deskewed frame they separate cleanly.
 */
function groupIntoLines(words: PlacedWord[]): PlacedWord[][] {
  const sorted = [...words].sort((a, b) => {
    const midA = (a.top + a.bottom) / 2;
    const midB = (b.top + b.bottom) / 2;
    return midA - midB || a.left - b.left;
  });

  const lines: OpenLine[] = [];
  let current: OpenLine | null = null;

  for (const word of sorted) {
    if (
      current !== null &&
      overlapRatio(word.top, word.bottom, current.top, current.bottom) >= LINE_OVERLAP_RATIO
    ) {
      current.words.push(word);
      const n = current.words.length;
      current.top += (word.top - current.top) / n;
      current.bottom += (word.bottom - current.bottom) / n;
      continue;
    }
    current = { words: [word], top: word.top, bottom: word.bottom };
    lines.push(current);
  }

  for (const line of lines) {
    // Reading order within the line. Left to right in the DESKEWED frame, so a
    // tilt cannot reorder a label and its amount.
    line.words.sort((a, b) => a.left - b.left);
  }
  return lines.map((line) => line.words);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Vision break types that assert a space was printed. LINE_BREAK and
 * EOL_SURE_SPACE are deliberately absent: they are Vision's claim that the
 * line ENDED here, and that claim is the defect. Geometry decides instead. */
const SPACE_BREAKS = ["SPACE", "SURE_SPACE"];

function renderLine(words: PlacedWord[]): string {
  const heights: number[] = [];
  for (const word of words) heights.push(word.bottom - word.top);
  const glyphHeight = median(heights);
  const gapThreshold = glyphHeight * WORD_GAP_RATIO;

  let text = "";
  let previous: PlacedWord | null = null;
  for (const word of words) {
    if (previous !== null) {
      const gap = word.left - previous.right;
      const spaced =
        (previous.breakType !== null && SPACE_BREAKS.indexOf(previous.breakType) >= 0) ||
        gap >= gapThreshold;
      if (spaced) text += " ";
    }
    text += word.text;
    previous = word;
  }
  return text;
}

function lineConfidence(words: PlacedWord[]): number | null {
  let weighted = 0;
  let weight = 0;
  for (const word of words) {
    if (word.conf === null) continue;
    weighted += word.conf * word.weight;
    weight += word.weight;
  }
  return weight > 0 ? weighted / weight : null;
}

function lineBbox(words: PlacedWord[]): [number, number, number, number] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const word of words) {
    if (word.originalX0 < x0) x0 = word.originalX0;
    if (word.originalY0 < y0) y0 = word.originalY0;
    if (word.originalX1 > x1) x1 = word.originalX1;
    if (word.originalY1 > y1) y1 = word.originalY1;
  }
  return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
}

/**
 * Vision's own measured confidence for the document.
 *
 * Preference order is page, then the words. The page number is Vision's own
 * aggregate over everything it read and is the value the API documents as the
 * page-level confidence; the word fallback exists only for a response shape
 * that stops carrying it. Both are MEASURED. Nothing here is invented, which
 * is the whole difference from the engine this replaced.
 */
function documentConfidence(annotation: VisionFullTextAnnotation, words: RawWord[]): number {
  const pageConfidences: number[] = [];
  for (const page of annotation.pages ?? []) {
    if (isFiniteNumber(page.confidence)) pageConfidences.push(page.confidence);
  }
  if (pageConfidences.length > 0) {
    let sum = 0;
    for (const value of pageConfidences) sum += value;
    return clamp01(sum / pageConfidences.length);
  }

  let weighted = 0;
  let weight = 0;
  for (const word of words) {
    if (word.conf === null) continue;
    weighted += word.conf * word.weight;
    weight += word.weight;
  }
  if (weight > 0) return clamp01(weighted / weight);

  return CONFIDENCE_UNREPORTED;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Vision's `fullTextAnnotation` to the printed lines of the receipt.
 *
 * WHAT THIS HANDLES
 *   - Vision splitting a label from its right-aligned amount (the defect above).
 *   - A photograph rotated by ANY in-plane angle, corrected from the median of
 *     the words' own quadrilateral orientations. A few degrees of counter-top
 *     tilt and a fully sideways phone photo are the same correction.
 *   - Mixed font sizes on one receipt, because every threshold is a ratio of
 *     the local glyph height rather than a pixel constant.
 *   - Words Vision over-splits ("OR" "#" "004512"), rejoined on their gap.
 *   - `normalizedVertices` in place of `vertices`.
 *   - Multiple pages, concatenated in page order.
 *
 * WHAT THIS DOES NOT HANDLE, stated plainly so nobody assumes otherwise:
 *   - MULTI-COLUMN LAYOUTS. Two independent columns of text at the same height
 *     are merged into one line, because "same vertical band" is the entire
 *     definition of a line here. PH receipts are single-column, and a wide
 *     invoice with a left address block beside a right totals block would
 *     interleave. There is no column detection.
 *   - MIXED ORIENTATIONS ON ONE PAGE. The correction is a single global angle,
 *     so a receipt carrying a rotated stamp or a sideways promotional block
 *     straightens the dominant body text and scrambles the rest. Scrambled
 *     text near the totals is the dangerous case, and the only defence here is
 *     that it produces no total keyword beside an amount, which routes to
 *     review. PH receipts do not do this; a folded or torn slip photographed
 *     as two planes might.
 *   - FEWER THAN THREE WORDS. No skew is estimated (MIN_SKEW_SAMPLES). Such an
 *     image has no readable total either way.
 *   - PERSPECTIVE AND CURVATURE. A receipt curling on a counter has a skew that
 *     varies down the page; one global median angle cannot straighten it. The
 *     overlap rule absorbs a little of this because it compares against a
 *     running band rather than a fixed one, but a strongly curved slip will
 *     split lines. Doc 36 Stage 3's `perspective` op is the real answer and it
 *     lives in the preprocessing that this engine does not perform.
 *   - VERTICAL OR RIGHT-TO-LEFT SCRIPT. Reading order within a line is
 *     left-to-right, unconditionally.
 *   - COLUMN ALIGNMENT. Words are joined with a single space, so the visual
 *     column positions are lost. The parser reads the LAST money token on a
 *     line as the amount, which is the same rule whether or not the spaces are
 *     padded, so nothing downstream needs them.
 */
export function reconstructDocument(
  annotation: VisionFullTextAnnotation,
): ReconstructedDocument {
  const words = collectWords(annotation);
  if (words.length === 0) {
    return {
      text: "",
      blocks: [],
      meanConfidence: documentConfidence(annotation, words),
      skewDegrees: 0,
      wordCount: 0,
    };
  }

  const skewRadians = estimateSkewRadians(words);
  const placed = words.map((word) => place(word, skewRadians));
  const lines = groupIntoLines(placed);

  const blocks: ReconstructedLine[] = [];
  const rendered: string[] = [];
  const documentConf = documentConfidence(annotation, words);

  for (const line of lines) {
    const text = renderLine(line);
    if (text.trim().length === 0) continue;
    rendered.push(text);
    blocks.push({
      text,
      bbox: lineBbox(line),
      // Per-line confidence is a real aggregate of Vision's per-word numbers,
      // which is what makes a template's `handwriting.min_block_conf` floor
      // mean something for the first time. It falls back to the document
      // number rather than to 0, because a line whose words carried no
      // confidence is not a line we measured badly - it is one we did not
      // measure, and 0 would silently delete it under any configured floor.
      conf: clamp01(lineConfidence(line) ?? documentConf),
    });
  }

  return {
    text: rendered.join("\n"),
    blocks,
    meanConfidence: documentConf,
    skewDegrees: (skewRadians * 180) / Math.PI,
    wordCount: words.length,
  };
}
