# 42 — Integrations

Every external service Giya talks to: purpose, auth model, token storage, failure handling, cost posture, phase. All outbound calls go through typed clients in `src/lib/integrations/` (see Resilience standards at the end) — features never import vendor SDKs directly (mirrors the LLM gateway rule in `../10-architecture/11-tech-stack.md`). Groq and the OCR service are covered by `38-ai-rag-platform.md` / `36-receipt-ocr-pipeline.md`; this doc covers everything else.

## Summary

| Integration | Phase | Auth | Credentials live in | Blast radius if down |
|---|---|---|---|---|
| Google OAuth (login) | [MVP] | OAuth via Supabase Auth | Supabase provider config | Login option lost; email+password unaffected |
| Facebook OAuth (login) | [V1] | OAuth via Supabase Auth | Supabase provider config | Same |
| Meta Business (Pages/IG) | [V1] | OAuth (business grants) | `integration_connections` (encrypted) | Insights tiles degrade; core loops unaffected |
| Google Maps Platform | [MVP] | API keys | Vercel env (browser + server keys) | Maps/autocomplete degrade to text |
| Firebase Cloud Messaging | [MVP] | Service account (HTTP v1) | Vercel env (server-only JSON) | Push delayed (queue retries); in-app inbox unaffected |
| Resend | [MVP] | API key + webhook secret | Vercel env | Email delayed (queue retries) |
| PayMongo | [SCALE] | API key + webhook sig | — (future) | — |
| QRCode.js | [MVP] | none (library) | — | none |

## Google OAuth — consumer/business login [MVP]

- **Purpose:** low-friction sign-in for consumers and business users, alongside email+password (`../10-architecture/15-security.md`).
- **Auth model:** OAuth 2.0 via **Supabase Auth** (authorization code + PKCE). Supabase manages provider secrets, token exchange, and identity linking to `auth.users`; no Google tokens are stored by Giya app code.
- **Token storage:** none in our schema — Supabase session/refresh tokens only (JWT claims per `../10-architecture/12-multi-tenancy-rls.md`).
- **Failure handling:** provider outage degrades to email+password; auth endpoints rate-limited per `../10-architecture/13-api-standards.md`.
- **Cost:** free.

## Facebook OAuth — consumer login [V1]

Same model as Google (Supabase Auth provider). Note: this is **login only** — entirely separate from Meta Business below. Requires Meta app review for `public_profile`/`email`; sandbox app in staging.

## Meta Business OAuth — business connects FB Page / IG [V1]

- **Purpose:** a business links its Facebook Page / Instagram account. V1 enables **page insights read** (audience/engagement tiles in `32-business-portal.md` analytics); **content publishing is [SCALE]** (`../00-product/02-roadmap.md` Phase 3 marketing).
- **Auth model:** Meta Business Login (OAuth), scopes at V1: `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic` (+ `pages_manage_posts`, `instagram_content_publish` deferred to [SCALE]). Short-lived user token exchanged server-side for a **long-lived token (~60d)** and page tokens.
- **Connect flow:** owner/manager clicks Connect in portal settings → server-generated state nonce (Redis, 10 min TTL) → Meta consent dialog → callback `/api/v1/businesses/{businessId}/integrations/meta/callback` verifies state, exchanges code server-side, lists Pages, user picks Page(s) → one `integration_connections` row per Page. Disconnect deletes the row (soft) and best-effort revokes the grant.
- **Token storage decision:** **dedicated `integration_connections` table** (see Schema deltas), not `settings` scope `'business'`. Rationale: tokens need per-row encryption, expiry tracking, status lifecycle, uniqueness per external account, and admin visibility — a typed row beats an opaque JSONB setting; `settings` stays for preferences, never credentials. Tokens encrypted AES-256-GCM app-layer like TINs (`../10-architecture/15-security.md`), never logged, never in claims, never selected by client-reachable query paths.
- **Refresh/webhook handling:** V1 refresh is **on-read**: the insights client re-exchanges any token older than 45d before use (long-lived tokens last ~60d, so read-time refresh suffices at V1 insight volumes); a dedicated scheduled refresh queue is added only when publishing arrives [SCALE] and stale tokens become user-visible failures. Meta's deauthorize callback webhook marks the connection `revoked`; UI prompts reconnect.
- **Failure handling:** expired/revoked token → connection `status='expired'|'revoked'`, insights tiles show "reconnect" state; never blocks core loops. All Meta calls behind circuit breaker.
- **Cost:** free API; app-review lead time is the real cost — start review early in V1.

