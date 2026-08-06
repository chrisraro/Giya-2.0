# 23 — Schema: Campaigns, Points, Rewards, Loyalty

The core domain. Engine semantics in `30-modules/34-campaign-engine.md` and `35-points-engine.md`; this file is the storage contract. Conventions per `20-data-model.md`.

## Model in one paragraph

**Everything is a campaign.** A `campaigns` row is the universal container (type, lifecycle, schedule, targeting, budget). Type-specific payloads hang off it: `promotions` (display/offer detail), `rewards` (redeemable catalog items), `loyalty_programs` (progress-based programs), `points_rules` (earning math). Consumers interact through `reward_claims`/`redemptions`, `loyalty_cards`, and the append-only `points_transactions` ledger.

```sql
-- ============================================================ campaigns
-- Universal container. RLS: P1 (owner/manager/marketing write per matrix; public read active).
create table public.campaigns (
  id           uuid primary key default uuid_generate_v7(),
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
  check (ends_at is null or starts_at is null or ends_at > starts_at)
  -- +audit, +deleted_at
);
create index campaigns_biz_status_idx on public.campaigns (business_id, status, type)
  where deleted_at is null;
create index campaigns_active_window_idx on public.campaigns (status, starts_at, ends_at)
  where status in ('scheduled','active','paused') and deleted_at is null;   -- scheduler sweep (39)
  -- 'paused' added by task 2.1 (supabase/migrations/0053_campaigns_sweep.sql):
  -- the sweep's T7 (`active|paused -> ended`) needs paused rows indexed too,
  -- which the original two-status predicate excluded.

-- ============================================================ promotions
-- Display/offer payload for promotion-family campaigns (promotion, discount, seasonal, holiday, event).
create table public.promotions (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  campaign_id  uuid not null unique references public.campaigns(id) on delete cascade,
  offer_kind   text not null check (offer_kind in
                 ('percent_off','amount_off','bundle','freebie','announcement')),
  percent_off  integer check (percent_off between 1 and 100),
  amount_off_centavos integer check (amount_off_centavos > 0),
  freebie_text text,
  terms        text check (char_length(terms) <= 3000),
  product_ids  uuid[] not null default '{}',           -- scoped products (empty = storewide)
  redemption_hint text                                  -- "Show this screen at the counter"
  -- +audit, +deleted_at
);

-- ============================================================ points_rules
-- Earning math. Attached to a loyalty/membership campaign (or business default rule).
-- Exactly one base rule active per business at a time (partial unique below);
-- multiplier rules layer on top. Engine semantics: 35-points-engine.md.
create table public.points_rules (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  campaign_id  uuid references public.campaigns(id) on delete cascade,  -- null = business base rule
  kind         text not null check (kind in ('base','multiplier','bonus')),
  rule_type    text not null check (rule_type in
                 ('amount_rate','fixed_per_visit','fixed_per_receipt','tiered_amount')),
  -- amount_rate:      points = floor(amount_centavos / rate_centavos_per_point)
  rate_centavos_per_point integer check (rate_centavos_per_point > 0),   -- e.g. 100 => ₱1 = 1pt; 500 => ₱100 = 20pts
  -- fixed_per_visit / fixed_per_receipt:
  fixed_points integer check (fixed_points > 0),
  -- tiered_amount: [{min_centavos:0, max_centavos:19999, points:5}, …]
  tiers        jsonb,
  -- multiplier/bonus conditions (35 defines the condition DSL):
  multiplier   numeric(4,2) check (multiplier > 0),                      -- e.g. 2.00 Friday double, 5.00 birthday
  bonus_points integer check (bonus_points > 0),
  conditions   jsonb not null default '{}',   -- {days:[5], time_from:"11:00", time_to:"14:00", birthday:true, min_amount_centavos:…}
  rounding     text not null default 'floor' check (rounding in ('floor','round','ceil')),
  is_active    boolean not null default true
  -- +audit, +deleted_at
);
create unique index points_rules_one_base on public.points_rules (business_id)
  where kind = 'base' and is_active = true and deleted_at is null;
create index points_rules_biz_idx on public.points_rules (business_id) where is_active = true;

-- ============================================================ rewards
-- Redeemable catalog item, payload of a reward-family campaign.
create table public.rewards (
  id             uuid primary key default uuid_generate_v7(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  campaign_id    uuid not null references public.campaigns(id) on delete cascade,
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
  is_active      boolean not null default true
  -- +audit, +deleted_at
);
create index rewards_biz_idx on public.rewards (business_id) where is_active = true and deleted_at is null;
alter table public.rewards add constraint rewards_remaining_lte_total
  check (total_inventory is null or remaining is null or remaining <= total_inventory);

-- ============================================================ reward_claims
-- Consumer claims a reward (locks points + inventory). RLS: P3 (consumer self-read;
-- staff read own tenant). All writes via service layer.
create table public.reward_claims (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  reward_id    uuid not null references public.rewards(id),
  consumer_id  uuid not null references public.consumers(id),
  status       text not null default 'claimed' check (status in
                 ('claimed','redeemed','expired','cancelled')),
  points_spent integer not null default 0 check (points_spent >= 0),
  points_txn_id uuid references public.points_transactions(id),  -- the redeem ledger entry
  claimed_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  cancelled_reason text
  -- +audit
);
create index reward_claims_consumer_idx on public.reward_claims (consumer_id, status);
create index reward_claims_biz_idx     on public.reward_claims (business_id, status, claimed_at desc);
create index reward_claims_expiry_idx  on public.reward_claims (expires_at)
  where status = 'claimed';                              -- expiry sweep (39)

-- ============================================================ redemptions
-- The counter event: staff validates a claim. One claim → ≤1 redemption.
create table public.redemptions (
  id            uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  claim_id      uuid not null unique references public.reward_claims(id),
  validated_by  uuid not null references public.profiles(id),    -- staff member
  method        text not null default 'qr' check (method in ('qr','manual_code')),
  token_jti     text unique,                                     -- consumed one-time token id
  redeemed_at   timestamptz not null default now()
  -- +audit
);
create index redemptions_biz_idx on public.redemptions (business_id, redeemed_at desc);

-- ============================================================ loyalty_programs
-- Progress-based program, payload of a loyalty/membership campaign.
create table public.loyalty_programs (
  id            uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  campaign_id   uuid not null unique references public.campaigns(id) on delete cascade,
  program_type  text not null check (program_type in
                  ('visit_count','points_target','receipt_count','spend_amount','custom')),
  target_value  integer not null check (target_value > 0),   -- e.g. 10 visits / 500 pts / ₱5000 (centavos/100)
  reward_id     uuid not null references public.rewards(id), -- completion prize (claim_kind='loyalty_completion')
  stamp_icon    text,                                        -- card art
  card_style    jsonb not null default '{}',                 -- colors/animation prefs
  min_amount_per_stamp_centavos integer,                     -- anti-gaming floor per qualifying visit
  max_stamps_per_day integer not null default 1,
  resets_on_completion boolean not null default true
  -- +audit, +deleted_at
);

-- ============================================================ loyalty_cards
-- A consumer's progress in a program. RLS: P3.
create table public.loyalty_cards (
  id            uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  program_id    uuid not null references public.loyalty_programs(id) on delete cascade,
  consumer_id   uuid not null references public.consumers(id) on delete cascade,
  progress      integer not null default 0 check (progress >= 0),
  completed_count integer not null default 0,               -- times completed (for resets)
  last_stamp_at timestamptz,
  unique (program_id, consumer_id)
  -- +audit
);
create index loyalty_cards_consumer_idx on public.loyalty_cards (consumer_id);
create index loyalty_cards_biz_idx on public.loyalty_cards (business_id, program_id);

-- ============================================================ points_transactions
-- THE LEDGER. Append-only. No UPDATE/DELETE grants for any role, including service_role
-- (enforced by revoking table privileges + a BEFORE UPDATE/DELETE trigger that raises).
-- RLS: P3 select (consumer own rows; staff own tenant); INSERT only via points service.
create table public.points_transactions (
  id            uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id),
  consumer_id   uuid not null references public.consumers(id),
  type          text not null check (type in
                  ('earn','redeem','adjust','expire','clawback','reversal','referral_bonus')),
  points        integer not null check (points <> 0),   -- signed: earn>0, redeem/expire/clawback<0
  balance_after integer not null check (balance_after >= 0),  -- snapshot for statements
  -- provenance (exactly one source per type; enforced in service + check below)
  receipt_id    uuid references public.receipts(id),
  claim_id      uuid references public.reward_claims(id),
  campaign_id   uuid references public.campaigns(id),
  rule_snapshot jsonb,                                   -- the rule(s) applied, frozen (35)
  reverses_id   uuid references public.points_transactions(id),  -- for reversal/clawback
  adjust_reason text,                                    -- required for adjust (service-enforced)
  actor_id      uuid references public.profiles(id),     -- staff/admin for manual ops; null = system
  expires_at    timestamptz,                             -- for earn rows: when these points lapse (35 FIFO)
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
  -- NO updated_at/deleted_at: immutable
);
create index pt_consumer_biz_idx on public.points_transactions (consumer_id, business_id, created_at desc);
create index pt_biz_created_idx  on public.points_transactions (business_id, created_at desc);
create index pt_receipt_idx      on public.points_transactions (receipt_id) where receipt_id is not null;
create index pt_expiry_idx       on public.points_transactions (business_id, expires_at)
  where type = 'earn' and expires_at is not null;        -- expiry sweep
create unique index pt_receipt_earn_once on public.points_transactions (receipt_id)
  where type = 'earn';                                   -- one earn per receipt, DB-enforced
```

