# 01 — Personas, Roles & Permission Matrix

## User hierarchy

```
Platform
│
├── Platform Admin          (operates the marketplace)
│     ├── super_admin
│     ├── admin
│     └── support           [V1]
│
├── Business                (tenant)
│     ├── owner
│     ├── manager
│     ├── marketing
│     └── staff             [V1]
│
└── Consumer                (end user)
```

A single auth identity (`auth.users`) can hold multiple roles — e.g. a business owner is usually also a consumer. Role resolution is per-context: consumer surfaces read the consumer profile; business surfaces read the user's `business_staff` membership; admin surfaces require a `platform_admins` row. See `10-architecture/12-multi-tenancy-rls.md` for how this maps to JWT claims and RLS.

## Personas

### Consumer — "Mia", 24, Cebu
Orders milk tea 3×/week, keeps receipts in her bag, has 4 paper punch cards she keeps losing. Wants: one app for all her cards, visible progress, rewards that feel attainable, and answers ("what time does this branch close?") without messaging the page and waiting.
**Design consequences:** scan flow must complete in < 15 seconds of user effort; points/stamps must animate and feel immediate even while OCR settles asynchronously (optimistic "pending" state); AI assistant answers from business knowledge, never hallucinates hours or prices.

### Business Owner — "Ramon", 41, owns 2 milk-tea branches in Iloilo
No IT staff. Runs Facebook page himself. Knows regulars by face, not by data. Wants more repeat visits and to know whether promos actually work.
**Design consequences:** onboarding to first live campaign must be possible in one sitting; templates over blank forms; analytics in plain language ("Tuesdays are your slowest day — run a promo?"); verification requirements match PH reality (Mayor's Permit, DTI/SEC, TIN).

### Business Marketing — "Karla", 27, handles socials for a 5-branch chain
Lives in Meta Business Suite. Wants campaign scheduling, audience segments, and performance numbers she can screenshot for her boss.
**Design consequences:** marketing role has campaign + analytics powers but no staff management or verification/bank-level settings; campaign scheduler mirrors social-scheduler mental models.

### Platform Admin — "Ops", internal
Verifies businesses, watches fraud dashboards, manages CMS content, answers support escalations.
**Design consequences:** every admin action is audited; verification is a queue with document viewing (signed URLs), approve/reject/revision states, and history; fraud review queue is a first-class surface.

## Role definitions

### Platform roles (`platform_admins.role`)

| Role | Phase | Scope |
|---|---|---|
| `super_admin` | MVP | Everything, including managing other admins and feature flags |
| `admin` | MVP | Verification, moderation, CMS, reports, fraud review; cannot manage admins |
| `support` | V1 | Read-only user/business lookup, suspension *requests*, no destructive actions |

### Business roles (`business_staff.role`)

| Role | Phase | Scope |
|---|---|---|
| `owner` | MVP | Everything in the tenant incl. billing, staff, verification docs, danger zone |
| `manager` | MVP | Day-to-day: campaigns, menu, customers, reward fulfillment; no billing/staff-role changes/deletion |
| `marketing` | MVP | Campaigns, promotions, marketing sends, analytics; no menu/staff/settings |
| `staff` | V1 | Redemption validation (scan/verify reward QR), view daily dashboard; nothing else |

A business must have exactly one `owner` at all times (ownership transfer is an atomic swap, `[V1]`).

### Consumer

Consumers have no sub-roles. Per-business standing lives in `business_customers` (`segment`: e.g. `vip`, `blacklisted`) and affects earning/redemption within that business only.

## Permission matrix (canonical)

Legend: ✅ allowed · 🟡 allowed with constraint (see note) · ❌ denied. This matrix is enforced server-side (route guards + RLS); UI hiding is cosmetic, never the control.

| Capability | owner | manager | marketing | staff | consumer | admin | super_admin |
|---|---|---|---|---|---|---|---|
| **Business profile** |
| Edit profile/hours/gallery | ✅ | ✅ | ❌ | ❌ | ❌ | 🟡¹ | ✅ |
| Submit verification docs | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Approve/reject verification | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Staff** |
| Invite/remove staff | ✅ | 🟡² | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change staff roles | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Menu** |
| Manage categories/products | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Campaigns & points** |
| Create/edit campaigns | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Activate/pause campaigns | ✅ | ✅ | 🟡³ | ❌ | ❌ | 🟡⁴ | ✅ |
| Edit points rules | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Manual points adjustment | ✅ | 🟡⁵ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Rewards** |
| Manage reward catalog | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Validate redemption (QR) | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Claim/redeem rewards | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| **Customers** |
| View customer list/profiles | ✅ | ✅ | ✅ | ❌ | ❌ | 🟡¹ | ✅ |
| Segment (VIP/blacklist) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Marketing** |
| Send push/email campaigns | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Connect Meta/IG | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Receipts** |
| Scan/submit receipts | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Manage receipt templates | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Review flagged receipts (own biz) | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Analytics** |
| Business analytics | ✅ | ✅ | ✅ | 🟡⁶ | ❌ | 🟡¹ | ✅ |
| Platform analytics | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Platform** |
| CMS / announcements / banners | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Feature flags | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Suspend user/business | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Manage platform admins | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| View audit logs (own tenant) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

Notes:
1. Admin edits/views of tenant data are for support/moderation, always audited with reason.
2. Manager can invite `staff` role only, `[V1]`.
3. Marketing can activate campaigns it created; owner/manager approval required if campaign cost caps exceed plan limits `[SCALE]`.
4. Admin can pause (not activate) any campaign for policy violations.
5. Manager manual adjustments capped per day (configurable, default ±500 points/customer); owner uncapped within tenant.
6. Staff sees today's redemption counts only.

This matrix is mirrored in code at `src/lib/authz/permissions.ts` as a typed map; the table above is the source of truth.
