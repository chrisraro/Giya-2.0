-- ============================================================================
-- 0009_fix_category_fk_set_null_column.sql
-- 0008's products_category_business_fkey used `on delete set null` on the
-- composite (category_id, business_id) with no column list. Standard multi-
-- column FK semantics would null BOTH columns on parent delete, but
-- products.business_id is NOT NULL, so a category hard-delete would raise a
-- not-null violation instead of orphaning just the category link. Postgres 15
-- lets us scope SET NULL to category_id only. Unreachable today (no category
-- delete policy), fixed before category/business hard-delete ships.
-- ============================================================================

alter table public.products
  drop constraint products_category_business_fkey,
  add constraint products_category_business_fkey
    foreign key (category_id, business_id)
    references public.menu_categories (id, business_id)
    on delete set null (category_id);