## Integrity rules (DB-level summary)

| Invariant | Enforcement |
|---|---|
| One earn per receipt | partial unique index `pt_receipt_earn_once` |
| Ledger immutable | revoked UPDATE/DELETE + raising trigger |
| Balance never negative | `balance_after >= 0` check + service serializes per (consumer,business) via Redis lock + `select … for update` on `business_customers` |
| One redemption per claim | `redemptions.claim_id` unique |
| Reward stock never oversold | service decrements `remaining` with `where remaining > 0` conditional update inside the claim transaction |
| One active base points rule per business | partial unique index |
| One loyalty card per consumer per program | unique `(program_id, consumer_id)` |

## Type → payload mapping (engine contract)

| campaign.type | Required payload row | Notes |
|---|---|---|
| `promotion`,`discount`,`seasonal`,`holiday`,`event` | `promotions` | display + offer |
| `reward` | `rewards` (≥1) | catalog entries |
| `loyalty`,`membership` | `loyalty_programs` (+ its `rewards` prize, optional `points_rules`) | |
| `birthday` | `points_rules` (multiplier w/ `conditions.birthday=true`) and/or `rewards` | |
| `referral` | `points_rules` (kind=`bonus`) — both referrer and referee bonuses in `conditions` | `[V1]` |

Enforced by the campaign service on activation (a campaign cannot go `active` without its payload complete — `34-campaign-engine.md` state machine).
