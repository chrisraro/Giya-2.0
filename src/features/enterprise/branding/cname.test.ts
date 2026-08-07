import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import { resolveBusinessFromCname } from "./cname";

describe("White-Label CNAME Domain Resolver", () => {
  it("resolves business context by custom enterprise CNAME domain", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: "biz-1",
          slug: "star-coffee",
          name: "Star Coffee Corporate",
        },
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const business = await resolveBusinessFromCname("rewards.starcoffee.ph");
    expect(business).not.toBeNull();
    expect(business?.slug).toBe("star-coffee");
  });
});