## Maps — SUPERSEDED by OpenStreetMap [MVP, shipped]

**The Google Maps Platform section below is no longer what is built.** The map slice shipped on an open-source stack instead, on an explicit owner instruction ("open source reliable maps ... no paid key"). This subsection is the contract that is actually in the code; the Google section is kept underneath because the `businesses.google_place_id` column, the Static-Maps-in-email idea and the discover-map surface still reference it.

| Concern | Choice | Why, and where the reasoning lives |
|---|---|---|
| Map library | **Leaflet 1.9** (BSD-2), raster tiles | ~42KB gzip against MapLibre GL's ~230KB plus a worker. Doc 33's per-route budget is 90KB gzip. Raster tiles are also what makes the zero-JS static map possible. Full argument: `src/features/businesses/settings/components/leaflet-map.tsx`. |
| Basemap tiles | **MapTiler free tier**, OSM-derived raster | `tile.openstreetmap.org` explicitly forbids third-party app use in the OSMF Tile Usage Policy. Limits, quota maths and the growth path: `src/lib/maps/tile-source.ts`. |
| Geocoding | **Nominatim**, proxied through `GET /api/v1/geocode` | Its policy requires a descriptive `User-Agent`, which is a forbidden header name in the Fetch standard — browser code cannot comply, so the call is server-side. Policy compliance in full: `src/lib/maps/geocode.ts`. |
| Directions | `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}` | One universal https link, no user-agent sniffing. Intercepted natively by the installed app on Android and iOS; a working web page everywhere else. `geo:` and `maps://` are each dead on two of the three platforms. `src/lib/maps/coordinates.ts`. |
| Attribution | Rendered visibly on every map surface | ODbL 4.3 and the tile host's terms. Not a nicety; a licence condition. |

- **Auth model:** one optional browser key, `NEXT_PUBLIC_MAPTILER_KEY`, referrer-restricted per origin in the MapTiler console. No server key: geocoding needs none. Read directly in `src/lib/maps/tile-source.ts` rather than through `src/lib/env.ts`, because the whole contract is that an absent key degrades gracefully and a schema that throws cannot.
- **Failure handling:** no key → no basemap renders anywhere, every surface falls back to address text, and the consumer "Get directions" link keeps working because it is two numbers in a URL. Geocoder down → 503 with copy that names the fallback ("you can still drag the pin"). Geocoder throttled → 429 with `Retry-After: 1`.
- **Cost control:**

| Surface | Control |
|---|---|
| Merchant picker (`/business/settings`) | Leaflet + its stylesheet in a `next/dynamic({ ssr: false })` chunk, fetched only when the settings screen renders |
| Public business page (`/b/[slug]`) | **No map library at all.** Server-computed tile mosaic, 6 tiles typical / 8 worst case, plain `<img>`, `loading="lazy"` |
| Tile quota | ~100k tiles/month free ≈ 16k business-page views before the tier binds; tiles are immutable, CDN-cached and shared between neighbouring shops |
| Geocoding | Explicit submit only (no autocomplete — the policy forbids it), 1s client throttle, 30/min per user, global 1 req/s ceiling, 24h Redis cache of every lookup |
| Growth path | CDN the tile URLs → MapTiler paid tier → self-host Protomaps/PMTiles (no per-request quota). All three are a URL-template change in one file. |

## Google Maps Platform [superseded above; retained for `google_place_id`, discover map and email static maps]

