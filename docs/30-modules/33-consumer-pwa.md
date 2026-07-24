# 33 — Consumer PWA

The consumer surface: discovery, business pages, the receipt scanner (the core loop), wallets, loyalty cards, reviews, notifications, and the AI assistant. Lives in `app/(consumer)` per `../10-architecture/10-system-architecture.md` D2. Stack rules (RSC-first, TanStack Query for server data, Zustand for UI state only, dynamic-import Maps, next-pwa) per `../10-architecture/11-tech-stack.md`. All endpoints follow `../10-architecture/13-api-standards.md` (envelope, cursor pagination, `Idempotency-Key`, error registry). Offline behavior is summarized per feature here; mechanics live in `41-pwa-offline.md`.

## Auth policy: browse without login

Discovery is public; participation requires auth. Concretely:

- **Public (no session):** home, discover, business pages (info/menu/promotions/rewards catalog/reviews read), CMS pages, banners. These render as Server Components with ISR (see caching below) and must never fetch user-scoped data.
- **Auth required:** scanning, wallets, claiming, loyalty cards, favorites, writing reviews, AI chat, notifications, profile. Guarded by middleware on the route group; API side re-enforces via `requireSession()` (`../10-architecture/13-api-standards.md` handler order).
- **Deferred-auth pattern:** tapping a gated action while logged out routes to `/login?next={route}` and, after auth, resumes the intended action (e.g. the favorite toggle fires on return). Email must be verified before first scan (`../10-architecture/15-security.md`).

## Route inventory — `app/(consumer)`

| Route | Auth | Phase | Purpose |
|---|---|---|---|
| `/` | public | MVP | Home: nearby, featured banners, categories; trending [V1]; recommended [SCALE] |
| `/discover` | public | V1 | Search + filters + map view + infinite results |
| `/b/[slug]` | public | MVP | Business page (info, menu, promos, rewards, loyalty) |
| `/b/[slug]/menu` | public | MVP | Full menu (also the menu-QR landing target) |
| `/b/[slug]/reviews` | public read / auth write | V1 | Review list + write/edit |
| `/b/[slug]/chat` | auth | V1 | AI assistant for this business |
| `/scan` | auth | MVP | Scanner (generic scan [V1]; `?business={id}` pre-bound from business page [MVP]) |
| `/scan/[receiptId]` | auth | MVP | Live processing status for one submission |
| `/receipts` | auth | MVP | Scan history list |
| `/receipts/[id]` | auth | V1 | Receipt detail (parsed fields, line items, points) |
| `/wallet` | auth | MVP | Points wallet: per-business balances |
| `/wallet/[businessId]` | auth | MVP | Transaction history + expiration for one business |
| `/rewards` | auth | MVP | Rewards wallet, tabbed by claim status |
| `/rewards/claims/[claimId]` | auth | MVP | Redemption QR screen |
| `/cards` | auth | MVP | Loyalty cards overview |
| `/cards/[cardId]` | auth | MVP | Single card progress + prize claim |
| `/favorites` | auth | V1 | Favorited businesses and rewards |
| `/notifications` | auth | MVP | In-app inbox |
| `/profile`, `/profile/settings`, `/profile/devices` | auth | MVP (devices UI V1) | Profile, preferences, device sessions |
| `/referral` | auth | V1 | Share referral code, see bonuses |
| `/(auth)/login`, `/register`, `/forgot-password` | public | MVP | Auth flows per `30-platform-core.md` |
| `/offline` | public | MVP | SW offline fallback document (`41-pwa-offline.md`) |

## Shared client conventions

- **Query keys** (registry `src/lib/query-keys.ts`, shape `[domain, entity, params]`): listed per screen below. Mutations invalidate by key; optimistic updates only where called out (favorites, review edit).
- **Zustand stores** (UI state only): `scannerStore` (capture → crop → compress → submit step machine, current image, bound `business_id`), `uiStore` (modals, install-prompt eligibility, push-priming dismissals). Server data never enters Zustand.
- **Standard states**, implemented once as shared components: skeletons for loading (never spinners on full pages), typed empty states with a single CTA, error states showing the envelope `error.message` verbatim (it is user-safe by contract) with a retry button, and `RATE_LIMITED` states honoring `Retry-After`.
- **Money/points:** centavos ints formatted client-side (`₱`), points as integers; dates rendered in `Asia/Manila`.

## Home (`/`)

Sections render as independent RSC fragments with Suspense boundaries so a slow section never blocks LCP.

