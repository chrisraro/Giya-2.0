# Plan: Receipts + Award Pipeline Slice

**Spec:** `../specs/2026-07-25-receipts-award-design.md`
**Branch:** `feat/receipts-award`
**Method:** subagent-driven-development - one fresh implementer subagent per task, one reviewer subagent per task (opus for SQL and money paths), controller does live verification via Supabase MCP + Puppeteer, final whole-branch review before merge.
**Ledger:** append outcomes to `.superpowers/sdd/progress.md` after every task.

Every task: TDD (red -> green -> refactor), gates green before hand-off (`npm run lint`, `npx tsc --noEmit`, `npx vitest run`, `npm run build` where UI changed), Conventional Commit scope `receipts`, no em-dashes, tokens-only UI, both themes.

---

## Wave 1 - database (sequential, controller applies)

### T1. Migration 0017: receipts domain + platform settings
Author `supabase/migrations/0017_receipts.sql` per spec 3.1 and doc 24. Tables: `settings`, `receipt_templates`, `receipts`, `receipt_line_items`, `ocr_results`, `fraud_signals`, `ai_usage_events`. House conventions: `private.uuid_generate_v7()`, text + check constraints (no `create type`), `touch_updated_at` triggers where doc 24 marks `+audit`, RLS enabled immediately after each table, every policy comments its P-pattern, all staff policies use `private.is_active_staff`. Include doc 24's indexes verbatim (`receipts_sha_unique`, partial `receipts_number_unique`, `receipts_hash_idx`, `receipts_biz_status_idx`, `receipts_review_idx`, `fraud_signals_consumer_idx`). `receipts` has NO `deleted_at`. `fraud_signals.signal` check list includes `staff_self_scan`. Close the deferred FK: `points_transactions.receipt_id references public.receipts(id)`. Seed the platform `settings` defaults registry from doc 37 + doc 36.
Also author `supabase/tests/rls_receipts_smoke.sql` per spec 3.4 using **insert-returning CTE fixtures only** (never global name lookups - they collide with live data).
**Reviewer: opus, tenancy + evidence-integrity focus.** Do not apply until review passes; controller applies via MCP, runs pgTAP, checks advisors, regenerates types.

### T2. Migration 0018: `award_receipt_points`
Author `supabase/migrations/0018_award_receipt_points.sql` per spec 3.2 plus `supabase/tests/rpc_award_smoke.sql`. Service-role-only grants mirroring `0016_claim_expiry_sweep`. Read the **live** definitions of `claim_reward` and the `business_customers` grants with `pg_get_functiondef` before writing, so lock order and the balance-cache fence match what is deployed rather than what the spec paraphrases.
**Reviewer: opus, money-path focus** - atomicity, lock ordering vs `claim_reward` (deadlock risk), `balance_after` correctness under concurrency, Manila-day visit logic across DST-free but offset-bearing timestamps, one-earn-per-receipt.

### T3. Migration 0019: storage bucket + policies
`receipts` private bucket, owner-prefix INSERT, owner/service SELECT, no client UPDATE/DELETE. Verify live that a second user cannot read another's object.

---

## Wave 2 - pure engines (parallel, no IO, exhaustive TDD)

### T4. `src/features/receipts/parse.ts`
Field extraction per doc 36 Stage 7 and spec 4. Template-config tier then generic PH heuristics. Tests must cover: PH date format precedence and the ambiguous-date older-reading rule, money tokens with thousands separators, VAT sanity pass/fail and the null-the-sub-field-not-the-total behaviour, receipt numbers with preserved leading zeros, line-item columnar split, and garbage input returning nulls rather than throwing.

### T5. `src/features/receipts/confidence.ts`
`parseConfidence` + `routeReceipt` per doc 36 Stage 9, thresholds injected (not hardcoded). Test the formula at boundaries (0.79 vs 0.80, match 0.849 vs 0.85), the LLM-assist 0.5 weight, the VAT bonus clamp at 1.0, and every row of the routing table.

### T6. `src/features/receipts/fraud.ts` + `velocity.ts`
`scoreSignals`, `fraudVerdict`, pure velocity-window evaluation per doc 37. Doc 37's worked example is a verbatim test (0.7x0.4 + 0.4x0.4 = 0.44 passes; +0.16 = 0.60 reviews). Test: any block wins regardless of composite; dup-family block maps to `duplicate` and others to `fraud_suspected`; `staff_self_scan` forces review unconditionally even at composite 0; composite clamps at 1.0.

