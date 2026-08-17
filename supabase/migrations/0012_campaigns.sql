-- ============================================================================
-- 0012_campaigns.sql
-- Campaigns domain: campaigns, promotions, points_rules, rewards,
-- reward_claims, redemptions, loyalty_programs, loyalty_cards,
-- points_transactions (the append-only ledger).
-- Source docs: docs/20-data/23-schema-campaigns.md, docs/20-data/20-data-model.md,
-- docs/10-architecture/12-multi-tenancy-rls.md.
-- Environment adaptations (same family as 0002/0007/0008/0010):
--   * uuid_generate_v7() -> private.uuid_generate_v7()
--   * doc 23's "-- +audit, +deleted_at" shorthand expanded to the standard
--     audit columns + touch trigger (+ deleted_at where marked);
--     points_transactions is immutable and gets NO updated_at, NO deleted_at,
--     NO touch trigger
--   * staff policies use the table-truth helper private.is_active_staff
--     (0010), not the claim-based private.is_staff_of
--   * public.receipts does not exist yet (receipts slice):
--     points_transactions.receipt_id is a bare uuid column; deferred FK noted
--     inline. Its indexes (pt_receipt_idx, pt_receipt_earn_once) exist now.
--   * circular FK: reward_claims.points_txn_id -> points_transactions(id) and
--     points_transactions.claim_id -> reward_claims(id). Both columns are
--     created bare and BOTH foreign keys are added via ALTER TABLE at the end
--     of this file, after both tables exist, so the file applies top to bottom
--   * composite (id, business_id) foreign keys on campaign/reward/program/claim
--     children for defense in depth against cross-tenant child injection,
--     per the 0008 pattern
-- ============================================================================

-- ============================================================ campaigns
-- Universal container. RLS: P1 (owner/manager/marketing write per matrix
-- "Create/edit campaigns"; public read of active rows).
create table public.campaigns (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  type         text not null check (type in
                 ('promotion','reward','discount','referral','event','seasonal',
                  'birthday','holiday','membership','loyalty')),
  status       text not null default 'draft' check (status in
                 ('draft','scheduled','active','paused','ended','archived')),
  name         text not null check (char_length(name) between 2 and 120),
  description  text check (char_length(description) <= 2000),
  image_url    text,                                   -- bucket: promotions
  starts_at    timestamptz,
  ends_at      timestamptz,
  timezone     text not null default 'Asia/Manila',
  -- recurrence for seasonal/holiday/happy-hour style campaigns [V1]
  recurrence   jsonb,                                  -- {rrule:"FREQ=WEEKLY;BYDAY=FR", windows:[{from:"11:00",to:"14:00"}]}
  -- targeting [V1]; empty = everyone
  audience     jsonb not null default '{}',            -- {segments:["vip"], min_visits:3, cities:[uuid], birthday_month:true}
  -- guardrails
  budget       jsonb not null default '{}',            -- {max_total_points:100000, max_redemptions:500, per_customer_limit:1}
  priority     integer not null default 100,           -- stacking order (34: lower wins ties)
  is_stackable boolean not null default false,         -- may combine with other campaigns (34)
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  -- composite target so payload children can enforce same-tenant parentage (0008 pattern)
  constraint campaigns_id_business_uniq unique (id, business_id)
);
alter table public.campaigns enable row level security;
create trigger touch_campaigns before update on public.campaigns
  for each row execute function private.touch_updated_at();

create index campaigns_biz_status_idx on public.campaigns (business_id, status, type)
  where deleted_at is null;
create index campaigns_active_window_idx on public.campaigns (status, starts_at, ends_at)
  where status in ('scheduled','active') and deleted_at is null;   -- scheduler sweep (39)

-- P1 + public read: anyone sees active, non-deleted campaigns (consumer app)
create policy campaigns_public_select on public.campaigns
  for select to anon, authenticated
  using (status = 'active' and deleted_at is null);
