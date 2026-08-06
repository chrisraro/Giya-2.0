# T3.1 report: password recovery

Status: COMPLETE.

## Round 2: review response (read this section first)

The coordinator's review found one Critical (C1) and several Importants
(I2-I6) against the round-1 submission below. All are fixed, TDD red-first
for C1/I4/I5 as required, every new/changed assertion mechanically
mutant-verified (edit source -> run -> watch fail -> revert -> confirm
green). Full suite green (219 files / 4468 tests), `npx eslint .` clean
(one pre-existing unrelated warning, untouched by this task), `npx tsc
--noEmit` back to exactly 3 known errors (none in touched files - fixing
C1/I4 introduced two real type errors of my own along the way, both fixed
properly rather than cast away; see below).

### C1 (Critical) - captchaToken silently dropped

`route.ts`'s `bodySchema` was `z.object({ email })`. Zod strips unknown
keys by default, so the `captchaToken` the client collected, transmitted,
and expected to be verified was discarded before `resetPasswordForEmail`
was ever called - with hCaptcha actually configured in this environment
(confirmed by the coordinator against the ops doc) and GoTrue enforcing
captcha on `/recover`, every submission with captcha enabled would have
been silently rejected by Supabase, swallowed by my own enumeration-safe
catch, and shown the success screen anyway. Zero emails, zero errors,
zero log lines.

Fix: added `captchaToken: z.string().optional()` to the schema and forward
it as `options.captchaToken` in the `resetPasswordForEmail` call. Red
first: `route.test.ts`'s "forwards a submitted captchaToken..." test failed
against the original schema (proving the exact defect) before the fix.
Mutant: re-drop `captchaToken` from the schema -> re-run -> caught by the
same test. `login/page.tsx:96` and `signup/page.tsx`'s two call sites were
the reference for what "forwarded correctly" looks like.

### I6 - the swallow had no server-side log

Added `console.error("[api] auth-forgot-password: resetPasswordForEmail
failed", error)` inside the catch, matching the logging convention already
used for a swallowed/handled failure elsewhere in this pipeline
(`handler.ts`'s unhandled-error log, `rate-limit.ts`'s Redis-failure log).
Client-visible uniformity (the whole point of this feature) and
server-side observability are different concerns; the empty catch
satisfied the first at the cost of making the second impossible, which is
exactly how C1 went unnoticed. Test: mocks `console.error`, rejects
`resetPasswordForEmail`, asserts the call. Mutant: drop the `console.error`
call, keep the empty catch -> caught.

### I3 - rate-limit tests were order-dependent, not content-dependent

`route.test.ts` drove the shared `checkRateLimit` mock with
`mockResolvedValueOnce` chains, implicitly assuming "first call = IP check,
second call = address check." Removing the IP limiter entirely just shifts
which check consumes the first queued answer, so the "429 when IP is over
budget" test could still see a 429 - for the wrong reason. Fixed by keying
the mock on the actual `key` argument (`mockImplementation(({key}) =>
key.includes(":ip:") ? ipAnswer : emailAnswer)`) instead of call order, via
a `mockRateLimit({ip, email})` helper. Mutant: drop the `rateLimit` config
block from `defineHandler` entirely -> reran the full file -> exactly the
three IP-scoped tests failed ("checks the caller's IP...", "answers 429...
IP is over budget", "does not delay a request refused..."), while the
address-scoped tests correctly stayed green (proving the two dimensions
are now genuinely independent in the test, not just in the source).

### I2 - the "byte-identical HTML" page test was vacuous

`page.test.tsx` did `(await screen.findByText("Check your email")).closest
("div")`. `AuthCard` splits into a header `<div>` (title + subtitle - both
hard-coded, identical every render) and a sibling body `<div>` (the actual
email address, which is what varies). `closest("div")` from the `<h1>`
only ever reaches the header, so the assertion compared two things that
were structurally guaranteed to be equal regardless of what the body
contained. Fixed by diffing `render()`'s own `container.innerHTML` in
full. Mutant, reproducing the reviewer's exact counter-example: changed
`setSentTo(email)` to `setSentTo(response?.status === 200 ? email :
\`${email} (not delivered)\`)` -> the new assertion failed with a diff
showing exactly that suffix; confirmed restoring the source makes it pass
again.

### I4 - reset-password accepted ANY session, not a recovery session

`getSession()` being truthy was the entire gate, so any already-signed-in
user (or anyone holding an unlocked device with a stale session) could
reach the new-password form and set a password without presenting the
current one. This also falsified the "no captcha needed" reasoning from
round 1, which assumed reaching the form required a real emailed link.

Fix: the gate is now `getClaims()`'s `amr` (Authentication Methods
Reference) JWT claim - entries are ordered most-recent-first, and GoTrue
stamps `"recovery"` as the method exactly when the session's last
authentication was a recovery flow, regardless of where the code exchange
happened (confirmed via Supabase's own JWT Claims Reference docs, fetched
during this round). `supabase.auth.onAuthStateChange`'s documented
`PASSWORD_RECOVERY` event is kept as a first-class second admission path
(literally what the coordinator asked for) - though I noted in the code
that it may never fire in THIS app's specific architecture, since
`/auth/callback` exchanges the recovery code server-side, and
`PASSWORD_RECOVERY` is normally emitted by client-side code that
processes the recovery URL itself, which this browser client never does.
The `amr` check is what actually makes the gate work regardless; either
signal admits (an "OR", not exclusive) since both are equally
unforgeable evidence of a real recovery flow. `getSession()` is no longer
called at all.

