# Giya Product UI v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-24-product-ui-v0-design.md`: /consumers page, auth stubs, dual onboarding, mock-data consumer app, responsive business dashboard shell.

**Architecture:** All screens consume the existing design system. Mock data lives in typed modules under `src/lib/mock/`. Auth/onboarding/business surfaces are new route groups. Client components only where interactivity demands (forms, steppers, drawer, toggles). Implementers have layout latitude WITHIN the binding constraints below; every screen is visually reviewed.

**Tech Stack:** existing stack only (Next.js 16, Tailwind MD3 tokens, Motion, Material Symbols). No new dependencies.

## Global Constraints

- Tokens only (lint-enforced). Mango/tertiary = reward figures ONLY. Teal (secondary) leads business surfaces; coral (primary) leads consumer/auth surfaces.
- Shape rules: buttons/chips full; cards `rounded-md3-md`; sheets/dialogs/large panels `rounded-md3-xl`; text fields via the existing `TextField` component only.
- Both themes on all product surfaces (consumer, auth, onboarding, business). Marketing stays light-locked. Test both.
- 48px touch targets on consumer/auth/onboarding surfaces (`size="touch"`); business portal may use `size="md"` on desktop-only controls.
- Zero em-dash characters in any copy. Copy register: plain, warm, no filler verbs.
- Every stubbed behavior carries `// TODO(auth): wire Supabase` (auth/session) or `// TODO(api): replace mock` (data) comments.
- Motion: Motion library only, `useReducedMotion` gates; step transitions and reveals only, no scroll hijacks.
- Mobile-first: every screen must be explicitly correct at 390px and 1280px.
- All named exports and file paths in "Interfaces" blocks are binding contracts. Copy strings given in briefs are verbatim-binding; layout details not specified are implementer latitude (reviewed visually).
- Conventional Commits scope `product` (e.g. `feat(product): ...`); commit per task. Branch: `feat/product-ui`.
- Existing suite (14 tests) must stay green every task; each task adds the tests named in it.

---

### Task 1: Mock data + `/consumers` marketing page

**Files:**
- Create: `src/lib/mock/consumer.ts`, `src/lib/mock/business.ts`
- Create: `src/app/(marketing)/consumers/page.tsx`
- Modify: `src/components/marketing/footer.tsx` (add "For consumers" link to Product column)
- Test: `src/lib/mock/mock-data.test.ts`

