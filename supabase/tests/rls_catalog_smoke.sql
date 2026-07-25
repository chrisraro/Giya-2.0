-- ============================================================================
-- rls_catalog_smoke.sql (pgTAP)
-- Smoke tests for catalog-domain RLS (menu_categories, products,
-- product_variants, product_addons). Runs entirely inside one transaction and
-- rolls back. Execute as a privileged role (postgres) against a database with
-- migrations 0001-0007 applied. pgTAP lives in the extensions schema.
--
-- Fixture strategy: mirror rls_identity_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- then create two tenant businesses via the register_business RPC under
-- set-local-role authenticated. Business ids are parked in transaction-local
-- settings (test.biz1 / test.biz2) so restricted roles can reference them
-- without needing select access to draft businesses.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(14);

-- ---------------------------------------------------------------- fixtures
-- Three fixed test users: two business owners and one bare consumer.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('33333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-catalog-owner1@example.com', '{"full_name": "Catalog Owner One"}'::jsonb),
  ('44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-catalog-owner2@example.com', '{"full_name": "Catalog Owner Two"}'::jsonb),
  ('55555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-catalog-bare@example.com', '{"full_name": "Bare Consumer"}'::jsonb);

-- owner1 registers tenant 1
select set_config('request.jwt.claims',
  '{"sub": "33333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select public.register_business('Catalog Cafe', 'cafe', 'cebu', '1 Menu Street');
reset role;

-- owner2 registers tenant 2
select set_config('request.jwt.claims',
  '{"sub": "44444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select public.register_business('Rival Resto', 'restaurant', 'manila', '2 Other Ave');
reset role;

-- park tenant ids in transaction-local settings for use under app roles
select set_config('test.biz1',
  (select id::text from public.businesses where name = 'Catalog Cafe'), true);
select set_config('test.biz2',
  (select id::text from public.businesses where name = 'Rival Resto'), true);

-- ---------------------------------------------------------------- owner writes (P1)
-- owner1 with a biz claim for Catalog Cafe
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub',  '33333333-3333-4333-8333-333333333333',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'biz', jsonb_build_object(current_setting('test.biz1'), 'owner')))::text,
  true);
set local role authenticated;

-- 1. owner inserts a category
select lives_ok(
  $$insert into public.menu_categories (business_id, name, sort)
    values (current_setting('test.biz1')::uuid, 'Drinks', 10)$$,
  'owner inserts a menu category into own tenant (P1 insert)');

-- 2. owner inserts an active product
select lives_ok(
  $$insert into public.products (business_id, category_id, name, base_price_centavos, status)
    values (current_setting('test.biz1')::uuid,
            (select id from public.menu_categories where name = 'Drinks'),
            'Iced Latte', 12000, 'active')$$,
  'owner inserts an active product into own tenant (P1 insert)');

-- 3. owner inserts a hidden product
select lives_ok(
  $$insert into public.products (business_id, name, base_price_centavos, status)
    values (current_setting('test.biz1')::uuid, 'Secret Item', 9900, 'hidden')$$,
  'owner inserts a hidden product into own tenant (P1 insert)');

-- 4. owner inserts a variant on the active product
select lives_ok(
  $$insert into public.product_variants (business_id, product_id, name, price_centavos)
    values (current_setting('test.biz1')::uuid,
            (select id from public.products where name = 'Iced Latte'),
            'Large', 15000)$$,
  'owner inserts a product variant into own tenant (P1 insert)');

-- 5. staff select: owner sees all own products, including the hidden one
select is(
  (select count(*)::int from public.products
    where business_id = current_setting('test.biz1')::uuid),
  2,
  'owner sees both active and hidden products of own tenant (P1 staff select)');

reset role;

-- ---------------------------------------------------------------- anon reads
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

-- 6. anon sees the active product
select is(
  (select count(*)::int from public.products where name = 'Iced Latte'),
  1,
  'anon sees the active product (P1 public select)');

-- 7. anon does not see the hidden product
select is(
  (select count(*)::int from public.products where name = 'Secret Item'),
  0,
  'anon does not see the hidden product (P1 public select is active-only)');

-- 8. anon sees the available variant
select is(
  (select count(*)::int from public.product_variants where name = 'Large'),
  1,
  'anon sees the available variant (P1 public select)');

-- 9. anon sees the active category
select is(
  (select count(*)::int from public.menu_categories where name = 'Drinks'),
  1,
  'anon sees the active category (P1 public select)');

reset role;

-- ---------------------------------------------------------------- cross-tenant deny
-- owner2 with a biz claim only for Rival Resto
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub',  '44444444-4444-4444-8444-444444444444',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'biz', jsonb_build_object(current_setting('test.biz2'), 'owner')))::text,
  true);
set local role authenticated;

-- 10. tenant-2 owner gets zero rows for tenant-1 staff-only data (the active
--     product is public by design, so the hidden product is the isolation probe)
select is(
  (select count(*)::int from public.products where name = 'Secret Item'),
  0,
  'tenant-2 owner cannot see tenant-1 hidden product (P1 cross-tenant deny)');

-- 11. tenant-2 owner cannot insert into tenant-1
select throws_ok(
  $$insert into public.products (business_id, name, base_price_centavos)
    values (current_setting('test.biz1')::uuid, 'Hijack Item', 100)$$,
  '42501',
  null,
  'tenant-2 owner insert into tenant-1 products is blocked (P1 with check)');

reset role;

-- ---------------------------------------------------------------- bare user deny
-- authenticated user with no membership and no biz claim
select set_config('request.jwt.claims',
  '{"sub": "55555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;

-- 12. bare authenticated user cannot insert a product into tenant-1
select throws_ok(
  $$insert into public.products (business_id, name, base_price_centavos)
    values (current_setting('test.biz1')::uuid, 'Freeloader Item', 100)$$,
  '42501',
  null,
  'bare authenticated user insert into tenant-1 products is blocked (P1 with check)');

reset role;

-- ---------------------------------------------------------------- variant hard delete
-- owner1 again: child rows allow hard delete by owner/manager (edit ergonomics)
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub',  '33333333-3333-4333-8333-333333333333',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'biz', jsonb_build_object(current_setting('test.biz1'), 'owner')))::text,
  true);
set local role authenticated;

-- 13. owner hard-deletes the variant
select lives_ok(
  $$delete from public.product_variants where name = 'Large'$$,
  'owner hard-deletes a variant in own tenant (P1 delete)');

reset role;

-- 14. the delete actually removed the row (checked as privileged role)
select is(
  (select count(*)::int from public.product_variants where name = 'Large'),
  0,
  'variant row is gone after owner delete');

select * from finish();

rollback;
