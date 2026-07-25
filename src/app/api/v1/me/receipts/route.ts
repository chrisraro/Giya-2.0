import { listMyReceiptsQuerySchema, type ListMyReceiptsQuery } from "@/features/receipts/schemas";
import { listMyReceipts } from "@/features/receipts/server/repo";
import { toReceiptWire } from "@/features/receipts/wire";
import { buildPage, decodeCursor } from "@/lib/api/cursor";
import { defineHandler } from "@/lib/api/handler";

// GET /api/v1/me/receipts
//
// Doc 36's API surface table: "consumer | Own history, cursor, ?status=
// filter". Also doc 33's `/receipts` list and, for the wallet island, the
// poll fallback when Realtime is unavailable.
//
// Cursor pagination is doc 13's, not an invention: an opaque base64 of
// (sort_key, id) over the default `created_at desc, id desc` sort, resolved
// as a keyset predicate in the repository. No offset appears anywhere.
//
// Column safety: the repository names every column it selects, because 0017
// revoked the table-level SELECT on `receipts` and re-granted 13 columns. The
// response is mapped field by field through `toReceiptWire`, so a column
// added to the table in a future migration cannot leak into this body by
// accident.

/** Doc 13 rate limit baseline: "General authenticated API | 120/min per user". */
const LIST_RATE_LIMIT = 120;
const LIST_RATE_LIMIT_WINDOW_SECONDS = 60;

export const GET = defineHandler({
  route: "me.receipts.list",
  requireSession: true,
  querySchema: listMyReceiptsQuerySchema,
  rateLimit: { limit: LIST_RATE_LIMIT, windowSeconds: LIST_RATE_LIMIT_WINDOW_SECONDS },
  handler: async ({ user, query }) => {
    const { limit, cursor, status } = query as ListMyReceiptsQuery;

    const { rows } = await listMyReceipts({
      userId: user.id,
      limit,
      cursor: decodeCursor(cursor),
      status,
    });

    const { items, page } = buildPage(rows, limit, (receipt) => ({
      sortKey: receipt.createdAt,
      id: receipt.receiptId,
    }));

    return {
      data: items.map(toReceiptWire),
      meta: { page },
      // Doc 13: "Authenticated GET: private, no-store by default". This one
      // is also a polling endpoint, so a cached response would defeat the
      // entire Realtime fallback it exists to serve.
      headers: { "Cache-Control": "private, no-store" },
    };
  },
});
