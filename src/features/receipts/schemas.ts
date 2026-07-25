import { z } from "zod";

import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, MIN_PAGE_LIMIT } from "@/lib/api/cursor";

// Request schemas for the consumer receipt read surfaces (doc 36's API
// surface table, doc 13's validation rules). Kept in the feature's own
// schemas.ts like every other slice here, so the route handlers stay thin.

export const receiptIdSchema = z.string().uuid();

/**
 * Exactly the `receipts.status` check constraint from 0017_receipts.sql. An
 * enum rather than a free string so `?status=` can never become a filter
 * injection point, and so an unknown value is a clean 422 rather than a
 * silently empty page.
 */
export const receiptStatusSchema = z.enum([
  "queued",
  "processing",
  "review",
  "approved",
  "rejected",
]);

/**
 * `GET /api/v1/me/receipts?limit=&cursor=&status=`.
 *
 * Doc 13: "limit clamp 1-100, default 25", cursor opaque. The cursor is only
 * shape-checked here (non-empty string); decoding it is
 * `decodeCursor`'s job and a malformed one deliberately degrades to "start
 * from head" rather than 422, because a stale bookmark is not a client error
 * worth failing a request over.
 */
export const listMyReceiptsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(MIN_PAGE_LIMIT)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).optional(),
  status: receiptStatusSchema.optional(),
});

export type ListMyReceiptsQuery = z.infer<typeof listMyReceiptsQuerySchema>;

export const receiptDetailParamsSchema = z.object({
  receiptId: receiptIdSchema,
});

export type ReceiptDetailParams = z.infer<typeof receiptDetailParamsSchema>;

// ---------------------------------------------------------------------------
// Human review (doc 36 Stage 9 "Human review queue", doc 37 review queues)
// ---------------------------------------------------------------------------
//
// These live here rather than in server/review.ts so the decision FORM and the
// service validate against one shape: the form is a client component and
// server/review.ts is `server-only`, so a schema defined there could never be
// imported by the thing that produces the payload.

/**
 * Exactly the `receipts.reject_reason` check constraint from 0017_receipts.sql,
 * which doc 36 Stage 9 names as the reviewer's reason list ("reason from
 * `receipt_reject_reason` enum + `reject_note`").
 */
export const receiptRejectReasonSchema = z.enum([
  "duplicate",
  "unreadable",
  "wrong_business",
  "too_old",
  "fraud_suspected",
  "manual",
]);

/** int4, the domain of every `*_centavos` column on `receipts` (0017). */
const MAX_CENTAVOS = 2_147_483_647;

const centavosSchema = z.number().int().min(0).max(MAX_CENTAVOS);

/**
 * One corrected line item. `sort` is deliberately absent: it is the position in
 * this array, so a client cannot submit two items claiming the same slot.
 * `qty` matches `receipt_line_items.qty numeric(8,3)` (0017).
 */
export const reviewLineItemSchema = z.object({
  raw_text: z.string().trim().min(1).max(500),
  qty: z.number().min(0).max(99_999.999).nullable(),
  unit_price_centavos: centavosSchema.nullable(),
  line_total_centavos: centavosSchema.nullable(),
});

export type ReviewLineItem = z.infer<typeof reviewLineItemSchema>;

/**
 * The editable field form of doc 36 Stage 9's UI contract: "merchant, number,
 * date, subtotal/tax/total, line items, pre-filled with parsed values".
 *
 * EVERY scalar key is REQUIRED (nullable, but present). The form is pre-filled
 * with what the parser found, so it always has a value to send for each field,
 * and a partial patch would be ambiguous between "the reviewer left this alone"
 * and "the reviewer cleared it". `line_items` is the one optional key, because
 * "I did not touch the line items" and "the receipt has none" are genuinely
 * different: absent leaves the parsed rows as they are, `[]` clears them.
 *
 * `total_centavos` is the only non-nullable field. It is the number the points
 * engine prices, and doc 36 Stage 8's readability rule already refuses a
 * receipt without one; approving a totalless receipt would silently award zero.
 */
export const reviewFieldsSchema = z.object({
  merchant_name: z.string().trim().min(1).max(200).nullable(),
  receipt_number: z.string().trim().min(1).max(100).nullable(),
  receipt_date: z.coerce.date().nullable(),
  subtotal_centavos: centavosSchema.nullable(),
  tax_centavos: centavosSchema.nullable(),
  total_centavos: centavosSchema,
  line_items: z.array(reviewLineItemSchema).max(200).optional(),
});

export type ReviewFields = z.infer<typeof reviewFieldsSchema>;
