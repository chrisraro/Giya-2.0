# Receipts and award pipeline

A consumer photographs a paper receipt and earns points. This directory owns
everything between the shutter and the ledger row.

Canonical docs: `docs/30-modules/36-receipt-ocr-pipeline.md` (stages S1-S10),
`docs/30-modules/37-fraud-detection.md` (signal catalog and scoring),
`docs/30-modules/35-points-engine.md` (award), `docs/20-data/24-schema-receipts-ai.md`
(storage), `docs/30-modules/33-consumer-pwa.md` (capture UX),
`docs/10-architecture/13-api-standards.md` (envelope, idempotency, rate limits).

## The stage chain

| Stage | What happens | Owner |
|---|---|---|
| capture | size and type validation, then the compression ladder (2048px long edge, q0.8, target 1.5MB) | `compress.ts`, `components/camera-viewfinder.tsx`, `components/receipt-capture.tsx` |
| upload | signed upload URL, PUT, then submit with a stable `Idempotency-Key` | `upload.ts`, `src/app/api/v1/receipts/uploads/route.ts` |
| submit | path ownership, cooldown, magic-byte sniff, sharp canonicalization, sha256, pHash, insert `status='queued'` | `server/submit.ts`, `server/image.ts`, `src/app/api/v1/receipts/route.ts` |
| OCR | 5 minute signed URL to the object, one provider call per invocation, `ocr_results` + `ai_usage_events` rows | `server/ocr/provider.ts`, `server/ocr/http.ts`, `server/ocr/stub.ts`, `server/process.ts` |
| parse | template `parse_config` tier, then generic PH heuristics; VAT sanity | `parse.ts` |
| match | best-of business scoring, pre-bound receipts verified not re-bound | `matching.ts` |
| validate | readability, freshness, not-future, postdates-activation, amount sanity | `validateParsedReceipt` in `server/process.ts` |
| fraud | pHash neighbours, receipt-number duplicates, Redis velocity windows, amount anomalies, staff self-scan, low confidence | `fraud.ts`, `velocity.ts`, `phash.ts`, the detectors in `server/process.ts` |
| route | confidence formula and the doc 36 Stage 9 routing table, merged with the fraud verdict | `confidence.ts`, `resolveOutcome` in `server/process.ts` |
| award | pure `computePoints`, then `award_receipt_points` | `priceReceipt` / `awardPoints` in `server/process.ts`, `supabase/migrations/0018_award_receipt_points.sql` |
| status | Realtime on the receipt row with a 5s poll fallback, consumer-safe copy | `components/use-receipt-realtime.ts`, `components/receipt-status.tsx`, `components/receipt-copy.ts` |
| history | `/receipts` list and the wallet's pending entry | `server/repo.ts`, `wire.ts`, `components/receipt-history-list.tsx`, `components/wallet-receipt-activity.tsx` |

`processReceipt(receiptId)` in `server/process.ts` is the whole chain from OCR
to award. It takes an id and nothing else, and it never throws: every failure is
either a terminal receipt status or a retryable state the next attempt picks up.
The order of writes inside it is load-bearing and is stated at the top of that
file; read that comment before reordering anything.

## The OCR boundary

Doc 36 Stage 4 puts PaddleOCR and OpenCV in a private container (decision D1).
That container and its credentials arrive at the end of the build, so the
pipeline is written against the container's HTTP contract with two
implementations behind one interface in `server/ocr/provider.ts`:

- `createHttpOcrProvider` (`server/ocr/http.ts`) POSTs `{OCR_SERVICE_URL}/v1/ocr`
  with `Authorization: Bearer {OCR_SERVICE_TOKEN}`, a 30s worker timeout against
  the service's 25s internal budget, and Zod validation of the 200 body. Statuses
  map to `OCR_AUTH_FAILED` (401), `OCR_IMAGE_TOO_LARGE` (413),
  `OCR_IMAGE_UNREADABLE` (422), `OCR_UNAVAILABLE` (503 or transport failure),
  `OCR_TIMEOUT`, and `OCR_BAD_RESPONSE`. Each error carries an explicit
  `retryable` flag rather than letting callers infer one from the status.
- `createStubOcrProvider` (`server/ocr/stub.ts`) fabricates plausible PH receipt
  text so the whole chain runs today. Output is a pure function of the request
  (FNV-1a seed, xorshift32 draws, no `Math.random`); the only clock read is the
  receipt date, which is injected so tests get byte-identical output. The
  fabricated receipt uses VAT-inclusive arithmetic where `subtotal + tax = total`
  exactly, so it parses through the real engine to an `approved` outcome.

