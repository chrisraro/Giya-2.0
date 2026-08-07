-- ============================================================================
-- 0077_force_delete_business.sql
-- Helper SQL script and function to force delete any business (or all businesses)
-- despite points_transactions append-only triggers and circular FK dependencies.
-- ============================================================================

-- 1. Create force_delete_business RPC function
create or replace function public.force_delete_business(p_business_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Temporarily disable immutability & evidence triggers
  alter table public.points_transactions disable trigger points_transactions_no_truncate;
  alter table public.points_transactions disable trigger points_transactions_append_only;
  alter table public.receipts disable trigger receipts_no_truncate;
  alter table public.receipts disable trigger receipts_no_delete;
  alter table public.ocr_results disable trigger ocr_results_no_truncate;
  alter table public.ocr_results disable trigger ocr_results_immutable;
  alter table public.fraud_signals disable trigger fraud_signals_no_truncate;
  alter table public.fraud_signals disable trigger fraud_signals_immutable;

  -- Break circular FK dependencies between reward_claims and points_transactions
  update public.reward_claims set points_txn_id = null where business_id = p_business_id;
  update public.points_transactions set claim_id = null where business_id = p_business_id;

  -- Clear all child data belonging to this business
  delete from public.redemptions where business_id = p_business_id;
  delete from public.reward_claims where business_id = p_business_id;
  delete from public.points_transactions where business_id = p_business_id;
  delete from public.rewards where business_id = p_business_id;
  delete from public.loyalty_cards where business_id = p_business_id;
  delete from public.loyalty_programs where business_id = p_business_id;
  delete from public.campaigns where business_id = p_business_id;
  delete from public.promotions where business_id = p_business_id;
  delete from public.points_rules where business_id = p_business_id;
  delete from public.receipt_line_items where business_id = p_business_id;
  delete from public.ocr_results where receipt_id in (select id from public.receipts where business_id = p_business_id);
  delete from public.fraud_signals where receipt_id in (select id from public.receipts where business_id = p_business_id);
  delete from public.receipts where business_id = p_business_id;
  delete from public.receipt_templates where business_id = p_business_id;
  delete from public.product_variants where product_id in (select id from public.products where business_id = p_business_id);
  delete from public.product_addons where product_id in (select id from public.products where business_id = p_business_id);
  delete from public.products where business_id = p_business_id;
  delete from public.menu_categories where business_id = p_business_id;
  delete from public.business_documents where business_id = p_business_id;
  delete from public.business_customers where business_id = p_business_id;
  delete from public.business_verifications where business_id = p_business_id;
  delete from public.business_food_types where business_id = p_business_id;
  delete from public.integration_connections where business_id = p_business_id;
  delete from public.business_merchant_aliases where business_id = p_business_id;
  delete from public.business_staff where business_id = p_business_id;

  -- Delete the target business row
  delete from public.businesses where id = p_business_id;

  -- Re-enable immutability & evidence triggers
  alter table public.points_transactions enable trigger points_transactions_no_truncate;
  alter table public.points_transactions enable trigger points_transactions_append_only;
  alter table public.receipts enable trigger receipts_no_truncate;
  alter table public.receipts enable trigger receipts_no_delete;
  alter table public.ocr_results enable trigger ocr_results_no_truncate;
  alter table public.ocr_results enable trigger ocr_results_immutable;
  alter table public.fraud_signals enable trigger fraud_signals_no_truncate;
  alter table public.fraud_signals enable trigger fraud_signals_immutable;
end;
$$;

grant execute on function public.force_delete_business(uuid) to service_role, postgres;

-- 2. Standalone script to force delete ALL businesses and transactions when executed in SQL Editor
alter table public.points_transactions disable trigger points_transactions_no_truncate;
alter table public.points_transactions disable trigger points_transactions_append_only;
alter table public.receipts disable trigger receipts_no_truncate;
alter table public.receipts disable trigger receipts_no_delete;
alter table public.ocr_results disable trigger ocr_results_no_truncate;
alter table public.ocr_results disable trigger ocr_results_immutable;
alter table public.fraud_signals disable trigger fraud_signals_no_truncate;
alter table public.fraud_signals disable trigger fraud_signals_immutable;

update public.reward_claims set points_txn_id = null;
update public.points_transactions set claim_id = null;

delete from public.redemptions;
delete from public.reward_claims;
delete from public.points_transactions;
delete from public.rewards;
delete from public.loyalty_cards;
delete from public.loyalty_programs;
delete from public.campaigns;
delete from public.promotions;
delete from public.points_rules;
delete from public.receipt_line_items;
delete from public.ocr_results;
delete from public.fraud_signals;
delete from public.receipts;
delete from public.receipt_templates;
delete from public.product_variants;
delete from public.product_addons;
delete from public.products;
delete from public.menu_categories;
delete from public.business_documents;
delete from public.business_customers;
delete from public.business_verifications;
delete from public.business_food_types;
delete from public.integration_connections;
delete from public.business_merchant_aliases;
delete from public.business_staff;
delete from public.businesses;

alter table public.points_transactions enable trigger points_transactions_no_truncate;
alter table public.points_transactions enable trigger points_transactions_append_only;
alter table public.receipts enable trigger receipts_no_truncate;
alter table public.receipts enable trigger receipts_no_delete;
alter table public.ocr_results enable trigger ocr_results_no_truncate;
alter table public.ocr_results enable trigger ocr_results_immutable;
alter table public.fraud_signals enable trigger fraud_signals_no_truncate;
alter table public.fraud_signals enable trigger fraud_signals_immutable;
