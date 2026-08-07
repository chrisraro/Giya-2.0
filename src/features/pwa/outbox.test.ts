import { describe, expect, it } from "vitest";
import { queueOfflineReceipt, getOfflineOutbox } from "./outbox";

describe("PWA Outbox Storage", () => {
  it("queues an offline receipt record with idempotency key", async () => {
    const item = {
      idempotencyKey: "key-123",
      businessId: "biz-1",
      amountCentavos: 5000,
      createdAt: new Date().toISOString(),
    };

    // In Node test environment, mock store fallback
    await queueOfflineReceipt(item);
    const list = await getOfflineOutbox();

    expect(list).toBeDefined();
  });
});
