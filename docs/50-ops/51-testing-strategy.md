# 51 — Testing Strategy

What we test, at which layer, and what gates CI (`50-environments-deployment.md` pipeline stages). Definition of Done per `../10-architecture/14-development-standards.md` applies to every feature.

## The pyramid

| Layer | Tooling | Scope | Speed budget |
|---|---|---|---|
| Unit (widest) | Vitest | Pure domain logic — no I/O | < 60s total |
| Integration | Vitest + local Supabase (CLI stack) | Services against a real Postgres (RLS on), queue workers via direct-invoke harness (`../30-modules/39-background-jobs.md`) | < 5 min |
| DB policy | pgTAP (`supabase/tests/`) | RLS matrix + constraints/triggers | < 3 min |
| API contract | Vitest + OpenAPI validation | Handlers vs the generated spec (`../10-architecture/13-api-standards.md`) | < 2 min |
| E2E (narrowest) | Playwright (`e2e/`) | Golden paths on preview/staging deploys | < 15 min |

### Unit — pure domain logic (the 90%+ zone)

Services are pure where possible (`../10-architecture/14-development-standards.md` layering); these functions are exhaustively unit-tested:

- **Points calculation** (`../30-modules/35-points-engine.md`): every `points_rules.rule_type` (`amount_rate`, `fixed_per_visit`, `fixed_per_receipt`, `tiered_amount`), rounding modes (`floor|round|ceil`), multiplier/bonus condition evaluation (day/time windows, birthday, `min_amount_centavos`), stacking order, FIFO expiry math, reversal/clawback computation. Property-based tests: points never negative, `balance_after` invariant, floor(amount/rate) monotonicity.
- **Campaign eligibility & state machine** (`../30-modules/34-campaign-engine.md`): audience matching (`campaigns.audience` — segments, min_visits, cities, birthday_month), schedule/recurrence window evaluation in `Asia/Manila`, budget guardrails (`campaigns.budget`), legal status transitions only.
- **Fraud scoring** (`../30-modules/37-fraud-detection.md`): signal scoring/aggregation to pass/review/block decisions, velocity window math, hash-distance thresholds.
- **Parsers** (`../30-modules/36-receipt-ocr-pipeline.md`): field extraction from OCR text against `parse_config` (date formats, total keywords, receipt-number regexes), merchant alias matching, line-item → product fuzzy match scoring.
- **Analytics formulas** (`../30-modules/40-analytics.md`): `manila_day()` boundaries (23:59/00:00 Manila edges), visit dedup rule, new-vs-returning classification, rollup upsert convergence (same input twice → identical row).
- Shared Zod schemas: valid/invalid fixtures per schema (these double as API 422 fixtures).

Example shape (points engine — the flavor of the whole layer):

```ts
describe('calculatePoints', () => {
  it('amount_rate floors: ₱149.99 at 100c/pt → 149', () => {
    expect(calculatePoints({ rule: amountRate(100), totalCentavos: 14999 }).points).toBe(149);
  });
  it('Friday 2x multiplier applies only inside the window (Asia/Manila)', () => {
    const at = manila('2026-07-24T13:00');            // Friday lunch
    expect(calculatePoints({ rule: base, multipliers: [friday2x], totalCentavos: 10000, at }).points).toBe(200);
  });
  prop('never negative, never fractional', arbReceipt(), arbRules(), (r, rules) => {
    const { points } = calculatePoints({ ...r, rules });
    return Number.isInteger(points) && points >= 0;
  });
});
```

### Integration — services against local Supabase

- Repositories + services run against `supabase start` Postgres with migrations + seeds applied; tests execute under **anon/authenticated JWTs, not service role**, so RLS is exercised in the write paths too.
- Transactional invariants: concurrent claim of last reward inventory (one winner), concurrent points award serialization (Redis lock + `select for update`, `../20-data/23-schema-campaigns.md` integrity table), `pt_receipt_earn_once` double-award rejection, `receipts_sha_unique` duplicate stop.
- Workers: invoked via the direct-invoke harness with real DB — asserts idempotency (invoke twice = one effect), claim/reclaim behavior, terminal-vs-retryable classification (`../30-modules/39-background-jobs.md` contract).

