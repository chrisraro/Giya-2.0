needed-- ============================================================================
-- 0002_identity.sql
-- Identity domain: reference tables, profiles, consumers, platform_admins,
-- businesses, staff, verification, documents, CRM rows, devices, consents.
-- Source docs: docs/20-data/21-schema-identity.md, docs/20-data/20-data-model.md,
-- docs/20-data/26-schema-amendments.md (identity [MVP] accepted deltas only:
-- A21.1 profiles.birth_date_updated_at, A21.2 user_consents, A21.3
-- consumers.scan_blocked_until), docs/10-architecture/12-multi-tenancy-rls.md.
-- ============================================================================

-- ---------------------------------------------------------------- referral code
-- amendment: defined here (not 0001) because consumers.referral_code uses it as
-- a column default; it is identity-domain plumbing. 8-char Crockford-less
-- base32 (A-Z, 2-7) per doc 21.
create or replace function private.gen_referral_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  bytes bytea := extensions.gen_random_bytes(8);
  code text := '';
  i int;
begin
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return code;
end
$$;

grant execute on function private.gen_referral_code() to authenticated, service_role;

-- ============================================================ reference tables
-- RLS: P4 public read; admin write via CMS (service role, no client policy).
create table public.ref_cities (
  id         uuid primary key default private.uuid_generate_v7(),
  name       text not null,
  province   text not null,
  region     text not null,
  slug       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);
alter table public.ref_cities enable row level security;
create trigger touch_ref_cities before update on public.ref_cities
  for each row execute function private.touch_updated_at();

-- P4: public read; writes are service-role only (no write policies)
create policy ref_cities_public_select on public.ref_cities
  for select to anon, authenticated using (true);

create table public.ref_business_types (
  id         uuid primary key default private.uuid_generate_v7(),
  name       text not null unique,
  slug       text not null unique,
  icon       text,
  sort       integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);
alter table public.ref_business_types enable row level security;
create trigger touch_ref_business_types before update on public.ref_business_types
  for each row execute function private.touch_updated_at();

-- P4: public read; writes are service-role only (no write policies)
create policy ref_business_types_public_select on public.ref_business_types
  for select to anon, authenticated using (true);

create table public.ref_food_types (
  id         uuid primary key default private.uuid_generate_v7(),
  name       text not null unique,
  slug       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);
alter table public.ref_food_types enable row level security;
create trigger touch_ref_food_types before update on public.ref_food_types
  for each row execute function private.touch_updated_at();

-- P4: public read; writes are service-role only (no write policies)
create policy ref_food_types_public_select on public.ref_food_types
  for select to anon, authenticated using (true);

-- ============================================================ profiles
-- 1:1 with auth.users. Platform-wide identity. RLS: P2 (self) + admin.
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  avatar_url    text,
  phone         text check (phone ~ '^\+63[0-9]{10}$'),          -- PH E.164
  locale        text not null default 'en-PH' check (locale in ('en-PH','fil-PH')),
  birth_date    date,                       -- birthday campaigns; consumer-set, editable 1x/yr (app rule)
  -- amendment: A21.1 [MVP] editable-once-per-rolling-year enforcement column
  birth_date_updated_at timestamptz,
  is_suspended  boolean not null default false,
  suspended_reason text,
  onboarded_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  deleted_at    timestamptz
);
alter table public.profiles enable row level security;
create trigger touch_profiles before update on public.profiles
  for each row execute function private.touch_updated_at();

-- P2: owner reads and writes own row
create policy profiles_owner_select on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_owner_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- P2 + admin: platform admins read all profiles
create policy profiles_admin_select on public.profiles
  for select to authenticated using (private.is_admin());
-- No insert/delete policies: rows are created by private.handle_new_user
-- (security definer, 0003) and removed via auth.users cascade / service role.

-- ============================================================ consumers
-- Consumer-role extension. RLS: P2.
create table public.consumers (
  id                     uuid primary key references public.profiles(id) on delete cascade,
  referral_code          text not null unique default private.gen_referral_code(), -- 8-char base32
  referred_by            uuid references public.consumers(id),
  marketing_opt_in       boolean not null default false,
  push_enabled           boolean not null default true,
  email_enabled          boolean not null default true,
  gps_fraud_opt_in       boolean not null default false,
  city_id                uuid references public.ref_cities(id),
  lifetime_points_earned integer not null default 0,   -- derived, maintained by points service
  last_scan_at           timestamptz,
  -- amendment: A21.3 [MVP] durable scan cooldown (fraud consequences ladder)
  scan_blocked_until     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id),
  updated_by             uuid references auth.users(id)
);
alter table public.consumers enable row level security;
create trigger touch_consumers before update on public.consumers
  for each row execute function private.touch_updated_at();
