-- ============================================================================
-- 0017_receipts.sql
-- Receipts domain: settings (pulled forward from doc 25), receipt_templates,
-- receipts, receipt_line_items, ocr_results, fraud_signals, ai_usage_events.
-- Closes the deferred points_transactions.receipt_id foreign key left by 0012.
-- Source docs: docs/20-data/24-schema-receipts-ai.md (canonical DDL),
-- docs/20-data/25-schema-platform.md (settings shape),
-- docs/30-modules/36-receipt-ocr-pipeline.md (stage semantics),
-- docs/30-modules/37-fraud-detection.md (signal catalog + settings registry),
-- docs/10-architecture/12-multi-tenancy-rls.md (P1-P4 policy patterns),
-- docs/00-product/01-personas-roles.md (receipt-review permission matrix),
-- docs/20-data/26-schema-amendments.md (A24.1, A24.2, A24.3).
-- Environment adaptations (same family as 0002/0007/0012):
--   * uuid_generate_v7() -> private.uuid_generate_v7()
--   * doc 24's "-- +audit" shorthand expanded to the standard audit columns
--     + touch trigger (+ deleted_at only where the doc marks it). receipts
--     gets audit columns but deliberately NO deleted_at; ocr_results,
--     fraud_signals, ai_usage_events and receipt_line_items are write-once
--     records and get no audit columns at all
--   * no PG enums: every enumerated column is text + a check constraint
--   * staff policies use the table-truth helper private.is_active_staff
--     (0010) exclusively, never the claim-based helper from doc 12 - the
--     custom access token hook is not enabled on this project, so a
--     claim-based policy would deny every staff read
--   * ratified MVP amendments folded in at creation time rather than as a
--     follow-up migration: A24.1 (ocr_results.error), A24.2
--     (receipts.parse_meta), A24.3 (fraud_signals.signal += staff_self_scan)
--   * embeddings / ai_conversations / ai_messages from doc 24 are deliberately
--     NOT created here: they are the pgvector + RAG surface, deferred to V1
--   * the write fences in this file are stated three ways, because RLS alone
--     covers none of them fully: policies gate row DML, privilege revokes gate
--     what RLS never sees (TRUNCATE) and roles RLS never applies to
--     (service_role), and raising triggers gate the table owner. Every fence
--     below says which of the three layers it is.
-- ============================================================================

-- ============================================================ settings
-- Platform-wide + per-business settings, pulled forward from doc 25 because
-- doc 37 is explicit that fraud/OCR thresholds are data, not code. Business
-- scope overrides platform scope at the reader. RLS: P1 for business rows;
-- platform rows have NO client policy at all (see below); all writes are
-- service-role only.
create table public.settings (
  id           uuid primary key default private.uuid_generate_v7(),
  scope        text not null check (scope in ('platform','business')),
  business_id  uuid references public.businesses(id) on delete cascade,
  key          text not null,
  value        jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_by   uuid references auth.users(id),
  constraint settings_scope_business_key_uniq unique (scope, business_id, key),
  constraint settings_scope_business_consistent
    check ((scope = 'platform') = (business_id is null))
);
alter table public.settings enable row level security;
create trigger touch_settings before update on public.settings
  for each row execute function private.touch_updated_at();

-- amendment: doc 25's unique (scope, business_id, key) does NOT deduplicate
-- platform rows. business_id is null for every platform row and the SQL
-- standard treats nulls as distinct inside a unique constraint, so the same
-- platform key could be inserted unlimited times and "on conflict do nothing"
-- would never fire. This partial unique index restores the intent the doc
-- describes ("one row per key per scope") for the platform half and makes the
-- seed at the end of this file genuinely idempotent. The business half needs
-- no such index: business_id is not null there, so the doc's constraint
-- already deduplicates it.
create unique index settings_platform_key_uniq on public.settings (key)
  where scope = 'platform';
-- amendment: FK index per doc 20 convention (every FK indexed)
create index settings_business_idx on public.settings (business_id);

-- amendment: NO client select policy on platform-scope rows, against the
-- spec table's "platform rows world-readable to authenticated". doc 25 is the
-- schema authority and says "platform rows admin-only", and the seed at the
-- bottom of this file is why: the platform rows ARE the fraud rulebook.
-- fraud.velocity.* are the exact submission caps an abuser has to stay under,
-- fraud.phash_block_distance is the exact perceptual distance a re-photograph
-- has to exceed, fraud.review_threshold is the composite score to stay below,
-- and fraud.cooldown_strikes is how many rejections are free. A blanket
-- "scope = 'platform'" predicate publishes all of that to any signed-in
-- consumer and contradicts doc 37's philosophy that fraud internals are never
-- exposed to the submitter. Every settings read is therefore server-side
-- through the service role (the typed reader T8, which also holds hardcoded
-- fallbacks). If a genuinely client-facing key ever appears, the correct move
-- is an explicit key allowlist policy - using (scope = 'platform' and key in
-- ('ui.something')) - never a scope predicate again: a scope predicate makes
-- every FUTURE platform key public by default, which is exactly how this
-- leaked in the first place.

