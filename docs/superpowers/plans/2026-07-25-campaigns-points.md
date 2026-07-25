# Giya Campaign + Points Engine Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement `docs/superpowers/specs/2026-07-25-campaigns-points-design.md`: campaigns-domain schema + RLS, the pure points + campaign-lifecycle engines (TDD), and business-portal campaign + base-points-rule management.

**Architecture:** Migration authored as a file, applied by the CONTROLLER via MCP. Pure engines have zero IO and are the exhaustively-tested core. Feature-first `src/features/campaigns/` + `src/features/points/`. Server actions + RLS/composite-FK tenant control, mirroring the catalog slice.

## Global Constraints

- DDL authority: `docs/20-data/23-schema-campaigns.md` verbatim + integrity table; conventions `20-data-model.md`; RLS doc 12 using the table-truth `private.is_active_staff(bid, roles)` helper (already live from 0010) for ALL staff policies - do NOT use claim-based is_staff_of. Engine semantics: `docs/30-modules/34-campaign-engine.md`, `docs/30-modules/35-points-engine.md` (implementers read these).
- Adaptations: `private.uuid_generate_v7()`; standard audit columns + `private.touch_updated_at()` trigger where doc marks `+audit`; `deleted_at` where marked; NO audit/deleted on `points_transactions` (immutable). `points_transactions.receipt_id` is a bare `uuid` (no FK - receipts table ships later); keep `pt_receipt_earn_once` partial unique on it. Composite FKs (like catalog 0008): child payload rows (promotions/rewards/loyalty_programs/points_rules) referencing `campaign_id` must also match `business_id` -> add `campaigns` unique `(id, business_id)` and composite FKs.
- Ledger: `before update or delete` trigger raising an exception on `points_transactions` + `revoke update, delete ... from authenticated, anon`. No client insert/update/delete policy (service-role fence).
- App: tokens only, zero em-dashes incl. comments (peso sign U+20B1 ok), TS strict no any, money integer centavos, server actions confirm session + resolve business server-side + `{ok}|{ok:false,message}`, never throw. Conventional Commits scope `campaigns`/`points`. Branch `feat/campaigns-points`. Existing suite (229) green each task.
- Pure engines: no imports of server/db/React; deterministic; every branch unit-tested.

---

### Task 1: Author migration 0012 + pgTAP

**Files:** Create `supabase/migrations/0012_campaigns.sql`, `supabase/tests/rls_campaigns_smoke.sql`.

**Binding:** all nine tables verbatim from doc 23 with the adaptations above; read `supabase/migrations/0007_catalog.sql` + `0008` + `0010` first to match this repo's exact conventions (audit cols, touch triggers, is_active_staff policies, composite-FK pattern, public/staff select split). RLS per spec section 2. Ledger immutability trigger + revokes. Integrity indexes/constraints verbatim. Composite `(id, business_id)` unique on campaigns + composite FKs on the four payload children. pgTAP >= 10 assertions per spec.

**Steps:**
- [ ] Read docs 23, 20, and skim 12; read 0007/0008/0010. Author 0012 + pgTAP.
- [ ] Self-check: RLS enabled on all 9; ledger has no update/delete grant + trigger; is_active_staff used (not is_staff_of); FK order (campaigns -> payloads -> claims/redemptions/cards; points_transactions after reward_claims? note reward_claims.points_txn_id -> points_transactions and points_transactions has no FK to reward_claims except claim_id -> reward_claims: circular! resolve by creating points_transactions first WITHOUT waiting on reward_claims, and reward_claims.points_txn_id FK added after both exist, OR make claim_id/points_txn_id FKs deferrable / add one via ALTER after both tables exist). Handle the circular FK explicitly. Zero em-dashes.
- [ ] `npm test` still green. Commit: `feat(campaigns): campaigns/points/rewards/loyalty schema, RLS, ledger immutability, pgTAP (authored)`

---

### Task 2 (controller): apply 0012 + verify + types
- [ ] MCP apply_migration 0012 (fix-forward in-file before first success). Run rls_campaigns_smoke via execute_sql; all pass. Verify ledger immutability live (attempt update -> raises). get_advisors security -> no new ERROR. generate_typescript_types -> overwrite src/lib/supabase/types.ts; build green. Commit: `db(campaigns): apply campaigns migration, regenerated types`

---

### Task 3: pure points engine (compute + conditions) - TDD
**Files:** Create `src/features/points/conditions.ts` (+ test), `src/features/points/compute.ts` (+ test), `src/features/points/types.ts`.
**Binding:** per `docs/30-modules/35-points-engine.md` (read it fully). `evaluateConditions(conditions, ctx)` pure: days (ISO 1-7), time_from/to (HH:MM, midnight span when from>to), min_amount_centavos, birthday flag, first_visit flag; `ruleConditionsSchema` Zod `.strict()`. `computePoints({amountCentavos, receiptDate, businessTimezone, baseRule, candidateRules, visitContext})`: base rule (amount_rate = floor/round/ceil(amount/rate) per rounding; fixed_per_visit; fixed_per_receipt; tiered_amount via tiers array), then eligible multipliers/bonuses (isLive + conditions), stacking `effective = 1 + Σ(mᵢ-1)` then bonuses added, integer result per rounding, returns `{points, breakdown, ruleSnapshot}`. NO IO. Timezone handling: evaluate day/time at receiptDate in businessTimezone (use a small pure helper; Intl or a fixed offset for Asia/Manila UTC+8 with a documented note). Exhaustive tests: each rule_type; rounding modes; the doc worked example (P485 Friday 2x -> 970); multiple-multiplier stacking; bonus after; no-eligible-rules -> base only; tiered boundaries.
**Steps:**
- [ ] TDD conditions then compute (RED first, then GREEN). Full branch coverage.
- [ ] Gates. Commit: `feat(points): pure points computation and condition DSL engines`

