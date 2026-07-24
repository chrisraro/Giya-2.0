# 21 — Schema: Identity, Businesses, Verification, Staff

Conventions (audit fields, triggers, UUIDv7, RLS enablement) per `20-data-model.md` — audit/soft-delete columns are shown once here in `profiles` and elided (`-- +audit`) afterwards for readability; they exist on every table.

```sql
-- ============================================================ profiles
-- 1:1 with auth.users. Platform-wide identity. RLS: P2 (self) + admin.
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  avatar_url    text,
  phone         text check (phone ~ '^\+63[0-9]{10}$'),          -- PH E.164
  locale        text not null default 'en-PH' check (locale in ('en-PH','fil-PH')),
  birth_date    date,                                            -- birthday campaigns; consumer-set, editable 1x/yr (app rule)
  is_suspended  boolean not null default false,
  suspended_reason text,
  onboarded_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  deleted_at    timestamptz
);

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
  last_scan_at           timestamptz
  -- +audit
);

-- ============================================================ platform_admins
-- RLS: P4 — select self + super_admin; writes via service role (super_admin surface).
create table public.platform_admins (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  role        text not null check (role in ('super_admin','admin','support')),
  is_active   boolean not null default true,
  mfa_enforced boolean not null default true
  -- +audit
);

-- ============================================================ businesses
-- The tenant root. RLS: P1 (staff read/write per role) + public read of active rows.
create table public.businesses (
  id               uuid primary key default uuid_generate_v7(),
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
  -- location
  address_line     text,
  barangay         text,
  city_id          uuid references public.ref_cities(id),
  postal_code      text,
  lat              double precision,
  lng              double precision,
  google_place_id  text,
  -- hours: [{day:1..7, open:"08:00", close:"22:00", closed:false}, …]
  opening_hours    jsonb not null default '[]',
  -- entitlement hooks [SCALE billing enforcement]
  plan             text not null default 'free' check (plan in ('free','starter','growth','enterprise')),
  plan_limits      jsonb not null default '{}',
  verified_at      timestamptz,
  suspended_reason text,
  search_tsv       tsvector generated always as (
                     to_tsvector('simple', unaccent(coalesce(name,'') || ' ' || coalesce(description,'')))
                   ) stored
  -- +audit, +deleted_at
);
-- NOTE (design decision): exactly ONE location representation — lat/lng doubles + Haversine.
-- No PostGIS dependency at MVP; "nearby" uses a bounding-box prefilter on businesses_latlng_idx
-- + Haversine sort. Swapping to PostGIS geography is an additive migration [SCALE].
create index businesses_city_idx     on public.businesses (city_id) where deleted_at is null;
create index businesses_status_idx   on public.businesses (status)  where deleted_at is null;
create index businesses_latlng_idx   on public.businesses (lat, lng) where status = 'active' and deleted_at is null;
create index businesses_tsv_idx      on public.businesses using gin (search_tsv);
create index businesses_name_trgm    on public.businesses using gin (name gin_trgm_ops);
create index businesses_type_idx     on public.businesses (business_type_id);

-- ============================================================ business_staff
-- Membership + role. RLS: P1 (owner manages; member reads own tenant roster).
create table public.business_staff (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null check (role in ('owner','manager','marketing','staff')),
  status       text not null default 'active' check (status in ('invited','active','disabled')),
  invited_email text,                     -- pre-signup invitations
  invite_token  text unique,
  invite_expires_at timestamptz,
  unique (business_id, user_id)
  -- +audit
);
create index business_staff_user_idx on public.business_staff (user_id) where status = 'active';
-- exactly-one-owner invariant:
create unique index business_staff_one_owner
  on public.business_staff (business_id) where role = 'owner' and status = 'active';

-- ============================================================ business_verifications
-- One row per submission round. RLS: owner insert/read own; admin all (service).
create table public.business_verifications (
  id           uuid primary key default uuid_generate_v7(),
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
  decided_at        timestamptz
  -- +audit
);
create index bv_business_idx on public.business_verifications (business_id, created_at desc);
create index bv_status_idx   on public.business_verifications (status) where status = 'pending';

-- ============================================================ business_documents
-- Uploaded verification docs. RLS: owner CRUD own (until approved); admin read. Bucket: business-documents.
create table public.business_documents (
  id              uuid primary key default uuid_generate_v7(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  verification_id uuid references public.business_verifications(id) on delete set null,
  doc_type        text not null check (doc_type in
                    ('business_permit','mayors_permit','tin','dti','sec','sample_receipt','other')),
  storage_path    text not null,          -- business-documents/{business_id}/{uuid}.pdf
  file_name       text not null,
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes > 0 and size_bytes <= 20971520),
  expires_on      date                    -- permit validity, for renewal reminders [V1]
  -- +audit, +deleted_at
);
create index bd_business_idx on public.business_documents (business_id);

-- ============================================================ business_customers
-- The CRM row: consumer × business relationship. Created on first interaction.
-- RLS: P3 dual-audience (consumer self-select; staff owner/manager/marketing select;
-- segment writes owner/manager; balance columns written ONLY by points service).
create table public.business_customers (
  id                 uuid primary key default uuid_generate_v7(),
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
  unique (business_id, consumer_id)
  -- +audit
);
create index bc_business_seg_idx on public.business_customers (business_id, segment);
create index bc_business_lastvisit_idx on public.business_customers (business_id, last_visit_at desc);
create index bc_consumer_idx on public.business_customers (consumer_id);

-- ============================================================ user_devices
-- Sessions/devices + FCM tokens. RLS: P2.
create table public.user_devices (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  fcm_token     text unique,
  platform      text check (platform in ('web','android','ios')),
  user_agent    text,
  last_seen_at  timestamptz not null default now(),
  is_revoked    boolean not null default false
  -- +audit
);
create index user_devices_user_idx on public.user_devices (user_id) where is_revoked = false;

-- ============================================================ reference tables
-- RLS: P4 public read; admin write via CMS.
create table public.ref_cities (
  id uuid primary key default uuid_generate_v7(),
  name text not null, province text not null, region text not null,
  slug text not null unique, is_active boolean not null default true
  -- +audit
);
create table public.ref_business_types (
  id uuid primary key default uuid_generate_v7(),
  name text not null unique, slug text not null unique,
  icon text, sort integer not null default 0, is_active boolean not null default true
  -- +audit
);
create table public.ref_food_types (          -- cuisine/food tags for discovery
  id uuid primary key default uuid_generate_v7(),
  name text not null unique, slug text not null unique,
  is_active boolean not null default true
  -- +audit
);
create table public.business_food_types (
  business_id uuid not null references public.businesses(id) on delete cascade,
  food_type_id uuid not null references public.ref_food_types(id) on delete cascade,
  primary key (business_id, food_type_id)
);
```

## Row-count expectations (drives index choices)

| Table | @ 100k businesses | Notes |
|---|---|---|
| businesses | 100k | Small; heavily read; ISR-cached pages |
| business_staff | ~300k | |
| consumers | 5–10M | |
| business_customers | 50–200M | Hot: composite indexes above are the discipline |
| user_devices | 10–20M | Pruned by cleanup queue (stale > 180d revoked) |

## Invariants enforced here

- One active owner per business (partial unique index).
- Phone format PH E.164; slug URL-safe; document size caps in-DB.
- `business_customers` uniqueness (one CRM row per pair) — the points engine upserts against this.
- TIN never stored plaintext.
