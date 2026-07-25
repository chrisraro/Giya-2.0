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

/** The two components of a keyset cursor, in sort order. */
export interface CursorParts {
  /** The endpoint's primary sort column, serialised as a string (an ISO-8601 timestamp for the default `created_at desc` sort). */
  sortKey: string;
  /** The tiebreaker: the row id. Makes the cursor total even when two rows share a sort key. */
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

/**
 * Decode a cursor a client supplied. Returns null for anything malformed
 * rather than throwing, because a stale or hand-edited cursor is a client
 * mistake and not a server fault: callers treat null as "start from head",
 * which is exactly doc 13's "clients restart from head" behaviour and avoids
 * turning an old bookmark into a 422.
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
  if (!sortKey || !id) return null;

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
