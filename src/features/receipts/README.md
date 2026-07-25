# Receipts and award pipeline

A consumer photographs a paper receipt and earns points. This directory owns
everything between the shutter and the ledger row, and the human review queue
that resolves the receipts the pipeline will not decide on its own.

Canonical docs: `docs/30-modules/36-receipt-ocr-pipeline.md` (stages S1-S10 and
Stage 9's human review queue), `docs/30-modules/37-fraud-detection.md` (signal
catalog, scoring, the evidence display contract, the consequences ladder),
`docs/30-modules/35-points-engine.md` (award), `docs/20-data/24-schema-receipts-ai.md`
(storage), `docs/20-data/25-schema-platform.md` (`audit_logs`),
`docs/30-modules/33-consumer-pwa.md` (capture UX),
`docs/30-modules/32-business-portal.md` (the review surfaces),
`docs/10-architecture/13-api-standards.md` (envelope, idempotency, rate limits).

## The stage chain

| Stage | What happens | Owner |
|---|---|---|
| entry | `/scan` needs a business before it needs a camera: with a valid `?business=`, the capture flow; without one, the store chooser | `scan-entry.ts`, `components/scan-business-chooser.tsx`, `server/scan-targets.ts` |
| capture | size and type validation, then the compression ladder (2048px long edge, q0.8, target 1.5MB) | `compress.ts`, `components/camera-viewfinder.tsx`, `components/receipt-capture.tsx` |
| upload | signed upload URL, PUT, then submit with a stable `Idempotency-Key` | `upload.ts`, `src/app/api/v1/receipts/uploads/route.ts` |
| submit | path ownership, cooldown, magic-byte sniff, sharp canonicalization, sha256, pHash, insert `status='queued'` | `server/submit.ts`, `server/image.ts`, `src/app/api/v1/receipts/route.ts` |
| OCR | 5 minute signed URL to the object, one provider call per invocation, `ocr_results` + `ai_usage_events` rows | `server/ocr/provider.ts`, `server/ocr/http.ts`, `server/ocr/stub.ts`, `server/process.ts` |
| parse | template `parse_config` tier, then generic PH heuristics; VAT sanity | `parse.ts` |
| match | best-of business scoring; a pre-bound receipt is never silently re-bound, but see the matching note under "The pure engines" for what that does and does not verify | `matching.ts` |
| validate | readability, freshness, not-future, postdates-activation, amount sanity | `validateParsedReceipt` in `server/process.ts` |
| fraud | pHash neighbours, receipt-number duplicates, Redis velocity windows, amount anomalies, staff self-scan, low confidence | `fraud.ts`, `velocity.ts`, `phash.ts`, the detectors in `server/process.ts` |
| route | confidence formula and the doc 36 Stage 9 routing table, merged with the fraud verdict | `confidence.ts`, `resolveOutcome` in `server/process.ts` |
| review queue | receipts routed to `review` are listed at `/business/receipts` for owner and manager, oldest first, with queue age against doc 36's 24h SLA; the sidebar and the dashboard carry the pending count | `review/queue.ts`, `review/queue-screen.tsx`, `review/access.ts`, `src/app/(business)/business/(portal)/receipts/page.tsx`, `components/business/sidebar.tsx`, `src/app/(business)/business/(portal)/dashboard/page.tsx` |
| review decision | the image beside pre-filled editable fields with per-field source and confidence chips, plus the fraud signals rendered as sentences; approve with corrections or reject with a reason | `review/decision-screen.tsx`, `review/evidence.tsx`, `review/presenter.ts`, `review/types.ts`, `review/actions.ts`, `src/app/(business)/business/(portal)/receipts/[receiptId]/page.tsx` |
| review service | the only way a receipt leaves `review`: guard order, the conditional decision write, the audit row, then the shared award or the strike ladder | `server/review.ts`, `supabase/migrations/0022_audit_logs.sql` |
| award | pure `computePoints`, then `award_receipt_points`; an approval priced at zero calls `record_receipt_visit` instead | `priceReceipt` / `awardPoints` / `awardApprovedReceipt` in `server/award.ts`, `supabase/migrations/0018_award_receipt_points.sql`, `supabase/migrations/0023_record_receipt_visit.sql` |
| cooldown | doc 37 ladder step 2, counted over fraud-family rejections in a 30 day window | `server/cooldown.ts` |
| status | Realtime on the receipt row with a 5s poll fallback, consumer-safe copy | `components/use-receipt-realtime.ts`, `components/receipt-status.tsx`, `components/receipt-copy.ts` |
| history | `/receipts` list and the wallet's pending entry | `server/repo.ts`, `wire.ts`, `components/receipt-history-list.tsx`, `components/wallet-receipt-activity.tsx` |

