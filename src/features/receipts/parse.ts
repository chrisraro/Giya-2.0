import { zonedWallTimeToUtc } from "../campaigns/date-window";

// Pure receipt field extraction, per docs/30-modules/36-receipt-ocr-pipeline.md
// Stage 6 (the parse_config template shape) and Stage 7 (field rules). ZERO IO:
// the processing orchestrator, the template test-run endpoint, and any future
// golden-set harness all call these same functions with text they loaded
// themselves.
//
// Three-tier strategy per Stage 7. Tier 1 is the matched template's
// parse_config: its regexes, keyword lists and layout_anchors. Tier 2 is
// generic PH heuristics: keyword dictionaries that supersede every template's
// vocabulary plus BIR-standard receipt wording, a right-aligned money column,
// and a largest-amount-near-the-foot fallback for the total. Tier 3 (LLM
// parse-assist) is [V1] and deliberately absent here.
//
// Nothing in this module throws on bad input. A garbled OCR read is the normal
// case, not an exceptional one: the caller routes on what came back null, and
// the confidence model (./confidence.ts) turns that into a review or a
// rejection. The one thing that must never happen is a wrong total_centavos
// reaching the points engine, so every amount is integer centavos parsed from
// digit strings, never from a float multiply.

/** The zone every PH paper receipt's wall clock is read in. Overridable per
 * call so tests and any future per-business timezone column can thread a
 * different zone through explicitly rather than relying on an implicit
 * global. */
export const RECEIPT_TIMEZONE = "Asia/Manila";

/** A normalized [0-1] vertical page band, as authored in `layout_anchors`. */
export interface LayoutRegion {
  y?: [number, number];
  align?: string;
}

export interface LayoutAnchors {
  header?: LayoutRegion;
  line_items?: LayoutRegion;
  totals?: LayoutRegion;
  footer_keywords?: string[];
}

/**
 * The `receipt_templates.parse_config` JSONB shape (doc 36 Stage 6). Every
 * field is optional: templates are business-authored and partially filled in
 * the portal, and a receipt with no matched template at all must still parse
 * through the generic tier.
 *
 * Note the deliberate distinction between an ABSENT `tax_keywords` and an
 * EMPTY one. Absent means "no template opinion, use the generic VAT
 * vocabulary". Empty means "this business is non-VAT registered", which
 * switches the 12% sanity check off entirely rather than failing it.
 */
export interface ParseConfig {
  merchant_aliases?: string[];
  tin?: string;
  receipt_no_regex?: string;
  /** Priority order; tried before the built-in PH format precedence. */
  date_formats?: string[];
  /** Priority order; the first keyword with a readable amount wins. */
  total_keywords?: string[];
  subtotal_keywords?: string[];
  tax_keywords?: string[];
  layout_anchors?: LayoutAnchors;
  /** Named groups qty / name / amount. Business-authored, so untrusted. */
  line_item_pattern?: string;
  amount_sanity?: {
    min_total_centavos?: number;
    max_total_centavos?: number;
  };
  handwriting?: {
    min_block_conf?: number;
    digits_only_amounts?: boolean;
  };
}

/** One OCR text block as the service returns it (doc 36 Stage 4). PaddleOCR
 * emits these at line granularity, so one block is treated as one line.
 * `bbox` is `[x0, y0, x1, y1]` in image pixels. */
export interface OcrBlock {
  text: string;
  bbox: [number, number, number, number];
  conf: number;
}

export interface ParseInput {
  rawText: string;
  blocks?: OcrBlock[];
  config?: ParseConfig;
  /** Defaults to RECEIPT_TIMEZONE. */
  timeZone?: string;
}

export interface ParsedAmounts {
  subtotalCentavos: number | null;
  taxCentavos: number | null;
  totalCentavos: number | null;
  vatConsistent: boolean;
}

export interface ParsedLineItem {
  rawText: string;
  qty: number | null;
  unitPriceCentavos: number | null;
  lineTotalCentavos: number | null;
  sort: number;
}

export type ParseNote = "date_ambiguous" | "vat_inconsistent" | "amount_out_of_range";

export interface ParsedReceipt {
  merchantName: string | null;
  receiptNumber: string | null;
  receiptDate: Date | null;
  /** True when two readings of a numeric date were both valid; the older one
   * was taken. The caller adds a review note (doc 36 Stage 7). */
  dateAmbiguous: boolean;
  /**
   * Whether `receiptDate`'s time-of-day came from an actual HH:mm token
   * printed on the receipt (`findAdjoiningTime`), as opposed to the noon
   * default `extractDate` fills in when no clock is adjoining the date.
   *
   * This is the flag doc 37 S5's closed-hours check (`../closed-hours.ts`)
   * gates on: a defaulted noon is not evidence of anything printed on the
   * paper, and scoring it against a business's opening hours would score a
   * fact this parser never observed. False whenever `receiptDate` is null,
   * since there is no time to have extracted.
   */
  timeExtracted: boolean;
  subtotalCentavos: number | null;
  taxCentavos: number | null;
  totalCentavos: number | null;
  vatConsistent: boolean;
  lineItems: ParsedLineItem[];
  /** null when the template declared no `amount_sanity` bounds, or when no
   * total was extracted to test against them. */
  withinAmountSanity: boolean | null;
  notes: ParseNote[];
}

// ---------------------------------------------------------------------------
// Untrusted-input budgets
// ---------------------------------------------------------------------------
//
// `receipt_no_regex` and `line_item_pattern` are authored by business staff in
// the portal, so they are untrusted code running in our process. JS regexes
// cannot be interrupted once started, so the only real defence is to bound
// what they can chew on: a catastrophic-backtracking pattern over 300
// characters is a millisecond, over 300KB it is a hung worker. The caps below
// are the primary mitigation; the shape check in `safeCompile` is a cheap
// second line, and it never blocks work because an unusable pattern silently
// falls through to the generic tier.