- **Purpose & surfaces:** Maps JS (discover map, business page map), **Places Autocomplete** (business address entry, with session tokens), **Geocoding** (address → `businesses.lat`/`lng` on save), **Static Maps** for emails [V1].
- **Auth model:** API keys — a browser key (HTTP-referrer-restricted, exposed client-side by design) and a server key (IP/API-restricted, server-only via `src/lib/env.ts`).
- **Token storage:** keys in Vercel env vars per environment (`../50-ops/50-environments-deployment.md`); nothing in DB. Geocode results stored on `businesses.lat/lng/google_place_id` — **never re-geocode per view** (`../10-architecture/11-tech-stack.md` rule); re-geocode only when `address_line/barangay/city_id/postal_code` change.
- **Failure handling:** geocoding failure on save is non-blocking (business saved without lat/lng, flagged for retry + excluded from "nearby"); Maps JS load failure degrades to address text.
- **Cost control:**

| API | Control |
|---|---|
| Maps JS | Dynamic import only on map surfaces (`../10-architecture/11-tech-stack.md`); no map on non-map pages |
| Places Autocomplete | Session tokens (one billing session per address entry); debounce 300ms; business-portal-only surface |
| Geocoding | Only on address save/change (write-time, cached forever in DB) |
| Static Maps [V1] | Rendered once per email template send batch, URL-signed; cached by CDN |
| Budget | GCP budget alert at 50/80/100% of monthly cap → alert per `../50-ops/52-monitoring-observability.md` |

## Firebase Cloud Messaging — web push [MVP]

- **Purpose:** consumer + staff push (points awarded, receipt rejected, reward claimed, campaign pushes per F4 in `../10-architecture/10-system-architecture.md`).
- **Architecture:** FCM Web Push. Client: FCM SDK in the PWA service worker (`41-pwa-offline.md`) obtains a token after permission grant → `POST /api/v1/me/devices` upserts `user_devices` (`fcm_token`, `platform`, `user_agent`). Server: `notify.push` worker (`39-background-jobs.md`) sends via **FCM HTTP v1 API** with a Firebase service-account credential (JSON in env, server-only).
- **Permission UX rule:** never prompt on first load — the browser permission dialog is requested only behind an in-app explainer at a value moment (first points award, first claimed reward), because a denied web-push permission is nearly unrecoverable. Denial state stored client-side; in-app inbox (`notifications` channel `in_app`) is the guaranteed fallback channel for every kind.
- **Payload contract:** data-only messages `{title, body, data:{route, params}}` mirroring `notifications.data` deep-link shape (`../20-data/25-schema-platform.md`); the service worker renders the notification and routes on tap. Payload ≤4KB — deep links carry IDs, never content.
- **Token lifecycle (`user_devices`):** upsert on login/permission; `last_seen_at` touched on app open; FCM `UNREGISTERED`/`INVALID_ARGUMENT` responses → `is_revoked=true` immediately; stale >180d revoked by `cleanup.devices` (`39`); user-visible device list + revoke per `../10-architecture/15-security.md`.
- **Topic vs token — decision: token sends only.** No FCM topics. Tenant/segment fan-out is computed server-side (audience materialization in F4) into `notifications` rows, then batched 500/job. Rationale: topics leak targeting control to a third party, can't honor `segment='blacklisted'`/opt-outs atomically, and break per-recipient delivery accounting.
- **Delivery receipts:** send result per token → `notifications.status` (`sent` on 200, `failed`+`error` otherwise). Web push has no true delivery receipt: `delivered` is set by the service worker calling a beacon endpoint on receipt [V1]; `read` via `read_at` when the in-app inbox item is opened.
- **Failure handling:** FCM 5xx/429 retryable (queue backoff); invalid tokens are per-recipient terminal (row `failed`, token revoked), never job-fatal.
- **Cost:** free.

## Resend — email [MVP transactional, V1 marketing]

- **Purpose:** transactional email [MVP] and marketing campaigns [V1], all through the `notify.email` queue — no synchronous sends anywhere.
- **Template registry (React Email, `src/emails/`):** `verify-email`, `password-reset`, `email-change`, `new-device` (`../10-architecture/15-security.md`), `staff-invite`, `verification-decision`, `receipt-rejected`, `reward-claimed`, `reward-expiring`, `export-ready` [V1], `campaign-marketing` [V1], `fraud-weekly-digest` [V1]. Template key recorded on the `notify.email` payload; adding one = code + this registry.
- **Auth model:** API key (server env). Domain auth: SPF + DKIM on the sending domain, DMARC `p=quarantine` → `p=reject` after 30 clean days; separate subdomains `mail.giya.ph` (transactional) vs `news.giya.ph` (marketing) so marketing reputation never burns password resets.
- **Suppression / bounce webhook:** Resend webhooks → `/api/webhooks/resend` (signature-verified, service-role zone), correlated to the `notifications` row via the Resend message id stored in `notifications.data` at send time:

| Webhook event | Effect |
|---|---|
| `email.delivered` | `notifications.status='delivered'` |
| `email.bounced` (hard) | `status='failed'` + `error`; **`consumers.email_enabled=false` auto-off** (audited, `actor_kind='system'`, `audit_logs` action `consumer.email_disabled`) |
| `email.complained` | same as hard bounce + flagged for support review |
| `email.bounced` (soft) | `status='failed'`; no auto-off; ≥3 soft bounces in 30d escalates to auto-off |

  Marketing sends additionally require `consumers.marketing_opt_in = true` (`../10-architecture/15-security.md` consent) — checked at fan-out and again in the worker; every marketing email carries a one-click unsubscribe (List-Unsubscribe header + link → sets `marketing_opt_in=false`).
- **Rate pacing:** flow-control key `email:{business_id}` (`39`) keeps per-tenant pacing under Resend account rate limits; global cap set to plan limit minus headroom.
- **Cost:** per-email plan; marketing volume is the driver — per-tenant monthly send caps are entitlement hooks (`businesses.plan_limits`).

## PayMongo [SCALE] — design constraints only

No billing code before SCALE (`../00-product/00-vision.md`). Constraints binding future work: webhook-driven truth (payment status from signature-verified webhooks, never client redirects); idempotency keys on every create call and webhook processing (replayable); entitlement activation = flipping `businesses.plan`/`plan_limits` inside the webhook transaction + `audit_logs`; all card data stays with PayMongo (no PAN touches Giya); webhook endpoint isolated at `/api/webhooks/paymongo` in the service-role zone. Schema hooks already exist (`../20-data/21-schema-identity.md`).

## QRCode.js — QR generation [MVP]

- **Contexts:** (1) durable marketing QRs from `qr_codes` rows (`business`,`campaign`,`reward`,`menu`) encoding `https://giya.ph/q/{short_code}` — never raw entity IDs (`../10-architecture/11-tech-stack.md`); (2) **ephemeral redemption QRs** encoding the short-lived signed JWT (jti single-use, TTL 5 min, `../10-architecture/15-security.md`) — rendered client-side, never persisted.
- **Export:** SVG (source of truth) + PNG raster at 512/1024/2048px from the business portal. **Print guidance** (shown in UI): minimum 2×2 cm at table distance, ≥3×3 cm recommended for posters/counter standees; quiet zone ≥4 modules; error correction level M for durable QRs (allows center logo ≤20% area), L for ephemeral screen QRs.
- **Failure handling:** pure client/server-side library — no external dependency. Short-link resolution endpoint increments `qr_codes.scan_count` (fire-and-forget).
- **Cost:** free.

## Failure-mode drill matrix

Each mode is drilled in staging before launch (`../50-ops/50-environments-deployment.md` checklist) and has an alert per `../50-ops/52-monitoring-observability.md`:

| Failure | User-visible effect | System behavior | Recovery |
|---|---|---|---|
| FCM outage | Push delayed | `notify.push` retries with backoff; in-app inbox already has the row | Automatic on recovery; no replay needed |
| Resend outage | Email delayed | `notify.email` retries; transactional kinds unaffected functionally (in-app fallback) | Automatic |
| Maps quota exhausted | Autocomplete/map degrade to manual text entry | Server geocode queued for retry; browser key failure caught client-side | Raise quota / next billing window |
| Meta token expired en masse | Insights tiles show reconnect prompt | Connections flip `expired`; no queue impact | Business re-connects (email nudge [V1]) |
| Supabase Storage degraded | Uploads fail with retryable error | Upload endpoints return 503 `DEPENDENCY_UNAVAILABLE`; scanner queues offline (`41-pwa-offline.md`) | Automatic |
| Webhook endpoint down (deploy window) | none | Providers retry (Resend/Meta both retry); idempotent processing dedupes | Automatic |

