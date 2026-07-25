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