---

### Task 4: pure campaign lifecycle engine - TDD
**Files:** Create `src/features/campaigns/lifecycle.ts` (+ test), `src/features/campaigns/types.ts`.
**Binding:** per `docs/30-modules/34-campaign-engine.md` (read it). `canTransition(from,to)` + `nextStatus(campaign, action)` for draft/scheduled/active/paused/ended/archived (transitions T1-T9; archived terminal; no ended->active); `activationGates(campaign, payload, business)` returning `{ok, failures:[{code,message}]}` with codes BUSINESS_NOT_VERIFIED (business.status !== 'active'), CAMPAIGN_PAYLOAD_INCOMPLETE (per type->payload map: promotion needs promotions row; reward needs >=1 rewards; loyalty needs loyalty_programs + prize reward), CAMPAIGN_SCHEDULE_INVALID (ends>starts, not in past for scheduled), CAMPAIGN_BUDGET_INVALID (budget numbers non-negative); `isCampaignLive(campaign, atDate)` (status active + within [starts_at, ends_at] window, timezone-aware; recurrence deferred). Pure, exhaustive tests incl. every transition (valid + invalid), each gate failure + all-pass, live/not-live windows.
**Steps:**
- [ ] TDD lifecycle. Full coverage.
- [ ] Gates. Commit: `feat(campaigns): pure campaign lifecycle, activation gates, live-window engine`

---

### Task 5: schemas + repo + service + actions
**Files:** Create `src/features/campaigns/schemas.ts`, `server/repo.ts`, `server/service.ts`, `actions.ts`; `src/features/points/schemas.ts`, `server/repo.ts`, `server/service.ts`, `actions.ts`; tests `src/features/campaigns/campaigns.test.ts`, `src/features/points/rules.test.ts`.
**Binding:** Zod schemas for promotion/reward/loyalty campaign create + base points rule. Repo (server client, RLS-scoped): createCampaignWithPayload (transactional - sequenced inserts; the composite FK backstops tenant; on any failure return {ok:false} and note partial-row risk -> prefer a single Postgres RPC `create_campaign` if clean, else document the sequence and rely on the composite FK + revalidate), updateCampaign, setCampaignStatus (calls lifecycle.canTransition + activationGates on activate), listCampaigns, getCampaignPayload; upsertBaseRule (one-active-base; friendly message on unique violation), listRules. Actions: session + resolveOwnerBusiness (reuse the catalog/menu resolveOwnerBusiness or lift a shared one to src/features/businesses/server) + Zod + service + revalidatePath + {ok}. Reuse the money helper + is_active_staff-backed RLS (no app-level role check needed beyond session; RLS enforces). Tests: action arg validation + gate enforcement (activate a payload-incomplete campaign -> {ok:false, message} with the gate code) with mocked client.
**Steps:**
- [ ] TDD actions/service. Gates. Commit: `feat(campaigns): campaign and points-rule schemas, services, server actions`

---

### Task 6: business portal campaigns + points-rule UI
**Files:** Create `src/app/(business)/business/(portal)/campaigns/page.tsx` (repoint stub), `src/features/campaigns/components/` (campaigns-manager.tsx client, campaign-list.tsx, campaign-form.tsx with the type picker + type-specific fields, earning-rule-card.tsx for the base rule editor). Test: campaign-form validation.
**Binding:** server page resolves business (redirect to onboarding if none), loads campaigns + base rule, renders `<CampaignsManager>` (client) using the reusable `src/components/ui/dialog.tsx`. Create flow: pick type (Promotion/Reward/Loyalty) -> RHF+Zod form -> createCampaign action. List with status chips + activate/pause/archive (surface gate-failure messages inline). Earning-rule card: edit the base rule (amount_rate rate or fixed_per_visit), upsertBaseRule action. Teal-led, both themes, empty states, 48px primary controls (md ok desktop), zero em-dashes, money via formatPeso/pesoToCentavos.
**Steps:**
- [ ] Failing campaign-form test. Build components + page.
- [ ] Gates + curl `/business/campaigns` anon -> redirect. Commit: `feat(campaigns): business portal campaign and earning-rule management`

---

### Task 7 (controller): live E2E + final review + merge
- [ ] Login as the seeded E2E owner; at `/business/campaigns` set a base points rule (amount_rate) and create a promotion campaign; activate it (gates pass); verify persistence + RLS via MCP; verify one-active-base-rule (a 2nd base insert rejected) + ledger immutability (update raises) via MCP; confirm cross-tenant campaign write denied (simulated claims). Screenshot both themes.
- [ ] Sweep: gates, em-dash scan, TODO markers. Final whole-branch review (most capable model), fix wave, merge per finishing-a-development-branch. Update ledger + debt.
