import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";

import { checkRateLimit } from "@/lib/rate-limit";
import { del, get, redisKey, set, setNx } from "@/lib/redis";
import { createClient } from "@/lib/supabase/server";

import {
  ApiError,
  API_ERROR_CODES,
  isApiError,
  zodIssuesToDetails,
  type ErrorDetail,
} from "./errors";

// Shared route-handler composition for /api/v1, implementing
// docs/10-architecture/13-api-standards.md so that no handler ever hand-rolls
// an envelope, an error shape, a rate-limit header or an idempotency gate
// again. A route becomes ~20 lines of business logic plus a config object.
//
// Pipeline order follows doc 13's mandated sequence, with ONE deliberate
// deviation: route params are parsed with their Zod schema immediately after
// the session check, ahead of the authorize callback and the rate limiter.
// Doc 13 lists "zod parse" as step 4, after rate limiting, but an ownership
// or tenant assertion that runs on an UNVALIDATED path segment is exactly the
// kind of thing that turns into a security bug, and the rate-limit key is
// often derived from a path segment too. Validating the path first is the
// safer reading of the same rule. Body and query validation stay at step 4.
//
//   1. request_id            (generate or propagate)
//   2. requireSession        -> 401 UNAUTHENTICATED
//   3. params zod parse      -> 422 VALIDATION_FAILED
//   4. authorize             -> 403 / 404
//   5. rate limit            -> 429 RATE_LIMITED (+ honest Retry-After)
//   6. query + body zod      -> 422 VALIDATION_FAILED (400 on unparseable JSON)
//   7. idempotency gate      -> 400 / 409 / 503, or a replayed response
//   8. handler               -> domain errors as thrown ApiError
//   9. envelope

// Accepted shape for an inbound X-Request-Id. Client-supplied ids are useful
// for end-to-end correlation but are untrusted input that lands in log lines,
// so anything outside this alphabet is discarded and replaced rather than
// echoed (log injection, absurd lengths, control characters).
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Idempotency-Key alphabet. UUIDs and ULIDs both satisfy it. The colon is
// excluded on purpose: it is the Redis key separator, so allowing it would
// let a caller forge a key that collides with a different (route, user) scope.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.-]{8,200}$/;

// Doc 13: `SET key NX EX 86400`.
const IDEMPOTENCY_TTL_SECONDS = 86_400;

// The in-progress marker gets a much shorter TTL than the stored response.
// If a process dies mid-handler the marker is all that is left, and a 24h
// marker would wedge that key for a day; two minutes is longer than any
// request we are willing to serve, and self-heals afterwards.
const IDEMPOTENCY_LOCK_TTL_SECONDS = 120;

// Rate-limit keys are partly caller-controlled (a path segment, a keyBy
// result), so the derived suffix is clamped rather than trusted to be short.
const RATE_LIMIT_KEY_MAX_LENGTH = 128;

type RawParams = Record<string, string | string[]>;

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export interface RateLimitKeyInfo {
  userId: string | null;
  ip: string;
  params: RawParams;
  request: NextRequest;
}

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
  // "user" scopes by the authenticated user id (falling back to IP when the
  // route is public), "ip" always scopes by client IP, and a function lets a
  // route compose its own scope (e.g. user + claim id).
  keyBy?: "user" | "ip" | ((info: RateLimitKeyInfo) => string);
}

export interface AuthorizeArgs<TParams> {
  user: User | null;
  supabase: SupabaseServerClient;
  params: TParams;
  request: NextRequest;
  requestId: string;
}

export interface HandlerArgs<
  TBody,
  TParams,
  TQuery,
  TRequireSession extends boolean,
  TAuthContext,
