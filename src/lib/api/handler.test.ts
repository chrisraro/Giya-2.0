import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { HandlerResult } from "./handler";

// The shared /api/v1 route handler library. These tests ARE the contract for
// every future route handler in the app, so they assert the doc 13
// (10-architecture/13-api-standards.md) envelope, error registry, rate-limit
// and Idempotency-Key semantics directly rather than through any one route.
//
// Redis is mocked at the @/lib/redis boundary (never live Upstash). The real
// checkRateLimit runs on top of that mock, so the 429 Retry-After assertions
// exercise the genuine "read the actual TTL" path rather than a stubbed
// limiter - that honesty was a fixed bug once and must not regress.

vi.mock("server-only", () => ({}));

const hoisted = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setNx: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  expireNx: vi.fn(),
  ttl: vi.fn(),
  redisKey: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  setNx: hoisted.setNx,
  get: hoisted.get,
  set: hoisted.set,
  del: hoisted.del,
  incr: hoisted.incr,
  expireNx: hoisted.expireNx,
  ttl: hoisted.ttl,
  redisKey: hoisted.redisKey,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: hoisted.getUser } })),
}));

const { defineHandler } = await import("./handler");
const { ApiError } = await import("./errors");

const USER_ID = "11111111-1111-4111-8111-111111111111";

// What the handler was invoked with. Captured from inside an INLINE handler,
// which defineHandler contextually types, so these assertions stay strictly
// typed instead of digging through an untyped mock call tuple.
interface CapturedArgs {
  body: unknown;
  params: unknown;
  query: unknown;
  user: { id: string } | null;
  supabase: unknown;
  requestId: string;
  idempotencyKey: string | null;
}

interface RequestInitLike {
  method?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeRequest(init: RequestInitLike = {}): NextRequest {
  const headers = new Headers(init.headers ?? {});
  const hasBody = init.body !== undefined;
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new NextRequest(init.url ?? "https://giya.test/api/v1/things", {
    method: init.method ?? "POST",
    headers,
    ...(hasBody
      ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }
      : {}),
  });
}

function authed(): void {
  hoisted.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
}

function anonymous(): void {
  hoisted.getUser.mockResolvedValue({ data: { user: null } });
}

beforeEach(() => {
  hoisted.store.clear();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  // In-memory Redis good enough for idempotency semantics: SET NX must fail
  // when the key exists, GET must see what SET wrote, DEL must remove it.
  hoisted.setNx.mockImplementation(async (key: string, value: string) => {
    if (hoisted.store.has(key)) {
      return false;
    }
    hoisted.store.set(key, value);
    return true;
  });
  hoisted.get.mockImplementation(async (key: string) => hoisted.store.get(key) ?? null);
  hoisted.set.mockImplementation(async (key: string, value: string) => {
    hoisted.store.set(key, value);
    return true;
  });
  hoisted.del.mockImplementation(async (key: string) => (hoisted.store.delete(key) ? 1 : 0));
  hoisted.redisKey.mockImplementation((...parts: string[]) => `test:${parts.join(":")}`);

  // Rate limiter defaults: first hit of a fresh window, full TTL remaining.
  hoisted.incr.mockResolvedValue(1);
  hoisted.expireNx.mockResolvedValue(true);
  hoisted.ttl.mockResolvedValue(60);

  authed();
});