| Section | Phase | Source | Query key (client refetch) |
|---|---|---|---|
| Featured banners | MVP | `banners` where `status='published'`, `audience in ('all','consumers')`, within `starts_at`/`ends_at`, ordered `sort` | RSC only (ISR) |
| Categories | MVP | `ref_business_types` where `is_active`, ordered `sort`; tap → `/discover?type={slug}` ([V1]) or filtered home list ([MVP]) | RSC only |
| Nearby | MVP | `GET /api/v1/businesses?near={lat},{lng}&radius_km=5` | `['businesses','nearby',{lat,lng,radius}]` |
| Trending | V1 | `GET /api/v1/businesses?sort=trending&city_id=…` | `['businesses','trending',{cityId}]` |
| Recommended | SCALE | embedding-based personalization (`38-ai-rag-platform.md`) | `['businesses','recommended']` |

**Nearby mechanics** (per the location note in `../20-data/21-schema-identity.md`): server filters `businesses` on `status='active'` with a bounding-box prefilter over `(lat, lng)` (uses `businesses_latlng_idx`), then Haversine-sorts and cuts to radius. No PostGIS. Cursor = `(distance_bucket, id)` — distance is stable per request coordinates.

**Permission UX:** never prompt for geolocation on load. Show a "See what's nearby" card; tap triggers `navigator.geolocation`. Denied → fall back to city picker persisted to `consumers.city_id` (also used when logged out via localStorage). Coordinates are used transiently for the query and are **not** stored (GPS storage exists only for opt-in receipt fraud checks, `consumers.gps_fraud_opt_in`).

**Trending score [V1]** — computed nightly by an analytics job (`40-analytics.md`), inputs from `analytics_daily_business` over a 7-day window with exponential decay (half-life 3 days):
`trend = 0.5·z(receipts_approved) + 0.3·z(rewards_claimed) + 0.2·z(favorites_added)` per business, z-scored within city. `favorites_added` is a proposed rollup column (see deltas). Score is cached in Redis (`{env}:discovery:trending:{city_id}`, TTL 24h) — not schema.

**States:** location undecided → city fallback list; zero nearby results → "No businesses near you yet" + link to browse all; each section has its own skeleton.

## Discover (`/discover`) [V1]

- **Search:** `GET /api/v1/businesses?q=…` — server combines `businesses.search_tsv` (websearch tsquery) with `businesses_name_trgm` trigram similarity for typo tolerance; product-name hits (`products.search_tsv`) surface the parent business. Debounced 300ms; min 2 chars. Key: `['businesses','search',{q,filters}]`.
- **Filters:** `city_id` (from `ref_cities`), `type` (`ref_business_types.slug`), `food_types` (`ref_food_types` via `business_food_types`), `open_now` (server evaluates `businesses.opening_hours` JSONB against `Asia/Manila` now — computed, not stored). Filters serialize to URL params (shareable/back-button safe).
- **Results:** cursor-paginated infinite scroll via `useInfiniteQuery`, `limit=25`, cursor per `../10-architecture/13-api-standards.md`.
- **Map view:** Google Maps per `../10-architecture/11-tech-stack.md` rules — component loaded via `next/dynamic` only when the map tab is opened; markers from the already-fetched result page (no separate Maps API queries); business coordinates come from `businesses.lat/lng` (geocoded once at business setup, never per view). Marker tap → bottom-sheet business card → `/b/[slug]`. Map view disabled offline.
- **States:** empty query → trending + categories; no results → "Nothing matched" with filter-clear CTA; map JS failure → list-only with notice.

## Business page (`/b/[slug]`)

RSC page, ISR-cached: `revalidate = 60` matching `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` from `../10-architecture/13-api-standards.md`; portal mutations call `revalidateTag('biz:{id}:menu')`-style tags. Only `active`-status businesses resolve; others 404. User-scoped overlays (balance, card progress, favorite state) hydrate client-side after paint so the public shell stays cacheable.

