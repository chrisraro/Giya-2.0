# 36 — Receipt Intelligence Pipeline

The money flow (`../10-architecture/10-system-architecture.md` F1): consumer submits a receipt photo, the pipeline turns it into structured, validated purchase data and hands it to the points engine (`35-points-engine.md`). Storage contract: `../20-data/24-schema-receipts-ai.md`. Fraud stage detail: `37-fraud-detection.md`. Queue mechanics: `39-background-jobs.md`. Everything here is `[MVP]` unless tagged.

## Pipeline overview

```
submit → queue(ocr.process) → preprocess → OCR → parse → business match → template match
       → field extraction → validation → fraud (37) → outcome → points award (35) → notify
```

Each stage writes its evidence: image + hashes on `receipts`, raw OCR on `ocr_results` (immutable, one row per attempt), extracted lines on `receipt_line_items`, tripped checks on `fraud_signals`. Authoritative parsed fields are copied onto `receipts` (`merchant_name`, `receipt_number`, `receipt_date`, `subtotal_centavos`, `tax_centavos`, `total_centavos`, `template_id`, `match_confidence`, `parse_confidence`).

`receipts.status` state machine (values per `../20-data/20-data-model.md` enum registry):

```
queued → processing → approved
                    → review → approved | rejected   (human decision, reviewed_by/reviewed_at set)
                    → rejected (reject_reason: duplicate|unreadable|wrong_business|too_old|fraud_suspected|manual)
```

Latency budget (F1): enqueue ack < 500ms; end-to-end p95 < 60s `[MVP]`, < 20s `[V1]`.

## Stage 1 — Submission

### Client capture/crop UX contract (consumer PWA, `33-consumer-pwa.md`)

- Sources: live camera (`camera=(self)` per `../10-architecture/15-security.md`) or gallery pick.
- Client-side crop with edge-detection assist; user confirms crop. Downscale to max 2048px long edge, re-encode JPEG quality 0.8, target ≤ 1.5MB before upload (canonical compression contract: `33-consumer-pwa.md` §Scanner). Accepted input formats: JPEG, PNG, WebP; HEIC converted client-side.
- Hard cap 10MB (`../10-architecture/15-security.md` upload safety); client rejects larger before upload.
- Scan entry points: business page scanner (passes `business_id` — the common path) and the generic home scanner `[V1]` (no `business_id`; resolved by matching, below).
- On 202 the client subscribes to Realtime (below) and renders the receipt as a "pending" wallet entry immediately.

### Upload + submit API

Two-step, pre-signed upload (preferred; multipart fallback for small images):

1. `POST /api/v1/receipts/uploads` → `{ data: { upload_url, image_path } }`. Signed PUT URL, TTL 5 min, path forced to `receipts/{user_id}/{uuid}.jpg` (bucket `receipts` is private; filename server-generated per `../10-architecture/15-security.md`).
2. `POST /api/v1/receipts` with `Idempotency-Key` header (`../10-architecture/13-api-standards.md`), body `{ image_path, client_sha256?, business_id?, submitted_lat?, submitted_lng?, device_id? }`. `submitted_lat/lng` accepted only when `consumers.gps_fraud_opt_in` is true; otherwise stripped. `client_sha256` (hash of the bytes the client uploaded) is **advisory only** — used for a fast duplicate pre-check and as the offline outbox dedupe key (`41-pwa-offline.md`); it is never stored as `receipts.sha256`.

Server ingest (synchronous, must finish < 500ms excluding the sharp re-encode which runs in the same request but is budgeted):

1. `requireSession` + verified email + rate limit **6/min, 60/day per consumer** (`../10-architecture/13-api-standards.md`).
2. Validate `image_path` prefix matches `auth.uid()`; magic-byte sniff; re-encode via sharp to canonical JPEG (strips EXIF/GPS payloads per `../10-architecture/15-security.md`) and overwrite the stored object.
3. Compute `sha256` over the canonical stored bytes (this server-computed value is the **authoritative** `receipts.sha256`; it will differ from `client_sha256` because of the re-encode — replay protection across retries comes from the `Idempotency-Key`, not the client hash) and `image_hash` = 64-bit DCT pHash (grayscale, 32×32 downsample, top-left 8×8 DCT coefficients, median-thresholded), stored hex.
4. `INSERT receipts (status='queued', source='scan', image_path, image_hash, sha256, business_id?, device_id, submitted_lat/lng)`. A violation of `receipts_sha_unique` aborts here → `422 RECEIPT_DUPLICATE` (the only fully synchronous rejection).
5. Enqueue `ocr.process` with `payload={receipt_id}` and `jobs.dedupe_key = sha256`; `jobs_dedupe_idx` (unique on `(queue, dedupe_key)` while `queued/running`, `../20-data/25-schema-platform.md`) prevents concurrent double-processing.
6. Respond `202 { data: { receipt_id, status: "queued" } }`.

