# Giya Receipts + Award Pipeline Slice - Design Spec

**Date:** 2026-07-25
**Status:** Approved (autonomous, recommended); ready for planning
**Canonical docs:** `20-data/24-schema-receipts-ai.md` (storage), `30-modules/36-receipt-ocr-pipeline.md` (stages S1-S10), `30-modules/37-fraud-detection.md` (signals + scoring), `30-modules/35-points-engine.md` (award), `30-modules/33-consumer-pwa.md` (capture UX), `10-architecture/13-api-standards.md` (envelope, idempotency, rate limits).
**Depends on:** campaigns+points (pure `computePoints`, `points_rules`, ledger), rewards (SECURITY DEFINER RPC + fence patterns), identity (`consumers.scan_blocked_until`, `gps_fraud_opt_in` already exist). Target: Supabase `dcnpuvtbftpbcjcvfnlt`.

## 1. Goal

The wedge: a consumer photographs a paper receipt and earns real points. This slice delivers submit -> OCR -> parse -> match -> validate -> fraud -> route -> **award** (the second and last place that writes the ledger) plus the consumer scan flow. Human review queues (business + admin UI) and the OCR container itself are the following slices; every hook they need is built here.

## 2. The OCR boundary (no credentials yet)

Doc 36 Stage 4 puts PaddleOCR + OpenCV in a private container (decision D1). We have no container and, per standing orders, external credentials arrive at the end. Therefore the pipeline is written against the doc's exact HTTP contract with two implementations behind one interface:

```ts
// src/features/receipts/server/ocr/provider.ts
type OcrRequest  = { requestId: string; imageUrl: string; preprocess: "auto" | string[]; langs: string[] }
type OcrResponse = { engine: string; engineVersion: string; preprocessOps: string[]; rawText: string;
                     blocks: {text: string; bbox: [number,number,number,number]; conf: number}[];
                     meanConfidence: number; durationMs: number }
```

- `httpOcrProvider` - POSTs `{OCR_SERVICE_URL}/v1/ocr` with `Authorization: Bearer {OCR_SERVICE_TOKEN}`, 30s timeout, maps 401/413/422 `IMAGE_UNREADABLE`/503 per doc 36. The real one, dormant.
- `stubOcrProvider` - deterministic, derives receipt text from the submission so the whole pipeline is exercisable and testable today. Always writes `engine='stub'` so stub data is never mistaken for real OCR, and the scan UI shows a dev-only note when active.
- Selection: `OCR_SERVICE_URL` unset -> stub. When the container arrives, set two env vars; no code changes.

`ai_usage_events` (`kind='ocr'`, `units=1`, `ref_id=receipt_id`) is written per call from day one so cost metering is not retrofitted.

## 3. Database

### 3.1 Migration 0017 - receipts domain + platform settings

Tables per doc 24, house conventions (`private.uuid_generate_v7()`, text + check constraints instead of PG enums, audit columns + `touch_updated_at` where doc 24 marks `+audit`, RLS enabled immediately, policies cite their P-pattern):

