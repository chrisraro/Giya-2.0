-- ============================================================================
-- 0021_consumer_selfupdate_column_fence.sql
-- Column-level write fence on the two self-update surfaces of the identity
-- domain: public.consumers and public.profiles.
--
-- WHY NOW: the receipts slice made consumers.scan_blocked_until load-bearing.
-- 0017's pipeline writes it (the cooldown step in
-- src/features/receipts/server/process.ts) and
-- src/features/receipts/server/submit.ts refuses submissions while it is in
-- the future. But 0002's consumers_owner_update policy is row-scoped only, it
-- does not column-restrict, and `authenticated` still held the Supabase
-- default table-level UPDATE grant. Verified live before writing this file:
-- information_schema.column_privileges listed UPDATE for `authenticated` on
-- scan_blocked_until, so a blocked consumer could PATCH the column to null
-- through PostgREST and resume scanning immediately, defeating doc 37's
-- consequences ladder step 2 (automatic 24h scan block after 3 fraud-family
-- rejections) entirely. profiles.is_suspended, which doc 37 ladder step 4
-- uses, was exposed the same way and is fenced here too.
--
-- Source docs:
--   * docs/30-modules/37-fraud-detection.md (consequences ladder: step 2
--     scan_blocked_until cooldown, step 4 is_suspended account suspension)
--   * docs/20-data/21-schema-identity.md + docs/20-data/26-schema-amendments.md
--     (A21.1 birth_date_updated_at, A21.3 consumers.scan_blocked_until)
--   * docs/10-architecture/12-multi-tenancy-rls.md (P2 self pattern)
--
-- Pattern: identical to the business_customers balance-cache fence at the
-- bottom of 0013. Postgres note repeated from there because it is the whole
-- reason this file is shaped the way it is: revoking a COLUMN privilege is a
-- no-op while a table-level UPDATE grant remains, so the table-level privilege
-- must be revoked first and exactly the self-editable columns granted back.
--
-- RLS is unchanged. The P2 policies (consumers_owner_update,
-- profiles_owner_update from 0002) still decide WHICH row a caller may update;
-- this file decides WHICH COLUMNS. Both fences have to hold for a write to
-- land. SECURITY DEFINER functions are unaffected: private.handle_new_user
-- (0003), public.register_business (0003), public.claim_reward (0013) and
-- public.award_receipt_points (0018) execute as their definer, and the
-- service-role pipeline bypasses grants entirely, so every server-side writer
-- of the fenced columns keeps working.
-- ============================================================================

-- ---------------------------------------------------------------- consumers
-- Allowlist derivation (from 0002's DDL plus every writer in the app):
--   * city_id, push_enabled      - written by completeConsumerOnboarding in
--                                  src/features/identity/actions.ts, the one
--                                  and only client write to this table today.
--   * marketing_opt_in,
--     email_enabled,
--     gps_fraud_opt_in           - consent and notification preferences. Doc 21
--                                  models these as consumer-owned toggles and
--                                  the profile settings screen edits them; they
--                                  are meaningless as anything other than
--                                  self-service, so they stay writable.
--   * updated_by                 - actor stamp, per the 0013 precedent. RLS
--                                  already pins the row to the caller.
--
-- Deliberately NOT granted, with the reason each one is dangerous:
--   * scan_blocked_until     - THE defect. Doc 37 ladder step 2's durable
--                              cooldown; self-clearable means no cooldown.
--   * last_scan_at           - velocity input to the same fraud pipeline;
--                              rewriting it forges the scan-rate history.
--   * lifetime_points_earned - derived, maintained by the points service
--                              (0002 says so on the column); client-writable
--                              means a self-declared lifetime total.
--   * referral_code          - unique identity token, defaulted by
--                              private.gen_referral_code(). Self-writable lets
--                              a consumer squat or guess another's code.
--   * referred_by            - referral attribution; self-writable is a direct
--                              referral-reward fraud lever.
--   * id                     - the PK and the tenancy key of the P2 policy.
--   * created_at, created_by, updated_at - audit columns; updated_at is
--                              maintained by the touch_consumers trigger,
--                              which is a trigger write and therefore not
--                              subject to these column grants.
revoke update on public.consumers from anon, authenticated;
grant update (
  city_id,
  marketing_opt_in,
  push_enabled,
  email_enabled,
  gps_fraud_opt_in,
  updated_by
) on public.consumers to authenticated;

-- ---------------------------------------------------------------- profiles
-- Allowlist derivation (from 0002's DDL plus every writer in the app):
--   * onboarded_at               - stamped by completeConsumerOnboarding in
--                                  src/features/identity/actions.ts, the one
--                                  and only client write to this table today.
--                                  Onboarding breaks without this grant.
--   * display_name, avatar_url,
--     phone, locale              - the profile edit surface. All four are
--                                  self-descriptive fields with database-level
--                                  check constraints (display_name length,
--                                  phone PH E.164, locale enum) that survive
--                                  the grant.
--   * updated_by                 - actor stamp, per the 0013 precedent.
--
-- Deliberately NOT granted:
--   * is_suspended, suspended_reason - doc 37 ladder step 4. A suspended user
--                              clearing their own suspension is the same class
--                              of defect as the cooldown above, and 0002's own
--                              comment flagged it. Suspension is an admin
--                              action and stays a service-role write.
--   * birth_date, birth_date_updated_at - fenced as a PAIR, deliberately.
--                              A21.1 makes birth_date editable once per rolling
--                              year and birth_date_updated_at is the column
--                              that enforces it. Granting birth_date without
--                              its enforcement column would let a consumer
--                              rewrite their birthday freely (birthday
--                              campaigns are a points surface), and granting
--                              the enforcement column would let them reset the
--                              clock. Nothing in the app writes either column
--                              today, so nothing breaks; the birthday edit
--                              ships through a server-side path that can hold
--                              the once-per-year rule.
--   * deleted_at             - soft delete. Account closure is a deliberate
--                              flow with data-retention consequences, not a
--                              PATCH.
--   * id                     - the PK and the tenancy key of the P2 policy.
--   * created_at, created_by, updated_at - audit columns; updated_at is
--                              maintained by the touch_profiles trigger.
revoke update on public.profiles from anon, authenticated;
grant update (
  display_name,
  avatar_url,
  phone,
  locale,
  onboarded_at,
  updated_by
) on public.profiles to authenticated;
