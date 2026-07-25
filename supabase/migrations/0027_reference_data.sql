-- ============================================================================
-- 0027_reference_data.sql
-- Reference data for the two lookup tables that onboarding and discovery read
-- but that 0002_identity.sql only stubbed: ref_cities (six rows, so a merchant
-- outside six cities could not name their own location) and ref_food_types
-- (zero rows, so business_food_types could never be populated and any
-- food-tag picker rendered empty).
--
-- Source docs: docs/20-data/21-schema-identity.md (the ref_cities /
-- ref_food_types / business_food_types DDL), docs/30-modules/32-business-portal.md
-- section 4 (store management reads city_id from ref_cities and offers a
-- business_food_types tag multi-select), docs/30-modules/33-consumer-pwa.md
-- ("Discover" filters: city_id from ref_cities, food_types from ref_food_types
-- via business_food_types), docs/00-product/00-vision.md (the market this
-- vocabulary has to fit: "food and retail SMEs, starting in the Philippines").
--
-- No DDL here. This migration only inserts rows into tables 0002 created, so
-- it creates no types, no tables and no policies.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY
-- ---------------------------------------------------------------------------
-- Every insert carries `on conflict (slug) do nothing`. `slug` is the stable
-- natural key: ref_cities_slug_key and ref_food_types_slug_key are the unique
-- constraints that actually exist on these tables (ref_cities has no unique
-- constraint on `name`, so `name` cannot be the conflict target). Replaying
-- this migration is therefore a no-op, and the six rows 0002 seeded plus the
-- Naga row added by hand during live verification are all matched by slug and
-- left exactly as they are rather than duplicated.
--
-- The seven pre-existing slugs are, verbatim: manila, cebu, davao, iloilo,
-- baguio, cagayan-de-oro, naga. They are repeated below with their original
-- spelling so the conflict fires. Do not "correct" those seven names to the
-- longer form (Cebu City, Davao City, Iloilo City): a new slug would not
-- conflict and the table would end up holding the same city twice.
--
-- ---------------------------------------------------------------------------
-- WHY name IS UNIQUE IN PRACTICE EVEN THOUGH NO CONSTRAINT SAYS SO
-- ---------------------------------------------------------------------------
-- src/features/identity/actions.ts resolves a consumer's chosen city with
--   .from("ref_cities").select("id").ilike("name", cityName).maybeSingle()
-- and `maybeSingle()` raises when more than one row matches. Four Philippine
-- city names are genuinely shared by two different chartered cities (San
-- Fernando, San Carlos, Talisay, and Naga, which is already seeded as the
-- Camarines Sur one). Seeding both members of such a pair under the bare name
-- would turn consumer onboarding into a runtime error for everybody, not just
-- for people in those cities, because the query is not filtered any further.
-- Each colliding city is therefore seeded with the province in parentheses,
-- which is also what a merchant needs to see in a picker to tell them apart.
--
-- The same reason drives keeping the word "City" on Batangas City, Cavite
-- City, Cotabato City, Isabela City, Masbate City, Quezon City, Sorsogon City,
-- Surigao City, Tarlac City and Zamboanga City: the bare form of each is the
-- name of a province (or of a group of provinces), so the bare form would read
-- as a region rather than a location. public.register_business resolves the
-- business-side city with `where slug = p_city or lower(name) = lower(p_city)
-- limit 1`, which is duplicate-tolerant, but the consumer path above is not,
-- so the stricter rule governs.
--
-- ---------------------------------------------------------------------------
-- WHERE THE CITY DATA COMES FROM
-- ---------------------------------------------------------------------------
-- All 149 chartered cities of the Philippines: 33 highly urbanized, 5
-- independent component, 111 component. That is a closed, checkable universe,
-- which is why it was chosen over a judgement call about which component
-- cities count as "major"; the row count reconciles exactly to the PSA totals.
-- Province and region were cross-checked against the PSA Philippine Standard
-- Geographic Code and per-province references. Three assignments are the ones
-- that stale datasets get wrong, so they are called out:
--
--   * Negros Island Region. RA 12000 (signed 13 June 2024) re-created NIR from
--     Negros Occidental, Negros Oriental and Siquijor, and PSA folded it into
--     the PSGC in the Q2 2024 update. Bacolod is therefore Negros Island
--     Region, NOT Western Visayas, and Dumaguete is Negros Island Region, NOT
--     Central Visayas. Every pre-2024 list of Philippine cities says otherwise.
--   * Isabela City (Basilan) is administered under Zamboanga Peninsula, not
--     BARMM, even though the rest of Basilan is BARMM: its voters declined to
--     join in both the 2001 and the January 2019 plebiscites. Lamitan, not
--     Isabela City, is Basilan's capital under BARMM.
--   * Cotabato City is BARMM (the Supreme Court upheld its inclusion on 10
--     January 2023) and is geographically enclaved by Maguindanao del Norte
--     after the 2022 split of Maguindanao.
--
-- `province` for a city that is legally independent of any province holds the
-- province that geographically contains it, which is the convention 0002 set
-- when it wrote Davao / Davao del Sur and Baguio / Benguet. NCR cities carry
-- 'Metro Manila', also 0002's convention. Both columns are `not null`, so
-- there is no "unknown" escape hatch and every row states a real answer.
--
-- ---------------------------------------------------------------------------
-- amendment: WHERE THE FOOD-TYPE DATA COMES FROM
-- ---------------------------------------------------------------------------
-- amendment: docs/20-data/21-schema-identity.md declares ref_food_types as
-- "cuisine/food tags for discovery" and specifies its DDL, but it specifies no
-- vocabulary, and neither does 32-business-portal.md or 33-consumer-pwa.md;
-- both only say the tags exist and are filterable. The list below is therefore
-- chosen, not transcribed, and this comment is the record of that. It is built
-- for the market 00-vision.md names, Philippine food and retail SMEs, so it
-- leads with the categories a Filipino carinderia, panaderia, milk tea shop or
-- grill actually sits in (Filipino, Silog and Breakfast, Lechon and Roast,
-- Noodles and Pancit, Halo-Halo and Cold Desserts, Kakanin and Local Snacks,
-- Pulutan and Bar Food, Street Food) rather than a generic international
-- cuisine list, and keeps the international entries a Philippine urban centre
-- genuinely has. 28 tags: enough to describe an SME without a picker that
-- needs its own search box.
-- ============================================================================

