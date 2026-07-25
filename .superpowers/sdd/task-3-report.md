# Task 3 report: pure points computation + condition DSL engines

Status: COMPLETE. Commit `debf0a5` `feat(points): pure points computation and condition DSL engines` on `feat/campaigns-points`.

## Files
- `src/features/points/types.ts` - RuleKind/RuleType/RoundingMode, RuleTier, RuleConditions, PointsRule (snake_case fields mirroring the `points_rules` columns; tiers camelCase per the brief), ComputePointsInput, PointsBreakdown, PointsResult. Zero IO in the whole feature dir (no server/db/React imports).
- `src/features/points/conditions.ts` + `conditions.test.ts` - `ruleConditionsSchema` (Zod v4 `z.strictObject`, equivalent to `.strict()`) and `evaluateConditions(conditions, ctx)`.
- `src/features/points/compute.ts` + `compute.test.ts` - `deriveLocalDayTime(receiptDate, timeZone)` and `computePoints(input)`.

## Conditions DSL (as implemented)
- Keys: `days` (int 1-7 ISO, nonempty), `time_from`/`time_to` (`^([01]\d|2[0-3]):[0-5]\d$`), `min_amount_centavos` (int >= 0 per the task brief; doc 35 shows `.positive()` - relaxed to allow an explicit 0 no-op floor), `birthday`, `first_visit`. Unknown keys rejected. Refine: time_from/time_to must be set together (kept from doc 35).
- Doc 35's referral-only keys (`referrer_points`/`referee_points`) are intentionally NOT in this schema: they are a [V1] referral-slice concern; the strict schema will grow when that slice lands.
- Evaluation: all present keys AND together; `{}` always true. `days`: weekday must be in list. Time window: from inclusive, to exclusive; `from > to` spans midnight (`m >= from || m < to`); `from == to` is an empty window (never matches, documented). `min_amount_centavos`: amount >=. `birthday: true` requires `ctx.isBirthday === true` (undefined = not a birthday); `birthday: false` is a no-op gate. Same for `first_visit`.

