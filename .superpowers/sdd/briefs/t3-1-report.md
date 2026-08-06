# T3.1 report: password recovery

Status: COMPLETE.

## Brief

Found (after an initial miss on my part - see below) at
`C:\Users\raroc\OneDrive\Desktop\OCS\Giya 2.0\.superpowers\sdd\briefs\t3-1-brief.md`,
the main checkout's copy, not this worktree's. `.superpowers/` is gitignored
project-wide, so it is never checked out into any worktree at all; the
relative path I was first given resolved to nothing inside my isolated
worktree, and I did not think to look one level up at the shared checkout
before proceeding on the task description alone. Corrected mid-task per the
coordinator; this report and everything below it (specifically the rate
limiting section) reflects the real brief, read in full.

## Commits (in this worktree, not pushed)

1. `43dab78` fix(auth): point the login page's Forgot password link at the recovery flow
2. `9309f27` feat(auth): add a timing-normalizing wrapper for enumeration-sensitive calls
3. `67e17af` feat(auth): add the forgot-password page (later revised - see below)
4. `5c9e03b` feat(auth): add the reset-password page
5. `17acc84` docs(product): T3.1 password recovery report (the pre-brief version; superseded by this one)
6. *(pending)* feat(auth): rate-limit forgot-password and move the Supabase call server-side

Worktree: `C:\Users\raroc\OneDrive\Desktop\OCS\Giya 2.0\.claude\worktrees\agent-a83ed56a39ac1fab0`

## What changed after reading the real brief

The brief's requirement 4 - rate limiting via `src/lib/rate-limit.ts`/`defineHandler` - could not be satisfied by my first pass's design: `forgot-password/page.tsx` called `supabase.auth.resetPasswordForEmail` directly from the browser, and a direct browser-to-Supabase call can never be gated by this repo's own limiter, which only wraps Route Handlers. So this revision moves that call server-side:

- **New: `src/app/api/v1/auth/forgot-password/route.ts`** (+ `route.test.ts`, 11 tests) - a `defineHandler`-built POST route. This is now the only thing that calls `supabase.auth.resetPasswordForEmail`. It owns: body validation (zod), both rate-limit checks, the enumeration-neutral try/catch, and the `withMinDelay` timing floor (moved here from the page, since this is where the actual variable-latency call now happens).
- **Rewritten: `src/app/(auth)/forgot-password/page.tsx`** (+ `page.test.tsx`) - no longer imports `@/lib/supabase/client` or `@/lib/auth/timing` at all. It now `fetch()`s the route above and treats every response identically (confirmation screen) with exactly one exception: a `429` from the route, which gets a distinct "Too many requests" message and keeps the user on the form. This is not a new enumeration channel - the reasoning is below.
- **Unchanged from the first pass**: `reset-password/page.tsx`, `src/lib/auth/timing.ts` (now consumed by the route instead of the page - same module, same tests, new caller), the login page fix, `/auth/callback`.

## Rate limiting: the key I chose, and why it's two keys, not one

**Two independent budgets, both enforced, request refused if either is exhausted:**

