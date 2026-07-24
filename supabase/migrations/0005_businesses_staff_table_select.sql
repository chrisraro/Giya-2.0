-- ============================================================================
-- 0005_businesses_staff_table_select.sql
-- Staff can read their business rows via a table membership check, independent
-- of JWT claims (doc 12: claims are hints, tables are truth). Without this, an
-- owner whose token predates the membership (or with the token hook disabled)
-- cannot read their own draft business, breaking the dashboard status fetch.
-- The EXISTS probes business_staff_user_idx (partial on status = 'active'),
-- one indexed lookup per row, bounded by the businesses rows in scope.
-- ============================================================================

create policy businesses_staff_table_select on public.businesses
  for select to authenticated
  using (
    exists (
      select 1 from public.business_staff bs
      where bs.business_id = id
        and bs.user_id = (select auth.uid())
        and bs.status = 'active'
    )
  );
