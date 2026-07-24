# 32 — Business Portal

The `(business)` route group: everything Ramon and Karla (`../00-product/01-personas-roles.md`) use to run their program. Access requires an active `business_staff` membership (claims + `giya_biz` tenant cookie per `../30-modules/30-platform-core.md` §3.2); every screen is scoped to the active tenant and gated per the canonical permission matrix — the table in §12 is a *summary* of that matrix, never a fork of it.

Schema: `../20-data/21-schema-identity.md` (businesses, business_staff, business_documents, business_customers), `../20-data/22-schema-catalog.md` (menu), `../20-data/23-schema-campaigns.md` (campaigns/points/rewards/loyalty), `../20-data/24-schema-receipts-ai.md` (templates, receipts), `../20-data/25-schema-platform.md` (qr_codes, notifications, analytics_daily_business, audit_logs, exports). Engine semantics are owned by `../30-modules/34-campaign-engine.md` / `35-points-engine.md` / `36-receipt-ocr-pipeline.md` — this doc is the screens/UX contract.

Server Action vs Route Handler: portal mutations are Server Actions (D1, `../10-architecture/10-system-architecture.md`); TanStack-Table list reads, campaign lifecycle verbs (`POST …/campaigns/{id}/activate` etc., registered in `../30-modules/34-campaign-engine.md`), and staff redemption validation use `/api/v1/businesses/{businessId}/…` Route Handlers (cursor pagination, envelope, `Idempotency-Key` per `../10-architecture/13-api-standards.md`) — anything idempotency-keyed or called outside portal chrome stays a Route Handler.

## 1. Route/screen inventory — `(business)`

| Route | Screen | Phase |
|---|---|---|
| `/business` | Dashboard | [MVP] |
| `/business/onboarding` | Setup checklist | [MVP] |
| `/business/verification` | Verification submission + status | [MVP] |
| `/business/store` | Store profile editor | [MVP] |
| `/business/menu` · `/business/menu/[categoryId]` | Menu management | [MVP] |
| `/business/templates` | Receipt templates | [MVP] |
| `/business/campaigns` · `/business/campaigns/new` · `/business/campaigns/[id]` | Campaign list / wizard / detail | [MVP] |
| `/business/rewards` | Reward catalog + inventory | [MVP] |
| `/business/loyalty` | Loyalty program setup | [MVP] |
| `/business/points` | Points rules editor | [MVP] |
| `/business/customers` · drawer `[customerId]` | CRM | [MVP list; segments V1] |
| `/business/redeem` | Staff redemption validation | [MVP] |
| `/business/receipts` | Flagged-receipt review (own tenant) | [MVP] |
| `/business/qr` | QR management hub | [MVP business/reward; campaign/menu V1] |
| `/business/staff` | Staff & invitations | [MVP owner/manager/marketing; staff role V1] |
| `/business/marketing` · `/business/marketing/calendar` | Push/email composer + scheduler | [V1] |
| `/business/analytics` | Deep analytics | [V1] |
| `/business/activity` | Activity log (audit, owner) | [V1] |
| `/business/settings` | Tenant settings, danger zone | [MVP] |

Portal-wide states (DoD per `../10-architecture/14-development-standards.md`): skeletons for every list/detail (no raw spinners), empty states with a primary CTA ("No campaigns yet — start from a template"), error states show `request_id` + retry, mobile viewport verified (owners live on phones).

## 2. Onboarding journey: register → verified → live

```
register (30 §2.2)          businesses.status='draft'
  └─ checklist  ──────────► profile + menu + template drafts (all editable)
       └─ submit docs ────► status='pending_verification'   (verification round)
            └─ admin decision (31 §3) ──► approved → status='active', verified_at set
                                     └─► revision_requested/rejected → fix docs, resubmit (new round)
```

