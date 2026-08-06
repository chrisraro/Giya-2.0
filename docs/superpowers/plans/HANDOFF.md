# Giya 2.0 — Build Handoff

**Written:** 2026-08-06 · **Repo state:** `main` @ `5052419`, pushed, clean
**Suite:** 215 files / 4,433 tests green · **Types:** 3 known pre-existing errors · **Migrations:** 0037–0062 live

You are picking up a multi-wave build-out of every module the docs specify and the code lacked. This document is the whole context. Read it top to bottom once; you should not need the prior conversation.

---

## 1. Verify you're starting from a good state

```bash
npx vitest run                    # expect 215 files / 4433 tests, all green
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

## 4. What is DONE (16 tasks, merged and pushed)

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

---

## 5. IN FLIGHT — nothing

T2.4 was mid-fix when this document was first written; it has since been
reviewed, approved and merged. **There is no unfinished work in a worktree.**
Start at §8 with T2.7.

Four Minor follow-ups were recorded against T2.4 rather than fixed, none
blocking: `revertReplay` filters on `id` alone and could clobber a row a
worker claimed in a narrow window (add `.eq("status","queued")`); a revert
whose own write fails leaves the row queued and logged as `UNAUDITED CHANGE`;
the replay-count read caps at 1,000 rows without notice; and the revert
overwrites `last_error`, so the DLQ row shows the replay failure rather than
why the job originally died (the original is preserved in the audit `before`).

## 6. STANDING RULES — read before writing any task

These are in the plan's global constraints. They were each earned.

### Rule 1 — every assertion needs a NAMED mutant

**And when you clone a mechanism, clone its mutants too.** The commonest way a gap survives this rule is copying a correct neighbour's *code* without its *test* — seen twice in one task, once with the omission argued in a comment that did not hold.

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

## 8. REMAINING WORK — 27 tasks

### Wave 3 — auth + suspension (1/4 done)

| Task | What it closed |
|---|---|
| T3.2 | Suspension was written by the admin ladder and read by **nothing** — a suspended user kept scanning, claiming and redeeming |

**Remaining in Wave 3:**
- **T3.1** `/forgot-password` + `/reset-password` — the login page's link is currently `href="#"`
- **T3.3** Staff invites — **owners cannot add teammates at all**; needs `/business/staff`, `/invite/[token]`, the `staff_invite` notification kind
- **T3.4** Profile edit + preferences + devices — profile is read-only with a dead "Devices" row; the four consent toggles exist in the schema with no UI. **NPC Circular 2023-04 requires separate, un-ticked marketing consent** — bundling it is non-compliant.

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
- **A written DTI FTEB query** on whether a perpetual loyalty programme needs a sales-promotion permit. `docs/00-product/03-loyalty-benchmarks.md` explains why the "loyalty is exempt" claim is unsupported. This matters before the campaign builder ships — it is a permit-generating machine.

---

## 10. Two live facts worth knowing

- `cron.job_run_details` holds **two real failures from 25 July** — `sweep_stuck_receipts` raising `LIMIT must not be negative` — that nobody ever saw, on a job id since unscheduled. The alerting that catches this is now merged but not yet scheduled.
- The money path was verified end to end earlier in this build: a real receipt through the deployed Vision function awarded **300 points from ₱150.00**, one earn row, cached balance == ledger sum.
