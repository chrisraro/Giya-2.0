import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/meta", () => ({
  isMetaConfigured: vi.fn().mockReturnValue(true),
  publishFacebookPost: vi.fn().mockResolvedValue({ id: "post-123" }),
}));

vi.mock("@/lib/crypto/token-cipher", () => ({
  decryptToken: vi.fn().mockReturnValue("page-token-abc"),
}));

vi.mock("./repo", () => ({
  readConnectionSecret: vi.fn().mockResolvedValue({
    id: "conn-1",
    externalAccountId: "page-1",
    accessTokenEncrypted: Buffer.from("encrypted"),
    status: "connected",
  }),
}));

import { publishCampaignToMeta } from "./publishing";

describe("Meta Content Publishing", () => {
  it("publishes campaign announcement post to connected Facebook Page", async () => {
    const res = await publishCampaignToMeta({
      businessId: "biz-1",
      connectionId: "conn-1",
      message: "Check out our new Promo!",
      linkUrl: "https://giya.app/b/tea-house",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.postId).toBe("post-123");
    }
  });
});