## Stage 2 — Queue

Queue `ocr.process` (QStash → OCR worker Route Handler, `39-background-jobs.md`). `jobs.max_attempts = 3` for this queue (override of the column default 5 — OCR failures are rarely transient beyond that). Worker is idempotent by job-id and by receipt status check: if `receipts.status` is not `queued`/`processing`, ack and exit.

## Stage 3 — Preprocessing (OpenCV, inside the OCR service)

Worker requests preprocessing as part of the OCR call (single round-trip). Standard op chain, applied conditionally by image analysis, `auto` mode:

| Op | When | Notes |
|---|---|---|
| `perspective` | 4-point document contour found | Warp to rectangle |
| `deskew` | Hough-line skew > 1.5° | Rotation correction |
| `denoise` | Estimated noise above threshold | fastNlMeansDenoising |
| `contrast` | Low dynamic range (faded thermal) | CLAHE |
| `adaptive_threshold` | Uneven lighting / shadows | Gaussian adaptive binarization |

Ops actually applied are returned by the service and recorded verbatim in `ocr_results.preprocess_ops` (`text[]`) — required for debugging quality regressions against the golden set (`../50-ops/51-testing-strategy.md`).

## Stage 4 — OCR service contract (PaddleOCR + OpenCV, containerized)

Per decision D1 (`../10-architecture/10-system-architecture.md`): private HTTP container (Fly.io/Railway/Cloud Run), stateless, no DB access, no business logic — image in, structured text out. Called only by the OCR worker.

```
POST {OCR_SERVICE_URL}/v1/ocr
Authorization: Bearer {OCR_SERVICE_TOKEN}        # static service token, per-environment secret
Content-Type: application/json
{
  "request_id": "req_01J…",                      # propagated for log correlation
  "image_url": "https://…signed…",               # 5-min signed URL to the receipts object
  "preprocess": "auto",                          # or explicit ["deskew","adaptive_threshold"]
  "langs": ["en"],                               # English covers PH receipts; "fil" reserved
  "return_blocks": true
}
→ 200
{
  "engine": "paddleocr",
  "engine_version": "2.8.1",
  "preprocess_ops": ["perspective","deskew","adaptive_threshold"],
  "raw_text": "JOLLI CAFE\nTIN 123-456-789-000\n…",
  "blocks": [ { "text": "TOTAL 245.00", "bbox": [34, 812, 310, 840], "conf": 0.97 }, … ],
  "mean_confidence": 0.91,
  "duration_ms": 2140
}
Errors: 401 (bad token) · 413 (image too large) · 422 {"code":"IMAGE_UNREADABLE"} · 503 (overloaded)
GET /healthz → 200 {"status":"ok","engine_version":"…"}   # deploy gate + uptime probe
```

Timeouts: service internal budget 25s; worker HTTP timeout 30s; timeout/503 counts as a retryable attempt. Response is persisted verbatim to `ocr_results` (`engine`, `engine_version`, `raw_text`, `blocks`, `mean_confidence`, `preprocess_ops`, `duration_ms`, `attempt`). One `ai_usage_events` row `kind='ocr'`, `units=1` (page), `ref_id=receipt_id` per call (cost metering, `../20-data/24-schema-receipts-ai.md`).

## Stage 5 — Business matching

Goal: set `receipts.business_id` + `receipts.match_confidence` (0–1).

**Pre-bound scan (MVP default):** submitted from a business page, `business_id` already set. Matching still runs as verification — if extracted merchant identity strongly contradicts the bound business, that is a `wrong_business` outcome, not a silent re-bind.

**Generic scan `[V1]`:** no `business_id`; candidates scored across all `active` businesses.

Scoring inputs (best-of, not additive):