-- P1: staff of the tenant read their campaigns in any status (table-truth)
create policy campaigns_staff_select on public.campaigns
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager/marketing create campaigns in their own tenant
create policy campaigns_staff_insert on public.campaigns
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- P1: owner/manager/marketing update; with check pins business_id to own tenant
create policy campaigns_staff_update on public.campaigns
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']))
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ promotions
-- Display/offer payload for promotion-family campaigns (promotion, discount,
-- seasonal, holiday, event). RLS: P1 payload child.
create table public.promotions (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  campaign_id  uuid not null unique,
  offer_kind   text not null check (offer_kind in
                 ('percent_off','amount_off','bundle','freebie','announcement')),
  percent_off  integer check (percent_off between 1 and 100),
  amount_off_centavos integer check (amount_off_centavos > 0),
  freebie_text text,
  terms        text check (char_length(terms) <= 3000),
  product_ids  uuid[] not null default '{}',           -- scoped products (empty = storewide)
  redemption_hint text,                                 -- "Show this screen at the counter"
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  -- composite FK: the parent campaign must belong to the same tenant (0008 pattern)
  constraint promotions_campaign_business_fkey
    foreign key (campaign_id, business_id)
    references public.campaigns (id, business_id) on delete cascade
);
alter table public.promotions enable row level security;
create trigger touch_promotions before update on public.promotions
  for each row execute function private.touch_updated_at();

-- amendment: FK index per doc 20 convention (campaign_id is covered by its
-- unique constraint; business_id needs its own)
create index promotions_business_idx on public.promotions (business_id);

-- P1 + public read: anyone sees non-deleted promotion payloads. promotions has
-- has no status/is_active column of its own, so gate public visibility on the
-- parent campaign being active (an EXISTS subquery; acceptable here because a
-- business has only a handful of campaigns, unlike the points/receipt hot paths
-- doc 12's single-table rule targets). Without this a direct anon GET would leak
-- draft/scheduled/paused offer payloads. The composite FK still pins tenancy.
create policy promotions_public_select on public.promotions
  for select to anon, authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.campaigns c
      where c.id = campaign_id and c.status = 'active' and c.deleted_at is null
    )
  );
