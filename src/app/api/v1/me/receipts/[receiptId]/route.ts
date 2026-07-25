import { receiptDetailParamsSchema, type ReceiptDetailParams } from "@/features/receipts/schemas";
import { getMyReceipt } from "@/features/receipts/server/repo";
import { toReceiptDetailWire } from "@/features/receipts/wire";
import { notFound } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";

// GET /api/v1/me/receipts/{id}
//
// Doc 36's API surface table: "consumer | Detail + receipt_line_items". Also
// the 5s poll fallback the /scan/[receiptId] status screen and the wallet
// island call when Realtime is unavailable.
//
// TWO SECURITY PROPERTIES, both deliberate and both regression-tested:
//
//   1. ANOTHER USER'S RECEIPT 404s, IT DOES NOT 403. Doc 13: "404 NOT_FOUND -
//      Resource absent **or** outside caller's tenant (never distinguish)".
//      A 403 would confirm that the id names a real receipt, turning this
//      endpoint into an id oracle for anyone who can guess or harvest one.
//      This is the same call the reward-claim token route made, for the same
//      reason. `getMyReceipt` collapses both cases to null and this handler
//      answers one message for both.
//
//      The check is NOT redundant with RLS. `receipts` RLS is a UNION of
//      receipts_consumer_select (own rows) and receipts_staff_select (active
//      owner/manager of the matched business), so a shop owner reading a
//      customer's receipt id would pass RLS. The repository constrains
//      user_id itself.
//
//   2. NO FRAUD INTERNALS, EVER. The body is built field by field from
//      ReceiptDetailDTO, whose shape stops at the 13 columns 0017 grants to
//      `authenticated`. reject_note, parse_meta, match_confidence,
//      parse_confidence, sha256, image_hash and the entire `fraud_signals`
//      table are unreachable from here: not filtered out, but never fetched
//      and not representable in the response type.

/** Doc 13 rate limit baseline: "General authenticated API | 120/min per user". */
const DETAIL_RATE_LIMIT = 120;
const DETAIL_RATE_LIMIT_WINDOW_SECONDS = 60;

export const GET = defineHandler({
  route: "me.receipts.detail",
  requireSession: true,
  paramsSchema: receiptDetailParamsSchema,
  rateLimit: { limit: DETAIL_RATE_LIMIT, windowSeconds: DETAIL_RATE_LIMIT_WINDOW_SECONDS },
  handler: async ({ user, params }) => {
    const { receiptId } = params as ReceiptDetailParams;

    const receipt = await getMyReceipt(receiptId, user.id);
    if (!receipt) {
      throw notFound("This receipt was not found.");
    }

    return {
      data: toReceiptDetailWire(receipt),
      headers: { "Cache-Control": "private, no-store" },
    };
  },
});
