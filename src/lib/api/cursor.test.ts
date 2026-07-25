import { describe, expect, it } from "vitest";

import {
  buildPage,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "./cursor";

// Doc 13's pagination contract: "Cursor is an opaque base64 of (sort_key,
// id) ... Never offset pagination". These tests pin the round trip, the
// tolerance for a stale cursor, and the over-fetch-by-one page builder every
// paginated endpoint depends on.

const SORT_KEY = "2026-07-25T03:15:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a (sort_key, id) pair", () => {
    expect(decodeCursor(encodeCursor({ sortKey: SORT_KEY, id: ID }))).toEqual({
      sortKey: SORT_KEY,
      id: ID,
    });
  });

  it("produces an opaque token that does not expose the sort key in plain text", () => {
    const cursor = encodeCursor({ sortKey: SORT_KEY, id: ID });
    expect(cursor).not.toContain(SORT_KEY);
    expect(cursor).not.toContain(ID);
  });

  it("is stable: the same position always encodes to the same string", () => {
    expect(encodeCursor({ sortKey: SORT_KEY, id: ID })).toBe(
      encodeCursor({ sortKey: SORT_KEY, id: ID }),
    );
  });

  it("round-trips non-ASCII sort keys without corruption", () => {
    const parts = { sortKey: "café ñ 東京", id: ID };
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts);
  });

  it("returns null for undefined and empty input (start from head)", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null rather than throwing for a hand-edited cursor", () => {
    // Doc 13: a cursor whose sort schema changed simply restarts from head.
    // A stale bookmark must never become a 422 the consumer has to decode.
    expect(decodeCursor("not-base64-!!!")).toBeNull();
    expect(decodeCursor(btoa("no separator here"))).toBeNull();
    expect(decodeCursor(btoa("\nid-with-no-sort-key"))).toBeNull();
    expect(decodeCursor(btoa("sort-key-with-no-id\n"))).toBeNull();
  });
});

describe("page limits", () => {
  it("matches doc 13's clamp and default", () => {
    expect(MIN_PAGE_LIMIT).toBe(1);
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(DEFAULT_PAGE_LIMIT).toBe(25);
  });
});

interface Row {
  id: string;
  createdAt: string;
}

const toCursor = (row: Row) => ({ sortKey: row.createdAt, id: row.id });

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `id-${index}`,
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
}

describe("buildPage", () => {
  it("reports has_more and trims the over-fetched row when limit + 1 rows come back", () => {
    const { items, page } = buildPage(rows(4), 3, toCursor);

    expect(items).toHaveLength(3);
    expect(items.map((row) => row.id)).toEqual(["id-0", "id-1", "id-2"]);
    expect(page.has_more).toBe(true);
    expect(page.limit).toBe(3);
  });

  it("emits a next_cursor pointing at the LAST returned row, not the over-fetched one", () => {
    const { page } = buildPage(rows(4), 3, toCursor);

    expect(decodeCursor(page.next_cursor)).toEqual({
      sortKey: "2026-07-03T00:00:00.000Z",
      id: "id-2",
    });
  });

  it("emits no next_cursor on the last page", () => {
    const { items, page } = buildPage(rows(3), 3, toCursor);

    expect(items).toHaveLength(3);
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it("handles an empty result set", () => {
    const { items, page } = buildPage([], 25, toCursor);

    expect(items).toEqual([]);
    expect(page).toEqual({ next_cursor: null, has_more: false, limit: 25 });
  });

  it("does not mutate the caller's array", () => {
    const source = rows(4);
    buildPage(source, 3, toCursor);
    expect(source).toHaveLength(4);
  });
});