-- P1: staff of the tenant read their promotion payloads in any state
create policy promotions_staff_select on public.promotions
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager/marketing create (matrix "Create/edit campaigns")
create policy promotions_staff_insert on public.promotions
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- P1: owner/manager/marketing update; with check pins business_id to own tenant
create policy promotions_staff_update on public.promotions
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']))
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ points_rules
-- Earning math. Attached to a loyalty/membership campaign (or business default
-- rule). Exactly one base rule active per business at a time (partial unique
-- below); multiplier rules layer on top. Engine semantics: 35-points-engine.md.
create table public.points_rules (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  campaign_id  uuid,                                    -- null = business base rule
  kind         text not null check (kind in ('base','multiplier','bonus')),
  rule_type    text not null check (rule_type in
                 ('amount_rate','fixed_per_visit','fixed_per_receipt','tiered_amount')),
  -- amount_rate: points = floor(amount_centavos / rate_centavos_per_point)
  rate_centavos_per_point integer check (rate_centavos_per_point > 0),   -- e.g. 100 => 1 peso = 1pt; 500 => 100 pesos = 20pts
  -- fixed_per_visit / fixed_per_receipt:
  fixed_points integer check (fixed_points > 0),
  -- tiered_amount: [{min_centavos:0, max_centavos:19999, points:5}, ...]
  tiers        jsonb,
  -- multiplier/bonus conditions (35 defines the condition DSL):
  multiplier   numeric(4,2) check (multiplier > 0),                      -- e.g. 2.00 Friday double, 5.00 birthday
  bonus_points integer check (bonus_points > 0),
  conditions   jsonb not null default '{}',   -- {days:[5], time_from:"11:00", time_to:"14:00", birthday:true, min_amount_centavos:...}
  rounding     text not null default 'floor' check (rounding in ('floor','round','ceil')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  deleted_at   timestamptz,
  -- composite FK (0008 pattern). MATCH SIMPLE (default): a null campaign_id
  -- (business base rule) skips the check; a non-null one must be a same-tenant campaign.
  constraint points_rules_campaign_business_fkey
    foreign key (campaign_id, business_id)
    references public.campaigns (id, business_id) on delete cascade
);
alter table public.points_rules enable row level security;
create trigger touch_points_rules before update on public.points_rules
  for each row execute function private.touch_updated_at();

create unique index points_rules_one_base on public.points_rules (business_id)
  where kind = 'base' and is_active = true and deleted_at is null;
create index points_rules_biz_idx on public.points_rules (business_id) where is_active = true;
-- amendment: FK index per doc 20 convention (every FK indexed)
create index points_rules_campaign_idx on public.points_rules (campaign_id);

-- No public select: earning math is tenant configuration, and the whole ROW is
-- tenant configuration - `conditions` (the campaign targeting DSL) and
-- `created_by` / `updated_by` (both `uuid references auth.users(id)`) sit on it
-- alongside the rate. RLS cannot restrict columns, so any select policy here
-- publishes those too. That, not the rate itself, is why this table has no
-- consumer policy and should not grow one.
--
-- AMENDED (T4.6): one consumer surface now derives from this table, and it does
-- NOT go through a policy. `/scan` shows the signed-in consumer a
-- "~N pts at <shop>" estimate for the shop they are standing in, which is only
-- honest if it is computed under that shop's own base rule; the platform
-- default of 1 point per peso would quote a shop earning 1 point per PHP50
-- double what its receipts pay. Since no client role can read this table, the
-- app performs a narrow service-role read instead - see
-- src/features/receipts/server/preview-rule.ts, which selects exactly
-- `rate_centavos_per_point` and `rounding` for one business's single active
-- amount_rate base rule, and is gated on the caller's own RLS-scoped
-- `listActiveBusinesses` having already returned that business (see
-- src/app/(consumer)/scan/page.tsx, where the two reads are sequential for that
-- reason). What reaches the browser is the earning rate of a publicly listed
-- active shop: the number that shop advertises to the customers standing in it.
--
-- The right long-term shape is a two-column view over this table
-- (`business_id`, `rate_centavos_per_point`, `rounding`) joined to active
-- businesses, which discloses the rate without publishing `conditions` or the
-- two `auth.users` references. Until that exists, the sentence this comment
-- replaced ("Consumer-facing 'how you earn' copy is served by the app layer")
-- was true of the copy and false of the numbers.
-- P1: staff of the tenant read their rules in any state
create policy points_rules_staff_select on public.points_rules
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager create (matrix "Edit points rules")
create policy points_rules_staff_insert on public.points_rules
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
-- P1: owner/manager update; with check pins business_id to own tenant
create policy points_rules_staff_update on public.points_rules
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ rewards
-- Redeemable catalog item, payload of a reward-family campaign. RLS: P1 payload child.
create table public.rewards (
  id             uuid primary key default private.uuid_generate_v7(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  campaign_id    uuid not null,
  name           text not null check (char_length(name) between 2 and 120),
  description    text,
  image_url      text,                                  -- bucket: rewards
  points_cost    integer not null default 0 check (points_cost >= 0),  -- 0 = free claim (loyalty completion / gift)
  claim_kind     text not null default 'points' check (claim_kind in ('points','loyalty_completion','granted')),
  total_inventory integer check (total_inventory >= 0), -- null = unlimited
  remaining       integer check (remaining >= 0),       -- derived; maintained transactionally
  per_customer_limit integer not null default 1 check (per_customer_limit > 0),
  claim_expiry_days  integer not null default 30 check (claim_expiry_days between 1 and 365),
  terms          text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  updated_by     uuid references auth.users(id),
  deleted_at     timestamptz,
  constraint rewards_remaining_lte_total
    check (total_inventory is null or remaining is null or remaining <= total_inventory),
  -- composite FK: the parent campaign must belong to the same tenant (0008 pattern)
  constraint rewards_campaign_business_fkey
    foreign key (campaign_id, business_id)
    references public.campaigns (id, business_id) on delete cascade,
  -- composite target for loyalty_programs.reward_id / reward_claims.reward_id
  constraint rewards_id_business_uniq unique (id, business_id)
);
alter table public.rewards enable row level security;
create trigger touch_rewards before update on public.rewards
  for each row execute function private.touch_updated_at();

create index rewards_biz_idx on public.rewards (business_id) where is_active = true and deleted_at is null;
-- amendment: FK index per doc 20 convention (every FK indexed)
create index rewards_campaign_idx on public.rewards (campaign_id);

-- P1 + public read: anyone sees active, non-deleted rewards (consumer catalog);
-- the parent campaign additionally gates visibility at the app query layer
create policy rewards_public_select on public.rewards
  for select to anon, authenticated
  using (is_active = true and deleted_at is null);
-- P1: staff of the tenant read their rewards in any state
create policy rewards_staff_select on public.rewards
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager/marketing create (matrix "Create/edit campaigns")
create policy rewards_staff_insert on public.rewards
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- P1: owner/manager/marketing update; with check pins business_id to own tenant
create policy rewards_staff_update on public.rewards
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']))
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ reward_claims
-- Consumer claims a reward (locks points + inventory). RLS: P3 (consumer
-- self-read; staff read own tenant). All writes via the service layer.
create table public.reward_claims (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  reward_id    uuid not null,
  consumer_id  uuid not null references public.consumers(id),
  status       text not null default 'claimed' check (status in
                 ('claimed','redeemed','expired','cancelled')),
  points_spent integer not null default 0 check (points_spent >= 0),
  points_txn_id uuid,          -- the redeem ledger entry; FK added at end of file (circular with points_transactions)
  claimed_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  cancelled_reason text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  -- composite FK: the claimed reward must belong to the same tenant (0008 pattern)
  constraint reward_claims_reward_business_fkey
    foreign key (reward_id, business_id)
    references public.rewards (id, business_id),
  -- composite target for redemptions.claim_id
  constraint reward_claims_id_business_uniq unique (id, business_id)
);
alter table public.reward_claims enable row level security;
create trigger touch_reward_claims before update on public.reward_claims
  for each row execute function private.touch_updated_at();

create index reward_claims_consumer_idx on public.reward_claims (consumer_id, status);
create index reward_claims_biz_idx     on public.reward_claims (business_id, status, claimed_at desc);
create index reward_claims_expiry_idx  on public.reward_claims (expires_at)
  where status = 'claimed';                              -- expiry sweep (39)
-- amendment: FK indexes per doc 20 convention (every FK indexed)
create index reward_claims_reward_idx on public.reward_claims (reward_id);
create index reward_claims_points_txn_idx on public.reward_claims (points_txn_id);

-- P3: consumer sees own claims
create policy reward_claims_consumer_select on public.reward_claims
  for select to authenticated
  using (consumer_id = (select auth.uid()));
-- P3: tenant staff see claims for their business. All four roles: counter
-- staff look up claim state to validate (matrix "Validate redemption (QR)");
-- marketing reads for campaign performance.
create policy reward_claims_staff_select on public.reward_claims
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- No insert/update/delete policies for either audience: all writes go through
-- service-role code paths (claim service locks points + inventory atomically).

-- ============================================================ redemptions
-- The counter event: staff validates a claim. One claim has at most one
-- redemption (claim_id unique). RLS: staff read own tenant; writes service-role.
create table public.redemptions (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  claim_id      uuid not null unique,
  validated_by  uuid not null references public.profiles(id),    -- staff member
  method        text not null default 'qr' check (method in ('qr','manual_code')),
  token_jti     text unique,                                     -- consumed one-time token id
  redeemed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  -- composite FK: the validated claim must belong to the same tenant (0008 pattern)
  constraint redemptions_claim_business_fkey
    foreign key (claim_id, business_id)
    references public.reward_claims (id, business_id)
);
alter table public.redemptions enable row level security;
create trigger touch_redemptions before update on public.redemptions
  for each row execute function private.touch_updated_at();

create index redemptions_biz_idx on public.redemptions (business_id, redeemed_at desc);
-- amendment: FK index per doc 20 convention (every FK indexed)
create index redemptions_validated_by_idx on public.redemptions (validated_by);

-- P3 (staff half only): tenant staff see redemptions for their business.
-- All four roles: counter staff see their validations (daily dashboard).
create policy redemptions_staff_select on public.redemptions
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- No insert/update/delete policies: redemption validation writes go through
-- the service-role redemption flow (token check + claim status flip + ledger).

-- ============================================================ loyalty_programs
-- Progress-based program, payload of a loyalty/membership campaign. RLS: P1 payload child.
create table public.loyalty_programs (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  campaign_id   uuid not null unique,
  program_type  text not null check (program_type in
                  ('visit_count','points_target','receipt_count','spend_amount','custom')),
  target_value  integer not null check (target_value > 0),   -- e.g. 10 visits / 500 pts / 5000 pesos (centavos/100)
  reward_id     uuid not null,                               -- completion prize (claim_kind='loyalty_completion')
  stamp_icon    text,                                        -- card art
  card_style    jsonb not null default '{}',                 -- colors/animation prefs
  min_amount_per_stamp_centavos integer,                     -- anti-gaming floor per qualifying visit
  max_stamps_per_day integer not null default 1,
  resets_on_completion boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  deleted_at    timestamptz,
  -- composite FKs: parent campaign and prize reward must be same-tenant (0008 pattern)
  constraint loyalty_programs_campaign_business_fkey
    foreign key (campaign_id, business_id)
    references public.campaigns (id, business_id) on delete cascade,
  constraint loyalty_programs_reward_business_fkey
    foreign key (reward_id, business_id)
    references public.rewards (id, business_id),
  -- composite target for loyalty_cards.program_id
  constraint loyalty_programs_id_business_uniq unique (id, business_id)
);
alter table public.loyalty_programs enable row level security;
create trigger touch_loyalty_programs before update on public.loyalty_programs
  for each row execute function private.touch_updated_at();

-- amendment: FK indexes per doc 20 convention (campaign_id covered by its
-- unique constraint)
create index loyalty_programs_business_idx on public.loyalty_programs (business_id);
create index loyalty_programs_reward_idx on public.loyalty_programs (reward_id);

-- P1 + public read: gate on the parent campaign being active (same reasoning as
-- promotions_public_select) so draft/inactive program payloads never leak to anon.
create policy loyalty_programs_public_select on public.loyalty_programs
  for select to anon, authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.campaigns c
      where c.id = campaign_id and c.status = 'active' and c.deleted_at is null
    )
  );
