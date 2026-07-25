-- ============================================================================
-- 0008_catalog_composite_fks.sql
-- Defense in depth against cross-tenant child injection. The catalog RLS write
-- policies check is_staff_of(business_id, ...) on the ROW being written, but do
-- not verify that a child's product_id (or a product's category_id) actually
-- belongs to that same business_id. A staff member of tenant A could therefore
-- attach a variant/add-on to tenant B's product by supplying B's product_id
-- with A's (trusted) business_id. Composite foreign keys make the parent's
-- business_id part of the referential contract, so the DB rejects any child
-- whose (product_id, business_id) pair does not exist in the parent tenant.
-- ============================================================================

-- Parent uniqueness targets for the composite references.
alter table public.products
  add constraint products_id_business_uniq unique (id, business_id);
alter table public.menu_categories
  add constraint menu_categories_id_business_uniq unique (id, business_id);

-- product_variants.product_id must belong to the same business_id.
alter table public.product_variants
  drop constraint product_variants_product_id_fkey,
  add constraint product_variants_product_business_fkey
    foreign key (product_id, business_id)
    references public.products (id, business_id) on delete cascade;

-- product_addons.product_id must belong to the same business_id.
alter table public.product_addons
  drop constraint product_addons_product_id_fkey,
  add constraint product_addons_product_business_fkey
    foreign key (product_id, business_id)
    references public.products (id, business_id) on delete cascade;

-- products.category_id (nullable) must belong to the same business_id when set.
-- MATCH SIMPLE (default): a null category_id skips the check (on delete set null
-- still works), a non-null one must match a same-tenant category.
alter table public.products
  drop constraint products_category_id_fkey,
  add constraint products_category_business_fkey
    foreign key (category_id, business_id)
    references public.menu_categories (id, business_id) on delete set null;
