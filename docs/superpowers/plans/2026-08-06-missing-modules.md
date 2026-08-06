# Plan: Missing modules build-out (docs 30–42 + 52)

**Date:** 2026-08-06
**Status:** ACTIVE — inventory complete (5 parallel audits, all docs 30–42 + 52 read against code).
**Goal:** every in-scope module the docs specify and code lacks, production-grade, TDD, subagent-driven. UI under the impeccable skill against docs/10-architecture/16-design-system.md.

## Scope rule

- **MVP-tagged and untagged requirements: in scope.**
- **[V1] items: in scope when a shipped surface depends on them or they guard money/trust.** Otherwise deferred (list at bottom).
- **[SCALE] items: out of scope** (PayMongo, content publishing, AI analytics) — the docs themselves defer them.
- External credentials (FCM, Sentry DSN, Resend domain, Meta app) wire **env-optional**: feature degrades cleanly when the key is absent; creds land at the end per standing order.

## Global constraints (binding on every task)

1. **Every new or modified assertion must be red-verified against a named mutant, and the report must name the mutant for each.** An assertion with no stated mutant is an assertion nobody has shown can fail.

   This is not a style preference. Across the first two waves, reviewers found the same defect class in *seven* tasks: a test that passes without exercising the property its name claims. A concurrency proxy that tested summation breadth. A pair-scoping filter whose fixtures all used one business. A "no statement boundary" predicate that could not hold against its own migration. A `status: running` fixture paired with `failures: 0`, a combination the source function cannot return. A cascade assertion querying a table the deleted row was never in. Each was invisible to a full green suite.

   The discriminator is empirical and visible in the record: every assertion an implementer red-verified against a specific mutant turned out to be sound, and every one that was not is on the list above. The practice is already in use — it is just applied selectively. Make it universal.

   **When you clone a mechanism, clone its mutants too.** The most common way a
   gap survives the rule is copying a correct neighbour's *code* without copying
   its *test*. Observed twice in one task: a 30s settings cache transcribed from
   `flags.ts`'s cache shipped without `flags.ts`'s TTL-expiry test, so a
   permanent cache passed the whole suite — and the omission was rationalised in
   a comment that did not hold (it argued a different cache's liveness test
   covered this one). If you copy a pattern, open the original's test file and
   copy the assertions that fence it.

   **When correctness depends on two files agreeing, assert the agreement, not
   each side.** A cookie is deleted only by a `Set-Cookie` whose *identity
   tuple* — name, `Path`, `Domain` — matches the one that set it; everything
   else on the header is decoration. T3.1 shipped a clear that asserted
   `name=;` and `max-age=0` and nothing else, so `Path=/reset-password`,
   an omitted `Path`, and an added `Domain` **all passed a green suite while
   deleting nothing** — reopening the exact reuse window the fix existed to
   close. The mint side was equally unpinned in the other direction. Neither
   file's test could express the property, because the property lives
   *between* them; the fix is a test that owns the relationship. Generalise
   past cookies: emitting the right-looking artifact is not evidence that the
   artifact did its job. Assert the effect, and where you cannot reach the
   effect, assert the identity that produces it.

   **Agreement is necessary, not sufficient — also pin the shared value to its
   source of truth.** Two call sites both reading one helper prove they cannot
   *drift*; they prove nothing about whether the helper is *right*. T3.4a hit
   this immediately after adopting the rule above: both sides quoted
   `oversizePhotoMessage()`, and changing that helper to say "4 MB" against an
   8 MB ceiling left both new assertions green, because each compared rendered
   text against the helper's own output. The fix is a third assertion that
   parses the figure back out of the sentence and compares it to
   `AVATAR_MAX_UPLOAD_BYTES`. Three variants of this one class appeared in a
   single task: a fixture whose value coincided with the constant under test,
   a `JSON.stringify` that flattened `new Error("x")` to `"{}"` so a log
   assertion passed against discarded evidence, and two sides agreeing on a
   shared wrong value. **When an assertion's expected value comes from the
   same place as its actual value, it cannot disagree with the code.**

   Name the mutant concretely: "delete `and pt.business_id = c.business_id` → these four assertions fail", not "tested the filter".

