# Giya Rewards + Redemption Slice - Design Spec

**Date:** 2026-07-25
**Status:** Approved (autonomous, recommended); ready for planning
**Depends on:** campaigns+points slice (campaigns/rewards/reward_claims/redemptions/points_transactions tables live, pure engines, is_active_staff RLS). Target: Supabase `dcnpuvtbftpbcjcvfnlt`.

## 1. Goal

Close the reward loop end to end: a consumer sees a business's rewards, claims one (points debited through the immutable ledger, inventory decremented), shows a short-lived redemption QR, and staff validates it at the counter. This is the FIRST slice that writes ledger rows, so the transactional guards from doc 35 section 6 are the core deliverable.

## 2. Ledger writes: service-role + atomic RPC (the critical decision)

Doc 23/35 fence ledger writes behind service-role code paths, and doc 35 section 6 requires claim to be ONE transaction (inventory decrement + balance check + ledger insert + claim insert + balance update). Sequenced client-side inserts cannot provide that. Therefore:

- **Postgres RPC `public.claim_reward(p_reward_id uuid)`** (SECURITY DEFINER, `search_path=''`, granted to `authenticated`, revoked from anon/public), implementing doc 35 section 6 claim steps 1-6 atomically inside the function's implicit transaction:
  1. Resolve caller `auth.uid()` as consumer; raise `42501` if unauthenticated.
  2. Load reward + its campaign; guards: `rewards.is_active`, campaign `status='active'` and within window, consumer's `business_customers.segment <> 'blacklisted'`; per-customer limit (count consumer's non-cancelled claims for this reward vs `rewards.per_customer_limit`; stricter of reward limit and campaign `budget.per_customer_limit`).
  3. Inventory: `update rewards set remaining = remaining - 1 where id = p_reward_id and (remaining is null or remaining > 0) returning remaining`; zero rows -> raise `REWARD_OUT_OF_STOCK`.
  4. Balance: `select ... for update` on `business_customers` (creating the row if absent with balance 0); require `points_balance >= points_cost` else raise `POINTS_INSUFFICIENT`.
  5. Insert `reward_claims` (status `claimed`, `points_spent`, `expires_at = now() + claim_expiry_days`), then insert `points_transactions` (`type='redeem'`, `points = -points_cost`, `claim_id`, `balance_after`), then update the claim's `points_txn_id`. Skip the ledger row entirely when `points_cost = 0` (free/loyalty claims).
  6. Update `business_customers.points_balance`; return the claim id.
  Errors raise SQLSTATE-tagged exceptions the app maps to the doc's error codes (REWARD_OUT_OF_STOCK, POINTS_INSUFFICIENT, REWARD_LIMIT_REACHED, CUSTOMER_BLACKLISTED, REWARD_EXPIRED).
- **RPC `public.validate_redemption(p_claim_id uuid, p_token_jti text, p_method text)`** (SECURITY DEFINER, granted to `authenticated`): staff-side. Guards: caller `private.is_active_staff(business_id, [owner,manager,staff])` (matrix: staff CAN validate), claim `status='claimed'`, `expires_at` future else `CLAIM_EXPIRED`, consumer not blacklisted; insert `redemptions` (unique `claim_id` -> `CLAIM_ALREADY_REDEEMED` on double scan), set claim `status='redeemed'`, `redeemed_at`. **No ledger entry** (points moved at claim).
- Client INSERT on `points_transactions` is revoked in the same migration (closing campaigns-slice debt item 4); the RPCs are the only write path.

## 3. Redemption token (Redis-backed, no fallback)

`src/lib/redis.ts`: Upstash REST client from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (added to `src/lib/env.ts` as **required server-side** env; the app fails fast at boot if absent, since a missing Redis would silently allow QR replay). Key namespace `{env}:` per doc 11.

`src/features/rewards/server/token.ts`:
- `mintRedemptionToken(claimId)`: verifies the caller owns the claim and it is `claimed`/unexpired; mints a signed JWT (HS256, `REDEMPTION_TOKEN_SECRET` env, separate from Supabase keys) with `{ jti, claimId, businessId, exp: now+300 }`; stores `SET {env}:redeem:jti:{jti} claimId NX EX 300`; returns `{ token, expiresAt }`.
- `consumeRedemptionToken(token)`: verifies signature + exp, then `GETDEL {env}:redeem:jti:{jti}` (atomic single-use); missing key -> `REDEMPTION_TOKEN_INVALID` (already used or expired). Returns the claim id for `validate_redemption`.
- Route handlers per doc 13: `POST /api/v1/reward-claims/[claimId]/token` (consumer, mints) and `POST /api/v1/redemptions/validate` (staff, consumes + calls the RPC). Both use the shared response envelope shape and the documented error codes; rate-limited later (doc 13 baseline noted as debt).

## 4. Consumer surfaces

- `/b/[slug]` public business page gains a **Rewards** section (active reward-campaign rewards: name, points cost Badge, inventory-left hint) - public read via existing RLS.
- `/rewards` (consumer app, replacing mock): live "Available" rewards across the consumer's businesses (from active reward campaigns) with a Claim button (calls the claim action -> RPC; disabled with reason when insufficient points/out of stock), and "Claimed" list from real `reward_claims` (status chip, expiry countdown, "Show QR" link).
- `/rewards/claims/[claimId]` **Redemption QR screen**: mints the token on load, renders the QR full-screen (qrcode lib), 5:00 countdown, "Refresh code" after expiry, brightness boost best-effort, offline explanation. Realtime confirmation on the claim row (sanctioned use D5) flipping to a success state when staff validates.
- `/wallet` points balances now read the REAL `business_customers.points_balance` + `points_transactions` history (replacing mock), since the ledger now has rows.

## 5. Staff surface

`/business/redeem` (portal): a scan screen (camera QR reader via `@zxing/browser` or `html5-qrcode`; choose one, document) that on decode POSTs to `/api/v1/redemptions/validate`; shows success (reward name, consumer display name) or the mapped error (expired, already redeemed, invalid). Manual-code fallback deferred [V1]. Staff role allowed per matrix.

## 6. Constraints

Tokens only; zero em-dashes; TS strict; both themes; money/points integers; RPCs are the only ledger path; every RPC guard has a pgTAP or integration assertion; Conventional Commits scope `rewards`. External creds: Upstash (already in `.env.local`) + a new `REDEMPTION_TOKEN_SECRET` (generated locally, documented for production).

## 7. Out of scope

Claim-expiry sweep worker (queue infra; deferred with the jobs slice, but the RPC sets `expires_at` correctly so the sweep is additive); manual-code fallback [V1]; push notifications on claim/redeem; loyalty-card auto-claim on completion (needs the award pipeline); rate limiting (doc 13) recorded as debt.

## 8. Success criteria

1. Migration applied: both RPCs live, client INSERT on `points_transactions` revoked; pgTAP proves out-of-stock, insufficient-points, per-customer-limit, blacklist, double-redeem, and that a claim writes exactly one ledger row with correct `balance_after`.
2. A consumer with a seeded balance can claim a reward live: balance debits, ledger row appears, inventory decrements, claim row created.
3. The QR screen mints a token; a second consume of the same token fails (single-use proven live against Upstash).
4. Staff validation flips the claim to `redeemed` and creates a `redemptions` row; a second scan returns `CLAIM_ALREADY_REDEEMED`.
5. Wallet + rewards screens show real data; gates green; both themes.