- **Per-IP**: 10 requests / 10 minutes (`keyBy: "ip"`, wired through `defineHandler`'s own `rateLimit` config - this is the one that can use the built-in slot, since IP is known before the body is parsed).
- **Per-address**: 3 requests / 15 minutes, checked manually inside the handler via a direct `checkRateLimit()` call, keyed on the trimmed+lowercased email. This canNOT go through `defineHandler`'s built-in `rateLimit` config: doc 13's pipeline runs rate limiting (step 5) *before* body parsing (step 6), and the address only exists in the body. That ordering is why this is a second, separate call rather than one composite `(ip, email)` key.

The coordinator's framing is exactly right and is why one key is not enough:
- **Per-IP alone** would never stop an attacker who simply rotates IPs (VPN/proxy/botnet) - each new IP gets a fresh budget while the same victim's inbox keeps absorbing hits.
- **Per-address alone** would never stop the opposite attack: one source spraying recovery email at many *different* addresses (an enumeration sweep, or the "email-amplification vector against arbitrary third parties" the brief names) - no single address ever gets hit enough times to trip its own limit.

So both run, and either can refuse the request. Per-IP is set generous (10/10min) specifically so a shared NAT (office, campus, household) is never realistically the one that trips it - that's the trade-off the coordinator flagged, and I resolved it by making the IP budget deliberately loose and leaning on the address budget (which has no such shared-caller problem) to do the tighter work of protecting a specific inbox.

**A `429` is not an enumeration leak.** Both budgets are keyed on the caller (IP) or the raw submitted address, checked *before* Supabase is ever asked whether that address has an account - a known and an unknown address hit the identical limiter, the identical way. So `forgot-password/page.tsx` is allowed to show a `429` differently from everything else without reopening the hole this whole feature exists to close; every other outcome (200, any other status, or the fetch throwing outright) still collapses to the one confirmation screen, exactly as before.

**What "refuses at the threshold" is proven by, and by whom.** My new route tests mock `checkRateLimit` (matching the existing pattern in `src/app/api/v1/health/route.test.ts`) and prove *wiring*: the route asks the limiter with the right key/limit/window for both dimensions, and honors a `{ok: false}` answer by refusing before calling Supabase. The actual threshold arithmetic (count <= limit passes, count > limit refuses) is proven once, already, generically, in `src/lib/rate-limit.test.ts` ("allows requests up to the limit" / "blocks once the count exceeds the limit") - pre-existing, untouched by this task. I did not duplicate that proof; I proved the part that's actually new here, which is the two-independent-budgets composition.

## Enumeration resistance (updated for the new architecture)

**Body.** The route's handler never branches on Supabase's `{error}` field, and wraps the call in `try { } catch { /* swallowed */ }` so a rejected promise takes the identical path to the identical response - this needed its own try/catch rather than relying on `defineHandler`'s generic-500 fallback, because that fallback still answers with a *different status* (500 vs 200), which is itself a signal. Proven mechanically: `route.test.ts`'s "returns a byte-identical body whether Supabase answers with success or an error" test calls the route twice (mocked success, then mocked `AuthError`) and asserts `errorJson.data` deep-equals `successJson.data`, plus that the raw Supabase message never appears anywhere in the serialized response. A second test proves the same for an outright rejection.

The page, one layer up, no longer even sees Supabase's answer - it only sees the route's response, which is already uniform. Its own test proves the same shape at that layer: rendering the page against a `200` and against a `500` from the route produces byte-identical confirmation-screen HTML (`page.test.tsx`, "shows the same confirmation for a plain success and for an unexpected non-429 status").

**Timing.** Unchanged mechanism, moved location: `withMinDelay` (`src/lib/auth/timing.ts`, its own 3 tests, all still passing, untouched) now wraps the call inside the route rather than inside the page, applied *after* both rate-limit checks succeed - deliberately not applied to the 429 path, since a refusal for being over budget has nothing to do with whether the address exists, so there's no enumeration reason to slow it down (and a real reason not to: it would only make a legitimate caller's rate-limit message feel worse). `route.test.ts` proves both halves with fake timers: the happy path is held back to the 800ms floor even when the mocked Supabase call resolves instantly, and the rate-limited path resolves immediately, unpadded.

This remains a best-effort mitigation, not a proof of zero timing leakage - it normalizes the one thing this app controls (how long the *server* waits before answering), not network jitter between browser and this app's own server, or Supabase's infrastructure-level timing beyond the single request/response this code sees.

**800ms is a considered guess, not a measurement**, exactly as flagged: I have no live Supabase project reachable from this sandbox to measure the real gap between GoTrue's "address not found, short-circuit" path and its "mint a token, hand off to the mail provider" path. What would turn this from a guess into a number: run both cases against the actual project (a known test account vs. a throwaway unregistered address), time `resetPasswordForEmail`'s round trip for each over a representative sample, and set the floor to comfortably exceed the **p99** of the slower (known-address) case - p99 rather than p50 or a mean, because the floor has to survive the tail, not the typical case, or an unlucky slow response on the known-address path would still poke above the floor and become visible. I did not have the access to run that measurement here.

