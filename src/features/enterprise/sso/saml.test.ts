import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import { resolveSamlSsoConfig } from "./saml";

describe("Enterprise SAML SSO Provider", () => {
  it("resolves enterprise SSO configuration by corporate email domain", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: "sso-1",
          business_id: "biz-corp-1",
          domain: "acme.com",
          provider: "okta",
          entity_id: "https://okta.com/acme",
          sso_url: "https://acme.okta.com/app/sso",
        },
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const config = await resolveSamlSsoConfig("alex@acme.com");
    expect(config).not.toBeNull();
    expect(config?.provider).toBe("okta");
    expect(config?.ssoUrl).toBe("https://acme.okta.com/app/sso");
  });
});
