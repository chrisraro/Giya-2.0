// =============================================================================
// The structured log line.
// =============================================================================
//
// One JSON object per line, so a log aggregator can filter on a field instead
// of guessing at a regex. The bar this module is built to clear is a sentence
// from t7-5-brief.md, and every design decision below traces back to one clause
// of it:
//
//   "when the next page 500s, can someone say WHICH LINE THREW, in WHICH
//    REQUEST, for WHICH USER, on WHICH DEPLOY?"
//
//   which line threw  -> `err.stack`, and the whole of §"Errors" below, because
//                        `JSON.stringify(new Error("x"))` is `"{}"` and a log
//                        that discards its own evidence is worse than no log:
//                        it looks like diligence.
//   which request     -> `request_id`, minted by src/lib/api/handler.ts and
//                        echoed on `X-Request-Id`. NOT a second scheme.
//   which user        -> a `user_id` field the call site supplies; this module
//                        only guarantees it will not be redacted away.
//   which deploy      -> `release`, from the platform's commit sha.
//
// -----------------------------------------------------------------------------
// WHY THERE IS NO GENERIC `createLogger`
// -----------------------------------------------------------------------------
// The brief: "An entry with neither is a log nobody can trace - make that hard
// to write." The only two exported constructors each REQUIRE a correlation id,
// so there is no call that produces an uncorrelated entry. A blank id is the
// one case the type system cannot catch, and it does not throw (see
// §"Never the reason something fails") - it stamps `correlation_missing: true`
// so the untraceable lines are themselves greppable.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE IS NOT `server-only`
// -----------------------------------------------------------------------------
// Nearly every other module in src/lib that touches a secret is. This one must
// not be, because `redact()` is also the scrubber the CLIENT Sentry config uses
// in `beforeSend` (instrumentation-client.ts). The brief requires that "the
// redaction from §1 applies to anything forwarded", and there is exactly one
// way to guarantee two scrubbers agree: be one scrubber. Nothing in here reads
// a secret, holds a secret, or imports a module that does - it only refuses to
// print things - so the usual reason for the fence does not apply.
//
// -----------------------------------------------------------------------------
// WHY REDACTION IS BY KEY (AND WHAT THAT DOES NOT COVER)
// -----------------------------------------------------------------------------
// A value-level scan for "things that look secret" is guesswork in both
// directions: it misses an opaque token and it mangles a receipt total. Keys
// are declared by the caller and are stable, so the key list is the primary
// rule. Two value-level rules ride along because their shapes are unambiguous
// and their blast radius is total - a JWT (every Supabase key and session
// token) and an `Authorization`-style bearer credential.
//
// WHAT THIS CANNOT DO: redact a secret pasted into the MESSAGE string, or into
// a provider's own error text. That is why call sites pass structured fields
// and why this repo's `infrastructureFailure` / `reportThrown` posture already
// keeps provider text off the consumer path. The log gets the detail, the user
// gets the sentence - and neither gets the credential.

export type LogLevel = "error" | "warn" | "info";

/** What replaces a redacted value. A literal, so a log reader can grep it. */
export const REDACTED = "[redacted]";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  /**
   * A logger with the same correlation id and `fields` merged into every
   * subsequent entry. Fields passed at a call site win over bound ones; the
   * reserved keys below win over both.
   */
  with(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /**
   * Injected clock. Tests assert a literal `time`, which is only possible if
   * the timestamp has a seam - the brief's "deterministic output".
   */
  readonly now?: () => Date;
  /** Injected sink. Defaults to the console channel matching the level. */
  readonly write?: (level: LogLevel, line: string) => void;
  /**
   * Deploy identity. Defaults to the platform's commit sha, then its
   * deployment id, then nothing at all - and "nothing at all" omits the key
   * rather than emitting `"release":null`, because a null in every line off
   * platform is noise that teaches readers to ignore the field.
   */
  readonly release?: string | null;
}