| Block | Phase | Data | Query key (user-scoped overlays only) |
|---|---|---|---|
| Header | MVP | `businesses`: `name, logo_url, cover_url, description, gallery, socials, phone, website, address_line, barangay, city_id, opening_hours, verified_at` badge | — (RSC) |
| Map snippet | MVP | static map thumbnail from `lat/lng` (no JS SDK); tap → deep link to Google Maps app via `google_place_id` | — |
| Menu | MVP | `menu_categories` (`is_active`, ordered `sort`) → `products` with `product_variants` + `product_addons`. Display price = variant `price_centavos` (or `base_price_centavos`) + addon `price_delta_centavos` deltas. `status='sold_out'` renders greyed with "Sold out"; `status='hidden'` or `is_available=false` never renders. `availability` windows shown as hints ("Lunch only 11:00–14:00") | — (RSC) |
| Active promotions | MVP | `campaigns` (`status='active'`, promotion-family types, within `starts_at/ends_at`) joined to `promotions` payload: `offer_kind`, `percent_off`/`amount_off_centavos`/`freebie_text`, `terms`, `redemption_hint`, scoped `product_ids` chips | — (RSC) |
| Rewards catalog | MVP | `rewards` (`is_active`, campaign `active`): `name, image_url, points_cost, remaining, per_customer_limit, terms`. Overlay: my `business_customers.points_balance` → "You can claim this" / "Need 120 more pts" | `['points','balance',{businessId}]` |
| Loyalty programs | MVP | `loyalty_programs` + prize `rewards` row; overlay my `loyalty_cards.progress` vs `target_value` | `['loyalty','card',{programId}]` |
| Reviews summary | V1 | rating aggregate (see deltas: `businesses.rating_avg/rating_count`) + top 3 `reviews` | — (RSC) |
| Favorite toggle | MVP | `favorites` row exists for `(user_id, business_id)`; optimistic mutation | `['favorites','list']` |
| Scan CTA | MVP | sticky "Scan receipt" → `/scan?business={id}` (pre-bound) | — |
| AI assistant entry | V1 | "Ask about this place" → `/b/[slug]/chat`; hidden unless `feature_flags` key `ai_assistant` enabled | — |

## Receipt scanner (`/scan`) — the core flow

Target: **< 15 seconds of user effort** (persona Mia, `../00-product/01-personas-roles.md`). Flow state machine lives in `scannerStore`; each step recoverable on refresh.

**1. Capture [MVP].** Camera via `<input type="file" accept="image/*" capture="environment">` (fallback-proof) upgrading to `getUserMedia` viewfinder with edge-guide overlay when available; gallery pick equally supported. `Permissions-Policy: camera=(self)` per `../10-architecture/15-security.md`.

**2. Crop/rotate [MVP].** Library-agnostic contract in `src/features/scanner/image-editor.ts`: `edit(input: Blob, ops: {rotate: 0|90|180|270; crop?: {x,y,w,h}}): Promise<Blob>` — pure, canvas-based, no upload. Default suggestion = full frame; one-tap 90° rotate; skip allowed (OCR service deskews anyway, `36-receipt-ocr-pipeline.md`).

**3. Compress [MVP].** Client-side before upload: re-encode to JPEG, max long edge **2048px**, quality 0.8, target ≤ **1.5MB** (hard server cap 10MB per `../10-architecture/15-security.md`). Compute `sha256` of the final bytes client-side (`client_sha256`) — advisory: it keys the offline outbox and lets the server run a fast duplicate pre-check. The authoritative `receipts.sha256` is recomputed server-side over the canonical re-encoded bytes (`36-receipt-ocr-pipeline.md` Stage 1); replay safety comes from the `Idempotency-Key`.

**4. Upload [MVP].** `POST /api/v1/receipts/uploads` returns a pre-signed PUT URL for the private `receipts` bucket (path `receipts/{user_id}/{uuid}.jpg`) + the `image_path`. Direct-to-storage PUT keeps the API thin (flow F1, `../10-architecture/10-system-architecture.md`).

**5. Submit [MVP].** `POST /api/v1/receipts` with `Idempotency-Key` (UUID minted at capture time, survives retries/offline replay), body `{image_path, client_sha256, business_id?}` plus `submitted_lat/lng` only when `consumers.gps_fraud_opt_in`. Server inserts `receipts` (`status='queued'`, `source='scan'`), enqueues `ocr.process`, answers `202 {receipt_id}` in < 500ms. Rate limit 6/min, 60/day per consumer. Duplicate bytes → `422 RECEIPT_DUPLICATE` immediately (unique `receipts.sha256`).

- **Business-bound scan [MVP]:** entered from a business page; `business_id` pre-set, skips merchant matching ambiguity.
- **Generic scan [V1]:** no `business_id`; pipeline matches the merchant (`receipts.business_id` null until matched, `match_confidence` scored).

**6. Status [MVP].** `/scan/[receiptId]` subscribes to Supabase Realtime on the `receipts` row (sanctioned use, D5). UX per `receipts.status`:

| Status | UX |
|---|---|
| `queued` | "Receipt received" + animated stepper; safe-to-leave note ("we'll notify you") |
| `processing` | "Reading your receipt…" stepper advances |
| `approved` | Confetti + points animation; shows `points_transactions.points` for this `receipt_id`; CTA to wallet |
| `review` | "Being double-checked by a human — usually within a day." Points shown as *pending* in wallet context |
| `rejected` | Plain-language reason (below) + recovery CTA |

