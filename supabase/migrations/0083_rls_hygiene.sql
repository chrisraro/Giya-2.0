-- ============================================================================
-- 0083_rls_hygiene.sql
-- RLS and privilege hygiene from the 2026-10 audit. WRITTEN, NOT APPLIED: the
-- owner applies this by hand in the Supabase SQL Editor. Forward-only; no
-- existing migration is edited. Every statement is idempotent (drop ... if
-- exists / create index if not exists), so a replay is a no-op.
--
-- BLOCK 1  qr_codes (0069). FINDING: `qr_codes_public_select ... to anon,
--   authenticated using (true)` plus `grant select ... to anon, authenticated`
--   let anyone enumerate every QR code, its target and its scan_count with one
--   unfiltered REST call. The only reader is src/app/q/[code]/route.ts, which
--   resolves ONE code. That route now uses the service-role client with an
--   exact-match lookup and an active-business check, so the table needs no
--   client audience at all: policy dropped, select revoked from anon AND
--   authenticated (with no policy authenticated would see zero rows anyway;
--   revoking the grant makes the denial loud instead of silent). RLS stays
--   enabled with no policy = deny by default; service_role keeps its grants.
--   DEPLOY ORDER: ship the route change before (or with) this migration, or
--   /q/{code} redirects everything to /discover until it lands.
--
-- BLOCK 2  business_documents (0067 vs 0002/0011/0079). FINDINGS:
--   (a) 0067's `business_docs_staff_select` widened read to marketing/staff via
--       the JWT-claim helper is_staff_of. These are permits and tax forms;
--       0011's `business_documents_staff_select` (owner/manager, table-truth
--       is_active_staff) is the intended rule and stays. Dropped.
--   (b) 0067's `business_docs_staff_insert` let owner/manager insert a row with
--       ANY storage_path (e.g. another tenant's object) and used the claims
--       helper, so it disagreed with 0079's object policies. Replaced by a
--       table-truth policy that also pins storage_path to the `{business_id}/`
--       prefix, which is the exact object name shape 0079 fences on and
--       newBusinessDocumentPath() produces (`{business_id}/{uuid}.{ext}`).
--   (c) 0067 granted UPDATE with no policy. With RLS that updates nothing, but
--       it is a grant nobody intends (replacement of a reviewed document is
--       deliberately not a capability, see 0079). Revoked. Review decisions and
--       soft deletes go through the service role.
--   The onboarding upload (src/features/businesses/onboarding/actions.ts)
--   inserts through the SESSION client as the merchant, so it is subject to the
--   new policy: it passes owner/manager of the business and a storage_path of
--   `{businessId}/{uuid}.{ext}`; no app change is needed.
--
-- BLOCK 3  private.create_monthly_partition (0072). FINDING: SECURITY DEFINER,
--   no search_path, default PUBLIC execute, and it builds DDL from caller-
--   supplied identifiers. Unused anywhere in src/ or supabase/ (grep-verified).
--   Dropped rather than hardened.
--
-- BLOCK 4  favorites (0065). FINDINGS: the three policies call bare auth.uid()
--   (advisor auth_rls_initplan: re-evaluated per row) and favorites.business_id
--   has no covering index (every FK is indexed, doc 20). Policies recreated
--   with (select auth.uid()); favorites_business_idx added.
--
-- BLOCK 5  platform_admins (0002). FINDING: platform_admins_select used a bare
--   auth.uid() (auth_rls_initplan). Same semantics, now (select auth.uid()); the
--   auth.jwt() call is wrapped for the same reason.
--
-- BLOCK 6  announcements (0070). FINDING: the public select ignored `audience`,
--   so anon could read consumer-only and business-only announcements. anon now
--   sees only audience = 'all'. authenticated keeps today's behaviour (every
--   active row): docs/20-data/25-schema-platform.md defines `audience` but no
--   per-role audience rule for signed-in users, so narrowing them is a product
--   decision, not hygiene.
--
-- BLOCK 7  SECURITY DEFINER functions. This migration creates or replaces none,
--   so there is nothing to pin. (Block 3 removes the one definer function that
--   lacked search_path.) Any future definer function must `set search_path = ''`
--   and revoke/grant explicitly, because create or replace re-applies
--   Supabase's default PUBLIC execute.
-- ============================================================================

-- ============================================================ 1. qr_codes
drop policy if exists qr_codes_public_select on public.qr_codes;
revoke select on public.qr_codes from anon, authenticated;

-- ============================================================ 2. business_documents
drop policy if exists business_docs_staff_select on public.business_documents;
drop policy if exists business_docs_staff_insert on public.business_documents;
drop policy if exists business_documents_staff_insert on public.business_documents;

create policy business_documents_staff_insert on public.business_documents
  for insert to authenticated
  with check (
    private.is_active_staff(business_id, array['owner', 'manager'])
    and starts_with(storage_path, business_id::text || '/')
  );

revoke update on public.business_documents from authenticated;

-- ============================================================ 3. dead definer
drop function if exists private.create_monthly_partition(text, integer, integer);

-- ============================================================ 4. favorites
drop policy if exists favorites_consumer_select on public.favorites;
drop policy if exists favorites_consumer_insert on public.favorites;
drop policy if exists favorites_consumer_delete on public.favorites;

create policy favorites_consumer_select on public.favorites
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy favorites_consumer_insert on public.favorites
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy favorites_consumer_delete on public.favorites
  for delete to authenticated
  using (user_id = (select auth.uid()));

create index if not exists favorites_business_idx on public.favorites (business_id);

-- ============================================================ 5. platform_admins
drop policy if exists platform_admins_select on public.platform_admins;
create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or ((select auth.jwt())->'app_metadata'->>'admin_role') = 'super_admin'
  );

-- ============================================================ 6. announcements
drop policy if exists announcements_public_select on public.announcements;
drop policy if exists announcements_anon_select on public.announcements;
drop policy if exists announcements_authenticated_select on public.announcements;

create policy announcements_anon_select on public.announcements
  for select to anon
  using (is_active = true and audience = 'all');

create policy announcements_authenticated_select on public.announcements
  for select to authenticated
  using (is_active = true);