`processReceipt(receiptId)` in `server/process.ts` is the whole chain from OCR
to award. It takes an id and nothing else, and it never throws: every failure is
either a terminal receipt status or a retryable state the next attempt picks up.
The order of writes inside it is load-bearing and is stated at the top of that
file; read that comment before reordering anything.

There are now **two** entry points into the award, not one: the pipeline above
and `reviewReceipt` in `server/review.ts`, which is how a receipt leaves
`status='review'`. Both run the same `server/award.ts`. Read the next two
sections together; the second only makes sense given the first.

## The shared award path

`server/award.ts` is the one implementation of "this receipt is approved, price
it and pay it". It exists because doc 36 Stage 9 states the constraint
literally: *approving from review runs the same service function auto-approval
runs, no separate code path, so ledger invariants hold*. Until this slice there
was one caller and the constraint was aspirational. There are now two, so the
extraction had to come first: two award sequences that must agree is exactly how
a ledger bug is written, and the disagreement would only surface as points that
are wrong by an amount nobody can reconstruct.

It was extracted BEFORE the review service was written, deliberately. The
existing `server/process.test.ts` suite stayed green unchanged apart from its
imports, which is the evidence that nothing about the pipeline's behaviour moved
during the extraction.

What lives there:

- `priceReceipt` loads the business's active rules, resolves campaign stacking,
  and runs the shared pure `computePoints`. It returns a plan with `points: 0`
  rather than null when nothing is due, because zero is a legitimate outcome.
- `awardPoints` takes a plan and calls the RPC. Above zero it is
  `award_receipt_points` (0018); at zero it is `record_receipt_visit` (0023).
- `awardApprovedReceipt` composes the two, for the review service.
- `AWARD_ERROR_HANDLING` maps every P0001 message the two RPCs raise to a
  severity. Nothing here throws: the receipt is already `approved` in the
  database when either RPC runs, so a refusal is an approved receipt that needs
  support attention, while an exception would strand the pipeline job or lose
  the reviewer's decision after it had already been persisted.

**The caller writes `status='approved'`, this module does not**, and that is a
contract stated at the top of the file. The pipeline has to write the terminal
status in ONE statement together with the parsed fields, because
`receipts_number_unique` is partial over the live statuses and the loser of that
race has to land as `rejected` in the same statement that writes its number; the
review service has to write the reviewer's corrections and `reviewed_by` /
`reviewed_at` in its own statement under an optimistic-concurrency predicate.
An award function owning the status write would have to reproduce both.

**`processed_at` belongs to the RPC, not the caller.** Both RPCs stamp it, so a
caller landing a receipt on `approved` leaves it null and lets the award write
it. Only the paths that never reach an RPC (rejected, review, an OCR dead end)
stamp it themselves. `processed_at is null` on an approved row is therefore the
findable marker for "approved, award pending".

### `record_receipt_visit` and the zero-point CRM defect

0023 is a defect fix, not a tidy-up. Every `business_customers` counter
(`visit_count`, `lifetime_spend_centavos`, `first_visit_at`, `last_visit_at`)
and the existence of the pair row itself were maintained only inside step 6 of
`award_receipt_points`. A zero-point approval skips that RPC by design, so for a
tenant with no active base rule:

- the portal's customer list, lifetime spend and last-visit sort never advanced,
  however many approved receipts arrived; and
- `visit_count` stayed 0, so `isFirstVisit` was permanently true for that pair.
  The day the owner configured a `first_visit` bonus rule, every existing
  customer would collect it on their next receipt. That is real money paid on a
  false premise.

0023 extracts 0018 step 6 verbatim into `private.apply_receipt_visit`, which
both RPCs now call, so the doc 40 visit rule cannot drift between them, and adds
`record_receipt_visit` as the ledger-free entry point the zero-point path takes.
It introduces no new error strings: it reuses `RECEIPT_NOT_AWARDABLE`,
`AWARD_RECEIPT_ID_REQUIRED` and `CUSTOMER_RECORD_MISSING` so the service layer
keeps one taxonomy and one severity map.