-- ============================================================ ref_cities
-- Idempotent on the unique slug. Ordered by region, then province, then city.

insert into public.ref_cities (name, province, region, slug) values
  -- National Capital Region (16)
  ('Caloocan',        'Metro Manila', 'National Capital Region', 'caloocan'),
  ('Las Piñas',       'Metro Manila', 'National Capital Region', 'las-pinas'),
  ('Makati',          'Metro Manila', 'National Capital Region', 'makati'),
  ('Malabon',         'Metro Manila', 'National Capital Region', 'malabon'),
  ('Mandaluyong',     'Metro Manila', 'National Capital Region', 'mandaluyong'),
  ('Manila',          'Metro Manila', 'National Capital Region', 'manila'),
  ('Marikina',        'Metro Manila', 'National Capital Region', 'marikina'),
  ('Muntinlupa',      'Metro Manila', 'National Capital Region', 'muntinlupa'),
  ('Navotas',         'Metro Manila', 'National Capital Region', 'navotas'),
  ('Parañaque',       'Metro Manila', 'National Capital Region', 'paranaque'),
  ('Pasay',           'Metro Manila', 'National Capital Region', 'pasay'),
  ('Pasig',           'Metro Manila', 'National Capital Region', 'pasig'),
  ('Quezon City',     'Metro Manila', 'National Capital Region', 'quezon-city'),
  ('San Juan',        'Metro Manila', 'National Capital Region', 'san-juan'),
  ('Taguig',          'Metro Manila', 'National Capital Region', 'taguig'),
  ('Valenzuela',      'Metro Manila', 'National Capital Region', 'valenzuela'),

  -- Cordillera Administrative Region (2)
  ('Baguio',          'Benguet',      'Cordillera Administrative Region', 'baguio'),
  ('Tabuk',           'Kalinga',      'Cordillera Administrative Region', 'tabuk'),

  -- Ilocos Region (9)
  ('Batac',                    'Ilocos Norte', 'Ilocos Region', 'batac'),
  ('Laoag',                    'Ilocos Norte', 'Ilocos Region', 'laoag'),
  ('Candon',                   'Ilocos Sur',   'Ilocos Region', 'candon'),
  ('Vigan',                    'Ilocos Sur',   'Ilocos Region', 'vigan'),
  ('San Fernando (La Union)',  'La Union',     'Ilocos Region', 'san-fernando-la-union'),
  ('Alaminos',                 'Pangasinan',   'Ilocos Region', 'alaminos'),
  ('Dagupan',                  'Pangasinan',   'Ilocos Region', 'dagupan'),
  ('San Carlos (Pangasinan)',  'Pangasinan',   'Ilocos Region', 'san-carlos-pangasinan'),
  ('Urdaneta',                 'Pangasinan',   'Ilocos Region', 'urdaneta'),

  -- Cagayan Valley (4)
  ('Tuguegarao',      'Cagayan',      'Cagayan Valley', 'tuguegarao'),
  ('Cauayan',         'Isabela',      'Cagayan Valley', 'cauayan'),
  ('Ilagan',          'Isabela',      'Cagayan Valley', 'ilagan'),
  ('Santiago',        'Isabela',      'Cagayan Valley', 'santiago'),

  -- Central Luzon (15)
  ('Balanga',                 'Bataan',      'Central Luzon', 'balanga'),
  ('Baliwag',                 'Bulacan',     'Central Luzon', 'baliwag'),
  ('Malolos',                 'Bulacan',     'Central Luzon', 'malolos'),
  ('Meycauayan',              'Bulacan',     'Central Luzon', 'meycauayan'),
  ('San Jose del Monte',      'Bulacan',     'Central Luzon', 'san-jose-del-monte'),
  ('Cabanatuan',              'Nueva Ecija', 'Central Luzon', 'cabanatuan'),
  ('Gapan',                   'Nueva Ecija', 'Central Luzon', 'gapan'),
  ('Muñoz',                   'Nueva Ecija', 'Central Luzon', 'munoz'),
  ('Palayan',                 'Nueva Ecija', 'Central Luzon', 'palayan'),
  ('San Jose',                'Nueva Ecija', 'Central Luzon', 'san-jose'),
  ('Angeles',                 'Pampanga',    'Central Luzon', 'angeles'),
  ('Mabalacat',               'Pampanga',    'Central Luzon', 'mabalacat'),
  ('San Fernando (Pampanga)', 'Pampanga',    'Central Luzon', 'san-fernando-pampanga'),
  ('Tarlac City',             'Tarlac',      'Central Luzon', 'tarlac-city'),
  ('Olongapo',                'Zambales',    'Central Luzon', 'olongapo'),

  -- CALABARZON (22)
  ('Batangas City',   'Batangas', 'CALABARZON', 'batangas-city'),
  ('Calaca',          'Batangas', 'CALABARZON', 'calaca'),
  ('Lipa',            'Batangas', 'CALABARZON', 'lipa'),
  ('Santo Tomas',     'Batangas', 'CALABARZON', 'santo-tomas'),
  ('Tanauan',         'Batangas', 'CALABARZON', 'tanauan'),
  ('Bacoor',          'Cavite',   'CALABARZON', 'bacoor'),
  ('Carmona',         'Cavite',   'CALABARZON', 'carmona'),
  ('Cavite City',     'Cavite',   'CALABARZON', 'cavite-city'),
  ('Dasmariñas',      'Cavite',   'CALABARZON', 'dasmarinas'),
  ('General Trias',   'Cavite',   'CALABARZON', 'general-trias'),
  ('Imus',            'Cavite',   'CALABARZON', 'imus'),
  ('Tagaytay',        'Cavite',   'CALABARZON', 'tagaytay'),
  ('Trece Martires',  'Cavite',   'CALABARZON', 'trece-martires'),
  ('Biñan',           'Laguna',   'CALABARZON', 'binan'),
  ('Cabuyao',         'Laguna',   'CALABARZON', 'cabuyao'),
  ('Calamba',         'Laguna',   'CALABARZON', 'calamba'),
  ('San Pablo',       'Laguna',   'CALABARZON', 'san-pablo'),
  ('San Pedro',       'Laguna',   'CALABARZON', 'san-pedro'),
  ('Santa Rosa',      'Laguna',   'CALABARZON', 'santa-rosa'),
  ('Lucena',          'Quezon',   'CALABARZON', 'lucena'),
  ('Tayabas',         'Quezon',   'CALABARZON', 'tayabas'),
  ('Antipolo',        'Rizal',    'CALABARZON', 'antipolo'),

  -- MIMAROPA Region (2)
  ('Calapan',         'Oriental Mindoro', 'MIMAROPA Region', 'calapan'),
  ('Puerto Princesa', 'Palawan',          'MIMAROPA Region', 'puerto-princesa'),

  -- Bicol Region (7)
  ('Legazpi',         'Albay',         'Bicol Region', 'legazpi'),
  ('Ligao',           'Albay',         'Bicol Region', 'ligao'),
  ('Tabaco',          'Albay',         'Bicol Region', 'tabaco'),
  ('Iriga',           'Camarines Sur', 'Bicol Region', 'iriga'),
  ('Naga',            'Camarines Sur', 'Bicol Region', 'naga'),
  ('Masbate City',    'Masbate',       'Bicol Region', 'masbate-city'),
  ('Sorsogon City',   'Sorsogon',      'Bicol Region', 'sorsogon-city'),

  -- Western Visayas (3)
  ('Roxas',           'Capiz',  'Western Visayas', 'roxas'),
  ('Iloilo',          'Iloilo', 'Western Visayas', 'iloilo'),
  ('Passi',           'Iloilo', 'Western Visayas', 'passi'),

  -- Negros Island Region (19). RA 12000, 13 June 2024. Not Western Visayas
  -- and not Central Visayas, whatever a pre-2024 dataset says.
  ('Bacolod',                       'Negros Occidental', 'Negros Island Region', 'bacolod'),
  ('Bago',                          'Negros Occidental', 'Negros Island Region', 'bago'),
  ('Cadiz',                         'Negros Occidental', 'Negros Island Region', 'cadiz'),
  ('Escalante',                     'Negros Occidental', 'Negros Island Region', 'escalante'),
  ('Himamaylan',                    'Negros Occidental', 'Negros Island Region', 'himamaylan'),
  ('Kabankalan',                    'Negros Occidental', 'Negros Island Region', 'kabankalan'),
  ('La Carlota',                    'Negros Occidental', 'Negros Island Region', 'la-carlota'),
  ('Sagay',                         'Negros Occidental', 'Negros Island Region', 'sagay'),
  ('San Carlos (Negros Occidental)','Negros Occidental', 'Negros Island Region', 'san-carlos-negros-occidental'),
  ('Silay',                         'Negros Occidental', 'Negros Island Region', 'silay'),
  ('Sipalay',                       'Negros Occidental', 'Negros Island Region', 'sipalay'),
  ('Talisay (Negros Occidental)',   'Negros Occidental', 'Negros Island Region', 'talisay-negros-occidental'),
  ('Victorias',                     'Negros Occidental', 'Negros Island Region', 'victorias'),
  ('Bais',                          'Negros Oriental',   'Negros Island Region', 'bais'),
  ('Bayawan',                       'Negros Oriental',   'Negros Island Region', 'bayawan'),
  ('Canlaon',                       'Negros Oriental',   'Negros Island Region', 'canlaon'),
  ('Dumaguete',                     'Negros Oriental',   'Negros Island Region', 'dumaguete'),
  ('Guihulngan',                    'Negros Oriental',   'Negros Island Region', 'guihulngan'),
  ('Tanjay',                        'Negros Oriental',   'Negros Island Region', 'tanjay'),

  -- Central Visayas (10)
  ('Tagbilaran',      'Bohol', 'Central Visayas', 'tagbilaran'),
  ('Bogo',            'Cebu',  'Central Visayas', 'bogo'),
  ('Carcar',          'Cebu',  'Central Visayas', 'carcar'),
  ('Cebu',            'Cebu',  'Central Visayas', 'cebu'),
  ('Danao',           'Cebu',  'Central Visayas', 'danao'),
  ('Lapu-Lapu',       'Cebu',  'Central Visayas', 'lapu-lapu'),
  ('Mandaue',         'Cebu',  'Central Visayas', 'mandaue'),
  ('Naga (Cebu)',     'Cebu',  'Central Visayas', 'naga-cebu'),
  ('Talisay (Cebu)',  'Cebu',  'Central Visayas', 'talisay-cebu'),
  ('Toledo',          'Cebu',  'Central Visayas', 'toledo'),

  -- Eastern Visayas (7)
  ('Borongan',        'Eastern Samar',  'Eastern Visayas', 'borongan'),
  ('Baybay',          'Leyte',          'Eastern Visayas', 'baybay'),
  ('Ormoc',           'Leyte',          'Eastern Visayas', 'ormoc'),
  ('Tacloban',        'Leyte',          'Eastern Visayas', 'tacloban'),
  ('Calbayog',        'Samar',          'Eastern Visayas', 'calbayog'),
  ('Catbalogan',      'Samar',          'Eastern Visayas', 'catbalogan'),
  ('Maasin',          'Southern Leyte', 'Eastern Visayas', 'maasin'),

  -- Zamboanga Peninsula (5). Isabela City belongs here, not to BARMM.
  ('Isabela City',    'Basilan',              'Zamboanga Peninsula', 'isabela-city'),
  ('Dapitan',         'Zamboanga del Norte',  'Zamboanga Peninsula', 'dapitan'),
  ('Dipolog',         'Zamboanga del Norte',  'Zamboanga Peninsula', 'dipolog'),
  ('Pagadian',        'Zamboanga del Sur',    'Zamboanga Peninsula', 'pagadian'),
  ('Zamboanga City',  'Zamboanga del Sur',    'Zamboanga Peninsula', 'zamboanga-city'),

  -- Northern Mindanao (9)
  ('Malaybalay',      'Bukidnon',           'Northern Mindanao', 'malaybalay'),
  ('Valencia',        'Bukidnon',           'Northern Mindanao', 'valencia'),
  ('Iligan',          'Lanao del Norte',    'Northern Mindanao', 'iligan'),
  ('Oroquieta',       'Misamis Occidental', 'Northern Mindanao', 'oroquieta'),
  ('Ozamiz',          'Misamis Occidental', 'Northern Mindanao', 'ozamiz'),
  ('Tangub',          'Misamis Occidental', 'Northern Mindanao', 'tangub'),
  ('Cagayan de Oro',  'Misamis Oriental',   'Northern Mindanao', 'cagayan-de-oro'),
  ('El Salvador',     'Misamis Oriental',   'Northern Mindanao', 'el-salvador'),
  ('Gingoog',         'Misamis Oriental',   'Northern Mindanao', 'gingoog'),

  -- Davao Region (6)
  ('Panabo',          'Davao del Norte', 'Davao Region', 'panabo'),
  ('Samal',           'Davao del Norte', 'Davao Region', 'samal'),
  ('Tagum',           'Davao del Norte', 'Davao Region', 'tagum'),
  ('Davao',           'Davao del Sur',   'Davao Region', 'davao'),
  ('Digos',           'Davao del Sur',   'Davao Region', 'digos'),
  ('Mati',            'Davao Oriental',  'Davao Region', 'mati'),

  -- SOCCSKSARGEN (4)
  ('Kidapawan',       'Cotabato',       'SOCCSKSARGEN', 'kidapawan'),
  ('General Santos',  'South Cotabato', 'SOCCSKSARGEN', 'general-santos'),
  ('Koronadal',       'South Cotabato', 'SOCCSKSARGEN', 'koronadal'),
  ('Tacurong',        'Sultan Kudarat', 'SOCCSKSARGEN', 'tacurong'),

  -- Caraga (6)
  ('Butuan',          'Agusan del Norte',  'Caraga', 'butuan'),
  ('Cabadbaran',      'Agusan del Norte',  'Caraga', 'cabadbaran'),
  ('Bayugan',         'Agusan del Sur',    'Caraga', 'bayugan'),
  ('Surigao City',    'Surigao del Norte', 'Caraga', 'surigao-city'),
  ('Bislig',          'Surigao del Sur',   'Caraga', 'bislig'),
  ('Tandag',          'Surigao del Sur',   'Caraga', 'tandag'),

  -- Bangsamoro Autonomous Region in Muslim Mindanao (3)
  ('Lamitan',       'Basilan',              'Bangsamoro Autonomous Region in Muslim Mindanao', 'lamitan'),
  ('Marawi',        'Lanao del Sur',        'Bangsamoro Autonomous Region in Muslim Mindanao', 'marawi'),
  ('Cotabato City', 'Maguindanao del Norte','Bangsamoro Autonomous Region in Muslim Mindanao', 'cotabato-city')
