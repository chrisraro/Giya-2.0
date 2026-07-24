# 25 — Schema: Platform (Notifications, Reviews, CMS, QRs, Jobs, Audit, Flags)

Conventions per `20-data-model.md`.

```sql
-- ============================================================ notifications
-- One row per recipient per message. RLS: P2 select/update(read_at) own; writes service-only.
create table public.notifications (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  business_id  uuid references public.businesses(id) on delete set null,  -- sender tenant (null = platform)
  campaign_id  uuid references public.campaigns(id) on delete set null,   -- marketing sends
  channel      text not null check (channel in ('push','email','in_app')),
  status       text not null default 'pending' check (status in
                 ('pending','sent','delivered','failed','read')),
  kind         text not null,            -- registry: points_awarded, receipt_rejected, reward_claimed,
                                         -- reward_expiring, campaign_push, announcement, staff_invite, …
  title        text not null,
  body         text not null,
  data         jsonb not null default '{}',    -- deep-link payload {route, params}
  error        text,
  sent_at      timestamptz,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx on public.notifications (user_id)
  where read_at is null and channel = 'in_app';
create index notifications_campaign_idx on public.notifications (campaign_id)
  where campaign_id is not null;                        -- campaign delivery stats

-- ============================================================ favorites
create table public.favorites (           -- RLS: P2
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references public.consumers(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  reward_id   uuid references public.rewards(id) on delete cascade,
  created_at  timestamptz not null default now(),
  check (num_nonnulls(business_id, reward_id) = 1),
  unique (user_id, business_id, reward_id)
);
create index favorites_user_idx on public.favorites (user_id, created_at desc);

-- ============================================================ reviews
-- RLS: consumer CRUD own (published window); public read published; staff read own tenant;
-- admin moderate. One review per consumer per business, editable.
create table public.reviews (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  consumer_id  uuid not null references public.consumers(id) on delete cascade,
  rating       integer not null check (rating between 1 and 5),
  comment      text check (char_length(comment) <= 2000),
  photos       jsonb not null default '[]',
  status       text not null default 'published' check (status in ('published','flagged','removed')),
  is_verified_customer boolean not null default false,  -- had ≥1 approved receipt at review time
  reply_text   text,                                    -- single business reply
  replied_by   uuid references public.profiles(id),
  replied_at   timestamptz,
  flagged_reason text,
  unique (business_id, consumer_id)
  -- +audit, +deleted_at
);
create index reviews_biz_idx on public.reviews (business_id, status, created_at desc);

-- ============================================================ qr_codes
-- RLS: P1 manage; resolution is public via short code endpoint.
create table public.qr_codes (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  qr_type      text not null check (qr_type in ('business','campaign','reward','menu')),
  target_id    uuid,                                    -- campaign/reward id (null for business/menu)
  short_code   text not null unique default private.gen_short_code(),  -- 10-char base58 → giya.ph/q/{code}
  label        text,
  scan_count   integer not null default 0,
  is_active    boolean not null default true
  -- +audit, +deleted_at
);
create index qr_codes_biz_idx on public.qr_codes (business_id, qr_type);
-- NOTE: reward redemption QRs shown by consumers are ephemeral signed tokens (15-security.md),
-- NOT rows here. qr_codes.reward type = printable marketing QR linking to the reward page.

-- ============================================================ CMS: announcements / faqs / cms_pages / banners
-- RLS: P4 (public read published; admin write via service).
create table public.announcements (
  id         uuid primary key default uuid_generate_v7(),
  title      text not null,
  body       text not null,                             -- markdown
  image_url  text,                                      -- bucket: announcements
  audience   text not null default 'all' check (audience in ('all','consumers','businesses')),
  status     text not null default 'draft' check (status in ('draft','published','archived')),
  publish_at timestamptz,
  expires_at timestamptz
  -- +audit, +deleted_at
);
create table public.faqs (
  id         uuid primary key default uuid_generate_v7(),
  audience   text not null default 'all' check (audience in ('all','consumers','businesses')),
  category   text not null,
  question   text not null,
  answer     text not null,                             -- markdown
  sort       integer not null default 0,
  status     text not null default 'published' check (status in ('draft','published','archived'))
  -- +audit, +deleted_at
);
create table public.cms_pages (                          -- terms, privacy, help articles, tutorials, news
  id         uuid primary key default uuid_generate_v7(),
  slug       text not null unique,                       -- 'terms', 'privacy', 'help/scanning'
  kind       text not null check (kind in ('legal','help','tutorial','news')),
  title      text not null,
  body       text not null,                              -- markdown
  version    integer not null default 1,                 -- bumped on legal changes (re-consent hook)
  status     text not null default 'draft' check (status in ('draft','published','archived')),
  published_at timestamptz
  -- +audit, +deleted_at
);
create table public.banners (                            -- home-screen promo banners
  id         uuid primary key default uuid_generate_v7(),
  image_url  text not null,
  link_url   text,
  audience   text not null default 'consumers' check (audience in ('all','consumers','businesses')),
  sort       integer not null default 0,
  status     text not null default 'draft' check (status in ('draft','published','archived')),
  starts_at  timestamptz, ends_at timestamptz
  -- +audit, +deleted_at
);

-- ============================================================ tags (generic content tags, admin-managed)
create table public.tags (
  id uuid primary key default uuid_generate_v7(),
  name text not null unique, slug text not null unique, kind text not null default 'general'
  -- +audit
);

-- ============================================================ feature_flags
-- RLS: read all authenticated (evaluation client-side + server-side); write super_admin service.
create table public.feature_flags (
  key          text primary key,                        -- 'ai_assistant', 'offline_sync', …
  description  text not null,
  is_enabled   boolean not null default false,
  rollout      jsonb not null default '{}'              -- {percent:25, business_ids:[…], plans:["growth"], beta:true}
  -- +audit
);

-- ============================================================ settings
-- Platform-wide + per-business settings (typed via Zod at app layer).
create table public.settings (                           -- RLS: platform rows admin-only; business rows P1 owner
  id           uuid primary key default uuid_generate_v7(),
  scope        text not null check (scope in ('platform','business')),
  business_id  uuid references public.businesses(id) on delete cascade,
  key          text not null,
  value        jsonb not null,
  unique (scope, business_id, key),
  check ((scope = 'platform') = (business_id is null))
  -- +audit
);

-- ============================================================ audit_logs
-- Insert-only. RLS: select admin; select owner where business_id matches; no update/delete grants.
create table public.audit_logs (
  id           uuid primary key default uuid_generate_v7(),
  actor_id     uuid references public.profiles(id),     -- null = system/worker
  actor_kind   text not null check (actor_kind in ('user','admin','system','worker')),
  actor_role   text,
  business_id  uuid,                                    -- no FK: log survives tenant hard-purge
  action       text not null,                           -- verb registry: 'campaign.activated', 'staff.role_changed', …
  entity_type  text not null,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  reason       text,                                    -- required for admin overrides (service-enforced)
  request_id   text,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index audit_biz_idx    on public.audit_logs (business_id, created_at desc);
create index audit_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_actor_idx  on public.audit_logs (actor_id, created_at desc);

-- ============================================================ jobs
-- Durable job record mirroring queue state (Postgres = truth; QStash = delivery). Service-only.
create table public.jobs (
  id           uuid primary key default uuid_generate_v7(),
  queue        text not null,                           -- 'ocr.process', 'notify.push', … (39 registry)
  status       text not null default 'queued' check (status in
                 ('queued','running','succeeded','failed','dead')),
  payload      jsonb not null,
  business_id  uuid,
  dedupe_key   text,
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  last_error   text,
  scheduled_at timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);
create unique index jobs_dedupe_idx on public.jobs (queue, dedupe_key)
  where dedupe_key is not null and status in ('queued','running');
create index jobs_queue_status_idx on public.jobs (queue, status, scheduled_at);

-- ============================================================ exports
create table public.exports (                            -- RLS: requester reads own; admin all
  id           uuid primary key default uuid_generate_v7(),
  requested_by uuid not null references public.profiles(id),
  business_id  uuid references public.businesses(id),
  kind         text not null,                           -- 'customers_csv','campaign_report','my_data', …
  params       jsonb not null default '{}',
  status       text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  storage_path text,                                    -- bucket: exports (7-day TTL cleanup)
  error        text
  -- +audit
);

-- ============================================================ feedback
create table public.feedback (                           -- in-app feedback/bug reports. RLS: P2 insert/read own; admin all
  id         uuid primary key default uuid_generate_v7(),
  user_id    uuid references public.profiles(id) on delete set null,
  category   text not null check (category in ('bug','idea','complaint','praise','other')),
  message    text not null,
  context    jsonb not null default '{}',               -- route, app version, device
  status     text not null default 'new' check (status in ('new','triaged','closed'))
  -- +audit
);

-- ============================================================ analytics_daily_business
-- Pre-aggregated rollups (40-analytics.md). Written by nightly job; RLS: staff read own tenant.
create table public.analytics_daily_business (
  business_id     uuid not null references public.businesses(id) on delete cascade,
  day             date not null,
  receipts_approved integer not null default 0,
  receipts_rejected integer not null default 0,
  gross_sales_centavos bigint not null default 0,       -- from approved receipt totals
  points_earned   integer not null default 0,
  points_redeemed integer not null default 0,
  new_customers   integer not null default 0,
  returning_customers integer not null default 0,
  rewards_claimed integer not null default 0,
  rewards_redeemed integer not null default 0,
  ai_questions    integer not null default 0,
  primary key (business_id, day)
);
```

## Registry notes

- **`notifications.kind` registry** lives in `src/features/notifications/kinds.ts` with per-kind template + deep link; adding a kind is code + doc, not schema.
- **`audit_logs.action` registry** in `src/lib/audit/actions.ts` — dot-namespaced verbs; free-text actions are lint-rejected.
- **`jobs`** is the durable mirror; queue mechanics and the queue-name registry live in `39-background-jobs.md`.
- Every table above has RLS enabled; patterns cited inline per `12-multi-tenancy-rls.md`.