// The keys the entry owns. A field of the same name is DROPPED, not merged:
// `request_id` is the one thing a reader has to be able to trust, and a
// handler that forwards a caller-supplied body into `fields` must not be able
// to relabel the line it appears on.
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "level",
  "time",
  "msg",
  "request_id",
  "job_id",
  "correlation_missing",
  "release",
]);

// Compared against the key with every non-letter stripped and the rest
// lowercased, so `SUPABASE_SERVICE_ROLE_KEY`, `supabaseServiceRoleKey` and
// `supabase-service-role-key` are one rule and not three.
const SENSITIVE_KEY_PARTS: readonly string[] = [
  "auth", // authorization, auth_code, authToken. Deliberately broad.
  "cookie",
  "token", // access_token, page token, INTEGRATION_TOKEN_AES_KEY, REDEMPTION_TOKEN_SECRET
  "secret", // META_APP_SECRET, OCR_FUNCTION_SECRET
  "password",
  "passphrase",
  "credential",
  "signature", // upstash-signature
  "signingkey", // QSTASH_CURRENT/NEXT_SIGNING_KEY
  "ciphertext",
  "encrypted",
  "bearer",
  "apikey", // GROQ_API_KEY, RESEND_API_KEY
  "anonkey", // NEXT_PUBLIC_SUPABASE_ANON_KEY
  "publishablekey",
  "servicerole", // SUPABASE_SERVICE_ROLE_KEY
  "privatekey",
  "accesskey",
  "aeskey",
  "sessionkey",
];

/** A JWT: every Supabase key and every Supabase session is one of these. */
const JWT_PATTERN = /^ey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/;

/** `Authorization: Bearer ...`, wherever it ended up. */
const BEARER_PATTERN = /^bearer\s+\S+/i;

// Bounds. A log line is written on the failure path, which is exactly when a
// value is most likely to be enormous or self-referential, and an unbounded
// line is its own outage (aggregators drop, disks fill).
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 8_192;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function isSensitiveValue(value: string): boolean {
  return JWT_PATTERN.test(value) || BEARER_PATTERN.test(value);
}

/**
 * True for anything that behaves like an Error, including one whose prototype
 * came from another realm (a worker, a vm context, a structured clone) where
 * `instanceof Error` is false. That case is not hypothetical here: it is the
 * same "looks handled, is not" shape as the `{}` trap.
 */
function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.toString.call(value) !== "[object Error]") return false;
  const candidate = value as { name?: unknown; message?: unknown };
  return typeof candidate.name === "string" && typeof candidate.message === "string";
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
  readonly code?: unknown;
}

/**
 * An Error as a plain object that survives `JSON.stringify`.
 *
 * `name`, `message` and `stack` are non-enumerable own properties on a real
 * Error, which is the entire reason `JSON.stringify(new Error("x"))` is
 * `"{}"`. They are copied explicitly. `cause` is followed because a wrapped
 * error puts the actual fault - the connection refused, the column that does
 * not exist - at the bottom of the chain and nowhere else.
 */
export function serializeError(value: unknown): SerializedError | unknown {
  if (!isErrorLike(value)) return value;

  const error = value as Error & { cause?: unknown; code?: unknown };
  const serialized: Record<string, unknown> = {
    name: String(error.name ?? "Error"),
    message: String(error.message ?? ""),
  };
  if (typeof error.stack === "string") serialized.stack = error.stack;
  if (error.code !== undefined) serialized.code = error.code;
  if (error.cause !== undefined) serialized.cause = error.cause;
  return serialized as unknown as SerializedError;
}