-- P1: business-scope rows are visible only to active owner/manager of that
-- business. Narrowed from the four-role catalog read for two reasons: doc 25
-- specifies "business rows P1 owner", and doc 37's registry explicitly allows
-- fraud.velocity.pair_day / pair_10min to be overridden at scope='business',
-- so a business row can carry a fraud threshold too. owner/manager is also
-- exactly the receipt-review audience in doc 01's matrix ("Review flagged
-- receipts (own biz)"), which keeps this table's role list identical to
-- receipts, fraud_signals and ai_usage_events below.
create policy settings_business_staff_select on public.settings
  for select to authenticated
  using (
    scope = 'business'
    and private.is_active_staff(business_id, array['owner','manager'])
  );
-- No insert/update/delete policies for either audience. Thresholds gate the
-- fraud and points pipelines; a business owner who could edit their own
-- fraud.review_threshold could switch fraud detection off for their tenant.
-- Writes go through service-role/admin code paths (audited) only. truncate is
-- revoked with them: RLS does not gate TRUNCATE at all, so without this a
-- client role holding Supabase's default grant could wipe the whole registry.
revoke insert, update, delete, truncate on public.settings from anon, authenticated;

-- ============================================================ receipt_templates
-- Business-uploaded reference receipts that teach the parser (doc 36 Stage 6).
-- RLS: P1, owner/manager read + write per doc 24 and the spec matrix.
create table public.receipt_templates (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  name          text not null,                       -- "Main branch POS", "Handwritten pad"
  source_kind   text not null default 'pos' check (source_kind in ('pos','invoice','handwritten')),
  sample_path   text not null,                       -- bucket: invoice-templates/{business_id}/...
  -- Learned/configured parse hints (doc 36 defines the shape):
  parse_config  jsonb not null default '{}',         -- {merchant_aliases:[...], tin:"...", receipt_no_regex:"...",
                                                     --  date_formats:[...], total_keywords:[...], layout_anchors:{...}}
  version       integer not null default 1,
  is_active     boolean not null default true,
  ocr_test_result jsonb,                             -- last validation run summary
  validated_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  deleted_at    timestamptz
);
alter table public.receipt_templates enable row level security;
create trigger touch_receipt_templates before update on public.receipt_templates
  for each row execute function private.touch_updated_at();

-- amendment: doc 24 indexes business_id partially (where is_active = true and
-- deleted_at is null). That index cannot serve the business_id foreign key: a
-- tenant hard-delete cascades over ALL child rows, including inactive and
-- soft-deleted ones, and the partial index does not contain them, so the
-- cascade degrades to a sequential scan. The doc's predicate also makes the
-- index unusable for the template-history and restore-a-soft-deleted-template
-- reads the management UI needs. Non-partial keeps the doc's hot path indexed
-- (business_id is still the leading and only column) at the cost of a few
-- dead-row entries.
create index receipt_templates_biz_idx on public.receipt_templates (business_id);

-- P1: owner/manager read their own templates in any state. Narrower than the
-- four-role catalog reads because parse_config is anti-fraud configuration
-- (regexes, TIN, amount sanity bounds) that counter staff never need.
create policy receipt_templates_staff_select on public.receipt_templates
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
-- P1: owner/manager create templates in their own tenant
create policy receipt_templates_staff_insert on public.receipt_templates
  for insert to authenticated
  with check (private.is_active_staff(business_id, array['owner','manager']));
-- P1: owner/manager update; the with check pins business_id to own tenant so a
-- row cannot be moved to another business
create policy receipt_templates_staff_update on public.receipt_templates
  for update to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']))
  with check (private.is_active_staff(business_id, array['owner','manager']));
-- No delete policy: soft delete via update (deleted_at). insert and update
-- privileges stay (the three policies above are the client write path), but
-- delete and truncate go, and truncate is the one that matters: RLS never sees
-- a TRUNCATE, so with Supabase's default grant intact any authenticated user
-- could have erased every tenant's parse configuration in one statement
-- despite there being no delete policy anywhere on this table.
revoke delete, truncate on public.receipt_templates from anon, authenticated;
-- amendment: insert/update are additionally revoked from anon alone. They must
-- stay for authenticated (the three policies above ARE the client write path),
-- but anon is not an audience of this table at any privilege level: every
-- policy here is "to authenticated", so an anon write was already dead on
-- arrival at the RLS layer. Leaving the privilege in place made anon the one
-- role in this file whose fence was RLS-only, which breaks the file's own
-- three-layer rule and makes the anon row of doc 12's matrix read as a leak.
revoke insert, update on public.receipt_templates from anon;