## Compute algorithm (as implemented)
1. Derive `{weekday, minutesOfDay}` from `receiptDate` in `businessTimezone` via `Intl.DateTimeFormat` with `timeZone` + `hourCycle: "h23"` (`formatToParts`, weekday short name mapped Mon=1..Sun=7). Works for any IANA zone (Asia/Manila is fixed UTC+8, no DST); pure and deterministic; RangeError on an invalid zone id.
2. Base points from `baseRule`, gated by the base rule's OWN conditions (doc 35 allows e.g. a `min_amount_centavos` earning floor on base; a failed base condition yields 0 base while independent bonuses still apply):
   - `amount_rate`: `rounding(amountCentavos / rate_centavos_per_point)` with floor / round (Math.round = half-up for non-negatives) / ceil.
   - `fixed_per_visit` / `fixed_per_receipt`: `fixed_points` (visit-day dedup is the caller's job; the pure engine treats both identically).
   - `tiered_amount`: first tier where `minCentavos <= amount <= maxCentavos` (both ends inclusive); `maxCentavos: null` = open-ended top tier. No matching tier (below all, in a gap, or above a CLOSED top tier) awards 0 (documented choice: a closed tier table means "nothing beyond this").
   - Misconfigured rules (missing rate/fixed_points/tiers) THROW rather than silently award 0.
3. Eligible candidates = `candidateRules` whose conditions pass. Campaign liveness/audience/budget filtering is the caller's job (doc 34); the engine documents that `candidateRules` arrive pre-filtered.
4. Multipliers stack additively: `effectiveMultiplier = 1 + sum(m_i - 1)`. `multipliedBase = max(0, floor(basePoints * effectiveMultiplier))`. Decision: floor always (not the base rule's rounding), documented in code - the house never rounds the stacked product up, and per-rule rounding already shaped the base. Note: doc 35 states per-multiplier extras `round_i(base * (m_i - 1))`; the task brief explicitly mandated the effective-multiplier-then-floor formulation with the `{effectiveMultiplier, multipliedBase}` breakdown, which is what is implemented. The two agree whenever extras are integral (incl. both worked/stacking examples); they can differ by <= n-1 points on fractional multipliers.
5. Bonuses: `sum(bonus_points)` of eligible bonus rules, added AFTER multiplication, never multiplied, never rounded.
6. `points = max(0, multipliedBase + bonusPoints)`, always an integer >= 0 (negative effective multipliers from sub-1x stacks clamp at 0).
7. `ruleSnapshot`: deep-frozen `{engine: "points/v1", amount_centavos, receipt_date, timezone, base:{rule_id, rule_type, rounding, eligible, points}, multipliers:[{rule_id, multiplier}], bonuses:[{rule_id, bonus_points}], effective_multiplier, total_points}`. No `computed_at` (would be impure); the IO layer stamps it at insert time.

## Worked example (doc 35 section 3)
48500 centavos, receiptDate `2026-07-24T04:40:00Z` (= Friday 12:40 Asia/Manila), base amount_rate rate 100 floor, candidate 2.00x multiplier `{days:[5]}`:
base 485 -> effective 2 -> multipliedBase 970 -> bonuses 0 -> **points = 970**. Asserted exactly, including the full breakdown.

## Tests
58 new tests (25 conditions + 33 compute): schema accept/reject matrix (strict keys, day bounds, HH:MM regex, paired times, min_amount), every DSL predicate incl. midnight-spanning 22:00->02:00 window and from==to; timezone derivation (Manila noon, date-line crossing to Saturday, local midnight Sunday, UTC, America/New_York DST zone); every rule_type; all three rounding modes on fractional cases; tiered boundaries (at min, at max, between tiers, gap, above closed top -> 0, open-ended top); worked example -> 970; 2x+3x additive stacking -> 4x -> 1940; fractional multiplier floor; bonus-after-multiplication; multi-bonus sum; failing-condition exclusion; no candidates -> base only; birthday/first_visit gating; base earning floor; sub-1x clamp to 0; integer invariant; deep-frozen snapshot contents; throw-on-misconfig.

## Gates
- `npm test`: 28 files, **287 passed** (229 existing + 58 new), 0 failed.
- `npm run lint`: clean. `npm run build`: compiled + TypeScript clean (strict, exactOptionalPropertyTypes, no any).
- Zero em-dashes in the new files (verified by grep). No IO imports anywhere in `src/features/points/`.

## Fix report

Status: COMPLETE. Money-path correctness fix so `computePoints` exactly matches doc 35 "Arithmetic (exact)" and the doc 34 section 6 additive-extras model. Commit `fix(points): per-multiplier rounding of extras per points-engine spec (doc 35)` on `feat/campaigns-points`.

### What changed
- `src/features/points/compute.ts`: replaced the effective-multiplier-then-floor formulation (`floor(base * (1 + sum(m_i - 1)))`) with per-rule extras: `extra_i = round_i(base_points * (multiplier_i - 1))` using THAT multiplier rule's `rounding` column (floor|round|ceil, round = half-up); `TOTAL = max(0, base_points + sum(extra_i) + sum(bonus_points))`, all integers. Base rounding and verbatim bonuses unchanged; eligibility filtering (conditions DSL + pre-filtered candidates) unchanged. Rounding applies per contribution, never to the running total.
- `src/features/points/types.ts`: `PointsBreakdown` is now `{basePoints, multipliers: [{multiplier, rounding, extra}], multiplierExtras, bonusPoints, total}` (new `MultiplierBreakdown` type); `effectiveMultiplier`/`multipliedBase` removed.
- `ruleSnapshot.multipliers` entries now carry `rounding` and `points_delta` (= extra_i) per doc 35's frozen shape; `effective_multiplier` removed. `campaign_id`/`priority`/`is_stackable` remain the caller/service layer's job (the pure engine does not see campaigns).
- `compute.test.ts`: kept the worked examples (485 Friday 2x floor -> 970; 100 base 2x + 50 bonus -> 250; 2x + 3x on 485 -> 1940) and corrected/added divergence cases: base 3 with two 1.5x floor -> 5 (old code said 6); 1.25x ceil on base 485 -> 485 + ceil(121.25) = 607 (old: 606); mixed 2x floor + 1.5x ceil on 485 -> 485 + 485 + 243 = 1213; 1.5x round (half-up) on base 3 -> 5; sub-1x clamp now asserts per-rule extras (floor(485 * -0.75) = -364 each).

### Gates
- `npm test`: 29 files, 355 passed, 0 failed. `npm run lint`: clean. `npm run build`: compiled + TypeScript clean. Zero em-dashes in the touched files.
- Note: the "Compute algorithm" section above (items 4, 6, 7) describes the pre-fix behavior; this fix report supersedes it.
