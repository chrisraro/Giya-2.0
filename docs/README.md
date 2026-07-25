# Giya — Product & Engineering Documentation

> **Giya** is an AI-powered Customer Relationship and Marketing Platform for food and retail SMEs in the Philippines. Loyalty, rewards, receipt OCR, AI-powered business knowledge, customer engagement, and campaign automation are capabilities of one unified platform — not isolated features.

**Blueprint version:** 1.0 · **Docs status:** development-ready · **Target scale:** 100,000+ businesses, millions of consumers, no rewrite required.

## How to use this documentation

- **Foundation first.** `00-product/` and `10-architecture/` contain the canonical decisions. Every other document defers to them. If a module doc conflicts with a foundation doc, the foundation doc wins and the module doc has a bug.
- **Schema is law.** `20-data/` contains the complete SQL DDL. All module docs reference these exact table and column names. Migrations are generated from these docs, then the docs are updated in the same PR as any migration.
- **Phasing.** Every feature is tagged `[MVP]`, `[V1]`, or `[SCALE]`. See `00-product/02-roadmap.md` for definitions and build order.

## Index

### 00-product — What we are building and why
| File | Contents |
|---|---|
| [00-vision.md](00-product/00-vision.md) | Product philosophy, positioning, non-goals, success metrics |
| [01-personas-roles.md](00-product/01-personas-roles.md) | User hierarchy, personas, role/permission matrix |
| [02-roadmap.md](00-product/02-roadmap.md) | Phase definitions (MVP → V1 → SCALE), build order, exit criteria |

### 10-architecture — How the system is shaped
| File | Contents |
|---|---|
| [10-system-architecture.md](10-architecture/10-system-architecture.md) | System diagram, request flows, queue architecture, scaling model |
| [11-tech-stack.md](10-architecture/11-tech-stack.md) | Every stack choice with rationale and rules-of-use |
| [12-multi-tenancy-rls.md](10-architecture/12-multi-tenancy-rls.md) | Tenant isolation model, RLS policy patterns, JWT claims design |
| [13-api-standards.md](10-architecture/13-api-standards.md) | Envelope, pagination, errors, idempotency, versioning |
| [14-development-standards.md](10-architecture/14-development-standards.md) | Repo layout, feature-first architecture, coding/DB/commit standards |
| [15-security.md](10-architecture/15-security.md) | Threat model, authn/authz, headers, rate limits, audit logging |
| [16-design-system.md](10-architecture/16-design-system.md) | Brand, MD3 token system, component registry, surface profiles, adaptive rules |

### 20-data — The canonical schema
| File | Contents |
|---|---|
| [20-data-model.md](20-data/20-data-model.md) | ERD overview, naming conventions, shared column standards, enum registry |
| [21-schema-identity.md](20-data/21-schema-identity.md) | Users, profiles, roles, businesses, verification, staff, devices |
| [22-schema-catalog.md](20-data/22-schema-catalog.md) | Categories, menus, products, variants, add-ons |
| [23-schema-campaigns.md](20-data/23-schema-campaigns.md) | Campaigns, promotions, rewards, loyalty programs, points ledger, redemptions |
| [24-schema-receipts-ai.md](20-data/24-schema-receipts-ai.md) | Receipt templates, receipts, OCR results, fraud signals, embeddings, AI chats |
| [25-schema-platform.md](20-data/25-schema-platform.md) | Notifications, favorites, reviews, CMS, settings, audit logs, feature flags |
| [26-schema-amendments.md](20-data/26-schema-amendments.md) | Ratified v1.1 amendments from module specs — canonical until merged into 21–25 |

### 30-modules — Development-ready module specs
| File | Contents |
|---|---|
| [30-platform-core.md](30-modules/30-platform-core.md) | Auth flows, profiles, notification service, CMS |
| [31-admin-portal.md](30-modules/31-admin-portal.md) | Platform admin: dashboards, verification, moderation, feature flags, reports |
| [32-business-portal.md](30-modules/32-business-portal.md) | Business dashboard, store/menu management, staff, customers, marketing |
| [33-consumer-pwa.md](30-modules/33-consumer-pwa.md) | Home/discover, business pages, scanner UX, wallets, loyalty cards, AI assistant |
| [34-campaign-engine.md](30-modules/34-campaign-engine.md) | **The heart of Giya.** Campaign model, lifecycle, targeting, scheduling |
| [35-points-engine.md](30-modules/35-points-engine.md) | Rule DSL, earning pipeline, ledger integrity, expiry, reversals, clawbacks |
| [36-receipt-ocr-pipeline.md](30-modules/36-receipt-ocr-pipeline.md) | Ingest → preprocess → OCR → parse → match → award pipeline, template system |
| [37-fraud-detection.md](30-modules/37-fraud-detection.md) | Duplicate detection, image hashing, velocity rules, review queue |
| [38-ai-rag-platform.md](30-modules/38-ai-rag-platform.md) | Embedding pipeline, retrieval design, assistant, prompt registry, cost controls |
| [39-background-jobs.md](30-modules/39-background-jobs.md) | Queue design, workers, retries, DLQs, scheduling, observability |
| [40-analytics.md](30-modules/40-analytics.md) | Event taxonomy, aggregation strategy, dashboard queries, CLV |
| [41-pwa-offline.md](30-modules/41-pwa-offline.md) | Service worker strategy, offline queues, background sync, conflict handling |
| [42-integrations.md](30-modules/42-integrations.md) | Meta/Google OAuth, Maps, FCM, Resend, PayMongo (future) |

### 50-ops — Running it
| File | Contents |
|---|---|
| [50-environments-deployment.md](50-ops/50-environments-deployment.md) | Environments, CI/CD, migration workflow, secrets, rollback |
| [51-testing-strategy.md](50-ops/51-testing-strategy.md) | Test pyramid, RLS tests, OCR golden sets, E2E, load testing |
| [52-monitoring-observability.md](50-ops/52-monitoring-observability.md) | Sentry, OpenTelemetry, SLOs, alerting, AI/OCR quality monitoring |
| [53-env-credentials-checklist.md](50-ops/53-env-credentials-checklist.md) | Every credential the app needs, what breaks without each, and the final-build handover list |

## Golden rules (summary)

1. **One backend.** Next.js Route Handlers + Server Actions only. No second backend framework, ever.
2. **Everything is a campaign.** Promotions, rewards, discounts, referrals, loyalty — all instances of one campaign model.
3. **The points ledger is append-only.** Balances are derived; corrections are new entries, never edits.
4. **RLS on every user-facing table.** Server-side authorization for every protected action, always, even when the UI already gates it.
5. **AI augments, never decides.** Low-confidence OCR and fraud flags go to human review. AI never irreversibly moves points or money on its own.
6. **Audit everything.** Every state change that matters lands in `audit_logs`.
7. **Soft delete by default** where data has business meaning. Hard delete only for `temp` data and where law requires it.
8. **Docs and schema move together.** A migration PR that doesn't update `20-data/` is incomplete.
