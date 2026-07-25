# Giya Campaign Engine + Points Engine Slice - Design Spec

**Date:** 2026-07-25
**Status:** Approved (autonomous, recommended); ready for planning
**Depends on:** identity + catalog slices (RLS `is_active_staff`, business_staff membership, feature-first patterns, money helper). Target: Supabase `dcnpuvtbftpbcjcvfnlt`.

## 1. Goal

Stand up the core domain: the full campaigns/points/rewards/loyalty schema (storage contract per doc 23), the two pure engines that are the heart of the product (points calculation + campaign lifecycle) built TDD-first with exhaustive unit tests, and business-portal campaign + points-rule management. Consumer-facing reward claim/redemption/loyalty flows and the receipt-triggered award pipeline are explicitly deferred to following slices (they depend on receipts + a customer surface).

## 2. Database (migration 0012_campaigns)

Authority: `docs/20-data/23-schema-campaigns.md` (verbatim tables + integrity rules), conventions `20-data-model.md`, RLS doc 12. All nine tables: `campaigns`, `promotions`, `points_rules`, `rewards`, `reward_claims`, `redemptions`, `loyalty_programs`, `loyalty_cards`, `points_transactions`.

Adaptations (same family as catalog 0007): `private.uuid_generate_v7()`; audit/`deleted_at` columns + touch triggers where doc marks `+audit`/`+deleted_at` (NOT on `points_transactions`/`redemptions`/`reward_claims` immutable-ish tables per doc - points_transactions has NO updated_at/deleted_at); `extensions.gin_trgm_ops` if any trgm index. **Deferred FK:** `points_transactions.receipt_id` and `pt_receipt_earn_once`/`pt_receipt_idx` reference a `receipts` table that ships later - make `receipt_id uuid` a bare column (no FK) now, keep the partial unique index on it (works on a plain uuid), and add the FK in the receipts migration. Comment this clearly.

**Ledger immutability (critical, doc 23):** `points_transactions` gets a `before update or delete` trigger that `raise exception`s, plus `revoke update, delete on public.points_transactions from authenticated, anon` (service_role writes via inserts only). RLS: P3 select (consumer own rows via `consumer_id = auth.uid()`; staff own tenant via `is_active_staff(business_id, [owner,manager,marketing])`); NO insert/update/delete policy for client roles (all ledger writes go through service-role points-service code paths, same fence as `receipts`/`business_customers`).

RLS per table (is_active_staff table-truth throughout, matching 0010/0011):
- `campaigns`, `promotions`, `rewards`, `points_rules`, `loyalty_programs`: staff select (4 roles); public select of active/live rows (campaigns where status='active' and deleted_at is null; promotions/rewards/loyalty_programs where their campaign is active - simplest single-table: public read where deleted_at is null and is_active where the column exists, plus join-free predicate; document the exact predicate); insert/update owner+manager (per matrix: marketing can also create/edit campaigns - use [owner,manager,marketing] for campaigns/promotions/rewards writes, [owner,manager] for points_rules per matrix "Edit points rules"). Composite FKs where a child references campaign_id AND business_id (same defense as catalog 0008): promotions/rewards/loyalty_programs/points_rules -> campaigns must be same-tenant.
- `reward_claims`, `loyalty_cards`: P3 dual-audience (consumer self-select; staff select own tenant); writes service-role only (no client policy).
- `redemptions`: staff select own tenant; writes service-role only.

Integrity indexes/constraints verbatim from doc 23: `points_rules_one_base` (partial unique), `rewards_remaining_lte_total`, `redemptions.claim_id` unique, `loyalty_cards (program_id, consumer_id)` unique, `pt_receipt_earn_once`, campaign window check, the campaigns/points/rewards indexes. pgTAP smoke (`rls_campaigns_smoke.sql`): staff write own campaign; public reads active campaign not draft; cross-tenant deny; one-base-rule rejects a second active base; ledger UPDATE/DELETE raises; consumer sees own ledger rows only. >= 10 assertions.

## 3. Pure engines (the confidence deliverable, TDD)

`src/features/points/compute.ts` - `computePoints(input): PointsResult` per `docs/30-modules/35-points-engine.md`:
- Inputs: `{ amountCentavos, receiptDate, businessTimezone, baseRule, candidateRules: Rule[], visitContext? }`.
- Evaluates the base rule (amount_rate: `floor(amount/rate)` with rounding mode; fixed_per_visit; fixed_per_receipt; tiered_amount), then eligible multiplier/bonus rules (conditions DSL: days[ISO 1-7], time_from/to with midnight span, min_amount_centavos, birthday flag), applies stacking (`effective = 1 + Σ(mᵢ-1)` additive on multipliers, bonuses added after), returns `{ points, breakdown, ruleSnapshot }`. Pure, deterministic, no IO. Exhaustive tests incl. the doc's worked example (₱485 Friday 2x -> 970).
- `src/features/points/conditions.ts` - the condition evaluator (`ruleConditionsSchema` Zod `.strict()`, `evaluateConditions(conditions, ctx)`), pure, tested (days, time windows incl. midnight, min amount).