| Evidence | Score contribution |
|---|---|
| TIN in `raw_text` equals a template `parse_config.tin` | 0.98 |
| Exact/normalized hit on template `parse_config.merchant_aliases` | 0.95 |
| Trigram similarity of extracted merchant line vs `businesses.name` via `businesses_name_trgm` GIN index (`similarity() >= 0.4` prefilter) | `0.9 × similarity` |
| Pre-bound `business_id` with no contradicting evidence | floor of 0.85 |

`match_confidence = max(inputs)`; a validated-template structural match (Stage 6) adds +0.05, capped at 1.0. Thresholds:

- `>= 0.85` → auto-accept match.
- `0.5 – 0.85` → route receipt to `review` (reviewer confirms the business).
- `< 0.5` → `rejected`, `reject_reason='wrong_business'` (pre-bound) or unmatched-discard `[V1]` (generic scan; consumer prompted to pick the business and resubmit).

## Stage 6 — Template matching & the template system

`receipt_templates` (`../20-data/24-schema-receipts-ai.md`): business-uploaded reference receipts that teach the parser. Multiple active templates per business (e.g. "Main branch POS" + "Handwritten pad"); `source_kind ∈ ('pos','invoice','handwritten')`.

**Lifecycle:** upload sample (`sample_path`, bucket `invoice-templates`, private per `../10-architecture/15-security.md`) → OCR test run (same service call; summary stored in `ocr_test_result`) → `parse_config` auto-suggested from the test run, then edited by owner/manager in the portal → test passes acceptance (all anchor fields extracted from the sample) → `validated_at` set → usable in the pipeline. Any `parse_config` edit increments `version` and clears `validated_at` until re-tested. `is_active=false` retires a template without deleting evidence.

**Selection at parse time:** score each active validated template of the matched business by (a) `source_kind` layout heuristics — dense monospaced lines + VAT block ⇒ `pos`; letterhead + "INVOICE"/"SI No." ⇒ `invoice`; low block-alignment + low OCR confidence ⇒ `handwritten` — and (b) fraction of `layout_anchors` found in `blocks`. Highest scorer wins; winner recorded in `receipts.template_id`; no winner ⇒ generic heuristics path.

**`parse_config` JSONB spec** (the shape referenced by `../20-data/24-schema-receipts-ai.md`):

```jsonc
{
  "merchant_aliases": ["JOLLI CAFE", "JOLLI CAFE CORP", "JOLLICAFE"],
  "tin": "123-456-789-000",
  "receipt_no_regex": "(?:SI|OR|INV)[#:\\s-]*([0-9]{4,12})",
  "date_formats": ["MM/dd/yyyy", "MM-dd-yy", "MMM dd, yyyy"],   // priority order
  "total_keywords": ["TOTAL", "AMOUNT DUE", "TOTAL DUE"],
  "subtotal_keywords": ["SUBTOTAL", "VATable Sales"],
  "tax_keywords": ["VAT", "12% VAT", "VAT Amount"],
  "layout_anchors": {                       // normalized [0–1] page regions
    "header":      { "y": [0.0, 0.15] },    // merchant identity lives here
    "line_items":  { "y": [0.25, 0.70] },
    "totals":      { "y": [0.70, 0.92], "align": "right" },
    "footer_keywords": ["THIS SERVES AS", "OFFICIAL RECEIPT"]
  },
  "line_item_pattern": "^(?<qty>\\d+)\\s+(?<name>.+?)\\s+(?<amount>[\\d,]+\\.\\d{2})$",
  "amount_sanity": { "min_total_centavos": 1000, "max_total_centavos": 2000000 }
}
```

Handwritten-pad example (typical resto order pad / "temporary receipt"):

```jsonc
{
  "merchant_aliases": ["ALING NENA'S", "ALING NENAS EATERY"],
  "receipt_no_regex": "No[.:\\s]*([0-9]{3,6})",        // pre-printed pad number
  "date_formats": ["M/d/yy", "M-d-yyyy"],
  "total_keywords": ["TOTAL", "TTL"],
  "tax_keywords": [],                                   // non-VAT: tax extraction skipped
  "layout_anchors": { "totals": { "y": [0.6, 1.0] } },
  "handwriting": { "min_block_conf": 0.35, "digits_only_amounts": true },
  "amount_sanity": { "min_total_centavos": 2000, "max_total_centavos": 500000 }
}
```

## Stage 7 — Field extraction (parsing)

Three-tier strategy; each field records which tier produced it (in the parse trace kept on the job log, not the DB):