- `settings` (doc 25 slice, pulled forward): `(scope, scope_id, key)` unique, `value jsonb`. Doc 37 is explicit that thresholds are data, not code. Seeded with the platform defaults registry (fraud velocity caps, `fraud.review_threshold` 0.5, `fraud.phash_block_distance` 4 / `warn` 10, `ocr.approve_threshold` 0.8 / `ocr.review_threshold` 0.5, `receipts.max_age_days` 3, `fraud.cooldown_strikes` 3 / `cooldown_hours` 24). Business-scope rows override platform. Reader has hardcoded fallbacks so a missing row can never break the pipeline. The rest of doc 25 (jobs, audit_logs, notifications) lands with the jobs slice.
- `receipt_templates` - `parse_config jsonb` per doc 36 Stage 6, `version`, `validated_at`, `is_active`, `source_kind in ('pos','invoice','handwritten')`.
- `receipts` - `business_id` nullable until matched, `status in ('queued','processing','review','approved','rejected')`, `source in ('scan','pos','digital')`, `reject_reason in ('duplicate','unreadable','wrong_business','too_old','fraud_suspected','manual')`, `image_path`, `image_hash` (pHash hex), `sha256`, parsed fields, `match_confidence`, `parse_confidence`, `processed_at`, `reviewed_by`/`reviewed_at`, `device_id`, `submitted_lat/lng`. Audit columns but **no `deleted_at`** - receipts are evidence. Indexes verbatim from doc 24, notably `receipts_sha_unique` and the partial `receipts_number_unique` on `(business_id, receipt_number) where status in ('approved','review','processing')`.
- `receipt_line_items`, `ocr_results` (immutable, one row per attempt, no audit), `fraud_signals` (`signal` check list includes `staff_self_scan` - ratified MVP amendment A24.3, so no interim `velocity` encoding), `ai_usage_events`.
- Deferred FK from the campaigns slice now closed: `points_transactions.receipt_id references public.receipts(id)`.

`embeddings` / `ai_conversations` are deliberately excluded (pgvector + RAG, V1).

RLS - `private.is_active_staff(bid, roles)` table-truth throughout:

| Table | Policy |
|---|---|
| `receipts` | P3 select: consumer `user_id = auth.uid()`; staff owner/manager own tenant. **No client insert/update/delete** - every write is service-role, exactly like the ledger, so fraud and points cannot be bypassed. |
| `receipt_line_items` | consumer reads own via parent receipt; staff own tenant; service-role writes |
| `ocr_results` | staff own tenant only; service-role writes; never consumer-readable |
| `fraud_signals` | staff own tenant read (doc 37 review UI); **never consumer-readable** (doc 33: never expose fraud internals); service-role writes |
| `receipt_templates` | P1 owner/manager read + write |
| `settings` | platform rows world-readable to authenticated; business rows staff-of-that-business; writes service-role/admin only |
| `ai_usage_events` | staff own tenant read; service-role writes |

### 3.2 Migration 0018 - `award_receipt_points`

`public.award_receipt_points(p_receipt_id uuid, p_points integer, p_rule_snapshot jsonb, p_campaign_id uuid, p_expires_at timestamptz)` SECURITY DEFINER, `search_path = ''`, **service_role only** (grant pattern of `expire_claims`). Doc 36 Stage 10 / doc 35 section 3 in one transaction:

1. Load receipt `for update`; require `status='approved'`, `business_id` and `user_id` non-null, else `RECEIPT_NOT_AWARDABLE`.
2. One earn per receipt: existing `earn` row -> `RECEIPT_ALREADY_AWARDED` (`pt_receipt_earn_once` is the DB backstop).
3. Ensure + lock the `business_customers` pair row (same lock order as `claim_reward`).
4. Insert `points_transactions` `type='earn'`, `points > 0`, `balance_after = prev + points`, with `receipt_id`, `campaign_id`, `rule_snapshot`, `expires_at`.
5. Update the pair: `points_balance`, `lifetime_points`, `lifetime_spend_centavos` (+ receipt total), `first_visit_at` if null, `last_visit_at`, and `visit_count` **+1 only when the receipt's `receipt_date` falls on a different Asia/Manila day than `last_visit_at`** (doc 40's one-visit-per-consumer-per-business-per-day definition).
6. Set `receipts.processed_at`; return the ledger row id.

Rule math stays in the shared pure TS engine - doc 35 section 11 requires one implementation serving both preview and award. This RPC only performs the atomic write.

`loyalty_cards` advancement is deferred to the loyalty slice (no card rows exist yet); the RPC is written so adding it is additive.

### 3.3 Migration 0019 - storage

Private bucket `receipts`, path `{user_id}/{uuid}.jpg` (server-generated filename, doc 15). Storage policies: consumer INSERT restricted to their own `auth.uid()` prefix; SELECT owner + service role; **no client UPDATE/DELETE** (evidence). Review surfaces later read via 5-minute signed URLs.