**Interfaces (binding):**
- `src/lib/mock/consumer.ts` exports:
```ts
export type MockBusiness = { id: string; name: string; type: string; city: string; distanceKm: number; pointsRate: string };
export type MockBalance = { businessId: string; businessName: string; points: number; stampsEarned: number; stampsTarget: number; nextReward: string };
export type MockTransaction = { id: string; businessName: string; kind: "earn" | "redeem"; points: number; description: string; dateLabel: string };
export type MockReward = { id: string; businessName: string; name: string; pointsCost: number; status: "available" | "claimed" };
export const MOCK_USER: { name: string; firstName: string; city: string; initials: string };
export const MOCK_BUSINESSES: MockBusiness[];   // >= 4 entries
export const MOCK_BALANCES: MockBalance[];      // >= 3 entries (Kape Diaria 1250 pts, 3/5 stamps, "Free latte" must be one)
export const MOCK_TRANSACTIONS: MockTransaction[]; // >= 6, mix earn/redeem
export const MOCK_REWARDS: MockReward[];        // >= 4, mix available/claimed
```
- `src/lib/mock/business.ts` exports:
```ts
export type MockKpi = { label: string; value: string; delta: string };
export const MOCK_KPIS: MockKpi[]; // exactly: Visits this week "128" "+12% vs last week"; Points issued "4,320" "+8%"; Redemptions "37" "+5"; New customers "24" "+3"
export const MOCK_WEEK_VISITS: { day: string; value: number }[]; // Mon..Sun, values 12-28
export const MOCK_ACTIVITY: { id: string; icon: string; text: string; timeLabel: string }[]; // >= 5 mixed scans/redemptions
```
- Mock names must be PH-flavored and non-generic (e.g. Kape Diaria, Lola Nena's Bakeshop, Seoul Grill PH, Chill Cup Milk Tea, Tapsi ni Marco). No "Acme", no "John Doe". Consumer persona: Mia Santos, Cebu.
- `/consumers` page: coral-led hero (h1 "Every suki card, one app.", <=20-word subtext, CTA "Open Giya" -> /home), a benefits section (4 items: one wallet; points that do not get lost; rewards worth claiming; answers instantly), a reuse of `<PhonePreview />` in a "See it in action" split section, closing CTA band. Zero em-dashes; max 1 eyebrow; layout families must differ from adjacent sections.

**Steps:**
- [ ] Write failing test `src/lib/mock/mock-data.test.ts` asserting: MOCK_BALANCES contains a Kape Diaria entry with points 1250, stampsEarned 3, stampsTarget 5; MOCK_KPIS has 4 entries with the exact labels above; MOCK_WEEK_VISITS has 7 entries. Run -> FAIL.
- [ ] Create both mock modules -> test PASS.
- [ ] Build `/consumers` page + footer link.
- [ ] Gates (`npm test`, lint, build) + curl `/consumers` contains "Every suki card, one app."
- [ ] Commit: `feat(product): mock data modules and consumers marketing page`

---

### Task 2: Auth screens (`/login`, `/signup`) + social buttons

**Files:**
- Create: `src/app/(auth)/layout.tsx`, `src/app/(auth)/login/page.tsx`, `src/app/(auth)/signup/page.tsx`
- Create: `src/components/auth/auth-card.tsx`, `src/components/auth/social-buttons.tsx`, `src/components/auth/password-field.tsx`
- Test: `src/components/auth/auth.test.tsx`

**Interfaces (binding):**
- `(auth)/layout.tsx`: centers content on `bg-surface`, small `<Logo variant="lockup" />` (link to `/`) at top, `min-h-dvh`, works in both themes.
- `<AuthCard title subtitle children footer>`: `max-w-md` Card variant outlined, `rounded-md3-xl`, generous padding.
- `<SocialButtons onGoogle onFacebook />`: two full-width outlined buttons, 48px, real brand marks as inline SVGs (Google multicolor "G", Facebook "f" in #1877F2 - raw hex is banned in src/ by lint, so brand marks live as SVG files `public/brand/google.svg`, `public/brand/facebook.svg` rendered via `<img>` with empty alt; labels "Continue with Google" / "Continue with Facebook". Click handlers are the passed stubs.
- `<PasswordField id label>`: wraps TextField with a visibility toggle button (`aria-label` "Show password"/"Hide password", Material Symbol visibility/visibility_off).
- `/login`: email + PasswordField + "Sign in" filled touch Button (stub navigates `/home` via `router.push`; comment `// TODO(auth): wire Supabase`), SocialButtons (same stub), links: "New to Giya? Create an account" -> /signup, small text link "Business sign in" -> /business/dashboard, "Forgot password" text link (href="#" stub).
- `/signup`: role selector FIRST (two selectable cards, radio semantics: "Earn rewards" consumer / "Grow my business" business, consumer preselected), then name/email/PasswordField, "Create account" filled touch Button -> role === consumer ? `/onboarding` : `/business/onboarding`; SocialButtons follow role too. Legal line: "By continuing you agree to the Terms of Service and Privacy Policy." with links.
- Client validation states only (required, email format) using simple state + the TextField error slots; no form libraries.

**Steps:**
- [ ] Failing test: renders `/signup` role selector (both role labels present, radiogroup semantics), renders login CTA "Sign in", social buttons have accessible names "Continue with Google"/"Continue with Facebook". Run -> FAIL.
- [ ] Create brand SVGs + components + pages -> tests PASS.
- [ ] Gates + curl `/login` and `/signup`.
- [ ] Commit: `feat(product): auth screens with social sign-in stubs`

---

### Task 3: Consumer onboarding (`/onboarding`)

**Files:**
- Create: `src/app/(auth)/onboarding/page.tsx`, `src/components/auth/stepper.tsx`
- Test: `src/components/auth/stepper.test.tsx`

**Interfaces (binding):**
- `<Stepper steps activeIndex />`: progress dots (active = elongated pill `bg-primary`, inactive `bg-outline-variant`), `aria-label` "Step X of Y".
- Page is one client component managing step state. 4 steps per spec section 4 (Welcome / Your city / What you love / Notifications). Cities list and chip labels verbatim from the spec. Controls: Back (text button, hidden on step 1), Continue (filled touch), "Skip for now" (text, top-right, -> /home). Finish -> /home. Step transition: Motion slide/fade (reduced-motion: instant). City list: simple filter input + selectable rows (radio semantics). Chips: existing Chip component, multi-select. Notifications step: Switch-style toggle built from existing components or a styled checkbox with 48px target.
- Welcome step visual: composed from brand components (Logo stamp trio + copy), not an illustration file.

**Steps:**
- [ ] Failing Stepper test (renders 4 dots, marks active, aria-label). -> FAIL.
- [ ] Build Stepper + page -> PASS.
- [ ] Gates + curl `/onboarding`.
- [ ] Commit: `feat(product): consumer onboarding flow`

---

### Task 4: Business onboarding (`/business/onboarding`) + business layout shell

**Files:**
- Create: `src/app/(business)/layout.tsx` (minimal: just `min-h-dvh bg-surface`, dual-theme pass-through; the dashboard chrome comes in Task 6)
- Create: `src/app/(business)/business/onboarding/page.tsx`
- Create: `src/components/business/wizard-header.tsx`

**Interfaces (binding):**
- Route must resolve at `/business/onboarding` (group folder `(business)` containing `business/onboarding/page.tsx`).
- `<WizardHeader steps activeIndex />`: numbered progress (1 Basics, 2 Location & hours, 3 Verification), teal accents (`text-secondary`/`bg-secondary-container` on active), connector lines.
- 3 steps per spec section 4. Business types select options verbatim: Cafe, Restaurant, Bakery, Retail, Grocery, Other. Hours: two day-groups (Weekdays, Weekends) each with open/close `<input type="time">` styled to match TextField. Verification step: dropzone-look panel (dashed `border-outline`, upload icon, "Drag files or tap to choose", accepts click -> hidden file input, lists chosen file names client-side only) + three required-document rows (Mayor's Permit, DTI or SEC registration, Valid government ID) + copy: "We review documents within a few days. You can explore your dashboard while you wait." Finish button "Go to dashboard" -> `/business/dashboard`.
- All state client-side, nothing persisted; `// TODO(api): replace mock` markers.

**Steps:**
- [ ] Build layout + wizard (no new unit test; covered by build + visual review; existing suite green).
- [ ] Gates + curl `/business/onboarding`.
- [ ] Commit: `feat(product): business onboarding wizard`

---

### Task 5: Consumer app build-out (Home, Wallet, Rewards, Profile)

**Files:**
- Modify: `src/app/(consumer)/home/page.tsx`, `wallet/page.tsx`, `rewards/page.tsx`, `profile/page.tsx`
- Create: `src/components/consumer/loyalty-strip.tsx`, `src/components/consumer/business-card.tsx`, `src/components/consumer/empty-state.tsx`
- Test: `src/components/consumer/consumer-components.test.tsx`

**Interfaces (binding):**
- All data from `@/lib/mock/consumer`. Screens are server components; interactivity limited to links.
- `<LoyaltyStrip balances />`: horizontal scroll-snap row of per-business stamp cards (business name, `<Logo variant="stamp">` progress row filled/25%-opacity like PhonePreview, "X of Y", next-reward caption). Mango on stamps only.
- `<BusinessCard business />`: outlined Card row: name, type + city caption, distance chip (`{distanceKm} km`), points rate caption (e.g. "1 pt per P20").
- `<EmptyState icon title body action? />`: designed empty state (icon in tonal circle, title, body, optional Link button). Used on Rewards "Claimed" when empty and anywhere a mock list could be empty.
- Home: greeting "Magandang umaga, {firstName}" + date caption; total-points hero Card (`bg-primary-container`, mono total of MOCK_BALANCES points, caption "across {n} businesses"); LoyaltyStrip; "Near you" heading + BusinessCards list.
- Wallet: heading "Wallet"; balance Card rows (business name, mono points, chevron); "Activity" section listing MOCK_TRANSACTIONS (icon per kind, description, dateLabel; signed mono amount: earns `+N pts` in `text-on-tertiary-container` on `bg-tertiary-container` pill, redeems plain `-N pts`).
- Rewards: "Available" grid of reward Cards (name, businessName caption, Badge `{pointsCost} pts`, "Claim" tonal Button disabled with caption "Claiming opens after launch"); "Claimed" section from claimed mocks else EmptyState ("redeem" icon, "Nothing claimed yet", "Rewards you claim will appear here with their QR codes.").
- Profile: avatar circle (initials, `bg-secondary-container text-on-secondary-container`), name + city; settings list rows (Notifications, Devices, Privacy policy -> /privacy, Terms -> /terms, Log out) with Material Symbols and chevrons; Log out is a stub Link to `/login` with `// TODO(auth): wire Supabase`.
- Scan page: unchanged.

**Steps:**
- [ ] Failing tests: LoyaltyStrip renders "3 of 5" for Kape Diaria; BusinessCard renders name + "km"; EmptyState renders title+body. -> FAIL.
- [ ] Build components + 4 screens -> PASS.
- [ ] Gates + curl `/home` contains "Magandang umaga".
- [ ] Commit: `feat(product): consumer app screens on mock data`

---

### Task 6: Business dashboard shell + dashboard page

**Files:**
- Create: `src/components/business/sidebar.tsx`, `src/components/business/topbar.tsx`, `src/components/business/kpi-card.tsx`, `src/components/business/bar-chart.tsx`, `src/components/business/coming-soon.tsx`
- Create: `src/app/(business)/business/dashboard/page.tsx`
- Create: stub pages `src/app/(business)/business/{campaigns,menu,customers,rewards,settings}/page.tsx` (each renders `<ComingSoon title="...">`)
- Modify: `src/app/(business)/layout.tsx` (becomes the dashboard chrome for all /business/* EXCEPT onboarding keeps a chrome-free experience: implement chrome in a nested layout `src/app/(business)/business/(portal)/layout.tsx` and move dashboard+stubs under `(portal)`; onboarding stays outside it)
- Test: `src/components/business/business-components.test.tsx`

**Interfaces (binding):**
- Final route shape: `/business/onboarding` (chrome-free), `/business/dashboard` + 5 stubs (with chrome). Use nested group `(portal)` to achieve this; adjust paths accordingly.
- `<Sidebar />` (client): desktop `lg:` fixed left rail width 240px: lockup, nav items (Dashboard `space_dashboard`, Campaigns `campaign`, Menu `restaurant_menu`, Customers `group`, Rewards `redeem`, Settings `settings`) with active pill (`bg-secondary-container text-on-secondary-container`), `aria-current`. Mobile: hidden; a drawer variant slides in (Motion, reduced-motion instant) triggered from Topbar hamburger; scrim closes it; focus returns to trigger.
- `<Topbar title />` (client): sticky top, `bg-surface-container`, mobile hamburger (`aria-label` "Open navigation"), page title `text-title-l`, right side: `<ThemeToggle />` (reuse existing) + avatar circle "RD" (mock owner Ramon Dela Cruz).
- `<KpiCard kpi />`: `bg-surface-container-low` Card, label caption, `font-mono text-headline-s` value, delta caption in `text-secondary`.
- `<BarChart data ariaLabel />` (server, pure SVG): 7 bars from MOCK_WEEK_VISITS, `fill` uses `var(--md-sys-color-secondary)`, rounded tops, day labels `text-label-s`, `role="img"` + aria-label summarizing ("Visits per day this week, highest Saturday").
- Dashboard page: "Verification pending" banner (tonal `bg-tertiary-container`? NO - banner is informational, use `bg-secondary-container` with info icon; mango stays reward-only) with text "Your documents are under review. You can explore while you wait." + dismiss X (client stub); KPI grid (2x2 mobile, 4-up desktop); Card containing BarChart titled "Visits this week"; "Recent activity" list from MOCK_ACTIVITY (icon, text, timeLabel) with EmptyState fallback.
- `<ComingSoon title />`: centered panel (icon `construction`, title, body "This area arrives with the next milestone.", Link "Back to dashboard").

**Steps:**
- [ ] Failing tests: Sidebar renders 6 nav items with accessible names; KpiCard renders label+value; BarChart renders `role="img"` with aria-label. -> FAIL.
- [ ] Build chrome + pages -> PASS.
- [ ] Gates + curl `/business/dashboard` contains "Visits this week".
- [ ] Commit: `feat(product): business dashboard shell with responsive sidebar`

---

### Task 7 (controller): visual pre-flight + final review + merge

- [ ] Puppeteer sweep at 390px and 1280px, both themes where applicable: `/consumers`, `/login`, `/signup`, `/onboarding` (all steps), `/business/onboarding` (all steps), `/home`, `/wallet`, `/rewards`, `/profile`, `/business/dashboard` (+ drawer open state), one stub page.
- [ ] Mechanical checks: em-dash scan = 0; mango scoping (tertiary tokens only on reward figures/stamps/scan FAB); `TODO(auth)`/`TODO(api)` markers present; touch-target spot check.
- [ ] Gates; final whole-branch review (most capable model); one fix wave; merge per finishing-a-development-branch.