1. **TDD.** Red first. Each task names its test files; implementer reports test output. Full suite green (baseline 3820) before DONE.
2. **Money path:** ledger writes ONLY via SECURITY DEFINER RPCs. New RPCs/migrations carry the three-layer fence (RLS + privilege revokes + raising triggers) and pgTAP tests.
   - **Every new `public.` SECURITY DEFINER function needs pgTAP grant assertions in the same commit** — `anon`/`authenticated` denied, `service_role` allowed — and any `private.` helper it wraps asserted as not executable even by `service_role`. Correct grants in the migration are not enough; the assertion is what catches a future misgrant. Pattern: `rpc_award_smoke.sql`'s I-A block. This was an Important review finding on both T1.1 and T1.2 — do not make it a third.
   - **Never meter a per-campaign budget with `sum(points) where campaign_id = X`.** `points_transactions.points` is the whole-receipt total and `campaign_id` names only the primary campaign. Use the attribution helpers from 0041 (`campaign_points_awarded`, `campaign_customer_earn_count`), which read the campaign's own contribution out of `rule_snapshot`.
3. **Migrations:** applied live to `zlfxfzlnklqhajacngxf` via MCP, mirrored in `supabase/migrations/`, recorded in `supabase/README.md`. Next number: 0037.
4. **RSC boundary:** no functions crossing into `"use client"`.
5. **Design system:** MD3 tokens (`text-title-m`, `bg-surface-container`, `rounded-md3-*`, `material-symbols-rounded`), skeleton `loading.tsx`, `EmptyState`, `motion/react` gated by `useReducedMotion`. UI tasks run under impeccable.
6. **Copy never accuses the consumer.** Expiry/consent copy mirrors the terms page. No "while supplies last" phrasing anywhere (DTI).
7. **Day boundaries:** `private.manila_day()` / `manila-day.ts`.
8. **Types:** `rm -rf .next && npx tsc --noEmit` → exactly the 3 known pre-existing errors.
9. **Server actions over new REST routes** where the repo already does so (documented deviation, accepted).
10. **NPC compliance where code touches consent:** separate un-ticked marketing consent, opt-out honored immediately, member QR carries minimal data.
11. Commits per task; push to origin at wave boundaries after wave review.

## Wave 1 — Money correctness + trust