-- amendment: FK indexes per doc 20 convention (every FK indexed)
create index consumers_referred_by_idx on public.consumers (referred_by);
create index consumers_city_idx on public.consumers (city_id);

-- P2: owner reads and updates own row; inserts happen via the signup trigger
-- (security definer) so no insert policy is exposed.
create policy consumers_owner_select on public.consumers
  for select to authenticated using (id = (select auth.uid()));
create policy consumers_owner_update on public.consumers
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ============================================================ platform_admins
-- RLS: P4. Select self + super_admin; writes via service role (super_admin surface).
create table public.platform_admins (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  role         text not null check (role in ('super_admin','admin','support')),
  is_active    boolean not null default true,
  mfa_enforced boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id)
);
alter table public.platform_admins enable row level security;
create trigger touch_platform_admins before update on public.platform_admins
  for each row execute function private.touch_updated_at();

-- P4: self + super_admin read; no client write policies (service role only)
create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (auth.jwt()->'app_metadata'->>'admin_role') = 'super_admin'
  );

-- ============================================================ businesses
-- The tenant root. RLS: P1 (staff read/write per role) + public read of active rows.
create table public.businesses (
  id               uuid primary key default private.uuid_generate_v7(),
  slug             text not null unique check (slug ~ '^[a-z0-9-]{3,60}$'),
  name             text not null check (char_length(name) between 2 and 120),
  status           text not null default 'draft'
                     check (status in ('draft','pending_verification','active','suspended','closed')),
  business_type_id uuid not null references public.ref_business_types(id),
  description      text check (char_length(description) <= 2000),
  logo_url         text,
  cover_url        text,
  gallery          jsonb not null default '[]',            -- [{url, caption, sort}]
  phone            text,
  email            text,
  website          text,
  socials          jsonb not null default '{}',            -- {facebook, instagram, tiktok}
  -- location (design decision: lat/lng doubles + Haversine, no PostGIS at MVP)
  address_line     text,
  barangay         text,
  city_id          uuid references public.ref_cities(id),
  postal_code      text,
  lat              double precision,
  lng              double precision,
  google_place_id  text,
  -- hours: [{day:1..7, open:"08:00", close:"22:00", closed:false}, ...]
  opening_hours    jsonb not null default '[]',
  -- entitlement hooks [SCALE billing enforcement]
  plan             text not null default 'free' check (plan in ('free','starter','growth','enterprise')),
  plan_limits      jsonb not null default '{}',
  verified_at      timestamptz,
  suspended_reason text,
  -- amendment: doc 21 uses bare unaccent(); generated columns require an
  -- immutable expression, so private.immutable_unaccent wraps it (see 0001).
  search_tsv       tsvector generated always as (
                     to_tsvector('simple', private.immutable_unaccent(coalesce(name,'') || ' ' || coalesce(description,'')))
                   ) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id),
  updated_by       uuid references auth.users(id),
  deleted_at       timestamptz
);
alter table public.businesses enable row level security;
create trigger touch_businesses before update on public.businesses
  for each row execute function private.touch_updated_at();

create index businesses_city_idx   on public.businesses (city_id) where deleted_at is null;
create index businesses_status_idx on public.businesses (status)  where deleted_at is null;
create index businesses_latlng_idx on public.businesses (lat, lng) where status = 'active' and deleted_at is null;
create index businesses_tsv_idx    on public.businesses using gin (search_tsv);
create index businesses_name_trgm  on public.businesses using gin (name extensions.gin_trgm_ops);
create index businesses_type_idx   on public.businesses (business_type_id);

-- P1 + public read: anyone sees active, non-deleted businesses
create policy businesses_public_select on public.businesses
  for select to anon, authenticated
  using (status = 'active' and deleted_at is null);
-- P1: staff of the tenant read their business in any status
create policy businesses_staff_select on public.businesses
  for select to authenticated
  using (private.is_staff_of(id, array['owner','manager','marketing','staff']));
-- P1: owner/manager update their business; tenant key is the PK so no hopping
create policy businesses_staff_update on public.businesses
  for update to authenticated
  using (private.is_staff_of(id, array['owner','manager']))
  with check (private.is_staff_of(id, array['owner','manager']));
-- No insert policy: creation goes through the register_business RPC
-- (security definer, 0003). No delete policy: soft delete via update.

