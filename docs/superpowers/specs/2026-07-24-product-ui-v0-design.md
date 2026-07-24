# Giya Product UI v0 (Mock Data) - Design Spec

**Date:** 2026-07-24
**Status:** Approved in brainstorming; ready for implementation planning
**Depends on:** design-system spec (tokens/components) and marketing-site spec (nav/footer, /business page). No backend: all data is mock; all auth is stubbed with `// TODO(auth): wire Supabase` markers.

## 1. Goal

Make the product demoable end to end without a backend: a consumer marketing page, auth screens, onboarding for both user types, a real-feeling consumer app on mock data, and a responsive business dashboard shell.

## 2. Routes

| Route | Group | Page |
|---|---|---|
| `/consumers` | (marketing) | Consumer pitch page |
| `/login`, `/signup` | (auth) | Sign in / sign up, email + Google + Facebook (stubs) |
| `/onboarding` | (auth) | Consumer onboarding, 4 steps |
| `/business/onboarding` | (business) | Business onboarding wizard, 3 steps |
| `/business/dashboard` | (business) | Dashboard shell |
| `/home`, `/wallet`, `/rewards`, `/profile` | (consumer) | Built out with mock data (`/scan` stays placeholder) |

Stub routing: signup role choice "Earn rewards" -> `/onboarding`; "Grow my business" -> `/business/onboarding`. Login -> `/home` (consumer default); a small text link "Business sign in" routes to `/business/dashboard`. No real sessions; navigation is direct.

## 3. Auth screens

Centered card (`max-w-md`) on warm surface with the mark above; MD3 TextFields (email, password with visibility toggle); client-side validation states only; primary filled Button full-width; divider "or continue with"; **Google and Facebook** outlined buttons with real brand marks (inline SVG paths); footer links (login <-> signup, Terms/Privacy links). Signup adds the role selector (two selectable cards: consumer / business) before the form. All submit handlers are stubs that navigate per section 2. Both themes; mobile-first.

## 4. Onboarding

**Consumer (`/onboarding`)**: full-screen stepper, progress dots, Back/Continue (48px), skippable ("Skip for now" -> `/home`). Steps: (1) Welcome - value recap + illustration from brand components; (2) Your city - searchable list of PH cities (mock: Cebu, Manila, Davao, Iloilo, Baguio, Cagayan de Oro); (3) What you love - multi-select food-type chips (Milk tea, Coffee, Bakery, Samgyupsal, Fast food, Desserts, Silog, Ramen); (4) Notifications - opt-in toggle explanation. Finish -> `/home`. Springy step transitions (Motion), reduced-motion collapses to instant.

**Business (`/business/onboarding`)**: 3-step wizard with numbered progress header. (1) Business basics - name, business type select (Cafe, Restaurant, Bakery, Retail, Grocery, Other), city; (2) Location and hours - address field, simple open/close time inputs per day-group (weekdays/weekends); (3) Verification documents - upload dropzone UI (stub, lists chosen file names client-side; Mayor's Permit, DTI/SEC, valid ID) with copy explaining review takes days. Finish -> `/business/dashboard` which shows a "Verification pending" banner.

## 5. Consumer app (mock data)

Shared mock module `src/lib/mock/consumer.ts` exports typed constants (businesses, balances, transactions, rewards, loyalty cards) so screens stay consistent.

- **Home**: greeting ("Magandang umaga, Mia"), total-points hero Card (coral container, mono figure), horizontal scroll-snap loyalty strip (stamp progress per business), "Near you" section (business Cards: name, type, distance, points rate). Uses the app's expressive profile.
- **Wallet**: per-business balance list (Card rows with mono points), transaction history (earn/redeem entries with signed mono amounts; mango only on positive earn figures).
- **Rewards**: claimable reward cards (image-less: tonal panels with reward name, points cost in Badge, claim Button disabled-stub), "Claimed" section with QR placeholder state.
- **Profile**: avatar circle (initials), name/city, settings list rows (notifications, devices, privacy policy link, terms link, log out stub).

## 6. Business dashboard shell

`(business)` group layout: **desktop >= 1024px**: fixed left sidebar (72-260px, logo, nav items Dashboard/Campaigns/Menu/Customers/Rewards/Settings with Material Symbols, active state pill), topbar (page title, theme toggle, avatar). **Mobile**: sidebar becomes a drawer (hamburger in topbar); content single-column. Teal-led productive profile, denser spacing, both themes.

**Dashboard page**: verification-pending banner (dismiss stub); 4 KPI cards (Visits this week 128, Points issued 4,320, Redemptions 37, New customers 24; mono figures, delta captions); "Visits this week" SVG bar chart (7 bars, token colors, no chart lib yet); recent activity list (mock scans/redemptions). Other sidebar destinations route to a shared "coming soon" stub page (one component, real layout).

## 7. Constraints (inherited + specific)

Tokens only; mango = rewards only; teal leads business surfaces; MD3 shape rules; 48px touch targets on consumer/auth/onboarding; both themes everywhere except marketing (light-locked); reduced-motion gates; zero em-dashes; skeleton/empty states where a list could be empty (wallet transactions, activity list); Conventional Commits scope `product`.

## 8. Out of scope

Real auth/sessions/Supabase, camera scan flow, real charts (Tremor later), form persistence, i18n, business portal pages beyond dashboard + onboarding + stubs.

## 9. Success criteria

1. Every route in section 2 renders and is navigable end to end (signup -> onboarding -> app/dashboard) on mock data.
2. Business dashboard: sidebar on desktop, drawer on mobile, verified visually at 390px and 1280px in both themes.
3. Consumer app screens show real (mock) content with loading-skeleton-ready structure and designed empty states.
4. Auth pages present Google/Facebook options with real brand marks; all stubs marked `TODO(auth)`.
5. Gates green; visual pre-flight passes (em-dash zero, mango scoping, touch targets).