-- P1: staff of the tenant read their programs in any state
create policy loyalty_programs_staff_select on public.loyalty_programs
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing','staff']));
-- P1: owner/manager/marketing create (payload of a campaign; matrix "Create/edit campaigns")
create policy loyalty_programs_staff_insert on public.loyalty_programs
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- P1: owner/manager/marketing update; with check pins business_id to own tenant
create policy loyalty_programs_staff_update on public.loyalty_programs
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']))
  with check (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No delete policy: soft delete via update (deleted_at).

-- ============================================================ loyalty_cards
-- A consumer's progress in a program. RLS: P3 (consumer self-read; staff read
-- own tenant). Stamps/progress written only by the service layer.
create table public.loyalty_cards (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  program_id    uuid not null,
  consumer_id   uuid not null references public.consumers(id) on delete cascade,
  progress      integer not null default 0 check (progress >= 0),
  completed_count integer not null default 0,               -- times completed (for resets)
  last_stamp_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  unique (program_id, consumer_id),
  -- composite FK: the program must belong to the same tenant (0008 pattern)
  constraint loyalty_cards_program_business_fkey
    foreign key (program_id, business_id)
    references public.loyalty_programs (id, business_id) on delete cascade
);
alter table public.loyalty_cards enable row level security;
create trigger touch_loyalty_cards before update on public.loyalty_cards
  for each row execute function private.touch_updated_at();