`reject_reason` → consumer copy (localized `en-PH`/`fil-PH`): `duplicate` → "This receipt was already scanned." · `unreadable` → "We couldn't read this photo — try again with better lighting." (CTA: rescan) · `wrong_business` → "This receipt looks like it's from a different store." · `too_old` → "This receipt is past the scanning window." · `fraud_suspected`/`manual` → "This receipt couldn't be accepted." + `reject_note` if reviewer provided one. Never expose fraud signal internals.

Realtime drop → fall back to polling `GET /api/v1/me/receipts/{id}` every 5s (key `['receipts','detail',{id}]`). Offline capture queues to the outbox — full contract in `41-pwa-offline.md` [V1].

## Scan history (`/receipts`, `/receipts/[id]`)

- List [MVP]: `GET /api/v1/me/receipts?limit=25&cursor=…` (default sort `created_at desc`), status chips filter. Key: `['receipts','list',{status}]`. Empty: "Scan your first receipt" CTA.
- Detail [V1]: parsed fields (`merchant_name`, `receipt_number`, `receipt_date`, `subtotal_centavos`, `tax_centavos`, `total_centavos`), `receipt_line_items` (`raw_text`, `qty`, `line_total_centavos`, matched `product_id` name when present), points awarded (`points_transactions` rows referencing `receipt_id`), and signed-URL thumbnail of the image (5-min TTL per `../10-architecture/15-security.md`).

## Points wallet (`/wallet`)

- **Balances [MVP]:** `GET /api/v1/me/points` → per-business rows from `business_customers` (`points_balance`, `lifetime_points`, `visit_count`, `last_visit_at`) + business name/logo. Key: `['points','balances']`. Sorted by `last_visit_at desc`.
- **Pending [MVP]:** count of my `receipts` in `queued/processing/review` per business, shown as "N receipts pending" — no point amount is promised before award (ledger is truth, `35-points-engine.md`).
- **History [MVP]:** `/wallet/[businessId]` → `GET /api/v1/me/points/transactions?business_id=…&cursor=…` over `points_transactions`: `type` (`earn`, `redeem`, `adjust`, `expire`, `clawback`, `reversal`, `referral_bonus`), signed `points`, `balance_after`, `created_at`, link to `receipt_id`/`claim_id` source. Key: `['points','transactions',{businessId}]`, infinite.
- **Expiration [MVP display / V1 enforcement]:** earliest-expiring bucket from `earn` rows' `expires_at` — "500 pts · 120 expiring Aug 30". Expiry job is [V1] (`../00-product/02-roadmap.md`); display the dates from day one.
- Offline: last-synced snapshot with staleness banner [V1] (`41-pwa-offline.md`).

## Rewards wallet (`/rewards`)

**Claim flow [MVP]** (from business page or reward detail): confirm sheet shows `points_cost`, resulting balance, `expires_at` preview (`claim_expiry_days`), `terms`. `POST /api/v1/rewards/{rewardId}/claims` with `Idempotency-Key`. Server atomically: balance check (else `422 POINTS_INSUFFICIENT`), `per_customer_limit` check (else `409 REWARD_LIMIT_REACHED`), conditional inventory decrement on `rewards.remaining` (else `409 REWARD_OUT_OF_STOCK`), insert `reward_claims` + `redeem` ledger entry (`points_spent`, `points_txn_id`). Invalidate `['points','balances']`, `['rewards','claims']`.

**Tabs [MVP]** on `reward_claims.status`: Active (`claimed`, ordered `expires_at asc` with countdown badges — "3 days left" amber at ≤72h), Redeemed (`redeemed`, `redeemed_at`), Expired (`expired`), Cancelled (`cancelled`). `GET /api/v1/me/rewards?status=…&cursor=…`, key `['rewards','claims',{status}]`. Expiry reminders arrive as notifications `kind='reward_expiring'` (T-72h and T-24h, `30-platform-core.md`).

