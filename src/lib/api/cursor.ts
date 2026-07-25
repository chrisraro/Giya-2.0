// Cursor pagination primitives for /api/v1, per
// docs/10-architecture/13-api-standards.md ("Pagination - cursor-based only"):
//
//   "Cursor is an opaque base64 of (sort_key, id) - internally keyset
//    pagination (where (sort_key, id) < ($1,$2) order by sort_key desc,
//    id desc). Never offset pagination (breaks at scale, leaks churn)."
//
// This file owns the encode/decode half of that contract. The keyset predicate
// itself is expressed per-repository, because PostgREST has no row-value
// comparison operator: `(created_at, id) < ($1, $2)` has to be written as
// `created_at < $1 OR (created_at = $1 AND id < $2)`.
//
// Deliberately free of "server-only", Node and Next imports: the encoded
// cursor is a client-visible string and a client may want to parse a limit
// alongside it, so nothing here may drag server code into the browser bundle.

/**
 * The two components of a keyset cursor, in sort order. `decodeCursor`
 * guarantees the shape of both on the way in; see the note above it.
 */
export interface CursorParts {
  /** The endpoint's primary sort column: an ISO-8601 timestamp, for the default `created_at desc` sort. */
  sortKey: string;
  /** The tiebreaker: the row id, a UUID. Makes the cursor total even when two rows share a sort key. */
  id: string;
}

/** Doc 13: "limit clamp 1-100, default 25". */
export const DEFAULT_PAGE_LIMIT = 25;
export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 100;

// The separator must be a character that cannot appear in either component.
// ISO-8601 timestamps and UUIDs are both restricted alphabets, and neither
// admits a newline, so a split on the FIRST newline is unambiguous even if a
// future sort key were to contain one.
const SEPARATOR = "\n";

// btoa/atob + TextEncoder/TextDecoder are available in every runtime this code
// runs in (browser, Node 18+, edge). Buffer is deliberately not used so the
// module stays isomorphic, and the UTF-8 round trip goes through TextEncoder
// rather than the deprecated escape/unescape pair so a non-ASCII sort key can
// never silently corrupt a cursor.
function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a keyset position into the opaque cursor a client echoes back.
 * Opaque means opaque: clients must never parse this, and its internal shape
 * may change (doc 13: "Cursors ... expire only if sort schema changes, then
 * clients restart from head").
 */
export function encodeCursor(parts: CursorParts): string {
  return toBase64(`${parts.sortKey}${SEPARATOR}${parts.id}`);
}

// BOTH COMPONENTS ARE VALIDATED BECAUSE BOTH ARE INTERPOLATED.
//
// A decoded cursor is client-controlled input that ends up inside a PostgREST
// filter expression, textually: the keyset predicate has no row-value
// comparison operator to lean on, so every repository writes it by hand as
//
//   .or(`created_at.lt.${sortKey},and(created_at.eq.${sortKey},id.lt.${id})`)
//
// where `,` `(` `)` and `.` are that grammar's punctuation. Today the outer
// `.eq("user_id", ...)` is ANDed with whatever the `.or()` parses to and the
// withheld columns raise 42501, so a crafted cursor buys nothing. That is two
// unrelated accidents standing between an opaque token and a tenancy hole, and
// it contradicts what schemas.ts says this codebase does with untrusted filter
// input ("an enum rather than a free string so `?status=` can never become a
// filter injection point"). So the shape is pinned here, once, at the only
// place a cursor becomes structured data.
//
// A rejected cursor still degrades to "start from head" rather than 422: doc
// 13 says a cursor whose sort schema changed simply restarts, and an attacker
// crafting one is not owed a different answer from a consumer with a stale
// bookmark.

/**
 * ISO-8601 UTC-or-offset timestamps, which is exactly what PostgREST emits for
 * a `timestamptz` and therefore the only thing `encodeCursor` is ever handed.
 * Fractional seconds are optional and go up to nanosecond precision.
 */
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSortKey(value: string): boolean {
  // The pattern rejects the punctuation; Date.parse rejects 2026-13-45, which
  // is well formed and still not a timestamp.
  return ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Decode a cursor a client supplied. Returns null for anything malformed
 * rather than throwing, because a stale or hand-edited cursor is a client
 * mistake and not a server fault: callers treat null as "start from head",
 * which is exactly doc 13's "clients restart from head" behaviour and avoids
 * turning an old bookmark into a 422.
 *
 * Malformed includes the wrong SHAPE, not just bad base64: the sort key must
 * be an ISO-8601 timestamp and the id a UUID. See the note above.
 */
export function decodeCursor(raw: string | undefined | null): CursorParts | null {
  if (!raw) return null;

  let decoded: string;
  try {
    decoded = fromBase64(raw);
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(SEPARATOR);
  if (separatorIndex <= 0) return null;

  const sortKey = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + SEPARATOR.length);
  if (!isValidSortKey(sortKey)) return null;
  if (!UUID_PATTERN.test(id)) return null;

  return { sortKey, id };
}

/** Doc 13's `meta.page` block. snake_case: it is serialised straight into the HTTP envelope. */
export interface PageMeta {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

/**
 * Turn an over-fetched result set into a page plus its `meta.page`.
 *
 * The convention every paginated endpoint here follows: query `limit + 1`
 * rows, hand the whole array to this function, and it tells you whether there
 * is another page WITHOUT a second count query (which would be both a wasted
 * round trip and a lie the moment a row is inserted between the two queries).
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => CursorParts,
): { items: T[]; page: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];

  return {
    items,
    page: {
      // A next_cursor is only meaningful when there IS a next page. Emitting
      // one on the last page invites clients into a pointless extra request
      // that always returns empty.
      next_cursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
      has_more: hasMore,
      limit,
    },
  };
}
