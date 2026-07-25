# Task 3 Report: money helper + menu schemas + service/repo/actions

## Status

Complete. All deliverables implemented, TDD'd, and green.

## Files

- `src/lib/money.ts` + `src/lib/money.test.ts` (21 tests)
- `src/features/menu/schemas.ts` (Zod: categorySchema, productSchema, variantSchema, addonSchema, availabilityWindowSchema, productStatusSchema, idSchema, productUpdateSchema + inferred types)
- `src/features/menu/types.ts` (Row DTOs re-exported from generated Supabase types, ActionResult<T>, ProductUpdatePatch)
- `src/features/menu/server/repo.ts` (only layer touching the Supabase client)
- `src/features/menu/server/service.ts` (thin orchestration + emitCatalogUpdated)
- `src/features/menu/actions.ts` ("use server": 12 actions + an extra setProductStatus helper)
- `src/features/menu/menu.test.ts` (51 tests: repo-level + action-level)

## TDD evidence

1. Wrote `src/lib/money.test.ts` first (21 cases: format, parse, symbol toggle, throws on non-integer/negative, round-trip both directions). Ran it against a nonexistent `money.ts` -> red (`Failed to resolve import "./money"`).
2. Implemented `money.ts` -> green, 21/21.
3. Wrote `schemas.ts`, then `repo.ts`/`service.ts`/`actions.ts`, then `menu.test.ts` (51 cases covering: `resolveOwnerBusiness` auth/membership resolution, list functions' scoping, the cascade behavior directly at the repo layer, and per-action arg validation/auth-gating/repo-call-shape through the full actions -> service -> repo -> mocked-supabase-client path). First run caught a real bug: my UUIDs in test fixtures (`11111111-1111-1111-1111-...`) didn't satisfy zod v4's stricter `.uuid()` regex (requires valid version/variant nibbles), correctly failing 13 tests before I fixed the fixtures to `...-4111-8111-...` form - confirms the schema validation is doing real work, not a rubber stamp.
4. Full suite: baseline 87 + money 21 + menu 51 = **159 passed**, `npx eslint` clean on new files, `npm run build` succeeds (Next 16 compiles + typechecks + prerenders all 24 routes).

## Child-cascade approach (one line)

`repo.archiveProduct`, `repo.setProductStatus('hidden')`, and `repo.updateProduct` (when its patch includes `status: 'hidden'`) all funnel through a shared `cascadeHideChildren(productId)` that sets `is_available = false` on the product's `product_variants`/`product_addons` rows in the same call, since those tables' public RLS select policies only check `is_available` + `deleted_at` and never look at the parent product's status/deleted_at; un-hiding never auto re-enables children (left to explicit variant/addon toggles).

## Architecture notes

- `resolveOwnerBusiness()` takes no business id from the client: it derives the caller's user id from `supabase.auth.getUser()` inside repo.ts, looks up their first `business_staff` row with `status = 'active'`, then loads that business's `{id, slug, name, status}`.
- `actions.ts` independently calls `getUser()` for the explicit "confirm session" gate (matching `identity/actions.ts`'s NOT_SIGNED_IN pattern) and separately calls `repo.resolveOwnerBusiness()` for business resolution; both share the same mocked/cookie-scoped Supabase client so this is not a real double-fetch of different data.
- `service.ts` never touches Supabase directly - it only calls repo functions and translates `{data, error}` into `{ok}` / `{ok:false, message}`, then fires `emitCatalogUpdated` (console.info + `// TODO(api): wire embeddings refresh job (doc 38)`) after every successful mutation.
- Added `setProductStatus` as an extra exported action (not in the UI's literal 12-action list) since the brief's repo/service deliverables explicitly call for a dedicated `setProductStatus` with cascade; it's wired up for a future hide/unhide quick-action and exercises the identical cascade path as `updateProduct`.
- `ProductUpdateInput`/`ProductUpdatePatch` types were introduced (rather than TS's `Partial<ProductInput>`) to satisfy `exactOptionalPropertyTypes: true` - zod's own `.partial()` inference and the generated Supabase `Update` row type both need to line up structurally with what gets passed to `.update()`.

## Gates

- `npx vitest run`: 19 test files, 159 passed.
- `npx eslint` on new files: clean.
- `npx tsc --noEmit`: no errors in any menu/money file (3 pre-existing unrelated errors in `scripts/generate-md3-tokens.test.ts` and two component test files predate this branch/task, confirmed via `git stash`).
- `npm run build`: compiles, typechecks, and prerenders successfully.

## Concerns / follow-ups for later tasks

- `listCategories`/`listProducts`/`listVariants`/`listAddons` are implemented but not yet wired to any server action or page - they exist for the (presumably upcoming) menu-builder UI task to consume.
- `emitCatalogUpdated` is a stub per spec; the embeddings-refresh wiring is explicitly deferred (doc 38 TODO).
- `supabase/migrations/0007_catalog.sql` showed as modified in git status before this task started (an unrelated doc-22 `sold_out` public-read RLS fix); it was left untouched here and has since been committed separately (`f567a14 fix(menu): sold_out products are publicly readable (doc 22 greyed-out state)`), out of scope for this task.
- This report file previously held content from an unrelated earlier task-numbering scheme ("Supabase clients, validated env, session middleware" on the auth-slice plan). Overwritten per instructions since the same `task-3-report.md` path is reused per-feature-plan; flagging in case that collision is unintentional.
