# 30 — Platform Core (Auth, Profiles, Notifications, CMS)

The identity, session, notification, and content plumbing every other module assumes. Schema: `../20-data/21-schema-identity.md` (profiles, consumers, business_staff, user_devices), `../20-data/25-schema-platform.md` (notifications, CMS, settings, feature_flags, audit_logs). Tenancy/claims: `../10-architecture/12-multi-tenancy-rls.md`. Security baseline: `../10-architecture/15-security.md`. All endpoints follow `../10-architecture/13-api-standards.md`.

## 1. Screen inventory — `(auth)` route group

| Route | Screen | Phase | Notes |
|---|---|---|---|
| `/login` | Login (email/password + Google) | [MVP] | Facebook button [V1] |
| `/register` | Consumer registration (default) | [MVP] | Link: "Registering a business?" |
| `/register/business` | Business registration | [MVP] | Creates identity + draft tenant (§2.2) |
| `/verify-email` | "Check your inbox" + resend | [MVP] | Gate screen (§2.3) |
| `/forgot-password` | Request reset email | [MVP] | Always answers success (no enumeration) |
| `/reset-password` | Set new password (token in URL) | [MVP] | Token TTL 1h, single-use (15) |
| `/invite/[token]` | Staff invite acceptance | [MVP] | Pre-signup path per §2.7 |
| `/auth/callback` | OAuth/code exchange handler | [MVP] | Route Handler, not a page |
| `/suspended` | Suspension notice | [MVP] | Terminal screen, logout only (§2.8) |
| `/onboarding` | Consumer first-run wizard | [MVP] | Sets `profiles.onboarded_at` (§3.3) |

All `(auth)` screens: centered card layout, no app chrome, locale switcher in footer. Loading = button spinners only (no skeletons on auth); errors inline under fields via Zod messages + top-level alert for auth failures (generic "Invalid email or password" — never distinguish which).

## 2. Auth flows

Supabase Auth (GoTrue) is the credential authority: signup, login, OAuth, password reset, and email verification all go through the Supabase SDK/endpoints — Giya does not build `/api/v1/auth/login`. Giya-owned logic (profile creation, tenant creation, claims, gates) wraps around it as below.

### 2.1 Consumer registration (default) [MVP]
1. Client: `supabase.auth.signUp({email, password})` (rate limit 10/min per IP + identifier per 13).
2. DB trigger on `auth.users` insert creates `profiles` (display_name from email prefix placeholder) + `consumers` row (defaults: `push_enabled=true`, `email_enabled=true`, `marketing_opt_in=false`, `gps_fraud_opt_in=false`, unique `referral_code` generated).
3. Consent capture: registration form records ToS/privacy acceptance (versioned — §6.4) and the *separate* marketing checkbox → `consumers.marketing_opt_in` (RA 10173, per 15).
4. Redirect to `/verify-email`. Referral deep link `?ref={code}` stores `consumers.referred_by` at trigger time [V1 — referral campaigns].

### 2.2 Business registration [MVP]
Same identity creation as 2.1, then one atomic RPC (`private.register_business`, per tenant lifecycle in `../10-architecture/12-multi-tenancy-rls.md`):
- Inserts `businesses` (`status='draft'`, slug auto-generated from name, `business_type_id` required, `city_id` optional at this step) **and** `business_staff` (`role='owner'`, `status='active'`) in one transaction. The one-active-owner partial unique index makes double-submission safe.
- Called from a Server Action (`src/features/businesses/actions.ts`); on success redirect to `/verify-email`, then `(business)` onboarding (`../30-modules/32-business-portal.md`).
- A logged-in consumer can also register a business later (same RPC, no new identity) — one identity, many roles per `../00-product/01-personas-roles.md`.

### 2.3 Email verification gate [MVP]
- Verified email is required before **receipt scanning** (15) and before **verification document submission**. Browsing, profile editing, and menu drafting are allowed unverified.
- Enforcement: server-side check of `auth.users.email_confirmed_at` (via session claims) in the receipt-submit and verification-submit services → `403 EMAIL_NOT_VERIFIED`. UI shows a persistent banner with "Resend email" (resend rate-limited 3/hour).

### 2.4 Login & OAuth
- Email/password [MVP]; lockout: 5 failures → 15 min exponential backoff (15). Google OAuth [MVP], Facebook OAuth [V1] — provider config in `../30-modules/42-integrations.md`. OAuth identities auto-link on identical verified email; conflicting unverified link attempts → `409 OAUTH_LINK_CONFLICT`.
- On every successful login: upsert `user_devices` (fingerprint by FCM token when present, else UA hash), update `last_seen_at`; if the device row is new → notification kind `new_device` (§5.4) to the user's other channels.

