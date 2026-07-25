import type { z } from "zod";

// Error vocabulary for /api/v1, per docs/10-architecture/13-api-standards.md.
// Codes are stable, SCREAMING_SNAKE, and the registry is EXTENDED, never
// repurposed: an existing code must keep meaning exactly what it meant when
// a client first shipped against it.
//
// This file is deliberately free of "server-only" and of any Node or Next
// import so a client component can import the code type for localisation
// without dragging server code into the browser bundle.

// One itemised problem inside an error payload. Doc 13's shape is
// `{ field, issue }`; `message` is an additive, human-readable extra and
// clients must ignore fields they do not know.
export interface ErrorDetail {
  field: string;
  issue: string;
  message?: string;
}

// Codes shared by the handler library itself. Domain modules register their
// own codes in their own docs (RECEIPT_DUPLICATE, POINTS_INSUFFICIENT, ...)
// and pass them straight to ApiError, so this list is not exhaustive and is
// not a closed union.
export const API_ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  // Idempotency. IDEMPOTENCY_REPLAYED is doc 13's registered code for "key
  // reused with different payload" (409). The two _KEY_ codes and
  // IDEMPOTENCY_IN_PROGRESS are registry EXTENSIONS: doc 13 mandates the
  // header without naming a code for "missing", "unusable" or "the first
  // request with this key has not finished yet".
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_INVALID: "IDEMPOTENCY_KEY_INVALID",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  IDEMPOTENCY_REPLAYED: "IDEMPOTENCY_REPLAYED",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

// Anything thrown as an ApiError becomes the client's response verbatim, so
// `message` must always be safe to show an end user: no SQL, no stack, no
// internal identifiers. Everything else the handler catches collapses to a
// generic 500 INTERNAL instead.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly ErrorDetail[] | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: readonly ErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function badRequest(message: string, code: string = API_ERROR_CODES.BAD_REQUEST): ApiError {
  return new ApiError(400, code, message);
}

export function unauthenticated(message = "Please sign in to continue."): ApiError {
  return new ApiError(401, API_ERROR_CODES.UNAUTHENTICATED, message);
}

export function forbidden(message = "You do not have access to this resource."): ApiError {
  return new ApiError(403, API_ERROR_CODES.FORBIDDEN, message);
}

// Doc 13: 404 covers "absent" AND "outside the caller's tenant", and the two
// are never distinguished, so a probe cannot enumerate other tenants' ids.
export function notFound(message = "This resource was not found."): ApiError {
  return new ApiError(404, API_ERROR_CODES.NOT_FOUND, message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

export function validationFailed(
  details: readonly ErrorDetail[],
  message = "Some of the information provided needs your attention.",
): ApiError {
  return new ApiError(422, API_ERROR_CODES.VALIDATION_FAILED, message, details);
}

export function unprocessable(code: string, message: string, details?: readonly ErrorDetail[]): ApiError {
  return new ApiError(422, code, message, details);
}

export function rateLimited(message = "Too many requests. Please wait a moment."): ApiError {
  return new ApiError(429, API_ERROR_CODES.RATE_LIMITED, message);
}

export function internal(message = "Something went wrong. Please try again."): ApiError {
  return new ApiError(500, API_ERROR_CODES.INTERNAL, message);
}

export function dependencyUnavailable(
  message = "This service is temporarily unavailable. Please try again shortly.",
): ApiError {
  return new ApiError(503, API_ERROR_CODES.DEPENDENCY_UNAVAILABLE, message);
}

// Flattens a ZodError into doc 13's `details` array. Exactly two primitives
// cross the boundary: the dotted field path, and the issue CODE (zod's
// stable public discriminator such as "too_small" or "invalid_type", which
// is what makes the payload machine-readable and localisable client-side).
//
// Zod's own English messages are deliberately NOT forwarded. They are
// developer-facing prose ("Invalid input: expected string, received number"),
// they can echo a caller's payload back, and a custom .refine() message may
// name internal concepts - none of which satisfies doc 13's rule that
// anything reaching the client is safe for end users. The single top-level
// `message` carries the human text.
export function zodIssuesToDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "_root",
    issue: issue.code,
  }));
}
