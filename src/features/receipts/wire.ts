import type {
  ReceiptDetailDTO,
  ReceiptLineItemDTO,
  ReceiptListItemDTO,
  ReceiptRejectReason,
  ReceiptStatus,
} from "./types";

// The HTTP shape of a receipt, shared by the route handlers that produce it
// and the client components that consume it as the Realtime poll fallback.
//
// snake_case keys per doc 13 ("Timestamps ISO-8601 UTC ... money as integer
// centavos ... snake_case JSON keys"); internal DTOs stay camelCase and this
// module is the single seam between the two. Keeping the mappers here rather
// than inline in each route is what makes it impossible for the list and the
// detail endpoint to drift into two slightly different receipt shapes.
//
// Pure and IO-free on purpose: it is imported by a "use client" component, so
// it must never pull in server-only code.

export interface ReceiptLineItemWire {
  id: string;
  raw_text: string;
  qty: number | null;
  unit_price_centavos: number | null;
  line_total_centavos: number | null;
  sort: number;
}

export interface ReceiptWire {
  receipt_id: string;
  business_id: string | null;
  business_name: string | null;
  status: ReceiptStatus;
  /** Null unless status is 'rejected'. Never accompanied by reject_note, which is not client-readable. */
  reject_reason: ReceiptRejectReason | null;
  merchant_name: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  total_centavos: number | null;
  created_at: string;
  processed_at: string | null;
  /** Null when no `earn` ledger row references this receipt yet. Null is not zero. */
  points_awarded: number | null;
  /**
   * When the submitter asked the merchant to look at this rejected receipt
   * again, or null on every receipt the pipeline routed itself (0036).
   *
   * IT HAS TO BE ON THE WIRE, and the reason is a bug rather than a nicety.
   * This shape is the status screen's poll fallback: `fromReceiptWire` rebuilds
   * the whole DTO from it, so a field missing here comes back as null on every
   * poll. The escalation is once per receipt forever, so a null would put the
   * "ask the store to look at this" button back on a receipt that has already
   * been sent, and the customer would tap it and be refused by the server.
   * 0017's column grant is satisfied: 0036 grants exactly this column.
   */
  escalated_at: string | null;
}

export interface ReceiptDetailWire extends ReceiptWire {
  line_items: ReceiptLineItemWire[];
}

export function toReceiptWire(receipt: ReceiptListItemDTO): ReceiptWire {
  return {
    receipt_id: receipt.receiptId,
    business_id: receipt.businessId,
    business_name: receipt.businessName,
    status: receipt.status,
    reject_reason: receipt.rejectReason,
    merchant_name: receipt.merchantName,
    receipt_number: receipt.receiptNumber,
    receipt_date: receipt.receiptDate,
    total_centavos: receipt.totalCentavos,
    created_at: receipt.createdAt,
    processed_at: receipt.processedAt,
    points_awarded: receipt.pointsAwarded,
    escalated_at: receipt.escalatedAt,
  };
}

export function toReceiptLineItemWire(item: ReceiptLineItemDTO): ReceiptLineItemWire {
  return {
    id: item.id,
    raw_text: item.rawText,
    qty: item.qty,
    unit_price_centavos: item.unitPriceCentavos,
    line_total_centavos: item.lineTotalCentavos,
    sort: item.sort,
  };
}

export function toReceiptDetailWire(receipt: ReceiptDetailDTO): ReceiptDetailWire {
  return {
    ...toReceiptWire(receipt),
    line_items: receipt.lineItems.map(toReceiptLineItemWire),
  };
}

/** Reverse mapper, for the client's poll fallback reading its own endpoint back. */
export function fromReceiptWire(wire: ReceiptWire): ReceiptListItemDTO {
  return {
    receiptId: wire.receipt_id,
    businessId: wire.business_id,
    businessName: wire.business_name,
    status: wire.status,
    rejectReason: wire.reject_reason,
    merchantName: wire.merchant_name,
    receiptNumber: wire.receipt_number,
    receiptDate: wire.receipt_date,
    totalCentavos: wire.total_centavos,
    createdAt: wire.created_at,
    processedAt: wire.processed_at,
    pointsAwarded: wire.points_awarded,
    // Defaulted rather than assumed present: a poll answered by a deploy that
    // predates 0036 omits the key, and reading that as "not escalated" would
    // restore the button on a receipt already with the merchant. Undefined
    // means "not sent", exactly as it does for the Realtime payload.
    escalatedAt: wire.escalated_at ?? null,
  };
}
