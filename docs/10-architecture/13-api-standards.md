# 13 — API Standards

Applies to all Route Handlers under `/api/v1/*`. Server Actions follow the same validation, authz, and error-shape rules minus the HTTP envelope. Shared implementation lives in `src/lib/api/` — handlers never hand-roll envelopes, pagination, or errors.

## Versioning

- Path-versioned: `/api/v1/...`. `v2` is created only for breaking changes; `v1` then gets a deprecation window ≥ 6 months with `Deprecation` + `Sunset` headers.
- Additive changes (new fields, new endpoints) are not breaking. Clients must ignore unknown fields.

## Resource conventions

- Plural kebab-case nouns: `/api/v1/businesses/{businessId}/receipt-templates/{id}`.
- Tenant-scoped resources nest one level under `/businesses/{businessId}/…`; consumer-scoped resources root at `/me/…` (e.g. `/api/v1/me/points`, `/me/rewards`); admin surface under `/api/v1/admin/…`.
- Actions that aren't CRUD use verb sub-resources sparingly: `POST /campaigns/{id}/activate`, `POST /redemptions/validate`.
- IDs are UUIDs in paths; never sequential integers.

## Response envelope

Success:
```jsonc
{
  "data": { /* resource or array */ },
  "meta": {                       // present when relevant
    "page": { "next_cursor": "…", "has_more": true, "limit": 25 },
    "request_id": "req_01J…"
  }
}
```

Error:
```jsonc
{
  "error": {
    "code": "RECEIPT_DUPLICATE",        // stable, SCREAMING_SNAKE, from the registry below
    "message": "This receipt has already been submitted.",  // safe for end users (localizable key client-side)
    "details": [ { "field": "receipt_number", "issue": "duplicate" } ],  // optional, for 422s
    "request_id": "req_01J…"
  }
}
```

Rules: never leak stack traces, SQL, or internal identifiers in `message`; `request_id` present on every response (also as `X-Request-Id` header) and logged in Sentry/OTel for correlation.

## Error code registry (extend, never repurpose)

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed input (non-validation) |
| 401 | `UNAUTHENTICATED` | Missing/invalid session |
| 403 | `FORBIDDEN` | Authenticated but not permitted (role/tenant) |
| 404 | `NOT_FOUND` | Resource absent **or** outside caller's tenant (never distinguish) |
| 409 | `CONFLICT` | State conflict (e.g. `CAMPAIGN_INVALID_STATE`, `REWARD_OUT_OF_STOCK`) |
| 409 | `IDEMPOTENCY_REPLAYED` | Key reused with different payload |
| 422 | `VALIDATION_FAILED` | Zod validation errors, itemized in `details` |
| 422 | domain codes | `RECEIPT_DUPLICATE`, `RECEIPT_UNREADABLE`, `POINTS_INSUFFICIENT`, `REWARD_EXPIRED`, `REDEMPTION_TOKEN_INVALID`, `BUSINESS_NOT_VERIFIED`, … (each module doc registers its codes) |
| 429 | `RATE_LIMITED` | Includes `Retry-After` |
| 500 | `INTERNAL` | Generic; details only in Sentry |
| 503 | `DEPENDENCY_UNAVAILABLE` | OCR/AI/queue outage; client may retry |

## Pagination — cursor-based only

- Request: `?limit=25&cursor=…` (limit clamp 1–100, default 25).
- Cursor is an opaque base64 of `(sort_key, id)` — internally keyset pagination (`where (sort_key, id) < ($1,$2) order by sort_key desc, id desc`). Never offset pagination (breaks at scale, leaks churn).
- Response `meta.page` as in the envelope. Cursors are stable across inserts and expire only if sort schema changes (then clients restart from head).
- Default sort: `created_at desc, id desc` unless the endpoint documents otherwise.

## Validation & serialization

- Every handler: parse params/query/body with Zod schemas from the feature's `schemas.ts` **before** any logic; failure → 422 `VALIDATION_FAILED`.
- Response DTOs are also Zod-typed and explicitly mapped from DB rows — never `select *` straight to JSON. Column additions must be consciously exposed.
- Timestamps ISO-8601 UTC (`2026-07-24T03:15:00Z`); money as integer centavos + `currency` (`PHP`); points as integers; snake_case JSON keys.

## Idempotency

- All unsafe POSTs that create side effects (receipt submission, redemption validate, campaign activation, manual points adjustments, sends) accept `Idempotency-Key` header (UUID).
- Implementation: Redis `SET key NX EX 86400` storing request-hash + response; replay with same hash returns stored response with `Idempotent-Replayed: true`; different hash → 409 `IDEMPOTENCY_REPLAYED`.
- Receipt submission additionally has domain-level dedup (image hash) independent of the header (`37-fraud-detection.md`).
- Workers are idempotent by job-id check regardless (`39-background-jobs.md`).

## Rate limiting

Upstash Ratelimit (sliding window), enforced in middleware (coarse, per-IP) and per-route (fine, per-user). Baselines (tunable via config, not code):

| Surface | Limit |
|---|---|
| Auth endpoints (login/register/forgot) | 10/min per IP + per identifier |
| Receipt submission | 6/min, 60/day per consumer |
| AI chat | 10/min, 100/day per consumer; per-business daily cap |
| Uploads | 20/min per user |
| General authenticated API | 120/min per user |
| Admin API | 300/min per admin |

429 responses include `Retry-After`. Limits are also entitlement hooks for plan tiers `[SCALE]`.

## Caching

- `GET` public content (business pages, menus, promotions): `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` + Redis application cache where computed.
- Authenticated `GET`: `private, no-store` by default; opt-in caching per endpoint with user-scoped keys.
- Cache invalidation is event-driven: mutations publish `revalidateTag(tag)` (Next) + delete Redis keys; tags follow `biz:{id}:menu`-style registry in `src/lib/cache-tags.ts`.

## Authn/Authz in handlers (order is mandatory)

```
1. requireSession()                 → 401
2. requireRole(scope)               → 403 (tenant/role via claims, per matrix 00-product/01)
3. rateLimit(route policy)          → 429
4. zod parse                        → 422
5. idempotency gate (if unsafe)     → replay/409
6. service call (business logic)    → domain errors
7. envelope response
```

Handlers are thin: steps 1–5 come from `src/lib/api/handler.ts` composition (`createHandler({auth, role, limit, schema}, fn)`), so a new endpoint is ~20 lines.

## OpenAPI

`src/lib/api/openapi.ts` generates an OpenAPI 3.1 doc from the Zod schemas (zod-openapi) in CI; published to the repo at `docs/api/openapi.json`. Drift between code and spec is impossible by construction; the spec is the contract for any future mobile client.