## `reset-password` has no captcha - deliberate, not an oversight

Restated as the coordinator asked: reaching `reset-password`'s form at all requires a valid session, which only exists after clicking a real, emailed recovery link (`/auth/callback` exchanges the link's code for that session before ever redirecting here - see `src/app/auth/callback/route.ts`, unmodified). That is a strictly stronger gate against automated abuse than a captcha widget would add on top, so this page intentionally has none, unlike `forgot-password` (public, unauthenticated, bot-reachable, and now also rate-limited) and login/signup (which both gate on `CAPTCHA_ENABLED`).

## Tests: 33 new across this task, every assertion's mutant run mechanically

Baseline before this task: 215 files / 4433 tests, all green. Final: **219 files / 4460 tests, all green** (`npx vitest run`, full suite, ~116s). `npx eslint .`: clean except one pre-existing, unrelated warning in `src/features/campaigns/server/exhaustion.test.ts` (not touched by this task). `npx tsc --noEmit`: **exactly 3 known errors** (in `scripts/generate-md3-tokens.test.ts` x2 and `src/features/rewards/server/token.test.ts` x1) - none in any file this task touched, matching the brief's stated baseline exactly. `npm run build`'s TypeScript pass compiles clean; the later "collect page data" step fails on a pre-existing condition unrelated to this work - this worktree has no `.env.local`, so `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are unset at that step, and the failing page (`/api/v1/businesses/[businessId]/integrations/meta/callback`) is nothing this task touched.

Every mutant below was actually applied to the real source file, run against the real test file, watched fail, then reverted and re-verified green - not inferred.

**`src/lib/auth/timing.ts` / `timing.test.ts`** (unchanged from the first pass, now consumed by the route instead of the page)
- Fast-resolving op padded to `minMs`. Mutant: delay removed entirely (no-op passthrough) → failed as expected.
- Op slower than `minMs` gets zero extra wait. Mutant: always wait the full `minMs` regardless of elapsed → failed as expected.
- Fast-rejecting op still padded, original error rethrown unchanged. Mutant: swallow the rejection, return `undefined` → failed as expected.

**`src/app/api/v1/auth/forgot-password/route.test.ts`** (new)
- Valid submit calls `resetPasswordForEmail` with the normalized address + `redirectTo`, returns 200 with a generic message.
- Byte-identical body for a Supabase success vs. a Supabase error, raw error text never present (the core enumeration assertion). Mutant: destructure `{error}` and return `error.message` on the error branch → caught by this test AND by the rejection test below (the mutant also removed the try/catch that both depend on).
- 200 with the generic body even when `resetPasswordForEmail` rejects outright. Same mutant as above caught this independently.
- 422 on a malformed email, `resetPasswordForEmail` never called. Mutant: drop the format `.regex()` from the zod schema → failed as expected.
- IP budget: `checkRateLimit` called with `{key: ".../ip:...", limit: 10, windowSeconds: 600}`; 429 without calling Supabase when over budget. Mutant: drop the `rateLimit` config from `defineHandler` entirely → caught by both tests in this group (and incidentally shifted which call the "address over budget" test's mock intercepted, which is itself evidence the two checks are genuinely sequential and independent).
- Address budget: `checkRateLimit` called with `{key: "...victim@b.com...", limit: 3, windowSeconds: 900}`, independent of the IP check; 429 without calling Supabase when the address alone is over budget, even with a fresh IP; address is normalized (trim+lowercase) before keying so `"  Victim@B.com  "` and `"victim@b.com"` share a budget. Mutant: drop the manual `checkRateLimit()` call for the address entirely → caught by all three tests in this group.
- Timing: response held back to 800ms floor even when Supabase answers instantly; NOT held back when refused by the rate limiter. Mutant: bypass `withMinDelay`, call `resetPasswordForEmail` directly → caught by the floor test.

**`src/app/(auth)/forgot-password/page.test.tsx`** (rewritten for the new fetch-based design)
- Empty submit → validation error, `fetch` never called.
- Valid submit POSTs `{email}` (JSON) to `/api/v1/auth/forgot-password`, shows the confirmation.
- Byte-identical confirmation HTML for a `200` and for an unexpected `500` from the route, so nothing about the route's answer leaks through the page either. Mutant: add a `response.ok` branch that shows a different error message on any non-2xx, non-429 status → caught by this test.
- Same confirmation when `fetch` itself throws (network failure), error text never rendered.
- `429` specifically shows a distinct "Too many requests" message and stays on the form. Mutant: drop the `response?.status === 429` branch entirely → caught by this test.
- Captcha: blocks submit until verified, then POSTs `{email, captchaToken}`, resets the widget. Mutant: drop `captchaToken` from the request body → caught by this test.

**`src/app/(auth)/reset-password/page.test.tsx`** (unchanged from the first pass - not in scope for rate limiting, since it requires an existing session and sends no email)
- No session → expired-link message + link to `/forgot-password`, no form rendered. Mutant: skip the session check, always set status to ready → failed as expected.
- Session present → renders the new-password form.
- Empty submit → validation error, `updateUser` never called.
- Successful submit calls `updateUser({password})`, then `signOut()`, then shows "Password updated" with a link to `/login`. Mutant: drop the `signOut()` call → failed as expected.
- `updateUser` error shown inline, `signOut` NOT called, form stays mounted (this is intentionally the one place in the whole feature that surfaces a raw Supabase message - the caller already holds a valid session, so it's ordinary password-policy UX, not an enumeration leak). Mutant: drop the `if (error)` branch, always proceed to signOut/done → failed as expected.

**`src/components/auth/auth.test.tsx`**
- "Forgot password" link's `href` is `/forgot-password`, not `#`. Mutant is the original bug itself: red against the real pre-fix `href="#"`, green after the one-line fix.

