# Task 3 report: Upstash Redis client + single-use redemption tokens

Status: COMPLETE. Branch `feat/rewards-redemption`.

## Files
- `src/lib/env.ts` (+ `env.test.ts`) - added a server-only env accessor alongside the existing eager client `env` export.
- `src/lib/redis.ts` (+ `redis.test.ts`) - tiny fetch-based Upstash REST client.
- `src/features/rewards/server/token.ts` (+ `token.test.ts`) - single-use redemption token mint/consume.
- `.env.local` - added `REDEMPTION_TOKEN_SECRET` (locally generated, base64url, 32 random bytes).

## The env split approach

`src/lib/env.ts` keeps its existing eager `envSchema`/`loadEnv()`/`export const env` exactly as before - unchanged behavior, unchanged export, still safe to import from client code (`src/lib/supabase/client.ts` and any Client Component). Nothing about the existing surface changed.

Alongside it, a second, independent schema (`serverEnvSchema`) covers `UPSTASH_REDIS_REST_URL` (`z.string().url()`), `UPSTASH_REDIS_REST_TOKEN` (`z.string().min(20)`), and `REDEMPTION_TOKEN_SECRET` (`z.string().min(32)`). This schema is never parsed at module scope. `getServerEnv()` parses `process.env` lazily on its first call, memoizes the result in a module-level `cachedServerEnv` variable, and returns the cached object on every subsequent call (verified by a test that mutates `process.env` between two calls and asserts the second call still returns the first call's object, unaffected). On validation failure it throws `Invalid or missing server environment variables: <comma-separated keys>. Check .env.local.` so a misconfigured deploy fails fast with a readable message instead of a cryptic downstream error.

Because `getServerEnv()` is a function that only touches `process.env` when *called*, importing `src/lib/env.ts` from a server-only file never evaluates the server schema unless that code path actually runs `getServerEnv()`. Since nothing in the client tree calls it, `next build` never inlines or bundles the three server secrets into client JS. Verified: `npm run build` succeeds, and a search of `src` shows the only importers of `getServerEnv` today are `src/lib/redis.ts` and `src/features/rewards/server/token.ts`, neither of which is (yet) reachable from any Client Component - this task only builds the primitives, wiring into routes/actions is later work.

## Redis client (`src/lib/redis.ts`)

Fetch-based, no SDK dependency. A single internal `sendCommand(command: readonly string[])` POSTs the JSON command array to `getServerEnv().UPSTASH_REDIS_REST_URL` with `Authorization: Bearer <UPSTASH_REDIS_REST_TOKEN>`, and unwraps `{ result }` from the JSON response.

Exact command payloads sent (asserted in tests against a mocked `fetch`):
- `setNx(key, value, ttlSeconds)` -> `["SET", key, value, "NX", "EX", String(ttlSeconds)]`. Returns `true` iff `result === "OK"`, `false` when `result === null` (key already existed - the caller lost the race).
- `getDel(key)` -> `["GETDEL", key]`. Single command, single `fetch` call (asserted with `toHaveBeenCalledTimes(1)`) - never a separate GET followed by a separate DEL, which is exactly the race a two-step read/delete would open between two concurrent scans of the same token.

`redisKey(...parts)` returns `` `${process.env.NODE_ENV}:${parts.join(":")}` ``, so dev/test/production traffic can never collide in the same Upstash database. Tokens use `redisKey("redeem", "jti", jti)`.

Fail-closed: any non-200 response from Upstash throws (`Upstash Redis request failed (<status>): <body>`) rather than returning `null`/`false`. This matters specifically for `getDel`: if Redis is down and the client silently returned `null` on error, `consumeRedemptionToken` would read that as "already consumed" and reject a legitimate redemption - annoying but safe. The actual danger is the opposite failure mode this code refuses to have: it never returns a *value* on error, so an outage can never be misread as "token still valid, here is the claimId" and permit a replay.

## Token module (`src/features/rewards/server/token.ts`)

`import "server-only"` at the top. Uses `jose` (added as a dependency, `npm i jose`, version `6.2.4`) for HS256 sign/verify - tiny, standard, edge-safe.

Payload shape signed into the JWT: `{ claimId: string, businessId: string, jti: string }`, plus jose's standard `iat`/`exp` claims (300s TTL from mint time). `consumeRedemptionToken` narrows jose's verified payload down to exactly `{ claimId, businessId, jti }` before returning it - `iat`/`exp` are not part of this module's return contract.

`mintRedemptionToken(claimId, businessId)`:
1. `jti = crypto.randomUUID()`.
2. Signs `{claimId, businessId, jti}` HS256 with `getServerEnv().REDEMPTION_TOKEN_SECRET`, `iat` = now, `exp` = now + 300s.
3. `setNx(redisKey("redeem", "jti", jti), claimId, 300)`. If this returns `false` (jti collision - astronomically unlikely for a `randomUUID()`), throws `RedemptionTokenError`.
4. Returns `{ token, expiresAt: <ISO string>, jti }`.

`consumeRedemptionToken(token)`:
1. `jwtVerify(token, secretKey, { algorithms: ["HS256"] })`. Any failure here - bad signature, malformed token, expired `exp`, wrong algorithm, missing claims - is caught and collapsed to the same `RedemptionTokenError` with `code: "REDEMPTION_TOKEN_INVALID"`, so callers cannot distinguish "expired" from "tampered" from a message or timing side channel.
2. `getDel(redisKey("redeem", "jti", jti))`. If `null` (key never existed, expired out of Redis, or - the important case - already consumed by a prior call), throws the same error. If the stored value does not equal the token's `claimId`, also throws (defense in depth; should never happen for a token this module minted itself).
3. Returns `{ claimId, businessId, jti }`.

`RedemptionTokenError extends Error`, carries `readonly code: "REDEMPTION_TOKEN_INVALID"`.

This module deliberately does not check claim ownership or status - that is the route/RPC's job, kept out of scope here per the brief.

## Single-use guarantee

Enforced entirely by `GETDEL`'s atomicity, not by the JWT. A JWT signature only proves the token was minted by this server and has not been tampered with; a valid signature is otherwise replayable forever since it is just data. The single-use property comes from the Redis side: `mintRedemptionToken` writes the `jti -> claimId` mapping with `SET NX EX 300` (created once, TTL 300s), and `consumeRedemptionToken` reads and deletes it in one atomic `GETDEL` round trip. Two concurrent redemption attempts for the same token both call `GETDEL` against the same key; Redis serializes the two commands, so exactly one gets the value back and the other gets `null` and is rejected as `REDEMPTION_TOKEN_INVALID`. A non-atomic GET-then-DEL would let both concurrent requests observe the value before either deletes it, defeating the whole point. Combined with fail-closed error handling in `redis.ts` (a Redis outage throws rather than returning a value), the token can never be double-spent and an outage can never be silently treated as a valid, unconsumed token.

## Tests

22 new tests, full suite 420 passed (0 failed), up from the 398-test baseline:
- `env.test.ts`: 6 new (`getServerEnv`) - not evaluated at module scope, throws listing all three missing keys, throws on short token, throws on short secret, parses valid input, memoizes across calls even after `process.env` changes.
- `redis.test.ts`: 8 new - `redisKey` namespacing; `setNx` sends the exact `["SET",...]` payload and returns true/false; `getDel` sends the exact `["GETDEL",...]` payload, returns the value then null, issues exactly one `fetch` call; both throw on a mocked 500 response.
- `token.test.ts`: 8 new - mint returns a token whose `jwtVerify`-decoded payload has `claimId`/`businessId`/matching `jti` and `exp` in `[now+300, now+300]` (checked as a bracketed range around the call); mint calls `setNx` with the right key/value/TTL; mint throws on `setNx` collision; consume succeeds and returns `{claimId, businessId, jti}`; **consume throws `REDEMPTION_TOKEN_INVALID` on replay** (mint once, consume once with `getDel` mocked to return the claimId, then consume the same token again with `getDel` mocked to return `null` - the most important test in this module); tampered signature rejected (`getDel` never called); expired token rejected via a token hand-signed with a past `exp` (`getDel` never called); mismatched stored claimId rejected.
- Note: `token.test.ts` runs under `// @vitest-environment node` instead of the project default `jsdom`. jose's internal type guards do `instanceof Uint8Array` checks; jsdom runs in a separate VM realm whose `Uint8Array` fails that check against objects built in the outer Node realm, which made every `sign()`/`verify()` call throw `TypeError: payload must be an instance of Uint8Array` under the default environment. Since this module is server-only with no DOM dependency, switching just this test file to the `node` environment was the correct fix rather than working around jose's guards.

## Gates
- `npm test`: 33 files, 420 passed, 0 failed (was 31 files / 398 passed before this task).
- `npm run lint`: clean.
- `npm run build`: compiled and TypeScript-checked clean (strict, `exactOptionalPropertyTypes`, no `any`). No route/action currently imports the new server-only modules, so there is nothing yet for them to leak into a client bundle; verified via `grep` that `getServerEnv`/`@/lib/redis`/`token.ts` are only referenced by each other and their own tests.
- Zero em-dashes in all six new/touched files (verified by grep).
