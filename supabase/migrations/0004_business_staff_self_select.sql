-- ============================================================================
-- 0004_business_staff_self_select.sql
-- A user can always read their OWN membership rows, independent of JWT claims.
-- Doc 12 makes tables the source of truth and claims mere hints; without this
-- policy a user whose token predates a membership (or with the token hook not
-- yet enabled) cannot discover their own tenants, which breaks the portal
-- membership check and the future business switcher (doc 30).
-- Note: this does not re-trigger the overflow recursion; the jwt_biz_role
-- table fallback only fires when the biz_overflow claim is true, and this
-- policy is claim-free.
-- ============================================================================

create policy business_staff_self_select on public.business_staff
  for select to authenticated
  using (user_id = (select auth.uid()));
