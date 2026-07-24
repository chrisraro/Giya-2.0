# 02 — Phased Roadmap: MVP → V1 → SCALE

## Phase philosophy

Architectural depth is never phased — the schema, tenancy model, ledger design, and queue architecture ship enterprise-grade in MVP. Feature breadth is phased. Tags used across all docs:

- **[MVP]** — required for first paying-quality launch (pilot cohort of businesses in 1–2 cities).
- **[V1]** — required to call the platform generally available.
- **[SCALE]** — built when metrics demand it; designed-for now.

A feature's tag lives in its module doc; this file is the cross-cutting summary and build order. Conflicts resolve in favor of this file.

## Phase 0 — Foundations (weeks, not months)

Everything else depends on this being right.

- Repo scaffold per `14-development-standards.md` (Next.js 15, TS strict, ESLint/Prettier/Husky, CI).
- Supabase project: full schema migration set from `20-data/` (all domains, even ones without UI yet), RLS policies, generated types.
- Auth: email + Google OAuth, session management, role resolution, JWT claims (`12-multi-tenancy-rls.md`).
- API conventions implemented once as shared lib: envelope, errors, pagination, rate limiting, idempotency (`13-api-standards.md`).
- Upstash Redis + queue skeleton with one working queue end-to-end (`39-background-jobs.md`).
- Sentry + OpenTelemetry + Vercel Analytics wired (`52-monitoring-observability.md`).
- Storage buckets created with policies (`15-security.md`).

**Exit criteria:** a developer can clone, migrate, seed, and run E2E auth + one queued job locally and in staging. RLS test suite green.

## Phase 1 — [MVP] The receipt-to-reward loop

The single loop that proves the product: *business creates program → consumer scans receipt → points awarded → reward redeemed at counter.*

| Area | MVP scope |
|---|---|
| Business onboarding | Registration, profile, PH verification docs upload, admin verification queue |
| Business portal | Dashboard (basic KPIs), menu management (categories/products/pricing/images), receipt template upload + OCR test |
| Campaign engine | Campaign types: `loyalty`, `reward`, `promotion`. Create/schedule/pause/archive |
| Points engine | Formula rules (amount-based, visit-based), append-only ledger, balances, expiry dates set (enforcement job V1) |
| Rewards | Catalog, points redemption, reward QR generation, staff-side validation via owner/manager login |
| Consumer PWA | Auth, home (nearby/featured), business page (store/menu/rewards/promos), receipt scanner (camera/gallery/crop), points wallet, rewards wallet, basic loyalty card |
| OCR pipeline | Full ingest→preprocess→OCR→parse→match→award pipeline with human review queue for low confidence |
| Fraud v1 | Exact duplicate (image hash), receipt-number + merchant uniqueness, per-consumer velocity caps |
| Admin portal | Verification queue, user/business lookup, suspension, receipt review queue, audit log viewer |
| Notifications | Push (FCM) + in-app inbox for: points awarded, reward claimed, receipt rejected |
| Security | Everything in `15-security.md` marked MVP — RLS, rate limits, signed URLs, audit logs |

**Explicitly not in MVP:** email marketing sends, AI assistant, RAG, campaign suggestions, Facebook/Instagram connections, reviews, referral/birthday/event campaign types, staff role, exports, Tremor-heavy analytics (basic charts only), offline mode beyond app-shell caching.

**Exit criteria:** 20+ verified pilot businesses; scan→award p95 < 60s; ≥70% receipts auto-approved; fraud leak < 1%; zero cross-tenant data access findings in RLS audit.

## Phase 2 — [V1] The engagement platform

Deepens both sides of the marketplace.

| Area | V1 additions |
|---|---|
| Campaign engine | Remaining types: `discount`, `referral`, `birthday`, `seasonal`, `holiday`, `event`, `membership`. Targeting by segment. Campaign QRs |
| Points engine | Time-window multipliers (Friday double, lunch hours), birthday multiplier, expiry enforcement job, clawbacks |
| Loyalty | Digital stamp cards with animations, multi-program support per business |
| Consumer PWA | Discover (search/filters/map), favorites, reviews (ratings/comments/photos), notification preferences, receipt history detail |
| AI platform | RAG over business knowledge (menus, promos, hours, FAQs, policies); consumer AI assistant; embedding pipeline; prompt registry |
| Fraud v2 | OCR-similarity near-duplicates, cross-consumer duplicate rings, GPS plausibility (optional), AI confidence scoring |
| Business portal | Customer segments (VIP/blacklist), push campaign composer, campaign scheduler, analytics v2 (retention, top products, campaign performance), staff role + invitations, activity logs |
| Marketing | Email campaigns (Resend), scheduled sends, per-campaign performance |
| Admin portal | CMS (announcements/banners/FAQs/categories/cities), feature flags UI, AI/OCR monitoring dashboards, reports with export queue |
| PWA | Offline receipt queue + background sync, offline wallet/reward viewing, installability polish |
| Platform | Facebook OAuth login, support admin role, device management UI |

**Exit criteria:** scan auto-approval ≥85%; WASC growth ≥10%/mo across 2 consecutive months; AI assistant answer accuracy ≥95% on golden set; support ticket rate < 2% of WAU.

## Phase 3 — [SCALE] The intelligent platform

Built when volume justifies; architecture already accommodates.

- **AI analytics:** campaign suggestions, best-time-to-promote, customer/sales trend narratives (`38-ai-rag-platform.md`).
- **Monetization:** plan tiers, PayMongo billing, entitlement enforcement, usage metering.
- **Marketing:** Meta/IG content publishing, lookalike-style segment expansion, marketing automation journeys.
- **Ops at scale:** read replicas, table partitioning for `points_transactions`/`receipts`/`audit_logs` (designed in `20-data/20`), pgvector index tuning or dedicated vector strategy, multi-region CDN posture, self-hosted vLLM inference if Groq economics demand.
- **Verticals:** reservations, ordering, POS integrations (receipt source adapter), ownership transfer, franchising/multi-branch hierarchy.
- **Consumer:** cross-business discovery feeds, trending algorithm v2, personalized recommendations from embeddings.

## Build order inside Phase 1 (dependency chain)

```
0. Foundations
1. Auth + tenancy + roles            (everything depends on identity)
2. Business onboarding + verification (need real tenants)
3. Menu + business profile            (content for consumer app)
4. Campaign + points + rewards engine (core domain, pure logic first, TDD)
5. Consumer PWA shell + business pages
6. Receipt pipeline (template → OCR → match → award) + fraud v1
7. Wallets + redemption + staff validation
8. Notifications + admin queues
9. Pilot hardening (RLS audit, load test, golden OCR set)
```

## Rewrite-avoidance checklist

Decisions locked now so SCALE never forces a rewrite — the details live in the linked docs:

- UUIDv7 keys, audit fields, soft deletes everywhere → `20-data/20-data-model.md`
- `business_id` denormalized onto every tenant-scoped row (partition + RLS key) → `12-multi-tenancy-rls.md`
- Append-only ledger with derived balances → `35-points-engine.md`
- All heavy work behind queues; workers stateless → `39-background-jobs.md`
- API versioned `/api/v1` with envelope + cursor pagination → `13-api-standards.md`
- Receipt "source" abstraction (`scan` today; `pos`, `digital` later) → `36-receipt-ocr-pipeline.md`
- Campaign engine as data-driven rules, not code-per-type → `34-campaign-engine.md`
- Entitlement hooks in schema without billing logic → `21-schema-identity.md`
