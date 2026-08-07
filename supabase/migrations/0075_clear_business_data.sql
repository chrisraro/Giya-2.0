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

-- 1. Disable evidence and ledger immutability triggers for the reset
alter table public.points_transactions disable trigger points_transactions_no_truncate;
alter table public.points_transactions disable trigger points_transactions_append_only;

alter table public.receipts disable trigger receipts_no_truncate;
alter table public.receipts disable trigger receipts_no_delete;

alter table public.ocr_results disable trigger ocr_results_no_truncate;
alter table public.ocr_results disable trigger ocr_results_immutable;

alter table public.fraud_signals disable trigger fraud_signals_no_truncate;
alter table public.fraud_signals disable trigger fraud_signals_immutable;

-- 2. Atomic CASCADE truncate to clear all business tenants and dependent transaction records
truncate table public.businesses cascade;

-- 3. Re-enable evidence and ledger immutability triggers
alter table public.points_transactions enable trigger points_transactions_no_truncate;
alter table public.points_transactions enable trigger points_transactions_append_only;

alter table public.receipts enable trigger receipts_no_truncate;
alter table public.receipts enable trigger receipts_no_delete;

alter table public.ocr_results enable trigger ocr_results_no_truncate;
alter table public.ocr_results enable trigger ocr_results_immutable;

alter table public.fraud_signals enable trigger fraud_signals_no_truncate;
alter table public.fraud_signals enable trigger fraud_signals_immutable;