`src/features/campaigns/lifecycle.ts` - per `docs/30-modules/34-campaign-engine.md`:
- `canTransition(from, to): boolean` and `nextStatus(campaign, action)` for the state machine (draft->scheduled->active->paused->ended->archived; transitions T1-T9; invalid -> a typed error/false).
- `activationGates(campaign, payload): GateResult` - G1 business active, G2 payload complete (per type->payload mapping), G3 schedule valid, G4 budget valid, G5 targeting valid; returns `{ ok, failures: [{code,message}] }` with the doc's error codes (BUSINESS_NOT_VERIFIED, CAMPAIGN_PAYLOAD_INCOMPLETE, CAMPAIGN_SCHEDULE_INVALID, CAMPAIGN_BUDGET_INVALID).
- `isCampaignLive(campaign, atDate): boolean` - status active + within schedule window (timezone-aware, recurrence deferred [V1] - simple window this slice), used later by the award pipeline.
All pure, TDD, no DB. These are reused by the award pipeline (next slice) and the portal.

## 4. Points + campaign services/actions

`src/features/campaigns/` (schemas, server/repo, server/service, actions, types) and `src/features/points/` (schemas for rules, server/repo, server/service, actions):
- Campaign actions (owner/manager/marketing): createCampaign (type promotion|reward|loyalty this slice; creates the container + payload row transactionally via an RPC or sequenced inserts with the composite-FK backstop), updateCampaign, activateCampaign (runs `activationGates`, refuses with the gate failure message), pauseCampaign, archiveCampaign; listCampaigns.
- Points-rule actions (owner/manager): upsertBaseRule (enforces one active base via the partial unique + a friendly message on conflict), listRules.
- All actions: session + resolveOwnerBusiness server-side, Zod parse, `{ok}|{ok:false,message}`, revalidatePath. Ledger writes are NOT exposed as client actions (service-role only, exercised by the award pipeline later); this slice does not insert ledger rows from the UI.

## 5. Business portal UI

`/business/campaigns` (repoint the ComingSoon stub): list campaigns (name, type, status chip, schedule) grouped/filtered by status; "New campaign" opens the reusable `Dialog` -> a type picker (Promotion / Reward / Loyalty) then a type-specific form (RHF+Zod). Promotion form: name, description, offer kind + value, dates, terms. Reward form: name, points cost, inventory, per-customer limit, expiry days. Loyalty form: program type, target, stamp settings, prize reward. Activate/pause/archive buttons calling the actions, surfacing gate-failure messages inline. Teal-led, both themes, empty state.
`/business/settings` or a "Points" section: the base points-rule editor (rule type amount_rate with rate, or fixed_per_visit with fixed points; rounding) - simplest: a dedicated `/business/campaigns` sub-panel or a small card on the campaigns page "Earning rules". Keep it one focused editor for the base rule this slice.

## 6. Constraints

Tokens only; zero em-dashes (peso sign ok); TS strict no any; both themes; money integer centavos; server actions never trust client ids; RLS + composite FKs are the tenant control; ledger immutable; feature-first; Conventional Commits scope `campaigns` (and `points`). Existing suite green each task. External services: none needed this slice.

## 7. Out of scope

Consumer reward claim/redeem/QR + staff validation (next slice); loyalty card consumer UI; the receipt-triggered award pipeline (needs receipts, module 36); manual points adjustment UI (needs CRM/customer surface); points expiry sweep + clawbacks/referrals [V1]; campaign targeting/audience + recurrence [V1]; budget enforcement at award-time (built into gates now, enforced when awards run); consumer wallet reading the real ledger (wired when receipts award points).

## 8. Success criteria

1. 0012 applied + committed; nine campaigns-domain tables live; ledger UPDATE/DELETE raises; advisors no new ERROR; pgTAP campaigns smoke passes; types regenerated.
2. `computePoints` + `campaignLifecycle` pure engines pass exhaustive unit tests incl. the doc worked examples and every rule_type/condition/transition/gate.
3. A business owner can create a promotion campaign + a base points rule at `/business/campaigns`, activate the campaign (gates enforced), and it persists (verified live); cross-tenant campaign write blocked by RLS.
4. Gates green (lint, tests, build); zero em-dashes; both themes.
5. One-active-base-rule and ledger-immutability invariants verified live via MCP.