### 2.5 Session management & middleware [MVP]
`src/middleware.ts` (Edge, per `../10-architecture/10-system-architecture.md`):
1. Refresh Supabase session cookie server-side (JWT ≤1h, rotating refresh tokens).
2. Read custom claims (`app_metadata.biz`, `is_platform_admin`, `admin_role`) stamped by the Custom Access Token Hook (12).
3. Route-group guard: `(business)` requires ≥1 active `biz` claim; `(admin)` requires `is_platform_admin`; failure → redirect `/login` (unauthenticated) or the user's home surface (authenticated, wrong surface — never a 403 page for navigation).
4. Suspension + maintenance checks (§2.8, §6.6). Coarse per-IP rate limits (13).

Claims are hints; destructive checks re-verify tables (12). Claim staleness after role change is bounded by token TTL; staff removal and suspension are also enforced by table-lookup on the server, so revocation is immediate where it matters.

### 2.6 Forgot / reset password [MVP]
`supabase.auth.resetPasswordForEmail` → `/reset-password` with recovery token. On success: notification email to the account ("password was changed"), all other refresh tokens revoked, `user_devices` rows other than current marked `is_revoked=true`.

### 2.7 Staff invite acceptance [MVP flow; staff role V1]
`/invite/[token]` resolves `business_staff` by `invite_token` (single-use, `invite_expires_at` default 7 days). Existing account → accept → row flips `status='invited'→'active'`, `user_id` set, claims refresh on next token. No account → registration form pre-filled with `invited_email` → same flip post-verification. Expired → `422 INVITE_EXPIRED`; consumed/unknown → `422 INVITE_INVALID`. Issuance UX lives in `../30-modules/32-business-portal.md`.

### 2.8 Suspension handling [MVP]
- **User:** `profiles.is_suspended=true` (+`suspended_reason`). Middleware checks a Redis-cached suspension set (30s TTL, busted on suspension write) → redirect all authenticated routes to `/suspended`; API returns `403 ACCOUNT_SUSPENDED`. Refresh tokens revoked at suspension time by the admin service.
- **Business:** `businesses.status='suspended'` — middleware blocks `(business)` for that tenant (`403 BUSINESS_SUSPENDED` on API), public pages 404, campaigns auto-paused by worker (12). Other memberships of the same user are unaffected.

### 2.9 Device management [UI V1; recording MVP]
`user_devices` rows are recorded from MVP (needed for FCM + fraud `device_id` on receipts). The management UI ships V1 (roadmap): list devices (platform, user_agent-derived label, `last_seen_at`, "this device"), revoke → `is_revoked=true` + server-side refresh-token revocation → next request from that device gets `401 DEVICE_REVOKED` and a forced re-login. Stale devices (>180d) pruned by cleanup queue (21).

## 3. Role resolution & routing

### 3.1 Landing logic
After auth, `resolveHomeSurface(claims)`: `is_platform_admin` → `/admin`; ≥1 `biz` claim → `/business` (last-active tenant); else → `/` (consumer). Users with multiple hats get a surface switcher in the account menu (consumer ⇄ business ⇄ admin as applicable); the consumer surface is always reachable.

### 3.2 Multi-business account switcher [MVP]
- Source: `app_metadata.biz` claim map (≤20 memberships; `biz_overflow` falls back to a `business_staff` query per 12).
- Active tenant = `giya_biz` cookie (httpOnly, validated against claims in middleware on every `(business)` request; invalid/missing → switcher screen). All `(business)` server code reads tenant from this validated context — never from client input.
- Switcher UI: business logo/name/role badge/status chip; switching busts TanStack Query cache (`query-keys` are tenant-prefixed per 14).

### 3.3 Onboarding states
- `profiles.onboarded_at is null` → consumer first-run wizard at `/onboarding`: display name, city (`consumers.city_id` from `ref_cities`), locale, notification permission prompt, optional birth date (§4.3). Completion sets `onboarded_at=now()` (Server Action). Skippable except display name; skip still sets `onboarded_at` (wizard never re-traps).
- Business onboarding state is `businesses.status` (`draft`→`pending_verification`→`active`) — checklist UX in `../30-modules/32-business-portal.md`.

## 4. Profile management

Screens: consumer `/settings/profile`, `/settings/preferences`, `/settings/devices` [V1], `/settings/privacy`; business/admin surfaces reuse the same feature components under their route groups.