1. **Template hints first** — the matched template's `parse_config` regexes, keywords, and `layout_anchors` applied against `ocr_results.blocks` (bbox-aware: totals sought in the totals region, merchant in header).
2. **Generic heuristics second** — keyword dictionaries (superset of all template keywords + BIR-standard receipt vocabulary), right-aligned money-column detection, largest-amount-below-line-items fallback for total.
3. **LLM parse-assist third `[V1]`** — only when tiers 1–2 leave `total_centavos` or `receipt_date` empty and `mean_confidence >= 0.5`: Groq structured extraction (JSON-schema-constrained) over `ocr_results.raw_text`. Output is a *candidate* requiring the same validation below; it can never raise `parse_confidence` above the `review` band on its own (golden rule 5: AI augments, never decides). Metered: `ai_usage_events` `kind='parse_assist'` with token `units` and `cost_micros`; per-business daily budget per `../10-architecture/15-security.md` rate/abuse rules.

Field rules:

- **`merchant_name`** — header-region block(s); normalized (uppercase, collapse whitespace) for matching; raw form stored.
- **`receipt_number`** — `receipt_no_regex` or generic `(SI|OR|INV|RECEIPT|TRANS)[#:. ]*\d{3,}` patterns. Stored digits+significant prefix, normalized (leading zeros preserved — it participates in `receipts_number_unique`).
- **`receipt_date`** — PH formats, tried in template priority order then: `MM/dd/yyyy` (dominant PH POS convention), `MM/dd/yy`, `dd/MM/yyyy` (only when day-slot > 12 disambiguates), `MMM dd, yyyy`, `yyyy-MM-dd`. Time appended when a `HH:mm` token adjoins; else 12:00 `Asia/Manila` assumed, stored UTC `timestamptz`. Ambiguous two-way dates where both readings are valid and differ in validity outcome ⇒ prefer the reading that is *older* (conservative) and add an `ai_confidence_low`-style note to the review payload.
- **Amounts** — `subtotal_centavos`, `tax_centavos`, `total_centavos` parsed from money tokens (`1,245.00` → 124500 centavos; integer centavos per `../10-architecture/13-api-standards.md`). **VAT 12% sanity check** (PH VAT-inclusive receipts): expect `tax ≈ total × 12/112` and `subtotal + tax ≈ total`, tolerance ±₱0.05 or ±0.5%. Pass ⇒ small confidence boost; fail ⇒ keep `total` (authoritative for points) and null out the inconsistent sub-field rather than guessing. Non-VAT templates (empty `tax_keywords`) skip the check.
- **Line items → `receipt_line_items`** — `line_item_pattern` or generic qty/name/amount columnar split; one row per line with `raw_text`, `qty`, `unit_price_centavos`, `line_total_centavos`, `sort`. Product linkage: fuzzy match `raw_text` vs the business's `products` (trigram over name); `product_id` + `match_score` set when `>= 0.6`, else null (unmatched is fine — line items are analytics enrichment (`40-analytics.md`), never a gate on approval).

## Stage 8 — Validation (business rules)

Applied to the parsed candidate before fraud scoring; failures set terminal status directly:

| Rule | Check | Failure |
|---|---|---|
| Readability | `total_centavos` present AND (`receipt_date` OR `receipt_number`) present | `rejected / unreadable` |
| Freshness | `receipt_date >= now() - max_age_days` (default **3 days**; business-configurable via `settings` row `scope='business'`, key `receipts.max_age_days`, clamp 1–30; platform default row `scope='platform'`) | `rejected / too_old` |
| Not future | `receipt_date <= now() + 24h` (TZ grace) | `timestamp_anomaly` fraud signal (37), not auto-reject |
| Postdates activation | `receipt_date >= businesses.verified_at` | `rejected / too_old` (predates the program) |
| Number dedupe | insert-time conflict on `receipts_number_unique` (`(business_id, receipt_number)` where status ∈ approved/review/processing — rejected rows excluded, so resubmission after rejection works, `../20-data/24-schema-receipts-ai.md` note) | `rejected / duplicate` + `receipt_number_dup` signal |
| Amount sanity | within template `amount_sanity` bounds | route to `review` |

## Stage 9 — Confidence model & outcome routing

```
parse_confidence = 0.35·f(total)  + 0.20·f(date) + 0.15·f(receipt_number)
                 + 0.30·mean_confidence(ocr_results)
  where f(field) = 1 if extracted & validated, 0.5 if extracted via LLM parse-assist, 0 if missing
  bonus: +0.05 if VAT sanity check passed (cap 1.0)
```