-- ============================================================ receipts
-- One consumer submission. RLS: P3 SELECT only for both audiences; every write
-- is service-role (see the fence below the policies).
create table public.receipts (
  id            uuid primary key default private.uuid_generate_v7(),
  business_id   uuid references public.businesses(id),   -- null until matched (doc 36 Stage 5)
  user_id       uuid not null references public.consumers(id),
  status        text not null default 'queued' check (status in
                  ('queued','processing','review','approved','rejected')),
  source        text not null default 'scan' check (source in ('scan','pos','digital')),
  image_path    text not null,                       -- bucket: receipts/{user_id}/{uuid}.jpg
  image_hash    text not null,                       -- perceptual hash (pHash) for dup detection
  sha256        text not null,                       -- exact-bytes hash
  -- parsed fields (post-OCR; authoritative copies live here, raw in ocr_results)
  merchant_name text,
  receipt_number text,
  receipt_date  timestamptz,
  subtotal_centavos integer check (subtotal_centavos >= 0),
  tax_centavos      integer check (tax_centavos >= 0),
  total_centavos    integer check (total_centavos >= 0),
  template_id   uuid references public.receipt_templates(id),
  -- amendment: numeric(4,3) alone admits -9.999 to 9.999. Both confidences are
  -- probabilities by definition (doc 36 Stage 9 routes on them against
  -- thresholds in 0..1), and a parser regression writing 9.999 would clear
  -- ocr.approve_threshold on EVERY receipt and auto-approve the whole queue.
  -- The domain is part of the contract, so state it.
  match_confidence  numeric(4,3) check (match_confidence between 0 and 1),  -- business match 0-1
  parse_confidence  numeric(4,3) check (parse_confidence between 0 and 1),  -- field extraction 0-1
  -- amendment: A24.2 [MVP] per-field extraction provenance for the review UI
  -- chips: {field: {tier: 'template'|'heuristic'|'llm', conf}}
  parse_meta    jsonb,
  reject_reason text check (reject_reason in
                  ('duplicate','unreadable','wrong_business','too_old','fraud_suspected','manual')),
  reject_note   text,
  reviewed_by   uuid references public.profiles(id), -- human reviewer if status went through review
  reviewed_at   timestamptz,
  -- consumer-context (fraud):
  submitted_lat double precision,                    -- only if consumers.gps_fraud_opt_in
  submitted_lng double precision,
  -- amendment: on delete set null. 0002 grants consumers "for all" on their own
  -- user_devices rows, so a consumer can delete a device at any time. With the
  -- doc's bare reference (no action) that delete would raise 23503 against
  -- receipts the consumer cannot reach, edit or remove - a dead end they could
  -- never clear. The device linkage is fraud context, not evidence of record
  -- (the fraud_signals rows it produced are kept regardless), so dropping the
  -- pointer is the right failure mode.
  device_id     uuid references public.user_devices(id) on delete set null,
  processed_at  timestamptz,
  created_at    timestamptz not null default now(),
  -- doc 24 marks receipts "+updated_at/updated_by (status transitions)"; the
  -- full audit quartet is used for consistency with every other table here.
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id),
  -- amendment: composite target for receipt_line_items and fraud_signals,
  -- the 0008/0012 pattern. Both children carry a denormalized business_id that
  -- their RLS policies trust; without this the child's business_id is untied
  -- to the parent receipt's and a wrong (or hostile) value would create a row
  -- visible to a tenant the receipt does not belong to.
  constraint receipts_id_business_uniq unique (id, business_id)
  -- NO deleted_at, deliberately: receipts are financial and fraud evidence and
  -- are never deleted (doc 24 Notes + doc 15 privacy runbook). Consumer account
  -- deletion anonymizes the user_id linkage inside the retention window; it
  -- never removes rows. The points_transactions.receipt_id FK added at the end
  -- of this file is on delete restrict for the same reason, and the delete
  -- trigger below covers the rows that FK cannot reach.
);
alter table public.receipts enable row level security;
create trigger touch_receipts before update on public.receipts
  for each row execute function private.touch_updated_at();

create index receipts_user_idx        on public.receipts (user_id, created_at desc);
create index receipts_biz_status_idx  on public.receipts (business_id, status, created_at desc);
create index receipts_review_idx      on public.receipts (status, created_at)
  where status = 'review';                            -- review queues
create index receipts_hash_idx        on public.receipts (image_hash);
-- exact dup: hard stop. The submit path maps this violation to 422
-- RECEIPT_DUPLICATE (doc 36 Stage 1, doc 37 S1) - the one sanctioned
-- automatic rejection without human review.
create unique index receipts_sha_unique on public.receipts (sha256);
-- two LIVE claims of one receipt number at one business cannot coexist;
-- rejected rows are excluded so honest resubmission after a rejection works
-- (doc 24 Notes, doc 37 S3).
create unique index receipts_number_unique on public.receipts (business_id, receipt_number)
  where receipt_number is not null and status in ('approved','review','processing');
