// Validates a client- or query-string-supplied redirect target before it is
// handed to router.push()/NextResponse.redirect(). A startsWith("/") /
// startsWith("//") blocklist is not enough: browsers normalize backslashes
// to forward slashes for special schemes, so "/\evil.com" (or its encoded
// form "%2F%5Cevil.com") passes a naive check but still resolves to a
// different host during navigation. Instead, resolve `next` against a
// fixed, unresolvable base and compare the resulting origin: anything that
// changes the origin (protocol-relative, backslash tricks, absolute URLs,
// etc.) falls back to a known-safe internal default. Only the path,
// query, and hash of the resolved URL are returned, never anything that
// could carry a different host.
export function getSafeRedirect(
  next: string | null | undefined,
  fallback: string,
): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;

  const base = "http://internal.invalid";
  try {
    const resolved = new URL(next, base);
    if (resolved.origin !== base) return fallback;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return fallback;
  }
}
