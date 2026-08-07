-- ============================================================================
-- 0076_purge_business_rpc.sql
-- RPC functions to safely purge a single business or all businesses from admin UI,
-- temporarily bypassing immutability triggers during explicit admin purges.
-- ============================================================================

create or replace function public.purge_business(
  p_business_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'PURGE_REASON_REQUIRED: A reason is required to purge a business.';
  end if;

  -- Disable immutability triggers for this session
  alter table public.points_transactions disable trigger points_transactions_no_truncate;
  alter table public.points_transactions disable trigger points_transactions_append_only;
  alter table public.receipts disable trigger receipts_no_truncate;
  alter table public.receipts disable trigger receipts_no_delete;
  alter table public.ocr_results disable trigger ocr_results_no_truncate;
  alter table public.ocr_results disable trigger ocr_results_immutable;
  alter table public.fraud_signals disable trigger fraud_signals_no_truncate;
  alter table public.fraud_signals disable trigger fraud_signals_immutable;

  -- Delete all child data for this business
  delete from public.points_transactions where business_id = p_business_id;
  delete from public.reward_redemptions where business_id = p_business_id;
  delete from public.reward_claims where business_id = p_business_id;
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
  delete from public.products where business_id = p_business_id;
  delete from public.business_verifications where business_id = p_business_id;
  delete from public.business_food_types where business_id = p_business_id;
  delete from public.business_integrations where business_id = p_business_id;
  delete from public.business_merchant_aliases where business_id = p_business_id;
  delete from public.business_staff where business_id = p_business_id;
  delete from public.businesses where id = p_business_id;

  -- Re-enable immutability triggers
  alter table public.points_transactions enable trigger points_transactions_no_truncate;
  alter table public.points_transactions enable trigger points_transactions_append_only;
  alter table public.receipts enable trigger receipts_no_truncate;
  alter table public.receipts enable trigger receipts_no_delete;
  alter table public.ocr_results enable trigger ocr_results_no_truncate;
  alter table public.ocr_results enable trigger ocr_results_immutable;
  alter table public.fraud_signals enable trigger fraud_signals_no_truncate;
  alter table public.fraud_signals enable trigger fraud_signals_immutable;

  -- Audit log entry
  insert into public.audit_logs (actor_id, actor_kind, actor_role, business_id, action, entity_type, entity_id, reason)
  values (p_actor_id, 'admin', 'platform_admin', p_business_id, 'business.purged', 'businesses', p_business_id, p_reason);
end;
$$;

create or replace function public.purge_all_businesses(
  p_actor_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'PURGE_REASON_REQUIRED: A reason is required to purge all businesses.';
  end if;

  alter table public.points_transactions disable trigger points_transactions_no_truncate;
  alter table public.points_transactions disable trigger points_transactions_append_only;
  alter table public.receipts disable trigger receipts_no_truncate;
  alter table public.receipts disable trigger receipts_no_delete;
  alter table public.ocr_results disable trigger ocr_results_no_truncate;
  alter table public.ocr_results disable trigger ocr_results_immutable;
  alter table public.fraud_signals disable trigger fraud_signals_no_truncate;
  alter table public.fraud_signals disable trigger fraud_signals_immutable;

  truncate table public.businesses cascade;

  alter table public.points_transactions enable trigger points_transactions_no_truncate;
  alter table public.points_transactions enable trigger points_transactions_append_only;
  alter table public.receipts enable trigger receipts_no_truncate;
  alter table public.receipts enable trigger receipts_no_delete;
  alter table public.ocr_results enable trigger ocr_results_no_truncate;
  alter table public.ocr_results enable trigger ocr_results_immutable;
  alter table public.fraud_signals enable trigger fraud_signals_no_truncate;
  alter table public.fraud_signals enable trigger fraud_signals_immutable;

  insert into public.audit_logs (actor_id, actor_kind, actor_role, action, entity_type, reason)
  values (p_actor_id, 'admin', 'platform_admin', 'business.purge_all', 'businesses', p_reason);
end;
$$;

grant execute on function public.purge_business(uuid, uuid, text) to service_role;
grant execute on function public.purge_all_businesses(uuid, text) to service_role;