**Every stub response reports `engine: "stub"` and `engineVersion: "stub-v1"`,
persisted to `ocr_results.engine` / `ocr_results.engine_version`.** A stub row is
therefore always distinguishable from a real one in the database, in a future
review UI, and in any backfill. Do not change those constants to mimic the real
engine.

### Selection, and what to do when the container arrives

`getOcrProvider()` selects on the presence of `OCR_SERVICE_URL` alone:

- `OCR_SERVICE_URL` unset: stub.
- `OCR_SERVICE_URL` set and `OCR_SERVICE_TOKEN` set: the HTTP provider.
- `OCR_SERVICE_URL` set and `OCR_SERVICE_TOKEN` unset: throws `OCR_MISCONFIGURED`.

When the container is live, the entire switch is two environment variables:

```
OCR_SERVICE_URL=https://ocr.internal.example/
OCR_SERVICE_TOKEN=<service token>
```

There is no code change, no flag, and no import to swap. Both variables are
declared optional in `src/lib/env.ts` and are deliberately not cross-validated
there: a refinement on the env schema would make an OCR typo throw for every
`getServerEnv()` caller and take down auth and rewards over a receipts-only
problem. The pairing rule is enforced in `provider.ts`, where the blast radius is
the pipeline that needs it.

Half a configuration throws instead of falling back to the stub, and that
asymmetry is the point: in production a silent fallback would feed the pipeline
fabricated text that parses cleanly, and the award path would write real `earn`
rows for receipts nobody photographed.

## The fences, and why not to widen them

Someone will eventually try to "fix" one of these by loosening it. Each one is
here for a reason that is not obvious from the symptom.

**`receipts` has no client insert, update or delete policy.** Every write is
service role, exactly like the points ledger. Fraud scoring and points award are
not optional steps a client may skip, so there must be no client path that
creates or edits a receipt row. Insert and update are revoked from `anon` and
`authenticated` (0017). This is also why `SUPABASE_SERVICE_ROLE_KEY` is required
for the pipeline to run at all.

**The column grant withholds `reject_note`, `parse_meta`, `match_confidence`,
`parse_confidence`, `sha256` and `image_hash`.** 0017 revokes the table-level
SELECT from `authenticated` and re-grants exactly 13 columns: `id, user_id,
business_id, status, reject_reason, merchant_name, receipt_number, receipt_date,
total_centavos, image_path, source, created_at, processed_at`. `reject_note` is
free-text reviewer commentary that can name another consumer; `parse_meta` is
per-field extraction provenance, which is a gradient signal for a forger
iterating on a fake; the confidences and the hashes are the makings of a
duplicate-detector oracle. Column privileges are role-wide, not policy-wide, and
staff and consumers are both the `authenticated` role, so one grant cannot give
staff more columns than consumers. The safe intersection wins. When the review UI
needs the wider set, the answer is a staff-scoped view or a security definer
function owned by a role that holds the wider grant, never widening this one.
Practical consequence: `select *` on `receipts` as a signed-in user raises 42501,
so every client read names its columns (`server/repo.ts` enforces this).

**`fraud_signals` and `ocr_results` are never consumer-readable.** Staff of the
owning tenant read them; the submitter never does. Doc 33 and doc 37 both say
fraud internals are never exposed to the submitter, and a rejection message that
narrows the search space teaches evasion. `components/receipt-copy.ts` is the
matching rule on the UI side: the consumer is told what happened, never which
detector tripped, what it scored, what evidence it held, or which other receipt
matched. `fraud_suspected` deliberately offers no retake CTA, because a retry
path after a fraud rejection is a loop an abuser iterates against.

**Receipts cannot be deleted.** `delete` and `truncate` are revoked from
`anon`, `authenticated` and `service_role`, and a raising `BEFORE DELETE` trigger
(`receipts_no_delete`) covers the table owner, whom revokes never reach. The
non-obvious reason: `points_transactions.receipt_id` uses RESTRICT, which only
protects receipts that already have a ledger row. Rejected receipts have none, so
without the trigger they were freely deletable, and deleting them resets the
fraud strike history that doc 37's cooldown ladder counts from.

**`ocr_results` and `fraud_signals` are insert-only.** `update`, `delete` and
`truncate` are revoked from all three roles including `service_role`, plus
raising triggers as the owner-proof layer. They are evidence: the value of a
scoring history is that it cannot be edited after the fact.

