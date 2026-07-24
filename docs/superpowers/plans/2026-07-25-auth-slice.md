# Giya Auth Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-25-auth-slice-design.md`: identity schema + RLS + claims on Supabase project `dcnpuvtbftpbcjcvfnlt`, wired auth and onboarding.

**Architecture:** Migrations are authored as files (source of truth: docs 20/21/26/12; the spec lists deviations) and applied by the CONTROLLER via the Supabase MCP server. App wiring uses `@supabase/ssr` with browser/server/middleware clients; middleware stays claims-only.

**Tech Stack:** existing + `@supabase/supabase-js`, `@supabase/ssr`, `zod`.

## Global Constraints

- The canonical docs govern DDL details: `docs/20-data/20-data-model.md` (conventions), `21-schema-identity.md` (every table, column, index, and its RLS pattern assignment), `26-schema-amendments.md` (ONLY the [MVP]-accepted identity deltas), `docs/10-architecture/12-multi-tenancy-rls.md` (claims + policy SQL patterns). Implementers MUST read them before writing SQL. Where the plan and those docs conflict, the docs win except for the spec's named deviations (`private.uuid_generate_v7()` SQL implementation; `pgtap` extension added).
- Migrations: `supabase/migrations/{0001,0002,0003}_*.sql`, forward-only, idempotent-safe to re-run where cheap (`create ... if not exists` for extensions/schema only; tables plain `create table`). NEVER apply migrations yourself (no MCP calls from implementers) - the controller applies.
- All functions `security definer` MUST pin `search_path`. RLS enabled on EVERY table; tables without client paths get deny-all (no policies) so only service role passes.
- App code: tokens-only styling rules still apply to any UI touched; zero em-dashes anywhere incl. comments; TS strict (no `any`); Conventional Commits scope `auth` (e.g. `feat(auth): ...`).
- Env access ONLY through `src/lib/env.ts` (Zod). Never import `process.env` elsewhere in app code.
- Branch `feat/auth-slice`; existing suite (30 tests) green every task.

---

### Task 1: Author migrations 0001-0003

**Files:**
- Create: `supabase/migrations/0001_foundations.sql`, `supabase/migrations/0002_identity.sql`, `supabase/migrations/0003_auth_plumbing.sql`
- Create: `supabase/tests/rls_identity_smoke.sql` (pgTAP)
- Create: `supabase/README.md` (how migrations are applied here: MCP now, CLI/CI later; the manual token-hook dashboard step with exact navigation)

**Binding requirements:**
- 0001: `create extension if not exists` for `pgcrypto, vector, pg_trgm, unaccent, pgtap`; `create schema if not exists private`; `private.uuid_generate_v7()` (standard SQL UUIDv7: unix-ms timestamp in the top 48 bits, version/variant bits set, random tail via `gen_random_bytes`); `private.touch_updated_at()`; the three claims helpers copied from doc 12 section "Claim helper functions" adjusted only as needed to compile (keep `stable`, keep the overflow fallback subquery).
- 0002: every table in doc 21 with the doc's columns/checks/indexes plus amendments A-list for identity ONLY (`profiles.birth_date_updated_at timestamptz`, `consumers.scan_blocked_until timestamptz`, `user_consents` table per doc 26). Conventions from doc 20: `id uuid primary key default private.uuid_generate_v7()`, `created_at/updated_at timestamptz not null default now()` + touch trigger, `created_by/updated_by uuid`, `deleted_at` where doc'd, text+check enums, FK indexes, `business_staff_one_owner` partial unique index, `businesses.search_tsv` generated + GIN, `businesses` name trigram GIN. RLS: enable on all; write the P1/P2/P3/P4 policies each table's doc section assigns (business_customers is P3; profiles/consumers/user_devices/user_consents P2; businesses public-read `status='active' and deleted_at is null` + staff-write; business_staff readable by same-tenant staff, writes service-role only for now; verifications/documents staff-read own tenant, writes service-role; platform_admins + ref tables P4 with public read on refs where doc'd). Seed inserts: `ref_cities` (Cebu, Manila, Davao, Iloilo, Baguio, Cagayan de Oro), `ref_business_types` (Cafe, Restaurant, Bakery, Retail, Grocery, Other).
- 0003: `private.handle_new_user()` + trigger `on auth.users after insert` (creates `profiles` (name from raw_user_meta_data->>'full_name', fallback email local-part) + `consumers` row with generated unique 8-char base32 `referral_code`); `private.register_business(p_name text, p_type text, p_city text, p_address text) returns uuid` security definer: inserts `businesses` (status 'draft', slug = slugified name + short random suffix for uniqueness) + `business_staff` owner row for `auth.uid()`, returns id, raises if caller unauthenticated; PLUS a thin `public.register_business` wrapper with the same signature calling the private function and `grant execute to authenticated` (the `private` schema is not exposed via PostgREST; the app calls the public wrapper via `supabase.rpc("register_business", ...)`), revoke from anon; `private.custom_access_token_hook(event jsonb) returns jsonb` per doc 12 claim shape (biz map from active business_staff rows capped at 20, `biz_overflow` flag, `is_platform_admin`/`admin_role` from platform_admins) + `grant execute ... to supabase_auth_admin` and `grant usage on schema private to supabase_auth_admin` (plus select grants the hook needs).
- pgTAP smoke: at minimum 8 assertions using `set local role authenticated` + `set local request.jwt.claims`: consumer sees own profile / not another's; anon sees zero draft businesses; staff-claimed user sees own business row; cross-tenant staff read returns zero; `register_business` creates both rows; one-owner index rejects a second active owner.
- SQL style: lowercase keywords ok, but consistent; every `security definer` has `set search_path = ''` (fully-qualify objects) or pinned explicit schemas.

