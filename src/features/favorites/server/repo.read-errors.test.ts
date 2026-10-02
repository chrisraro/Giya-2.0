import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { isFavorite } from "./repo";

function client(result: { data: unknown; error: unknown }) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
}

describe("isFavorite read failure", () => {
  it("throws rather than reporting 'not favourited' when the read errors", async () => {
    vi.mocked(createClient).mockResolvedValue(
      client({ data: null, error: { message: "connection reset" } }) as never,
    );

    await expect(isFavorite("biz-1")).rejects.toThrow("isFavorite");
  });

  it("returns false for a genuine no-row", async () => {
    vi.mocked(createClient).mockResolvedValue(client({ data: null, error: null }) as never);

    await expect(isFavorite("biz-1")).resolves.toBe(false);
  });
});