> {
  request: NextRequest;
  requestId: string;
  body: TBody;
  params: TParams;
  query: TQuery;
  user: TRequireSession extends true ? User : User | null;
  supabase: SupabaseServerClient;
  idempotencyKey: string | null;
  // Whatever `authorize` returned. This is what lets a data-dependent
  // ownership check (fetch the row, assert the caller owns it, 404 if not)
  // live in `authorize` without the handler having to fetch the same row a
  // second time. `undefined` when no authorize callback is configured.
  auth: TAuthContext;
}

export interface HandlerResult<TData> {
  data: TData;
  status?: number;
  meta?: Record<string, unknown>;
  // A plain Record, one value per key - not string[] or Headers. jsonResponse()
  // below applies these with response.headers.set(key, value), not .append(),
  // so a route that needs to emit TWO Set-Cookie headers in one response
  // (e.g. clearing one cookie while setting another) can currently only
  // express one of them here; the second would silently overwrite the
  // first rather than erroring. True today (every current route needs at
  // most one Set-Cookie - see src/app/api/v1/auth/reset-password/route.ts),
  // but worth knowing before debugging it instead of reading it here.
  headers?: Record<string, string>;
}

export interface HandlerConfig<
  TData,
  TBody,
  TParams,
  TQuery,
  TRequireSession extends boolean,
  TAuthContext,
> {
  // Stable identifier for this endpoint. It scopes both the rate-limit and
  // the idempotency Redis keys, so it must be unique per route and must not
  // change casually (changing it silently resets both).
  route: string;
  schema?: z.ZodType<TBody>;
  paramsSchema?: z.ZodType<TParams>;
  querySchema?: z.ZodType<TQuery>;
  requireSession?: TRequireSession;
  // Throw an ApiError to reject (403 FORBIDDEN for role/tenant, 404 NOT_FOUND
  // for ownership so absent and out-of-scope stay indistinguishable). Anything
  // returned is handed to the handler as `auth`.
  authorize?: (args: AuthorizeArgs<TParams>) => TAuthContext | Promise<TAuthContext>;
  rateLimit?: RateLimitConfig;
  idempotent?: boolean;
  handler: (
    args: HandlerArgs<TBody, TParams, TQuery, TRequireSession, TAuthContext>,
  ) => Promise<HandlerResult<TData>>;
}

export type RouteHandler = (
  request: NextRequest,
  context?: { params?: Promise<unknown> },
) => Promise<NextResponse>;

interface SuccessPayload {
  status: number;
  body: { data: unknown; meta: Record<string, unknown> };
  headers: Record<string, string>;
}

interface IdempotencyRecord {
  state: "in_progress" | "completed";
  body_hash: string;
  status?: number;
  response?: unknown;
  headers?: Record<string, string>;
}

function resolveRequestId(request: NextRequest): string {
  const inbound = request.headers.get("x-request-id");
  return inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
}

function resolveClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) {
    return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function toRawParams(value: unknown): RawParams {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  const result: RawParams = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      result[key] = entry;
    }
  }
  return result;
}

function toQueryRecord(request: NextRequest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    result[key] = value;
  }
  return result;
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  headers: Record<string, string>,
): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("X-Request-Id", requestId);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function errorResponse(
  error: ApiError,
  requestId: string,
  headers: Record<string, string>,
): NextResponse {
  const body = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details && error.details.length > 0 ? { details: error.details } : {}),
      request_id: requestId,
    },
  };
  // The error's own headers win over the accumulated pipeline headers: an
  // error that names a header (doc 37's CONSUMER_SCAN_BLOCKED carries the
  // cooldown end in `Retry-After`) is stating its contract, and a rate-limit
  // `Retry-After` picked up earlier in the pipeline must not overwrite it.
  return jsonResponse(body, error.status, requestId, { ...headers, ...(error.headers ?? {}) });
}

