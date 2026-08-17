import { describe, expect, it, vi } from "vitest";
import { addFavorite, isFavorite, listMyFavorites, removeFavorite } from "./repo";

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

// `as unknown as`, not `as any`: the three cases above predate this repo's
// no-explicit-any rule and are grandfathered, and adding new lint errors is not
// something this task is allowed to do.
const createClientMock = createClient as unknown as {
  mockResolvedValue: (value: unknown) => void;
};

function favoritesSelect(result: { data: unknown; error: unknown }) {
  const queryBuilder: Record<string, unknown> = { eq: vi.fn() };
  (queryBuilder.eq as ReturnType<typeof vi.fn>).mockReturnValue(queryBuilder);
  queryBuilder.then = (resolve: (value: unknown) => unknown) => resolve(result);

  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(queryBuilder) }),
  };
}

// EMPTY IS NOT THE SAME ANSWER AS FAILED.
//
// `listMyFavorites` used to end `if (error || !data) return []`, and [] does not
// render as "something went wrong" anywhere it is read: /favorites turns it into
// "No favorites saved yet. Tap the heart icon on any business page to add it to
// your favorites", and /home drops the rail. A consumer whose read had just
// failed was told, in copy, that the shops they had saved were never saved.
//
// `src/features/rewards/server/repo.ts` and `src/features/loyalty/server/repo.ts`
// (T4.5) both settled this the same way: throw, and let the caller degrade
// deliberately. This is that convention, not a third one.
describe("listMyFavorites", () => {
  it("CRITICAL: throws on a query error rather than reporting an empty shelf", async () => {
    createClientMock.mockResolvedValue(
      favoritesSelect({ data: null, error: { message: "permission denied for table favorites" } }),
    );

    await expect(listMyFavorites()).rejects.toThrow(/permission denied for table favorites/);
  });

  it("names itself in the thrown message, so the failing read is identifiable in a log", async () => {
    createClientMock.mockResolvedValue(
      favoritesSelect({ data: null, error: { message: "boom" } }),
    );

    await expect(listMyFavorites()).rejects.toThrow(/listMyFavorites/);
  });

  it("still returns [] when the consumer genuinely has no favourites", async () => {
    createClientMock.mockResolvedValue(favoritesSelect({ data: [], error: null }));

    await expect(listMyFavorites()).resolves.toEqual([]);
  });

  it("returns [] for a signed-out caller without touching the table", async () => {
    const supabase = favoritesSelect({ data: [], error: null });
    supabase.auth.getUser = vi.fn().mockResolvedValue({ data: { user: null } });
    createClientMock.mockResolvedValue(supabase);

    await expect(listMyFavorites()).resolves.toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
