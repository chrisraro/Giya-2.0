-- ============================================================================
-- 0081_purge_rpcs_super_admin_only.sql
-- Defence in depth for the business purge, after 0080 closed the public grant.
--
-- 1. purge_business / purge_all_businesses now refuse unless p_actor_id is an
--    ACTIVE super_admin in platform_admins (PURGE_FORBIDDEN), mirroring how
--    clawback_receipt_points (0031) re-checks its actor by table truth. Doc 01:
--    'support' is read-only everywhere, and a purge erases ledger and audit
--    history, so even 'admin' may not. The audit row records the real role.
--    Bodies are otherwise 0076 verbatim.
-- 2. force_delete_business is DROPPED. It deleted the tenant's audit_logs and
--    wrote no audit row, and its only caller - the silent fallback in
--    src/features/admin/business-decisions.ts - was removed in the same change.
-- 3. Grants restated: create or replace re-applies Supabase's default PUBLIC
--    execute grant, which is exactly how 0076 shipped exposed.
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
as $
declare
  v_role text;
begin
  -- 0081: the caller must be an ACTIVE super_admin, by table truth. p_actor_id
  -- is supplied by the service-role caller (business-decisions.ts passes the
  -- session admin's own id), and this check is what makes a future grant
  -- mistake survivable: 0080 showed how a missing revoke reopens these.
  select pa.role into v_role
    from public.platform_admins pa
   where pa.user_id = p_actor_id and pa.is_active = true;
  if v_role is distinct from 'super_admin' then
    raise exception using errcode = 'P0001', message = 'PURGE_FORBIDDEN';
  end if;

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
  alter table public.audit_logs disable trigger audit_logs_no_truncate;
  alter table public.audit_logs disable trigger audit_logs_append_only;
  alter table public.notifications disable trigger notifications_no_truncate;
  alter table public.notifications disable trigger notifications_read_at_only;

  -- Break circular FK dependencies between reward_claims and points_transactions
  update public.reward_claims set points_txn_id = null where business_id = p_business_id;
  update public.points_transactions set claim_id = null where business_id = p_business_id;

  -- Delete all child data for this business
  delete from public.notifications where business_id = p_business_id;
  delete from public.ai_usage_events where business_id = p_business_id;
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
  alter table public.audit_logs enable trigger audit_logs_no_truncate;
  alter table public.audit_logs enable trigger audit_logs_append_only;
  alter table public.notifications enable trigger notifications_no_truncate;
  alter table public.notifications enable trigger notifications_read_at_only;

  -- Audit log entry
  insert into public.audit_logs (actor_id, actor_kind, actor_role, business_id, action, entity_type, entity_id, reason)
  values (p_actor_id, 'admin', v_role, p_business_id, 'business.purged', 'businesses', p_business_id, p_reason);
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
as $
declare
  v_role text;
begin
  -- 0081: the caller must be an ACTIVE super_admin, by table truth. p_actor_id
  -- is supplied by the service-role caller (business-decisions.ts passes the
  -- session admin's own id), and this check is what makes a future grant
  -- mistake survivable: 0080 showed how a missing revoke reopens these.
  select pa.role into v_role
    from public.platform_admins pa
   where pa.user_id = p_actor_id and pa.is_active = true;
  if v_role is distinct from 'super_admin' then
    raise exception using errcode = 'P0001', message = 'PURGE_FORBIDDEN';
  end if;

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
  alter table public.audit_logs disable trigger audit_logs_no_truncate;
  alter table public.audit_logs disable trigger audit_logs_append_only;
  alter table public.notifications disable trigger notifications_no_truncate;
  alter table public.notifications disable trigger notifications_read_at_only;

  update public.reward_claims set points_txn_id = null;
  update public.points_transactions set claim_id = null;

  delete from public.notifications;
  delete from public.ai_usage_events;
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
  alter table public.audit_logs enable trigger audit_logs_no_truncate;
  alter table public.audit_logs enable trigger audit_logs_append_only;
  alter table public.notifications enable trigger notifications_no_truncate;
  alter table public.notifications enable trigger notifications_read_at_only;

  insert into public.audit_logs (actor_id, actor_kind, actor_role, action, entity_type, reason)
  values (p_actor_id, 'admin', v_role, 'business.purge_all', 'businesses', p_reason);
end;
$$;

drop function if exists public.force_delete_business(uuid);

revoke execute on function public.purge_business(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.purge_business(uuid, uuid, text) to service_role;
revoke execute on function public.purge_all_businesses(uuid, text) from public, anon, authenticated;
grant  execute on function public.purge_all_businesses(uuid, text) to service_role;
