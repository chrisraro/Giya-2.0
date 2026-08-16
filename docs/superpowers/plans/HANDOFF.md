# Giya 2.0 — Build Handoff

**Written:** 2026-08-06 · **Last refreshed:** 2026-08-07 · **Repo state:** `main` at or after `042abcf` (the T3.4b merge, which closed Wave 3), pushed, clean
**Suite:** 248 files / 4,923 tests green · **Types:** 3 known pre-existing errors · **Migrations:** 0037–0064 live

You are picking up a multi-wave build-out of every module the docs specify and the code lacked. This document is the whole context. Read it top to bottom once; you should not need the prior conversation.

---

## 0. Read this first — the scope you are actually being handed

**Waves 1, 2 and 3 are complete: 21 tasks, all merged, all pushed. You own Waves 4-7 — 22 tasks.** Start at §8.

> ### ⚠️ Re-audited 2026-08-16 — read this before trusting anything below
>
> Work continued after this document was written: **27 commits**, taking
> migrations from 0064 to **0077** and adding the ERP admin command center,
> dedicated business signup/login, an admin verification gate, and business
> purge/force-delete tooling. That work was **not** the missing-modules plan.
>
> Current verified baseline: `main` @ `5aaf2ff`, **283 test files / 4,963 tests
> green**, `tsc` = the same 3 known pre-existing errors.
>
> **Waves 4-7 are still substantially unbuilt**, but not uniformly. Migrations
> `0065`-`0071` landed for T4.3, T4.5, T6.2, T6.4, T6.5, T7.1 and T7.2 — and
> almost none of them are wired to a surface. A migration existing is not
> evidence of a feature.
>
> **The dominant pattern to watch for:** a route file exists, passes access
> control, renders MD3-styled markup with **hardcoded sample data and inert
> buttons**, and its test asserts only that a heading renders. `/admin/admins`,
> `/admin/consumers`, `/admin/audit`, `/business/templates` and `/business/qr`
> are all this shape. Treat "the page exists" as the start of the task.
>
> Per-task status: **DONE** — T4.4 only. **PARTIAL** — T4.1, T4.2, T4.3, T4.6,
> T6.3, T6.4, T6.5, T7.4. **NOT STARTED** — T4.5's progression half, all of
> Wave 5, T6.1, T6.2, T6.6, T6.7, T7.1, T7.2, T7.3, T7.5, T7.6.
>
> **Highest-value single gap: T4.5.** `loyalty_cards` has existed since
> `0012_campaigns.sql` and **nothing has ever written to it**. The award path
> carries the acknowledgement in two migrations —
> `0018_award_receipt_points.sql:31` ("no loyalty_cards advancement (doc 35
> section 3 step 11)") and `0031_admin_access.sql:205`. Consumers can see stamp
> cards that can never fill.
>
> Also unwired and easy to miss: `ScanPreview` + its server action (T4.6) are
> correct and tested but imported by no page. And `supabase/README.md`'s
> migration ledger stops at `0067` — `0068`-`0077` are unrecorded, the same
> drift that once hid a migration recorded as applied whose function never
> landed (§7).

The user drew this boundary deliberately. An earlier session set a standing goal of *"execute all missing modules from the docs"*, and that instruction is still quoted in the plan file — but the user has since decided the remaining waves go to a fresh owner. **Do not treat the plan's standing goal as authority to keep going past a task the user has not asked for.** Ask.

Nothing is in flight. No worktree holds unfinished work. Every migration through 0064 is applied live and verified against the catalogue, not just against its file.

---

## 1. Verify you're starting from a good state

```bash
npx vitest run                    # expect 248 files / 4923 tests, all green
npx tsc --noEmit                  # expect EXACTLY 3 errors (see below)
scripts/sdd/check-grants.sh 090bc96   # expect "OK"
git status --porcelain            # expect empty
```

The **3 expected type errors** are pre-existing and predate this work — do not "fix" them as part of a task:
- `scripts/generate-md3-tokens.test.ts` ×2
- `src/features/rewards/server/token.test.ts` ×1

**Live database:** Supabase project `zlfxfzlnklqhajacngxf`. There is a second project `dcnpuvtbftpbcjcvfnlt` — **it is a different app of the user's ("latag-ph"), not Giya.** Never apply migrations there. Verify before trusting any project reference.

---

## 2. The plan and where things live