-- amendment: FK indexes per doc 20 convention (user_id is covered by
-- receipts_user_idx, business_id by receipts_biz_status_idx)
create index receipts_template_idx    on public.receipts (template_id);
create index receipts_reviewed_by_idx on public.receipts (reviewed_by);
create index receipts_device_idx      on public.receipts (device_id);

-- P3: consumer sees own submissions
create policy receipts_consumer_select on public.receipts
  for select to authenticated
  using (user_id = (select auth.uid()));
-- P3: owner/manager of the matched tenant see their receipts (review queue,
-- analytics), matching doc 01's "Review flagged receipts (own biz)" row.
-- Marketing and counter staff are excluded: receipts carry submitted GPS and
-- device linkage.
--
-- amendment: an unmatched receipt (business_id null) is invisible to every
-- tenant, and there is no admin policy to catch it either (see the admin note
-- below). The pipeline MUST therefore always write a best-guess business_id
-- before routing a receipt to status='review'; a review-routed receipt with a
-- null business_id lands in a queue that no audience on this database can
-- select, and it would sit there forever. When merchant matching produces no
-- candidate at all the receipt is rejected as 'wrong_business' (doc 36 Stage
-- 5), never parked in review.
create policy receipts_staff_select on public.receipts
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
--
-- amendment: NO admin policies anywhere in this file, against doc 24 line 105
-- ("RLS: admin + staff-own-tenant read") and doc 37's platform-wide admin
-- fraud queue. Every admin predicate in doc 12 reads the platform-admin claim
-- out of the JWT, and this project's custom access token hook is NOT enabled
-- (supabase/README.md, "Manual dashboard step"), so a claim-based admin policy
-- would evaluate to null for every session and silently deny - a policy that
-- looks like coverage and is not. The admin surfaces (doc 31 fraud queue, the
-- cross-tenant review queue) therefore read via the service role until the
-- hook is enabled, at which point admin policies land as their own migration
-- alongside the rest of the claim-based surfaces listed in that README.
--
-- NO insert/update/delete policies for ANY client audience. Every receipt
-- write is service-role, exactly mirroring the points_transactions ledger
-- fence in 0012/0013: the submit endpoint validates, canonicalizes the image,
-- computes the authoritative sha256/pHash and inserts with the service role;
-- the pipeline sets status, parsed fields and processed_at. If a consumer
-- could insert or update a receipt row they could hand themselves
-- status='approved' with an invented total and walk straight past OCR, the
-- fraud stage and the award RPC's approved-only guard.
-- Supabase grants all privileges on new public tables to the app roles by
-- default, so state the fence at the privilege layer too (0013 pattern for
-- points_transactions): with no policy AND no privilege, an UPDATE fails loudly
-- with 42501 instead of silently matching zero rows.
revoke insert, update on public.receipts from anon, authenticated;
-- delete and truncate go further and are revoked from service_role as well,
-- mirroring 0012's ledger revoke exactly. Deletion is not a client concern
-- here, it is an evidence concern: see the trigger block below for why the
-- restrict FK is not enough on its own, and note that TRUNCATE is invisible to
-- RLS, so the privilege is the only thing standing between an app role and an
-- empty evidence table. Until now receipts was protected from TRUNCATE only by
-- accident - truncating it requires truncating points_transactions in the same
-- statement (the FK below), and that table happens to block it - which is a
-- guarantee that evaporates the moment the FK changes. Make it explicit.
revoke delete, truncate on public.receipts from anon, authenticated, service_role;

-- amendment: column-level read fence, replacing the table-level select grant.
-- The consumer policy above is row-correct but column-blind: it hands the
-- submitter every column of their own row, including reject_note (free-text
-- reviewer commentary that can name the matched receipt or another consumer),
-- parse_meta (per-field extraction provenance: exactly which fields came from
-- a template, a heuristic or the LLM tier, with per-field confidence - a
-- gradient signal for a forger iterating on a fake), the two confidence
-- scores, and the sha256/pHash a duplicate-detector oracle would be built on.
-- The /scan status screen ships in this same slice, so this is load-bearing
-- immediately. The allowlist below is exactly what that screen and the wallet
-- receipt-history list render.
--
-- Column privileges are ROLE-wide, not policy-wide, and both audiences here
-- are the same database role (authenticated). One GRANT therefore cannot give
-- staff more columns than consumers: the safe intersection wins. That is the
-- deliberate trade - the review UI needs parse_meta and the confidences and
-- will not get them from this grant. It is not in this slice (doc spec s9
-- defers the business + admin review queue UI to the next one) and it reads
-- through the service role when it lands, alongside ocr_results, which is
-- already staff-visible only through a server-side path for the same reason.
-- If a future slice needs a client-side review UI, the answer is a
-- staff-scoped view (or a security definer function) owned by a role that
-- holds the wider grant, never widening this one.
--
-- Note for callers: `select *` on receipts as authenticated now raises 42501.
-- Client reads must name their columns.
revoke select on public.receipts from anon, authenticated;
grant select (
  id, user_id, business_id, status, reject_reason,
  merchant_name, receipt_number, receipt_date, total_centavos,
  image_path, source, created_at, processed_at
) on public.receipts to authenticated;

