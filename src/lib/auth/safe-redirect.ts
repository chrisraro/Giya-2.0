// Validates a client- or query-string-supplied redirect target before it is
// handed to router.push()/NextResponse.redirect(). Only same-origin,
// path-absolute targets are allowed: a single leading "/" and never a
// leading "//" (which browsers and some routers treat as a
// protocol-relative URL, i.e. an off-site redirect like "//evil.com").
// Anything else falls back to a known-safe internal default.
export function getSafeRedirect(
  next: string | null | undefined,
  fallback: string,
): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//")) return fallback;
  return next;
}