### T7. `src/features/receipts/matching.ts` + `phash.ts`
Best-of business matching per doc 36 Stage 5 (test that pre-bound receipts are verified and never silently re-bound, and that contradicting evidence yields `wrong_business`). DCT pHash from a 32x32 grayscale matrix + hamming distance; test against known-identical, slightly-perturbed, and unrelated matrices, and the 0-4 / 5-10 / >10 bands.

---

## Wave 3 - server plumbing

### T8. Settings loader + OCR provider
`src/features/receipts/server/settings.ts` - typed reader over the `settings` table, business-scope overriding platform-scope, hardcoded fallbacks so a missing row cannot break the pipeline, memoized per request. `src/features/receipts/server/ocr/provider.ts` + `http.ts` + `stub.ts` per spec 2, selected by `OCR_SERVICE_URL` presence, `OCR_SERVICE_TOKEN` added to `src/lib/env.ts` as optional server env. Tests mock `fetch` and cover 401/413/422/503/timeout mapping. Stub is deterministic and always reports `engine='stub'`.

### T9. Shared API handler
`src/lib/api/handler.ts` per doc 13 and spec 7: envelope, Zod validation, session/role assertion, Idempotency-Key replay via Redis, rate limiting, `request_id`. Unit-tested including a replayed Idempotency-Key returning the stored response without re-executing the handler body.

### T10. Submission
`POST /api/v1/receipts/uploads` and `POST /api/v1/receipts` per spec 5, plus `src/features/receipts/server/submit.ts` (sharp canonicalization, sha256, pHash, insert). Add `sharp`. Enforce prefix ownership, magic-byte sniff, 10MB cap, `scan_blocked_until`, and map `receipts_sha_unique` violations to `422 RECEIPT_DUPLICATE`.

### T11. Processing orchestration + award
`src/features/receipts/server/process.ts` per spec 5: the full stage chain, `fraud_signals` written even on approval, `ai_usage_events` per OCR call, cooldown ladder step 2, and the award handoff through the pure `computePoints` into `award_receipt_points`. Status-idempotent. Integration tests with the stub provider and a fake Supabase client covering: auto-approve path awards once, review path awards nothing, block path rejects with the right reason, and reprocessing an already-approved receipt is a no-op.

---

## Wave 4 - consumer UI

### T12. `/scan` capture and submit
Camera + gallery, client compression per doc 33, upload, submit, redirect to status. Reuse the existing camera-lifecycle patterns from `redeem-scanner.tsx` (that component already solved stream cleanup). Business-page Scan CTA pre-binds `business_id`.

### T13. `/scan/[receiptId]` status + wallet integration
Realtime subscription with poll fallback, the three outcome states with consumer-safe copy, pending wallet entry that flips on the event, and a receipts history list. `GET /api/v1/me/receipts` and `GET /api/v1/me/receipts/{id}`.

---

## Wave 5 - verification and close

### T14. Live E2E (controller)
Against `dcnpuvtbftpbcjcvfnlt` with the stub provider: submit a receipt as the seeded consumer, watch it reach `approved`, assert exactly one `earn` ledger row with correct `balance_after`, `processed_at` set, wallet balance risen, ledger sum equals cached balance. Then the abuse matrix: byte-identical resubmission -> `RECEIPT_DUPLICATE`; second award attempt -> `RECEIPT_ALREADY_AWARDED`; same-day second receipt does not double `visit_count`; a staff member scanning their own store lands in `review`; a consumer cannot read `fraud_signals` or another consumer's storage object. Browser pass on `/scan` in both themes.

### T15. Docs + ledger
Update `supabase/README.md` (migration ledger rows for 0017-0019, storage bucket note, any new advisor acceptances), add `src/features/receipts/README.md` documenting the OCR stub boundary and how to switch to the real container, and append outcomes to `.superpowers/sdd/progress.md`. Then whole-branch review (fable), fix wave, merge to `main`.

---

## Risks

- **Deadlock between `award_receipt_points` and `claim_reward`** if lock order diverges. Mitigated by T2 reading the live `claim_reward` body first and locking `business_customers` in the same order.
- **sharp on Windows dev + Vercel later.** Standard prebuilt binaries; if install misbehaves, the canonicalization step degrades to pass-through with a recorded TODO rather than blocking the slice - but sha256 must then be computed over the original bytes, still server-side.
- **Stub OCR masking real parse weakness.** Accepted and explicit: the parse engine is tested against realistic PH receipt text fixtures independent of the provider, so swapping in PaddleOCR exercises already-tested code.
- **Scope.** This is the largest slice so far. Review queue UI is deliberately deferred; receipts routed to `review` simply wait, which is correct behaviour, not a gap.
