# Giya Catalog Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement `docs/superpowers/specs/2026-07-25-catalog-slice-design.md`: catalog schema + RLS, business menu management, public business page.

**Architecture:** Migration authored as a file + applied by the CONTROLLER via MCP. Feature-first `src/features/menu/`. Server components + server actions; RLS is the authz control. Public business page is ISR.

## Global Constraints

- DDL authority: `docs/20-data/22-schema-catalog.md` (verbatim tables), `20-data-model.md` (conventions), doc 12 (RLS). Adaptations REQUIRED for hosted Supabase: `private.uuid_generate_v7()`, `private.immutable_unaccent(...)` in the products generated tsvector, `extensions.gin_trgm_ops`, standard audit columns (`created_at/updated_at` + `private.touch_updated_at()` trigger, `created_by/updated_by`, `deleted_at`) expanding the doc's `+audit`/`+deleted_at` shorthand.
- Every table: `enable row level security` immediately; P1 staff read (owner/manager/marketing/staff) + public read of visible rows + owner/manager writes; `business_id` denormalized on variants/addons (already in doc) so policies are single-table.
- Implementers NEVER apply migrations (no MCP). The controller (Task 2) applies.
- App: tokens only, zero em-dashes incl. comments, TS strict no `any`, money as integer centavos, server actions confirm session + return `{ok}|{ok:false,message}`, feature-first layout, both themes on portal / ISR public page. Conventional Commits scope `menu`. Env only via `src/lib/env.ts` / supabase clients. Branch `feat/catalog-slice`. Existing suite (87) green each task.

---

### Task 1: Author migration 0007 + pgTAP smoke

**Files:** Create `supabase/migrations/0007_catalog.sql`, `supabase/tests/rls_catalog_smoke.sql`.

**Binding:** four tables verbatim from doc 22 with the adaptations above. RLS per each table:
- `menu_categories`, `products`: staff select (4 roles) own tenant; public select where visible (`is_active`/`status='active'` and `deleted_at is null`); insert/update owner+manager (`private.is_staff_of(business_id, array['owner','manager'])`), with `with check` on same business_id. No delete policy (soft delete via update).
- `product_variants`, `product_addons`: staff select own tenant; public select where `is_available and deleted_at is null`; insert/update/delete owner+manager. (These are child rows; allow hard delete by owner/manager for edit ergonomics, plus soft `deleted_at` column exists - use hard delete policy, document choice.)
- All FKs indexed (doc has the indexes; add any missing per convention). products tsv + name trgm GIN present with the private/extensions adaptations.
- pgTAP (`select plan(N)`, begin/rollback): seed a business + owner via a fixed uuid inserted into auth.users (reuse the identity smoke pattern), then assert: owner inserts a category/product (lives_ok); public/anon sees active product but NOT a hidden one; a second tenant's owner cannot select the first's product (cross-tenant zero); non-owner role (e.g. a bare authenticated user with no membership) cannot insert (throws or zero). >= 8 assertions.

**Steps:**
- [ ] Read doc 22 fully + skim doc 12 patterns. Author 0007 with adaptations; author pgTAP.
- [ ] Self-check: every table RLS-enabled; every definer-free policy references private helpers that already exist (0001); FK order (categories before products before variants/addons); grep zero em-dashes.
- [ ] `npm test` still green (no app code). Commit: `feat(menu): catalog schema, RLS, pgTAP smoke (authored)`

---

### Task 2 (controller): apply 0007 + verify + types

- [ ] MCP `apply_migration` 0007 (fix-forward in-file on any error before first success). Run `rls_catalog_smoke.sql` via `execute_sql`; all assertions pass. `get_advisors security` -> no new ERROR (resolve or document WARNs). `generate_typescript_types` -> overwrite `src/lib/supabase/types.ts`; `npm run build` green. Commit: `db(menu): apply catalog migration, regenerated types`

---

### Task 3: money helper + menu schemas + service/repo/actions

**Files:** Create `src/lib/money.ts` + test; `src/features/menu/schemas.ts`, `src/features/menu/server/repo.ts`, `src/features/menu/server/service.ts`, `src/features/menu/actions.ts`, `src/features/menu/types.ts`; test `src/features/menu/menu.test.ts`.