function buildSuccessPayload<TData>(
  result: HandlerResult<TData>,
  requestId: string,
): SuccessPayload {
  return {
    status: result.status ?? 200,
    body: {
      data: result.data,
      meta: { ...(result.meta ?? {}), request_id: requestId },
    },
    headers: result.headers ?? {},
  };
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, prefix?: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  const details: ErrorDetail[] = zodIssuesToDetails(parsed.error).map((detail) =>
    prefix ? { ...detail, field: `${prefix}.${detail.field}` } : detail,
  );

  throw new ApiError(
    422,
    API_ERROR_CODES.VALIDATION_FAILED,
    "Some of the information provided needs your attention.",
    details,
  );
}

function isIdempotencyRecord(value: unknown): value is IdempotencyRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.state === "in_progress" || candidate.state === "completed") &&
    typeof candidate.body_hash === "string"
  );
}

function hashRequest(request: NextRequest, rawBody: string): string {
  return createHash("sha256")
    .update(`${request.method}\n${request.nextUrl.pathname}${request.nextUrl.search}\n${rawBody}`)
    .digest("hex");
}

// Idempotency fails CLOSED. Justification, since this repo deliberately holds
// both stances and the contrast matters:
//
//   src/lib/rate-limit.ts fails OPEN. It only guards throughput; a Redis blip
//   that 429'd or 500'd every caller would take a working feature down over a
//   temporary loss of throttling. Wrong direction to be strict.
//
//   src/features/rewards/server/token.ts fails CLOSED. It guards a security
//   property (single-use redemption); treating an outage as "not yet used"
//   would permit a replay, i.e. a double-spend.
//
// Idempotency sits with the token path, not the limiter. A route only opts in
// via `idempotent: true` when executing it twice causes real harm: points
// credited twice from one receipt, a redemption validated twice, a campaign
// activated twice. Failing open would silently downgrade such a route from
// exactly-once to at-least-once at precisely the worst moment, because an
// infrastructure blip is exactly when clients time out and retry - the outage
// both removes the guard and manufactures the duplicate requests it guards
// against. So when Redis is unreachable at the gate we return 503
// DEPENDENCY_UNAVAILABLE (doc 13: "client may retry") without running the
// handler. That is honest: unlike a 500, it tells the client the request was
// NOT processed, so retrying is safe.
//
// One asymmetry is intentional. If Redis fails AFTER the handler has run, at
// the store step, the side effect has already happened and refusing the
// response would be a lie that provokes the exact duplicate submission we are
// trying to prevent. There we log and return the success response; the key
// simply is not cached, so a replay re-executes - which is no worse than not
// having had idempotency at all for that one request.
async function readIdempotencyRecord(recordKey: string): Promise<IdempotencyRecord | null> {
  const raw = await get(recordKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isIdempotencyRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function defineHandler<
  TData,
  TBody = undefined,
  TParams = RawParams,
  TQuery = Record<string, string>,
  TRequireSession extends boolean = false,
  TAuthContext = undefined,
>(
  config: HandlerConfig<TData, TBody, TParams, TQuery, TRequireSession, TAuthContext>,
): RouteHandler {
  return async function route(request, context): Promise<NextResponse> {
    const requestId = resolveRequestId(request);
    // Accumulated across the pipeline so rate-limit headers land on error
    // responses too, not only on the happy path.
    const responseHeaders: Record<string, string> = {};

    try {
      // --- 2. session ---------------------------------------------------
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (config.requireSession && !user) {
        throw new ApiError(
          401,
          API_ERROR_CODES.UNAUTHENTICATED,
          "Please sign in to continue.",
        );
      }

      // --- 3. params ----------------------------------------------------
      const rawParams = toRawParams(context?.params ? await context.params : {});
      // Body fields keep their bare name (doc 13's example detail shape);
      // query and path fields are prefixed with their source so a body field
      // and a query field of the same name are distinguishable in `details`.
      const params = (
        config.paramsSchema ? parseOrThrow(config.paramsSchema, rawParams, "params") : rawParams
      ) as TParams;

      // --- 4. authorize -------------------------------------------------
      const auth = (
        config.authorize
          ? await config.authorize({ user, supabase, params, request, requestId })
          : undefined
      ) as TAuthContext;

      // --- 5. rate limit ------------------------------------------------
      if (config.rateLimit) {
        const { limit, windowSeconds, keyBy = "user" } = config.rateLimit;
        const ip = resolveClientIp(request);
        const info: RateLimitKeyInfo = { userId: user?.id ?? null, ip, params: rawParams, request };

        let suffix: string;
        if (typeof keyBy === "function") {
          suffix = keyBy(info);
        } else if (keyBy === "ip" || !user) {
          suffix = `ip:${ip}`;
        } else {
          suffix = `user:${user.id}`;
        }

        const result = await checkRateLimit({
          key: redisKey("rl", config.route, suffix.slice(0, RATE_LIMIT_KEY_MAX_LENGTH)),
          limit,
          windowSeconds,
        });

        responseHeaders["X-RateLimit-Limit"] = String(limit);
        responseHeaders["X-RateLimit-Remaining"] = String(result.remaining);
        responseHeaders["X-RateLimit-Reset"] = String(result.resetSeconds);

        if (!result.ok) {
          // Retry-After comes from the limiter's real remaining TTL, never
          // from the nominal window. Reporting the full window when only a
          // few seconds remain trains clients to back off far too long (and
          // was a fixed bug here once).
          responseHeaders["Retry-After"] = String(result.resetSeconds);
          throw new ApiError(
            429,
            API_ERROR_CODES.RATE_LIMITED,
            "Too many requests. Please wait a moment and try again.",
          );
        }
      }

      // --- 6. query and body --------------------------------------------
      const query = (
        config.querySchema
          ? parseOrThrow(config.querySchema, toQueryRecord(request), "query")
          : toQueryRecord(request)
      ) as TQuery;

      // The raw text is read at most once (a Request body is a single-use
      // stream) and serves both Zod parsing and the idempotency body hash.
      const needsRawBody = Boolean(config.schema) || Boolean(config.idempotent);
      const rawBody = needsRawBody ? await request.text() : "";

      let body = undefined as TBody;
      if (config.schema) {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(rawBody);
        } catch {
          throw new ApiError(
            400,
            API_ERROR_CODES.BAD_REQUEST,
            "Request body must be valid JSON.",
          );
        }
        body = parseOrThrow(config.schema, parsedJson);
      }

      const handlerArgs = {
        request,
        requestId,
        body,
        params,
        query,
        user: user as HandlerArgs<
          TBody,
          TParams,
          TQuery,
          TRequireSession,
          TAuthContext
        >["user"],
        supabase,
        idempotencyKey: null,
        auth,
      } satisfies HandlerArgs<TBody, TParams, TQuery, TRequireSession, TAuthContext>;

      // --- 7. idempotency gate ------------------------------------------
      if (!config.idempotent) {
        const payload = buildSuccessPayload(await config.handler(handlerArgs), requestId);
        return jsonResponse(payload.body, payload.status, requestId, {
          ...responseHeaders,
          ...payload.headers,
        });
      }

      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey) {
        throw new ApiError(
          400,
          API_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
          "An Idempotency-Key header is required for this request.",
        );
      }
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new ApiError(
          400,
          API_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
          "The Idempotency-Key header must be a UUID or similar opaque token.",
        );
      }

      // Scoped by route + caller + key so one client's key can never collide
      // with another's, and the same key on two endpoints stays independent.
      // Public idempotent routes fall back to the client IP as the caller
      // scope; that is weaker than a user id but still prevents cross-caller
      // collisions.
      const scope = user?.id ?? `ip:${resolveClientIp(request)}`;
      const recordKey = redisKey("idem", config.route, scope, idempotencyKey);
      const bodyHash = hashRequest(request, rawBody);

      let acquired: boolean;
      let existing: IdempotencyRecord | null = null;
      try {
        acquired = await setNx(
          recordKey,
          JSON.stringify({ state: "in_progress", body_hash: bodyHash } satisfies IdempotencyRecord),
          IDEMPOTENCY_LOCK_TTL_SECONDS,
        );
        if (!acquired) {
          existing = await readIdempotencyRecord(recordKey);
        }
      } catch (redisError) {
        // Fail CLOSED. See the block comment above readIdempotencyRecord.
        console.error("[api] idempotency gate unavailable, failing closed", redisError);
        throw new ApiError(
          503,
          API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
          "This service is temporarily unavailable. Please retry in a moment.",
        );
      }

      if (!acquired) {
        // The record vanished between SETNX and GET (its TTL elapsed in that
        // window). Treated as still-in-progress: refusing is always safe,
        // whereas executing might duplicate a side effect.
        if (!existing) {
          throw new ApiError(
            409,
            API_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
            "A request with this Idempotency-Key is still being processed. Please retry shortly.",
          );
        }

        // Different payload under the same key: doc 13's registered 409
        // IDEMPOTENCY_REPLAYED. Returning the stored response here would hand
        // the caller an answer to a question they did not ask.
        if (existing.body_hash !== bodyHash) {
          throw new ApiError(
            409,
            API_ERROR_CODES.IDEMPOTENCY_REPLAYED,
            "This Idempotency-Key was already used with a different request.",
          );
        }

        if (existing.state === "in_progress") {
          throw new ApiError(
            409,
            API_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
            "A request with this Idempotency-Key is still being processed. Please retry shortly.",
          );
        }

        // Replay: return the stored response WITHOUT re-running the handler.
        // The body is returned byte-identical, so meta.request_id still names
        // the execution that produced it; the X-Request-Id header names this
        // HTTP call, which is what correlates the replay itself in logs.
        return jsonResponse(existing.response, existing.status ?? 200, requestId, {
          ...responseHeaders,
          ...(existing.headers ?? {}),
          "Idempotent-Replayed": "true",
        });
      }

      // --- 8. handler (lock held) ---------------------------------------
      let payload: SuccessPayload;
      try {
        payload = buildSuccessPayload(
          await config.handler({ ...handlerArgs, idempotencyKey }),
          requestId,
        );
      } catch (handlerError) {
        // Release the key so a transient failure does not become permanent
        // for it. Only successful executions are worth replaying.
        await del(recordKey).catch((releaseError: unknown) => {
          console.error("[api] failed to release idempotency key", releaseError);
          return 0;
        });
        throw handlerError;
      }

      const cacheable = payload.status >= 200 && payload.status < 300;
      try {
        if (cacheable) {
          await set(
            recordKey,
            JSON.stringify({
              state: "completed",
              body_hash: bodyHash,
              status: payload.status,
              response: payload.body,
              headers: payload.headers,
            } satisfies IdempotencyRecord),
            IDEMPOTENCY_TTL_SECONDS,
          );
        } else {
          await del(recordKey);
        }
      } catch (storeError) {
        // The side effect already happened; see the fail-closed note above
        // for why this direction is deliberately different.
        console.error("[api] failed to persist idempotency record", storeError);
      }

      return jsonResponse(payload.body, payload.status, requestId, {
        ...responseHeaders,
        ...payload.headers,
      });
    } catch (error) {
      if (isApiError(error)) {
        return errorResponse(error, requestId, responseHeaders);
      }

      // Anything not deliberately thrown as an ApiError is an unexpected
      // fault. The message and stack stay server-side (Sentry/OTel correlate
      // via request_id); the client gets a generic 500.
      console.error(`[api] unhandled error in ${config.route} (request_id=${requestId})`, error);
      return errorResponse(
        new ApiError(500, API_ERROR_CODES.INTERNAL, "Something went wrong. Please try again."),
        requestId,
        responseHeaders,
      );
    }
  };
}
