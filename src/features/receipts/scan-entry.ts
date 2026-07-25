// Entry-point plumbing for /scan: the two decisions the server component makes
// before handing off to the client capture flow. Both are pure so they are
// tested without rendering a page.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pre-bound business from `/scan?business={id}` (doc 33's business-page
 * Scan CTA; `business_id` is accepted as an alias because that is the field
 * name the submit API uses and links get written both ways).
 *
 * Anything that is not a UUID becomes undefined rather than being forwarded.
 * A junk value would travel all the way to `POST /api/v1/receipts`, fail Zod
 * validation there, and turn a mistyped link into a failed scan after the
 * consumer had already taken the photo. Dropping it early degrades to a generic
 * scan, which the matching stage (doc 36 Stage 5) resolves anyway.
 */
export function parseBusinessIdParam(
  value: string | string[] | undefined,
): string | undefined {
  // Repeated params arrive as an array; the first wins, as everywhere else.
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;
  return UUID_PATTERN.test(candidate.trim()) ? candidate.trim().toLowerCase() : undefined;
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