create index loyalty_cards_consumer_idx on public.loyalty_cards (consumer_id);
create index loyalty_cards_biz_idx on public.loyalty_cards (business_id, program_id);

-- P3: consumer sees own cards
create policy loyalty_cards_consumer_select on public.loyalty_cards
  for select to authenticated
  using (consumer_id = (select auth.uid()));
-- P3: tenant staff see cards for their business (CRM surface, same roles as
-- business_customers)
create policy loyalty_cards_staff_select on public.loyalty_cards
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No insert/update/delete policies for either audience: stamping and resets go
-- through service-role code paths so anti-gaming rules cannot be bypassed.

-- ============================================================ points_transactions
-- THE LEDGER. Append-only. No UPDATE/DELETE privileges for any role, including
-- service_role (revoked below + a BEFORE UPDATE/DELETE trigger that raises;
-- corrections are compensating entries per doc 20).
-- RLS: P3 select (consumer own rows; staff own tenant); INSERT only via the
-- points service (service role); no client write policies.
create table public.points_transactions (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id),
  consumer_id   uuid not null references public.consumers(id),
  type          text not null check (type in
                  ('earn','redeem','adjust','expire','clawback','reversal','referral_bonus')),
  points        integer not null check (points <> 0),   -- signed: earn>0, redeem/expire/clawback<0
  balance_after integer not null check (balance_after >= 0),  -- snapshot for statements
  -- provenance (exactly one source per type; enforced in service)
  receipt_id    uuid,   -- deferred FK: references public.receipts(id) once the receipts slice lands
  claim_id      uuid,   -- FK added at end of file (circular with reward_claims)
  campaign_id   uuid references public.campaigns(id),
  rule_snapshot jsonb,                                   -- the rule(s) applied, frozen (35)
  reverses_id   uuid references public.points_transactions(id),  -- for reversal/clawback
  adjust_reason text,                                    -- required for adjust (service-enforced)
  actor_id      uuid references public.profiles(id),     -- staff/admin for manual ops; null = system
  expires_at    timestamptz,                             -- for earn rows: when these points lapse (35 FIFO)
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
  -- NO updated_at/deleted_at: immutable (and no touch trigger)
);
alter table public.points_transactions enable row level security;