### 2.1 Checklist (`/business/onboarding`)
Persistent card until dismissed post-activation. Items + completion predicates:
1. **Store profile** — name, type, address, city, `lat/lng` pin set.
2. **Opening hours** — `opening_hours` non-empty.
3. **Logo & cover** — `logo_url`, `cover_url` set.
4. **Menu started** — ≥1 `products` row.
5. **Receipt template** — ≥1 `receipt_templates` row with a passing test run (§6).
6. **Verification submitted** — latest `business_verifications` row exists.
7. **First campaign drafted** — ≥1 `campaigns` row (any status).

### 2.2 Verification submission (`/business/verification`) — owner only (matrix)
- Uploads → `business_documents` (private `business-documents` bucket, ≤20MB/doc, magic-byte sniffed per `../10-architecture/15-security.md`). `doc_type` picker with PH-specific guidance: `business_permit`, `mayors_permit`, `tin`, `dti`, `sec`, `sample_receipt`, `other`. Required set by `registration_type`: DTI-registered → `dti` + `mayors_permit` + `tin` + `sample_receipt`; SEC → `sec` instead of `dti`; `none` (informal) → `mayors_permit` or `business_permit` + `sample_receipt` (policy copy, service-validated).
- Submit (Server Action): creates `business_verifications` (`status='pending'`, `registered_name`, `registration_type`, TIN captured → encrypted `tin_encrypted` + `tin_masked`, applicant `notes`), links docs via `verification_id`, flips `businesses.status='draft'→'pending_verification'`. Requires verified email (30 §2.3).
- Status panel: current round status; on `revision_requested`/`rejected`, shows admin `decision_reason` verbatim + "Fix and resubmit" (new round per `../30-modules/31-admin-portal.md` §3.2). History accordion of prior rounds. `expires_on` on permits drives renewal reminders [V1].

### 2.3 Blocked-state UX while `pending_verification`
Editable pre-verification: store profile, hours, gallery, menu, receipt templates, campaign/reward/loyalty **drafts**, points-rule drafts, staff invitations. Blocked until `status='active'`: **campaign activation** (the activation gate in `../30-modules/34-campaign-engine.md` rejects with `422 BUSINESS_NOT_VERIFIED`), public listing in the consumer app, marketing sends, QR short links resolving publicly. UI: activation buttons render disabled with tooltip "Available once verified", plus a top banner with verification status + ETA copy. This ordering exists so Ramon's "one sitting to first live campaign" is just pressing Activate the moment approval lands.

## 3. Dashboard (`/business`)

Tiles = `analytics_daily_business` (rollups, `../30-modules/40-analytics.md`) + live queries for today:

| Tile | Source |
|---|---|
| Sales overview (`gross_sales_centavos`) | rollups for range + live sum of today's approved receipts |
| Customer growth (`new_customers`, `returning_customers`) | rollups |
| Points issued / redeemed | rollups (`points_earned`, `points_redeemed`) |
| Rewards claimed / redeemed | rollups + live `reward_claims` count today |
| Receipts approved vs rejected | rollups; click → `/business/receipts` |
| Campaign tiles (per active campaign) | claims/redemptions filtered by campaign (23) + notification delivery when sent (25 `notifications_campaign_idx`) |
| AI questions [V1] | rollups `ai_questions` |

**Date-range picker semantics:** presets Today / 7d / 30d / 90d / custom; days are **Asia/Manila** calendar days (rollup `day` is already Manila-bucketed per 40); "today" mixes rollup history + live queries and is labeled "so far today"; comparison delta = same-length preceding window. Charts: Tremor. Staff role [V1] sees only today's redemption count (matrix 🟡⁶ — dashboard renders the single-tile variant).

## 4. Store management (`/business/store`) — owner/manager

All `businesses` profile fields: name, `description`, `phone`/`email`/`website`, `socials` JSONB ({facebook, instagram, tiktok} URL fields), `gallery` JSONB ([{url, caption, sort}], drag-sort, images via `promotions`-style public bucket upload + image queue), `logo_url`/`cover_url`, address fields (`address_line`, `barangay`, `city_id` from `ref_cities`, `postal_code`), map pin: Google Maps picker (`../30-modules/42-integrations.md`) writing `lat`/`lng` + `google_place_id`, `business_food_types` tag multi-select.