-- ============================================================ receipt_line_items
-- Parsed line items (doc 36 Stage 7 columnar split, fuzzy product match).
-- RLS: consumer reads own via the parent receipt; staff read own tenant.
create table public.receipt_line_items (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid references public.businesses(id),
  receipt_id   uuid not null references public.receipts(id) on delete cascade,
  raw_text     text not null,
  qty          numeric(8,3),
  unit_price_centavos integer,
  line_total_centavos integer,
  product_id   uuid references public.products(id),  -- fuzzy-matched (doc 36); null = unmatched
  -- amendment: same 0..1 domain argument as receipts.match_confidence
  match_score  numeric(4,3) check (match_score between 0 and 1),
  sort         integer not null default 0,
  -- amendment: composite FK, the 0008/0012 pattern. rli_staff_select trusts
  -- this row's own business_id; without this constraint that column is tied to
  -- nothing and a wrong value silently publishes the line item to the wrong
  -- tenant. MATCH SIMPLE (the default) skips the check entirely when
  -- business_id is null, which is what makes this safe to apply to a column
  -- that is null for the whole pre-match window (doc 36 Stage 5 assigns the
  -- tenant): unmatched rows cost nothing, matched rows must name a
  -- (receipt_id, business_id) pair that exists on the parent. That skip is
  -- also exactly why the plain receipt_id reference above is KEPT rather than
  -- replaced: during the null window the composite FK enforces nothing at all,
  -- so the single-column FK remains the thing guaranteeing the parent exists.
  constraint rli_receipt_business_fkey
    foreign key (receipt_id, business_id)
    references public.receipts (id, business_id) on delete cascade
);
alter table public.receipt_line_items enable row level security;

create index rli_receipt_idx on public.receipt_line_items (receipt_id, sort);
create index rli_product_idx on public.receipt_line_items (product_id) where product_id is not null;
-- amendment: FK index per doc 20 convention
create index rli_business_idx on public.receipt_line_items (business_id);

-- P3 (consumer half): the consumer reads the line items of their own receipts.
-- business_id is null until the receipt is matched, so tenancy for the consumer
-- audience is derived from the parent receipt rather than the local column. An
-- EXISTS subquery is acceptable here for the same reason it was in 0012's
-- promotions_public_select: this is a detail-screen read of a handful of rows
-- for one receipt, not the hot path doc 12's single-table rule targets, and
-- rli_receipt_idx makes the parent lookup a primary-key hit.
create policy rli_consumer_select on public.receipt_line_items
  for select to authenticated
  using (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_id and r.user_id = (select auth.uid())
    )
  );
-- P3 (staff half): owner/manager of the tenant read their line items. Uses the
-- denormalized business_id directly (single-table, doc 12), which the composite
-- FK above now ties to the parent receipt's tenant.
create policy rli_staff_select on public.receipt_line_items
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
-- No client write policies: line items are parser output, written by the
-- pipeline with the service role.
revoke insert, update, delete on public.receipt_line_items from anon, authenticated;
-- amendment: deliberately NOT immutable, unlike ocr_results and fraud_signals.
-- Line items are DERIVED data, not evidence: a reprocess re-parses the same
-- ocr_results attempt (or a new one) and must be able to replace the previous
-- split, and a reviewer correcting a mis-parsed quantity edits these rows. The
-- evidence they were derived from (ocr_results.raw_text and blocks) is the
-- immutable record, and it is untouched by any of that. service_role therefore
-- keeps insert/update/delete here. It does NOT keep truncate: a reprocess
-- deletes the rows of ONE receipt, never every tenant's line items at once, so
-- there is no legitimate caller for the bulk form.
revoke truncate on public.receipt_line_items from anon, authenticated, service_role;

