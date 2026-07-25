-- ============================================================================
-- 0010_catalog_table_staff_policies.sql
-- Make catalog staff policies table-truth instead of claim-dependent, matching
-- the auth-slice correction (0004/0006): claims are a fast-path hint, the
-- business_staff table is the source of truth. Without this, a signed-in owner
-- whose JWT lacks the biz claim (the custom access token hook is optional and
-- may be disabled) cannot read hidden products or write any catalog row.
--
-- private.is_active_staff is SECURITY DEFINER so its lookup bypasses RLS on
-- business_staff, which both avoids the biz_overflow recursion hazard that
-- blocks a claim fallback inside jwt_biz_role AND keeps these policies working
-- with no token hook enabled. It is claim-free and safe for any tenant table.
-- ============================================================================

create or replace function private.is_active_staff(bid uuid, roles text[])
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.business_staff bs
    where bs.business_id = bid
      and bs.user_id = (select auth.uid())
      and bs.status = 'active'
      and bs.role = any(roles)
  )
$$;

revoke execute on function private.is_active_staff(uuid, text[]) from public, anon;
grant execute on function private.is_active_staff(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------- menu_categories
drop policy menu_categories_staff_select on public.menu_categories;
drop policy menu_categories_staff_insert on public.menu_categories;
drop policy menu_categories_staff_update on public.menu_categories;

create policy menu_categories_staff_select on public.menu_categories
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
create policy menu_categories_staff_insert on public.menu_categories
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy menu_categories_staff_update on public.menu_categories
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));

-- ---------------------------------------------------------------- products
drop policy products_staff_select on public.products;
drop policy products_staff_insert on public.products;
drop policy products_staff_update on public.products;

create policy products_staff_select on public.products
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
create policy products_staff_insert on public.products
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy products_staff_update on public.products
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));

-- ---------------------------------------------------------------- product_variants
drop policy product_variants_staff_select on public.product_variants;
drop policy product_variants_staff_insert on public.product_variants;
drop policy product_variants_staff_update on public.product_variants;
drop policy product_variants_staff_delete on public.product_variants;

create policy product_variants_staff_select on public.product_variants
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
create policy product_variants_staff_insert on public.product_variants
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy product_variants_staff_update on public.product_variants
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy product_variants_staff_delete on public.product_variants
  for delete to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));

-- ---------------------------------------------------------------- product_addons
drop policy product_addons_staff_select on public.product_addons;
drop policy product_addons_staff_insert on public.product_addons;
drop policy product_addons_staff_update on public.product_addons;
drop policy product_addons_staff_delete on public.product_addons;

create policy product_addons_staff_select on public.product_addons
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
create policy product_addons_staff_insert on public.product_addons
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy product_addons_staff_update on public.product_addons
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));
create policy product_addons_staff_delete on public.product_addons
  for delete to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