- **`opening_hours` JSONB editor:** 7 rows (day 1–7), each `{day, open:"HH:MM", close:"HH:MM", closed:false}`; "closed" toggle per day; copy-to-all-days affordance; overnight allowed (`close` < `open` renders "until 02:00 +1"); Zod schema `openingHours` validates shape + time format. This field feeds consumer display and AI answers (`../30-modules/38-ai-rag-platform.md` — never hallucinated hours), so save emits the embeddings refresh event.
- **Slug rules:** `^[a-z0-9-]{3,60}$`, unique; auto-generated at registration; freely editable while `draft`/`pending_verification`; after activation, changes are owner-only, limited to once per 30 days (app rule) with a "breaks printed QR links" warning — `qr_codes` short links (`giya.ph/q/{code}`) are slug-independent and keep working, which the warning says.
- Profile writes revalidate `biz:{id}:profile` cache tag (13) and emit `catalog.updated`-style embedding refresh for `business_info`/`hours` sources (24).

## 5. Menu management (`/business/menu`) — owner/manager

CRUD per `../20-data/22-schema-catalog.md`: `menu_categories` (drag `sort`, `is_active`), `products` (name, description, `base_price_centavos` — money input in pesos, stored centavos; `category_id`; `images` ≤6, uploaded to public `products` bucket → image queue pre-sizes variants), `product_variants` (absolute `price_centavos`), `product_addons` (`price_delta_centavos`).

- **`sold_out` vs `is_available`** (22 design note, surfaced verbatim in UX): the row menu shows two distinct controls — "Mark sold out" (`status='sold_out'`: stays visible greyed-out on the consumer page, merchandising state) and the availability switch (`is_available=false`: hides instantly, staff quick toggle). Bulk toggle from the list. `status='hidden'` = long-term unlisted.
- Availability windows editor (JSONB `availability`, Zod `availabilityWindows`) — display/AI hints only (22).
- Any catalog write emits `catalog.updated` → embeddings refresh job (22/38) and revalidates `biz:{id}:menu`.
- **Menu QR** [V1]: generate `qr_codes` row (`qr_type='menu'`) from the header — deep-links to the public menu page; export per §10.

## 6. Receipt templates (`/business/templates`) — owner/manager

Teaches the parser (pipeline detail: `../30-modules/36-receipt-ocr-pipeline.md`).