## RLS matrix tests — THE non-negotiable

Per `../10-architecture/12-multi-tenancy-rls.md` §Testing tenancy: **every table × every role**, in pgTAP, in CI, on every PR. Zero-tolerance gate — a red matrix blocks merge regardless of anything else.

- Personas instantiated per run: `anon`, `consumer_a`, `consumer_b`, tenant-A `owner/manager/marketing/staff`, tenant-B `owner`, `platform admin` (`support`/`admin`/`super_admin`), `service_role`.
- For each table in `../20-data/*`: assert **exactly** the accesses the permission matrix (`../00-product/01-personas-roles.md`) allows — select/insert/update/delete per persona, including: cross-tenant reads return **zero rows** (never errors — the 404-not-403 posture, `../10-architecture/15-security.md`), consumer sees only own P2/P3 rows, ledger tables reject UPDATE/DELETE even as `service_role` (raising trigger, `../20-data/23-schema-campaigns.md`), deny-all tables (`embeddings`, `jobs`) reject every non-service access.
- The matrix is **generated** from a declarative spec (`supabase/tests/matrix.yaml`) listing table × persona × verb → expect; a new table without a matrix entry fails a lint check, making "forgot RLS tests" impossible (`14` PR checklist).

Example generated case (shape, not exhaustive):

```sql
-- consumer_b must not read consumer_a's receipts; tenant-B owner must not read tenant-A's
select set_auth_user('consumer_b');
select is_empty(
  $$ select id from public.receipts where user_id = :'consumer_a_id' $$,
  'receipts: cross-consumer read returns zero rows');

select set_auth_user('owner_b');
select is_empty(
  $$ select id from public.receipts where business_id = :'business_a_id' $$,
  'receipts: cross-tenant staff read returns zero rows');

-- ledger immutability holds even for service_role
select set_role_service();
select throws_ok(
  $$ update public.points_transactions set points = 999 where id = :'txn_id' $$,
  'P0001', null, 'points_transactions: UPDATE raises even as service_role');
```

Beyond the matrix, pgTAP also covers: constraint behavior (`pt_receipt_earn_once`, `receipts_number_unique` re-submission-after-reject semantics, `business_staff_one_owner`, `rewards_remaining_lte_total`), trigger behavior (`touch_updated_at`, ledger raise trigger), and claim-helper functions (`private.jwt_biz_role` overflow fallback per `12`).

## API contract tests

- OpenAPI 3.1 generated from Zod in CI (`../10-architecture/13-api-standards.md`); a contract suite replays recorded request/response fixtures for every endpoint and validates both directions against the spec — drift is impossible by construction, these tests catch envelope/status-code regressions (error registry codes, cursor pagination shape, `X-Request-Id` presence, `Idempotent-Replayed` semantics).
- Rate-limit and idempotency behaviors get dedicated tests (429 + `Retry-After`; same key + different payload → 409 `IDEMPOTENCY_REPLAYED`).

## E2E — Playwright golden paths

Run against per-PR preview deploys (smoke set) and staging (full set). Mobile viewport is the default profile (consumer PWA reality; `14` DoD).

| Path | Assertions |
|---|---|
| **Scan → award** (F1) | Submit fixture receipt → Realtime status transitions → points in wallet → `points_transactions` earn row → notification received. Uses `QUEUE_INLINE`/staged OCR fixture mode for determinism |
| **Claim → redeem** (F2) | Claim reward (points deducted, inventory decremented) → redemption QR → staff validates → both screens confirm → claim `redeemed`; replayed token rejected |
| **Campaign create → activate** | Draft each MVP type with payload → activation blocked until payload complete (`../20-data/23-schema-campaigns.md` type→payload contract) → activate → visible on consumer business page |
| **Verification approve** | Business registers, uploads docs → admin queue → approve → business `active`, owner notified; reject path with required `decision_reason` |
| **Auth journeys** | Register/verify email/login (email + Google mock), staff invite accept, device list/revoke |
| **Offline mode** (per `../30-modules/41-pwa-offline.md`) [V1] | Airplane-mode scan queues locally → background sync submits on reconnect → exactly-once submission (no dup receipt); offline wallet/reward viewing renders cached data |

