import "server-only";

import type { OcrBlock, OcrProvider, OcrRequest, OcrResponse } from "./provider";

// The dormant-container stand-in, per the spec's section 2.
//
// WHY THIS EXISTS: doc 36 Stage 4 puts PaddleOCR + OpenCV in a private
// container (decision D1). That container and its credentials arrive at the
// END of the build, and the receipts pipeline has to be buildable, testable
// and demonstrable before then. This provider fabricates plausible PH receipt
// text so submit -> OCR -> parse -> match -> validate -> fraud -> route ->
// award runs end to end today.
//
// SETTING OCR_SERVICE_URL SWITCHES TO THE REAL PROVIDER WITH NO OTHER CODE
// CHANGE (see ./provider.ts). Nothing downstream of this file knows which
// implementation produced its input.
//
// Every response reports `engine: "stub"`, which is persisted to
// `ocr_results.engine`, so a stub-derived row can always be told apart from a
// real one in the database, in the review UI, and in any later backfill.
//
// DETERMINISM: output is a pure function of (request, Manila calendar day).
// All variation is seeded from a hash of the request; there is no Math.random
// anywhere, and no clock read inside the generator. The one concession is the
// receipt DATE, which has to sit inside the `receipts.max_age_days` freshness
// window (doc 36 Stage 8, default 3 days) or every stub receipt would start
// getting rejected as `too_old` a few days after this file was written. The
// clock is therefore an injected dependency with a documented default, so
// tests pin it and get byte-identical output.

/** Recorded in `ocr_results.engine`. Never "paddleocr". */
export const STUB_OCR_ENGINE = "stub";

/** Recorded in `ocr_results.engine_version`. Bumped when the fixtures change. */
export const STUB_OCR_ENGINE_VERSION = "stub-v1";

/** Recorded in `ocr_results.preprocess_ops`; no image was ever touched. */
const STUB_PREPROCESS_OPS = ["stub"];

/** Every PH paper receipt's wall clock, same constant the parser uses. */
const RECEIPT_TIMEZONE = "Asia/Manila";

export interface StubOcrProviderOptions {
  /**
   * Wall clock used ONLY to place the fabricated receipt inside the freshness
   * window. Injected rather than read inline so determinism is testable:
   * same request plus same clock gives byte-identical output.
   */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit. Small, fast, and stable across runtimes, which is what
 * matters here: the same request must hash the same way on a dev laptop and
 * in CI. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A seeded draw sequence (xorshift32). Successive draws differ, and the whole
 * sequence is reproducible from the seed. */
function createDrawer(seed: number): (bound: number) => number {
  let state = seed === 0 ? 0x9e3779b9 : seed;
  return (bound: number) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % bound;
  };
}

function pick<T>(draw: (bound: number) => number, options: readonly T[]): T {
  // Non-null assertion avoided: the arrays below are all non-empty literals,
  // but the type system does not know that, so fall back to the first element.
  const chosen = options[draw(options.length)] ?? options[0];
  if (chosen === undefined) throw new Error("stub fixture list must not be empty");
  return chosen;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Deliberately fictional trading names. None of them contains a token from
// parse.ts's MERCHANT_SKIP_KEYWORDS ("TIN", "SN ", "TEL", ...), or the merchant
// line would be skipped as BIR metadata.
const MERCHANTS = [
  "SARI SARI EXPRESS",
  "KAPE'T KAPE CAFE",
  "LUTONG BAHAY EATERY",
  "BAYANIHAN GROCERY",
  "MANGO GRILL HOUSE",
] as const;

const BRANCHES = [
  "CEBU CITY BRANCH",
  "MAKATI BRANCH",
  "DUMAGUETE BRANCH",
  "ILOILO BRANCH",
] as const;

// Product names avoid parse.ts's LINE_ITEM_EXCLUSIONS vocabulary (TOTAL, VAT,
// CASH, CHANGE, POINTS, DISCOUNT, TIN, ...), or the line would be dropped
// before it could be read as an item.
const PRODUCTS = [
  { name: "CHICKEN ADOBO", unitCentavos: 12_000 },
  { name: "PORK SISIG", unitCentavos: 15_500 },
  { name: "GARLIC RICE", unitCentavos: 3_500 },
  { name: "ICED TEA", unitCentavos: 4_500 },
  { name: "LECHON KAWALI", unitCentavos: 18_000 },
  { name: "PANCIT CANTON", unitCentavos: 9_500 },
  { name: "HALO HALO", unitCentavos: 8_500 },
  { name: "BUKO JUICE", unitCentavos: 5_500 },
] as const;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Integer centavos to "1,245.00". Never a float multiply, same rule the
 * parser reads back. */
function formatMoney(centavos: number): string {
  const pesos = Math.trunc(centavos / 100);
  const remainder = String(centavos % 100).padStart(2, "0");
  return `${pesos.toLocaleString("en-US")}.${remainder}`;
}

/** The Manila calendar date of an instant, as {year, month, day}. Intl is the
 * only DST-correct way to do this without pulling in a date library, and it is
 * how the rest of this codebase reads a zoned wall clock. */
function manilaCalendarDate(instant: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RECEIPT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const find = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "01";
  return { year: find("year"), month: find("month"), day: find("day") };
}

function padRight(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width, " ");
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? ` ${text}` : text.padStart(width, " ");
}

// ---------------------------------------------------------------------------
// Receipt generation
// ---------------------------------------------------------------------------

