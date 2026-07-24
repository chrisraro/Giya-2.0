-- ============================================================================
-- 0006_fix_businesses_staff_table_select.sql
-- 0005's policy compared bs.business_id to the UNQUALIFIED id, which resolved
-- to bs.id inside the EXISTS scope, so the policy never matched. Recreate with
-- the outer relation qualified.
-- ============================================================================

drop policy businesses_staff_table_select on public.businesses;

create policy businesses_staff_table_select on public.businesses
  for select to authenticated
  using (
    exists (
      select 1 from public.business_staff bs
      where bs.business_id = businesses.id
        and bs.user_id = (select auth.uid())
        and bs.status = 'active'
    )
  );