**Steps:**
- [ ] Read docs 20, 21, 26 (identity deltas only), 12 fully. Author 0001, 0002, 0003, the pgTAP file, and the README.
- [ ] Self-check: mentally execute FK ordering; grep your SQL for `search_path` on every definer fn; confirm every table has `alter table ... enable row level security`.
- [ ] `npm test` still green (no app code touched). Commit: `feat(auth): identity migrations, RLS policies, claims hook (authored)`

---

### Task 2 (controller): Apply migrations + verify + types

- [ ] MCP `list_tables` (baseline empty) -> `apply_migration` x3 in order; on error: fix-forward by editing the failing file BEFORE first successful apply is recorded (files not yet applied may be edited; applied ones never).
- [ ] Run `supabase/tests/rls_identity_smoke.sql` via `execute_sql`; all assertions pass.
- [ ] MCP `get_advisors` (security): resolve any ERROR-level findings on new objects (fix-forward migration if needed).
- [ ] MCP `generate_typescript_types` -> write `src/lib/supabase/types.ts`; `npm run build` green.
- [ ] Commit: `db(auth): apply identity migrations to dcnpuvtbftpbcjcvfnlt, generated types`

---

### Task 3: Supabase clients, env, middleware guards

**Files:**
- Create: `src/lib/env.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts`
- Create: `src/middleware.ts`
- Test: `src/lib/env.test.ts`

**Binding requirements:**
- `env.ts`: Zod schema `{ NEXT_PUBLIC_SUPABASE_URL: z.string().url(), NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20) }` parsed once, exported as `env`; throws at import with a readable message listing missing keys. Client-safe (only NEXT_PUBLIC keys).
- `client.ts`: `createBrowserClient<Database>` from `@supabase/ssr` using `env`. `server.ts`: `createServerClient<Database>` with Next cookies() adapter (async, per @supabase/ssr docs; `getAll`/`setAll` pattern). `middleware.ts` helper: `updateSession(request)` returning `{ response, user, claims }` using the documented @supabase/ssr middleware pattern (never modify cookies after copy; return the supabaseResponse as-is).
- `src/middleware.ts`: matcher excludes `_next/static`, `_next/image`, `favicon`, `brand/`, api workers none yet. Logic: always `updateSession`; if pathname starts with `/onboarding` or `/business/onboarding` and no user -> redirect `/login?next={pathname}`; if pathname starts with `/business/` excluding `/business/onboarding` AND excluding the PUBLIC marketing page `/business` (exact match) and no user -> same redirect; membership check for portal routes: claims `app_metadata.biz` non-empty OR `biz_overflow` true; if user but no membership -> redirect `/business/onboarding`. Keep it claims-only (no DB).
- Careful: `/business` (marketing) stays public; `/business/dashboard` etc. guarded. Exact-match logic must be tested by build + manual curl.

**Steps:**
- [ ] `npm i @supabase/supabase-js @supabase/ssr zod`
- [ ] Failing env test (missing vars -> throws listing names; valid vars -> parses). Implement. PASS.
- [ ] Build + curl checks: `/business` 200 anon; `/business/dashboard` redirects to `/login?next=...` anon; `/home` 200 anon.
- [ ] Commit: `feat(auth): supabase clients, validated env, session middleware with portal guards`

---

### Task 4: Wire auth screens + callback

**Files:**
- Modify: `src/app/(auth)/login/page.tsx`, `src/app/(auth)/signup/page.tsx`
- Create: `src/app/auth/callback/route.ts`, `src/components/auth/check-email.tsx`
- Modify: `src/components/auth/social-buttons.tsx` (accept an `onError(message)` reporting path if needed)
- Test: extend `src/components/auth/auth.test.tsx` (mock `@/lib/supabase/client`)

