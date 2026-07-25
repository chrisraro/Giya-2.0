-- ============================================================================
-- 0011_identity_table_staff_policies.sql
-- Converge the identity-domain staff policies onto the table-truth
-- private.is_active_staff (added in 0010) so the WHOLE app works with the
-- custom access token hook disabled, and staff revocation (status -> disabled)
-- takes effect on the next statement rather than the next token refresh.
--
-- Before this, catalog was table-truth (0010) but businesses updates,
-- verification/document reads, the staff roster, and business_customers stayed
-- claim-based (0002), so an owner without the biz claim could manage their menu
-- but not their business profile, and a disabled staff member kept identity
-- write access until their JWT expired. is_active_staff is SECURITY DEFINER, so
-- it bypasses RLS on business_staff (no recursion) and needs no claim.
--
-- The claim-based helpers (private.is_staff_of / jwt_biz_role) remain defined
-- and valid for when the hook is enabled; they are simply no longer the gate
-- for these policies.
-- ============================================================================

-- ---------------------------------------------------------------- businesses
-- 0006 already added a table-truth staff read (businesses_staff_table_select);
-- replace the claim-based read + the update policy to match.
drop policy businesses_staff_select on public.businesses;
drop policy businesses_staff_update on public.businesses;

create policy businesses_staff_select on public.businesses
  for select to authenticated
  using (private.is_active_staff(id, array['owner','manager','marketing','staff']));
create policy businesses_staff_update on public.businesses
  for update to authenticated
  using (private.is_active_staff(id, array['owner','manager']))
  with check (private.is_active_staff(id, array['owner','manager']));

-- ---------------------------------------------------------------- business_staff
-- Roster read (self read stays via business_staff_self_select from 0004).
drop policy business_staff_tenant_select on public.business_staff;
create policy business_staff_tenant_select on public.business_staff
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));

-- ---------------------------------------------------------------- business_verifications
drop policy business_verifications_staff_select on public.business_verifications;
create policy business_verifications_staff_select on public.business_verifications
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));

-- ---------------------------------------------------------------- business_documents
drop policy business_documents_staff_select on public.business_documents;
create policy business_documents_staff_select on public.business_documents
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));

-- ---------------------------------------------------------------- business_customers
drop policy business_customers_staff_select on public.business_customers;
drop policy business_customers_staff_update on public.business_customers;

create policy business_customers_staff_select on public.business_customers
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']));
create policy business_customers_staff_update on public.business_customers
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));

-- ---------------------------------------------------------------- business_food_types
-- Cuisine tag writes (public read policy stays claim-free).
drop policy bft_staff_insert on public.business_food_types;
drop policy bft_staff_delete on public.business_food_types;

create policy bft_staff_insert on public.business_food_types
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy bft_staff_delete on public.business_food_types
  for delete to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