Not mutation-tested: pure rendering assertions ("renders an email field and a send-link CTA", "renders the new-password form") - no interesting mutant beyond "delete the JSX," which every other test in the same file already catches.

## Design-system compliance

All three surfaces (the two pages, unchanged in this regard, plus the new route which has no UI) reuse existing components only (`AuthCard`, `TextField`, `PasswordField`, `Captcha`, `Button` with `size="touch"` = 48px), so MD3 tokens, 48px touch targets, and the reduced-motion structural rule are inherited for free - no new CSS or `animation:` declaration anywhere. Verified with `grep` that none of the new/touched files contain `animation:` or an em dash.

## Concerns

1. **800ms timing floor is a considered guess, not a measurement** - see above for exactly what would turn it into one (a live p99 against the real project).
2. **`reset-password` has no captcha** - deliberate, reasoned above; flag if the brief's author wanted one anyway despite the session-gate argument.
3. **Rate-limit thresholds (10/10min per IP, 3/15min per address) are my own judgment call**, not derived from any documented traffic baseline for this route (it's brand new, so there is none yet). If real usage shows either threshold wrong in either direction, they're two constants in one file to retune.
4. Resend/email-template note from the brief: confirmed by inspection - `resetPasswordForEmail` goes through `supabase.auth`, not through this repo's Resend registry (`src/lib/emails/**` was not touched, no new template added).
5. I did not verify against a live Supabase project that `resetPasswordForEmail`'s `redirectTo` + PKCE `code` round-trips correctly through `/auth/callback` end-to-end in production, since this worktree has no reachable project; I'm relying on the same mechanism this app's existing signup-confirmation and OAuth flows already use unmodified, which is documented in `src/app/auth/callback/route.ts`'s own comments as generic over the caller.