create index pt_consumer_biz_idx on public.points_transactions (consumer_id, business_id, created_at desc);
create index pt_biz_created_idx  on public.points_transactions (business_id, created_at desc);
create index pt_receipt_idx      on public.points_transactions (receipt_id) where receipt_id is not null;
create index pt_expiry_idx       on public.points_transactions (business_id, expires_at)
  where type = 'earn' and expires_at is not null;        -- expiry sweep
create unique index pt_receipt_earn_once on public.points_transactions (receipt_id)
  where type = 'earn';                                   -- one earn per receipt, DB-enforced
-- amendment: FK indexes per doc 20 convention (every FK indexed)
create index pt_claim_idx    on public.points_transactions (claim_id);
create index pt_campaign_idx on public.points_transactions (campaign_id);
create index pt_reverses_idx on public.points_transactions (reverses_id);
create index pt_actor_idx    on public.points_transactions (actor_id);

-- ---------------------------------------------------------------- immutability
-- Belt and suspenders per doc 23 integrity table: privilege revocation stops
-- app roles for row DML; the row trigger stops anyone who still holds
-- update/delete (service_role, table owner). Corrections are compensating
-- entries (reversal/adjust), never mutations.
create or replace function private.points_transactions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'points_transactions is append-only';
end
$$;

create trigger points_transactions_append_only
  before update or delete on public.points_transactions
  for each row execute function private.points_transactions_append_only();

-- A row-level trigger does NOT fire on TRUNCATE, so a bulk wipe would bypass the
-- guard above. Block it two ways: revoke the privilege from every app role and
-- add a statement-level BEFORE TRUNCATE trigger that raises (catches the table
-- owner / any future misgrant).
create or replace function private.points_transactions_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'points_transactions cannot be truncated (append-only ledger)';
end
$$;

create trigger points_transactions_no_truncate
  before truncate on public.points_transactions
  for each statement execute function private.points_transactions_no_truncate();

-- Supabase default privileges grant all on new public tables to app roles;
-- strip update/delete/truncate from every one of them (service_role included,
-- doc 23: no row mutation for ANY role).
revoke update, delete, truncate on public.points_transactions from anon, authenticated, service_role;

-- P3: consumer sees own ledger rows
create policy pt_consumer_select on public.points_transactions
  for select to authenticated
  using (consumer_id = (select auth.uid()));
-- P3: tenant staff see their business ledger
create policy pt_staff_select on public.points_transactions
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No insert/update/delete policies for client roles: only the points service
-- (service role) inserts, in the same transaction that maintains
-- business_customers.points_balance.

-- ---------------------------------------------------------------- circular FK
-- reward_claims.points_txn_id and points_transactions.claim_id reference each
-- other. Both columns were created bare above; both foreign keys are added
-- here, after both tables exist, so this file applies cleanly top to bottom.
alter table public.reward_claims
  add constraint reward_claims_points_txn_fkey
    foreign key (points_txn_id) references public.points_transactions (id);
alter table public.points_transactions
  add constraint points_transactions_claim_fkey
    foreign key (claim_id) references public.reward_claims (id);