### 4.1 Fields
`profiles`: `display_name` (1–80), `avatar_url`, `phone` (PH E.164 `+63XXXXXXXXXX`, Zod-masked input), `locale`, `birth_date`. `consumers`: `city_id`, preference booleans (§4.4). Mutations are Server Actions (portal-internal); reads via RSC.

### 4.2 Avatar upload [MVP]
Client crops square → upload to `avatars` bucket (public-read per 15), path `avatars/{user_id}/{uuid}.jpg` (filename regenerated, EXIF stripped, re-encoded via sharp on ingest) → enqueue `images.process` (pre-sized 64/128/512 variants, `../30-modules/39-background-jobs.md`) → `profiles.avatar_url` set to base path. UI shows optimistic local preview; failure reverts with toast.

### 4.3 Birth date rules [MVP field; birthday campaigns V1]
- Consumer-set, **editable once per rolling year** (app rule, 21). Enforced in the profile service against `birth_date_updated_at` (schema delta §9); attempt within the window → `422 BIRTH_DATE_LOCKED` with next-editable date in `details`.
- UI: date picker (age ≥ 13 Zod check), warning copy "You can change this once a year — birthday rewards depend on it." Birthday campaigns (`../20-data/23-schema-campaigns.md` `birthday` type, `points_rules.conditions.birthday=true`) read this field; the once-a-year lock is the anti-gaming control, cited by `../30-modules/34-campaign-engine.md`.

### 4.4 Preferences & privacy [MVP]
| Toggle | Column | Effect |
|---|---|---|
| Marketing messages | `consumers.marketing_opt_in` | Gates all `campaign_push`/marketing-kind sends (§5.5) |
| Push notifications | `consumers.push_enabled` | Suppresses `push` channel fan-out entirely |
| Email notifications | `consumers.email_enabled` | Suppresses `email` channel fan-out |
| GPS fraud check | `consumers.gps_fraud_opt_in` | Enables `submitted_lat/lng` capture on receipts (24); off = EXIF GPS stripped (15) |

Locale: `profiles.locale in ('en-PH','fil-PH')`; drives UI strings (next-intl dictionary) and notification template language at render time. Privacy screen also links export-my-data / delete-my-account [V1] (exports queue + purge runbook per 15).

## 5. Notification service

### 5.1 Model
`notifications` (25) is the **single record**: one row per recipient **per channel** per message. A logical send to one user on push+in_app = 2 rows sharing `kind` and `data`. `business_id` = sender tenant (null = platform); `campaign_id` set for marketing sends (delivery stats roll up via `notifications_campaign_idx`).

### 5.2 Fan-out (write path — service-role only, per RLS)
`notify(userIds, kind, payload)` in `src/features/notifications/server/`:
1. Resolve per-kind default channels (registry §5.3) ∩ user preferences (§5.5).
2. Render `title`/`body` from the kind's template in the recipient's `profiles.locale`; build `data` deep link.
3. Insert rows `status='pending'`; enqueue per channel with the queue registry in `../30-modules/39-background-jobs.md`: `notify.push` (FCM worker, `{notification_ids ≤500}` batches per F4 in `../10-architecture/10-system-architecture.md`), `notify.email` (Resend worker); `in_app` rows are `sent` immediately.
4. Workers update `status` (`sent`/`delivered`/`failed` + `error`, `sent_at`); FCM invalid-token responses revoke the `user_devices.fcm_token`.
In-app delivery to open clients: TanStack Query poll (60s) on the unread endpoint; the consumer scan and staff redemption screens already hold Realtime channels (D5) and piggyback nothing here — notifications are poll-based by design.

### 5.3 Kind registry — `src/features/notifications/kinds.ts`
Adding a kind = code + this table (never schema, 25). `data` always `{route, params}` (deep link) plus kind fields.