-- ============================================================ ocr_results
-- Raw OCR output, immutable evidence. One row per processing attempt.
-- RLS: staff own tenant read ONLY. Never consumer-readable: raw_text and the
-- block geometry are the evidence a forger would use to learn exactly which
-- tokens the parser keys on.
create table public.ocr_results (
  id            uuid primary key default private.uuid_generate_v7(),
  receipt_id    uuid not null references public.receipts(id) on delete cascade,
  attempt       integer not null default 1,
  engine        text not null default 'paddleocr',
  engine_version text not null,
  raw_text      text,
  blocks        jsonb,                               -- [{text, bbox, conf}]
  -- amendment: same 0..1 domain argument as receipts.match_confidence
  mean_confidence numeric(4,3) check (mean_confidence between 0 and 1),
  preprocess_ops  text[],                            -- ['deskew','denoise','contrast']
  duration_ms   integer,
  -- amendment: A24.1 [MVP] per-attempt failure reason (jobs.last_error is
  -- per-job, not per-attempt)
  error         text,
  created_at    timestamptz not null default now()
  -- immutable: no updated_at/updated_by, no deleted_at, no touch trigger. A
  -- reprocess writes a NEW row with the next `attempt` number; an existing
  -- attempt is never edited. Enforced by the trigger below, not by convention.
);
alter table public.ocr_results enable row level security;

-- amendment: doc 24's index on (receipt_id, attempt) is made UNIQUE. The
-- table's own contract is "one row per processing attempt" and a reprocess
-- writes the NEXT attempt number; two rows sharing (receipt_id, attempt) means
-- one of them silently overwrote the other's slot in the evidence history, and
-- ocr.max_attempts (seeded below, default 3) becomes uncountable. Unique also
-- makes the retry loop idempotent: a worker that crashes after inserting and
-- retries the same attempt collides instead of double-writing. The unique
-- index serves every lookup the plain one did, so no second index is created.
create unique index ocr_results_receipt_idx on public.ocr_results (receipt_id, attempt);

-- P3 (staff half only): owner/manager of the receipt's tenant read OCR
-- evidence for the review UI. doc 24 gives ocr_results no business_id column
-- and cannot: OCR (doc 36 Stage 4) runs BEFORE merchant matching (Stage 5), so
-- there is no tenant to denormalize at insert time. Tenancy is therefore
-- resolved through the parent receipt at read time. Same EXISTS justification
-- as rli_consumer_select: review-UI read path, primary-key parent lookup.
create policy ocr_results_staff_select on public.ocr_results
  for select to authenticated
  using (
    exists (
      select 1 from public.receipts r
      where r.id = receipt_id
        and private.is_active_staff(r.business_id, array['owner','manager'])
    )
  );
-- No consumer policy at all and no client write policies.
revoke insert on public.ocr_results from anon, authenticated;
-- amendment: the immutability revoke has to name service_role to mean
-- anything. anon and authenticated never had a write path to this table (no
-- policy, and now no privilege), so revoking update/delete from them alone
-- protected against nobody: the ONLY writer is service_role, which is exactly
-- the role that held the privilege to rewrite the evidence it had just
-- written. Same shape as 0012's ledger revoke.
revoke update, delete, truncate on public.ocr_results from anon, authenticated, service_role;

-- ============================================================ fraud_signals
-- Every tripped signal, even on receipts that end up approved (doc 37: scoring
-- history is how thresholds get tuned and slow-burn abusers get caught).
-- RLS: staff own tenant read only.
create table public.fraud_signals (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid references public.businesses(id),
  receipt_id   uuid not null references public.receipts(id) on delete cascade,
  consumer_id  uuid not null references public.consumers(id),
  -- amendment: A24.3 [MVP] adds 'staff_self_scan' to doc 24's eight base
  -- values, so the S9 staff self-scanning guard has its proper home and the
  -- interim encoding under 'velocity' never has to be written. The [V1] values
  -- 'referral_abuse' and 'device_shared' land with the ring sweep.
  signal       text not null check (signal in
                 ('image_hash_dup','ocr_similarity_dup','receipt_number_dup','velocity',
                  'timestamp_anomaly','gps_mismatch','amount_anomaly','ai_confidence_low',
                  'staff_self_scan')),
  severity     text not null check (severity in ('info','warn','block')),
  -- amendment: doc 37 defines score as a 0-1 contribution and the composite is
  -- min(1, sum(score x weight)); numeric(4,3) alone would admit 9.999, and one
  -- such row drives the composite past every review threshold on its own,
  -- turning a tuning bug into a queue-wide false-positive storm.
  score        numeric(4,3) not null check (score between 0 and 1),  -- 0-1 contribution
  evidence     jsonb not null default '{}',          -- e.g. {matched_receipt_id, hamming_distance}
  created_at   timestamptz not null default now(),
  -- amendment: composite FK, the 0008/0012 pattern, same reasoning as
  -- receipt_line_items above: fraud_signals_staff_select trusts this row's own
  -- business_id, so that column must be tied to the parent receipt's tenant or
  -- a wrong value publishes a fraud signal to a business the receipt never
  -- belonged to. MATCH SIMPLE skips the check while business_id is null (doc
  -- 37's detectors run after matching, but a receipt that never matched still
  -- gets signal rows), and the single-column receipt_id FK above is kept for
  -- exactly that window.
  constraint fraud_signals_receipt_business_fkey
    foreign key (receipt_id, business_id)
    references public.receipts (id, business_id) on delete cascade
);
alter table public.fraud_signals enable row level security;

