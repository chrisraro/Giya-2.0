// Entry-point plumbing for /scan: the decisions the server component makes
// before handing off to the client capture flow. All pure, so they are tested
// without rendering a page.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pre-bound business from `/scan?business={id}` (doc 33's business-page
 * Scan CTA; `business_id` is accepted as an alias because that is the field
 * name the submit API uses and links get written both ways).
 *
 * Anything that is not a UUID becomes undefined rather than being forwarded. A
 * junk value would travel all the way to `POST /api/v1/receipts` and fail Zod
 * validation there, after the consumer had already taken the photo.
 *
 * Undefined does NOT mean "generic scan". Generic scan is `[V1]` in doc 33's
 * route table and is not implemented: `buildMatchCandidates` in
 * `server/process.ts` only ever supplies the pre-bound business, so a receipt
 * with no `business_id` scores against zero candidates and is rejected as
 * `wrong_business` every time. Worse, `receipts_sha_unique` (0017) is a total
 * index that includes rejected rows, so re-submitting the same photo from the
 * right store page returns 422 RECEIPT_DUPLICATE and the receipt is burned.
 * Undefined therefore means "send the consumer to the store chooser", which is
 * what `/scan` renders, and never "photograph it anyway".
 */
export function parseBusinessIdParam(
  value: string | string[] | undefined,
): string | undefined {
  // Repeated params arrive as an array; the first wins, as everywhere else.
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;
  return UUID_PATTERN.test(candidate.trim()) ? candidate.trim().toLowerCase() : undefined;
}

/** Longer than any real shop name; anything past this is noise or an attack. */
export const MAX_STORE_QUERY_LENGTH = 60;

/**
 * Rows the `/scan` store chooser lists before it stops listing and insists on
 * search. Lives here rather than in the server module so the chooser component
 * can state the number in its copy without importing `server-only`.
 */
export const SCAN_CHOOSER_LIMIT = 50;

/**
 * Above this many shops the list stops being scannable by eye and the search
 * field appears. Below it, a search box over six rows is clutter.
 */
export const SCAN_SEARCH_THRESHOLD = 8;

// Letters, digits, spaces and the punctuation Philippine shop names actually
// use. Everything else is dropped rather than escaped, which keeps one rule
// instead of two: `%` and `_` (ilike wildcards) and `,` `(` `)` `.` (PostgREST
// filter punctuation) all fall outside the allowlist, so a search term can
// never reshape the query it lands in.
const STORE_QUERY_DISALLOWED = /[^\p{L}\p{N} '&-]+/gu;

/**
 * The `?q=` store search on the `/scan` chooser, normalised to something safe
 * to hand to a PostgREST `ilike`. Returns undefined when nothing usable is
 * left, which the chooser reads as "no search is active".
 */
export function parseStoreQueryParam(
  value: string | string[] | undefined,
): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;

  const cleaned = candidate
    .slice(0, MAX_STORE_QUERY_LENGTH)
    .replace(STORE_QUERY_DISALLOWED, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length === 0 ? undefined : cleaned;
}

export interface OcrStubNoteEnvironment {
  readonly nodeEnv: string | undefined;
  readonly ocrServiceUrl: string | undefined;
}

/**
 * Whether /scan shows the dev-only "OCR stub active" note (spec section 2).
 *
 * Two conditions, and the production one is checked FIRST and independently of
 * the other: the note must never render in production even if OCR_SERVICE_URL
 * is somehow unset there. A consumer seeing internal pipeline state is a
 * defect; a developer mistaking fabricated stub totals for real OCR output is a
 * worse one, which is why the note exists at all.
 */
export function shouldShowOcrStubNote(environment: OcrStubNoteEnvironment): boolean {
  if (environment.nodeEnv === "production") return false;
  const url = environment.ocrServiceUrl;
  return url === undefined || url.trim().length === 0;
}
