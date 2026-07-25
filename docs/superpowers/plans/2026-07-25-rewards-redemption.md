# Giya Rewards + Redemption Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement `docs/superpowers/specs/2026-07-25-rewards-redemption-design.md`: atomic claim/validate RPCs (the first ledger writes), Redis-backed single-use redemption tokens, consumer reward + QR screens, staff scan screen, real wallet data.

**Architecture:** All ledger mutation happens inside two SECURITY DEFINER Postgres RPCs (atomicity + the service-role fence). The app calls them via the RLS-scoped server client. Redemption tokens are signed JWTs whose `jti` is single-use in Upstash Redis (GETDEL). Consumer/staff UIs sit on top.

## Global Constraints

- Canon: `docs/30-modules/35-points-engine.md` section 6 (claim + redeem-at-counter + expiry semantics, worked example), `docs/20-data/23-schema-campaigns.md` (integrity table), `docs/30-modules/33-consumer-pwa.md` (QR screen UX), `docs/10-architecture/15-security.md` (token contract), doc 12 (RLS), doc 13 (API envelope + error codes).
- Ledger invariants (non-negotiable): one ledger row per claim with `points_cost > 0`; `balance_after` correct and never negative; inventory never oversold (conditional update); one redemption per claim (unique `claim_id`); no client-side INSERT on `points_transactions` (revoke in this migration).
- RPCs: `security definer`, `set search_path = ''`, fully-qualified objects, `revoke execute from public, anon`, `grant execute to authenticated`. Guards raise SQLSTATE-tagged exceptions mapped to doc-13 error codes by the app.
- Redis env is REQUIRED (fail fast at boot). No degraded no-Redis mode: a missing lock would permit QR replay.
- App: tokens only, zero em-dashes, TS strict no any, both themes, integer points/centavos, server actions confirm session, `{ok}|{ok:false,message,code?}`. Conventional Commits scope `rewards`. Branch `feat/rewards-redemption`. Existing suite (398) green each task.

---

### Task 1: Author migration 0013 (claim + validate RPCs, ledger write fence)

**Files:** Create `supabase/migrations/0013_reward_claim_rpcs.sql`, `supabase/tests/rpc_claim_smoke.sql`.

**Binding:** implement doc 35 section 6 exactly.
- `public.claim_reward(p_reward_id uuid) returns uuid` per spec section 2 steps 1-6. Use `for update` on `business_customers` (insert-if-absent with balance 0 first). Inventory via conditional update returning; `if not found then raise exception using errcode='P0001', message='REWARD_OUT_OF_STOCK'`. Distinct messages: `REWARD_OUT_OF_STOCK`, `POINTS_INSUFFICIENT`, `REWARD_LIMIT_REACHED`, `CUSTOMER_BLACKLISTED`, `REWARD_UNAVAILABLE` (inactive reward/campaign not live). Skip the ledger insert when `points_cost = 0`. Set `points_txn_id` on the claim after inserting the ledger row.
- `public.validate_redemption(p_claim_id uuid, p_token_jti text, p_method text default 'qr') returns jsonb` per spec: staff authz via `private.is_active_staff(business_id, array['owner','manager','staff'])` else raise `FORBIDDEN`; guards claim status/expiry/blacklist; insert `redemptions` (catch `unique_violation` -> raise `CLAIM_ALREADY_REDEEMED`); update claim to `redeemed`. Return jsonb `{claim_id, reward_name, consumer_name, redeemed_at}` for the staff UI.
- `revoke insert on public.points_transactions from anon, authenticated;` (service-role/definer only) - closes campaigns debt item 4.
- pgTAP `rpc_claim_smoke.sql` (>= 12 assertions, begin/rollback): seed two tenants + a consumer with a balance (insert a ledger row + business_customers as the privileged role); claim succeeds and writes EXACTLY one ledger row with correct `balance_after` and decrements `remaining`; claiming with insufficient points raises POINTS_INSUFFICIENT and leaves balance/inventory unchanged; out-of-stock raises; per-customer-limit raises on the second claim; blacklisted consumer raises; a `points_cost = 0` reward creates NO ledger row; validate_redemption by staff flips status + creates the redemption row; a second validate raises CLAIM_ALREADY_REDEEMED; validate by a non-staff user raises FORBIDDEN; expired claim raises CLAIM_EXPIRED; client (authenticated role) direct INSERT into points_transactions is denied.

**Steps:**
- [ ] Read doc 35 section 6 + doc 23 integrity table; read 0012 for style. Author both files.
- [ ] Self-check: every guard present; ledger row count exactly right; `search_path=''`; grants/revokes; em-dash grep 0.
- [ ] `npm test` still green. Commit: `feat(rewards): atomic claim and validate RPCs, ledger write fence (authored)`

---

### Task 2 (controller): apply 0013 + pgTAP + types
- [ ] Apply via MCP; run the pgTAP suite; verify the ledger-insert revoke live; advisors; regenerate types; build. Commit: `db(rewards): apply claim/validate RPCs, regenerated types`

---

### Task 3: Redis client + redemption token module

**Files:** Create `src/lib/redis.ts` (+ test), `src/features/rewards/server/token.ts` (+ test); modify `src/lib/env.ts` (add required `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDEMPTION_TOKEN_SECRET` to a NEW server-only schema section - keep the existing client schema untouched so client bundles never see them), `.env.local` (add `REDEMPTION_TOKEN_SECRET=` with a generated value).