**Platform `settings` rows have no client policy at all.** Not a narrowed one,
none. The platform rows are the fraud rulebook: `fraud.velocity.*` are the exact
submission caps an abuser must stay under, `fraud.phash_block_distance` is the
exact perceptual distance a re-photograph must exceed, `fraud.review_threshold`
is the composite score to stay below, and `fraud.cooldown_strikes` is how many
rejections are free. Every read is server side through the service role
(`server/settings.ts`). If a genuinely client-facing key ever appears, add an
explicit key allowlist policy (`using (scope = 'platform' and key in (...))`) and
never a scope predicate again: a scope predicate makes every future platform key
public by default.

**Storage has no UPDATE and no DELETE policy.** See the `receipts` bucket
section in `supabase/README.md`. The image is evidence behind a sha256 and a
pHash already computed from it.

## Thresholds: settings-driven vs code

Doc 37's rule is that thresholds are data, not code. `server/settings.ts` reads
them with business-scope rows overriding platform-scope rows, memoized per
request via React `cache` with deliberately no TTL, so a retuned row is live
without a deploy.

Settings-driven: `fraud.phash_block_distance`, `fraud.phash_warn_distance`, the
five `fraud.velocity.*` caps, `fraud.review_threshold`, `fraud.cooldown_strikes`,
`fraud.cooldown_hours`, `ocr.approve_threshold`, `ocr.review_threshold`,
`ocr.max_attempts`, `receipts.max_age_days` (validated as an integer then clamped
to 1-30).

Code, on purpose: the severity and score of each velocity window (a settings row
must not be able to reclassify a velocity signal), the doc 36 Stage 5 match bands
`matchAccept` / `matchReview` (no registered settings key), and the severity
weights in `fraud.ts`.

**The fallback-drift guard.** The loader's hardcoded fallbacks are *imported from
the engines' exported constants*: `PHASH_BANDS`, `DEFAULT_VELOCITY_CAPS`,
`DEFAULT_FRAUD_REVIEW_THRESHOLD`, `DEFAULT_ROUTING_THRESHOLDS`. Retyping the
literals would let the engine default and the loader default drift apart
silently, and the drift would only show up when the settings table was
unreachable, which is the worst possible moment to discover it. The four keys with
no engine constant (`cooldown_strikes`, `cooldown_hours`, `ocr.max_attempts`,
`max_age_days`) are asserted against the 0017 seed in the tests instead.

The loader never throws and never returns an unvalidated value. A missing row, a
malformed row, an unreachable database or an absent service-role key all degrade
to `DEFAULT_RECEIPT_SETTINGS` and log. A malformed *business* override falls
through to the platform row beneath it rather than shadowing it.

## The pure engines

Zero IO, no React, no database. Every threshold is injected; defaults are
exported for the loader.

- `parse.ts`: PH field extraction. Template config tier, then generic heuristics.
  PH date precedence with the older-reading rule for ambiguous numeric dates,
  money tokens with thousands separators to integer centavos, VAT sanity at
  12/112 which nulls the inconsistent sub-field and keeps `total` authoritative.
  Business-authored regexes (`receipt_no_regex`, `line_item_pattern`) are treated
  as untrusted code: bounded input, a nested-quantifier shape check, and a
  fall-through to the generic tier when either fails.
- `confidence.ts`: `parseConfidence` (0.35 total + 0.20 date + 0.15 number + 0.30
  mean OCR confidence, +0.05 VAT bonus, clamped to 1.0) and `routeReceipt`.
- `fraud.ts` and `velocity.ts`: `scoreSignals` (composite = min(1, sum of score x
  severity weight)), `fraudVerdict` (any block wins; dup family maps to
  `duplicate` and everything else to `fraud_suspected`; `staff_self_scan` forces
  review unconditionally), and pure velocity window evaluation given counts and
  caps.
- `matching.ts`: best-of business scoring with a pre-bound floor. A pre-bound
  receipt is verified and never silently re-bound.
- `phash.ts`: 64-bit DCT perceptual hash with a frozen bit convention and golden
  vectors, plus `hammingDistance`. Pure given pixels; sharp only supplies them.

Both `confidence.ts` and `fraud.ts` quantize before comparing against a
threshold. This is not cosmetic. Exact-decimal inputs that should land on 0.80
and 0.50 sum to 0.7999999999999999 and 0.49999999999999994 in IEEE 754, and a
raw `>=` would route real receipts to the wrong outcome. Those cases are pinned
by tests; do not remove the rounding.

## Known gaps and deferred work

