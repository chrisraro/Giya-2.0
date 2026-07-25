"use client";

import type { ReceiptListItemDTO, ReceiptStatus } from "../types";
import { fromReceiptWire, type ReceiptDetailWire, type ReceiptWire } from "../wire";

// Browser-side reads of this slice's own GET endpoints, used exclusively as
// the poll fallback when Realtime is unavailable (doc 36: "Fallback: poll
// GET /api/v1/me/receipts/{id} every 5s if the socket drops").
//
// Every function here returns null on ANY failure rather than throwing. That
// is deliberate for a fallback path: a poll tick that fails is a poll tick
// that will happen again in five seconds, and turning a transient blip into a
// visible error would replace a working screen with a broken one for no
// reason. Genuine terminal errors are not this layer's job to report.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** GET /api/v1/me/receipts/{id}. */
export async function fetchReceiptDetail(receiptId: string): Promise<ReceiptListItemDTO | null> {
  try {
    const response = await fetch(`/api/v1/me/receipts/${receiptId}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (!isObject(body) || !isObject(body.data)) return null;

    return fromReceiptWire(body.data as unknown as ReceiptDetailWire);
  } catch {
    return null;
  }
}

export interface FetchMyReceiptsArgs {
  limit?: number;
  status?: ReceiptStatus;
}

/** GET /api/v1/me/receipts. Only the first page: the fallback never paginates. */
export async function fetchMyReceipts(
  args: FetchMyReceiptsArgs = {},
): Promise<ReceiptListItemDTO[] | null> {
  const params = new URLSearchParams();
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  if (args.status) params.set("status", args.status);

  const query = params.toString();

  try {
    const response = await fetch(`/api/v1/me/receipts${query ? `?${query}` : ""}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (!isObject(body) || !Array.isArray(body.data)) return null;

    return (body.data as ReceiptWire[]).map(fromReceiptWire);
  } catch {
    return null;
  }
}