create index fraud_signals_receipt_idx  on public.fraud_signals (receipt_id);
create index fraud_signals_consumer_idx on public.fraud_signals (consumer_id, created_at desc);
-- amendment: FK index per doc 20 convention
create index fraud_signals_biz_idx on public.fraud_signals (business_id);

-- P3 (staff half only): owner/manager of the tenant read their own signals for
-- the business review queue (doc 37 "Review queues").
create policy fraud_signals_staff_select on public.fraud_signals
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
-- Deliberately NO consumer policy. doc 33 and doc 37 both require that fraud
-- internals are never exposed to the submitter: knowing which detector tripped,
-- at what score, with what evidence, is a recipe for evading it. The consumer
-- status screen shows a consumer-safe reason string derived server-side from
-- receipts.reject_reason, never a signal row.
-- No client write policies: the fraud stage writes with the service role.
revoke insert on public.fraud_signals from anon, authenticated;
-- amendment: same argument as ocr_results - the only writer is service_role,
-- so an immutability revoke that stops at anon/authenticated stops nobody.
-- This table is the strike history doc 37's cooldown ladder counts from; a
-- role that can update or delete rows here can retroactively clear an abuser's
-- record.
revoke update, delete, truncate on public.fraud_signals from anon, authenticated, service_role;

-- ============================================================ ai_usage_events
-- Cost metering for ALL AI/OCR compute (budget caps + billing hooks).
-- RLS: staff own tenant read; writes service-role.
create table public.ai_usage_events (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid references public.businesses(id),
  user_id      uuid references public.profiles(id),
  kind         text not null check (kind in ('chat','embedding','ocr','parse_assist','analytics')),
  model        text,
  -- amendment: a meter cannot run backwards. Without these a negative units or
  -- cost_micros row would silently credit a tenant's spend and defeat the plan
  -- budget caps this table exists to enforce.
  units        integer not null check (units >= 0),    -- tokens or pages
  cost_micros  bigint not null default 0 check (cost_micros >= 0),  -- USD micro-dollars
  ref_id       uuid,                                 -- message/receipt/job id
  created_at   timestamptz not null default now()
);
alter table public.ai_usage_events enable row level security;

create index ai_usage_biz_day_idx on public.ai_usage_events (business_id, created_at);
-- amendment: FK index per doc 20 convention
create index ai_usage_user_idx on public.ai_usage_events (user_id);

-- P1 (read half): owner/manager of the tenant read their own AI/OCR spend.
-- Marketing and counter staff are excluded - this is billing data.
create policy ai_usage_events_staff_select on public.ai_usage_events
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager']));
-- No consumer policy and no client write policies: the meter is written by the
-- LLM gateway and OCR worker with the service role. A client-writable meter is
-- a client-editable bill, and a client-truncatable meter is a deleted one.
revoke insert, update, delete, truncate on public.ai_usage_events from anon, authenticated;

-- ---------------------------------------------------------------- immutability
-- Belt and suspenders per doc 23's integrity table and the 0012 ledger
-- pattern. The revokes above stop every app role including service_role; these
-- triggers stop whoever still holds the privilege (the table owner, any future
-- misgrant) and are the only layer that survives someone re-granting by
-- mistake. Declared after all seven tables exist so this file still applies
-- top to bottom in one pass.

-- receipts: DELETE only. UPDATE must stay permitted - the pipeline is nothing
-- but updates (queued -> processing -> approved/review/rejected, parsed fields,
-- processed_at, reviewer decisions), so a points_transactions-style
-- "before update or delete" trigger would deadlock the whole slice. The
-- privilege fence above is what keeps clients out of those updates.
--
-- Why the restrict FK on points_transactions.receipt_id is NOT enough on its
-- own: RESTRICT only fires for a receipt that HAS a ledger row, i.e. an
-- approved and awarded one. A REJECTED receipt has no ledger row at all and
-- was therefore freely deletable - and doc 37's cooldown ladder step 2 counts
-- "3 fraud-family rejections in 30 days" from exactly those rows, so deleting
-- them resets every repeat abuser's strike counter to zero. The three child
-- tables (line items, ocr_results, fraud_signals) would have cascaded away in
-- the same statement, silently, taking the evidence with them.
create or replace function private.receipts_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'receipts cannot be deleted (financial and fraud evidence)';
end
$$;

create trigger receipts_no_delete
  before delete on public.receipts
  for each row execute function private.receipts_no_delete();

-- ocr_results and fraud_signals: UPDATE and DELETE both. Neither table has any
-- legitimate mutation - a reprocess writes a new ocr_results attempt and the
-- fraud stage writes new signal rows; nothing ever edits an existing one.
create or replace function private.receipt_evidence_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is immutable evidence (insert-only)', tg_table_name;
end
$$;