### 3.4 pgTAP

`rls_receipts_smoke.sql` - consumer cannot insert/update a receipt, consumer sees only own, cross-tenant staff denied, consumer cannot read `fraud_signals` or `ocr_results`, `receipts_sha_unique` rejects a byte-identical second row, `receipts_number_unique` allows resubmission after rejection but blocks a live duplicate.
`rpc_award_smoke.sql` - award writes exactly one earn row with correct `balance_after`; double award raises `RECEIPT_ALREADY_AWARDED`; non-approved raises `RECEIPT_NOT_AWARDABLE`; `visit_count` increments once per Manila day and not twice on same-day receipts; ledger sum equals cached balance; authenticated/anon cannot execute the RPC.

## 4. Pure engines (TDD, zero IO)

| Module | Contract |
|---|---|
| `parse.ts` | `extractTotal`, `extractDate`, `extractReceiptNumber`, `extractMerchantName`, `extractLineItems`, `vatSanity` - template `parse_config` first, generic PH heuristics second (doc 36 Stage 7). PH date precedence `MM/dd/yyyy` then `MM/dd/yy` then `dd/MM/yyyy` only when day-slot > 12 disambiguates; ambiguous two-way dates prefer the **older** reading. Money `1,245.00` -> 124500 centavos. VAT check `tax ~= total x 12/112` and `subtotal + tax ~= total`, tolerance +/-PHP 0.05 or +/-0.5%; on failure keep `total` (authoritative) and null the inconsistent sub-field rather than guessing. |
| `confidence.ts` | `parseConfidence = 0.35 f(total) + 0.20 f(date) + 0.15 f(number) + 0.30 meanConfidence`, `f = 1 extracted+validated / 0.5 LLM-assisted / 0 missing`, `+0.05` if VAT passed, clamp 1.0. `routeReceipt` per doc 36 Stage 9 table, thresholds injected from `settings`. |
| `fraud.ts` | `scoreSignals` -> `composite = min(1, sum(score x weight))`, weights block 1.0 / warn 0.4 / info 0.1. `fraudVerdict` -> any block -> `block` (reason `duplicate` for the dup family, else `fraud_suspected`); staff self-scan -> `review` unconditionally; `composite >= fraud.review_threshold` -> `review`; else `pass`. Doc 37's worked example (0.44 passes, 0.60 reviews) is a test case verbatim. |
| `matching.ts` | Best-of scoring: TIN 0.98, alias 0.95, `0.9 x trigramSimilarity`, pre-bound floor 0.85; validated-template structural match `+0.05` capped at 1.0. `>= 0.85` accept, 0.5-0.85 review, `< 0.5` `wrong_business`. Pre-bound receipts are **verified, never silently re-bound**. |
| `phash.ts` | 64-bit DCT pHash from a 32x32 grayscale matrix (top-left 8x8 coefficients, median threshold, hex) + `hammingDistance`. Pure given pixels; `sharp` only supplies them. Bands 0-4 block / 5-10 warn / >10 no signal. |
| `velocity.ts` | Pure window evaluation: given counts + caps, emit the signal rows. Redis supplies the counts. |

## 5. Server pipeline

**Submission** (doc 36 Stage 1, two-step signed upload):
1. `POST /api/v1/receipts/uploads` -> Supabase `createSignedUploadUrl`, path forced to `{auth.uid()}/{uuid}.jpg`. 20/min.
2. `POST /api/v1/receipts` with `Idempotency-Key`: session + `scan_blocked_until` check (`403 CONSUMER_SCAN_BLOCKED` with `Retry-After`) + rate limit 6/min, 60/day -> validate `image_path` prefix matches the caller -> magic-byte sniff -> **sharp re-encode to canonical JPEG** (strips EXIF/GPS per doc 15) and overwrite the object -> sha256 over the canonical bytes (authoritative; `client_sha256` is advisory only) -> 64-bit pHash -> insert `status='queued'`. `receipts_sha_unique` violation -> `422 RECEIPT_DUPLICATE`, the only synchronous rejection. Respond `202 {receipt_id, status}`.