| Artifact | Path |
|---|---|
| **The plan** (all 7 waves, global constraints) | `docs/superpowers/plans/2026-08-06-missing-modules.md` |
| Task briefs + reports + review findings | `.superpowers/sdd/briefs/` *(gitignored scratch)* |
| Running progress ledger | `.superpowers/sdd/progress.md` *(gitignored)* |
| Grant gate script | `scripts/sdd/check-grants.sh` *(tracked)* |
| Migration ledger + suite index | `supabase/README.md` |
| Product research that drove several decisions | `docs/00-product/03-loyalty-benchmarks.md` |

The gap inventory that produced the plan came from five parallel audits of docs 30–42 + 52 against the actual code. The plan's scope rule: **MVP and untagged requirements are in scope; [V1] only when a shipped surface depends on it or it guards money/trust; [SCALE] is out.**

---

## 3. The working method

Each task runs one loop. It is not optional ceremony — every single task so far has come back from review with real defects, several money-path.

```
write brief → dispatch implementer (TDD, isolated) → adversarial review
    → fix pass → re-review → merge → push
```

**Implementers** get a brief file, not a conversation. The brief states the defect, the required behavior, binding constraints, minimum tests, and the report contract. They work on `main` if they own the migration sequence, otherwise in an isolated git worktree.

**Reviewers** are told to verify by *execution*, not by reading. The single most productive instruction has been: *"apply this mutation, run the suite, tell me what fails."* That is what caught most of the serious defects.

**Only one task at a time may create migrations.** Violating this cost a file three renames (see §7).

---

## 4. What is DONE (21 tasks, merged and pushed)

### Wave 1 — money correctness (7/7 complete)

| Task | What it closed |
|---|---|
| T1.1 | `fixed_per_visit` paid on every receipt instead of once per visit-day |
| T1.2 | Campaign budgets unenforced at award time — and metered in the wrong unit entirely |
| T1.3 | The 12-month expiry published in your consumer terms but never implemented |
| T1.4 | No way to cancel a claim; points locked until the sweep |
| T1.5 | Unaffordable rewards looked tappable and failed on tap — plus a `cn()` bug deleting typography app-wide |
| T1.6 | Automatic fraud cooldowns unaudited; closed-hours signal never built |
| T1.7 | Lifecycle transitions left no audit trail; resume skipped its gates |
| *(0052)* | Unplanned: service role could reach three session-only RPCs |

### Wave 2 — ops floor (8/8 COMPLETE)