**Redemption QR (`/rewards/claims/[claimId]`) [MVP]** — per flow F2 and `../10-architecture/15-security.md`: `POST /api/v1/reward-claims/{claimId}/token` mints an **ephemeral signed JWT** (separate signing key, `jti` single-use in Redis, **TTL 5 min**). This is NOT a `qr_codes` row (those are printable marketing QRs — see the note in `../20-data/25-schema-platform.md`). UX: QR rendered full-screen, screen brightness boosted to max while visible (restored on exit), visible 5:00 countdown, "Refresh code" regenerates after expiry. Staff validation flows through `POST /api/v1/redemptions/validate`; the consumer screen confirms via Realtime on the claim (sanctioned use, D5) with a success animation. **Requires connectivity** — token minting is server-side by design; offline shows an explanation (`41-pwa-offline.md`).
**Manual code fallback [V1]:** same mint returns an 8-char code (Redis alongside the `jti`, same TTL/single-use); staff types it — lands as `redemptions.method='manual_code'`.

## Loyalty cards (`/cards`, `/cards/[cardId]`)

- List [MVP]: `GET /api/v1/me/loyalty-cards` joining `loyalty_cards` (`progress`, `completed_count`, `last_stamp_at`) to `loyalty_programs` (`program_type`, `target_value`, `stamp_icon`, `card_style`) and the prize `rewards` row. Key: `['loyalty','cards']`.
- Card UI: stamp grid of `target_value` cells, `progress` filled; new stamps animate ([V1] polish per roadmap; MVP = simple fill). Realtime is **not** used here — invalidation of `['loyalty','cards']` on receipt approval keeps it fresh. Copy explains earn rules from program config (`min_amount_per_stamp_centavos` floor, `max_stamps_per_day`).
- **Completion:** `progress >= target_value` → celebration + prize claim CTA. Prize is a `rewards` row with `claim_kind='loyalty_completion'`, `points_cost=0` — claim reuses the standard claim endpoint (no points check). If `resets_on_completion=true`, the engine resets `progress` and increments `completed_count`; card shows "Completed ×N". If false, card renders a terminal "Completed" state.

## Favorites (`/favorites`) [V1 surface; toggle ships MVP]

`favorites` rows: business favorites and reward favorites (exactly one FK set, per schema check). `GET /api/v1/me/favorites`, key `['favorites','list']`. Toggle = optimistic mutate `POST/DELETE /api/v1/me/favorites`. Empty state: "Save places you love."

## Reviews [V1]

- One review per consumer per business (unique constraint): the write CTA becomes "Edit your review" when a row exists. Fields: `rating` 1–5, `comment` ≤2000, `photos` (max 3, compressed like receipts). `is_verified_customer` is server-set (≥1 approved receipt at review time) and renders a "Verified customer" badge. **Edit window:** app rule, 30 days from `created_at`; after that read-only (server-enforced).
- List: `GET /api/v1/businesses/{businessId}/reviews?cursor=…` (`status='published'` only), business `reply_text` nested. Key: `['reviews','list',{businessId}]`.
- Write: `POST/PATCH /api/v1/businesses/{businessId}/reviews` (auth). Moderation states `flagged/removed` are invisible here (author sees "under review" for own flagged row).

## Notifications inbox (`/notifications`) [MVP]

- `GET /api/v1/me/notifications?cursor=…` over `notifications` where `channel='in_app'`; unread = `read_at is null` (badge count via `notifications_user_unread_idx`). Keys: `['notifications','list']`, `['notifications','unread-count']`. Mark-read: `PATCH /api/v1/me/notifications/{id}` (sets `read_at`); mark-all-read batch variant.
- **Kinds → deep links** from `notifications.data` (`{route, params}`, registry in `30-platform-core.md`): `points_awarded` → `/wallet/[businessId]` · `receipt_rejected` → `/receipts/[id]` · `reward_claimed`/`reward_expiring` → `/rewards/claims/[claimId]` · `campaign_push` → `/b/[slug]` · `announcement` → CMS page.
- **Push priming:** never call `Notification.requestPermission()` cold. Prime after the first `approved` receipt with a value-framed sheet ("Get told the moment your points land"); decline is remembered in `uiStore`, re-prompt no sooner than 30 days. Grant → FCM token registered into `user_devices.fcm_token` (`41-pwa-offline.md`). In-app inbox is the guaranteed fallback channel on every platform.

## Profile & settings (`/profile`, `/profile/settings`, `/profile/devices`)

- Profile [MVP]: `profiles.display_name`, `avatar_url` (public `avatars` bucket), `phone` (PH E.164), `locale` (`en-PH`/`fil-PH`), `birth_date` (editable once/year — app rule; powers birthday campaigns [V1]). Key: `['profile','me']`.
- Preferences [MVP], on `consumers`: `marketing_opt_in`, `push_enabled`, `email_enabled`, `gps_fraud_opt_in` (with a clear explainer of what GPS is used for), `city_id`. Contract details in `30-platform-core.md`.
- Devices [V1]: list/revoke `user_devices` (`platform`, `user_agent`, `last_seen_at`); revoke sets `is_revoked` and kills the refresh token.
- Referral block [V1]: see below. Account actions: logout (purges caches per `41-pwa-offline.md`), export-my-data and delete-my-account [V1] per `../10-architecture/15-security.md`.