const MAX_TEXT_LENGTH = 20_000;
const MAX_LINES = 400;
const MAX_LINE_LENGTH = 300;
const MAX_PATTERN_LENGTH = 200;
/** Slice of the receipt text ever fed to a business-authored regex. */
const MAX_UNTRUSTED_REGEX_INPUT = 4_000;

/** A quantified group whose body itself contains a quantifier: the `(a+)+`
 * family that makes backtracking explode. Crude on purpose, and false
 * positives cost nothing but a fall-through to the generic tier. */
const NESTED_QUANTIFIER_PATTERN = /\([^()]*[*+][^()]*\)\s*[*+{]/;

function safeCompile(pattern: string | undefined, flags: string): RegExp | null {
  if (pattern === undefined || pattern.length === 0) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** Run an untrusted regex over bounded input, swallowing anything it throws.
 * Returns null rather than propagating: a broken template must degrade to the
 * generic tier, never fail the receipt. */
function safeExec(regex: RegExp, text: string): RegExpExecArray | null {
  try {
    regex.lastIndex = 0;
    return regex.exec(text.slice(0, MAX_UNTRUSTED_REGEX_INPUT));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

// A PH money token: optional peso marker, an integer part with optional
// thousands separators, an optional 1-2 digit fraction. The lookarounds do the
// real work:
//   (?<![\d.,\-])  never start mid-number, and never inside a dashed run like
//                  a TIN "123-456-789-000"
//   (?![\d.,%])    never stop mid-number, and never read "12%" as 12 pesos
//   (?!-\d)        never read the head of a dashed run as a standalone amount
const MONEY_TOKEN_PATTERN =
  /(?<![\d.,\-])(₱|PHP|P)?[ \t]{0,2}(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d.,%])(?!-\d)/g;

/** Guard against absurd digit runs (serial numbers, OCR smears) overflowing
 * the integer range. No PH receipt totals ten million pesos. */
const MAX_INTEGER_DIGITS = 9;

interface MoneyToken {
  centavos: number;
  /** Index of the first character of the token in its line. */
  start: number;
  /** Index one past the last character of the token in its line. */
  end: number;
  /** A peso marker or a decimal fraction was present. Bare integers are only
   * money on handwritten pads (`digits_only_amounts`) or on a line a keyword
   * already identified as an amount line. */
  explicit: boolean;
}

/** Digits to centavos WITHOUT a float multiply. `1,245.00` becomes
 * 1245 * 100 + 0, never 1245.00 * 100 (which IEEE754 can hand back as
 * 124499.99999999999 for other values). */
function digitsToCentavos(integerPart: string, fraction: string | undefined): number | null {
  const digits = integerPart.replace(/,/g, "");
  if (digits.length === 0 || digits.length > MAX_INTEGER_DIGITS) return null;
  const pesos = Number(digits);
  if (!Number.isSafeInteger(pesos)) return null;
  // "5" means 50 centavos, not 5. Pad on the right, never parse as a float.
  const centavoDigits = (fraction ?? "").padEnd(2, "0");
  return pesos * 100 + Number(centavoDigits);
}

function findMoneyTokens(line: string): MoneyToken[] {
  const tokens: MoneyToken[] = [];
  const regex = new RegExp(MONEY_TOKEN_PATTERN.source, "g");
  let match = regex.exec(line);
  while (match !== null) {
    const [whole, marker, integerPart, fraction] = match;
    const centavos = digitsToCentavos(integerPart ?? "", fraction);
    if (centavos !== null) {
      const end = match.index + whole.length;
      // A bare integer immediately followed by a letter is part of a word
      // ("1PC", "2X"), never an amount, whatever mode we are in.
      const followedByLetter = /^[A-Za-z]/.test(line.slice(end, end + 1));
      const explicit = marker !== undefined || fraction !== undefined;
      if (explicit || !followedByLetter) {
        tokens.push({ centavos, start: match.index, end, explicit });
      }
    }
    // Guard the pathological zero-length match; the pattern cannot produce
    // one today but a future edit must not turn this into an infinite loop.
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
    match = regex.exec(line);
  }
  return tokens;
}

/**
 * The centavo value of a single money token, or null when the text carries
 * none. Exported because the template test-run endpoint and the review UI both
 * need the exact same string-to-centavos rule the pipeline used.
 */
export function parseCentavos(text: string): number | null {
  const tokens = findMoneyTokens(text.slice(0, MAX_LINE_LENGTH));
  return tokens[0]?.centavos ?? null;
}

/** One money token this parser recognised, stripped of its position. */
export interface AmountToken {
  centavos: number;
  /** A peso marker or a decimal fraction was present. A bare integer run is
   * only money on a handwritten pad (`handwriting.digits_only_amounts`). */
  explicit: boolean;
}

/**
 * Every money token in `text`, in reading order, under exactly the rule the
 * deterministic tiers use.
 *
 * Exported for the LLM parse-assist tier (./extract.ts). Its verbatim-presence
 * rail has to answer "is this candidate a number THIS parser would itself have
 * read as money, at a position it would have read it?", and the only honest
 * way to answer that is with this tokenizer. Comparing digit substrings
 * instead would let a candidate be "found" inside a TIN or a phone number,
 * whereas the token lookarounds refuse to start or stop inside a dashed run.
 */
export function findAmountTokens(text: string): AmountToken[] {
  return text
    .slice(0, MAX_TEXT_LENGTH)
    .split(/\r?\n/)
    .slice(0, MAX_LINES)
    .flatMap((line) => findMoneyTokens(line.slice(0, MAX_LINE_LENGTH)))
    .map(({ centavos, explicit }) => ({ centavos, explicit }));
}

// ---------------------------------------------------------------------------
// Lines and layout regions
// ---------------------------------------------------------------------------

function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Uppercase, collapse whitespace, and drop everything that is not a letter,
 * a digit or a space. Used only for alias comparison, so "ALING NENA'S" and
 * "ALING NENAS" are the same merchant. */
function normalizeAlias(text: string): string {
  return normalizeForMatch(text).replace(/[^A-Z0-9 ]+/g, "");
}

function resolveText(input: ParseInput): string {
  if (input.rawText.trim().length > 0) return input.rawText.slice(0, MAX_TEXT_LENGTH);
  const fromBlocks = (input.blocks ?? []).map((block) => block.text).join("\n");
  return fromBlocks.slice(0, MAX_TEXT_LENGTH);
}

function textLines(input: ParseInput): string[] {
  return resolveText(input)
    .split(/\r?\n/)
    .slice(0, MAX_LINES)
    .map((line) => line.slice(0, MAX_LINE_LENGTH))
    .filter((line) => line.trim().length > 0);
}

/** Blocks the OCR service is confident enough about. Only a template that
 * declares a handwriting floor filters anything: we never invent a threshold
 * of our own, because dropping a block we should have kept loses the total. */
function confidentBlocks(input: ParseInput): OcrBlock[] {
  const blocks = input.blocks ?? [];
  const floor = input.config?.handwriting?.min_block_conf;
  if (floor === undefined) return blocks;
  return blocks.filter((block) => block.conf >= floor);
}

/**
 * The lines lying inside a normalized [0-1] vertical band, in top-to-bottom
 * order. Returns null (not an empty list) when the region cannot be resolved,
 * which is the signal to fall back to plain text lines: no blocks, no anchor
 * for this field, or a degenerate page height.
 *
 * A block is placed by its vertical CENTRE, so a tall block straddling a band
 * edge lands on the side it mostly occupies. Page height is taken as the
 * lowest block edge, since the OCR contract carries pixel bboxes but no image
 * dimensions.
 */
function regionLines(input: ParseInput, region: LayoutRegion | undefined): string[] | null {
  const blocks = confidentBlocks(input);
  if (blocks.length === 0) return null;
  const band = region?.y;
  if (band === undefined) return null;

  const pageHeight = Math.max(...blocks.map((block) => block.bbox[3]));
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) return null;

  const [top, bottom] = band;
  return blocks
    .filter((block) => {
      const centre = (block.bbox[1] + block.bbox[3]) / 2 / pageHeight;
      return centre >= top && centre <= bottom;
    })
    .sort((a, b) => a.bbox[1] - b.bbox[1])
    .map((block) => block.text.slice(0, MAX_LINE_LENGTH))
    .filter((line) => line.trim().length > 0);
}

/** Region lines when the template anchors one, plain text lines otherwise. */
function linesFor(input: ParseInput, region: LayoutRegion | undefined): string[] {
  return regionLines(input, region) ?? textLines(input);
}

// ---------------------------------------------------------------------------
// Merchant name
// ---------------------------------------------------------------------------

/** Lines that carry BIR or contact metadata rather than the trading name. */
const MERCHANT_SKIP_KEYWORDS = [
  "TIN",
  "VAT REG",
  "MIN ",
  "SN ",
  "SERIAL",
  "ACCR",
  "PERMIT",
  "OFFICIAL RECEIPT",
  "SALES INVOICE",
  "TEL",
  "PHONE",
  "CEL",
  "WWW",
  "HTTP",
];

function countLetters(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

function looksLikeMerchantLine(line: string): boolean {
  const normalized = normalizeForMatch(line);
  if (countLetters(normalized) < 2) return false;
  if (DATE_LIKE_PATTERN.test(normalized)) return false;
  return !MERCHANT_SKIP_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/** How far down a template-less receipt we will look for the trading name. */
const GENERIC_HEADER_DEPTH = 6;

/**
 * The merchant's trading name (doc 36 Stage 7). Template aliases first, then
 * the first meaningful line of the header region (or of the top of the page
 * when no anchors exist).
 *
 * The returned value is the RAW line, only trimmed and whitespace-collapsed:
 * doc 36 stores the raw form and normalizes separately for matching, so the
 * business matcher (./matching.ts) can run its own trigram comparison against
 * text that still looks like what was printed.
 */
export function extractMerchantName(input: ParseInput): string | null {
  const aliases = input.config?.merchant_aliases ?? [];
  const allLines = textLines(input);

  // Tier 1: an alias hit anywhere on the receipt, not just the header. Some
  // POS slips print the trading name in the footer instead.
  if (aliases.length > 0) {
    const normalizedAliases = aliases
      .map((alias) => normalizeAlias(alias))
      .filter((alias) => alias.length > 0);
    for (const line of allLines) {
      const normalized = normalizeAlias(line);
      if (normalizedAliases.some((alias) => normalized.includes(alias))) {
        return line.trim().replace(/\s+/g, " ");
      }
    }
  }

  // Tier 2: the header region if the template anchors one, else the top of
  // the page, skipping BIR metadata and lines with no letters in them.
  const header = regionLines(input, input.config?.layout_anchors?.header);
  const candidates = header ?? allLines.slice(0, GENERIC_HEADER_DEPTH);
  for (const line of candidates) {
    if (looksLikeMerchantLine(line)) return line.trim().replace(/\s+/g, " ");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipt number
// ---------------------------------------------------------------------------

/** The generic PH pattern from doc 36 Stage 7. Anchored on word boundaries so
 * "OR" inside a word is not a receipt prefix, and with an optional "NO"/"NUM"
 * word between prefix and digits because PH slips print "OR NO. 0012345" at
 * least as often as "OR# 0012345". The word itself is not captured: only the
 * prefix and the digits are significant. A bare "No. 04821" with no prefix is
 * deliberately NOT generic - it is far too common in ordinary text - so a
 * handwritten pad has to declare it in its template `receipt_no_regex`. */
const GENERIC_RECEIPT_NO_PATTERN =
  /\b(SI|OR|INV|RECEIPT|TRANS)\b[#:.\s]*(?:NO|NR|NUM|NUMBER)?[#:.\s]*(\d{3,})/i;

/**
 * Normalize a receipt number for storage: uppercase, and drop the separators
 * a POS prints for looks (`#`, `:`, `.`, `-`, spaces). DIGITS ARE NEVER
 * TOUCHED - leading zeros are significant because the value participates in
 * the partial unique index `receipts_number_unique`, where "04821" and "4821"
 * must remain two different receipts.
 */
export function normalizeReceiptNumber(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return normalized.length > 0 ? normalized : null;
}

/**
 * The receipt number (doc 36 Stage 7). The template's `receipt_no_regex`
 * first; its capture group 1 when it has one (the doc's own examples capture
 * just the digits), otherwise the whole match. Falls back to the generic
 * pattern, which keeps the significant prefix: "OR# 0012345" stores as
 * "OR0012345".
 */
export function extractReceiptNumber(input: ParseInput): string | null {
  const text = resolveText(input);
  if (text.trim().length === 0) return null;

  const templateRegex = safeCompile(input.config?.receipt_no_regex, "i");
  if (templateRegex !== null) {
    const match = safeExec(templateRegex, text);
    if (match !== null) {
      const captured = match[1] ?? match[0];
      const normalized = normalizeReceiptNumber(captured);
      if (normalized !== null) return normalized;
    }
  }

  const generic = GENERIC_RECEIPT_NO_PATTERN.exec(text);
  if (generic === null) return null;
  return normalizeReceiptNumber(`${generic[1] ?? ""}${generic[2] ?? ""}`);
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

/** Any slash/dash/dot numeric date, used to keep date lines out of the
 * line-item split and out of merchant detection. */
const DATE_LIKE_PATTERN = /\d{1,4}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}/;

/** HH:mm, optionally with seconds and a meridiem. */
const TIME_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM)?\b/i;

/**
 * PH format precedence (doc 36 Stage 7), applied after any template-declared
 * formats. MM/dd/yyyy leads because it is the dominant PH POS convention;
 * dd/MM/yyyy sits below MM/dd/yy so it only ever fires when the day slot is
 * above 12 and therefore disambiguates on its own.
 */
const DEFAULT_DATE_FORMATS = [
  "MM/dd/yyyy",
  "MM/dd/yy",
  "dd/MM/yyyy",
  "MMM dd, yyyy",
  "yyyy-MM-dd",
];

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface DateFormatSpec {
  regex: RegExp;
  /** Capture group index of each part, 1-based. */
  order: { year: number; month: number; day: number };
  /** Month was written as a name, so nothing about it is ambiguous. */
  monthIsName: boolean;
  yearIsTwoDigit: boolean;
  /** The format leads with a day or month slot, so a day/month swap is a
   * plausible second reading. ISO yyyy-MM-dd never is. */
  dayMonthLeading: boolean;
}

/**
 * Turn a format string ("MM/dd/yyyy", "M/d/yy", "MMM dd, yyyy") into a
 * matcher. Supported tokens are exactly the ones doc 36's parse_config
 * examples use. Any literal `/`, `-` or `.` accepts all three separators,
 * because the same POS prints "07/24/2026" and "07-24-2026" depending on
 * paper and firmware; everything else in the format is matched literally.
 *
 * Returns null for a format we cannot express, which simply drops that entry
 * from the priority list.
 */
function compileDateFormat(format: string): DateFormatSpec | null {
  const order: Partial<Record<"year" | "month" | "day", number>> = {};
  let monthIsName = false;
  let yearIsTwoDigit = false;
  let firstToken: "year" | "month" | "day" | null = null;
  let group = 0;
  let source = "";
  let index = 0;

  while (index < format.length) {
    const rest = format.slice(index);
    if (rest.startsWith("yyyy")) {
      group += 1;
      order.year = group;
      firstToken ??= "year";
      source += "(\\d{4})";
      index += 4;
    } else if (rest.startsWith("yy")) {
      group += 1;
      order.year = group;
      yearIsTwoDigit = true;
      firstToken ??= "year";
      source += "(\\d{2})";
      index += 2;
    } else if (rest.startsWith("MMM")) {
      group += 1;
      order.month = group;
      monthIsName = true;
      firstToken ??= "month";
      source += "([A-Za-z]{3,9})";
      index += 3;
    } else if (rest.startsWith("MM")) {
      group += 1;
      order.month = group;
      firstToken ??= "month";
      source += "(\\d{2})";
      index += 2;
    } else if (rest.startsWith("M")) {
      group += 1;
      order.month = group;
      firstToken ??= "month";
      source += "(\\d{1,2})";
      index += 1;
    } else if (rest.startsWith("dd")) {
      group += 1;
      order.day = group;
      firstToken ??= "day";
      source += "(\\d{2})";
      index += 2;
    } else if (rest.startsWith("d")) {
      group += 1;
      order.day = group;
      firstToken ??= "day";
      source += "(\\d{1,2})";
      index += 1;
    } else if ("/-.".includes(rest[0] ?? "")) {
      source += "\\s*[/.-]\\s*";
      index += 1;
    } else if (rest.startsWith(" ")) {
      source += "\\s+";
      index += 1;
    } else {
      source += (rest[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      source += "\\s*";
      index += 1;
    }
  }

  if (order.year === undefined || order.month === undefined || order.day === undefined) {
    return null;
  }
  try {
    return {
      // Bracketed by "not part of a longer number" on both sides so a serial
      // number or a TIN run can never masquerade as a date.
      regex: new RegExp(`(?<![\\d/.-])${source}(?![\\d/.-])`, "g"),
      order: { year: order.year, month: order.month, day: order.day },
      monthIsName,
      yearIsTwoDigit,
      dayMonthLeading: firstToken === "month" || firstToken === "day",
    };
  } catch {
    return null;
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function isValidCalendarDate(date: CalendarDate): boolean {
  if (date.year < 1900 || date.year > 2999) return false;
  if (date.month < 1 || date.month > 12) return false;
  return date.day >= 1 && date.day <= daysInMonth(date.year, date.month);
}

/** Two-digit years: receipts are recent, so 00-69 is this century and 70-99
 * is the last one. */
function expandTwoDigitYear(value: number): number {
  return value < 70 ? 2000 + value : 1900 + value;
}

function toDateString({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

interface DateMatch {
  calendar: CalendarDate;
  index: number;
}

/** The first occurrence of `spec` in `text` that is a real calendar date.
 * A match that parses to 31 February keeps scanning rather than aborting the
 * format, because a receipt often carries several date-shaped tokens. */
function firstValidDateMatch(text: string, spec: DateFormatSpec): DateMatch | null {
  const regex = new RegExp(spec.regex.source, "g");
  let match = regex.exec(text);
  while (match !== null) {
    const rawYear = Number(match[spec.order.year]);
    const rawDay = Number(match[spec.order.day]);
    const monthText = match[spec.order.month] ?? "";
    const month = spec.monthIsName
      ? MONTH_NAMES.indexOf(monthText.slice(0, 3).toUpperCase()) + 1
      : Number(monthText);
    const calendar: CalendarDate = {
      year: spec.yearIsTwoDigit ? expandTwoDigitYear(rawYear) : rawYear,
      month,
      day: rawDay,
    };
    if (isValidCalendarDate(calendar)) return { calendar, index: match.index };
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
    match = regex.exec(text);
  }
  return null;
}

/** A time token on the date's own line, else on the line just after it, else
 * on the line just before. "Adjoining" in doc 36 Stage 7 means the clock the
 * POS printed next to the date, not any colon anywhere on the slip. */
function findAdjoiningTime(text: string, dateIndex: number): { hour: number; minute: number } | null {
  const lines = text.split(/\r?\n/);
  let cursor = 0;
  let dateLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const length = (lines[i] ?? "").length + 1;
    if (dateIndex < cursor + length) {
      dateLine = i;
      break;
    }
    cursor += length;
  }

  for (const offset of [0, 1, -1]) {
    const line = lines[dateLine + offset];
    if (line === undefined) continue;
    const match = TIME_PATTERN.exec(line);
    if (match === null) continue;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = match[3]?.toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (hour > 23) continue;
    return { hour, minute };
  }
  return null;
}

/**
 * The receipt date as a UTC instant, plus whether the reading was ambiguous
 * (doc 36 Stage 7).
 *
 * Template `date_formats` are tried first and are AUTHORITATIVE: a business
 * that declared "MM/dd/yyyy" has told us how its POS prints, so 05/06 is 6 May
 * and there is nothing to flag. Only the built-in precedence list can produce
 * an ambiguous reading.
 *
 * On the generic path, a numeric day/month token that reads as two different
 * real dates takes the OLDER one and sets `ambiguous`. Older is the
 * conservative choice: an older date is likelier to fail the Stage 8 freshness
 * rule, which costs the consumer a re-scan rather than costing the business
 * points it never owed. The flag is what makes that recoverable, so it always
 * travels with the date.
 *
 * Note this can override the MM/dd-first precedence for a genuinely two-way
 * token: 06/05/2026 resolves to 6 May, not 5 June. That is the doc's explicit
 * conservative rule, and `ambiguous: true` sends it to a human either way.
 *
 * Time comes from an adjoining HH:mm token; without one the wall clock is
 * assumed to be 12:00, which is the middle of the trading day and therefore
 * the reading least likely to fall on the wrong side of a day boundary.
 */
export function extractDate(
  input: ParseInput,
): { date: Date; ambiguous: boolean; timeExtracted: boolean } | null {
  const text = resolveText(input);
  if (text.trim().length === 0) return null;
  const timeZone = input.timeZone ?? RECEIPT_TIMEZONE;

  const templateFormats = input.config?.date_formats ?? [];
  const candidates: Array<{ format: string; fromTemplate: boolean }> = [
    ...templateFormats.map((format) => ({ format, fromTemplate: true })),
    ...DEFAULT_DATE_FORMATS.filter((format) => !templateFormats.includes(format)).map(
      (format) => ({ format, fromTemplate: false }),
    ),
  ];

  for (const { format, fromTemplate } of candidates) {
    const spec = compileDateFormat(format);
    if (spec === null) continue;
    const hit = firstValidDateMatch(text, spec);
    if (hit === null) continue;

    let calendar = hit.calendar;
    let ambiguous = false;
    if (!fromTemplate && !spec.monthIsName && spec.dayMonthLeading) {
      const swapped: CalendarDate = {
        year: calendar.year,
        month: calendar.day,
        day: calendar.month,
      };
      if (isValidCalendarDate(swapped) && compareCalendarDates(swapped, calendar) !== 0) {
        ambiguous = true;
        calendar = compareCalendarDates(swapped, calendar) < 0 ? swapped : calendar;
      }
    }

    const time = findAdjoiningTime(text, hit.index);
    return {
      date: zonedWallTimeToUtc(
        toDateString(calendar),
        time?.hour ?? 12,
        time?.minute ?? 0,
        timeZone,
      ),
      ambiguous,
      timeExtracted: time !== null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Amounts and the VAT sanity check
// ---------------------------------------------------------------------------

// Generic keyword dictionaries: a superset of the template vocabulary plus
// BIR-standard receipt wording (doc 36 Stage 7 tier 2). Order is priority
// order, most specific first, because the first keyword with a readable amount
// wins.
const GENERIC_SUBTOTAL_KEYWORDS = [
  "VATABLE SALES",
  "VATABLE AMOUNT",
  "AMOUNT NET OF VAT",
  "NET OF VAT",
  "SUBTOTAL",
  "SUB TOTAL",
  "SUB-TOTAL",
];
const GENERIC_TAX_KEYWORDS = [
  "VAT AMOUNT",
  "12% VAT",
  "VAT 12%",
  "V.A.T.",
  "SALES TAX",
  "VAT",
  "TAX",
];
const GENERIC_TOTAL_KEYWORDS = [
  "GRAND TOTAL",
  "TOTAL DUE",
  "AMOUNT DUE",
  "TOTAL AMOUNT",
  "TOTAL",
  "TTL",
];

/** Lines that carry the VAT vocabulary but are not the VAT figure. */
const TAX_EXCLUSIONS = ["VAT EXEMPT", "VAT-EXEMPT", "ZERO RATED", "ZERO-RATED", "VAT REG", "VATABLE"];
/** Lines that carry the word TOTAL but count things rather than money. */
const TOTAL_EXCLUSIONS = [
  "TOTAL ITEM",
  "TOTAL QTY",
  "TOTAL QUANTITY",
  "TOTAL NO",
  "TOTAL SAVINGS",
  "TOTAL DISCOUNT",
  "ITEM COUNT",
];

interface KeywordHit {
  keywordRank: number;
  lineIndex: number;
  centavos: number;
}

function firstKeywordIndex(normalized: string, keywords: string[]): number {
  for (let i = 0; i < keywords.length; i += 1) {
    const keyword = normalizeForMatch(keywords[i] ?? "");
    if (keyword.length > 0 && normalized.includes(keyword)) return i;
  }
  return -1;
}

/** The amount on an amount line: the LAST money token, which is the
 * right-aligned money column every PH POS prints. A bare integer counts here
 * even without a peso marker, because a keyword already established that this
 * line is about money ("TOTAL 355" on a handwritten pad). */
function amountOnLine(line: string, allowBareIntegers: boolean): number | null {
  const tokens = findMoneyTokens(line);
  if (tokens.length === 0) return null;
  const explicit = tokens.filter((token) => token.explicit);
  const pool = explicit.length > 0 || !allowBareIntegers ? explicit : tokens;
  return pool[pool.length - 1]?.centavos ?? null;
}

/** Pick the highest-priority keyword; among equal keywords take the
 * bottom-most line, which is where a POS prints the figure that supersedes. */
function bestHit(hits: KeywordHit[]): number | null {
  if (hits.length === 0) return null;
  const sorted = [...hits].sort(
    (a, b) => a.keywordRank - b.keywordRank || b.lineIndex - a.lineIndex,
  );
  return sorted[0]?.centavos ?? null;
}

/** Tolerance for the VAT comparisons: plus or minus 5 centavos or plus or
 * minus 0.5 percent, whichever is LARGER (doc 36 Stage 7). The absolute floor
 * covers a small receipt's rounding; the relative one covers a big one's. */
function vatTolerance(expected: number): number {
  return Math.max(5, Math.abs(expected) * 0.005);
}

/** The three amounts the PH VAT-inclusive relations are tested over. */
export interface VatSanityInput {
  subtotalCentavos: number | null;
  taxCentavos: number | null;
  totalCentavos: number | null;
}

export interface VatSanityResult extends VatSanityInput {
  /** The check actually RAN: a total and a tax figure were both present.
   * Distinguishes "the VAT block did not add up" from "there is no VAT
   * block", which both leave `consistent` false. */
  checked: boolean;
  consistent: boolean;
}

/**
 * The PH 12% VAT-inclusive sanity check of doc 36 Stage 7, over amounts the
 * caller already has: `tax ~= total x 12/112` AND `subtotal + tax ~= total`,
 * tolerance plus or minus 5 centavos or 0.5 percent, whichever is larger.
 *
 * On failure the TOTAL IS ALWAYS KEPT - it is authoritative for the points
 * award - and only the sub-field that failed to corroborate it comes back
 * null. Tax is corroborated by the 12/112 ratio alone. Subtotal is
 * corroborated either directly (total x 100/112) or through a tax figure that
 * itself survived; a subtotal whose only support is a tax we just discarded is
 * borrowing its credibility from a discredited number, so it goes too. We
 * never DERIVE a missing sub-field from the total: an invented subtotal that
 * looks plausible is worse than a null one, because analytics would believe
 * it.
 *
 * Pass a null total or tax to skip the check; the inputs come straight back.
 * That is how a non-VAT template (empty `tax_keywords`) opts out. Exported so
 * the LLM parse-assist tier (./extract.ts) applies the identical rule to a
 * model's candidate amounts rather than inventing a second one.
 */
export function checkVatSanity(input: VatSanityInput): VatSanityResult {
  const totalCentavos = input.totalCentavos;
  const tax = input.taxCentavos;
  let subtotalCentavos = input.subtotalCentavos;
  let taxCentavos = tax;

  if (totalCentavos === null || tax === null) {
    return { subtotalCentavos, taxCentavos, totalCentavos, checked: false, consistent: false };
  }

  // The expected values are floats on purpose: they exist only to be compared
  // against a tolerance and never reach the output, where every amount stays
  // the integer centavo value that was printed.
  const expectedTax = (totalCentavos * 12) / 112;
  const expectedSubtotal = (totalCentavos * 100) / 112;
  const ratioOk = Math.abs(tax - expectedTax) <= vatTolerance(expectedTax);
  // The sum check needs a subtotal; with none present the ratio alone
  // decides, since that is all the evidence there is.
  const sumOk =
    subtotalCentavos === null
      ? true
      : Math.abs(subtotalCentavos + tax - totalCentavos) <= vatTolerance(totalCentavos);
  const subtotalOk =
    subtotalCentavos === null
      ? true
      : Math.abs(subtotalCentavos - expectedSubtotal) <= vatTolerance(expectedSubtotal);

  const consistent = ratioOk && sumOk;
  if (!consistent) {
    if (!ratioOk) taxCentavos = null;
    if (!subtotalOk && !(sumOk && ratioOk)) subtotalCentavos = null;
  }
  return { subtotalCentavos, taxCentavos, totalCentavos, checked: true, consistent };
}

/**
 * Subtotal, tax and total in integer centavos, plus whether the PH 12%
 * VAT-inclusive relations hold (doc 36 Stage 7).
 *
 * The check is `tax ~= total x 12/112` AND `subtotal + tax ~= total`. On
 * failure the TOTAL IS ALWAYS KEPT - it is authoritative for the points award
 * - and only the sub-field that failed to corroborate it is nulled. We never
 * derive a missing sub-field from the total: an invented subtotal that looks
 * plausible is worse than a null one, because analytics would believe it.
 *
 * A template with an EMPTY `tax_keywords` is a non-VAT business, so the check
 * is skipped entirely: `vatConsistent` is false (no bonus was earned, doc 36
 * Stage 9) but nothing is nulled.
 */
export function extractAmounts(input: ParseInput): ParsedAmounts {
  const { subtotalCentavos, taxCentavos, totalCentavos, vatConsistent } =
    extractAmountsDetailed(input);
  return { subtotalCentavos, taxCentavos, totalCentavos, vatConsistent };
}

/** `extractAmounts` plus whether the VAT check actually RAN. Composition needs
 * that extra bit to tell "the VAT block did not add up" (worth a reviewer's
 * attention) from "there is no VAT block" (a non-VAT business, entirely
 * normal); both leave `vatConsistent` false. */
interface DetailedAmounts extends ParsedAmounts {
  vatChecked: boolean;
}

function extractAmountsDetailed(input: ParseInput): DetailedAmounts {
  const config = input.config;
  const lines = linesFor(input, config?.layout_anchors?.totals);
  const allowBareIntegers = config?.handwriting?.digits_only_amounts === true;

  const subtotalKeywords = config?.subtotal_keywords ?? GENERIC_SUBTOTAL_KEYWORDS;
  const taxKeywords = config?.tax_keywords ?? GENERIC_TAX_KEYWORDS;
  const totalKeywords = config?.total_keywords ?? GENERIC_TOTAL_KEYWORDS;
  const vatApplies = taxKeywords.length > 0;

  const subtotalHits: KeywordHit[] = [];
  const taxHits: KeywordHit[] = [];
  const totalHits: KeywordHit[] = [];
  // Lines a keyword already claimed. The largest-amount fallback below must
  // not re-read a subtotal or a VAT figure as if it were the total.
  const claimedLines = new Set<number>();

  lines.forEach((line, lineIndex) => {
    const normalized = normalizeForMatch(line);
    // Classification order matters and is not alphabetical: "SUBTOTAL"
    // contains "TOTAL" and "VATABLE SALES" contains "VAT", so the more
    // specific category has to claim the line first.
    const subtotalRank = firstKeywordIndex(normalized, subtotalKeywords);
    if (subtotalRank >= 0) {
      claimedLines.add(lineIndex);
      const centavos = amountOnLine(line, true);
      if (centavos !== null) subtotalHits.push({ keywordRank: subtotalRank, lineIndex, centavos });
      return;
    }
    if (vatApplies && !TAX_EXCLUSIONS.some((bad) => normalized.includes(bad))) {
      const taxRank = firstKeywordIndex(normalized, taxKeywords);
      if (taxRank >= 0) {
        claimedLines.add(lineIndex);
        const centavos = amountOnLine(line, true);
        if (centavos !== null) taxHits.push({ keywordRank: taxRank, lineIndex, centavos });
        return;
      }
    }
    if (!TOTAL_EXCLUSIONS.some((bad) => normalized.includes(bad))) {
      const totalRank = firstKeywordIndex(normalized, totalKeywords);
      if (totalRank >= 0) {
        claimedLines.add(lineIndex);
        const centavos = amountOnLine(line, true);
        if (centavos !== null) totalHits.push({ keywordRank: totalRank, lineIndex, centavos });
      }
    }
  });

  const subtotalHit = bestHit(subtotalHits);
  const taxHit = vatApplies ? bestHit(taxHits) : null;
  let totalCentavos = bestHit(totalHits);

  // Tier 2 last resort (doc 36 Stage 7): the largest amount near the foot of
  // the receipt. Only reached when no total keyword survived at all, which is
  // the faded-thermal case.
  if (totalCentavos === null) {
    const footStart = Math.floor(lines.length / 2);
    const candidates = lines
      .flatMap((line, lineIndex) =>
        lineIndex >= footStart && !claimedLines.has(lineIndex) ? findMoneyTokens(line) : [],
      )
      .filter((token) => token.explicit || allowBareIntegers)
      .map((token) => token.centavos);
    if (candidates.length > 0) totalCentavos = Math.max(...candidates);
  }

  // VAT-inclusive arithmetic is meaningless without both a total to anchor it
  // and a tax figure to test, so those two decide whether the check runs at
  // all. A non-VAT template already zeroed `taxHit`, which skips it.
  const vat = checkVatSanity({
    subtotalCentavos: subtotalHit,
    taxCentavos: taxHit,
    totalCentavos: vatApplies ? totalCentavos : null,
  });

  return {
    subtotalCentavos: vat.subtotalCentavos,
    taxCentavos: vat.taxCentavos,
    totalCentavos,
    vatConsistent: vat.consistent,
    vatChecked: vat.checked,
  };
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/** Lines that are never products: totals, tax, tender, and slip metadata.
 * Line items are analytics enrichment (doc 40) and never gate approval, so
 * being strict here costs nothing and a false positive pollutes reporting. */
const LINE_ITEM_EXCLUSIONS = [
  "TOTAL",
  "TTL",
  "AMOUNT DUE",
  "SUBTOTAL",
  "SUB TOTAL",
  "VAT",
  "TAX",
  "ZERO RATED",
  "CASH",
  "CHANGE",
  "TENDER",
  "CARD",
  "DEBIT",
  "CREDIT",
  "GCASH",
  "MAYA",
  "BALANCE",
  "POINTS",
  "DISCOUNT",
  "SENIOR",
  "PWD",
  "TIN",
  "MIN ",
  "SN ",
  "TEL",
  "PHONE",
  "BRANCH",
  "OFFICIAL RECEIPT",
  "SERVES AS",
  "THANK YOU",
  "SALAMAT",
];

/** A leading quantity column, with or without an "x"/"@" multiplier mark. */
const LEADING_QTY_PATTERN = /^\s*(\d{1,3})\s*(?:[xX@]\s*)?(?=\D)/;

function isExcludedLineItem(line: string): boolean {
  const normalized = normalizeForMatch(line);
  if (countLetters(normalized) < 2) return true;
  if (DATE_LIKE_PATTERN.test(normalized)) return true;
  return LINE_ITEM_EXCLUSIONS.some((keyword) => normalized.includes(keyword));
}

/** Unit price only when the arithmetic is exact. A line total of 100.00 over
 * a quantity of 3 has no integer-centavo unit price, and inventing 33.33 (or
 * worse, 33.333...) would put a fabricated number in front of the business. */
function exactUnitPrice(lineTotal: number | null, qty: number | null): number | null {
  if (lineTotal === null || qty === null || qty <= 0) return null;
  return lineTotal % qty === 0 ? lineTotal / qty : null;
}

interface RawLineItem {
  qty: number | null;
  unitPriceCentavos: number | null;
  lineTotalCentavos: number | null;
}

function matchTemplateLineItem(line: string, pattern: RegExp): RawLineItem | null {
  const match = safeExec(pattern, line);
  if (match === null) return null;
  const groups = match.groups ?? {};
  const amount = groups.amount;
  if (amount === undefined) return null;
  const lineTotalCentavos = parseCentavos(amount);
  if (lineTotalCentavos === null) return null;
  const qtyText = groups.qty;
  const qty = qtyText === undefined ? null : Number.parseInt(qtyText, 10);
  const safeQty = qty !== null && Number.isFinite(qty) ? qty : null;
  return {
    qty: safeQty,
    unitPriceCentavos: exactUnitPrice(lineTotalCentavos, safeQty),
    lineTotalCentavos,
  };
}

/** The generic columnar split (doc 36 Stage 7 tier 2): optional quantity, a
 * name, then one or two right-aligned money columns. Two columns mean unit
 * price then line total; one means the line total alone. */
function matchGenericLineItem(line: string, allowBareIntegers: boolean): RawLineItem | null {
  const qtyMatch = LEADING_QTY_PATTERN.exec(line);
  const qty = qtyMatch === null ? null : Number.parseInt(qtyMatch[1] ?? "", 10);
  // Scan for money AFTER the quantity column, so the quantity itself is never
  // mistaken for the unit price on a handwritten pad where both are bare
  // integers.
  const offset = qtyMatch === null ? 0 : qtyMatch[0].length;
  const remainder = line.slice(offset);

  const tokens = findMoneyTokens(remainder).filter(
    (token) => token.explicit || allowBareIntegers,
  );
  if (tokens.length === 0) return null;

  const nameText = remainder.slice(0, tokens[0]?.start ?? 0);
  if (countLetters(nameText) < 2) return null;

  const lineTotalCentavos = tokens[tokens.length - 1]?.centavos ?? null;
  const unitPriceCentavos =
    tokens.length >= 2
      ? (tokens[tokens.length - 2]?.centavos ?? null)
      : exactUnitPrice(lineTotalCentavos, qty);

  return {
    qty: qty !== null && Number.isFinite(qty) ? qty : null,
    unitPriceCentavos,
    lineTotalCentavos,
  };
}

/**
 * Product lines (doc 36 Stage 7). The template's `line_item_pattern` named
 * groups first, then the generic columnar split. Product linkage against the
 * business's catalogue happens downstream; this returns the raw shape only.
 */
export function extractLineItems(input: ParseInput): ParsedLineItem[] {
  const config = input.config;
  const lines = linesFor(input, config?.layout_anchors?.line_items);
  const allowBareIntegers = config?.handwriting?.digits_only_amounts === true;
  const templatePattern = safeCompile(config?.line_item_pattern, "");

  const items: ParsedLineItem[] = [];
  for (const line of lines) {
    if (isExcludedLineItem(line)) continue;
    const raw =
      (templatePattern === null ? null : matchTemplateLineItem(line, templatePattern)) ??
      matchGenericLineItem(line, allowBareIntegers);
    if (raw === null) continue;
    items.push({
      rawText: line,
      qty: raw.qty,
      unitPriceCentavos: raw.unitPriceCentavos,
      lineTotalCentavos: raw.lineTotalCentavos,
      sort: items.length,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Every field doc 36 Stage 7 extracts, in one pass, as the candidate the
 * validation (Stage 8), fraud (doc 37) and confidence (Stage 9) stages consume.
 *
 * `notes` carries the review-payload hints the doc asks for: the caller turns
 * them into reviewer-visible context. They are advisory, never a verdict -
 * routing lives in ./confidence.ts with thresholds injected from `settings`.
 */
export function parseReceipt(input: ParseInput): ParsedReceipt {
  const merchantName = extractMerchantName(input);
  const receiptNumber = extractReceiptNumber(input);
  const dateHit = extractDate(input);
  const amounts = extractAmountsDetailed(input);
  const lineItems = extractLineItems(input);

  const bounds = input.config?.amount_sanity;
  let withinAmountSanity: boolean | null = null;
  if (bounds !== undefined && amounts.totalCentavos !== null) {
    const min = bounds.min_total_centavos ?? Number.NEGATIVE_INFINITY;
    const max = bounds.max_total_centavos ?? Number.POSITIVE_INFINITY;
    withinAmountSanity = amounts.totalCentavos >= min && amounts.totalCentavos <= max;
  }

  // Only a check that ran AND failed is worth a note. A non-VAT template and
  // a receipt with no VAT block at all both leave `vatConsistent` false
  // without anything having gone wrong.
  const notes: ParseNote[] = [];
  if (dateHit?.ambiguous === true) notes.push("date_ambiguous");
  if (amounts.vatChecked && !amounts.vatConsistent) notes.push("vat_inconsistent");
  if (withinAmountSanity === false) notes.push("amount_out_of_range");

  return {
    merchantName,
    receiptNumber,
    receiptDate: dateHit?.date ?? null,
    dateAmbiguous: dateHit?.ambiguous ?? false,
    timeExtracted: dateHit?.timeExtracted ?? false,
    subtotalCentavos: amounts.subtotalCentavos,
    taxCentavos: amounts.taxCentavos,
    totalCentavos: amounts.totalCentavos,
    vatConsistent: amounts.vatConsistent,
    lineItems,
    withinAmountSanity,
    notes,
  };
}