-- ============================================================ business_staff
-- Membership + role. RLS: readable by same-tenant staff; writes service-role
-- only for now (invites/role changes ship with the staff module).
create table public.business_staff (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  role          text not null check (role in ('owner','manager','marketing','staff')),
  status        text not null default 'active' check (status in ('invited','active','disabled')),
  invited_email text,                     -- pre-signup invitations
  invite_token  text unique,
  invite_expires_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  unique (business_id, user_id)
);
alter table public.business_staff enable row level security;
create trigger touch_business_staff before update on public.business_staff
  for each row execute function private.touch_updated_at();

create index business_staff_user_idx on public.business_staff (user_id) where status = 'active';
-- exactly-one-owner invariant:
create unique index business_staff_one_owner
  on public.business_staff (business_id) where role = 'owner' and status = 'active';

-- P1: same-tenant staff read the roster; no client write policies (service role)
create policy business_staff_tenant_select on public.business_staff
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager','marketing','staff']));

-- ============================================================ business_verifications
-- One row per submission round. RLS: staff read own tenant; writes service-role.
create table public.business_verifications (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected','revision_requested')),
  tin_encrypted     bytea,               -- AES-GCM app-layer encryption (15-security.md)
  tin_masked        text,                -- "***-***-123" for display
  registered_name   text,
  registration_type text check (registration_type in ('dti','sec','none')),
  notes             text,                -- applicant notes
  decision_reason   text,                -- admin decision note (required on reject/revision)
  decided_by        uuid references public.profiles(id),
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id),
  updated_by        uuid references auth.users(id)
);
alter table public.business_verifications enable row level security;
create trigger touch_business_verifications before update on public.business_verifications
  for each row execute function private.touch_updated_at();

create index bv_business_idx on public.business_verifications (business_id, created_at desc);
create index bv_status_idx   on public.business_verifications (status) where status = 'pending';
-- amendment: FK index per doc 20 convention (every FK indexed)
create index bv_decided_by_idx on public.business_verifications (decided_by);

-- P1: owner/manager read own tenant rounds (sensitive: tin_masked, decisions);
-- all writes go through service-role verification flows, no client write policies
create policy business_verifications_staff_select on public.business_verifications
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']));

-- ============================================================ business_documents
-- Uploaded verification docs. RLS: staff read own tenant; writes service-role.
-- Bucket: business-documents.
create table public.business_documents (
  id              uuid primary key default private.uuid_generate_v7(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  verification_id uuid references public.business_verifications(id) on delete set null,
  doc_type        text not null check (doc_type in
                    ('business_permit','mayors_permit','tin','dti','sec','sample_receipt','other')),
  storage_path    text not null,          -- business-documents/{business_id}/{uuid}.pdf
  file_name       text not null,
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes > 0 and size_bytes <= 20971520),
  expires_on      date,                   -- permit validity, for renewal reminders [V1]
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  updated_by      uuid references auth.users(id),
  deleted_at      timestamptz
);
alter table public.business_documents enable row level security;
create trigger touch_business_documents before update on public.business_documents
  for each row execute function private.touch_updated_at();

create index bd_business_idx on public.business_documents (business_id);
-- amendment: FK index per doc 20 convention (every FK indexed)
create index bd_verification_idx on public.business_documents (verification_id);

-- P1: owner/manager read own tenant docs; writes via service-role upload flow
create policy business_documents_staff_select on public.business_documents
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']));

-- ============================================================ business_customers
-- The CRM row: consumer x business relationship. Created on first interaction.
-- RLS: P3 dual-audience (consumer self-select; staff owner/manager/marketing
-- select; segment writes owner/manager; balance columns written ONLY by the
-- points service, enforced at the service layer since RLS is row-scoped).
create table public.business_customers (
  id                 uuid primary key default private.uuid_generate_v7(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  consumer_id        uuid not null references public.consumers(id) on delete cascade,
  segment            text not null default 'regular' check (segment in ('regular','vip','blacklisted')),
  points_balance     integer not null default 0 check (points_balance >= 0),
  lifetime_points    integer not null default 0,
  lifetime_spend_centavos bigint not null default 0,
  visit_count        integer not null default 0,
  first_visit_at     timestamptz,
  last_visit_at      timestamptz,
  notes              text,                -- staff-visible note (never shown to consumer)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id),
  updated_by         uuid references auth.users(id),
  unique (business_id, consumer_id)
);
alter table public.business_customers enable row level security;
create trigger touch_business_customers before update on public.business_customers
  for each row execute function private.touch_updated_at();