| kind | Phase | Default channels | Payload (`data`) | Deep link |
|---|---|---|---|---|
| `points_awarded` | [MVP] | push, in_app | `{receipt_id, business_id, points}` | `/wallet/{business_id}` |
| `receipt_rejected` | [MVP] | push, in_app | `{receipt_id, reject_reason}` | `/receipts/{receipt_id}` |
| `reward_claimed` | [MVP] | push, in_app | `{claim_id, reward_id, business_id}` | `/rewards/claims/{claim_id}` |
| `staff_invite` | [MVP] | email | `{business_id, invite_token, role}` | `/invite/{token}` |
| `verification_decision` | [MVP] | email, in_app | `{verification_id, status, decision_reason}` | `/business/verification` |
| `new_device` | [MVP] | email | `{device_id, platform, user_agent}` | `/settings/devices` |
| `redemption_confirmed` | [MVP] | in_app | `{claim_id, redemption_id}` | `/rewards/claims/{claim_id}` |
| `points_adjusted` | [MVP] | in_app | `{business_id, points, adjust_reason}` | `/wallet` |
| `reward_expiring` | [V1] | push, in_app | `{claim_id, expires_at}` | `/rewards/claims/{claim_id}` — sent T-72h and T-24h (`../30-modules/33-consumer-pwa.md`) |
| `points_expiring` | [V1] | push, in_app | `{business_id, points, expires_on}` — T-30d/T-7d per `../30-modules/35-points-engine.md` | `/wallet/{business_id}` |
| `campaign_push` | [V1] | push, in_app, email | `{campaign_id, business_id}` | `/b/{slug}?c={campaign_id}` |
| `announcement` | [MVP] | in_app | `{announcement_id}` | `/announcements/{id}` |
| `birthday_greeting` | [V1] | push | `{business_id, campaign_id}` | `/b/{slug}` |
| `export_ready` | [V1] | email, in_app | `{export_id}` | signed URL screen |
| `campaign_budget_exhausted` | [V1] | push, in_app | `{campaign_id, business_id, cap}` — to owner + managers on budget auto-pause (`../30-modules/34-campaign-engine.md` §5) | `/business/campaigns/{campaignId}` |
| `points_expired` | [V1] | push, in_app | `{business_id, points}` — expiry sweep (`../30-modules/35-points-engine.md` §7) | `/wallet/{business_id}` |
| `reward_claim_expired` | [V1] | in_app | `{claim_id, points_refunded}` — claim expiry sweep (`../30-modules/35-points-engine.md` §6) | `/rewards/claims/{claim_id}` |
| `ai_budget_warning` | [V1] | in_app, email | `{business_id, spend_micros, cap_micros}` — 80% AI budget warn (`../30-modules/38-ai-rag-platform.md` §10) | `/business/settings` |

### 5.4 Transactional vs marketing
Kinds are classed `transactional` (everything above except `campaign_push`, `birthday_greeting`, `announcement` with `audience` marketing intent) or `marketing`. Classification lives on the kind entry and drives §5.5.

### 5.5 Preference enforcement
- `marketing` kinds require `consumers.marketing_opt_in=true` — checked at fan-out **and** re-checked by the worker at send time (opt-out between enqueue and send must win).
- `push_enabled=false` drops the push row; `email_enabled=false` drops email — for marketing kinds. Transactional email (password change, staff_invite, verification_decision) and transactional in_app ignore toggles; transactional push respects `push_enabled`.
- Suspended users receive nothing except suspension/appeal emails.

### 5.6 Read state & inbox
- `GET /api/v1/me/notifications?limit=25&cursor=…` (in_app rows, cursor per 13); unread badge = count where `read_at is null and channel='in_app'` (partial index, 25).
- `PATCH /api/v1/me/notifications/{id}` → sets `read_at`, `status='read'` (RLS P2 permits exactly this update); `POST /api/v1/me/notifications/read-all` `{before:timestamp}` batch variant. Consumer inbox UX: `../30-modules/33-consumer-pwa.md`.
- Inbox UI: grouped by day; tap → deep link + mark read. Empty state: illustration + "You're all caught up." Loading: 3 skeleton rows. Error: inline retry.

### 5.7 Retention
Daily `cleanup.notifications` job (cleanup family, registered in `../30-modules/39-background-jobs.md` alongside `cleanup.temp`/`cleanup.exports`/`cleanup.devices`): delete in_app rows read >90 days; delete push/email rows in terminal status >180 days **except** rows with `campaign_id` (kept for campaign stats until campaign archived + 180d). Partitioning by month at [SCALE] (12).

## 6. CMS consumption surfaces

Authoring is admin-only (`../30-modules/31-admin-portal.md`); this section is the consuming render contract. All tables RLS P4 (public read published).

| Surface | Table | Where rendered | Caching |
|---|---|---|---|
| Announcements | `announcements` | Consumer/business home feed + `/announcements` | ISR tag `cms:announcements`, s-maxage=60 |
| Banners | `banners` | Consumer home carousel (`audience`, `sort`, `starts_at`/`ends_at` window) | ISR tag `cms:banners` |
| FAQs | `faqs` | `/help` grouped by `category`, filtered by `audience` | ISR tag `cms:faqs` |
| Legal pages | `cms_pages` kind `legal` | `/legal/[slug]` (`terms`, `privacy`) | ISR tag `cms:page:{slug}` |
| Help center | `cms_pages` kind `help` | `/help/[...slug]` | ISR tag per slug |
| Tutorials | `cms_pages` kind `tutorial` | First-run coach marks + `/help/tutorials` | ISR |
| News | `cms_pages` kind `news` | `/news` [V1] | ISR |

