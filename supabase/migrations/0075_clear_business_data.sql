-- ============================================================================
-- 0075_clear_business_data.sql
-- Reset script to clear all business tenants, staff memberships, products,
-- campaigns, rewards, receipts, fraud signals, points ledgers, and verifications.
--
-- PRESERVED:
--   * System reference tables: public.ref_cities, public.ref_business_types, public.ref_food_types
--   * Platform admin accounts: public.platform_admins (including teamocsph@gmail.com)
--   * User authentication accounts & consumer profiles
-- ============================================================================

begin;

-- Disable triggers temporarily during bulk cleanup
set local session_replication_role = 'replica';

-- 1. Receipt engine & transaction tables
truncate table public.receipt_visits restart identity cascade;
truncate table public.receipt_line_items restart identity cascade;
truncate table public.receipt_fraud_signals restart identity cascade;
truncate table public.receipt_audit_logs restart identity cascade;
truncate table public.receipts restart identity cascade;

-- 2. Points & loyalty engine tables
truncate table public.points_ledger restart identity cascade;
truncate table public.points_rules restart identity cascade;

-- 3. Rewards & campaign tables
truncate table public.reward_claims restart identity cascade;
truncate table public.reward_redemptions restart identity cascade;
truncate table public.rewards restart identity cascade;
truncate table public.campaigns restart identity cascade;

-- 4. Products & Catalog
truncate table public.products restart identity cascade;

-- 5. Business verifications & join tables
truncate table public.business_verifications restart identity cascade;
truncate table public.business_food_types restart identity cascade;
truncate table public.business_integrations restart identity cascade;

-- 6. Business staff & Business tenants
truncate table public.business_staff restart identity cascade;
truncate table public.businesses restart identity cascade;

-- Re-enable normal trigger execution
set local session_replication_role = 'origin';

commit;