**Why `visit_recorded_at` and not `processed_at`.** The obvious idempotency
marker is `processed_at`, and it does not work. `processed_at` is stamped on
every terminal outcome *including `review`* (doc 52 measures scan e2e latency
from it for receipts reaching approved, review or rejected), so a receipt routed
to a human already carries one before the reviewer ever sees it. Guarding on it
would have made `record_receipt_visit` a silent no-op for exactly the receipts
human review approves at zero points, which is the original defect wearing a
different hat. `visit_recorded_at` states the fact that actually matters, is
written only by `private.apply_receipt_visit`, and makes the two RPCs idempotent
against each other as well as against themselves. It is outside 0017's column
grant, so no client role can read it. The migration backfills it for every
receipt that already carries an earn row, otherwise a later
`record_receipt_visit` would add that receipt's spend a second time.

## Human review

`reviewReceipt` in `server/review.ts` is the only way a receipt leaves
`status='review'`. It is simultaneously a money path and an insider-control
path, which is why the guard order is normative and is tested as an order rather
than as a set:

1. the receipt exists, else `RECEIPT_NOT_FOUND`;
2. the actor is an ACTIVE `owner`/`manager` of `receipts.business_id`, else
   `FORBIDDEN`;
3. the receipt is in `review`, else `RECEIPT_NOT_REVIEWABLE`;
4. the actor is not the submitter, else `FORBIDDEN` (doc 37 S9);
5. approve: validate the corrections, persist them with `reviewed_by` /
   `reviewed_at`, audit, then `awardApprovedReceipt`;
6. reject: persist reason and note, audit, then `applyCooldownIfEarned` for a
   fraud-family reason only.

Membership is checked before status so a stranger probing receipt ids learns
"forbidden" rather than "that id exists and has already been decided". Guard 4
is the one that carries the most weight: the fraud pipeline already routes every
staff self-scan to `review`, so without it the pipeline's own control would hand
the self-dealer the screen that lets them approve themselves.

**Concurrency is a WHERE predicate, not a read-then-write.** Both decision
writes carry `.eq("status", "review")` and treat zero affected rows as
`RECEIPT_NOT_REVIEWABLE`, the same shape `setCampaignStatus` uses, so two
managers with the same item open cannot both decide it.

**The audit row is written after the decision and BEFORE the award, and a failed
audit aborts the award.** Full atomicity is not available: holding all three
writes in one transaction would mean reimplementing `computePoints` in plpgsql,
which recreates the second award path the extraction above exists to prevent.
Given that, the asymmetry is not close. Audit-last risks minted points with
nobody recorded as authorizing them, which is unrecoverable and is exactly doc
15's insider-abuse threat item. Audit-first risks an audit row for a decision
that did happen, since the receipt is already approved by the preceding
statement, and the payment has its own better record in the ledger.

Rejecting for `duplicate` or `fraud_suspected` runs `server/cooldown.ts`, the
same function the pipeline calls, because a reviewer answering that question is
answering the pipeline's question. `unreadable`, `too_old`, `wrong_business` and
`manual` never accumulate toward a scan block.

### The review UI reads through the service role, so tenancy lives in code

This is the consequence of the column grant described below, and it is the most
important thing to know before adding a query to `review/queue.ts`.

0017's column grant is role-wide, and staff are the same `authenticated` role as
consumers, so no policy can hand staff `parse_meta` while withholding it from
the submitter. The review screens therefore read through the SERVICE ROLE, which
bypasses RLS entirely. Nothing the database does will stop a query in
`review/queue.ts` from returning another business's receipts.

**Anyone adding a query there must scope it.** Every read carries an explicit
`.eq("business_id", businessId)` and a `TENANCY` comment naming what enforces
it; a query that cannot be annotated does not belong in that file. The business
id itself has exactly one legitimate source, `resolveReviewerContext()` in
`review/access.ts`, which reads `business_staff` under the caller's own session
and returns null for a role that cannot review. No business id is ever taken
from a URL segment, a query parameter, a form field or a claim. The
`[receiptId]` segment is the only caller-supplied value that reaches the module,
and it is always paired with the resolved business id in the same WHERE clause.
A row failing the predicate is indistinguishable from a row that does not exist,
because a "you may not see this" branch is an existence oracle for other
tenants' receipt ids.

The subtlest of those predicates is the duplicate-match lookup in
`loadSignalsForReceipt`. pHash neighbours are drawn from the union of the
consumer's history and the business's history, so a `matched_receipt_id` in a
signal's evidence legitimately names a receipt at ANOTHER merchant. The business
predicate on that lookup is the only thing keeping that merchant's name, date
and total out of this tenant's render; an unresolved match is reported as
existing and nothing more.

Consumer history on the decision screen is scoped to the viewing tenant on
purpose. Doc 37's list is "approval ratio, prior signals, strikes, devices"; the
first two are answered from this business's own rows, and the last two are
cross-tenant by construction, so showing them would tell one merchant what a
consumer did at another. Doc 37 assigns that view to the admin queue.

