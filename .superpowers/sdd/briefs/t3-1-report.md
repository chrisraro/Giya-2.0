# T3.1 report: password recovery

Status: COMPLETE.

## Brief file not found

`.superpowers/sdd/briefs/t3-1-brief.md` does not exist in this worktree (nor
does a `briefs/` directory - only `.superpowers/sdd/task-3-report.md`, an
unrelated prior task's report, existed at start). I searched the whole
worktree and the repo's git history across all branches for any file named
`*brief*` or `t3-1*` and found nothing; `.superpowers/` is gitignored, so if
the brief was ever written to disk it was never committed and is not
recoverable from here. I proceeded from the task description and "context
the brief cannot know" given directly in my instructions, plus this repo's
existing login/signup idioms, and note this gap explicitly rather than
silently guessing at requirements I could not read.

## Commits (in this worktree, not pushed)

1. `43dab78` fix(auth): point the login page's Forgot password link at the recovery flow
2. `9309f27` feat(auth): add a timing-normalizing wrapper for enumeration-sensitive calls
3. `67e17af` feat(auth): add the forgot-password page
4. `5c9e03b` feat(auth): add the reset-password page

Worktree: `C:\Users\raroc\OneDrive\Desktop\OCS\Giya 2.0\.claude\worktrees\agent-a83ed56a39ac1fab0`

## What was built

- `src/app/(auth)/login/page.tsx` - one-line fix: `href="#"` -> `href="/forgot-password"`.
- `src/lib/auth/timing.ts` (+ `timing.test.ts`) - `withMinDelay(operation, minMs)`, a generic wrapper that makes an async call settle no sooner than `minMs` after it started, whether it resolves or rejects.
- `src/app/(auth)/forgot-password/page.tsx` (+ `page.test.tsx`) - email-only form. Calls `supabase.auth.resetPasswordForEmail`, wrapped in `withMinDelay(..., 800)`, and always ends on the same "Check your email" confirmation regardless of outcome.
- `src/app/(auth)/reset-password/page.tsx` (+ `page.test.tsx`) - the landing page after the emailed link. Checks for a session on mount (none -> expired-link message + link to `/forgot-password`; present -> new-password form). On success, signs out the recovery session and shows a confirmation with a link to `/login`.
- `src/app/auth/callback/route.ts` - **not modified**. It already does a generic `exchangeCodeForSession(code)` + redirect-to-`next` for signup confirmation and OAuth; `resetPasswordForEmail`'s `redirectTo` points at this same route with `?next=/reset-password`, and it works unchanged. An expired/already-used recovery link fails the exchange and falls through to the route's existing `/login?error=confirm` branch, which is why "Forgot password" being wired up matters: that's the recovery path the login page's existing notice ("...Sign in or request a new one.") points a user back toward.

Nothing in `supabase/**` was touched, and none of the other excluded paths (`src/lib/ai`, `src/lib/queue`, `src/features/admin`, `src/features/rewards`, `src/lib/auth/suspension.ts`) were touched.

## Enumeration resistance: how I actually established it, not asserted it

**Body.** `forgot-password/page.tsx`'s submit handler never inspects the `error` field `resetPasswordForEmail` returns, and the `try { ... } catch { /* swallowed */ }` around the call means even an outright rejected promise (network failure) takes the exact same code path to the same `sentTo` state. There is no branch anywhere in the file that a known-vs-unknown response could steer differently - I verified this isn't true "by construction" hand-waving with a mechanical test: `page.test.tsx`'s "shows the exact same confirmation when Supabase answers with an error..." test renders the page twice (once with a resolved-no-error mock, once with a resolved-with-`AuthError`-message mock) and diffs the **entire rendered HTML** of the confirmation card (`.closest("div")?.innerHTML`) between the two runs, asserting byte-for-byte equality, plus a separate assertion that the raw Supabase error text never appears anywhere in the DOM. A second test does the same for an outright-rejected promise.

**Timing.** `withMinDelay` pads the `resetPasswordForEmail` round trip to a floor of 800ms measured from when the call started, using `Date.now()` and a `finally` block so the floor applies identically whether the operation resolves or rejects. This is the concrete answer to "how did you establish indistinguishable timing": I did not just add a delay and assume it worked - `src/lib/auth/timing.test.ts` uses `vi.useFakeTimers()` to prove, deterministically, that (a) a call resolving in 0ms is held back until exactly 1000ms (test's own `minMs`), (b) a call that itself takes longer than the floor gets zero extra delay (not `elapsed + minMs`), and (c) a rejecting call is held back exactly as long as a resolving one and still rethrows the original error untouched. `forgot-password/page.test.tsx` then re-proves the same property one level up, at the actual page: with fake timers, the confirmation text is asserted absent at 799ms and present at 800ms after a mocked-instant `resetPasswordForEmail`.

This is a best-effort mitigation, not a proof of zero timing leakage: it normalizes the one variable this app controls (how long the browser waits before rendering the result), not network jitter, TLS handshake variance, or Supabase's own infrastructure-level timing outside the request/response the app sees. 800ms is comfortably larger than the difference I'd expect between GoTrue's "user not found, short-circuit" path and its "mint a token, call the mail provider" path, but I have no measurement of that gap from this sandboxed worktree (no live Supabase project reachable) to size the floor against real numbers - it's a considered guess, stated as one.

## Password fields

`reset-password` has one "New password" field (`PasswordField`, `autoComplete="new-password"`), matching signup's pattern exactly (signup has no confirm-password field either) rather than inventing a second field the rest of the codebase doesn't use anywhere.

`reset-password` deliberately has **no captcha** - unlike `forgot-password` (a public, unauthenticated, bot-reachable form) and login/signup, reaching this page's form at all already requires a valid session established by clicking a real emailed link, which is a much stronger gate than a captcha provides. `forgot-password` does gate on `CAPTCHA_ENABLED`, mirroring login/signup's widget-reset-after-submit behavior exactly.

## Tests: 22 new, every assertion's mutant run mechanically

Baseline before this task: 215 files / 4433 tests, all green (confirmed by running `npx vitest run` before starting). After: **218 files / 4449 tests, all green** (`npx vitest run`, full suite, 125s). Also clean: `npx eslint .` (one pre-existing unrelated warning in `exhaustion.test.ts`, not touched by this task), and `npm run build`'s TypeScript pass ("Finished TypeScript in 48s", zero errors) - the build's later "collect page data" step fails on a **pre-existing** condition unrelated to this work: this worktree has no `.env.local`, so `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are unset, and the failing page is `/api/v1/businesses/[businessId]/integrations/meta/callback`, which this task never touched.

For every test file I added or edited, I followed red-before-green (confirmed the test failed against the actual missing/wrong code before writing the fix), and for the assertions that carry real risk of passing for the wrong reason, I hand-edited the source to a named mutant, reran the exact test file, watched it fail, then restored the correct source and reran to confirm green again. All of the below were run this way, not inferred:

**`src/lib/auth/timing.test.ts`**
- Test: fast-resolving op is padded to `minMs`. Mutant "no-op passthrough" (delay removed entirely) -> failed as expected.
- Test: op slower than `minMs` gets no extra wait. Mutant "always wait full `minMs`" (ignore elapsed) -> failed as expected.
- Test: fast-rejecting op still padded, original error rethrown unchanged. Mutant "swallow rejection, return `undefined`" -> failed as expected.

**`src/app/(auth)/forgot-password/page.test.tsx`**
- Test: empty submit shows "Email is required", never calls the API. Mutant "remove the empty-email guard" -> failed as expected.
- Test: valid submit calls `resetPasswordForEmail` with the entered email + expected `redirectTo`, shows confirmation.
- Test: **error response produces byte-identical confirmation HTML to a success response, and the raw error text never appears** (the core enumeration assertion). Mutant "reintroduce enumeration: destructure `{error}` and `setFormError(error.message)` on the error branch" -> failed (caught by this test, and also by the rejection test below, since the mutant also dropped the `try/catch`).
- Test: rejected promise (network failure) still produces the same confirmation, error text never leaks. Same mutant as above also caught this one independently.
- Test: minimum-delay floor holds the confirmation back even when Supabase answers instantly (fake timers, page-level). Mutant "bypass `withMinDelay`, call `resetPasswordForEmail` directly" -> failed as expected.
- Test: captcha gating - blocks submit until verified, then calls the API with the token, resets the widget. Mutant "drop the `CAPTCHA_ENABLED` gate" -> failed as expected.

**`src/app/(auth)/reset-password/page.test.tsx`**
- Test: no session -> expired-link message + link to `/forgot-password`, no form rendered. Mutant "skip the session check, always set status to ready" -> failed as expected.
- Test: session present -> renders the new-password form.
- Test: empty submit shows "Password is required", never calls `updateUser`.
- Test: successful submit calls `updateUser({password})`, then `signOut()`, then shows "Password updated" with a link to `/login`. Mutant "drop the `signOut()` call" -> failed as expected.
- Test: `updateUser` error is shown inline, `signOut` is NOT called, form stays mounted (this is intentionally the one place in the whole feature that DOES surface the raw Supabase message, since the caller already holds a valid session at this point and it's ordinary password-policy UX, not an enumeration leak). Mutant "drop the `if (error)` branch, always proceed to signOut/done" -> failed as expected.

**`src/components/auth/auth.test.tsx`**
- Test: "Forgot password" link's `href` is `/forgot-password`, not `#`. This one's mutant is the original bug itself - I ran this test against the actual pre-fix code first (red), then applied the one-line fix (green); I did not additionally hand-mutate it since the red/green cycle against the real bug already is the mechanical proof.

Tests not mutation-tested: pure rendering assertions (e.g. "renders an email field and a send-link CTA", "renders the new-password form") - these have no interesting mutant beyond "delete the JSX," which every other test in the same file would also catch, so I did not spend a cycle on them individually.

## Design-system compliance

Both new pages reuse existing components only (`AuthCard`, `TextField`, `PasswordField`, `Captcha`, `Button` with `size="touch"` = 48px), so MD3 tokens, 48px touch targets, and the reduced-motion structural rule are inherited for free - I did not write any new CSS or `animation:` declaration. Verified with `grep` that neither new page/test file contains `animation:` or an em dash.

## Concerns

1. **No brief to check against.** I could not diff my implementation against the actual acceptance criteria for T3.1 since the brief file was missing - see above. If the real brief specified something I did not build (e.g. a resend-link affordance on the confirmation screen, a specific copy deck, rate limiting beyond Supabase's own), it isn't here.
2. **800ms timing floor is a considered guess, not a measurement** - see the timing section above. If Supabase's own known-vs-unknown latency gap on this project ever exceeds 800ms (e.g. a slow email provider), the floor would need raising; I have no live project in this sandbox to measure against.
3. **`reset-password` has no captcha**, reasoned about above; flag this if the brief wanted one anyway.
4. Did not add rate limiting beyond whatever Supabase's own GoTrue rate limits provide for the `recover` endpoint - out of scope per "do not touch `supabase/**`," and app-level rate limiting wasn't mentioned in the context I was given.