- **T1.1 `fixed_per_visit` once-per-Manila-day dedup.** `computeBasePoints` pays `fixed_points` on every receipt; doc 35 says once per visit-day. Gate in the award path on an existing same-consumer same-business same-Manila-day earn (use the visit rule's day logic). Tests: `src/features/points/compute.test.ts` + award-path test asserting second same-day receipt earns 0 from a fixed_per_visit rule but still records status.
- **T1.2 Award-time budget enforcement.** `max_total_points` running-total check and per-customer limit for multiplier/bonus campaigns inside the award transaction (doc 34 §5 rows 27/30). On exhaustion: campaign → paused (system), notification kind `campaign_budget_exhausted` to owner, audit row. Migration if a SQL-side check is needed. Tests: award tests + pgTAP if RPC changes.
- **T1.3 Points expiry enforcement.** Policy is already public in terms (12-month rolling). Migration 003x: `expires_at` on `points_transactions` earn rows (stamped award-time), `expire_points()` FIFO sweep (doc 35 §7 formula: expire remainder = earned − later consumption, floor 0), pg_cron daily, `reversal`-style `expire` ledger rows via SECURITY DEFINER, cached balance maintained. pgTAP for the sweep. Notification kind `points_expiring` (30d/7d) via a warn sweep. Wallet: per-lot "expires on" view (doc 33 + benchmarks finding 5).
- **T1.4 Consumer claim cancel.** One-tap release of an unredeemed claim reusing the `expire_claims` reversal semantics (new SECURITY DEFINER `cancel_claim` guarded to owner+active claim; restores balance + inventory; ledger `reversal`). pgTAP + UI on claim detail. (Benchmarks finding 1.)
- **T1.5 Rewards affordability.** `/rewards` and `/b/[slug]` catalog read the caller's balance; unaffordable cards greyed, never hidden, with numeric shortfall ("1,222 points to go"); progress anchored to next reachable reward. (Benchmarks finding 3; design under impeccable.)
- **T1.6 Fraud closure.** (a) `fraud.cooldown_applied` audit row on the automatic cooldown path (`TODO(audit)` in `server/cooldown.ts`, `actor_kind='system'`). (b) Closed-hours timestamp check (S5): compare receipt time to `businesses.opening_hours` when both exist, warn-signal only.
- **T1.7 Campaign transition audit rows.** Every lifecycle transition writes `audit_logs` (`campaign.<transition>`); `resumeCampaign` re-runs activation gates (doc 34 T6).

## Wave 2 — Automation + ops floor

- **T2.1 `campaigns.sweep`.** pg_cron (matches repo convention over QStash): scheduled→active at `starts_at`, active/paused→ended at `ends_at`; audit rows `campaign.activated_by_sweep`/`campaign.ended_by_sweep`; pgTAP. Add `schedule`/`unschedule`/`duplicate` actions + UI affordances.
- **T2.2 `integrity.balance_check`.** pg_cron daily: recompute Σledger vs cached balance over a sample; persist drift report rows; surface count in admin overview. pgTAP.
- **T2.3 Health + metrics.** `GET /api/v1/health` (DB/Redis/queue reachability, no secrets) and `GET /api/internal/metrics` (jobs depth, DLQ count, sweep_job_health) with bearer guard.
- **T2.4 Admin queue status.** `/admin/monitoring/queues`: jobs table state, dead letters with replay action (`job.replayed` audit), sweep run history via `sweep_job_health()`.
- **T2.5 Sweep-failure alerting.** Failures>0 in `sweep_job_health()` → email to admin via existing `notify.email` worker; once-per-day dedupe.
- **T2.6 Worker heartbeat.** Periodic `heartbeat_at` refresh for >60s workers (ocr.process).
- **T2.7 Feature flags.** `feature_flags` table (migration), `src/lib/flags.ts` (30s cache), `/admin/flags` UI, wire AI kill-switch keys (`ai_parse_assist`) into the LLM gateway + Redis budget counters honoring `ai.budget` settings (doc 38 §1).

## Wave 3 — Auth + suspension completeness

- **T3.1 Forgot/reset password.** `/forgot-password` + `/reset-password` (Supabase `resetPasswordForEmail` + `updateUser`), dead link fixed, rate-limited, email via Supabase auth (not Resend).
- **T3.2 Suspension enforcement.** `/suspended` terminal screen; consumer layouts check `profiles.is_suspended`; business portal blocks `businesses.status='suspended'`; error codes `ACCOUNT_SUSPENDED`/`BUSINESS_SUSPENDED`.
- **T3.3 Staff invites.** `/business/staff` roster (owner/manager), invite by email (`invite_token`), `/invite/[token]` acceptance, notification kind `staff_invite`, codes `INVITE_INVALID/EXPIRED/DUPLICATE`, `OWNER_REQUIRED`. Role matrix becomes reachable.
- **T3.4 Profile + preferences.** Profile edit (name/avatar/city); `/profile/settings` with the four toggles (marketing/push/email/gps_fraud_opt_in) as separate un-ticked consents (NPC 2023-04); `user_devices` upsert on login; devices list/revoke UI (revoke = row delete + session sign-out note).

## Wave 4 — Consumer surfaces

- **T4.1 Promotions visible.** Promotion cards on `/b/[slug]` and `/home` (merchant creates them today; consumers never see them). Counter-honored copy per doc 34.
- **T4.2 Discover.** `/discover`: text search over active businesses, city/type filters, map view reusing the static-tile stack. Skeletons + empty states.
- **T4.3 Favorites.** Migration: `favorites` table + RLS; toggle on `/b/[slug]`; `/favorites` list; home rail.
- **T4.4 Wallet/receipts depth.** `/wallet/[businessId]` per-business ledger; `/receipts/[id]` detail; `/rewards` status tabs (Active/Redeemed/Expired/Cancelled).
- **T4.5 Loyalty loop.** Doc 35 §3 step 11: `loyalty_cards` progression on award (SECURITY DEFINER, same txn discipline), completion → auto-claim prize (reuses `claim_reward` path), consumer `/cards` + `/cards/[cardId]` stamp UI, portal loyalty payload gets minimal card style. pgTAP.
- **T4.6 Points preview.** Scan-time estimate ("~N pts at <business>") from `computePoints` via a preview server action; portal "test a receipt" preview on the rules card.

## Wave 5 — PWA (doc 41)

- **T5.1 Service worker + manifest.** Serwist: precache shell, runtime caching per doc (supabase-img CacheFirst, tiles CacheFirst capped, pages NetworkFirst); manifest fixes (`id`, `start_url`, `orientation`, `lang`, `shortcuts`, maskable raster icons); build-id versioning + skipWaiting update toast; SW scoped out of `(business)`/`(admin)`.
- **T5.2 Offline UX.** `/offline` fallback; `useOnlineStatus()` + global offline pill; install prompt after first approved scan (`beforeinstallprompt` + iOS instructions).
- **T5.3 Offline outbox.** IndexedDB (`giya-offline`) receipt outbox: capture offline → queue → auto-submit on reconnect (reuses idempotency key design); wallet snapshot store + staleness banner. Redemption stays online-only (keep).

## Wave 6 — Portal/admin completion

- **T6.1 Template management.** `/business/templates`: upload sample, OCR test run, field-anchor authoring for `parse_config`, `validated_at` gate, version list. Server actions + storage; the pipeline already consumes templates.
- **T6.2 Onboarding persistence.** Wizard's hours + documents steps persist (migration: `business_documents` + storage bucket + RLS); verification uses submitted docs; `request_revision` third state + round history (doc 31).
- **T6.3 Admin surfaces.** `/admin/consumers` (+detail: history, cooldown/suspend actions), `/admin/admins` (CRUD, `LAST_SUPER_ADMIN` guard), `/admin/audit` viewer (filter by actor/action/entity), business search/detail beyond the queue.
- **T6.4 Analytics rollup.** Migration: `analytics_daily_business` + nightly pg_cron rollup (idempotent, 3-day re-roll); dashboards union rollup+today; admin tiles WASC/GMV-proxy/AI-cost (from `ai_usage_events`); Meta page-insights tile wired (`readPageInsights` exists unused).
- **T6.5 QR hub.** Migration: `qr_codes` + `/q/[code]` resolver (+scan counter) + `/business/qr` (generate/print/download, QRCode.js) for business/campaign links.
- **T6.6 Rules CRUD.** Multiplier/bonus rule create/edit UI with the implied-economics sentence pattern; conditions editor (days/time/min_amount).
- **T6.7 `images.process`.** Logo/cover/product variants via sharp worker; storage paths per doc 39.

## Wave 7 — Platform trimmings

- **T7.1 CMS minimal.** Migration: `announcements` (+audience: all/consumers/businesses), admin authoring, consumer/business surfacing, notification kind `announcement`; legal pages get version + effective-date row (`legal_versions`), `user_consents` records acceptance, re-consent interstitial on material change.
- **T7.2 Maintenance mode.** `settings` table + `/admin/settings` toggle + middleware check (admins exempt) + `/maintenance` page.
- **T7.3 Push env-optional.** `notify.push` worker + FCM client lifecycle + SW push/notificationclick handlers + push priming after first award; entire path no-ops without `FCM_SERVICE_ACCOUNT_JSON`/`NEXT_PUBLIC_FIREBASE_CONFIG`.
- **T7.4 Email completeness.** Resend template registry (staff_invite, reward_claimed, points_expiring, announcement), bounce/suppression webhook `/api/webhooks/resend` honoring suppression on send.
- **T7.5 Sentry env-optional + structured logs.** `instrumentation.ts` + client config behind `SENTRY_DSN`; `src/lib/log.ts` structured JSON with request/job ids adopted in workers.
- **T7.6 Docs refresh.** `src/features/receipts/README.md` (stale), `supabase/README.md` ledger, env checklist additions (FCM, Sentry, Resend webhook secret).

## Deferred (recorded, not built)

- Manual points adjustments — **user decision** in grilling session ("deliberately not built"; owner self-crediting is a doc-37 fraud vector needing its own audit surface).
- Audience targeting, recurrence/rrule, referral program, reviews feature, AI assistant chat + embeddings/RAG/eval harness, fraud rings + `ocr_similarity_dup` + `gps_mismatch` detectors, weekly fraud report, exports feature, deep analytics tabs (retention/top-products/CLV), marketing composer + calendar, generic (business-unbound) scan, TanStack/Zustand adoption (repo convention is RSC + server actions), Google Maps (OSM stack shipped), `/admin/reports`.
- [SCALE]: PayMongo, content publishing, AI analytics.

## Verification gates

- Per task: named tests red→green, full `vitest run` green, tsc clean (3 known), reviewer approval (spec + quality).
- Per wave: wave-scope review, live DB verification for any migration (MCP advisors + pgTAP), push to origin.
- Final: whole-branch review, live money-path re-verification, docs/ledger current.
