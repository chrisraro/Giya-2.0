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

  it("encodes non-ASCII bytes as UTF-8 rather than corrupting them", () => {
    // The codec goes through TextEncoder, not the deprecated escape/unescape
    // pair, so a multi-byte sort key survives the base64 round trip intact.
    // decodeCursor still refuses it (see the shape tests below), but the
    // refusal must be the validation's decision and not silent mojibake.
    const encoded = encodeCursor({ sortKey: "café ñ 東京", id: ID });
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));

    expect(new TextDecoder().decode(bytes)).toBe(`café ñ 東京\n${ID}`);
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

// Both decoded components are interpolated verbatim into a PostgREST `.or()`
// filter by every keyset repository, so decodeCursor is the single place their
// shape is pinned. A crafted cursor gets the same answer as a stale one:
// null, meaning start from head. Never a 422, which would tell the crafter
// their payload was interesting.
describe("decodeCursor shape validation", () => {
  it("rejects a sort key that is not an ISO-8601 timestamp", () => {
    expect(decodeCursor(encodeCursor({ sortKey: "yesterday", id: ID }))).toBeNull();
    expect(decodeCursor(encodeCursor({ sortKey: "2026-07-25", id: ID }))).toBeNull();
    expect(decodeCursor(encodeCursor({ sortKey: "café ñ 東京", id: ID }))).toBeNull();
    // Well formed, not a date: only Date.parse catches this one.
    expect(decodeCursor(encodeCursor({ sortKey: "2026-13-45T99:99:99.000Z", id: ID }))).toBeNull();
  });

  it("accepts the timestamp shapes PostgREST actually emits for a timestamptz", () => {
    for (const sortKey of [
      "2026-07-25T03:15:00Z",
      "2026-07-25T03:15:00.000Z",
      "2026-07-25T03:15:00.123456Z",
      "2026-07-25T03:15:00.123456+00:00",
      "2026-07-25T11:15:00+08:00",
    ]) {
      expect(decodeCursor(encodeCursor({ sortKey, id: ID }))).toEqual({ sortKey, id: ID });
    }
  });

  it("rejects an id that is not a UUID", () => {
    expect(decodeCursor(encodeCursor({ sortKey: SORT_KEY, id: "receipt-2" }))).toBeNull();
    expect(decodeCursor(encodeCursor({ sortKey: SORT_KEY, id: "1" }))).toBeNull();
    expect(decodeCursor(encodeCursor({ sortKey: SORT_KEY, id: `${ID}x` }))).toBeNull();
  });

  it("CRITICAL: rejects a cursor crafted to inject a PostgREST filter expression", () => {
    // Each of these is what a keyset repository would splice into
    //   created_at.lt.${sortKey},and(created_at.eq.${sortKey},id.lt.${id})
    // if the components were taken on trust. `,` closes the current filter and
    // starts a sibling one; `(` opens a nested boolean group; `.` separates
    // column, operator and value. None of them survive validation, so none of
    // them ever reach the query builder.
    const injections: readonly { sortKey: string; id: string }[] = [
      { sortKey: "2099-01-01,status.eq.approved", id: ID },
      { sortKey: "2099-01-01T00:00:00.000Z,user_id.neq.null", id: ID },
      { sortKey: "2099-01-01T00:00:00.000Z),or(user_id.not.is.null", id: ID },
      { sortKey: SORT_KEY, id: `${ID},user_id.neq.00000000-0000-4000-8000-000000000000` },
      { sortKey: SORT_KEY, id: "*" },
      { sortKey: SORT_KEY, id: "0,sha256.not.is.null" },
    ];

    for (const parts of injections) {
      expect(decodeCursor(encodeCursor(parts))).toBeNull();
    }
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

// Real UUIDs, because a cursor round trip is part of what is asserted here and
// decodeCursor rejects an id that is not one.
const rowId = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: rowId(index),
    createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
}

describe("buildPage", () => {
  it("reports has_more and trims the over-fetched row when limit + 1 rows come back", () => {
    const { items, page } = buildPage(rows(4), 3, toCursor);

    expect(items).toHaveLength(3);
    expect(items.map((row) => row.id)).toEqual([rowId(0), rowId(1), rowId(2)]);
    expect(page.has_more).toBe(true);
    expect(page.limit).toBe(3);
  });

  it("emits a next_cursor pointing at the LAST returned row, not the over-fetched one", () => {
    const { page } = buildPage(rows(4), 3, toCursor);

    expect(decodeCursor(page.next_cursor)).toEqual({
      sortKey: "2026-07-03T00:00:00.000Z",
      id: rowId(2),
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