Routing (defaults in `settings` `scope='platform'` keys `ocr.approve_threshold` / `ocr.review_threshold`):

| Condition | Outcome |
|---|---|
| `parse_confidence >= 0.8` AND `match_confidence >= 0.85` AND fraud pass (37) | `approved` (auto) |
| `0.5 <= parse_confidence < 0.8`, or match in review band, or fraud score in review band | `review` |
| `parse_confidence < 0.5` | `rejected / unreadable` |
| Any fraud `block` signal | `rejected` (reason per 37) |

Sub-threshold `mean_confidence` (< 0.5) additionally emits an `ai_confidence_low` fraud signal (severity `info`) so reviewers see it as context.

### Human review queue

- **Who:** business `owner`/`manager` review their own tenant's `review` receipts (`receipts_biz_status_idx`, RLS P1 scope); platform `admin`/`support` handle escalations, unmatched-business receipts, and fraud-flagged items (`31-admin-portal.md`).
- **UI contract:** side-by-side — zoomable receipt image (5-min signed URL, `../10-architecture/15-security.md`) beside an editable field form (merchant, number, date, subtotal/tax/total, line items) pre-filled with parsed values and per-field source/confidence chips; fraud signal list with `evidence` rendered (37); actions **Approve** (with edits) / **Reject** (reason from `receipt_reject_reason` enum + `reject_note`).
- **SLA:** target < 24h `[MVP]`, < 4h business-hours `[V1]`; queue-age surfaced on the business dashboard; admin alert when a tenant's oldest review item > 48h (`../50-ops/52-monitoring-observability.md`).
- **Approve path is identical to auto-approval:** the same service function transitions `review → approved`, sets `reviewed_by`/`reviewed_at`, persists edited fields to `receipts`, and invokes the points engine — no separate code path, so ledger invariants hold (one `earn` per receipt via `pt_receipt_earn_once`, `../20-data/23-schema-campaigns.md`).

## Stage 10 — Points award handoff

On `approved` (auto or human), in one transaction (`35-points-engine.md`): points engine evaluates active `points_rules` against `total_centavos`/visit, inserts the `points_transactions` `earn` row with `receipt_id` provenance and `rule_snapshot`, updates `business_customers` (`points_balance`, `visit_count`, `lifetime_spend_centavos`, `last_visit_at`), advances `loyalty_cards`, sets `receipts.processed_at`, enqueues `notify.push` (`kind='points_awarded'`). Rejection enqueues `kind='receipt_rejected'` with the reason.

## Retry, timeouts, DLQ

