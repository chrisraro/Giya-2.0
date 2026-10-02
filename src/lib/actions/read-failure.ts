// Server actions return a typed `{ ok: false, message }`; they never crash.
// Several repo reads now THROW on a failed Supabase read instead of returning
// null/empty (a failed read is an error, not "not found"). That is right for
// pages, whose error.tsx shows a retry, but an action that used to answer with
// a typed result must keep doing so. This maps the throw to one generic,
// non-leaking message and logs the cause.

export const READ_FAILED_MESSAGE = "Something went wrong on our side. Please try again.";

export type ReadFailedResult = { ok: false; message: string };

export async function guardReadFailure<T>(
  label: string,
  work: () => Promise<T>,
): Promise<T | ReadFailedResult> {
  try {
    return await work();
  } catch (error: unknown) {
    // Only the label and the error object - never the action's input, which
    // may carry user-entered text.
    console.error(`[${label}] a database read failed during the action`, error);
    return { ok: false, message: READ_FAILED_MESSAGE };
  }
}
