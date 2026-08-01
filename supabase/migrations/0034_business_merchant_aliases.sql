-- ============================================================================
-- 0034_business_merchant_aliases.sql
-- Merchant name aliases, scoped to the BUSINESS rather than to a layout.
--
-- WHY THIS TABLE EXISTS AT ALL.
--
-- The foreign-receipt hole: doc 36 Stage 5 runs a pre-bound scan as
-- verification, but the pipeline's candidate set for a pre-bound receipt is
-- the pre-bound business and nothing else, so the contradiction path can never
-- fire, the 0.85 pre-bound floor is always the score, and 0.85 is exactly the
-- accept threshold. Every pre-bound receipt accepted. Buy food at a
-- competitor, open Giya, tap a merchant, scan the competitor's slip: fresh,
-- unique, under the ceiling, approved. A merchant's points liability funded by
-- purchases at their rivals, with no forgery required.
--
-- The fix is a merchant-name check that routes a mismatch (and an UNREADABLE
-- name, which must not silently mean "passed") to human review, best-of across
-- the business name and every alias, at a deliberately generous threshold. It
-- is enforced from receipt one, with no grace period: a grace period leaves the
-- hole open exactly when a shop is too new to notice leakage, and removes any
-- reason to ever configure an alias at all.
--
-- WHY THE ALIASES CANNOT LIVE WHERE THEY LIVE TODAY.
--
-- `merchant_aliases` is a key of `receipt_templates.parse_config` (0017, doc 36
-- Stage 6). That is the wrong home for two independent reasons, and the first
-- one is fatal rather than merely untidy:
--
--   * A BRAND NEW MERCHANT HAS NO TEMPLATE. The template management UI does not
--     exist yet, so `receipt_templates` is empty for essentially every business
--     on the platform. The review queue is supposed to TEACH aliases - the
--     reviewer taps "this is my receipt header, always accept it" and the shop
--     self-tunes after a few reviews - and there is nowhere on a template-less
--     business to put what was learned. The exact case this feature exists for
--     is the case with no storage.
--   * AN ALIAS IS NOT A PROPERTY OF A LAYOUT. A shop can print from a POS and
--     also write on a handwritten pad, which is two templates, but its NAME on
--     both is the same name. Storing the alias per template means teaching it
--     twice and means a receipt that matched no template gets no aliases at
--     all, even though the name check runs whether or not a template matched.
--
-- So the alias belongs to the business. `receipt_templates.parse_config
-- .merchant_aliases` is NOT dropped and NOT migrated: it keeps working exactly
-- as it does today (the pipeline unions the two sources), because it is a
-- documented part of doc 36's `parse_config` spec and a merchant who has
-- configured one should not lose it. This table is where a LEARNED alias goes,
-- and it is the only source that exists for a business with no template.
--
-- WHY A TABLE RATHER THAN A `businesses.merchant_aliases text[]` COLUMN.
-- An array column would be one fewer read on the money path, but appending to
-- it is a read-modify-write: two reviewers tapping "always accept" on two
-- receipts in the same second lose one of the two aliases, silently, and the
-- merchant never learns which. A row with a unique index is an
-- `insert ... on conflict do nothing`, which is atomic, idempotent (the same
-- tap twice is a no-op rather than a duplicate) and race-free with no lock and
-- no RPC. It also carries the provenance an array cannot: who taught this
-- alias, when, and off which receipt - which is the first question anyone will
-- ask when an alias turns out to be wrong.
--
-- Source docs: docs/30-modules/36-receipt-ocr-pipeline.md Stage 5 (the scoring
-- table and the `parse_config` spec), docs/30-modules/37-fraud-detection.md
-- (review queues), docs/20-data/24-schema-receipts-ai.md.
--
-- amendment: no doc registers this table yet. It is recorded here for the next
-- docs pass alongside doc 26's existing amendments.
--
-- Conventions per 0017/0024/0032: three-layer fence (RLS policy, table
-- privileges, and an explicit truncate revoke, because RLS never sees a
-- TRUNCATE).
-- ============================================================================