Receipt images are 5-minute signed URLs minted server-side after the tenancy
check, because 0019 gives the bucket no staff policy at all.

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
therefore always distinguishable from a real one in the database, in the review
UI, and in any backfill. Do not change those constants to mimic the real
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
staff more columns than consumers. The safe intersection wins. The review UI does
need the wider set, and the shipped answer is the service role in server
components and server actions with the tenancy predicate applied in code (see
"Human review" above). A staff-scoped view or a security definer function owned
by a role holding the wider grant would work too; widening this grant would not,
because it would widen it for consumers in the same statement.
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

**`audit_logs` is append-only and owner-read-only.** 0022 gives it the same
three-layer treatment: no client write policy, `insert, update, delete, truncate`
revoked from `anon`/`authenticated` and `update, delete, truncate` revoked from
`service_role` (INSERT stays, since service_role is the writer), a raising row
trigger and a raising statement TRUNCATE trigger. Nothing references the table,
so unlike `receipts` there is no foreign key incidentally refusing a truncate
first and the statement trigger is genuinely the last line. Reads are narrower
than the neighbouring tables: **owner only, manager excluded**, because a manager
is precisely the person whose decisions this table records. `ip` and
`user_agent` are withheld from `authenticated` by a column grant, so `select *`
on `audit_logs` raises 42501 as it does on `receipts`.

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

**A blocked consumer cannot unblock themselves.** `applyCooldownIfEarned`
(`server/cooldown.ts`, called by both the pipeline and human review)
writes `consumers.scan_blocked_until` and `server/submit.ts` refuses
submissions while it is in the future, which is doc 37's ladder step 2. That
column is only a fence if the consumer cannot write it, and until this slice it
was not: `consumers_owner_update` is row-scoped and not column-restricted, and
`authenticated` held the default table-level UPDATE, so one PATCH cleared the
block. 0021 closes it with 0013's revoke-then-grant-columns pattern: the
table-level UPDATE is revoked from `authenticated` and granted back on exactly
the self-editable columns, which do not include `scan_blocked_until` (nor
`profiles.is_suspended` / `suspended_reason`, ladder step 4, nor the
`birth_date` / `birth_date_updated_at` pair, whose A21.1 once-a-year rule only
holds if neither is client-writable). The allowlists are asserted in pgTAP as
exact sorted string lists, so adding a column without deciding its writability
fails the suite. RLS is untouched: the policy still decides which row, the
grant decides which columns, and both have to hold. Service-role writes and the
SECURITY DEFINER RPCs are unaffected. Do not "fix" a failing client write by
widening this grant; the write belongs on the server.

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
- `matching.ts`: best-of business scoring with a pre-bound floor. Be precise
  about what this buys today. **Verified:** a pre-bound receipt is never
  silently re-bound to a different business, so the merchant a consumer chose
  is the merchant that gets charged the points, and `matchBusiness` does own a
  contradiction path that demotes a pre-bound receipt whose text clearly names
  somebody else. **Not verified:** that the receipt is actually from that
  business. `buildMatchCandidates` in `server/process.ts` supplies exactly one
  candidate, the pre-bound business itself, so there is no rival for the text
  to score higher against and the contradiction path cannot fire. Every
  pre-bound receipt therefore lands on the 0.85 floor. Concretely: a legible
  receipt from a shop across the street, submitted with a chosen `business_id`,
  auto-approves. Nothing shipped catches it, because pHash, sha256 and
  receipt-number dedupe only stop reuse of the same receipt. Tracked under
  Known gaps.
- `phash.ts`: 64-bit DCT perceptual hash with a frozen bit convention and golden
  vectors, plus `hammingDistance`. Pure given pixels; sharp only supplies them.

Both `confidence.ts` and `fraud.ts` quantize before comparing against a
threshold. This is not cosmetic. Exact-decimal inputs that should land on 0.80
and 0.50 sum to 0.7999999999999999 and 0.49999999999999994 in IEEE 754, and a
raw `>=` would route real receipts to the wrong outcome. Those cases are pinned
by tests; do not remove the rounding.

## Known gaps and deferred work