on conflict (slug) do nothing;

-- ============================================================ ref_food_types
-- Idempotent on the unique slug. ref_food_types has no `sort` column (unlike
-- ref_business_types), so display order is the reader's problem and these are
-- listed in the order a picker would most usefully show them: what a Philippine
-- SME is most likely to be, first.

insert into public.ref_food_types (name, slug) values
  ('Filipino',                'filipino'),
  ('Silog and Breakfast',     'silog-breakfast'),
  ('Rice Meals',              'rice-meals'),
  ('Grill and Barbecue',      'grill-barbecue'),
  ('Lechon and Roast',        'lechon-roast'),
  ('Noodles and Pancit',      'noodles-pancit'),
  ('Seafood',                 'seafood'),
  ('Street Food',             'street-food'),
  ('Pulutan and Bar Food',    'pulutan-bar-food'),
  ('Coffee',                  'coffee'),
  ('Milk Tea and Boba',       'milk-tea-boba'),
  ('Juice and Smoothies',     'juice-smoothies'),
  ('Bakery and Pastries',     'bakery-pastries'),
  ('Kakanin and Local Snacks','kakanin-local-snacks'),
  ('Halo-Halo and Cold Desserts', 'halo-halo-cold-desserts'),
  ('Desserts and Ice Cream',  'desserts-ice-cream'),
  ('Fast Food',               'fast-food'),
  ('Chicken',                 'chicken'),
  ('Burgers and Sandwiches',  'burgers-sandwiches'),
  ('Pizza and Pasta',         'pizza-pasta'),
  ('Chinese',                 'chinese'),
  ('Japanese',                'japanese'),
  ('Korean',                  'korean'),
  ('Thai',                    'thai'),
  ('American',                'american'),
  ('Italian',                 'italian'),
  ('Halal',                   'halal'),
  ('Vegetarian and Vegan',    'vegetarian-vegan')
on conflict (slug) do nothing;
