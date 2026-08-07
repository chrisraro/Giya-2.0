export interface PosItemDTO {
  name: string;
  qty: number;
  priceCentavos: number;
}

export interface PosReceiptPayloadDTO {
  storeId: string;
  transactionId: string;
  timestamp: string;
  totalCentavos: number;
  items: PosItemDTO[];
}

export function parsePosPayload(raw: any): PosReceiptPayloadDTO {
  const storeId = String(raw?.store_id ?? raw?.storeId ?? "default_store");
  const transactionId = String(raw?.transaction_id ?? raw?.transactionId ?? `tx_${Date.now()}`);
  const timestamp = String(raw?.timestamp ?? new Date().toISOString());
  const totalCentavos = Number(raw?.grand_total_cents ?? raw?.totalCentavos ?? 0);

  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const items: PosItemDTO[] = rawItems.map((item: any) => ({
    name: String(item?.name ?? item?.title ?? "Item"),
    qty: Number(item?.qty ?? item?.quantity ?? 1),
    priceCentavos: Number(item?.price_cents ?? item?.priceCentavos ?? 0),
  }));

  return {
    storeId,
    transactionId,
    timestamp,
    totalCentavos,
    items,
  };
}