- `ocr_results.attempt` numbers each OCR call; **max 3 attempts** (`jobs.max_attempts=3`), QStash exponential backoff per `39-background-jobs.md`.
- Retryable: OCR service 503/timeout, signed-URL expiry (worker re-requests a fresh signed URL for the stored image — the image itself is never re-requested from the consumer), transient DB errors. Non-retryable: `IMAGE_UNREADABLE` 422 (falls through to the confidence/rejection path immediately).
- Attempts exhausted → job `status='dead'` (DLQ per `39-background-jobs.md`), `receipts.status='rejected'`, `reject_reason='manual'`, `reject_note='processing_failed'`; consumer notified and may resubmit (rejected rows don't hold `receipts_number_unique` or block `sha256`? — `sha256` **does** still block byte-identical resubmission; consumer must retake the photo, which is the desired UX). DLQ items surface on the admin OCR monitoring dashboard `[V1]`.

## Realtime status + optimistic wallet UX

- Channel: Supabase Realtime, Postgres changes on `receipts` filtered `id=eq.{receipt_id}` — consumer subscribes right after the 202. RLS-authorized (consumer sees own rows only, P3), per D5 (`../10-architecture/10-system-architecture.md`).
- Business review-queue counter: tenant-scoped channel on `receipts` filtered `business_id=eq.{id},status=eq.review` for the portal badge.
- Wallet UX contract: on 202 the wallet inserts a local "Processing receipt…" pending entry (no points amount — the amount is unknown until parse). `approved` event carries the awarded points in the notification payload → entry flips to confirmed with points; `review` → "Being reviewed by the store"; `rejected` → reason + retake CTA. Fallback: poll `GET /api/v1/me/receipts/{id}` every 5s if the socket drops (PWA offline queue: `41-pwa-offline.md` `[V1]`).

## API surface

All per `../10-architecture/13-api-standards.md` (envelope, cursor pagination, Zod, idempotency).

| Method & path | Auth | Notes |
|---|---|---|
| `POST /api/v1/receipts/uploads` | consumer | Signed PUT URL, 20/min upload limit |
| `POST /api/v1/receipts` | consumer | Idempotency-Key required; 202; 6/min, 60/day |
| `GET /api/v1/me/receipts` | consumer | Own history, cursor, `?status=` filter |
| `GET /api/v1/me/receipts/{id}` | consumer | Detail + `receipt_line_items` |
| `GET /api/v1/businesses/{businessId}/receipts` | owner/manager | `?status=review` = review queue |
| `POST /api/v1/businesses/{businessId}/receipts/{id}/review` | owner/manager | `{action:'approve'|'reject', fields?, reject_reason?, reject_note?}`; audited |
| `GET/POST /api/v1/businesses/{businessId}/receipt-templates` | owner/manager | CRUD |
| `PATCH /api/v1/businesses/{businessId}/receipt-templates/{id}` | owner/manager | `parse_config` edit bumps `version`, clears `validated_at` |
| `POST /api/v1/businesses/{businessId}/receipt-templates/{id}/test` | owner/manager | OCR test run → `ocr_test_result`, sets `validated_at` on pass |
| `GET /api/v1/admin/receipts` | admin | Escalation/unmatched/DLQ queue |
| `POST /api/v1/admin/receipts/{id}/review` | admin | Reason required (audit, `../10-architecture/15-security.md`) |

Error codes registered by this module (422 unless noted):

| Code | When |
|---|---|
| `RECEIPT_DUPLICATE` | `sha256` conflict at submit, or number/near-dup at processing (surfaced via status) |
| `RECEIPT_UNREADABLE` | Confidence floor / readability rule |
| `RECEIPT_TOO_OLD` | Freshness / postdates-activation rule |
| `RECEIPT_WRONG_BUSINESS` | Match confidence < 0.5 on pre-bound scan |
| `RECEIPT_INVALID_IMAGE` (400) | Failed magic-byte sniff / oversize / bad path |
| `RECEIPT_NOT_REVIEWABLE` (409 `CONFLICT` family) | Review action on a non-`review` receipt |
| `TEMPLATE_NOT_VALIDATED` (409) | Activating an untested template |
| `DEPENDENCY_UNAVAILABLE` (503) | OCR service down (submit still 202s; failure is async) |

## Metrics (targets = roadmap exit criteria, `../00-product/02-roadmap.md`)

| Metric | Definition | Target |
|---|---|---|
| Scan success rate | approved / (approved+rejected), excl. fraud | trend, alert on drops |
| Auto-approval rate | auto-approved / all approved+review+rejected | **≥70% `[MVP]`, ≥85% `[V1]`** |
| Scan→award p95 | submit 202 → `earn` row | **<60s `[MVP]`, <20s `[V1]`** |
| Review queue age p95 | `review` entry → decision | <24h `[MVP]` |
| OCR mean confidence / attempt rate | from `ocr_results` | regression alarms (`../50-ops/52-monitoring-observability.md`) |
| Parse-assist spend | `ai_usage_events` `kind='parse_assist'` | within per-business budget `[V1]` |

## Future sources `[SCALE]`

`receipts.source` already admits `pos` and `digital` (`../20-data/20-data-model.md` enum registry; roadmap rewrite-avoidance list). Adapter concept: a source adapter transforms an external event (POS webhook line-item payload, e-receipt email/URL) into the *same* post-OCR candidate shape (merchant, number, date, amounts, line items) and enters the pipeline at Stage 8 (validation) with `parse_confidence=1.0` and no image (`image_path`/hashes nullable for non-scan sources — see delta below). Fraud, validation, review routing, and points award are unchanged — one pipeline, many mouths.

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. `ocr_results.error` — **ACCEPTED** [MVP] (A24.1).
2. `receipts.parse_meta` — **ACCEPTED** [MVP] (A24.2).
3. Relax `receipts.image_path`/`image_hash`/`sha256` to nullable for non-scan sources — **DEFERRED [SCALE]**, lands with the POS/digital source adapters (A24.8).
4. Settings keys (`receipts.max_age_days`, `ocr.approve_threshold`, `ocr.review_threshold`, `ocr.max_attempts`) — data, not DDL; recorded in 26 "Non-DDL registrations".