## Integration resilience standards (all of the above)

1. **Typed clients** in `src/lib/integrations/{google,meta,fcm,resend,maps}.ts` — Zod-validated responses, no raw `fetch` in features/workers.
2. **Timeouts:** every outbound call has an explicit timeout (default 10s; OCR service 90s per `39`); no unbounded awaits.
3. **Circuit breaker (Redis):** `{env}:cb:{service}` — open after 5 consecutive failures in 60s, half-open probe after 30s. Open circuit → queue jobs fail retryable (backoff does the waiting) and API surfaces return `503 DEPENDENCY_UNAVAILABLE` (`../10-architecture/13-api-standards.md`).
4. **Secrets** per `../10-architecture/15-security.md`: env-scoped, `src/lib/env.ts` server schema, rotation runbook in `../50-ops/50-environments-deployment.md`; webhook endpoints signature-verified without exception.
5. **Sandbox/test modes per environment** (`../50-ops/50-environments-deployment.md`): local/staging use Resend test mode + a staging FCM project + Meta test app + Maps keys with tight quotas; production keys never appear outside production env scope.
6. **Metering:** paid-per-call integrations (Maps, Resend, Groq via `ai_usage_events`) emit cost counters to `../50-ops/52-monitoring-observability.md` budget monitors.
7. **Webhook endpoints** (`/api/webhooks/{resend,meta,paymongo}`) are outside `/api/v1` (not part of the public contract), signature-verified before any parsing, idempotent by provider event id (Redis `SET NX` 24h — same pattern as `../10-architecture/13-api-standards.md` idempotency), and answer 200 fast with work queued, never processed inline.

### Environment variable registry (per environment; validated by `src/lib/env.ts`)

| Var | Scope | Integration |
|---|---|---|
| `NEXT_PUBLIC_MAPS_BROWSER_KEY` | client | Maps JS / Places (referrer-restricted) |
| `MAPS_SERVER_KEY` | server | Geocoding, Static Maps |
| `FCM_SERVICE_ACCOUNT_JSON` | server | FCM HTTP v1 |
| `NEXT_PUBLIC_FIREBASE_CONFIG` | client | FCM web SDK (public by design) |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | server | Resend |
| `META_APP_ID`, `META_APP_SECRET` | server | Meta Business OAuth [V1] |
| `INTEGRATION_TOKEN_AES_KEY` | server | `integration_connections` encryption (key-id-prefixed, `../50-ops/50-environments-deployment.md` rotation) |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` | server | [SCALE] placeholder |

Supabase/Upstash/QStash/Groq/Sentry/OCR-service vars are owned by their respective docs (`../50-ops/50-environments-deployment.md` inventory).

## Adding a new integration (checklist, enforced by PR review)

1. Entry in the Summary table + its own section in this doc (purpose, auth, storage, failure handling, cost, phase) — doc-first.
2. Typed client in `src/lib/integrations/{name}.ts`: Zod response schemas, explicit timeout, circuit-breaker wrap, no SDK leakage into features.
3. Secrets added to `src/lib/env.ts` server schema + the env inventory in `../50-ops/50-environments-deployment.md`; sandbox credentials for local/staging on day one.
4. Outbound calls only from services or workers — never handlers, components, or middleware (`../10-architecture/14-development-standards.md` layering).
5. If it stores tenant credentials → `integration_connections` row pattern (encrypted columns), never `settings`.
6. If it has webhooks → `/api/webhooks/{name}`, signature verification, event-id idempotency, fixture-based contract tests (`../50-ops/51-testing-strategy.md`).
7. Cost meter + budget alert registered in `../50-ops/52-monitoring-observability.md`; failure mode added to the drill matrix above.
8. Feature flag if user-visible (`14` DoD).

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

- New table `integration_connections` — **ACCEPTED** [V1], full DDL in 26 (A25.6).
- `notifications.opened_at` — **ACCEPTED** [V1] (A25.5; also proposed by `40-analytics.md`).
- `email_suppressions` table — **DEFERRED**: speculative re-registration edge case; `consumers.email_enabled` remains the sole suppression mechanism (A25.7).