**Processing** - `processReceipt(receiptId)`, queue-shaped (takes an id, no request context), idempotent by status (only `queued`/`processing` proceed). Signed URL -> OCR provider -> persist `ocr_results` + `ai_usage_events` -> parse -> match business -> validate (readability, freshness `receipts.max_age_days`, not-future, postdates `businesses.verified_at`, number dedupe, amount sanity) -> fraud pass (pHash neighbours, `receipt_number_dup`, Redis velocity windows, `timestamp_anomaly`, `amount_anomaly`, `ai_confidence_low`, `staff_self_scan`) writing `fraud_signals` **even when the receipt is approved** -> route -> on `approved` load active `points_rules`, run the pure `computePoints`, call `award_receipt_points`. Invoked synchronously from the submit action today with a `TODO(queue)` marking the QStash enqueue point.

**Cooldown ladder step 2** (doc 37, automatic + auto-expiring + audited): 3 fraud-family rejections in 30 days -> set `consumers.scan_blocked_until = now() + fraud.cooldown_hours`.

Fraud always completes before award; there is no award-then-check path.

## 6. Consumer scan flow

`/scan` replaces the placeholder: live camera (`facingMode: environment`) or gallery pick, client-side downscale to 2048px long edge / JPEG q0.8 / target <= 1.5MB, hard 10MB reject before upload, then signed PUT + submit. `/scan/[receiptId]` status screen driven by Supabase Realtime on the receipt row (`id=eq.{id}`, sanctioned D5) with a 5s poll fallback: pending -> approved (points awarded, mango celebration) / review ("The store is checking this") / rejected (consumer-safe copy per reason - never fraud internals, never which signal tripped). Wallet gains a "Processing receipt" pending entry on 202 that flips on the event, plus a receipts history list. Business pages get a Scan CTA that pre-binds `business_id`.

## 7. Shared API library (pays down recorded debt)

`src/lib/api/handler.ts` per doc 13: typed envelope `{data}` / `{error:{code,message,details}}`, Zod request validation, session + role assertion, **Idempotency-Key** replay via Redis (store response, replay identical), rate limiting, `request_id` propagation. Applied to the new receipt routes; existing reward routes migrate opportunistically, not as part of this slice's critical path.

## 8. Constraints

Ledger writes only via SECURITY DEFINER RPCs; receipts client-write-fenced; fraud internals server-only; integer centavos and points; tokens-only UI; zero em-dashes; both themes; TS strict; Conventional Commits scope `receipts`. New npm dep: `sharp` (image canonicalization + pHash pixels) - no credentials. No external service required to run or test this slice.

## 9. Out of scope

Business + admin review queue UI (next slice, with the `POST .../review` endpoint), template management UI, real OCR container, QStash queueing, LLM parse-assist tier 3 (V1), `ocr_similarity_dup` S2 (V1), `gps_mismatch` S6 (V1), ring detection (V1), clawback, `loyalty_cards` advancement, push notifications on award.

## 10. Success criteria

1. 0017/0018/0019 applied live; both pgTAP suites green; `points_transactions.receipt_id` FK closed; storage bucket + policies live; no new ERROR advisors.
2. Pure engines exhaustively unit-tested, including doc 37's worked example and doc 36's confidence formula.
3. Live E2E with the stub provider: submit -> approved -> exactly one earn row with correct `balance_after`, wallet balance rises, `processed_at` set.
4. Byte-identical resubmission -> `422 RECEIPT_DUPLICATE`; double award refused; `visit_count` increments once per Manila day; a staff member scanning their own store's receipt lands in `review`.
5. Gates green (lint, `tsc --noEmit` modulo the 3 pre-existing test-file errors, full vitest suite, build); scan flow works live in the browser in both themes.