**Binding:**
- `env.ts`: split into `clientEnv` (existing NEXT_PUBLIC_*) and `serverEnv` (the three new keys), where `serverEnv` is parsed lazily on first access (so client bundles and `next build` of client components do not throw). Export a `getServerEnv()` that throws a readable error listing missing keys. Keep existing `env` export working for client keys (update importers if needed; keep tests green).
- `redis.ts`: minimal Upstash REST wrapper (fetch-based, no SDK dependency needed: POST to `${url}/pipeline` or the command endpoints with the bearer token). Implement `setNx(key, value, ttlSeconds): Promise<boolean>` and `getDel(key): Promise<string|null>`. Namespace helper `redisKey(...parts)` producing `{NODE_ENV}:...`. Unit-test with a mocked fetch (assert the exact command payloads and that getDel is a single atomic call, not GET+DEL).
- `token.ts`: `mintRedemptionToken(claimId)` and `consumeRedemptionToken(token)` per spec section 3, using a small HS256 sign/verify (use `jose` if adding a dep is acceptable - prefer `jose`, it is tiny and standard; otherwise node:crypto HMAC over a base64url payload). TTL 300s. Tests: mint returns a token whose payload carries jti/claimId/exp; consume succeeds once (mocked redis GETDEL returns the claim) and fails the second time (GETDEL null -> REDEMPTION_TOKEN_INVALID); tampered signature rejected; expired token rejected.

**Steps:**
- [ ] TDD redis + token. Gates. Commit: `feat(rewards): upstash redis client and single-use redemption tokens`

---

### Task 4: claim/validate actions + API routes + wallet/rewards data layer

**Files:** Create `src/features/rewards/{schemas.ts,types.ts,server/repo.ts,server/service.ts,actions.ts}`, `src/app/api/v1/reward-claims/[claimId]/token/route.ts`, `src/app/api/v1/redemptions/validate/route.ts`; tests.

**Binding:**
- repo (server client, RLS-scoped): `listClaimableRewards()` (active reward-campaign rewards visible to the consumer), `listMyClaims()`, `getClaim(claimId)`, `getMyBalances()` (business_customers rows for the consumer), `listMyLedger(businessId?)` (points_transactions, consumer-scoped by RLS).
- service/actions: `claimReward(rewardId)` -> calls `supabase.rpc('claim_reward', ...)`, maps raised messages to `{ok:false, code, message}` with consumer-friendly copy per doc 33 (never expose internals); `revalidatePath('/rewards')`.
- Route handlers per doc 13 envelope `{data}|{error:{code,message,request_id}}`: token mint route (session required; ownership enforced inside `mintRedemptionToken`), validate route (session required; body `{token}`; consumes token then calls `validate_redemption` RPC; maps errors).
- Tests: action error mapping (each RPC error string -> the right code/message), route handler happy path + invalid token (mocked).

**Steps:**
- [ ] TDD. Gates. Commit: `feat(rewards): claim/validate services, actions, and API routes`

---

### Task 5: consumer rewards + QR screens + real wallet

**Files:** Modify `src/app/(consumer)/rewards/page.tsx`, `src/app/(consumer)/wallet/page.tsx`; create `src/app/(consumer)/rewards/claims/[claimId]/page.tsx` + `src/features/rewards/components/{reward-card.tsx,claim-list.tsx,redemption-qr.tsx}`; modify `/b/[slug]` public page to add a Rewards section. Add `qrcode` dep (or `qrcode.react`).

**Binding:** per spec section 4. Rewards page: real claimable rewards + Claim buttons (disabled with reason), real claimed list with expiry, "Show QR" link. QR screen (client): mints on mount via the token route, renders QR, 5:00 countdown, Refresh after expiry, success state via Supabase Realtime subscription on the claim row (sanctioned D5) or a poll fallback; offline explanation. Wallet: real balances + ledger history (mono figures, earn/redeem styling, mango only on positive earn pills). `/b/[slug]`: Rewards section listing active rewards (name, points Badge). Empty states everywhere. Consumer expressive profile, both themes, 48px targets.

**Steps:**
- [ ] Failing component tests (reward-card disabled-reason, claim-list expiry, qr countdown). Build. Gates. Commit: `feat(rewards): consumer rewards, redemption QR, and live wallet`

---

### Task 6: staff redeem screen

**Files:** Create `src/app/(business)/business/(portal)/redeem/page.tsx` + `src/features/rewards/components/redeem-scanner.tsx`; add the QR-reader dep (`@zxing/browser` recommended; document choice); add a "Redeem" sidebar nav item if not present.

**Binding:** camera scanner (client, permission prompt + fallback message), on decode POST `/api/v1/redemptions/validate`, success card (reward name, consumer name, time) or mapped error (expired / already redeemed / invalid / forbidden), "Scan next" reset. Teal-led, both themes, works on mobile viewport (staff use phones).

**Steps:**
- [ ] Build + a small test for the result-state rendering. Gates. Commit: `feat(rewards): staff redemption scanner`

---

### Task 7 (controller): live E2E + final review + merge
- [ ] Seed the E2E consumer a balance via a service-role ledger insert + business_customers row (MCP); create an active reward campaign + reward (MCP or UI). Claim live through the UI (or action) -> verify ledger row, balance, inventory via MCP. Mint a token, consume it twice (second must fail) against real Upstash. Validate as staff -> claim redeemed + redemptions row; second validate -> CLAIM_ALREADY_REDEEMED. Screenshot QR + staff screens both themes.
- [ ] Sweep: gates, em-dash scan. Final whole-branch review (most capable model), fix wave, merge. Update ledger + debt (expiry sweep worker, rate limiting, manual code).
