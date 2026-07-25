# Plan: Receipt Review Queue Slice

**Spec:** `../specs/2026-07-25-receipt-review-queue-design.md`
**Branch:** `feat/receipt-review-queue`
**Method:** subagent-driven-development, reviewer per task (opus for the SQL and the shared award path), controller applies migrations and verifies live, final whole-branch review before merge.
**Ledger:** append to `.superpowers/sdd/progress.md`.

Gates every task: `npm run lint`, `npx tsc --noEmit` (only the 5 known pre-existing test-file errors), `npx vitest run` (1592 green at branch point), `npm run build` where UI changed. Conventional Commits scope `receipts`. Zero em-dashes, tokens-only UI, TS strict.

---

## T1. Migration 0022: `audit_logs`

Author `supabase/migrations/0022_audit_logs.sql` per doc 25 and spec section 3, plus `supabase/tests/rls_audit_logs_smoke.sql`. Append-only with the full house treatment: no client write policies, `revoke insert, update, delete, truncate` from anon/authenticated and `update, delete, truncate` from service_role, a raising BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE statement trigger, mirroring 0012's ledger and 0017's evidence tables. Staff read own tenant via `private.is_active_staff`; no consumer policy. pgTAP with insert-returning CTE fixtures only.
**Reviewer: opus.** Controller applies, runs pgTAP, checks advisors, regenerates types.

## T2. Extract the shared award path

Refactor, no behaviour change. `process.ts` currently owns the approve-and-award sequence inline. Extract it into one function in `src/features/receipts/server/award.ts` that both the pipeline and the review service call: load active rules, `computePoints`, skip the RPC at zero points, call `award_receipt_points`, handle every error string 0018 raises. Doc 36 requires one code path so ledger invariants hold; this task is what makes that literally true rather than aspirational.
The existing `process.test.ts` suite must stay green **unchanged** apart from imports. If a test needs rewriting to pass, that is a behaviour change and it needs justifying, not accommodating.
**Reviewer: opus, money path.**

## T3. The review service

`src/features/receipts/server/review.ts` per spec section 4, with the guard order exactly as specified. The self-review block (reviewer is the submitter) and the not-in-review block (two managers racing) are the two that carry security weight; both get direct tests. Writes the `audit_logs` row with real before and after values. Reuses T2's award function and the pipeline's cooldown-strike logic rather than copying either.
Tests: approve awards once through the shared path; approve with corrected fields persists the corrections and awards on the corrected total; reject writes the reason; self-review refused; deciding an already-decided receipt refused; non-staff refused; cross-tenant refused; fraud-family rejection advances the strike count; every path writes exactly one audit row.

## T4. Queue and decision UI

`/business/receipts` and `/business/receipts/[receiptId]` per spec section 5, plus the sidebar entry with a pending count and the dashboard tile. Server components reading through the service role with the tenancy predicate applied in code (spec section 2 explains why the column grant forces this). 5-minute signed URLs for images. Doc 37's evidence display contract: per-field source and confidence chips from `parse_meta`, the fraud signal list with rendered evidence, side by side with the image.
Desktop-first portal layout that still works on mobile, both themes, tokens only. The decision actions are server actions calling T3.
Tests: queue renders and filters, the decision screen renders fields and signals, approve and reject actions wire through, and a test asserting the consumer-facing surfaces still cannot see any of this.

## T5. Live verification (controller)

Seed a receipt into `review` on the live database. Approve it through the real service with corrected fields and assert: one earn row, `balance_after` correct, cached balance equals ledger sum, `reviewed_by`/`reviewed_at` set, one audit row with before and after. Then the refusals: self-review, double decision, cross-tenant, non-staff. Reject a second receipt for a fraud reason and confirm the strike count advanced. Browser pass on both screens in both themes. Clean up every row created and prove it.

## T6. Docs and close

Update `src/features/receipts/README.md` (the review path now exists; correct anything the previous slice wrote as future tense), `supabase/README.md` (ledger row for 0022, pgTAP suite table), and `.superpowers/sdd/progress.md`. Record remaining debt: the admin queue still needs the access token hook; notifications on decision belong to the notifications slice. Then whole-branch review, fix wave, merge.

---

## Risks

- **Two award paths drifting** is the single biggest risk and the reason T2 comes before T3. If T3 is tempted to inline its own award sequence, stop and fix T2 instead.
- **Service-role reads in server components** bypass RLS, so the tenancy check moves into code. Every such read must apply the business scope explicitly; a missed scope is a cross-tenant leak that no policy will catch. The reviewer should treat every service-role query in T4 as a tenancy assertion to verify.
- **`parse_meta` reaching a consumer surface.** It is withheld by the column grant, but T4 introduces the first code that reads it. Keep it strictly inside the business portal tree.