| Task | What it closed |
|---|---|
| T2.1 | Scheduled campaigns never started; ended ones never ended |
| T2.2 | Nothing ever verified the cached balance still equals the ledger |
| T2.3 | Doc 52's observability stack had zero implementation |
| T2.5 | Seven cron jobs reported failure where nobody reads |
| T2.6 | `heartbeat_at` written once at claim, never refreshed |
| T2.8 | `finishJob` had no lease guard *(debt T2.6's own fix created)* |
| T2.4 | Dead-lettered jobs were invisible and unrecoverable through any interface |
| T2.7 | No AI kill switch, no budget caps; `budgetMicros` existed and no caller passed it |

### Wave 3 — auth + account completeness (4/4 COMPLETE)

| Task | What it closed |
|---|---|
| T3.2 | Suspension was written by the admin ladder and read by **nothing** — a suspended user kept scanning, claiming and redeeming |
| T3.3 | Owners could not add teammates at all — no roster, no invite, no accept |
| T3.1 | The login page's "Forgot password" link was `href="#"` — no recovery flow existed |
| T3.4a | Profile was read-only; `avatar_url` had zero writers and there was no bucket |
| T3.4b | Four consent columns had grants and no UI; `user_devices` had zero references in `src/`; the "Devices" row pointed nowhere |

---

## 5. IN FLIGHT — nothing

**No worktree holds unfinished work.** T3.4b was the last one open; it is
reviewed, approved and merged. Start at §8 with Wave 4.

### What Wave 3 left behind that you should know

**Two lessons cost a review round each and generalise past their tasks.**

**1. Assert the *claim*, not the words that happen to express it.** T3.4b's
device list guarded against overclaiming ("signs you out everywhere") with a
denylist of regexes. A reviewer wrote three plausible overclaims in unlisted
phrasings and all 343 tests stayed green. Fixed layered: **fixed prose is
pinned with `toBe`** — the full paragraph, the failed-revoke sentence, both
button labels — so any reworded sentence fails and a human is forced to read
the new claim; the denylist stays underneath for genuinely composed text an
allowlist cannot cover. If you write copy that makes a promise about security
behaviour, pin it exactly.

**2. An assertion whose expected value comes from the same place as its
actual value cannot disagree with the code.** Three variants appeared in one
task: a fixture whose declared type coincided with the constant under test; a
`JSON.stringify` that flattened `new Error("x")` to `"{}"` so a log assertion
passed against discarded evidence; and two call sites agreeing on a shared
helper whose value was wrong. **Agreement proves two sides cannot drift — it
proves nothing about whether the shared value is right.** Pin the shared
value to its source of truth as well.

**The product must not state a control it does not have — in either
direction.** T3.2 shipped `/suspended` telling users they could not redeem
while redemption was ungated. T3.4b shipped the inverse: a footer saying
device removal "does not sign that browser out", unqualified, when removing
your *current* device signs you out immediately — with the only warning in an
`aria-label`, which **replaces** the accessible name, so sighted users saw
nothing. Both are the same defect. Check copy against behaviour for the row
that is different, not the common case.

**Deleting a `user_devices` row does not invalidate that browser's session.**
The refresh token lives in GoTrue, not that table. Revoking the current
device calls a real `auth.signOut()`; revoking any other genuinely does not
end its session, and the copy now says so. Do not "improve" that copy into a
promise the system cannot keep.

**Device registration is enforced, not enumerated.**
`src/app/device-registration-coverage.test.ts` walks `src/app` and asserts
every module establishing a session also reaches a registration seam. It is
**AST-based on purpose**, and a third test pins that: `verifyOtp` appears
inside a comment in the forgot-password route, so a grep-shaped scan would
flag prose and invite someone to register a device on a route that mints no
session. Its limits, stated: same-module only, `src/app` only, and it cannot
tell whether registration sits on the success branch (other tests carry that).

### What T3.1 left behind that you should know

**T3.1 does not work until the two Dashboard changes in §9 ship with it.**
The code is done; the flow receives no traffic at all until then.

**The recovery marker is not an authorization boundary, and never was.**
`/auth/confirm` mints an HttpOnly marker cookie when it verifies a
`type=recovery` link; `updateUser` now sits behind a server route that checks
**and clears** it. But `updateUser` is authorized by the Supabase *session* —
the marker only distinguishes a recovery-origin session. It replaced an
`amr === "recovery"` check that could not do that at any value, because
`"recovery"` is not an `AMRMethod` at all (it is an
`EmailOtpType`/`GenerateLinkType`). Don't reason about the cookie as though
it carries authority it was never given.

**A cookie's deletion identity tuple is name + `Path` + `Domain` — nothing
else.** `HttpOnly`, `Secure` and `SameSite` are *not* part of it; stripping
them from a clearing header still deletes the cookie. Assert them on the
mint, where they are load-bearing. This cost a review round: the clear
asserted only `name=;` and `max-age=0`, so `Path=/reset-password`, an omitted
`Path`, and an added `Domain` all passed a green suite while deleting
nothing.

**`src/lib/auth/recovery-cookie.test.ts` is the pattern to copy** when a
property lives between two files. It `await import`s the real mint route,
reads the actual `set-cookie` off a real response, calls the real clear
helper, and compares the two identity tuples. The part most likely to be
dropped when copying it is the non-vacuity guard: without asserting the mint
tuple's name, a mint that emitted *no cookie at all* would compare
`{name:"", path:undefined, hasDomain:false}` against itself and pass.

**`.superpowers/` is gitignored, but
`.superpowers/sdd/briefs/t3-1-report.md` is deliberately tracked** (as is
`sdd/task-3-report.md` from an earlier slice). The worktree is gone; that
file is the per-assertion mutant record for a security-sensitive flow. It is
not cruft — leave it.

Four Minor follow-ups were recorded against T2.4 rather than fixed, none
blocking: `revertReplay` filters on `id` alone and could clobber a row a
worker claimed in a narrow window (add `.eq("status","queued")`); a revert
whose own write fails leaves the row queued and logged as `UNAUDITED CHANGE`;
the replay-count read caps at 1,000 rows without notice; and the revert
overwrites `last_error`, so the DLQ row shows the replay failure rather than
why the job originally died (the original is preserved in the audit `before`).

Five Minor follow-ups are recorded against T3.3, none blocking, ~20 minutes
between them. Do **N1** and **N2** first — both live inside a SECURITY
DEFINER function:

- **N1** — `0063:39-47`'s header says normalization is `lower(btrim(...))`
  "on BOTH sides"; `0063:75` btrims the *input* only. Either btrim both or
  narrow the sentence. Second time on this branch a comment overstated its
  code.
- **N2** — `0063:76` is `limit 1` with no `order by`. Two `auth.users` rows
  differing only by case resolve plan-dependently, and the consequence is an
  invite bound to the wrong human. `order by u.created_at`, or prefer an
  exact match before the case-insensitive one.
- **N3** — `service.ts:195` `data[0]` would `TypeError` on a null `data`,
  escaping as an unhandled rejection instead of this module's honest
  `{ok:false}`. `data?.[0]` is free.
- **R6** — `service.ts:539` `token: args.row.invite_token ?? ""` would email a
  real person a link to `/invite/`. Unreachable today; the fallback should
  throw rather than ship a broken URL.
- **R7** — `reinviteExisting` (`service.ts:400-434`) gates only on the *new*
  role, never `existing.role`, so a manager can reactivate a disabled manager
  or marketing row as a `staff` invite. A strict downgrade of an already
  non-live row, so no escalation — but `revokeInvite:566` applies exactly
  that symmetric check, and the asymmetry needs a gate or a line saying why
  not.

**`public.find_auth_user_by_email` (0063) should stay the only reader of
`auth.users`.** It is service-role-only, `security definer`,
`set search_path = ''`, and returns `(id uuid, email text)` — so the
narrow-column property is structural, not a `.select()` string a caller can
widen.

### Recorded against T3.4, none blocking

From T3.4a: `saveConsumerProfile` is **not atomic** — `profiles.display_name`
writes, then `consumers.city_id`, so a failure on the second leaves the name
saved while the UI reports failure. Zod's `.max(80)` counts UTF-16 code units
while the DB's `char_length` counts code points, so 45 emoji are refused by
the form and accepted by the column (Zod is the stricter side, so no `23514`
escapes). `revalidateProfileSurfaces()` is unasserted on both avatar actions.
`AVATAR_BUCKET_MAX_BYTES` is used by nothing but its own test. The uid in the
object path is not pinned to the *session* (the insert policy denies a
foreign segment, so defence in depth holds). The city picker cannot **clear**
a city. `updated_by` is unstamped, matching the existing writer.
`avatar-image.ts` imports `sniffImageFormat` across the feature boundary.

From T3.4b: **`saveConsent` reports success on a zero-row UPDATE** — an
`.update().eq("id", user.id)` returns no error when RLS or a missing row
matches nothing, so the optimistic flip stays and the database never changed.
A `.select("id").maybeSingle()` closes it. Same pre-existing pattern as
`saveConsumerProfile`. Device rows can duplicate under a same-instant race
(no unique index behind `(user_id, platform, user_agent)`; a migration would
be needed), and duplicates would both badge "This device". `is_revoked` is
still dead, and `user_devices` has **no column fence**, so `authenticated`
can UPDATE `fcm_token`/`is_revoked` on their own rows — both pre-existing.
`server/devices.ts` imports `relativeTime` from `@/features/analytics/metrics`.

### Pre-existing debt found along the way, not caused by these tasks

**`0019_receipts_storage.sql`'s fence has no pgTAP suite.** There was no
`storage.objects` assertion anywhere under `supabase/tests/` until T3.4a
wrote `rls_avatars_storage_smoke.sql`. The receipts bucket's fence — the one
guarding uploaded receipt images — is still untested. That suite is the
template if you take it on.

## 6. STANDING RULES — read before writing any task

These are in the plan's global constraints. They were each earned.

### Rule 1 — every assertion needs a NAMED mutant

**And when you clone a mechanism, clone its mutants too.** The commonest way a gap survives this rule is copying a correct neighbour's *code* without its *test* — seen twice in one task, once with the omission argued in a comment that did not hold.

**And an assertion whose expected value comes from the same place as its actual value cannot disagree with the code.** Three variants of this shipped green in Wave 3: a fixture whose declared MIME type coincided with the constant under test; a `JSON.stringify` that flattened `new Error("x")` to `"{}"`, so a log assertion passed against evidence the code had discarded; and two call sites agreeing on a shared helper that held the wrong number. Agreement proves two sides cannot *drift* — never that the shared value is *right*. Pin it to its source of truth as well.

**And a test that pins particular words does not pin the claim those words make.** A denylist of regexes over consumer-facing copy let three plausible rewordings of a false security promise pass a 343-test suite. For *fixed* prose, assert the full string with `toBe`; keep pattern matching underneath for text that is genuinely composed at runtime.

> Every new or modified assertion must be red-verified against a named mutant, and the report must name the mutant for each. An assertion with no stated mutant is one nobody has shown can fail.

**Why:** seven tasks shipped assertions that passed without exercising the property their names claimed. A "concurrency proxy" that measured summation breadth. A pair-scoping filter whose every fixture used one business. A `last_status:'running'` fixture paired with `failures:0` — a combination the source function *cannot return* — which survived **three** review rounds. A cascade check querying a table the deleted row was never in. Every one sat inside a fully green suite.

The discriminator is visible across the whole record: every assertion someone red-verified held up; every one marked "by construction" is on that list. State the mutant concretely — *"delete `and pt.business_id = c.business_id` → these four assertions fail"*, not *"tested the filter"*.

### Rule 2 — per-role grant assertions on every new definer function

anon denied, authenticated denied, service_role explicitly asserted — **independently**. Supabase grants `EXECUTE` to `service_role` at CREATE time via project-level default privileges, *regardless of what your migration revokes*. A function can have perfect anon/authenticated assertions and still ship reachable by the service role. `scripts/sdd/check-grants.sh <BASE>` enforces this and is schema-aware (an assertion on `private.foo` does **not** cover `public.foo`).

### Rule 3 — never edit an applied migration in place

Companion file only. See `supabase/README.md`'s `0011b` note. This was violated once and produced a ledger recording a history that never happened.

### Rule 4 — a candidate scan with a LIMIT must be self-clearing

A row that does no work and writes nothing still matches the scan forever. With a deterministic sort, dead rows accumulate at the front and everything behind them silently stops being processed. This shipped **three times** (0045 and 0054 are the fixes). And note: a test asserting "a full run returns zero" cannot distinguish a cleared scan from a stuck one — prove it with a *tight* limit.

---

## 7. Landmines specific to this repo

- **`apply_migration` returning success is not proof the SQL is live.** Migration 0057 was recorded as applied, its supporting objects were live, and its central `create or replace function` never landed — discovered only by reading `pg_proc` back. Always verify a function body after applying. The suite now pins a `balance_check body revision: NNNN` marker for exactly this.
- **The test suite runs as `postgres`.** A trigger that broke deletes for `service_role` was invisible until someone ran `set local role service_role`. If your change touches privileges, assert under the role that will actually run it.
- **`cn()` is `twMerge(clsx())`** and the MD3 type scale is registered in `src/lib/utils.ts`. Don't unregister it — before that fix, any color class silently deleted the type class.
- **Empty ≠ failed read.** This conflation was a real defect twice (`getMyBalances`, the metrics loader). A user with no balances and a user whose read failed must never see the same screen.
- **`src/lib/env.ts` throws at module scope** on a bad server schema. A length floor there gives a malformed value repo-wide blast radius — validate locally instead, the way `src/lib/supabase/service.ts` does.
- **Only one task may create migrations at a time.** Two concurrent tasks each told to "take the next free number" produced a file renamed 0058 → 0059 → 0060.

---

## 8. REMAINING WORK — 22 tasks

**Waves 1-3 are done. Wave 4 is where you start.**

### Wave 4 — consumer surfaces (6)
- **T4.1** Promotions visible — merchants create them; consumers never see them anywhere
- **T4.2** `/discover` — search, filters, map (route does not exist)
- **T4.3** Favourites — no table, no code
- **T4.4** `/wallet/[businessId]`, `/receipts/[id]`, claim status tabs
- **T4.5** Loyalty cards — `loyalty_cards` progression is entirely unbuilt; doc 35 §3 step 11
- **T4.6** Points preview at scan time (`computePoints` exists, is server-only)

### Wave 5 — PWA (3) — *unbuilt end to end, and it is in the product's name*
- **T5.1** Service worker + manifest fixes (no SW exists; no serwist/workbox dependency)
- **T5.2** `/offline`, install prompt, `useOnlineStatus` pill
- **T5.3** IndexedDB receipt outbox + wallet snapshot. **Redemption must stay online-only** — that is deliberate and correct.

### Wave 6 — portal/admin (7)
- **T6.1** Receipt template management UI (templates are DB-only today)
- **T6.2** Onboarding persistence — the wizard's hours and document steps are **mock-only and persist nothing**
- **T6.3** `/admin/consumers`, `/admin/admins`, `/admin/audit` viewer
- **T6.4** `analytics_daily_business` rollup + admin tiles + the Meta insights tile (`readPageInsights` is built and called by nothing)
- **T6.5** QR hub + `/q/[code]` resolver (`qr_codes` table does not exist)
- **T6.6** Multiplier/bonus rule CRUD (only the base rule has UI)
- **T6.7** `images.process` worker

### Wave 7 — platform (6)
- **T7.1** Announcements + legal versioning + `user_consents` re-consent
- **T7.2** Maintenance mode
- **T7.3** Push notifications — env-optional (no FCM, `user_devices` unused)
- **T7.4** Resend template registry + bounce/suppression webhook
- **T7.5** Sentry env-optional + structured logging
- **T7.6** Docs refresh — `src/features/receipts/README.md` is stale

### Final
- Whole-branch review + live money-path re-verification

### Deliberately deferred (do not build without asking)
Manual points adjustments *(the user decided this in a grilling session — doc 37 flags owner self-crediting as a fraud vector needing its own audit surface)*; audience targeting; recurrence/rrule; referral programme; reviews; AI assistant + RAG + eval harness; fraud rings, `ocr_similarity_dup`, `gps_mismatch`; exports; deep analytics tabs; marketing composer. All `[SCALE]` items.

---

## 9. Blocked on the user, not on code

- **GCP billing** on `giya-ocr-production` before receipt 1,001
- **A verified Resend domain** — email currently reaches only the account owner's address, so alerting and notifications are structurally undeliverable to anyone else
- **A Meta app** for `META_APP_ID`/`META_APP_SECRET` + App Review
- **Vercel env vars**: `NEXT_PUBLIC_MAPTILER_KEY`, `QSTASH_*`, `QSTASH_CALLBACK_ORIGIN`, `RESEND_API_KEY`, `SUPABASE_EDGE_OCR_URL` + `OCR_FUNCTION_SECRET`, `INTEGRATION_TOKEN_AES_KEY`, and optionally `METRICS_TOKEN` / `OPS_ALERT_EMAIL`
- **No QStash schedule** invokes `/api/jobs/ops.job_health_check` or `/api/internal/metrics`. Both routes exist and are tested; the cadence is recorded in `docs/50-ops/52-monitoring-observability.md` and must be configured externally before anything alerts anyone.
- **Two Supabase Dashboard changes that must ship in the same deployment as T3.1.** Password recovery does not work without them, and the code cannot make them for you:
  1. **Authentication → Email Templates → Reset Password** — change the link to
     `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`
  2. **Authentication → URL Configuration → Redirect URLs** — allowlist `<site>/auth/confirm`

  **If step 1 is missed, the failure is not a 404**, which is what you would
  reasonably guess. `redirectTo: ${origin}/auth/confirm` means the default
  template's `{{ .ConfirmationURL }}` routes the user through GoTrue's own
  `/auth/v1/verify`, which 302s to the route with a PKCE `?code=` rather than
  a `token_hash`. So `tokenHash` is null, the guard at `confirm/route.ts:52`
  fails, and it falls through to `/login?error=confirm` — the user sees
  **"That link expired or was already used"**, permanently, capped at three
  retries per fifteen minutes. That is indistinguishable from the bug T3.1
  exists to fix. `/auth/callback` is never involved.
- **A written DTI FTEB query** on whether a perpetual loyalty programme needs a sales-promotion permit. `docs/00-product/03-loyalty-benchmarks.md` explains why the "loyalty is exempt" claim is unsupported. This matters before the campaign builder ships — it is a permit-generating machine.

---

## 10. Two live facts worth knowing

- `cron.job_run_details` holds **two real failures from 25 July** — `sweep_stuck_receipts` raising `LIMIT must not be negative` — that nobody ever saw, on a job id since unscheduled. The alerting that catches this is now merged but not yet scheduled.
- The money path was verified end to end earlier in this build: a real receipt through the deployed Vision function awarded **300 points from ₱150.00**, one earn row, cached balance == ledger sum.
