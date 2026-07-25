# Giya Catalog Slice - Design Spec

**Date:** 2026-07-25
**Status:** Approved (autonomous, recommended options); ready for planning
**Depends on:** auth slice (identity schema live, business_staff membership, server actions pattern). Target project: Supabase `dcnpuvtbftpbcjcvfnlt`.

## 1. Goal

The menu domain end to end: catalog schema + RLS, real business-portal menu management (categories, products, variants, add-ons) wired to Supabase, and the public consumer business page `/b/[slug]` rendering store info + menu. Replaces mock menu with live data for businesses; consumer business page is net-new.

## 2. Database (migration 0007_catalog)

Authority: `docs/20-data/22-schema-catalog.md` (verbatim tables), conventions `20-data-model.md`, RLS patterns doc 12. Tables: `menu_categories`, `products`, `product_variants`, `product_addons`. Adapt the doc's `uuid_generate_v7()` -> `private.uuid_generate_v7()`, `unaccent(...)` in the products generated column -> `private.immutable_unaccent(...)` (same fix as businesses), `gin_trgm_ops` -> `extensions.gin_trgm_ops`, `+audit`/`+deleted_at` expanded to the standard columns + touch trigger. RLS **P1 + public read** on all four:
- Staff read (owner/manager/marketing/staff) of own tenant, any status.
- Public read: `menu_categories`/`products` where `is_active`/`status='active'` (respectively) AND `deleted_at is null`; variants/addons public-read where `is_available` and parent visible (simplest correct: public read where `deleted_at is null` and `is_available`, tenant-scoped join enforced at query time; document).
- Writes (insert/update/delete): owner/manager only (`is_staff_of(business_id, ['owner','manager'])`), `business_id` denormalized on variants/addons so policies stay single-table.
- Soft delete via `deleted_at` (no delete policy needed for products/categories; hard delete allowed for variants/addons via owner/manager or soft - choose soft for consistency, document).
Applied via MCP + committed; types regenerated; a pgTAP smoke file (`rls_catalog_smoke.sql`) covering staff-write/public-read/cross-tenant-deny, run once via MCP.

## 3. Catalog service + actions

`src/features/menu/` (feature-first per doc 14): `server/repo.ts` (Supabase queries, server client, RLS-scoped), `server/service.ts` (orchestration; emits a `catalog.updated` event stub - a logged no-op `TODO(api): wire embeddings refresh (38)` since the AI slice is later), `actions.ts` (server actions: category create/rename/reorder/archive; product create/update/archive/toggle-availability; variant + addon add/remove), `schemas.ts` (Zod, shared client+server: name lengths, price >= 0 integer centavos, max 6 images, availability-window shape). Actions return `{ok:true,data?}|{ok:false,message}`, never throw; authz via RLS + a service-layer `is_staff_of` preflight is unnecessary (RLS enforces) but actions must confirm a session.

## 4. Business portal: menu management

Route `/business/menu` (portal, teal-led, both themes). Server component loads the business's categories + products (grouped) via the repo using the caller's active membership business. UI:
- Category sidebar/list with add + inline rename + reorder (up/down buttons, no drag lib) + archive.
- Product list per category: cards with name, price (mono centavos -> peso display), status chips (active/hidden/sold_out), availability toggle. Add/Edit product in a bottom sheet / dialog form (RHF + Zod): name, description, base price, category, status, images (URL list stub - upload wiring is a later storage slice; accept URLs / show a "upload arrives with storage" note), variants (name + absolute price rows), add-ons (name + delta price rows).
- Empty states (no categories yet, no products in category). Optimistic-ish: revalidate after each mutation (server action + `revalidatePath`).
- Money helper `src/lib/money.ts` (centavos <-> peso display, PHP), TDD.

## 5. Consumer: public business page `/b/[slug]`

Route `src/app/(consumer)/b/[slug]/page.tsx` (public, no auth; ISR `revalidate = 60`). Loads the active business by slug (public-read RLS via anon server client) + its active menu. Renders: cover/logo, name, type + city, description, opening-hours summary, and the menu grouped by category (product name, price-from, variant chips, sold-out styling). 404 (notFound) for missing/inactive slug. Consumer expressive profile; coral-led; mango only if a reward element appears (none here). Nav: reachable later from discover; for now direct-linkable and linked from the business dashboard ("View public page").

## 6. Constraints

Tokens only; zero em-dashes incl. SQL/comments; TS strict; server actions never trust client ids; RLS is the authz control; money as integer centavos always; Conventional Commits scope `menu`; feature-first layout; both themes on portal, ISR public page; existing suite green each task. Image upload + `catalog.updated` embeddings are stubbed with `TODO(api)`/`TODO(storage)` markers (later slices).

## 7. Out of scope

Image upload to storage, embeddings refresh, receipt line-item matching consumption, ordering/cart, menu QR, availability-window enforcement (stored + displayed, not enforced), analytics.

## 8. Success criteria

1. 0007 applied + committed; catalog tables live; advisors no new ERROR; pgTAP catalog smoke passes; types regenerated.
2. A business owner can create categories/products/variants/addons at `/business/menu` and they persist (verified live).
3. `/b/[slug]` renders that business's live menu publicly; inactive/missing slug 404s; cross-tenant writes blocked by RLS.
4. Gates green (lint, tests, build); zero em-dashes; both themes on portal.
5. Money display correct (centavos to peso), unit-tested.
