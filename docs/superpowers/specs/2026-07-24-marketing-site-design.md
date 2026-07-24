# Giya Marketing Site - Design Spec

**Date:** 2026-07-24
**Status:** Approved in brainstorming; ready for implementation planning
**Depends on:** `2026-07-24-giya-design-system-design.md` (tokens, components, brand) - the marketing site consumes that system; it introduces no new tokens.

## 1. Problem & Goal

The app root currently redirects into the consumer PWA; there is no public website. Build the marketing site in the same Next.js app: an appealing landing page with clear paths for consumers and businesses, a business pitch page, and draft legal pages (privacy, terms).

## 2. Structure (approved: Approach A)

New `(marketing)` route group with a shared layout (top nav + footer):

| Route | Page |
|---|---|
| `/` | Landing page (root redirect removed) |
| `/business` | Business pitch + "Join the pilot" mailto CTA |
| `/privacy` | Privacy policy (draft, RA 10173-aware) |
| `/terms` | Terms of service (draft) |

The consumer PWA keeps `/home`, `/wallet`, `/rewards`, `/profile`, `/scan`; manifest `start_url` stays `/home`.

**CTA targets (approved):** consumer CTA "Open Giya" -> `/home`; business CTA -> `/business`, whose conversion action is a "Join the pilot" `mailto:teamocsph@gmail.com` link (no fake signup while auth does not exist).

## 3. Visual direction (approved)

Warm light, brand-forward: one light theme for the whole marketing site (`.light`-forced surfaces; marketing pages do not flip with system dark mode - theme lock per page). Coral leads; teal owns the business band and `/business` accents; mango stays reward-language only. Geist Sans on the MD3 type scale; Geist Mono for figures. Design-taste dials: variance 7, motion 5, density 3.

**Imagery policy:** the product is the visual. Hero and section visuals are REAL component previews (phone frame rendering the actual Card/Badge/Logo/BottomNav components) - never div-fake screenshots of invented UI, no stock photography in v1.

## 4. Landing page (`/`) - 9 sections, varied layout families

1. **Nav** - <=72px, one line: lockup left; How it works, For businesses, FAQ anchors; "Open Giya" filled button. Mobile: hamburger sheet (only client island besides FAQ + motion).
2. **Hero - asymmetric split** - left: headline "Your receipts are worth something." + subtext (<=20 words) + primary "Open Giya" + secondary "For businesses" (text/outlined; distinct intent from nav CTA is allowed because it is the same intent as the business band CTA -> use ONE label "For businesses" everywhere). Right: phone-frame component preview (points Card, stamp Logo, real BottomNav strip).
3. **How it works** - vertical 3-step flow (Scan -> Earn -> Redeem), numbered with a connecting line, each step paired with a small real-component fragment. Not three equal cards.
4. **For consumers** - benefits (one wallet for every suki card, points that do not get lost, rewards worth claiming) with mango reward moments; scroll-reveal stagger.
5. **For businesses - teal band** - full-width tinted section: enterprise CRM at SME price, no POS integration needed; CTA "For businesses" -> `/business`.
6. **Trust strip** - quiet, factual: fraud-checked scans, PH Data Privacy Act (RA 10173) compliance posture, points ledger integrity.
7. **FAQ** - accordion (5 questions: what is Giya, does it cost anything, how do I earn, what businesses can join, is my data safe).
8. **Final CTA band** - coral surface, "Open Giya".
9. **Footer** - lockup, columns: Product (app, business), Legal (privacy, terms), Contact (teamocsph@gmail.com); copyright line.

Copy register: plain, warm, no filler verbs, no em-dashes, no AI-tell phrases. Max 1 eyebrow per 3 sections.

## 5. `/business` page

Teal-accented hero ("Know your customers. Keep them coming back."), 4 value props (campaign engine, points and rewards, customer intelligence, zero hardware), "How the pilot works" 3-step, "Join the pilot" mailto CTA (subject prefilled), shared footer. Same light theme.

## 6. Legal pages

`/privacy` and `/terms`: prose layout (max-width 65ch, MD3 type scale), each opening with a visible notice: "Draft for review. This document has not yet been reviewed by counsel." and an "Effective date: to be set at launch" line. Content drafted from `docs/10-architecture/15-security.md` privacy commitments: what we collect (account, receipts, device), why, consent and marketing opt-in separation, consumer rights (access, correction, deletion), retention, no sale of personal data, fraud-prevention processing, NPC/RA 10173 references, contact email. Terms: service description, accounts, acceptable use (no fraudulent receipts), points-are-not-money clause, business participation, liability limits, governing law (Philippines), changes to terms.

## 7. Motion & accessibility

Motion library (`motion/react`): hero entrance + `whileInView` reveal staggers only; every animation gated by `useReducedMotion`/`motion-reduce`. WCAG AA contrast; nav and accordion keyboard-accessible; focus-visible rings per design system. Landing passes the design-taste pre-flight checklist (theme lock, no em-dashes, eyebrow cap, CTA intent uniqueness, hero discipline: <=2-line headline, <=20-word subtext, <=4 text elements).

## 8. Out of scope

Real signup/auth flows, waitlist database, blog, SEO beyond sane metadata (title/description/OG tags per page), photography, dark-mode marketing variant, i18n (English v1; Filipino later).

## 9. Success criteria

1. `/` renders the 9-section landing; root no longer redirects.
2. Both CTA paths work: Open Giya -> `/home`; For businesses -> `/business` -> mailto pilot CTA.
3. `/privacy` and `/terms` render complete draft content with the review notice.
4. Lint/test/build green; landing verified visually at mobile and desktop widths.
5. No design-taste pre-flight violations (spot-check: em-dashes, eyebrow count, hero discipline, one accent per section family).