### E2E mechanics

- **Auth states:** Playwright storage-state fixtures per persona (consumer, owner, manager, staff, admin) created once per run via API — no UI login repetition; Google OAuth is mocked at the Supabase provider level (real OAuth tested manually per release).
- **Determinism:** scan-path tests run with fixture receipts whose OCR output is pre-recorded (OCR service fixture mode keyed by `sha256`), so E2E asserts pipeline wiring, not OCR accuracy — accuracy is the golden set's job. Realtime assertions use explicit event waits, never sleeps.
- **Isolation:** each run seeds its own tenant namespace (unique slugs) on the preview-branch DB; parallel shards never share tenants — which also exercises tenancy for free.
- **Flake policy:** one auto-retry in CI; a test that flakes twice in a week is quarantined with a P1 issue and does not silently retry forever.

## Test data & fixtures

- **Canonical personas + tenants** come from `supabase/seed.sql` (`50-environments-deployment.md` seed strategy) — unit/integration/pgTAP/E2E all reference the same named entities (`business_a`, `owner_a`, `consumer_b`, …), so a failure reads the same everywhere.
- **Factories** (`src/test/factories/`) build valid domain objects from Zod schemas with overrides — no hand-rolled JSON in tests; invalid-case fixtures are derived by mutating a valid factory output one field at a time.
- **Clocks:** all time-dependent logic (campaign windows, expiry, Manila day boundaries) is tested with an injected clock; tests never depend on wall time. Standard tricky instants: `23:59 Asia/Manila`, `00:00` boundary, month rollover, `ends_at` exactly now.
- **Images:** fixture receipts live with the golden set (small subset vendored into the repo for unit/E2E; full corpus in the `ocr-golden/` store).

## OCR golden set

Curated PH receipt corpus (`ocr-golden/` repo dir; images + human-labeled ground truth JSON):

- **Composition (target ≥500 receipts, grown continuously from pilot rejects):** thermal POS (majority class), inkjet/dot-matrix invoices, handwritten pads, crumpled/folded, low-light/flash glare, faded thermal, skewed/perspective shots, EN/Tagalog mixed, long itemized receipts. Every pilot-phase human-review correction feeds the corpus (labels from the review queue, PII-scrubbed).
- **Regression gate on PaddleOCR upgrades** (and any `parse_config` engine change): CI job runs the full corpus through the candidate OCR image (`50-environments-deployment.md`) and compares field-level accuracy; any threshold breach blocks the upgrade (`../10-architecture/11-tech-stack.md` version policy).
- **Thresholds (gate values; ratchet upward, never down):**

| Metric | Gate |
|---|---|
| `total_centavos` exact match | ≥ 95% |
| `receipt_date` correct day | ≥ 92% |
| `receipt_number` exact | ≥ 90% |
| Merchant match (correct business) | ≥ 97% on templated businesses |
| End-to-end auto-approve on clean subset | ≥ 70% [MVP] / ≥ 85% [V1] (roadmap exit criteria) |
| False-approve (wrong total accepted) | ≤ 0.5% — hard gate, ties to fraud leak guardrail |

## AI eval harness [V1]

Per `../30-modules/38-ai-rag-platform.md`: golden Q&A set (≥200 questions across menus/hours/promos/policies per seeded businesses, EN + Tagalog), scored on: answer accuracy vs ground truth (≥95%, roadmap exit), **hallucination checks** (never invents hours/prices — any unsupported factual claim = fail), refusal correctness (out-of-scope and cross-business questions refused), retrieval hit rate (correct chunk in top-k). Runs: on every prompt-registry change, embedding-model change, and weekly against staging. Prompt-injection suite: adversarial business content fixtures must not steer answers (`../10-architecture/15-security.md` threat 5).

## Load testing (k6, against staging with synthetic dataset)