Mutations in the admin portal call `revalidateTag` per the `src/lib/cache-tags.ts` registry (13). Markdown rendered server-side with a sanitizing renderer (no raw HTML). Empty states: sections hide entirely when no published rows (never render "no announcements" on home).

### 6.4 Legal versioning & re-consent [MVP terms display; re-consent flow V1]
`cms_pages.version` bumps on legal change. Each acceptance is recorded in `user_consents` (schema delta §9) with the page slug + version. Middleware-adjacent check (Redis-cached current versions): logged-in user whose accepted `terms` or `privacy` version < published version → blocking interstitial `/legal/re-consent` before continuing; API surface for state-changing calls returns `403 CONSENT_REQUIRED`. Decline path = logout (with export/delete links).

### 6.6 Maintenance mode [MVP pattern]
`settings` row (`scope='platform'`, `key='maintenance_mode'`, `value={enabled, message, allow_admins}`) — toggled in admin (`../30-modules/31-admin-portal.md`), cached in Redis 30s. Middleware: pages → maintenance screen; API → `503 DEPENDENCY_UNAVAILABLE`; admins bypass when `allow_admins`.

## 7. API surface (module registration)

Server Actions (portal mutations): profile update, preferences, consumer onboarding completion, business registration RPC call, invite acceptance, consent recording. Route Handlers (client-interactive/public):

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/api/v1/me/profile` | GET | consumer/any | DTO from `profiles`+`consumers` |
| `/api/v1/me/notifications` | GET | any | cursor; in_app only |
| `/api/v1/me/notifications/{id}` | PATCH | any | mark read (`read_at`) |
| `/api/v1/me/notifications/read-all` | POST | any | batch mark-read |
| `/api/v1/me/devices` | GET | any | [V1] UI; excludes revoked |
| `/api/v1/me/devices` | POST | any | register/refresh FCM token (upsert) |
| `/api/v1/me/devices/{id}/revoke` | POST | any | idempotent |
| `/api/v1/cms/pages/{slug}` | GET | public | cached (13 public policy) |
| `/api/v1/cms/announcements` · `/faqs` · `/banners` | GET | public | `audience` filter |
| `/auth/callback` | GET | public | code exchange, then §3.1 redirect |

### Error codes registered by this module (extends 13 registry)
| HTTP | Code | Where |
|---|---|---|
| 403 | `EMAIL_NOT_VERIFIED` | scan/verification gates |
| 403 | `ACCOUNT_SUSPENDED` | middleware/API, suspended profile |
| 403 | `BUSINESS_SUSPENDED` | `(business)` API for suspended tenant |
| 403 | `CONSENT_REQUIRED` | re-consent gate [V1] |
| 401 | `DEVICE_REVOKED` | revoked device session |
| 409 | `OAUTH_LINK_CONFLICT` | provider link to unverified duplicate |
| 422 | `INVITE_INVALID` / `INVITE_EXPIRED` | invite acceptance |
| 422 | `BIRTH_DATE_LOCKED` | birth date within 1-year lock |

## 8. States, observability, DoD notes

- **Loading:** portals use skeletons (14 — no raw spinners); auth screens use button-level pending states.
- **Notification triggers emitted by this module:** `new_device` (login on unseen device), `staff_invite` (issuance, on behalf of 32), `verification_decision` (on behalf of 31). All other kinds are emitted by their owning modules but registered here (§5.3).
- **Audit:** `auth.login_admin`, `profile.suspended`, `profile.unsuspended`, `device.revoked`, `consent.accepted`, `notification_pref.changed` land in `audit_logs` via the actions registry (25).
- Auth events (failed logins, lockouts, resets) surface in Sentry + OTel with `request_id` (13).

## Schema deltas proposed

Ratified into `../20-data/26-schema-amendments.md`.

1. `profiles.birth_date_updated_at` — **ACCEPTED** [MVP] (A21.1).
2. New table `user_consents` — **ACCEPTED** [MVP capture; re-consent V1] (A21.2).
3. `notifications.kind_class` — **DEFERRED**: classification stays in the `kinds.ts` registry (A25.1).
