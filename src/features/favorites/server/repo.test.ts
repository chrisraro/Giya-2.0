import { describe, expect, it, vi } from "vitest";
import { addFavorite, isFavorite, removeFavorite } from "./repo";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("Favorites Repo", () => {
  it("isFavorite checks if a business is favorited by the logged in user", async () => {
    const mockSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: "fav-1" }, error: null }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const res = await isFavorite("biz-1");
    expect(res).toBe(true);
  });

  it("addFavorite inserts a row", async () => {
    const mockSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnThis(),
      insert: vi.fn().mockResolvedValue({ error: null }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const res = await addFavorite("biz-1");
    expect(res.ok).toBe(true);
  });

  it("removeFavorite deletes a row", async () => {
    const queryBuilder = {
      eq: vi.fn(),
    };
    queryBuilder.eq.mockReturnValue(queryBuilder);
    (queryBuilder as any).then = (resolve: any) => resolve({ error: null });

    const mockSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue(queryBuilder),
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const res = await removeFavorite("biz-1");
    expect(res.ok).toBe(true);
  });
});