**Synthetic dataset generator** (`scripts/synth-seed.ts`): parameterized to 100k businesses / 5M consumers / 100M `business_customers` / ledger + receipts history at `../20-data/21-schema-identity.md` row-count expectations; deterministic seed for repeatability.

| Profile | Shape | Pass criteria |
|---|---|---|
| Scan burst | 100 rps `POST /api/v1/receipts` for 10 min (image pre-signed upload path) | enqueue ack p95 < 500ms (F1); zero 5xx; queue oldest-age recovers < 10 min after burst |
| Campaign push fan-out | 1 tenant × 200k recipients + 50 tenants × 1k concurrently | per-tenant flow control proven: small tenants' sends p95 < 2 min while blast proceeds (`39` fairness) |
| Dashboard queries | 500 concurrent portal users, mixed tiles at 100k-business volume | API p95 < 500ms (SLO, `52-monitoring-observability.md`); replica-flag paths identified |
| Redemption contention | 200 concurrent validates on 50-inventory reward | exactly 50 succeed; no oversell; no deadlocks |
| Sustained soak | 24h at expected pilot ×10 | no memory growth in OCR service; no queue drift; rollup completes in window |

## Fraud test fixtures

Fixture pack (`fraud-fixtures/`) exercised in unit + integration + E2E: exact duplicate images (same `sha256`), re-photographed duplicates (pHash near, `image_hash_dup`), altered-total edits (`amount_anomaly` + parse mismatch), same `receipt_number` re-submission at same business (`receipts_number_unique`), cross-consumer duplicate ring (same receipt via N accounts) [V1], velocity burst (7 receipts/hour, caps per `../10-architecture/13-api-standards.md`), future-dated and stale-dated receipts (`timestamp_anomaly`, `too_old`), GPS-mismatch cases (opt-in path) [V1]. Every `fraud_signal_type` enum value (`../20-data/20-data-model.md`) has at least one fixture that trips it and one near-miss that must not.

## What we deliberately do not test (and why)

- **Vendor behavior** (FCM delivery internals, Resend inbox placement, Supabase Auth internals): trust + monitor (`52-monitoring-observability.md`), don't simulate. Integration tests stop at our typed clients' contracts (`../30-modules/42-integrations.md`), which are mocked from recorded fixtures.
- **OCR accuracy in E2E:** golden set owns accuracy; E2E owns wiring (fixture mode, see E2E mechanics). Mixing them makes both flaky.
- **Pixel-perfect UI:** no screenshot-diff suite at MVP — mobile-viewport E2E + DoD manual check (`14`); revisit if regressions recur.
- **Exhaustive permission UI states:** the server-side matrix is the control (`../10-architecture/15-security.md` "UI hiding is never the control"); UI gating gets smoke coverage only.

## Coverage bars & CI mapping

- **Domain logic (`src/features/*/server` pure modules): ≥90% line + branch** — enforced per-directory in Vitest config.
- Overall repo: pragmatic ≥70%; UI components excluded from bars (E2E covers them); coverage never blocks a hotfix (label override, audited).

| CI stage (`50-environments-deployment.md`) | Suites | Blocking |
|---|---|---|
| PR (`pr.yml`) | lint/typecheck → unit → pgTAP RLS matrix → API contract → build/drift checks → preview E2E smoke (scan→award, claim→redeem) | Yes, all |
| Merge to `main` (`main.yml`) | full E2E on staging + OCR golden **smoke** subset (~50 receipts) | Yes |
| Release (`release.yml`) | staging soak gate (30 min, no new Sentry class) + post-deploy smoke | Yes + manual approval |
| Weekly scheduled | full OCR golden set, AI eval harness [V1], k6 dashboard profile, `npm audit`, fresh-machine local-dev smoke | Alerts, not blocking (regressions open P1s; OCR-image upgrades gate on it) |
| Pre-launch / annual | full k6 suite at 100k-volume, external penetration test [V1] (`../10-architecture/15-security.md`) | Launch checklist gate |

## Schema deltas proposed

None. Testing introduces no schema changes; the pgTAP matrix spec (`supabase/tests/matrix.yaml`) is repo tooling, not schema.