Red first: all 9 tests in the rewritten `page.test.tsx` failed against the
original `getSession()`-based page (the mock surface changed entirely, so
this was a full red, not a targeted one). Mutants, each isolated and
reverted: (1) admit on any truthy claims payload regardless of `amr` ->
caught by the "ordinary signed-in session" test; (2) drop the
`PASSWORD_RECOVERY` event listener's admit call -> caught by the dedicated
event-path test; (3) drop the `subscription.unsubscribe()` cleanup ->
caught by the unmount test.

The no-captcha reasoning from round 1 is correct again now that "ready"
actually requires recovery-specific evidence rather than merely a session,
and I've said so explicitly rather than leaving it as a stale claim.

### I5 - a rejected claims check left a permanently blank screen

There was no `.catch()`, so a rejected `getSession()` (now `getClaims()`)
left `status` at `"checking"` forever, which renders `null`. Fixed: both
the resolve branch's non-recovery case and a new `.catch()` set
`"no-session"` - the same honest, actionable "link expired, request a new
one" state a genuinely absent session gets, since a failed check and a
genuinely absent recovery session are indistinguishable from the user's
perspective and both need the same recovery action. Mutant: delete the
`.catch()` -> the I5 test reproduced the stuck screen as an unhandled
promise rejection that never advances past `"checking"` -> caught (the
test failure IS the bug, surfaced directly rather than needing a status
assertion).

### Two type errors introduced while fixing the above, fixed properly

Fixing I4 required reading the JWT's `amr` claim, whose real type (checked
against `@supabase/auth-js`'s actual `.d.ts`, not assumed) is `AMREntry[]
| string[]` - a union of two array shapes, not an array of a union - so
`amr[0]?.method` does not type-check. Added a small `mostRecentAuthMethod`
helper that normalizes either shape (GoTrue's default detailed
`{method, timestamp}` form, or the plainer RFC-8176 string form a custom
access token hook could emit instead) down to the one string being
compared. Fixing I3's clamp test hit an unrelated `Array.prototype.find`
overload resolution issue from destructuring the predicate parameter
inline; resolved by typing `mock.calls` once and destructuring inside the
callback instead. `npx tsc --noEmit` is back to exactly the pre-existing 3
errors, none of them mine.

### Minors

- **Header comparison added to the enumeration test.** `errorJson.data`
  equality alone would miss a leak carried in a header instead of the
  body. Added a header-set comparison (excluding `X-Request-Id`, which is
  a fresh random correlation id by design and is SUPPOSED to differ every
  call). Mutant: added a hypothetical `X-Debug-Existed: true/false` header
  driven off whether `resetPasswordForEmail` returned an error -> caught.
- **Caller-controlled address clamped before entering the Redis key**,
  matching `handler.ts`'s own `RATE_LIMIT_KEY_MAX_LENGTH` (128) convention
  for exactly this reason. Zod already caps the email at 320 chars, so
  this is defense-in-depth rather than closing a live hole, but it matches
  the established pattern rather than leaving this one caller-controlled
  key un-clamped. Tested with a 306-char address; red before the fix,
  green after.
- **Dropped the dead `next/navigation`/`useRouter` mock scaffolding** from
  `forgot-password/page.test.tsx` - leftover from copy-pasting login/signup's
  test structure; that page never calls `useRouter` or `router.push`.

### Recorded, not fixed (per the coordinator's explicit instruction)

- **The 800ms timing floor is still unmeasured**, and the coordinator's
  specific risk is worth restating precisely: GoTrue's known-address path
  does a synchronous SMTP handoff that can routinely exceed 800ms, and if
  the real p99 for this project is above the floor, the timing channel
  this feature exists to close is still open for that slower tail. What
  would turn 800ms from a guess into a number: measure `resetPasswordForEmail`'s
  actual round trip against the live project for a known account vs. a
  throwaway unregistered one, and set the floor to comfortably exceed the
  **p99** of the slower (known-address) case specifically, not the mean -
  the floor has to survive the tail. I have no live project reachable from
  this sandbox to run that measurement.
- **Moving the Supabase call server-side breaks cross-device password
  recovery by construction.** The PKCE code verifier is written to cookies
  during the `POST /api/v1/auth/forgot-password` request itself (per
  Supabase's own PKCE flow docs: "the code exchange must be initiated on
  the same browser and device where the flow was started"), so a user who
  submits the form on a desktop and opens the emailed link on their phone
  will hit a failed code exchange at `/auth/callback` (falling through to
  the existing, honest `/login?error=confirm` path - not a crash, but also
  not a working reset). This is the same trade-off round 1's own copy
  already, if implicitly, worked around: `forgot-password`'s confirmation
  screen already reads "Open the link on this device to choose a new
  password" - stated here explicitly as the deliberate mitigation it is,
  per the coordinator's ask, rather than left as copy nobody connected to
  the underlying constraint.

---

## Round 1 (original submission, preserved below for context)

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
