-- ============================================================================
-- 0007_catalog.sql
-- Catalog domain: menu_categories, products, product_variants, product_addons.
-- Source docs: docs/20-data/22-schema-catalog.md, docs/20-data/20-data-model.md,
-- docs/10-architecture/12-multi-tenancy-rls.md.
-- Environment adaptations (same as 0002): uuid_generate_v7() ->
-- private.uuid_generate_v7(); unaccent() in generated tsvector ->
-- private.immutable_unaccent(); gin_trgm_ops -> extensions.gin_trgm_ops;
-- doc 22's "-- +audit, +deleted_at" shorthand expanded to the standard
-- audit columns + touch trigger + deleted_at.
-- ============================================================================

-- ============================================================ menu_categories
-- RLS: P1 (staff owner/manager write; public read of active rows).
create table public.menu_categories (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  description  text,
  sort         integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  unique (business_id, name)
);
alter table public.menu_categories enable row level security;
create trigger touch_menu_categories before update on public.menu_categories
  for each row execute function private.touch_updated_at();

create index menu_categories_biz_idx on public.menu_categories (business_id, sort)
  where deleted_at is null;

-- P1 + public read: anyone sees active, non-deleted categories (consumer menu)
create policy menu_categories_public_select on public.menu_categories
  for select to anon, authenticated
  using (is_active = true and deleted_at is null);
-- P1: staff of the tenant read their categories in any state
create policy menu_categories_staff_select on public.menu_categories
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager create categories in their own tenant
create policy menu_categories_staff_insert on public.menu_categories
  for insert to authenticated
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- P1: owner/manager update; with check pins business_id to their own tenant
create policy menu_categories_staff_update on public.menu_categories
  for update to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']))
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ products
-- RLS: P1 (staff owner/manager write; public read of active rows).
create table public.products (
  id             uuid primary key default private.uuid_generate_v7(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  category_id    uuid references public.menu_categories(id) on delete set null,
  name           text not null check (char_length(name) between 1 and 120),
  description    text check (char_length(description) <= 1000),
  base_price_centavos integer not null check (base_price_centavos >= 0),
  images         jsonb not null default '[]',      -- [{url, sort}] bucket: products
  status         text not null default 'active' check (status in ('active','hidden','sold_out')),
  is_available   boolean not null default true,    -- inventory flag (quick toggle)
  availability   jsonb not null default '{}',      -- optional day/time windows {days:[1..7], from:"11:00", to:"14:00"}
  sort           integer not null default 0,
  -- amendment: doc 22 uses bare unaccent(); generated columns require an
  -- immutable expression, so private.immutable_unaccent wraps it (see 0001).
  search_tsv     tsvector generated always as (
                   to_tsvector('simple', private.immutable_unaccent(coalesce(name,'') || ' ' || coalesce(description,'')))
                 ) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  updated_by     uuid references auth.users(id),
  deleted_at     timestamptz
);
alter table public.products enable row level security;
create trigger touch_products before update on public.products
  for each row execute function private.touch_updated_at();

create index products_biz_cat_idx on public.products (business_id, category_id, sort)
  where deleted_at is null;
create index products_tsv_idx on public.products using gin (search_tsv);
create index products_name_trgm on public.products using gin (name extensions.gin_trgm_ops); -- receipt line-item matching (36)
-- amendment: FK index per doc 20 convention (every FK indexed); the composite
-- above does not lead with category_id, so the on-delete-set-null path and
-- category lookups need their own index
create index products_category_idx on public.products (category_id);

-- P1 + public read: anyone sees active, non-deleted products (consumer menu)
create policy products_public_select on public.products
  for select to anon, authenticated
  using (status = 'active' and deleted_at is null);
-- P1: staff of the tenant read their products in any status
create policy products_staff_select on public.products
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager create products in their own tenant
create policy products_staff_insert on public.products
  for insert to authenticated
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- P1: owner/manager update; with check pins business_id to their own tenant
create policy products_staff_update on public.products
  for update to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']))
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ product_variants
-- e.g. sizes: Small/Medium/Large. Price is absolute, not delta (simpler math,
-- fewer bugs). business_id denormalized per doc 12 (single-table RLS).
create table public.product_variants (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,  -- denormalized (12)
  product_id   uuid not null references public.products(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  price_centavos integer not null check (price_centavos >= 0),
  is_available boolean not null default true,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  unique (product_id, name)
);
alter table public.product_variants enable row level security;
create trigger touch_product_variants before update on public.product_variants
  for each row execute function private.touch_updated_at();

create index product_variants_product_idx on public.product_variants (product_id);
-- amendment: FK index per doc 20 convention (every FK indexed)
create index product_variants_business_idx on public.product_variants (business_id);

-- P1 + public read: anyone sees available, non-deleted variants (consumer menu)
create policy product_variants_public_select on public.product_variants
  for select to anon, authenticated
  using (is_available = true and deleted_at is null);
-- P1: staff of the tenant read their variants in any state
create policy product_variants_staff_select on public.product_variants
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager create variants in their own tenant
create policy product_variants_staff_insert on public.product_variants
  for insert to authenticated
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- P1: owner/manager update; with check pins business_id to their own tenant
create policy product_variants_staff_update on public.product_variants
  for update to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']))
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- P1: owner/manager hard delete. Design choice: variants are child rows edited
-- inline in the menu builder, so hard delete keeps edit ergonomics; deleted_at
-- still exists for soft-hide flows that keep history.
create policy product_variants_staff_delete on public.product_variants
  for delete to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']));

-- ============================================================ product_addons
-- e.g. pearls +15, extra shot +25. Price is a delta.
-- business_id denormalized per doc 12 (single-table RLS).
create table public.product_addons (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  product_id   uuid not null references public.products(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  price_delta_centavos integer not null default 0 check (price_delta_centavos >= 0),
  is_available boolean not null default true,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  unique (product_id, name)
);
alter table public.product_addons enable row level security;
create trigger touch_product_addons before update on public.product_addons
  for each row execute function private.touch_updated_at();

create index product_addons_product_idx on public.product_addons (product_id);
-- amendment: FK index per doc 20 convention (every FK indexed)
create index product_addons_business_idx on public.product_addons (business_id);

-- P1 + public read: anyone sees available, non-deleted add-ons (consumer menu)
create policy product_addons_public_select on public.product_addons
  for select to anon, authenticated
  using (is_available = true and deleted_at is null);
-- P1: staff of the tenant read their add-ons in any state
create policy product_addons_staff_select on public.product_addons
  for select to authenticated
  using (private.is_staff_of(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager create add-ons in their own tenant
create policy product_addons_staff_insert on public.product_addons
  for insert to authenticated
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- P1: owner/manager update; with check pins business_id to their own tenant
create policy product_addons_staff_update on public.product_addons
  for update to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']))
  with check (private.is_staff_of(business_id, array['owner','manager']));
-- P1: owner/manager hard delete (same design choice as product_variants)
create policy product_addons_staff_delete on public.product_addons
  for delete to authenticated
  using (private.is_staff_of(business_id, array['owner','manager']));