## AI assistant (`/b/[slug]/chat`) [V1]

Backend contract in `38-ai-rag-platform.md`; flow F3 in `../10-architecture/10-system-architecture.md`.

- `POST /api/v1/ai/chat` `{conversation_id?, business_id, message}` → SSE stream. History from `ai_conversations`/`ai_messages`: `GET /api/v1/me/ai/conversations` and `/messages?cursor=…`, keys `['ai','conversations']`, `['ai','messages',{conversationId}]`.
- UI: streaming tokens with stop button; **suggested questions** seeded per business from its knowledge coverage ("What time do you close?", "Do you have promos today?" — supplied by 38's retrieval index, not hardcoded); thumbs feedback writes `ai_messages.feedback` (`up`/`down`) via `POST /api/v1/ai/messages/{id}/feedback` (`38-ai-rag-platform.md` §11).
- Rate limits surfaced kindly: 10/min, 100/day (`../10-architecture/13-api-standards.md`) → "You've hit today's question limit."
- **Offline: disabled** — input replaced with "Giya's assistant needs a connection" notice; history remains readable from cache. Gated by `feature_flags` key `ai_assistant`.

## Referral (`/referral`) [V1]

- Share my `consumers.referral_code` via Web Share API (fallback: copy link `giya.ph/r/{code}`).
- Signup capture: `/register?ref={code}` resolves and sets `consumers.referred_by` exactly once at account creation (immutable after).
- Bonuses: awarded by the points engine from a `referral` campaign's `points_rules` (kind=`bonus`, both sides configured in `conditions` — `../20-data/23-schema-campaigns.md` type→payload table), landing as `points_transactions.type='referral_bonus'`. Screen shows invite count and earned bonus rows. Key: `['referral','summary']`. Anti-abuse (self-referral, device fingerprint) per `37-fraud-detection.md`.

## Realtime usage contract

Supabase Realtime is limited to the three sanctioned uses (D5, `../10-architecture/10-system-architecture.md`); this surface consumes two:

| Subscription | Screen | Channel scope | Payload consumed | Fallback |
|---|---|---|---|---|
| Receipt status | `/scan/[receiptId]` | postgres_changes on own `receipts` row (RLS-authorized) | `status`, `reject_reason`, `reject_note` | poll `GET /me/receipts/{id}` @5s |
| Redemption confirm | `/rewards/claims/[claimId]` | own `reward_claims` row | `status` → `redeemed`, `redeemed_at` | poll @3s while QR visible |

Rules: subscribe on mount of the specific screen only, unsubscribe on unmount (no app-wide sockets); the Realtime client is dynamically imported; a Realtime event triggers TanStack Query invalidation of the affected keys rather than writing payloads into the cache directly (single source of truth = refetch). Everything else in the app refetches on focus/interval per TanStack defaults.

## Feature flags & deep links

**Flags consumed** (`feature_flags`, evaluated server + client per `../20-data/25-schema-platform.md`): `ai_assistant` (chat entry + route [V1]), `offline_sync` (receipt outbox + wallet snapshot [V1], `41-pwa-offline.md`), plus rollout-gated `discover` and `reviews` during V1 ramp. Unknown/disabled flag → feature absent, no dead UI.

**Public deep links** (also the push/QR landing targets):

| URL | Resolves to |
|---|---|
| `giya.ph/b/{slug}` | business page |
| `giya.ph/b/{slug}/menu` | menu (target of `qr_codes` `qr_type='menu'`/`'business'` short codes) |
| `giya.ph/q/{short_code}` | `qr_codes` resolver endpoint → redirect to business/campaign/reward page, increments `scan_count` |
| `giya.ph/r/{referral_code}` | `/register?ref={code}` [V1] |
| `giya.ph/scan?business={id}` | pre-bound scanner (auth-gated, deferred-auth pattern) |

## API endpoint inventory (consumer surface, consolidated)

All under `/api/v1`, envelope + handler order per `../10-architecture/13-api-standards.md`. Rate limits are the baselines from that doc: general authenticated = 120/min unless a stricter row exists. Public endpoints are RLS-safe (active rows only) and carry the public cache headers; `/me/*` endpoints are `private` (SW caching rules in `41-pwa-offline.md`).

| Method + path | Auth | Phase | Notes / key errors |
|---|---|---|---|
| `GET /businesses` | public | MVP (search/filters V1) | params: `near`, `radius_km`, `city_id`, `type`, `food_types`, `q`, `open_now`, `sort=trending`; cursor-paginated |
| `GET /businesses/{businessId}` | public | MVP | also resolvable by `slug` via RSC data layer |
| `GET /businesses/{businessId}/menu` | public | MVP | categories → products → variants/addons, one payload |
| `GET /businesses/{businessId}/promotions` | public | MVP | active promotion-family campaigns + payloads |
| `GET /businesses/{businessId}/rewards` | public | MVP | active catalog; no user context |
| `GET /businesses/{businessId}/loyalty-programs` | public | MVP | programs + prize summaries |
| `GET /businesses/{businessId}/reviews` | public | V1 | published only; cursor |
| `POST /businesses/{businessId}/reviews` · `PATCH …/reviews/{id}` | consumer | V1 | 409 `CONFLICT` on second review; 403 after edit window |
| `POST /receipts/uploads` | consumer | MVP | pre-signed PUT; 20/min upload limit |
| `POST /receipts` | consumer | MVP | `Idempotency-Key` required; 6/min, 60/day; `RECEIPT_DUPLICATE`, `RECEIPT_UNREADABLE`, `BUSINESS_NOT_VERIFIED` |
| `GET /me/receipts` · `GET /me/receipts/{id}` | consumer | MVP (detail V1) | polling fallback for Realtime |
| `GET /me/points` | consumer | MVP | per-business balances |
| `GET /me/points/transactions` | consumer | MVP | `business_id` filter; cursor |
| `POST /rewards/{rewardId}/claims` | consumer | MVP | `Idempotency-Key`; `POINTS_INSUFFICIENT`, `REWARD_OUT_OF_STOCK`, `REWARD_EXPIRED`, per-customer 409 |
| `GET /me/rewards` | consumer | MVP | `status` filter on `reward_claims`; cursor |
| `POST /reward-claims/{claimId}/token` | consumer | MVP | mints ephemeral QR token; `REDEMPTION_TOKEN_INVALID` family lives on the validate side |
| `GET /me/loyalty-cards` | consumer | MVP | cards + program config + prize |
| `GET /me/favorites` · `POST /me/favorites` · `DELETE /me/favorites/{id}` | consumer | MVP toggle / V1 screen | optimistic |
| `GET /me/notifications` · `PATCH /me/notifications/{id}` | consumer | MVP | mark-read sets `read_at` |
| `GET /me/profile` · `PATCH /me/profile` | consumer | MVP | profiles + consumers preference fields |
| `GET /me/devices` · `POST /me/devices` · `POST /me/devices/{id}/revoke` | consumer | MVP register / V1 UI | FCM token lifecycle (`41-pwa-offline.md`); revoke sets `is_revoked`, row retained (`30-platform-core.md` §7) |
| `POST /ai/chat` | consumer | V1 | SSE; 10/min, 100/day + per-business cap |
| `GET /me/ai/conversations` · `GET /me/ai/conversations/{id}/messages` | consumer | V1 | cursor |
| `POST /ai/messages/{id}/feedback` | consumer | V1 | `up`/`down` |
| `GET /me/referral` | consumer | V1 | code, invite count, bonus transactions |

**Module error codes registered** (extends the registry in `../10-architecture/13-api-standards.md`): `RECEIPT_DUPLICATE`, `RECEIPT_UNREADABLE`, `POINTS_INSUFFICIENT`, `REWARD_OUT_OF_STOCK`, `REWARD_EXPIRED`, `REWARD_LIMIT_REACHED` (per-customer limit), `CLAIM_EXPIRED`, `REVIEW_EDIT_WINDOW_CLOSED`, `REFERRAL_CODE_INVALID`.

## Screen state matrix (loading / empty / error)

Every screen implements all three via the shared components; this table is the QA contract.

| Screen | Loading | Empty | Error (beyond shared retry) |
|---|---|---|---|
| Home sections | per-section skeleton rows | section hidden (banners/trending); nearby → city fallback CTA | section-level inline error, rest of home unaffected |
| Discover | 6 skeleton cards | "Nothing matched" + clear-filters | map load failure → list-only notice |
| Business page | ISR — no client loading for shell; overlay shimmer on balance/progress | menu empty → "Menu coming soon"; no promos → section hidden | 404 → "This business isn't available" |
| Scanner | step-local spinners (compressing/uploading) | — | upload fail → retry sheet; offline → outbox path (`41-pwa-offline.md`) |
| Scan status | animated stepper is the loading state | — | Realtime drop → silent poll fallback; both down → "Check back in a minute" |
| Receipts list | skeleton rows | "Scan your first receipt" CTA → `/scan` | — |
| Points wallet | skeleton balance cards | "No points yet" + nearby businesses CTA | stale snapshot + banner when offline |
| Rewards wallet | skeleton per tab | per-tab copy ("No active rewards" / "Nothing redeemed yet") | claim errors mapped to friendly copy per code above |
| Redemption QR | brief mint spinner | — | token mint fail → retry; offline → explanation (no QR) |
| Loyalty cards | card skeletons | "Start a card — buy from a participating store" | — |
| Notifications | skeleton rows | "You're all caught up" | — |
| AI chat | streaming indicator | suggested questions | stream abort → partial kept + retry chip; rate limit → daily-limit copy |

## Analytics events (emitted by this surface)

Event taxonomy and transport per `40-analytics.md`; consumer PWA emits (client → collection endpoint, batched): `home_viewed`, `nearby_permission_{granted,denied}`, `business_viewed` (source: nearby/trending/search/banner/deep_link), `search_performed`, `scan_started`, `scan_submitted`, `scan_result_viewed` (status), `reward_claim_confirmed`, `redemption_qr_shown`, `loyalty_card_completed_viewed`, `push_prime_{shown,accepted,declined}`, `install_prompt_{shown,accepted,dismissed}`, `ai_question_asked`, `referral_shared`. No PII in payloads; `business_id`/route params only.

## Accessibility & localization

- WCAG 2.1 AA: all interactive islands keyboard-reachable; stamp/points animations respect `prefers-reduced-motion` (fall back to static state change); QR screen announces countdown at 60s/10s via `aria-live=polite`; contrast tokens enforced in the design system (`../10-architecture/11-tech-stack.md` Tailwind `@theme`).
- Locale from `profiles.locale` (`en-PH` default, `fil-PH`): all consumer-facing strings — including the rejection-reason copy and error `message` mapping — go through the message catalog; server error `message` values double as fallback text, with client-side localizable keys per `../10-architecture/13-api-standards.md`.
- Currency/points formatting centralized (`src/lib/format.ts`); dates relative ("2 days ago") with absolute on tap.

## Performance budget

Target device: mid-range Android (e.g. 4GB RAM), 3G-fast. **LCP < 2.5s** on `/` and `/b/[slug]`; INP < 200ms; CLS < 0.1. Tracked via Vercel Analytics; regression fails CI perf check (`../50-ops/51-testing-strategy.md`).

- **RSC-first, islands only:** public pages ship near-zero client JS; client components are leaf islands (favorite toggle, balance overlay, scanner, maps, charts none). Per-route JS budget: ≤ 90KB gzip on public routes.
- **Heavy deps dynamically imported** on interaction: Google Maps SDK, image editor, QR renderer, Realtime client.
- **Images:** `next/image` everywhere; pre-sized variants generated at upload (`39-background-jobs.md`) so lists never load originals; LCP image (business cover) priority-loaded; AVIF/WebP.
- **Fonts:** self-hosted, `display: swap`, subset.
- **Data:** ISR public pages (60s) mean most navigations hit CDN; TanStack Query `staleTime` 30s default on consumer reads to avoid refetch storms.

## Module dependencies

| Depends on | For |
|---|---|
| `30-platform-core.md` | auth flows, notification kind registry + templates, preference contracts |
| `34-campaign-engine.md` | which campaigns are "active" (state machine + windows/recurrence), stacking display order |
| `35-points-engine.md` | award semantics, pending→confirmed, expiry math shown in wallet |
| `36-receipt-ocr-pipeline.md` | status transitions, parse fields, template matching behavior the UX narrates |
| `37-fraud-detection.md` | rejection reasons surfaced (translated, never internals), referral abuse rules |
| `38-ai-rag-platform.md` | chat backend, suggested questions, guardrails |
| `41-pwa-offline.md` | SW caching, outbox, snapshots, push client lifecycle |
| `42-integrations.md` | Google Maps keys/cost controls, FCM setup |

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. `analytics_daily_business.favorites_added` — **ACCEPTED** [V1] (A25.3).
2. `businesses.rating_avg` + `businesses.rating_count` — **ACCEPTED** [V1] (A21.4).
3. *(No delta)* pending-points amounts: deliberately not stored/estimated pre-award; manual redemption codes [V1] live in Redis beside the token `jti`, not in schema.
