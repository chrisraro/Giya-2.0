// Normalizes how long an enumeration-sensitive async action appears to take
// from the caller's perspective. A password-recovery endpoint can
// legitimately take a different amount of time to answer for a known email
// (look up the user, mint a token, hand off to the mail provider) than for
// an unknown one (short-circuit after the lookup finds nothing) - a timing
// side channel that leaks account existence even when the response body is
// made identical for both cases. This wraps the call so it always settles
// no sooner than `minMs` after it started, whether it resolves or rejects,
// so a caller timing the round trip cannot use elapsed time to distinguish
// the two cases.
export async function withMinDelay<T>(operation: () => Promise<T>, minMs: number): Promise<T> {
  const start = Date.now();
  try {
    return await operation();
  } finally {
    const elapsed = Date.now() - start;
    const remaining = minMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
}