- **Upload:** sample receipt photo/PDF → private `invoice-templates` bucket (`sample_path`), name + `source_kind` (`pos`/`invoice`/`handwritten`).
- **OCR test run UX:** "Test this template" → `POST /api/v1/businesses/{businessId}/receipt-templates/{id}/test` (36's endpoint); result panel renders `ocr_test_result` JSONB — extracted merchant/receipt-no/date/total side-by-side with the image, per-field confidence chips (green ≥ .9, amber ≥ .7, red below), and the auto-suggested `parse_config` hints (merchant aliases, receipt-number regex, date formats). Failing fields open the hint editor (writes `parse_config`) → re-test. A pass (all anchor fields extracted) stamps `validated_at`; a fail leaves it unset and the panel lists the missing anchors.
- **Versions & activation:** any `parse_config` edit increments `version` and **clears `validated_at` until re-tested** (36 lifecycle); attempting to use/activate an untested template → `409 TEMPLATE_NOT_VALIDATED` (registered in 36). Multiple templates per business (per-branch/per-POS), each independently `is_active` (retire without deleting evidence). At least one active validated template is a checklist item (§2.1) — without it, scans fall back to generic parsing with lower auto-approval (36).
- States: empty → illustrated explainer ("Upload a real receipt — this is how Giya reads your customers' scans"); test running → progress skeleton over the result panel (poll job status); test failed → red summary + hint editor CTA.

## 7. Staff, roles, activity

### 7.1 Roster & invitations (`/business/staff`)
- Roster: `business_staff` rows (avatar, name, role badge, `status` chip, last-seen from `user_devices` via profile). Owner sees all controls; matrix rules: **owner** invites/removes any role and is the only tenant role that changes roles; **manager** may invite `staff` only [V1] (matrix 🟡²); marketing/staff see the roster read-only? — no: matrix has no roster-view grant for marketing/staff, so `/business/staff` is owner+manager only.
- Invite (Server Action): email + role → `business_staff` row (`status='invited'`, `invited_email`, single-use `invite_token`, `invite_expires_at` +7d) → notification kind `staff_invite` (email). Duplicate active/invited member → `409 INVITE_DUPLICATE`. Resend regenerates token. Acceptance flow: `../30-modules/30-platform-core.md` §2.7.
- Role change (owner): guarded by the one-active-owner invariant (21) — owner role is not assignable here; ownership transfer is an atomic swap [V1] in settings. Change is table-verified server-side (claims may be stale, 12) and audited (`staff.role_changed`).
- Disable: `status='disabled'` — immediate table-checked lockout, row retained for history. Removing the last owner is impossible by index; UI never offers it (`409 OWNER_REQUIRED` as the service backstop).

### 7.2 Activity logs (`/business/activity`) [V1] — owner only (matrix: view audit logs own tenant)
Tenant-scoped read of `audit_logs` (`audit_biz_idx`; RLS grants owner select where `business_id` matches). Filters: actor, action, entity, date. Same diff renderer as the admin viewer (`../30-modules/31-admin-portal.md` §10). Surfaces staff actions ("Karla activated Campaign X", "Manual adjustment +200 pts by Ramon — reason shown").

## 8. Customer management — CRM (`/business/customers`)

- **List [MVP]:** `business_customers` via `GET /api/v1/businesses/{businessId}/customers` — TanStack Table, server-side cursor pagination/sort/filter (indexes `bc_business_seg_idx`, `bc_business_lastvisit_idx`). Columns: consumer display name, `segment` badge, `points_balance`, `visit_count`, `lifetime_spend_centavos`, `last_visit_at`. Filters: segment, last-visit recency, min visits. Consumer PII beyond display name is not shown (privacy rule in 15 — no email/phone unless direct-marketing opt-in [V1]). Visible to owner/manager/marketing (matrix).
- **Profile drawer:** visit history (`receipts` for this pair, status-chipped), points statement (`points_transactions` ledger rows, signed values + `balance_after`), claims (`reward_claims` by status), loyalty progress (`loyalty_cards`), `first_visit_at`/`last_visit_at`.
- **Segments [V1]** — owner/manager only (matrix): `segment` = `regular`/`vip`/`blacklisted`. Effects (enforced by engines, cited here): `vip` is targetable in `campaigns.audience.segments` (`../30-modules/34-campaign-engine.md`); `blacklisted` blocks earning and redemption (redemption validate checks standing per F2 in `../10-architecture/10-system-architecture.md`; fraud interplay in `../30-modules/37-fraud-detection.md`). Blacklisting requires a typed reason → audit `customer.segment_changed`.
- **Notes:** `business_customers.notes` — staff-visible only, "Never shown to the customer" helper text (21); editable by owner/manager; visible to marketing read-only with the list grant.
- Export customers CSV [V1]: `exports` row `kind='customers_csv'` → same signed-URL flow as `../30-modules/31-admin-portal.md` §9.

## 9. Campaigns, points, rewards, loyalty — screens

Engine semantics (state machine, stacking, eligibility, ledger) are owned by `../30-modules/34-campaign-engine.md` and `../30-modules/35-points-engine.md`; below is the UX contract. Create/edit: owner/manager/marketing; points rules & manual adjustments exclude marketing (matrix).

### 9.1 Campaign list & wizard
- List: `campaigns` grouped by `status` (draft/scheduled/active/paused/ended/archived), type icon, schedule window, budget usage. Actions per state machine: activate (gated on payload completeness + business `active` — §2.3), pause, end, archive, **duplicate** (deep-copies campaign + payload rows as new `draft`, names "Copy of …").
- Wizard (`/business/campaigns/new`): step 1 pick type — [MVP] `loyalty`, `reward`, `promotion`; [V1] `discount`, `referral`, `birthday`, `seasonal`, `holiday`, `event`, `membership`. Template gallery first (Ramon: templates over blank forms). Step 2 payload per type→payload mapping (23): promotion-family → `promotions` (offer_kind, percent/amount off, terms, scoped `product_ids`); reward → ≥1 `rewards`; loyalty/membership → `loyalty_programs` + prize reward; birthday → multiplier rule and/or reward. Step 3 schedule (`starts_at`/`ends_at`, `timezone` default Asia/Manila; recurrence JSONB [V1] with weekday/time-window picker). Step 4 audience [V1] (`audience` JSONB — segment/min-visits/cities/birthday-month chips; empty = everyone) + budget guardrails (`budget` JSONB: max_total_points, max_redemptions, per_customer_limit). Step 5 review → save draft / activate.
- Scheduling: `scheduled` campaigns flip via the scheduler sweep (23 index, `../30-modules/39-background-jobs.md`); the detail screen shows next transition time.

### 9.2 Points rules editor (`/business/points`) — owner/manager
- One active base rule (partial unique, 23): `rule_type` selector — `amount_rate` ("Every ₱__ = 1 point", stored `rate_centavos_per_point`), `fixed_per_visit` / `fixed_per_receipt` (`fixed_points`), `tiered_amount` (tier table editor → `tiers` JSONB). `rounding` picker (floor default).
- Multiplier/bonus rules [V1] attach to campaigns (`kind='multiplier'|'bonus'`, `multiplier`/`bonus_points`, `conditions` JSONB editor: days, time windows, birthday, min amount).
- **Live preview (shared pure function per 14):** sample-receipt amount input runs `calculatePoints(rules, amountCentavos, context)` imported from `src/features/points/` — the *same* function the award pipeline uses server-side (no duplicated business logic). Preview shows "₱250 receipt → 25 pts (base) ×2 Friday = 50 pts" with rule breakdown.
- Manual adjustment (customer drawer action): owner uncapped in-tenant; manager capped ±500 pts/customer/day (matrix 🟡⁵, configurable via `settings` business scope); reason required (`points_transactions.adjust_reason`, service-enforced) → ledger `type='adjust'` + notification `points_adjusted`.

### 9.3 Rewards (`/business/rewards`) — owner/manager/marketing
Catalog CRUD on `rewards`: name, image (public `rewards` bucket), `points_cost` (0 = free claim), `claim_kind`, **inventory** (`total_inventory` null = unlimited; `remaining` displayed with low-stock badge ≤10%; oversell impossible per 23 integrity rules), `per_customer_limit`, `claim_expiry_days` (1–365; "claims expire {n} days after claiming"), `terms`, `is_active`. Expiration surfaces: claims nearing `expires_at` count on the detail screen; sweeps and `reward_expiring` notifications are engine-owned (23 expiry index, 39).

### 9.4 Loyalty program setup (`/business/loyalty`)
Wizard over `loyalty_programs`: `program_type` (visit_count / points_target / receipt_count / spend_amount / custom), `target_value`, prize `reward_id` (created inline with `claim_kind='loyalty_completion'`), card designer (`stamp_icon`, `card_style` JSONB — color/animation presets with live card preview matching the consumer render), anti-gaming (`min_amount_per_stamp_centavos`, `max_stamps_per_day`), `resets_on_completion`. Multi-program per business [V1]. Progress semantics: `../30-modules/34-campaign-engine.md`/`35-points-engine.md`.

## 10. QR management hub (`/business/qr`)

`qr_codes` (25): types `business` [MVP], `reward` [MVP — printable marketing QR linking to the reward page, **not** the redemption token, per 25 note], `campaign` [V1], `menu` [V1]. Card per QR: label, short link `giya.ph/q/{short_code}`, `scan_count`, `is_active` toggle (kill switch for printed material), download **SVG** (print) and **PNG** (1024px, logo-centered). Short-link resolution is a public Route Handler that increments the scan counter (Redis, flushed to `scan_count` by the `qr.scan_flush` job — `../30-modules/34-campaign-engine.md` §8, `../30-modules/39-background-jobs.md`) and 302s to the target; inactive → friendly 404. Create flows are also embedded in campaign/reward/menu screens ("Get QR").

## 11. Marketing & analytics [V1]

### 11.1 Push campaign composer (`/business/marketing`) — owner/manager/marketing
- Composer: title/body (per-locale variants optional), deep-link target (business page/campaign/reward), **audience builder** writing `campaigns.audience` JSONB (segments, min_visits, cities, birthday_month) with a live **preview count** (`Preview recipients: 412` — server count over `business_customers` ∩ preference gates, debounced). Ad-hoc messages attach to a `promotion` campaign with `offer_kind='announcement'` (everything is a campaign — no side channel).
- Send = campaign activation path F4 (`../10-architecture/10-system-architecture.md`): resolve audience → enqueue `notify.push` batches (500/job) → per-recipient `notifications` rows (kind `campaign_push`, `campaign_id` set) → delivery stats on the campaign detail (sent/delivered/failed/read from `notifications`). Preference gates (marketing_opt_in, push_enabled) enforced at fan-out **and** send (`../30-modules/30-platform-core.md` §5.5). Scheduled sends: `jobs.scheduled_at`.
- Email campaigns: same composer, `notify.email` via Resend (`../30-modules/42-integrations.md`); per-campaign performance identical.
- **Facebook/Instagram connection** — owner or marketing only (matrix "Connect Meta/IG"; manager excluded): Meta Business OAuth per `../30-modules/42-integrations.md`; V1 enables **page insights read** (audience/engagement tiles in §11.2); content publishing is [SCALE].
- **Scheduler calendar** (`/business/marketing/calendar`): month/week view of `campaigns.starts_at/ends_at` + scheduled sends; drag to reschedule (Server Action re-validating state machine). Mirrors social-scheduler mental models (Karla persona).

### 11.2 Analytics screens (`/business/analytics`) [V1 deep; MVP has dashboard only]
Tabs, all definitions canonical in `../30-modules/40-analytics.md`: Revenue (rollup `gross_sales_centavos` trends), Visits (`visit_count`/receipt trends), Retention cohorts (monthly first-visit cohorts × return rate), Top products (matched `receipt_line_items.product_id` aggregates — unmatched share shown honestly), Campaign performance (claims, redemptions, incremental visits), Reward performance (claim→redemption conversion, breakage), CLV (40's definition). Plain-language insight strips ("Tuesdays are your slowest day") are [SCALE] AI analytics — the layout reserves the slot.

## 12. Staff redemption validation (`/business/redeem`) — owner, manager, staff [MVP]

The counter flow (F2, `../10-architecture/10-system-architecture.md`). Marketing role is excluded (matrix "Validate redemption").

1. Full-screen camera scanner (same scanner component family as consumer PWA) reads the consumer's one-time reward QR (short-lived signed token, TTL 5 min).
2. `POST /api/v1/redemptions/validate` (`Idempotency-Key` required) → token verify (single-use `jti` Redis lock) → checks: claim `status='claimed'`, not expired, inventory, consumer standing not `blacklisted` → atomic tx: `redemptions` row (`validated_by` = current staff, `method='qr'`), points deduction if points-priced, inventory decrement.
3. **Confirmation screen** (big green check, reward name, consumer display name) driven by the response; the consumer's device confirms via Realtime simultaneously (one of the three sanctioned Realtime uses, D5). Notification `redemption_confirmed` (in_app) to the consumer.
4. Errors render as full-screen actionable states, codes per `../30-modules/35-points-engine.md`: `REDEMPTION_TOKEN_INVALID` (expired/re-used — "Ask the customer to reopen the reward"), `CLAIM_ALREADY_REDEEMED`, `CLAIM_EXPIRED`, `CUSTOMER_BLACKLISTED` (403; neutral copy: "Cannot redeem — see customers page"). Manual 8-char code fallback [V1] (`method='manual_code'`), same validation path.
5. Screen works on any logged-in staff phone; today's redemption count footer satisfies the staff-role dashboard grant (🟡⁶).

## 13. Per-screen role gating summary (mirror of `../00-product/01-personas-roles.md` — matrix wins on any conflict)

| Screen | owner | manager | marketing | staff [V1] |
|---|---|---|---|---|
| Dashboard | ✅ | ✅ | ✅ | 🟡 today's redemptions only |
| Store / Menu / Templates | ✅ | ✅ | ❌ | ❌ |
| Verification | ✅ | ❌ | ❌ | ❌ |
| Campaigns (create/edit) | ✅ | ✅ | ✅ (activate own — 🟡³) | ❌ |
| Points rules / manual adjust | ✅ | ✅ (adjust capped 🟡⁵) | ❌ | ❌ |
| Rewards catalog | ✅ | ✅ | ✅ | ❌ |
| Customers (view) | ✅ | ✅ | ✅ | ❌ |
| Segments / notes edit | ✅ | ✅ | ❌ | ❌ |
| Receipt review (own tenant) | ✅ | ✅ | ❌ | ❌ |
| Marketing sends | ✅ | ✅ | ✅ | ❌ |
| Meta/IG connect | ✅ | ❌ | ✅ | ❌ |
| Staff management | ✅ | 🟡 invite staff only | ❌ | ❌ |
| Redeem (validate QR) | ✅ | ✅ | ❌ | ✅ |
| Analytics | ✅ | ✅ | ✅ | 🟡⁶ |
| Activity log / Settings danger zone | ✅ | ❌ | ❌ | ❌ |

UI hiding is cosmetic; every action re-checks server-side (route guard + RLS per `../10-architecture/12-multi-tenancy-rls.md`).

### Error codes registered by this module
| HTTP | Code | Where |
|---|---|---|
| 409 | `INVITE_DUPLICATE` | inviting an existing/invited member |
| 409 | `OWNER_REQUIRED` | any action that would leave zero owners |
| 409 | `SLUG_TAKEN` | store slug conflict |

Surfaced here but registered elsewhere: `BUSINESS_NOT_VERIFIED` (shared registry, `../10-architecture/13-api-standards.md`; activation gate G1 in `../30-modules/34-campaign-engine.md`), `CAMPAIGN_INVALID_STATE` / `CAMPAIGN_PAYLOAD_INCOMPLETE` (34), `TEMPLATE_NOT_VALIDATED` (36), `REDEMPTION_TOKEN_INVALID` / `CLAIM_ALREADY_REDEEMED` / `CLAIM_EXPIRED` / `CUSTOMER_BLACKLISTED` / `POINTS_INSUFFICIENT` / `REWARD_OUT_OF_STOCK` (35/37).

### Notification triggers emitted
`staff_invite` (invite), `points_adjusted` (manual adjustment), `campaign_push` (marketing sends [V1]), `redemption_confirmed` (validate). Registered in `../30-modules/30-platform-core.md` §5.3; `verification_decision` arrives inbound from the admin portal.

## Schema deltas proposed

None. Every screen above operates on existing tables/columns: scheduled marketing sends use `jobs.scheduled_at` + campaign scheduling fields; ad-hoc pushes reuse `promotions.offer_kind='announcement'`; manager adjustment caps use `settings` (`scope='business'`). Two watch items deliberately **not** proposed now: (a) per-branch structure for multi-branch chains is [SCALE] (roadmap "franchising/multi-branch hierarchy"); (b) slug-change history/redirects — revisit only if slug edits post-activation prove common.