/**
 * A JSON-safe, secret-free copy of `value`.
 *
 * Exported because the Sentry hooks scrub with it too (see the header): one
 * scrubber, so the two cannot drift.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      if (isSensitiveValue(value)) return REDACTED;
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}[truncated]`
        : value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      // JSON.stringify THROWS on a bigint. An unhandled throw inside the
      // logger would replace the fault being reported with a fault about
      // reporting it.
      return value.toString();
    case "function":
      return "[function]";
    case "symbol":
      return "[symbol]";
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return "[truncated]";

  const object = value as object;
  if (seen.has(object)) return "[circular]";

  if (isErrorLike(object)) {
    seen.add(object);
    const result = walk(serializeError(object), depth, seen);
    seen.delete(object);
    return result;
  }

  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "[invalid date]" : object.toISOString();
  }

  // Each of these stringifies to `{}` on its own - the same trap as Error,
  // and each one is a shape this codebase genuinely puts in a log field.
  if (typeof Headers !== "undefined" && object instanceof Headers) {
    return walk(Object.fromEntries(object.entries()), depth, seen);
  }
  if (object instanceof Map) {
    return walk(Object.fromEntries(object.entries()), depth, seen);
  }
  if (object instanceof Set) {
    return walk([...object], depth, seen);
  }
  if (object instanceof RegExp) {
    return object.toString();
  }

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => walk(item, depth + 1, seen));
      if (object.length > MAX_ARRAY_ITEMS) {
        items.push(`[+${object.length - MAX_ARRAY_ITEMS} more]`);
      }
      return items;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTED : walk(entry, depth + 1, seen);
    }
    return result;
  } finally {
    // Removed on the way back out so a value that legitimately appears twice
    // in a tree (the same row object under two keys) is printed twice rather
    // than reported as a cycle. Only an actual ancestor is `[circular]`.
    seen.delete(object);
  }
}

function resolveRelease(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  const env: Record<string, string | undefined> =
    typeof process === "undefined" ? {} : (process.env ?? {});
  const candidate = env.VERCEL_GIT_COMMIT_SHA ?? env.VERCEL_DEPLOYMENT_ID ?? "";
  return candidate.trim().length > 0 ? candidate : null;
}

function consoleWrite(level: LogLevel, line: string): void {
  // Resolved per call, not captured at module load, so a test spy installed
  // after import is the one that receives the line.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

interface Correlation {
  readonly key: "request_id" | "job_id";
  readonly value: string;
}

function createLogger(
  correlation: Correlation,
  options: LoggerOptions,
  bound: LogFields,
): Logger {
  const now = options.now ?? (() => new Date());
  const write = options.write ?? consoleWrite;
  const release = resolveRelease(options.release);
  const traceable = correlation.value.trim().length > 0;

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    try {
      const entry: Record<string, unknown> = {
        level,
        time: now().toISOString(),
        msg: message,
        [correlation.key]: correlation.value,
      };
      if (!traceable) entry.correlation_missing = true;
      if (release !== null) entry.release = release;

      const merged = fields === undefined ? bound : { ...bound, ...fields };
      for (const [key, value] of Object.entries(merged)) {
        if (RESERVED_KEYS.has(key)) continue;
        entry[key] = isSensitiveKey(key) ? REDACTED : walk(value, 1, new WeakSet<object>());
      }

      write(level, JSON.stringify(entry));
    } catch {
      // NEVER THE REASON SOMETHING FAILS. This module is called from catch
      // blocks that are already handling a fault, and from a heartbeat that
      // is explicitly fire-and-forget. A logger that throws would replace a
      // diagnosable 500 with an undiagnosable one - the precise failure this
      // whole task exists to prevent - so the last resort is to lose the line
      // rather than the incident.
    }
  }

  return {
    error: (message, fields) => emit("error", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    info: (message, fields) => emit("info", message, fields),
    with: (fields) => createLogger(correlation, options, { ...bound, ...fields }),
  };
}

/**
 * A logger for a request context. `requestId` is the id
 * src/lib/api/handler.ts already mints and echoes on `X-Request-Id` - the same
 * value the client sees in the error envelope's `request_id`. Do not mint
 * another.
 */
export function requestLogger(requestId: string, options: LoggerOptions = {}): Logger {
  return createLogger({ key: "request_id", value: requestId }, options, {});
}

/**
 * A logger for a worker context. `jobId` is the `jobs` row id that every queue
 * payload carries and that src/lib/queue/claim.ts leases - again, not a new
 * scheme.
 */
export function jobLogger(jobId: string, options: LoggerOptions = {}): Logger {
  return createLogger({ key: "job_id", value: jobId }, options, {});
}
