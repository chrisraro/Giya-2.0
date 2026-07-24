# Giya Auth Slice - Design Spec

**Date:** 2026-07-25
**Status:** Approved in brainstorming; ready for implementation planning
**Target project:** Supabase `dcnpuvtbftpbcjcvfnlt` (confirmed canonical for Giya 2.0). Migrations applied via the Supabase MCP server AND committed to `supabase/migrations/` (docs-and-schema-move-together rule).

## 1. Goal

Real accounts end to end: identity-domain schema with RLS and JWT claims per the canonical docs, Supabase Auth wired into the existing auth/onboarding screens, sessions in middleware, role-based routing. App content screens stay on mock data (next slice).

## 2. Database

Authority: `docs/20-data/20-data-model.md` (conventions), `21-schema-identity.md` (tables), `26-schema-amendments.md` (ratified deltas), `docs/10-architecture/12-multi-tenancy-rls.md` (RLS patterns + claims). The migrations implement those documents; where this spec is silent, the docs govern.

- **0001 foundations:** extensions `pgcrypto, vector, pg_trgm, unaccent, pgtap`; `private` schema; `private.uuid_generate_v7()` implemented in SQL (hosted Supabase has no `pg_uuidv7` extension - documented amendment, same time-ordered semantics); `private.touch_updated_at()` trigger fn; claims helpers `private.jwt_biz_role(uuid)`, `private.is_staff_of(uuid, text[])`, `private.is_admin()` exactly per doc 12.
- **0002 identity domain:** all tables of doc 21 + MVP-accepted amendments from doc 26 (`profiles.birth_date_updated_at`, `user_consents` table, `consumers.scan_blocked_until`): `profiles`, `consumers`, `platform_admins`, `businesses`, `business_staff`, `business_verifications`, `business_documents`, `business_customers`, `user_devices`, `user_consents`, `ref_cities`, `ref_business_types`, `ref_food_types`, `business_food_types`. Conventions per doc 20: UUIDv7 PKs, audit columns + touch triggers, soft-delete where doc'd, text+check enums, every FK indexed, `business_staff_one_owner` partial unique, `businesses` search_tsv generated column + GIN. RLS enabled on every table with the P1-P4 policies the docs assign; deny-all + service-role for tables without a client path. Seed `ref_cities` (the 6 onboarding cities) and `ref_business_types` (Cafe, Restaurant, Bakery, Retail, Grocery, Other).
- **0003 auth plumbing:** `private.handle_new_user()` trigger on `auth.users` insert creating `profiles` + `consumers`; `private.register_business(name, type, city, address)` SECURITY DEFINER RPC creating `businesses` (status `draft`) + owner `business_staff` row atomically, returning the business id; `private.custom_access_token_hook(jsonb)` stamping `app_metadata.biz` (membership map), `is_platform_admin`, `admin_role` per doc 12, with grants for `supabase_auth_admin`.
- **Manual dashboard step (user):** enable the Custom Access Token Hook (Auth -> Hooks -> Customize Access Token -> `private.custom_access_token_hook`). Documented in the plan output; until enabled, guards fall back to table lookups (the helpers already handle claim absence via the overflow path semantics: treat missing claim as table-lookup fallback).
- **Verification:** RLS smoke suite executed via MCP `execute_sql` (simulated JWT claims via `set request.jwt.claims`), covering: anon sees only active businesses; a consumer reads own profile not others; staff reads own-tenant rows only; cross-tenant access denied. Supabase security advisors checked after apply. TypeScript types generated to `src/lib/supabase/types.ts` and committed.

## 3. App wiring

- **Clients:** `@supabase/supabase-js` + `@supabase/ssr`: `src/lib/supabase/client.ts` (browser), `server.ts` (server components/actions, cookie-based), `middleware.ts` helper. `src/lib/env.ts` Zod-validates `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` at boot.
- **Middleware:** refreshes the session on all app routes; guards: `/business/dashboard` + portal stubs require session AND a `business_staff` membership claim (or table fallback); `/onboarding` + `/business/onboarding` require session; unauthenticated -> `/login?next=<path>`. Marketing + consumer browse stay public. Claims-only checks in middleware (<5ms budget); table fallback happens server-side in the portal layout, not middleware.
- **Auth flows:** signup (email/password + full name; role choice preserved in `user_metadata.intended_role`) -> Supabase signUp with `emailRedirectTo` -> "Check your email" state with resend; email confirm -> `/auth/callback` route handler exchanges the code -> redirects by intended role (consumer -> `/onboarding`, business -> `/business/onboarding`). Login -> password signIn -> redirect: platform default `/home`; if the user has any business membership, offer/route `/business/dashboard` ("Business sign in" link passes `next`). Logout (profile screen + topbar avatar menu later) -> signOut -> `/`. Google/Facebook buttons -> `signInWithOAuth` with the callback redirect; on provider-not-enabled error show inline notice "Google sign-in is not configured yet." Dev note documented: disable email confirmation in dashboard for faster local testing (or use the MCP-confirmed test users).
- **Onboarding persistence:** consumer onboarding saves `city_id` (matched from ref_cities) and `push_enabled` to `consumers` on finish (interests remain client-only; no schema column, correctly); business onboarding Finish calls `register_business` and routes to the dashboard; the verification banner and dashboard read the real `businesses.status` (draft -> banner "Finish verification" variant text stays as-is v0).
- All replaced stubs lose their `TODO(auth)` markers; data still mocked keeps `TODO(api)`.

## 4. Out of scope

Storage buckets, document upload persistence, verification submission flow, admin portal auth, MFA, device sessions UI, queue skeleton, API envelope lib, remaining schema domains (catalog/campaigns/receipts/platform), CI pgTAP matrix (tests are authored + run once via MCP; CI wiring later).

## 5. Success criteria

1. All three migrations applied to `dcnpuvtbftpbcjcvfnlt` AND committed; `supabase` MCP `list_tables` shows the identity domain; security advisors show no ERROR-level findings on the new objects.
2. RLS smoke suite passes (own-row access allowed, cross-tenant denied, anon restricted).
3. A real signup -> confirm -> onboarding -> `/home` path works against the live project; business path reaches the dashboard with a real `businesses` row (verified with a test account; MCP used to confirm the email).
4. Generated types committed; `npm run build`, lint, all tests green.
5. Google/Facebook buttons degrade gracefully until providers are configured.
