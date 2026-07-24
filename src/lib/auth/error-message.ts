const FALLBACK = "Something went wrong. Please try again.";

// Live E2E showed a login failure rendering as the literal string "{}"
// because a non-Error rejection (e.g. a plain object without a usable
// message) was passed straight to a text node. Every user-facing error in
// the auth flows should be routed through this helper first so the UI
// always renders a real sentence, never a stringified object or "undefined".
export function toErrorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err.length > 0 ? err : FALLBACK;
  }

  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : FALLBACK;
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return FALLBACK;
}
