import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("QR Resolver Route /q/[code]", () => {
  it("redirects to business page for valid QR code", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          code: "QR123",
          business_id: "biz-1",
          target_type: "business_page",
          businesses: { slug: "tea-house" },
        },
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const req = new Request("http://localhost/q/QR123");
    const res = await GET(req, { params: Promise.resolve({ code: "QR123" }) });

    expect(res.status).toBe(307); // Next.js redirect status
    expect(res.headers.get("location")).toBe("http://localhost/b/tea-house");
  });
});