**Binding:**
- `money.ts`: `centavosToPeso(n: number): string` ("PHP 1,250.00" style -> actually return "1,250.00"; a `formatPeso(n, {symbol?})` returning "₱1,250.00" when symbol true) and `pesoToCentavos(input: string|number): number` (parse "1250.50" -> 125050, integer, throws/NaN-guard). TDD: 0 -> "0.00"; 125050 -> "1,250.50"; round-trip; reject negative.
- `schemas.ts` (Zod, shared): `categorySchema` (name 1-80, description optional, sort int), `productSchema` (name 1-120, description <= 1000, basePriceCentavos int >= 0, categoryId uuid|null, status enum active|hidden|sold_out, isAvailable bool, images url[] max 6, availability window optional {days:int[1-7][], from?:"HH:MM", to?:"HH:MM"}), `variantSchema` (name 1-60, priceCentavos int >= 0), `addonSchema` (name 1-60, priceDeltaCentavos int >= 0). Export inferred types.
- `repo.ts`: functions using the SERVER supabase client (RLS-scoped): `listCategories(businessId)`, `listProducts(businessId)`, `getBusinessForOwner()` (resolve caller's first active membership business id + row), plus insert/update/soft-archive/delete for each entity. Only layer touching the DB client.
- `service.ts`: thin orchestration; after any catalog mutation call `emitCatalogUpdated(businessId)` = a local function that `console.info`s + carries `// TODO(api): wire embeddings refresh job (doc 38)`.
- `actions.ts` ("use server"): one action per mutation the UI needs (createCategory, renameCategory, reorderCategory, archiveCategory; createProduct, updateProduct, archiveProduct, toggleProductAvailability; addVariant, removeVariant, addAddon, removeAddon). Each: confirm session (getUser), resolve the caller's business id server-side (never from client), Zod-parse input, call service, `revalidatePath("/business/menu")`, return `{ok}|{ok:false,message}`.
- Tests: money (TDD) + action-arg validation with a mocked server client (asserts repo called with right args; unauthenticated -> ok:false; invalid input -> ok:false with message).

**Steps:**
- [ ] TDD money.ts. Then schemas, repo, service, actions with mocked-client tests.
- [ ] Gates. Commit: `feat(menu): money helper, catalog schemas, service and server actions`

---

### Task 4: business portal menu management UI

**Files:** Create `src/app/(business)/business/(portal)/menu/page.tsx` (replace the ComingSoon stub route if it exists - check; the portal stub for menu was created in product-ui Task 6, repoint it), `src/features/menu/components/` (category-list.tsx, product-list.tsx, product-form.tsx, menu-manager.tsx client wrapper). Test: a component test for product-form validation states.

**Binding:**
- Page (server): resolve caller business via repo; if none -> redirect `/business/onboarding`; load categories+products; render `<MenuManager>` (client) with initial data.
- MenuManager (client): category list (add via inline field, rename inline, reorder up/down, archive with confirm), product list per selected category, add/edit product in a Dialog/bottom-sheet (`product-form` with RHF + zodResolver using `productSchema`; variants/addons as repeatable rows; images as a URL list with a "Uploads arrive with the storage slice" helper note - `TODO(storage)`), availability quick-toggle per product card, status chips. Calls the server actions; on `{ok:false}` show inline error; success relies on revalidate. Money displayed via `formatPeso`.
- Teal-led, both themes, 48px targets on primary controls acceptable at md on desktop portal, empty states for no-categories and empty-category. Zero em-dashes.
- Add a "View public page" link (to `/b/{slug}`) in the menu header when the business has a slug.

**Steps:**
- [ ] Failing product-form test (required fields, price parse). Build components + page.
- [ ] Gates + curl `/business/menu` (needs auth; assert redirect for anon, and 200 shape via build). Commit: `feat(menu): business portal menu management`

---

### Task 5: consumer public business page /b/[slug]

**Files:** Create `src/app/(consumer)/b/[slug]/page.tsx`, `src/features/menu/components/public-menu.tsx`, `src/features/businesses/server/public-repo.ts` (public reads: getBusinessBySlug(slug), getPublicMenu(businessId) using an anon-capable server client - the normal server client works, RLS public-read policies apply for anon/auth alike). Test: public-menu renders categories/products, price-from.

**Binding:**
- `page.tsx`: `export const revalidate = 60`; `generateMetadata` from business name/description; load business by slug (active only via RLS public-read) - if null `notFound()`; load public menu; render header (logo/cover/name/type/city/description/hours summary) + `<PublicMenu>`. Coral-led consumer profile; both themes (consumer app is dual-theme, this is a consumer route - but it is public/ISR; keep it theme-aware via existing tokens, no light-lock).
- PublicMenu: categories in order, each with its active products (name, price-from = min(base, variant prices) via formatPeso, description, sold_out greyed styling, variant chips). Empty state if no menu yet ("This store has not added a menu yet.").
- Opening-hours summary: a small pure helper `formatHoursSummary(opening_hours jsonb)` -> "Open today until 22:00" or "Hours not set" (keep simple; TDD lightly).
- Wire the business dashboard "View public page" link target here.

**Steps:**
- [ ] Failing public-menu test. Build repo + components + page.
- [ ] Gates + curl `/b/<nonexistent>` -> 404; build shows the dynamic route. Commit: `feat(menu): public consumer business page with live menu`

---

### Task 6 (controller): live E2E + final review + merge

- [ ] Using the seeded E2E owner (giya.e2e.owner@gmail.com) or a fresh login, drive `/business/menu`: create a category, a product with a variant + addon; verify rows land via MCP query (RLS-scoped correctness). Set business status active via MCP (activate the E2E business) and load `/b/{slug}` anon (fresh browser context / no cookies) to confirm public read renders the menu; confirm a hidden product does not appear publicly; confirm a second account cannot mutate the first's menu (MCP simulated-claims check).
- [ ] Sweep: gates, em-dash scan, both themes screenshot of /business/menu and /b/[slug].
- [ ] Final whole-branch review (most capable model), fix wave, merge per finishing-a-development-branch. Update ledger; note any debt.