describe("defineHandler - success envelope", () => {
  it("wraps the handler result in { data } with meta.request_id and an X-Request-Id header", async () => {
    const route = defineHandler({
      route: "things.create",
      handler: async () => ({ data: { id: "abc", points: 10 } }),
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as {
      data: { id: string; points: number };
      meta: { request_id: string };
    };

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ id: "abc", points: 10 });
    expect(typeof body.meta.request_id).toBe("string");
    expect(body.meta.request_id.length).toBeGreaterThan(0);
    expect(response.headers.get("X-Request-Id")).toBe(body.meta.request_id);
    expect(body).not.toHaveProperty("error");
  });

  it("honours a handler-supplied status and extra headers, and merges extra meta", async () => {
    const route = defineHandler({
      route: "things.create",
      handler: async () => ({
        data: [{ id: "a" }],
        status: 201,
        meta: { page: { next_cursor: "c1", has_more: true, limit: 25 } },
        headers: { Location: "/api/v1/things/a" },
      }),
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as {
      meta: { page: { limit: number }; request_id: string };
    };

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe("/api/v1/things/a");
    expect(body.meta.page.limit).toBe(25);
    expect(typeof body.meta.request_id).toBe("string");
  });
});

describe("defineHandler - Next.js route compatibility", () => {
  it("returns a function assignable to the shape Next.js calls a route handler with", async () => {
    // Compile-time assertion as much as a runtime one: Next.js 16 generates a
    // per-route type and checks the exported handler against it, so
    // `export const POST = defineHandler({...})` must satisfy
    // (NextRequest, { params: Promise<T> }) => Promise<Response>.
    type NextRouteSignature = (
      request: NextRequest,
      context: { params: Promise<{ claimId: string }> },
    ) => Promise<Response>;

    const post: NextRouteSignature = defineHandler({
      route: "compat.check",
      paramsSchema: z.object({ claimId: z.string().uuid() }),
      handler: async ({ params }) => ({ data: { claim_id: params.claimId } }),
    });

    const claimId = "33333333-3333-4333-8333-333333333333";
    const response = await post(makeRequest(), { params: Promise.resolve({ claimId }) });

    expect(response.status).toBe(200);
  });
});

describe("defineHandler - request_id propagation", () => {
  it("propagates a well-formed inbound X-Request-Id", async () => {
    const route = defineHandler({
      route: "things.create",
      handler: async () => ({ data: null }),
    });

    const response = await route(
      makeRequest({ headers: { "x-request-id": "req_01JABCDEF" } }),
    );

    expect(response.headers.get("X-Request-Id")).toBe("req_01JABCDEF");
  });

  it("ignores a malformed inbound X-Request-Id and generates its own", async () => {
    const route = defineHandler({
      route: "things.create",
      handler: async () => ({ data: null }),
    });

    const response = await route(
      makeRequest({ headers: { "x-request-id": "bad id with spaces and <script>" } }),
    );

    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).not.toBe("bad id with spaces and <script>");
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("defineHandler - validation", () => {
  const schema = z.object({
    receipt_number: z.string().min(1),
    total_centavos: z.number().int().positive(),
  });

  it("returns 422 VALIDATION_FAILED with machine-readable per-field details", async () => {
    const handler = vi.fn();
    const route = defineHandler({
      route: "receipts.create",
      schema,
      handler,
    });

    const response = await route(
      makeRequest({ body: { receipt_number: "", total_centavos: -5 } }),
    );
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        details: { field: string; issue: string }[];
        request_id: string;
      };
    };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(handler).not.toHaveBeenCalled();
    expect(body.error.details.map((detail) => detail.field).sort()).toEqual([
      "receipt_number",
      "total_centavos",
    ]);
    for (const detail of body.error.details) {
      expect(typeof detail.issue).toBe("string");
      expect(detail.issue.length).toBeGreaterThan(0);
    }
    expect(typeof body.error.request_id).toBe("string");
  });

  it("never leaks raw Zod internals in the error payload", async () => {
    const route = defineHandler({ route: "receipts.create", schema, handler: async () => ({ data: null }) });

    const response = await route(makeRequest({ body: { receipt_number: 5 } }));
    const raw = await response.text();

    expect(raw).not.toContain("ZodError");
    expect(raw).not.toContain("expected");
    expect(raw).not.toContain("stack");
  });

  it("passes the parsed body to the handler", async () => {
    let captured: CapturedArgs | undefined;
    const route = defineHandler({
      route: "receipts.create",
      schema,
      handler: async (args) => {
        captured = args;
        return { data: null };
      },
    });

    await route(makeRequest({ body: { receipt_number: "R-1", total_centavos: 12_500 } }));

    expect(captured?.body).toEqual({ receipt_number: "R-1", total_centavos: 12_500 });
  });

  it("returns 400 BAD_REQUEST for a body that is not valid JSON", async () => {
    const handler = vi.fn();
    const route = defineHandler({ route: "receipts.create", schema, handler });

    const response = await route(makeRequest({ body: "{not json" }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates query parameters and hands the parsed result to the handler", async () => {
    let captured: CapturedArgs | undefined;
    const route = defineHandler({
      route: "things.list",
      querySchema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      handler: async (args) => {
        captured = args;
        return { data: null };
      },
    });

    await route(makeRequest({ method: "GET", url: "https://giya.test/api/v1/things?limit=50" }));

    expect(captured?.query).toEqual({ limit: 50 });
  });

  it("returns 422 when query parameters fail validation", async () => {
    const route = defineHandler({
      route: "things.list",
      querySchema: z.object({ limit: z.coerce.number().int().min(1).max(100) }),
      handler: async () => ({ data: null }),
    });

    const response = await route(
      makeRequest({ method: "GET", url: "https://giya.test/api/v1/things?limit=9999" }),
    );
    const body = (await response.json()) as { error: { code: string; details: { field: string }[] } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    // Query and path fields carry a source prefix; body fields do not. That
    // keeps a body field and a query field of the same name distinguishable.
    expect(body.error.details[0]?.field).toBe("query.limit");
  });

  it("validates route params and hands the parsed result to the handler", async () => {
    let captured: CapturedArgs | undefined;
    const route = defineHandler({
      route: "claims.token",
      paramsSchema: z.object({ claimId: z.string().uuid() }),
      handler: async (args) => {
        captured = args;
        return { data: null };
      },
    });

    const claimId = "33333333-3333-4333-8333-333333333333";
    await route(makeRequest(), { params: Promise.resolve({ claimId }) });

    expect(captured?.params).toEqual({ claimId });
  });

  it("returns 422 when a route param fails validation", async () => {
    const handler = vi.fn();
    const route = defineHandler({
      route: "claims.token",
      paramsSchema: z.object({ claimId: z.string().uuid() }),
      handler,
    });

    const response = await route(makeRequest(), { params: Promise.resolve({ claimId: "nope" }) });
    const body = (await response.json()) as { error: { details: { field: string }[] } };

    expect(response.status).toBe(422);
    expect(body.error.details[0]?.field).toBe("params.claimId");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("defineHandler - session and authorization", () => {
  it("returns 401 UNAUTHENTICATED and skips the handler when there is no session", async () => {
    anonymous();
    const handler = vi.fn();
    const route = defineHandler({ route: "things.create", requireSession: true, handler });

    const response = await route(makeRequest());
    const body = (await response.json()) as { error: { code: string; request_id: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(typeof body.error.request_id).toBe("string");
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the resolved user and supabase client to the handler", async () => {
    let captured: CapturedArgs | undefined;
    const route = defineHandler({
      route: "things.create",
      requireSession: true,
      handler: async (args) => {
        captured = args;
        return { data: null };
      },
    });

    await route(makeRequest());

    expect(captured?.user?.id).toBe(USER_ID);
    expect(captured?.supabase).toBeDefined();
    expect(typeof captured?.requestId).toBe("string");
  });

  it("runs the authorize callback after the session and can reject with 403 FORBIDDEN", async () => {
    const handler = vi.fn();
    const route = defineHandler({
      route: "things.create",
      requireSession: true,
      authorize: () => {
        throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
      },
      handler,
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands whatever authorize returns to the handler as `auth`, so an ownership check fetches the row once", async () => {
    // This is the shape the existing reward-claims token route needs: fetch
    // the claim, assert the CALLER owns it (RLS alone does not, because the
    // policy is a union of consumer-own and staff-of-business), then use the
    // very same claim in the handler. Without `auth` the handler would have
    // to re-fetch, which is both wasteful and a chance to drift.
    const fetchClaim = vi.fn(async () => ({ claimId: "c-1", consumerId: USER_ID, status: "claimed" }));
    let captured: CapturedArgs | undefined;

    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      authorize: async ({ user }) => {
        const claim = await fetchClaim();
        if (claim.consumerId !== user?.id) {
          throw new ApiError(404, "NOT_FOUND", "This claim was not found.");
        }
        return { claim };
      },
      handler: async (args) => {
        captured = args;
        return { data: { status: args.auth.claim.status } };
      },
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as { data: { status: string } };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("claimed");
    expect(fetchClaim).toHaveBeenCalledTimes(1);
    expect(captured?.user?.id).toBe(USER_ID);
  });

  it("lets authorize express the 404-for-non-owner rule (never distinguish absent from out-of-scope)", async () => {
    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      paramsSchema: z.object({ claimId: z.string().uuid() }),
      authorize: ({ params }) => {
        if (params.claimId !== "33333333-3333-4333-8333-333333333333") {
          throw new ApiError(404, "NOT_FOUND", "This claim was not found.");
        }
      },
      handler: async () => ({ data: { ok: true } }),
    });

    const response = await route(makeRequest(), {
      params: Promise.resolve({ claimId: "99999999-9999-4999-8999-999999999999" }),
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("does not require a session when requireSession is omitted", async () => {
    anonymous();
    let captured: CapturedArgs | undefined;
    const route = defineHandler({
      route: "public.read",
      handler: async (args) => {
        captured = args;
        return { data: "public" };
      },
    });

    const response = await route(makeRequest({ method: "GET" }));

    expect(response.status).toBe(200);
    expect(captured?.user).toBeNull();
  });
});

describe("defineHandler - rate limiting", () => {
  it("emits rate-limit headers on an allowed request", async () => {
    hoisted.incr.mockResolvedValue(2);
    hoisted.ttl.mockResolvedValue(45);
    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      rateLimit: { limit: 5, windowSeconds: 60, keyBy: "user" },
      handler: async () => ({ data: null }),
    });

    const response = await route(makeRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("3");
    expect(response.headers.get("X-RateLimit-Reset")).toBe("45");
  });

  it("returns 429 RATE_LIMITED with an HONEST Retry-After taken from the real remaining TTL", async () => {
    // 37, not the full 60-second window: a dishonest Retry-After that always
    // reported the window was a real bug in this repo. Do not regress it.
    hoisted.incr.mockResolvedValue(6);
    hoisted.ttl.mockResolvedValue(37);
    const handler = vi.fn();
    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      rateLimit: { limit: 5, windowSeconds: 60, keyBy: "user" },
      handler,
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(response.headers.get("Retry-After")).toBe("37");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(handler).not.toHaveBeenCalled();
  });

  it("scopes the default key by user id", async () => {
    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      rateLimit: { limit: 5, windowSeconds: 60, keyBy: "user" },
      handler: async () => ({ data: null }),
    });

    await route(makeRequest());

    expect(hoisted.redisKey).toHaveBeenCalledWith("rl", "claims.token", `user:${USER_ID}`);
  });

  it("scopes by client IP when keyBy is 'ip'", async () => {
    anonymous();
    const route = defineHandler({
      route: "auth.login",
      rateLimit: { limit: 10, windowSeconds: 60, keyBy: "ip" },
      handler: async () => ({ data: null }),
    });

    await route(makeRequest({ headers: { "x-forwarded-for": "203.0.113.7, 70.41.3.18" } }));

    expect(hoisted.redisKey).toHaveBeenCalledWith("rl", "auth.login", "ip:203.0.113.7");
  });

  it("supports a keyBy function so a route can compose user and path scope", async () => {
    const claimId = "33333333-3333-4333-8333-333333333333";
    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      paramsSchema: z.object({ claimId: z.string().uuid() }),
      rateLimit: {
        limit: 5,
        windowSeconds: 60,
        keyBy: ({ userId, params }) => `${userId}:${String(params.claimId)}`,
      },
      handler: async () => ({ data: null }),
    });

    await route(makeRequest(), { params: Promise.resolve({ claimId }) });

    expect(hoisted.redisKey).toHaveBeenCalledWith("rl", "claims.token", `${USER_ID}:${claimId}`);
  });

  it("fails open when Redis is down, because throttling is an availability concern", async () => {
    hoisted.incr.mockRejectedValue(new Error("Upstash Redis request failed (500)"));
    const route = defineHandler({
      route: "claims.token",
      requireSession: true,
      rateLimit: { limit: 5, windowSeconds: 60, keyBy: "user" },
      handler: async () => ({ data: "served anyway" }),
    });

    const response = await route(makeRequest());

    expect(response.status).toBe(200);
  });
});

describe("defineHandler - error-carried headers", () => {
  it("emits headers an ApiError declares", async () => {
    // Some errors ARE a header: doc 37's 403 CONSUMER_SCAN_BLOCKED states when
    // scanning resumes in Retry-After, and a client should never have to parse
    // a sentence to find that out.
    const route = defineHandler({
      route: "receipts.submit",
      requireSession: true,
      handler: async () => {
        throw new ApiError(
          403,
          "CONSUMER_SCAN_BLOCKED",
          "Receipt scanning is paused on your account for now.",
          undefined,
          { "Retry-After": "3600" },
        );
      },
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("CONSUMER_SCAN_BLOCKED");
    expect(response.headers.get("Retry-After")).toBe("3600");
  });

  it("lets the error's own header win over one the pipeline already set", async () => {
    // The limiter records Retry-After on every request it allows through as
    // well; an error that names its own value is stating a different fact and
    // must not be overwritten by the ambient one.
    hoisted.incr.mockResolvedValue(1);
    hoisted.ttl.mockResolvedValue(59);
    const route = defineHandler({
      route: "receipts.submit",
      requireSession: true,
      rateLimit: { limit: 6, windowSeconds: 60, keyBy: "user" },
      handler: async () => {
        throw new ApiError(429, "RATE_LIMITED", "Daily limit reached.", undefined, {
          "Retry-After": "86400",
        });
      },
    });

    const response = await route(makeRequest());

    expect(response.headers.get("Retry-After")).toBe("86400");
    // Headers the error did not name still come through.
    expect(response.headers.get("X-RateLimit-Limit")).toBe("6");
  });
});

describe("defineHandler - unexpected errors", () => {
  it("returns 500 INTERNAL without leaking the message or stack", async () => {
    const route = defineHandler({
      route: "things.create",
      handler: async () => {
        throw new Error("connection string postgres://user:hunter2@db/internal");
      },
    });

    const response = await route(makeRequest());
    const raw = await response.text();
    const body = JSON.parse(raw) as { error: { code: string; message: string; request_id: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain("at ");
    expect(typeof body.error.request_id).toBe("string");
    expect(response.headers.get("X-Request-Id")).toBe(body.error.request_id);
  });

  it("surfaces a thrown ApiError with its code, status and details", async () => {
    const route = defineHandler({
      route: "receipts.create",
      handler: async () => {
        throw new ApiError(422, "RECEIPT_DUPLICATE", "This receipt has already been submitted.", [
          { field: "receipt_number", issue: "duplicate" },
        ]);
      },
    });

    const response = await route(makeRequest());
    const body = (await response.json()) as {
      error: { code: string; message: string; details: { field: string; issue: string }[] };
    };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("RECEIPT_DUPLICATE");
    expect(body.error.message).toBe("This receipt has already been submitted.");
    expect(body.error.details).toEqual([{ field: "receipt_number", issue: "duplicate" }]);
  });
});

describe("defineHandler - idempotency", () => {
  const schema = z.object({ amount: z.number() });
  const KEY = "9f1c2b7a-0000-4000-8000-000000000001";

  // Narrower than the full HandlerArgs on purpose: a function taking fewer
  // properties is still assignable where the wider one is expected, and it
  // keeps the mocks below strictly typed.
  type IdempotentHandler = (args: {
    body: { amount: number };
    idempotencyKey: string | null;
  }) => Promise<HandlerResult<unknown>>;

  function idempotentRoute(handler: IdempotentHandler) {
    return defineHandler({
      route: "receipts.create",
      requireSession: true,
      schema,
      idempotent: true,
      handler,
    });
  }

  it("returns 400 when the Idempotency-Key header is missing on a route that requires it", async () => {
    const handler = vi.fn<IdempotentHandler>();
    const route = idempotentRoute(handler);

    const response = await route(makeRequest({ body: { amount: 100 } }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed Idempotency-Key rather than letting it into a Redis key", async () => {
    const handler = vi.fn<IdempotentHandler>();
    const route = idempotentRoute(handler);

    const response = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": "a b:c" } }),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(handler).not.toHaveBeenCalled();
  });

  it("REPLAY: a second request with the same key returns the stored response and runs the handler exactly ONCE", async () => {
    const handler = vi.fn(async () => ({ data: { receipt_id: "r-1", points: 42 } }));
    const route = idempotentRoute(handler);

    const first = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    const firstBody = (await first.json()) as { data: { receipt_id: string } };

    const second = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    const secondBody = (await second.json()) as { data: { receipt_id: string } };

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(first.status);
    expect(secondBody).toEqual(firstBody);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
  });

  it("scopes the idempotency record by route, user and key", async () => {
    const route = idempotentRoute(vi.fn(async () => ({ data: null })));

    await route(makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }));

    expect(hoisted.redisKey).toHaveBeenCalledWith("idem", "receipts.create", USER_ID, KEY);
  });

  it("CONCURRENT: a request arriving while the first is still in flight gets 409 and does not double-execute", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await gate;
      return { data: { receipt_id: "r-1" } };
    });
    const route = idempotentRoute(handler);

    const inFlight = route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    // Let the first request reach the handler (and therefore hold the lock).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const concurrent = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    const concurrentBody = (await concurrent.json()) as { error: { code: string } };

    expect(concurrent.status).toBe(409);
    expect(concurrentBody.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(handler).toHaveBeenCalledTimes(1);

    release?.();
    const first = await inFlight;
    expect(first.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("REUSE: the same key with a different body is rejected instead of returning a stale response", async () => {
    const handler = vi.fn(async () => ({ data: { receipt_id: "r-1" } }));
    const route = idempotentRoute(handler);

    await route(makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }));
    const reused = await route(
      makeRequest({ body: { amount: 999 }, headers: { "idempotency-key": KEY } }),
    );
    const body = (await reused.json()) as { error: { code: string } };

    expect(reused.status).toBe(409);
    expect(body.error.code).toBe("IDEMPOTENCY_REPLAYED");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a domain error, so a transient failure never becomes permanent for that key", async () => {
    const handler = vi
      .fn<IdempotentHandler>()
      .mockRejectedValueOnce(new ApiError(409, "CONFLICT", "Try again."))
      .mockResolvedValueOnce({ data: { receipt_id: "r-1" } });
    const route = idempotentRoute(handler);

    const failed = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    expect(failed.status).toBe(409);

    const retried = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    const body = (await retried.json()) as { data: { receipt_id: string } };

    expect(retried.status).toBe(200);
    expect(body.data.receipt_id).toBe("r-1");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a 500, so the caller can retry the same key", async () => {
    const handler = vi
      .fn<IdempotentHandler>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ data: { receipt_id: "r-1" } });
    const route = idempotentRoute(handler);

    const failed = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    expect(failed.status).toBe(500);

    const retried = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );

    expect(retried.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not cache a non-2xx status returned (rather than thrown) by the handler", async () => {
    const handler = vi.fn(async () => ({ data: null, status: 302 }));
    const route = idempotentRoute(handler);

    await route(makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }));
    await route(makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED with 503 when Redis is unavailable at the gate: the handler must not run", async () => {
    hoisted.setNx.mockRejectedValue(new Error("Upstash Redis request failed (500)"));
    const handler = vi.fn<IdempotentHandler>();
    const route = idempotentRoute(handler);

    const response = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it("still returns the success response when Redis fails AFTER the handler ran (the side effect already happened)", async () => {
    hoisted.set.mockRejectedValue(new Error("Upstash Redis request failed (500)"));
    const handler = vi.fn(async () => ({ data: { receipt_id: "r-1" } }));
    const route = idempotentRoute(handler);

    const response = await route(
      makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }),
    );
    const body = (await response.json()) as { data: { receipt_id: string } };

    expect(response.status).toBe(200);
    expect(body.data.receipt_id).toBe("r-1");
    expect(console.error).toHaveBeenCalled();
  });

  it("exposes the idempotency key to the handler for downstream correlation", async () => {
    let captured: CapturedArgs | undefined;
    const route = defineHandler({
      route: "receipts.create",
      requireSession: true,
      schema,
      idempotent: true,
      handler: async (args) => {
        captured = args;
        return { data: null };
      },
    });

    await route(makeRequest({ body: { amount: 100 }, headers: { "idempotency-key": KEY } }));

    expect(captured?.idempotencyKey).toBe(KEY);
  });
});