-- ------------------------------------------------- business_merchant_aliases
create table public.business_merchant_aliases (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  -- The header VERBATIM, as it was read off the paper or typed by staff. Kept
  -- unnormalized because it is what a reviewer is shown when asked whether the
  -- alias is still right, and because a normalization we change later must be
  -- recomputable from the original rather than from its own output.
  alias         text not null check (char_length(btrim(alias)) between 2 and 200),
  -- The comparison form, and the ONLY thing uniqueness is decided on. This is
  -- `normalizeForMatch` in src/features/receipts/matching.ts expressed in SQL,
  -- character for character: uppercase, every run of non-alphanumerics
  -- collapsed to a single space, trimmed. Generated rather than written by the
  -- application so the two forms can never disagree, and so a future writer
  -- (an admin tool, a support script, a bulk import) cannot insert a row that
  -- the matcher will not find.
  alias_normalized text generated always as (
    btrim(regexp_replace(upper(alias), '[^A-Z0-9]+', ' ', 'g'))
  ) stored,
  -- 'learned' came from the review queue's one-tap affordance; 'configured'
  -- was entered deliberately. They are told apart because a learned alias is
  -- only ever as good as the OCR that produced it, and an audit of which
  -- aliases widened a merchant's acceptance has to be able to separate them.
  source        text not null default 'learned'
                  check (source in ('learned','configured')),
  -- The receipt the alias was taught from. Nullable, and ON DELETE SET NULL:
  -- the alias outlives the receipt, and losing the provenance must never
  -- silently narrow what a merchant already accepts.
  receipt_id    uuid references public.receipts(id) on delete set null,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);

-- An empty or whitespace-only normalization would match every unreadable
-- header, which is the exact case the check is built to catch. The generated
-- column cannot carry its own check in every Postgres version, so it is
-- asserted as a table constraint.
alter table public.business_merchant_aliases
  add constraint business_merchant_aliases_normalized_nonempty
  check (char_length(alias_normalized) > 0);

alter table public.business_merchant_aliases enable row level security;

-- THE INDEX THAT MAKES THE ONE-TAP IDEMPOTENT. `insert ... on conflict do
-- nothing` against this is how the review action writes, so tapping "always
-- accept this header" twice, or two reviewers tapping it on two receipts that
-- carry the same header, is a no-op rather than a duplicate or a lost update.
-- It is also the index the pipeline's per-business alias read rides on.
create unique index business_merchant_aliases_biz_alias_uniq
  on public.business_merchant_aliases (business_id, alias_normalized);

-- P1: owner/manager read their own aliases. The same owner/manager narrowing
-- 0017 applies to `receipt_templates`, and for the same reason: an alias list
-- is anti-fraud configuration (it is the list of headers that will auto-approve
-- a receipt at this shop) that counter staff and marketing never need, and that
-- an attacker who could read it would use to choose which receipt to scan.
create policy business_merchant_aliases_staff_select
  on public.business_merchant_aliases
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));

-- NO CLIENT WRITE POLICY, DELIBERATELY. Every write goes through the review
-- surface's server action, which resolves the reviewer's tenant from table
-- truth, re-reads the header text from `receipts.parse_meta` rather than
-- trusting anything the browser sent, and writes an `audit_logs` row. An
-- alias is a widening of what auto-approves at a merchant, which makes it a
-- money-path write and not a settings toggle; a direct client insert would be
-- an unaudited one, and a client-supplied alias string would let a reviewer's
-- compromised session widen acceptance to an arbitrary header.
revoke insert, update, delete, truncate
  on public.business_merchant_aliases from anon, authenticated;

-- And anon is not an audience of this table at any privilege level: the one
-- policy above is `to authenticated`, so an anon read was already dead at the
-- RLS layer, and leaving the table-level grant behind would make the anon row
-- of doc 12's matrix RLS-only for reads. Same close 0024 made on
-- receipt_templates.
revoke select on public.business_merchant_aliases from anon;

comment on table public.business_merchant_aliases is
  'Merchant name aliases scoped to the business (not to a receipt template), read by doc 36 Stage 5''s merchant-name check and taught by the receipt review queue. Writes are service-role only and audited.';
