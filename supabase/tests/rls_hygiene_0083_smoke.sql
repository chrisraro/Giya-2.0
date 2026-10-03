-- ============================================================================
-- rls_hygiene_0083_smoke.sql (pgTAP)
-- Smoke tests for 0083_rls_hygiene.sql. Runs in one transaction and rolls back.
-- Execute as a privileged role (postgres) against a database with 0001-0083
-- applied. pgTAP lives in the extensions schema.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(11);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('f1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-hyg-owner@example.com', '{"full_name": "Hygiene Owner"}'::jsonb),
  ('f2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-hyg-marketing@example.com', '{"full_name": "Hygiene Marketing"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "f1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Hygiene Cafe', 'cafe', 'naga', '1 Hygiene Street')::text),
  true);
reset role;

insert into public.business_staff (business_id, user_id, role, status, created_by, updated_by)
values (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222',
        'marketing', 'active',
        'f1111111-1111-4111-8111-111111111111', 'f1111111-1111-4111-8111-111111111111');

insert into public.business_documents
  (business_id, doc_type, storage_path, file_name, mime_type, size_bytes)
values (current_setting('test.biz')::uuid, 'dti',
        current_setting('test.biz') || '/aaaaaaaa-1111-4111-8111-111111111111.pdf',
        'dti.pdf', 'application/pdf', 1024);

insert into public.qr_codes (code, business_id, target_type)
values ('HYGIENE0083', current_setting('test.biz')::uuid, 'business_page');

insert into public.announcements (title, content, audience, is_active)
values ('hyg-all', 'x', 'all', true),
       ('hyg-consumers', 'x', 'consumers', true),
       ('hyg-businesses', 'x', 'businesses', true);

-- ---------------------------------------------------------------- catalog
select hasnt_function('private', 'create_monthly_partition',
  array['text', 'integer', 'integer'], 'dead definer create_monthly_partition is gone');

select has_index('public', 'favorites', 'favorites_business_idx',
  'favorites.business_id FK is indexed');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'qr_codes'),
  0, 'qr_codes has no policy left');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'business_documents'
      and policyname in ('business_docs_staff_select', 'business_docs_staff_insert')),
  0, '0067 business_documents policies are gone');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('favorites', 'platform_admins')
      and coalesce(qual, '') || coalesce(with_check, '') ~ 'auth\.uid\(\)'
      and coalesce(qual, '') || coalesce(with_check, '') !~* 'select auth\.uid\(\)'),
  0, 'favorites / platform_admins policies use (select auth.uid())');

-- ---------------------------------------------------------------- anon
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

select throws_ok('select * from public.qr_codes', '42501', null,
  'anon cannot select qr_codes');
select throws_ok('select * from public.business_documents', '42501', null,
  'anon cannot select business_documents');
select is(
  (select string_agg(title, ',') from public.announcements where title like 'hyg-%'),
  'hyg-all', 'anon sees only the audience=all announcement');

reset role;

-- ---------------------------------------------------------------- staff
select set_config('request.jwt.claims',
  '{"sub": "f2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select is(
  (select count(*)::int from public.business_documents
    where business_id = current_setting('test.biz')::uuid),
  0, 'marketing staff cannot read business_documents');

reset role;

select set_config('request.jwt.claims',
  '{"sub": "f1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  format('insert into public.business_documents (business_id, doc_type, storage_path, file_name, mime_type, size_bytes) values (%L, %L, %L, %L, %L, 10)',
    current_setting('test.biz'), 'dti', 'other-tenant/evil.pdf', 'evil.pdf', 'application/pdf'),
  '42501', null, 'owner cannot insert a document with a storage_path outside their prefix');

reset role;

select * from finish();
rollback;
