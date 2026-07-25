-- ============================================================================
-- ref_data_smoke.sql (pgTAP)
-- Smoke tests for 0027_reference_data.sql: the two lookup tables are populated,
-- the seed is idempotent on its natural key, and every seeded city states a
-- real province and a real region.
--
-- The third property is the one worth having. `province` and `region` are both
-- `not null`, so Postgres already refuses a missing value, but "not null" and
-- "true" are different things, and a reference table full of confidently wrong
-- regions silently mis-tags every business that picks one. These tests pin the
-- assignments that stale datasets get wrong: Bacolod and Dumaguete are Negros
-- Island Region (RA 12000, June 2024), Isabela City is Zamboanga Peninsula
-- rather than BARMM, and Cotabato City is BARMM.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0027 applied. pgTAP
-- lives in the extensions schema.
--
-- Unlike the RLS suites in this directory there are no fixtures and no roles to
-- assume: reference data is global by design, has no tenant, and its whole
-- point is that anonymous readers can see it. Bare counts over the two ref_
-- tables are therefore correct here, and are the exception to the "never count
-- over a whole table" rule the receipts and notifications suites follow, which
-- exists because those tables also hold live E2E rows. These two hold nothing
-- but seed.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(19);

-- ------------------------------------------------------------- non-empty
-- 1. ref_food_types was empty, which made business_food_types unpopulatable by
--    any tenant and rendered every food-tag picker blank.
select isnt_empty(
  'select 1 from public.ref_food_types',
  'ref_food_types is seeded at all');

-- 2. and it holds the whole vocabulary, not a token row
select cmp_ok(
  (select count(*) from public.ref_food_types)::int, '>=', 20,
  'ref_food_types holds a usable vocabulary, not a stub');

-- 3. every food type is selectable
select is(
  (select count(*) from public.ref_food_types where not is_active)::int, 0,
  'no seeded food type is inactive');

-- 4. ref_cities held six rows, so a merchant outside six cities could not name
--    their own location during onboarding
select cmp_ok(
  (select count(*) from public.ref_cities)::int, '>=', 145,
  'ref_cities holds the chartered cities of the Philippines, not a six-row stub');

-- 5. all of them pickable
select is(
  (select count(*) from public.ref_cities where not is_active)::int, 0,
  'no seeded city is inactive');

-- ------------------------------------------- every city states where it is
-- 6. and 7. the `not null` constraints say these cannot be null; these say they
--    cannot be blank either, which is the same lie in a different shape
select is(
  (select count(*) from public.ref_cities
    where province is null or btrim(province) = '')::int, 0,
  'every seeded city has a non-null, non-blank province');

select is(
  (select count(*) from public.ref_cities
    where region is null or btrim(region) = '')::int, 0,
  'every seeded city has a non-null, non-blank region');

-- 8. a region outside the 18 that exist is a typo that would silently mis-tag
--    every business in it, and would never surface as an error
select is_empty(
  $$select name, region from public.ref_cities where region not in (
      'National Capital Region', 'Cordillera Administrative Region',
      'Ilocos Region', 'Cagayan Valley', 'Central Luzon', 'CALABARZON',
      'MIMAROPA Region', 'Bicol Region', 'Western Visayas', 'Central Visayas',
      'Eastern Visayas', 'Negros Island Region', 'Zamboanga Peninsula',
      'Northern Mindanao', 'Davao Region', 'SOCCSKSARGEN', 'Caraga',
      'Bangsamoro Autonomous Region in Muslim Mindanao')$$,
  'every city sits in one of the 18 real Philippine regions');

-- 9. all 18 are actually represented, so no region is quietly unreachable
select is(
  (select count(distinct region) from public.ref_cities)::int, 18,
  'all 18 regions are represented');

-- 10. RA 12000 (13 June 2024) re-created the Negros Island Region. Every
--     pre-2024 dataset puts Bacolod in Western Visayas.
select is(
  (select region from public.ref_cities where slug = 'bacolod'),
  'Negros Island Region',
  'Bacolod is Negros Island Region, not Western Visayas');