- **Generic (unbound) scan is V1, and `/scan` says so by not offering it.**
  Doc 33's route table marks it `[V1]`; `buildMatchCandidates` supplies only the
  pre-bound business, so an unbound receipt scores against an empty candidate
  set, gets confidence 0 and is rejected `wrong_business` every time. Because
  `receipts_sha_unique` is a total index that includes rejected rows, the same
  photo re-submitted from the right store page then returns 422
  `RECEIPT_DUPLICATE`, so a real receipt is spent for nothing and each attempt
  costs a slot of the 60/day cap and moves every velocity counter. Bare `/scan`
  therefore renders a store chooser instead of the camera, and a hand-typed
  non-UUID `?business=` lands there too. When generic scan lands, the chooser
  gains a "not sure which shop" path; until then there is deliberately no way
  to reach the capture flow without a business id.
- **The BUSINESS review queue shipped; the ADMIN queue did not.** Owner and
  manager can resolve `review` receipts at `/business/receipts`. Doc 31's admin
  fraud queue and `POST /api/v1/admin/receipts/{id}/review` do not exist, and
  cannot yet: every admin predicate reads a platform-admin claim out of the JWT
  and this project's custom access token hook is disabled, so a claim-based
  admin policy would evaluate null and silently deny. Deferred to the slice that
  enables the hook. The two features that belong to that queue and are therefore
  absent from the business one are the side-by-side duplicate image comparison
  (a second image needs a second signed URL, and the matched receipt may belong
  to a tenant this business is not entitled to see) and the cross-tenant strike
  and device history.
- **The decision surface is server actions, not doc 36's REST endpoint.**
  `POST /api/v1/businesses/{businessId}/receipts/{id}/review` does not exist;
  `review/actions.ts` calls `reviewReceipt` directly. The service takes no
  business id from its caller, so the route is a thin addition when a client
  needs one, and `defineHandler` already exists for it.
- **The review badge is server-rendered, not Realtime.** Spec section 6 asks the
  queue badge to subscribe to `receipts` filtered on `business_id` and
  `status=review`. Nothing subscribes; the count is read per request and the
  decision actions `revalidatePath` the queue, the decision screen and the
  dashboard. `receipts` is in the publication (0020), so wiring it is a client
  component, not a migration.
- **A decision sends no notification.** The audit row that would trigger one is
  written; delivery belongs to the notifications slice.
- **The per-field source chips report the parse TIER, not a per-field tier.**
  `buildParseMeta` records presence per field and the tier the parse ran in, so
  `fieldChip` shows that plus the receipt's `parse_confidence` rather than a
  per-field confidence, which does not exist. Genuine per-field provenance is a
  `parse.ts` change.
- **`src/lib/supabase/types.ts` has not been regenerated since 0021.** It names
  neither `audit_logs`, nor `record_receipt_visit`, nor
  `receipts.visit_recorded_at`. Three structural narrowings stand in for them
  (`ReceiptRpcClient` in `server/award.ts`, `AuditLogClient` in
  `server/review.ts`), each marked as deletable the moment the types are
  regenerated. Regenerate before adding a fourth.
- **`fraud.cooldown_applied` is not audited.** Doc 37 wants an audit row when
  the strike ladder fires. 0022 landed the table with this slice, but the row
  needs an actor and a request id and the pipeline has neither
  (`actor_kind='system'`); wiring a system-actor write belongs to the jobs
  slice. Marked `TODO(audit)` in `server/cooldown.ts`.
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
- **`SUPABASE_SERVICE_ROLE_KEY` is required for the pipeline AND for review.**
  It is optional in `src/lib/env.ts` so the rest of the app boots without it, but
  receipts are service-role-write-only by design: without the key,
  `requireServiceRoleClient()` returns 503 on submit,
  `defaultProcessReceiptDeps()` returns null and logs, `defaultReviewDeps()`
  refuses with `DEPENDENCY_UNAVAILABLE`, and `defaultReviewQueueDeps()` makes the
  queue render "cannot load" rather than an empty list, since an empty list is a
  claim that there is nothing to review. The credential lands at
  the end of the build per standing orders.
- **Pre-bound match verification is structurally vacuous.** `matchBusiness` has
  a contradiction path, but `buildMatchCandidates` only ever hands it the
  pre-bound business, so the path can never fire and there is nothing for the
  receipt to contradict. A legible receipt from ANY store, submitted with a
  `business_id` of the consumer's choosing, lands on the 0.85 pre-bound floor
  and auto-approves. The three dedupe layers do not help: pHash, sha256 and
  receipt-number dedupe only stop reuse of the SAME receipt, and this is a
  genuine unused one at the wrong merchant. Closing it needs rival candidates,
  which needs the template management UI plus generic-scan candidate scoring.
  This is the highest-value item in the V1 matching slice. See "The pure
  engines" above for exactly what is and is not verified today.
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