- **Review queue UI is the next slice.** Business and admin queues plus doc 36's
  `POST /api/v1/businesses/{businessId}/receipts/{id}/review` and
  `POST /api/v1/admin/receipts/{id}/review` endpoints do not exist. Receipts routed to
  `review` sit and wait, which is correct behaviour, not a bug. Note that the
  column grant above means that UI reads through the service role, not the
  client.
- **Processing runs inline.** `server/submit.ts` calls `processReceipt` directly
  after the insert, marked `TODO(queue)`. `processReceipt` is already queue
  shaped (an id and nothing else, every fact re-read under the service role), so
  the QStash swap is an enqueue plus a Route Handler that unwraps `{receipt_id}`.
  A second `TODO(queue)` in `server/process.ts` marks the place to rethrow once
  QStash owns retries and backoff.
- **Nothing re-invokes a parked receipt.** A retryable OCR failure (timeout, 503)
  or an `OCR_AUTH_FAILED` / `OCR_MISCONFIGURED` leaves the row at `processing`
  on purpose, so a later attempt can pick it up; `ocr.max_attempts` bounds the
  retryable case. With processing inline there is no later attempt and no
  sweeper, so such a row sits until something calls `processReceipt` again. The
  queue closes this; until then it is the one status a human has to notice.
- **`SUPABASE_SERVICE_ROLE_KEY` is required for the pipeline to run.** It is
  optional in `src/lib/env.ts` so the rest of the app boots without it, but
  receipts are service-role-write-only by design: without the key,
  `requireServiceRoleClient()` returns 503 on submit and
  `defaultProcessReceiptDeps()` returns null and logs. The credential lands at
  the end of the build per standing orders.
- **The cooldown a consumer can lift themselves.** `applyCooldownIfEarned` writes
  `consumers.scan_blocked_until` and `server/submit.ts` refuses submissions while
  it is in the future, but `consumers_owner_update` is not column-restricted and
  `authenticated` holds UPDATE on that column, so a consumer can clear their own
  block with one PATCH. Doc 37's ladder step 2 is only as strong as that grant.
  Tracked in `supabase/README.md` under "Known limitations"; the fix is a
  column-restricted re-grant, the pattern 0013 used for the `business_customers`
  balance cache.
- **S5 closed-hours is not implemented.** `parse.ts` reads an adjoining time
  token when one exists but does not report whether it found one; a dateless time
  defaults to 12:00 in the returned `receiptDate`, so a noon timestamp is
  indistinguishable from "no time printed". Doc 37 S5 says the check is skipped
  when the time is not extracted, and that skip is not expressible today. Adding
  a `timeExtracted` flag (or an optional time field) to `ParsedReceipt` is the
  prerequisite. The future-dated and too-old halves of S5 are implemented.
- **S2 `ocr_similarity_dup`, S6 `gps_mismatch`, and ring detection are V1.**
  `submitted_lat` / `submitted_lng` are accepted at submit and gated on
  `consumers.gps_fraud_opt_in`, but no detector consumes them yet.
  `FraudSignalType` names `ocr_similarity_dup` and `gps_mismatch` so the schema
  and engine are ready; nothing emits them.
- **LLM parse-assist (doc 36 Stage 7 tier 3) is V1.** `fieldSource()` in
  `server/process.ts` therefore returns only `validated` or `missing`; the 0.5
  weighted `llm_assisted` source is implemented in `confidence.ts` and tested,
  but unused until that tier lands.
- **Line-item product linkage is deferred.** `writeLineItems` never sets
  `product_id` or `match_score`, so `receipt_line_items` rows are raw parsed text
  with amounts. The columns and the fuzzy-match FK exist in 0017; the matcher
  does not.
- **Template management UI does not exist.** `receipt_templates` rows can only be
  created by direct database access today, so the template tier of `parse.ts` is
  live code with no way to feed it from the portal.
- **The `settings` table has no admin write path.** Thresholds are tunable by
  design, but only through service-role or SQL access; there is no screen.
- **Doc 37's remaining registry keys are unread.** `fraud.text_sim_warn`,
  `fraud.gps_warn_m` and `fraud.referral_farm_min` belong to the V1 detectors
  above and are deliberately absent from `RECEIPT_SETTINGS_KEYS`.
- **Realtime status depends on 0020.** `receipts` was not in the
  `supabase_realtime` publication; a missing publication does not error, it
  reports SUBSCRIBED and delivers nothing. If the status screen ever silently
  stops updating, check the publication first.
