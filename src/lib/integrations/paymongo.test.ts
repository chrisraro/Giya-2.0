import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createCheckoutSession } from "./paymongo";

describe("PayMongo Integration Client", () => {
  it("generates checkout session payload for subscription tier", async () => {
    const session = await createCheckoutSession({
      businessId: "biz-1",
      plan: "growth",
      amountCentavos: 299900,
      successUrl: "https://giya.app/business/settings?billing=success",
      cancelUrl: "https://giya.app/business/settings?billing=cancel",
    });

    expect(session.checkoutUrl).toBeDefined();
    expect(session.checkoutUrl).toContain("paymongo.com");
  });
});
