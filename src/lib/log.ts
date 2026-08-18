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
// rule. Three value-level rules ride along because their shapes are
// unambiguous and their blast radius is total - a JWT (every Supabase key and
// session token), an `Authorization`-style bearer or basic credential, and
// Supabase's `sb_secret_` / `sb_publishable_` prefixes. All three match
// ANYWHERE in the value rather than being anchored: the realistic leak is a
// credential inside a URL, not a field whose whole value is the credential.
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
// DELIBERATELY NOT ANCHORED. An anchored `^...$` only catches a value that IS
// the credential, and the realistic leak is a credential INSIDE a longer
// string: a Supabase REST URL is shaped `...?apikey=eyJhbGci...`, and that is
// the single most likely thing to end up in a log field on this codebase. An
// anchored rule reads as protection and provides none for the actual case.
//
// Matching anywhere means the WHOLE value is redacted, not the matched span.
// Returning a partially-redacted string would invite exactly the reasoning
// that leaks the next one ("the rest looked safe").
const JWT_PATTERN = /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

/** `Authorization: Bearer ...` / `Basic ...`, wherever it ended up. */
const CREDENTIAL_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;

/** Supabase's own prefixed key formats, which are opaque and so match nothing
 * else above. `sb_secret_` is the service role; `sb_publishable_` is not a
 * secret but is still a key, and a log is not where either belongs. */
const SUPABASE_KEY_PATTERN = /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{4,}/;

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
  return (
    JWT_PATTERN.test(value) ||
    CREDENTIAL_PATTERN.test(value) ||
    SUPABASE_KEY_PATTERN.test(value)
  );
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
    name: String(error.name),
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
  // Each of the next four stringifies to  or  on its own - the same
  // trap as Error, and each is a shape this codebase genuinely logs.
  if (object instanceof Headers) {
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

    // Object.KEYS, not Object.entries. `entries` reads every value, so ONE
    // throwing getter anywhere in the object would unwind past this frame and
    // cost the entire log line - not just that field. Reading each value
    // inside its own try means a hostile or half-constructed object costs
    // exactly the field it broke.
    const result: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(object);
    } catch {
      // A Proxy whose `ownKeys` throws. Nothing about this object is readable.
      return "[unreadable]";
    }
    for (const key of keys) {
      try {
        const entry = (object as Record<string, unknown>)[key];
        result[key] = isSensitiveKey(key) ? REDACTED : walk(entry, depth + 1, seen);
      } catch {
        result[key] = "[unserializable]";
      }
    }
    return result;
  } finally {
    // Removed on the way back out so a value that legitimately appears twice
    // in a tree (the same row object under two keys) is printed twice rather
    // than reported as a cycle. Only an actual ancestor is `[circular]`.
    seen.delete(object);
  }
}

// No injection seam for the release: nothing ever passed one, and an option
// that only a deleted test could reach is dead weight on the public type.
// Tests stub the environment instead, which is what production reads.
function resolveRelease(): string | null {
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
  const release = resolveRelease();
  const traceable = correlation.value.trim().length > 0;

  // Fields are added ONE AT A TIME, each in its own try. The alternative -
  // building the whole field set inside one try - was what this module did,
  // and it was wrong in a way no test here caught: a single throwing getter
  // (or a Proxy with a hostile `ownKeys`) unwound to the outer catch and the
  // ENTIRE LINE was lost. Not degraded. Nothing: no msg, no request_id, not
  // even the sibling fields that serialized perfectly well.
  //
  // That is the exact failure this task exists to prevent, arriving through
  // the module built to prevent it. One bad field must cost one field.
  function addFields(entry: Record<string, unknown>, source: LogFields): void {
    let keys: string[];
    try {
      keys = Object.keys(source);
    } catch {
      entry.log_error = "fields could not be read";
      return;
    }

    for (const key of keys) {
      if (RESERVED_KEYS.has(key)) continue;
      try {
        // Read INSIDE the try: this is the line a throwing getter runs on.
        const value = (source as Record<string, unknown>)[key];
        entry[key] = isSensitiveKey(key) ? REDACTED : walk(value, 1, new WeakSet<object>());
      } catch {
        entry[key] = "[unserializable]";
      }
    }
  }

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    const entry: Record<string, unknown> = { level, time: "", msg: message };
    try {
      entry.time = now().toISOString();
    } catch {
      entry.log_error = "clock unavailable";
    }
    entry[correlation.key] = correlation.value;
    if (!traceable) entry.correlation_missing = true;
    if (release !== null) entry.release = release;

    addFields(entry, bound);
    if (fields !== undefined) addFields(entry, fields);

    try {
      write(level, JSON.stringify(entry));
    } catch {
      // The whole entry could not be written. Fall back to the smallest line
      // that is still worth having - the level, the message and the
      // correlation id - because "which request" plus "something broke here"
      // is a bisect step, and silence is not.
      try {
        write(
          level,
          JSON.stringify({
            level,
            time: entry.time,
            msg: message,
            [correlation.key]: correlation.value,
            log_error: "entry could not be serialized",
          }),
        );
      } catch {
        // NEVER THE REASON SOMETHING FAILS. The sink itself is gone. This
        // module is called from catch blocks already handling a fault and
        // from a fire-and-forget heartbeat; throwing from here would replace
        // a diagnosable 500 with an undiagnosable one.
      }
    }
  }

  return {
    error: (message, fields) => emit("error", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    info: (message, fields) => emit("info", message, fields),
    with: (fields) => createLogger(correlation, options, { ...bound, ...fields }),
  };
}

// -----------------------------------------------------------------------------
// THE REQUEST ID, IN ONE PLACE
// -----------------------------------------------------------------------------
// This pattern and this resolver used to live inside src/lib/api/handler.ts,
// which was fine while /api/v1 was the only thing that logged. It is not any
// more: src/instrumentation.ts's `onRequestError` reports faults in SERVER
// COMPONENTS AND PAGES, which never touch defineHandler at all - and that is
// the half the incident behind this task actually happened in. Two resolvers
// would be two correlation schemes wearing one name, so there is one.
//
// The screen matters as much as the id. An inbound X-Request-Id is untrusted
// input that lands in a log line, so anything outside this alphabet is
// DISCARDED AND REPLACED rather than echoed - otherwise whoever can set a
// header can forge a log entry, and absurd lengths and control characters get
// a free ride into the aggregator.

/** The accepted shape of an inbound `X-Request-Id`. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The inbound id if it is one, otherwise a fresh one. Never returns blank. */
export function resolveRequestId(inbound: string | null | undefined): string {
  return inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : newRequestId();
}

function newRequestId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  // No Web Crypto - an older runtime, or a test environment that does not
  // expose it. The id has to be unique enough to separate concurrent requests
  // in a log and nothing more; it is not a secret and nothing authenticates
  // on it, so a weaker source here is a legibility question, not a security
  // one. It still has to satisfy REQUEST_ID_PATTERN or the next hop would
  // discard it.
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
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