-- 11. same law, the other half: Dumaguete left Central Visayas
select is(
  (select region from public.ref_cities where slug = 'dumaguete'),
  'Negros Island Region',
  'Dumaguete is Negros Island Region, not Central Visayas');

-- 12. Basilan is BARMM but Isabela City is not: its voters declined in 2001
--     and again in January 2019
select is(
  (select region from public.ref_cities where slug = 'isabela-city'),
  'Zamboanga Peninsula',
  'Isabela City is administered under Zamboanga Peninsula, not BARMM');

-- 13. and Cotabato City is the reverse case
select is(
  (select region from public.ref_cities where slug = 'cotabato-city'),
  'Bangsamoro Autonomous Region in Muslim Mindanao',
  'Cotabato City is BARMM');

-- ------------------------------------------------------- name uniqueness
-- 14. src/features/identity/actions.ts resolves a consumer's city with
--     .ilike("name", cityName).maybeSingle(), which RAISES on a tie. Two cities
--     sharing a name would break consumer onboarding for everybody, not just
--     for people in those cities. No constraint enforces this, so this test is
--     the enforcement.
select is_empty(
  $$select lower(name) from public.ref_cities
     group by lower(name) having count(*) > 1$$,
  'no two cities share a name, which the consumer city lookup cannot survive');

-- 15. the four genuine collisions are disambiguated rather than dropped, so
--     both members are still reachable
select is(
  (select count(*) from public.ref_cities
    where slug in ('naga', 'naga-cebu',
                   'san-fernando-la-union', 'san-fernando-pampanga',
                   'san-carlos-pangasinan', 'san-carlos-negros-occidental',
                   'talisay-cebu', 'talisay-negros-occidental'))::int, 8,
  'both members of every duplicated city name are seeded under distinct slugs');

-- ---------------------------------------------------------- idempotency
-- 16 to 19. replaying the seed adds nothing. `slug` is the stable natural key
--     and the conflict target; this is what makes the migration safe to re-run
--     and what stopped the hand-added Naga row from being duplicated when 0027
--     seeded Naga again.
--
--     The replays below are a slice of the seed, not the whole of it, which is
--     sufficient: every row in 0027 goes in under the same `on conflict (slug)
--     do nothing`, so one conflicting row proves the clause and one row that
--     conflicts with a HAND-ADDED row (naga) proves the specific case that
--     motivated this, that the migration does not duplicate what live
--     verification inserted by hand.
--
--     Asserting on the whole table's row count rather than on the replayed
--     slugs is deliberate: `slug` is unique, so "the two slugs still number
--     two" is true whether or not the insert was a no-op, and would pass even
--     if the clause were broken.
select set_config('test.cities_before',
  (select count(*) from public.ref_cities)::text, true);

select lives_ok(
  $$insert into public.ref_cities (name, province, region, slug) values
      ('Naga',    'Camarines Sur',     'Bicol Region',          'naga'),
      ('Bacolod', 'Negros Occidental', 'Negros Island Region',  'bacolod')
    on conflict (slug) do nothing$$,
  'replaying the city seed does not raise');

select is(
  (select count(*) from public.ref_cities)::int,
  current_setting('test.cities_before')::int,
  'replaying the city seed leaves the ref_cities row count unchanged');

-- same for food types
select set_config('test.food_before',
  (select count(*) from public.ref_food_types)::text, true);

select lives_ok(
  $$insert into public.ref_food_types (name, slug)
    values ('Filipino', 'filipino'), ('Coffee', 'coffee')
    on conflict (slug) do nothing$$,
  'replaying the food-type seed does not raise');

select is(
  (select count(*) from public.ref_food_types)::int,
  current_setting('test.food_before')::int,
  'replaying the food-type seed leaves the ref_food_types row count unchanged');

select * from finish();

rollback;