**Binding requirements:**
- Signup submit: `supabase.auth.signUp({ email, password, options: { data: { full_name, intended_role }, emailRedirectTo: `${location.origin}/auth/callback?next=` + (role === "business" ? "/business/onboarding" : "/onboarding") } })`. On success with `data.user && !data.session` (confirmation required) -> render `<CheckEmail email onResend />` state (copy: heading "Check your email", body mentions the address and spam folder, resend via `supabase.auth.resend`). On success WITH session (confirmation disabled) -> router.push(intended destination). Supabase errors -> `errorText` on the relevant field or a form-level error line (`role="alert"`).
- Login submit: `signInWithPassword`; success -> router.push(`next` search param if present and internal, else `/home`). Error -> form-level error "Email or password is incorrect." for invalid-credentials; other messages passed through safely.
- Social buttons: `signInWithOAuth({ provider, options: { redirectTo: `${location.origin}/auth/callback?next=...` } })`; catch/handle error by showing inline notice `${Provider} sign-in is not configured yet.` (Supabase returns "provider is not enabled"). Buttons keep identical visuals.
- `/auth/callback/route.ts`: exchange `code` (`exchangeCodeForSession`), then redirect to validated internal `next` (default `/home`); on error redirect `/login?error=confirm`.
- Login page shows a dismissible notice when `?error=confirm` present: "That link expired or was already used. Sign in or request a new one."
- All `TODO(auth)` markers in touched flows removed. Tests: existing ones keep passing with a mocked client module; add: signup submit calls signUp with intended_role for the selected role card (assert mock call args).

**Steps:**
- [ ] Update tests first (mock `@/lib/supabase/client` exporting `createClient` -> stub auth methods). RED for the new assertion, GREEN after wiring.
- [ ] Implement pages + callback + CheckEmail.
- [ ] Gates + curl `/auth/callback` (400/redirect ok anon), `/login`, `/signup`.
- [ ] Commit: `feat(auth): real signup, login, oauth stubs-to-live, email confirmation flow`

---

### Task 5: Onboarding persistence + role routing + real banner

**Files:**
- Modify: `src/app/(auth)/onboarding/page.tsx` (finish/skip save), `src/app/(business)/business/onboarding/page.tsx` (finish registers business)
- Create: `src/features/identity/actions.ts` (server actions: `completeConsumerOnboarding({ cityName, pushEnabled })`, `registerBusiness({ name, type, city, address })`)
- Modify: `src/components/business/verification-banner.tsx` + dashboard page (banner shows only when the user's business status is `draft` or `pending_verification`; server-fetch in the (portal) layout or dashboard page and pass down)
- Test: `src/features/identity/actions.test.ts` (pure arg-validation level with mocked server client)

**Binding requirements:**
- Server actions use the server client; `completeConsumerOnboarding` resolves `city_id` by name from `ref_cities` (unknown name -> null, still succeeds) and updates the caller's `consumers` row (`city_id`, `push_enabled`); returns `{ ok: true }` or `{ ok: false, message }`. `registerBusiness` calls the `private.register_business` RPC (`supabase.rpc("register_business", ...)` NOTE: RPC must be exposed - if `private` schema is not exposed via PostgREST, Task 1's 0003 must ALSO create a `public.register_business` wrapper with the same signature calling the private one; implementer of Task 1 handles this; this task consumes `public.register_business`).
- Consumer onboarding: Finish (and Skip AFTER step 1 if city chosen) calls the action; failures show a non-blocking inline error and still navigate (v0 tolerance, note in code comment).
- Business onboarding: Finish calls `registerBusiness`; on success -> `/business/dashboard`; on failure -> inline error, stay. The wizard's collected basics map to the action args; hours/documents remain client-only (`TODO(api)`).
- Dashboard banner: `(portal)/layout.tsx` (server) fetches the caller's first active membership business + status via server client; passes `businessStatus` to the page/banner; banner renders only for `draft`/`pending_verification`; copy unchanged.
- Remove obsolete `TODO(auth)` markers in touched code; keep `TODO(api)` for still-mocked data.

**Steps:**
- [ ] Tests for action arg validation (mocked client asserts update/rpc called with right args). RED -> GREEN.
- [ ] Wire pages + banner.
- [ ] Gates. Commit: `feat(auth): onboarding persistence, business registration, live verification banner`

---

### Task 6 (controller): Live E2E smoke + final review + merge

- [ ] Create a test user via the live signup UI (puppeteer, mailbox not needed): confirm the email via MCP `execute_sql` (`update auth.users set email_confirmed_at = now() where email = ...`), then complete consumer onboarding; verify `consumers.city_id` persisted via MCP query.
- [ ] Second test user -> business path -> registers business -> dashboard shows banner; verify `businesses` + `business_staff` rows via MCP; verify RLS: first user cannot select the second's business (execute_sql with simulated claims).
- [ ] Sweep: gates, em-dash scan, TODO(auth) markers gone from wired paths.
- [ ] Final whole-branch review (most capable model), fix wave, merge per finishing-a-development-branch. Document the manual dashboard steps for the user (token hook enable; optional: disable email confirmation for dev; add Google/FB provider keys).
