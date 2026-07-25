# Giya Receipt Review Queue Slice - Design Spec

**Date:** 2026-07-25
**Status:** Approved (autonomous, recommended); ready for planning
**Canonical docs:** `30-modules/36-receipt-ocr-pipeline.md` (Stage 9 "Human review queue" and Stage 10), `30-modules/37-fraud-detection.md` (review queues, evidence display contract, consequences ladder), `30-modules/32-business-portal.md`, `20-data/25-schema-platform.md` (`audit_logs`), `10-architecture/15-security.md` (signed URL TTL, mandatory reason on admin actions).
**Depends on:** the receipts slice (merged): `receipts`, `ocr_results`, `fraud_signals`, `receipt_line_items`, `award_receipt_points`, `processReceipt`.

## 1. Goal

Receipts routed to `review` currently sit forever: nothing in the product can resolve them. This slice gives owner and manager a queue where they see the image beside the parsed fields and the fraud context, correct the fields, and approve or reject. Approving awards points through exactly the same path auto-approval uses.

Doc 36 is explicit and this is the central design constraint: **"Approve path is identical to auto-approval: the same service function transitions review to approved, sets reviewed_by/reviewed_at, persists edited fields, and invokes the points engine, no separate code path, so ledger invariants hold."** There will be one award path, not two.

## 2. Why the review UI reads server-side

0017 put a column-level SELECT grant on `receipts` for `authenticated`, withholding `parse_meta`, `parse_confidence`, `match_confidence`, `reject_note`, `sha256` and `image_hash`. Column privileges are role-wide and staff are the same `authenticated` role as consumers, so a single grant cannot give staff more columns than consumers. The review UI therefore reads through the service role in server components and server actions, with tenancy enforced in code by the same `is_active_staff` predicate the policies use. This was a deliberate trade recorded in 0017; this slice is where it lands.

## 3. Database

**Migration 0022 - `audit_logs`** (pulled forward from doc 25, the remaining platform tables land with the jobs slice). Every reviewer action writes one row: `actor_id`, `action`, `entity_type`, `entity_id`, `business_id`, `before`, `after`, `reason`, `request_id`, `created_at`. Append-only with the house treatment the ledger and receipt evidence already have: no client write policies, `revoke insert/update/delete/truncate` from the app roles, a raising BEFORE UPDATE OR DELETE row trigger, and a BEFORE TRUNCATE statement trigger. Staff read their own tenant's rows; there is no consumer policy.

Actions registered by this slice, per doc 37's reviewer-action mapping: `receipt.review_approved`, `receipt.review_rejected`.

pgTAP: staff read own tenant only, consumer reads nothing, client writes refused at both the policy and privilege layer, update and delete raise, truncate raises.

## 4. The review service

`reviewReceipt({ receiptId, businessId, actorId, action, fields?, rejectReason?, rejectNote?, requestId })`, service-role, in `src/features/receipts/server/review.ts`.

Guards, in order:
1. Active `owner`/`manager` of the receipt's business, else `FORBIDDEN`.
2. Receipt is in `review`, else `RECEIPT_NOT_REVIEWABLE` (an already-decided receipt must not be decided twice; this is the optimistic-concurrency guard for two managers opening the same item).
3. **`reviewed_by` must not equal `receipts.user_id`**, else `FORBIDDEN`. Doc 37 S9 requires that a staff member cannot decide their own submission. This is the insider control and it is not optional.
4. Approve path: validate edited fields (same Zod shape the pipeline uses), persist them with `reviewed_by`/`reviewed_at` and `status='approved'`, then run the shared points path: load active rules, `computePoints`, `award_receipt_points`. Zero points still approves without calling the RPC, exactly as the pipeline does.
5. Reject path: `status='rejected'` with a reason from the enum and an optional note, `reviewed_by`/`reviewed_at` set. A fraud-family rejection runs the same cooldown-strike check the pipeline runs.
6. Write the `audit_logs` row with before and after.

The award step is extracted from `process.ts` into one shared function both callers use, rather than reimplemented. That refactor is part of this slice and is the reason doc 36 wrote the constraint down.

## 5. Business portal surfaces

- **`/business/receipts`** - the queue. Default filter `status=review`, with tabs for approved and rejected history. Shows queue age, because doc 36 sets a 24h SLA target and an admin alert at 48h. Sidebar gains a Receipts entry with a count badge for pending review.
- **`/business/receipts/[receiptId]`** - the decision screen. Doc 37's evidence display contract: the receipt image beside an editable field form (merchant, number, date, subtotal, tax, total, line items) pre-filled with parsed values and carrying per-field source and confidence chips from `parse_meta`, plus the fraud signal list with rendered `evidence`. Actions are Approve with edits and Reject with a reason.
- **Image access**: 5-minute signed URLs minted server-side per doc 15. The bucket has no staff policy, so this is the only staff path to a receipt image and it stays server-mediated.
- **Dashboard**: a pending-review count that links into the queue.

Fraud evidence is rendered for staff but never leaves the tenant: signals are already scoped by RLS, and the UI shows severity, score and evidence per doc 37's contract.

## 6. Realtime

The business queue badge subscribes to `receipts` filtered `business_id=eq.{id}` and `status=eq.review` per doc 36. `receipts` is already in the publication (0020).

## 7. Constraints

One award path shared with the pipeline. Ledger writes only through `award_receipt_points`. Reviewer cannot be the submitter. Every decision audited with before and after. Tokens-only UI, both themes, mobile responsive with a desktop-first portal layout. Zero em-dashes. TS strict. Conventional Commits scope `receipts`.

## 8. Out of scope

The admin portal queue: doc 31's admin surfaces need platform-admin JWT claims and the custom access token hook is disabled on this project, so a claim-based admin policy would evaluate null and silently deny. Deferred to the slice that enables the hook, and recorded. Also out: template management UI, clawback, notifications on decision (the notifications slice owns delivery; this slice writes the audit row that would trigger one).

## 9. Success criteria

1. 0022 applied, pgTAP green, no new advisors.
2. A receipt in `review` can be approved with corrected fields and awards exactly one earn row with correct `balance_after`, through the same function auto-approval uses.
3. A staff member cannot decide their own submission.
4. Two managers cannot both decide the same receipt.
5. Every decision writes an audit row with before, after and actor.
6. Rejecting for a fraud-family reason advances the cooldown strike count.
7. Gates green; queue and decision screen verified live in both themes.