create trigger ocr_results_immutable
  before update or delete on public.ocr_results
  for each row execute function private.receipt_evidence_immutable();

create trigger fraud_signals_immutable
  before update or delete on public.fraud_signals
  for each row execute function private.receipt_evidence_immutable();

-- A row-level trigger does NOT fire on TRUNCATE, so a bulk wipe would bypass
-- every guard above. The revokes already strip the privilege from all four
-- roles; this statement-level trigger catches the table owner and any future
-- misgrant, exactly as 0012 does for the ledger.
create or replace function private.receipt_evidence_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% cannot be truncated (receipt evidence chain)', tg_table_name;
end
$$;

create trigger receipts_no_truncate
  before truncate on public.receipts
  for each statement execute function private.receipt_evidence_no_truncate();

create trigger ocr_results_no_truncate
  before truncate on public.ocr_results
  for each statement execute function private.receipt_evidence_no_truncate();

create trigger fraud_signals_no_truncate
  before truncate on public.fraud_signals
  for each statement execute function private.receipt_evidence_no_truncate();

-- ---------------------------------------------------------------- deferred FK
-- 0012 created points_transactions.receipt_id as a bare uuid column because
-- public.receipts did not exist yet (see the note at the top of that file and
-- the inline comment on the column). The table exists now, so close it.
--
-- on delete restrict, chosen deliberately: receipts are permanent evidence -
-- the table has no deleted_at and doc 24 states rows are never removed inside
-- the retention window. RESTRICT states that invariant in the schema and, being
-- non-deferrable, fails immediately on any attempted delete rather than at
-- commit. cascade would let one receipt delete silently destroy ledger rows
-- (points_transactions is append-only and cannot lose rows); set null would
-- erase the provenance that pt_receipt_earn_once relies on to keep one earn per
-- receipt, letting the same receipt be awarded twice after the delete. It is
-- the narrower of the two delete guards: receipts_no_delete above covers the
-- rows this FK never sees.
alter table public.points_transactions
  add constraint points_transactions_receipt_fkey
    foreign key (receipt_id) references public.receipts (id) on delete restrict;

-- ---------------------------------------------------------------- settings seed
-- Platform default registry: doc 37 "Default settings registry" plus doc 36's
-- routing thresholds and freshness window (registered in doc 26 "Non-DDL
-- registrations"). Idempotent via settings_platform_key_uniq, so replaying this
-- migration never duplicates a key and never clobbers a tuned live value.
-- The typed reader (T8) keeps hardcoded fallbacks matching these numbers, so a
-- missing row can never break the pipeline. Every row below is why the
-- platform scope has no client select policy.
insert into public.settings (scope, key, value) values
  -- doc 37 S1 perceptual-hash bands
  ('platform', 'fraud.phash_block_distance',      '4'::jsonb),
  ('platform', 'fraud.phash_warn_distance',       '10'::jsonb),
  -- doc 37 S2 [V1] text similarity
  ('platform', 'fraud.text_sim_warn',             '0.92'::jsonb),
  -- doc 37 S4 velocity caps
  ('platform', 'fraud.velocity.consumer_hour',    '4'::jsonb),
  ('platform', 'fraud.velocity.consumer_day',     '10'::jsonb),
  ('platform', 'fraud.velocity.pair_day',         '3'::jsonb),
  ('platform', 'fraud.velocity.pair_10min',       '2'::jsonb),
  ('platform', 'fraud.velocity.device_day',       '12'::jsonb),
  -- doc 37 composite routing
  ('platform', 'fraud.review_threshold',          '0.5'::jsonb),
  -- doc 37 S6 [V1] GPS
  ('platform', 'fraud.gps_warn_m',                '2000'::jsonb),
  -- doc 37 consequences ladder step 2
  ('platform', 'fraud.cooldown_strikes',          '3'::jsonb),
  ('platform', 'fraud.cooldown_hours',            '24'::jsonb),
  -- doc 37 rings [V1]
  ('platform', 'fraud.referral_farm_min',         '10'::jsonb),
  -- doc 36 Stage 9 confidence routing
  ('platform', 'ocr.approve_threshold',           '0.8'::jsonb),
  ('platform', 'ocr.review_threshold',            '0.5'::jsonb),
  -- amendment: doc 36 registers ocr.max_attempts alongside the two thresholds
  -- (doc 26 "Non-DDL registrations") with a documented default of 3
  -- (36 Stage 4 / "max 3 attempts"); seeded here so the whole registered key
  -- set exists rather than only two thirds of it.
  ('platform', 'ocr.max_attempts',                '3'::jsonb),
  -- doc 36 Stage 8 freshness window (business-scope override allowed, clamp 1-30)
  ('platform', 'receipts.max_age_days',           '3'::jsonb)
on conflict do nothing;