create index bc_business_seg_idx       on public.business_customers (business_id, segment);
create index bc_business_lastvisit_idx on public.business_customers (business_id, last_visit_at desc);
create index bc_consumer_idx           on public.business_customers (consumer_id);

-- P3: consumer sees own rows
create policy business_customers_consumer_select on public.business_customers
  for select to authenticated using (consumer_id = (select auth.uid()));
-- P3: tenant staff see rows for their business
create policy business_customers_staff_select on public.business_customers
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager','marketing']));
-- P3: owner/manager update (segment, notes); balance/visit columns are written
-- by the points service (service role) in the same transaction as the ledger
create policy business_customers_staff_update on public.business_customers
  for update to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']))
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- No insert policy for either audience: rows are created by service-role code
-- paths on first interaction so the points/fraud pipeline cannot be bypassed.

-- ============================================================ user_devices
-- Sessions/devices + FCM tokens. RLS: P2.
create table public.user_devices (
  id            uuid primary key default private.uuid_generate_v7(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  fcm_token     text unique,
  platform      text check (platform in ('web','android','ios')),
  user_agent    text,
  last_seen_at  timestamptz not null default now(),
  is_revoked    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id)
);
alter table public.user_devices enable row level security;
create trigger touch_user_devices before update on public.user_devices
  for each row execute function private.touch_updated_at();

create index user_devices_user_idx on public.user_devices (user_id) where is_revoked = false;

-- P2: owner full access to own device rows
create policy user_devices_owner_all on public.user_devices
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============================================================ user_consents
-- amendment: A21.2 [MVP] per docs/20-data/26-schema-amendments.md. Records who
-- accepted which cms_pages version. Consent records are immutable: no update
-- or delete policies. No audit columns per the ratified DDL (consented_at is
-- the record timestamp). page_slug has no FK because cms_pages lands in a
-- later platform migration.
create table public.user_consents (
  id           uuid primary key default private.uuid_generate_v7(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  page_slug    text not null,               -- cms_pages.slug ('terms', 'privacy', ...)
  version      integer not null,            -- cms_pages.version accepted
  consented_at timestamptz not null default now(),
  ip           inet,
  unique (user_id, page_slug, version)
);
alter table public.user_consents enable row level security;

create index user_consents_user_idx on public.user_consents (user_id, page_slug, version desc);

-- P2: insert/read own; immutable (no update/delete policies)
create policy user_consents_owner_select on public.user_consents
  for select to authenticated using (user_id = (select auth.uid()));
create policy user_consents_owner_insert on public.user_consents
  for insert to authenticated with check (user_id = (select auth.uid()));

-- ============================================================ business_food_types
-- Join table for cuisine/food discovery tags. Doc 21 assigns no explicit
-- pattern; treated as P1 with public read (ids feed public discovery filters).
create table public.business_food_types (
  business_id  uuid not null references public.businesses(id) on delete cascade,
  food_type_id uuid not null references public.ref_food_types(id) on delete cascade,
  primary key (business_id, food_type_id)
);
alter table public.business_food_types enable row level security;
-- amendment: FK index per doc 20 convention (PK covers business_id lead)
create index bft_food_type_idx on public.business_food_types (food_type_id);

-- P1 + public read: tag links are public discovery data
create policy bft_public_select on public.business_food_types
  for select to anon, authenticated using (true);
-- P1: owner/manager manage their tags
create policy bft_staff_insert on public.business_food_types
  for insert to authenticated
  with check (private.is_staff_of(business_id, array['owner','manager']));
create policy bft_staff_delete on public.business_food_types
  for delete to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']));

-- ============================================================ seeds
-- Idempotent: stable natural key is the unique slug (and name for types).
insert into public.ref_cities (name, province, region, slug) values
  ('Cebu',           'Cebu',             'Central Visayas',                  'cebu'),
  ('Manila',         'Metro Manila',     'National Capital Region',          'manila'),
  ('Davao',          'Davao del Sur',    'Davao Region',                     'davao'),
  ('Iloilo',         'Iloilo',           'Western Visayas',                  'iloilo'),
  ('Baguio',         'Benguet',          'Cordillera Administrative Region', 'baguio'),
  ('Cagayan de Oro', 'Misamis Oriental', 'Northern Mindanao',                'cagayan-de-oro')
on conflict (slug) do nothing;

insert into public.ref_business_types (name, slug, sort) values
  ('Cafe',       'cafe',       10),
  ('Restaurant', 'restaurant', 20),
  ('Bakery',     'bakery',     30),
  ('Retail',     'retail',     40),
  ('Grocery',    'grocery',    50),
  ('Other',      'other',      60)
on conflict (slug) do nothing;
