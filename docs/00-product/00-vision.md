# 00 — Vision & Positioning

## One-liner

Giya is an **AI-powered Customer Relationship and Marketing Platform** for food and retail SMEs — starting in the Philippines — that turns paper receipts into loyalty, loyalty into customer intelligence, and customer intelligence into automated marketing.

## Product philosophy

Build an **enterprise-grade architecture** that comfortably supports **100,000+ businesses and millions of consumers without a rewrite**. We ship in phases, but we never ship a schema, tenancy model, or API shape we'd have to throw away at scale. Cheap to run at 100 businesses, correct at 100,000.

Practical consequences of this philosophy:

- Tenancy, RLS, and the append-only points ledger are designed for the end-state on day one (`10-architecture/12`, `30-modules/35`).
- Feature *breadth* is phased (`00-product/02-roadmap.md`); architectural *depth* is not.
- Every capability is built as a platform primitive (campaigns, points, documents, queues), not a one-off feature, so reservations/ordering/POS/payments can be added later without redesign.

## What Giya is (capability stack)

One platform, six capabilities — not six products:

1. **Customer Relationship Platform (CRP)** — unified customer profiles per business: visits, spend, points, rewards, segments.
2. **Digital Loyalty Platform** — stamp cards, visit-based and spend-based programs, digital wallets.
3. **Rewards Platform** — points issuance, reward catalogs, redemption with inventory and expiry.
4. **Promotion Management Platform** — create, schedule, target, and measure promotions.
5. **Receipt Intelligence Platform** — OCR on physical receipts as the zero-integration bridge between offline purchases and digital loyalty. No POS integration required to start.
6. **Marketing Platform** — push/email campaigns, segmentation, AI-suggested campaigns and timing.

## Why receipts are the wedge

Philippine food & retail SMEs largely run on standalone POS or manual receipts. Competing loyalty products require POS integration or staff-driven point entry. Giya's wedge: **the consumer scans the receipt they already received.** This means:

- Zero hardware, zero POS integration, zero staff training to launch a business.
- Every scanned receipt is structured purchase data (items, amounts, time) — the raw material for the CRP and marketing layers.
- Fraud controls (`30-modules/37`) are therefore a core competency, not an afterthought.

## Who it serves

See `01-personas-roles.md`. In one line each:

- **Consumers** get one app for all their loyalty cards, points, and rewards — and an AI assistant that answers questions about any business on the platform.
- **Businesses** (owner → manager → marketing → staff) get an enterprise-grade CRM/marketing suite at SME price and SME simplicity.
- **Platform admins** operate marketplace quality: verification, fraud, content, health.

## Non-goals (v1.0)

Explicitly out of scope until the platform earns them (see roadmap for sequencing):

- **Not** a POS system. (Future integration target, not a product.)
- **Not** an ordering/delivery platform. (Future vertical.)
- **Not** a payments processor. (PayMongo integration is a future phase.)
- **Not** a social network. Reviews and favorites exist to serve discovery, not feeds.
- **No** blockchain/crypto points. Points are ledger entries in Postgres.
- **No** white-label per-business apps in v1. One consumer PWA; businesses are tenants inside it.

## Positioning statement

For food and retail SMEs that want repeat customers but can't afford enterprise CRM suites, Giya is a customer relationship platform that turns every paper receipt into loyalty data and automated marketing — unlike punch cards, generic loyalty apps, or POS-locked programs, Giya requires no hardware, no integration, and gives the business an AI marketing analyst out of the box.

## North-star & guardrail metrics

| Metric | Type | Definition |
|---|---|---|
| Weekly Active Scanning Consumers (WASC) | North star | Consumers who scan ≥1 valid receipt in a 7-day window |
| Verified active businesses | Growth | Verified businesses with ≥1 live campaign |
| Receipt scan success rate | Quality guardrail | % of submitted receipts auto-approved without human review (target ≥ 85% by V1) |
| Fraud leak rate | Trust guardrail | % of awarded points later clawed back for fraud (target < 0.5%) |
| Redemption rate | Engagement | Rewards redeemed ÷ rewards claimed |
| Business 90-day retention | Revenue guardrail | % of businesses still running campaigns 90 days after activation |
| AI cost per WASC | Cost guardrail | Groq + embedding + OCR compute per weekly active scanner |

## Business model (for architectural context)

Freemium SaaS for businesses (free tier → paid tiers by campaign volume, AI features, and analytics depth), free for consumers. Payments via PayMongo `[SCALE]`. The schema carries `plan`/entitlement hooks from day one (`21-schema-identity.md`) so monetization needs no migration — but billing enforcement logic is `[SCALE]`.

## Extension path (design-for, don't build)

The architecture must accept these later verticals without redesign: reservations, ordering, POS integrations, payments, additional retail verticals, multi-branch franchising. Each maps onto existing primitives: a reservation is an entity attached to a business + consumer; an order is a receipt born digital; a POS integration is a receipt source that skips OCR. This is the test for every design decision: *does it survive these extensions?*
