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

-- Single atomic TRUNCATE with CASCADE to clear all business data and transactions.
-- Truncating public.businesses with CASCADE automatically wipes all referencing child tables
-- (business_staff, business_verifications, products, campaigns, rewards, reward_claims,
-- reward_redemptions, points_rules, points_ledger, receipts, receipt_line_items, fraud_signals,
-- business_food_types, business_merchant_aliases, integration_connections).

truncate table public.businesses cascade;