interface StubReceipt {
  lines: string[];
  meanConfidence: number;
  durationMs: number;
}

const NAME_COLUMN = 24;
const UNIT_COLUMN = 10;
const AMOUNT_COLUMN = 11;
const LABEL_COLUMN = 26;
const TOTALS_COLUMN = 12;

function buildReceipt(request: OcrRequest, now: Date): StubReceipt {
  const seed = fnv1a(`${request.requestId}|${request.imageUrl}`);
  const draw = createDrawer(seed);

  const merchant = pick(draw, MERCHANTS);
  const branch = pick(draw, BRANCHES);
  const tin = `${100 + draw(900)}-${100 + draw(900)}-${100 + draw(900)}-000`;
  const receiptNumber = String(draw(9_999_999)).padStart(7, "0");

  // Trading hours, so the receipt does not trip doc 37's S5 closed-hours check
  // once opening_hours are wired in.
  const hour = 10 + draw(10);
  const minute = draw(60);
  const { year, month, day } = manilaCalendarDate(now);

  // 2 to 4 distinct products.
  const itemCount = 2 + draw(3);
  const chosen: Array<{ name: string; unitCentavos: number; qty: number }> = [];
  const used = new Set<string>();
  while (chosen.length < itemCount) {
    const product = pick(draw, PRODUCTS);
    if (used.has(product.name)) continue;
    used.add(product.name);
    chosen.push({ name: product.name, unitCentavos: product.unitCentavos, qty: 1 + draw(3) });
  }

  const itemLines = chosen.map((item) => {
    const lineTotal = item.unitCentavos * item.qty;
    return (
      padRight(String(item.qty), 3) +
      padRight(item.name, NAME_COLUMN) +
      padLeft(formatMoney(item.unitCentavos), UNIT_COLUMN) +
      padLeft(formatMoney(lineTotal), AMOUNT_COLUMN)
    );
  });

  const totalCentavos = chosen.reduce(
    (sum, item) => sum + item.unitCentavos * item.qty,
    0,
  );
  // PH 12% VAT-inclusive arithmetic, built so parse.ts's Stage 7 sanity check
  // passes: tax = total x 12/112 rounded to the centavo, subtotal = total -
  // tax, so `subtotal + tax = total` holds exactly.
  const taxCentavos = Math.round((totalCentavos * 12) / 112);
  const subtotalCentavos = totalCentavos - taxCentavos;
  // Tendered cash rounded up to the next hundred pesos above the total.
  const cashCentavos = (Math.floor(totalCentavos / 10_000) + 1) * 10_000;

  const lines = [
    merchant,
    branch,
    `TIN ${tin}`,
    `OR# ${receiptNumber}`,
    `${month}/${day}/${year} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    "",
    ...itemLines,
    "",
    padRight("VATABLE SALES", LABEL_COLUMN) + padLeft(formatMoney(subtotalCentavos), TOTALS_COLUMN),
    padRight("VAT (12%)", LABEL_COLUMN) + padLeft(formatMoney(taxCentavos), TOTALS_COLUMN),
    padRight("TOTAL", LABEL_COLUMN) + padLeft(formatMoney(totalCentavos), TOTALS_COLUMN),
    padRight("CASH", LABEL_COLUMN) + padLeft(formatMoney(cashCentavos), TOTALS_COLUMN),
    padRight("CHANGE", LABEL_COLUMN) +
      padLeft(formatMoney(cashCentavos - totalCentavos), TOTALS_COLUMN),
    "",
    "THIS SERVES AS AN OFFICIAL RECEIPT",
    "SALAMAT PO!",
  ];

  // High but not perfect, and stable per request: a clean phone photo of a
  // thermal slip is what this is pretending to be. Comfortably above doc 36
  // Stage 9's approve threshold once the field weights are applied, which is
  // the point - the stub must be able to reach `approved` in dev.
  const meanConfidence = (900 + draw(80)) / 1000;
  // Fabricated, not measured, so the value stays deterministic.
  const durationMs = 900 + draw(1_600);

  return { lines, meanConfidence, durationMs };
}

/** One block per printed line, stacked top to bottom with plausible pixel
 * boxes, so a template's `layout_anchors` tier has something real to resolve
 * against. */
function toBlocks(lines: string[], meanConfidence: number): OcrBlock[] {
  const blocks: OcrBlock[] = [];
  let y = 40;
  for (const line of lines) {
    if (line.trim().length === 0) {
      y += 18;
      continue;
    }
    blocks.push({
      text: line,
      bbox: [34, y, 34 + line.length * 11, y + 28],
      conf: meanConfidence,
    });
    y += 36;
  }
  return blocks;
}

export function createStubOcrProvider(options: StubOcrProviderOptions = {}): OcrProvider {
  const now = options.now ?? (() => new Date());

  return {
    name: "stub",

    ocr(request: OcrRequest): Promise<OcrResponse> {
      const receipt = buildReceipt(request, now());
      const rawText = receipt.lines.join("\n");

      return Promise.resolve({
        engine: STUB_OCR_ENGINE,
        engineVersion: STUB_OCR_ENGINE_VERSION,
        preprocessOps: STUB_PREPROCESS_OPS,
        rawText,
        blocks:
          request.returnBlocks === false
            ? []
            : toBlocks(receipt.lines, receipt.meanConfidence),
        meanConfidence: receipt.meanConfidence,
        durationMs: receipt.durationMs,
      });
    },
  };
}
