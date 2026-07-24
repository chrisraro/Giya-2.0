# 24 — Schema: Receipts, OCR, Fraud, Embeddings, AI

Pipeline semantics in `36-receipt-ocr-pipeline.md`, `37-fraud-detection.md`, `38-ai-rag-platform.md`. Conventions per `20-data-model.md`.

```sql
-- ============================================================ receipt_templates
-- Business-uploaded reference receipts that teach the parser. RLS: P1 (owner/manager).
create table public.receipt_templates (
  id            uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  name          text not null,                       -- "Main branch POS", "Handwritten pad"
  source_kind   text not null default 'pos' check (source_kind in ('pos','invoice','handwritten')),
  sample_path   text not null,                       -- bucket: invoice-templates/{business_id}/…
  -- Learned/configured parse hints (36 defines the shape):
  parse_config  jsonb not null default '{}',         -- {merchant_aliases:[…], tin:"…", receipt_no_regex:"…",
                                                     --  date_formats:[…], total_keywords:[…], layout_anchors:{…}}
  version       integer not null default 1,
  is_active     boolean not null default true,
  ocr_test_result jsonb,                             -- last validation run summary
  validated_at  timestamptz
  -- +audit, +deleted_at
);
create index receipt_templates_biz_idx on public.receipt_templates (business_id)
  where is_active = true and deleted_at is null;

-- ============================================================ receipts
-- One consumer submission. RLS: P3 select only; all writes service-layer (12).
create table public.receipts (
  id            uuid primary key default uuid_generate_v7(),
  business_id   uuid references public.businesses(id),   -- null until matched (36 merchant matching)
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
  match_confidence  numeric(4,3),                    -- business match 0–1
  parse_confidence  numeric(4,3),                    -- field extraction 0–1
  reject_reason text check (reject_reason in
                  ('duplicate','unreadable','wrong_business','too_old','fraud_suspected','manual')),
  reject_note   text,
  reviewed_by   uuid references public.profiles(id), -- human reviewer if status went through review
  reviewed_at   timestamptz,
  -- consumer-context (fraud):
  submitted_lat double precision,                    -- only if gps_fraud_opt_in
  submitted_lng double precision,
  device_id     uuid references public.user_devices(id),
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
  -- +updated_at/updated_by (status transitions); NO deleted_at (evidence retention)
);
create index receipts_user_idx    on public.receipts (user_id, created_at desc);
create index receipts_biz_status_idx on public.receipts (business_id, status, created_at desc);
create index receipts_review_idx  on public.receipts (status, created_at)
  where status = 'review';                            -- review queues
create index receipts_hash_idx    on public.receipts (image_hash);
create unique index receipts_sha_unique on public.receipts (sha256);  -- exact dup: hard stop
create unique index receipts_number_unique on public.receipts (business_id, receipt_number)
  where receipt_number is not null and status in ('approved','review','processing');

-- ============================================================ receipt_line_items
create table public.receipt_line_items (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid references public.businesses(id),
  receipt_id   uuid not null references public.receipts(id) on delete cascade,
  raw_text     text not null,
  qty          numeric(8,3),
  unit_price_centavos integer,
  line_total_centavos integer,
  product_id   uuid references public.products(id),  -- fuzzy-matched (36); null = unmatched
  match_score  numeric(4,3),
  sort         integer not null default 0
);
create index rli_receipt_idx on public.receipt_line_items (receipt_id, sort);
create index rli_product_idx on public.receipt_line_items (product_id) where product_id is not null;

-- ============================================================ ocr_results
-- Raw OCR output, immutable evidence. One per processing attempt.
create table public.ocr_results (
  id            uuid primary key default uuid_generate_v7(),
  receipt_id    uuid not null references public.receipts(id) on delete cascade,
  attempt       integer not null default 1,
  engine        text not null default 'paddleocr',
  engine_version text not null,
  raw_text      text,
  blocks        jsonb,                               -- [{text, bbox, conf}]
  mean_confidence numeric(4,3),
  preprocess_ops  text[],                            -- ['deskew','denoise','contrast']
  duration_ms   integer,
  created_at    timestamptz not null default now()
  -- immutable: no updates
);
create index ocr_results_receipt_idx on public.ocr_results (receipt_id, attempt);

-- ============================================================ fraud_signals
-- Every tripped signal, even on approved receipts (scoring history). RLS: admin + staff-own-tenant read.
create table public.fraud_signals (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid references public.businesses(id),
  receipt_id   uuid not null references public.receipts(id) on delete cascade,
  consumer_id  uuid not null references public.consumers(id),
  signal       text not null check (signal in
                 ('image_hash_dup','ocr_similarity_dup','receipt_number_dup','velocity',
                  'timestamp_anomaly','gps_mismatch','amount_anomaly','ai_confidence_low')),
  severity     text not null check (severity in ('info','warn','block')),
  score        numeric(4,3) not null,                -- 0–1 contribution
  evidence     jsonb not null default '{}',          -- e.g. {matched_receipt_id, hamming_distance}
  created_at   timestamptz not null default now()
);
create index fraud_signals_receipt_idx  on public.fraud_signals (receipt_id);
create index fraud_signals_consumer_idx on public.fraud_signals (consumer_id, created_at desc);

-- ============================================================ embeddings
-- Single polymorphic vector store (BGE-M3, 1024-dim). RLS: deny-all; service layer only.
create table public.embeddings (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  source_type  text not null check (source_type in
                 ('product','promotion','business_info','faq','policy','document','hours','reward')),
  source_id    uuid not null,
  chunk_index  integer not null default 0,
  content      text not null,                        -- the chunk text (retrieval returns this)
  metadata     jsonb not null default '{}',          -- {name, price, valid_until, …} for citation
  embedding    halfvec(1024) not null,
  model        text not null default 'bge-m3',
  content_hash text not null,                        -- skip re-embed when unchanged
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (source_type, source_id, chunk_index)
);
create index embeddings_biz_idx on public.embeddings (business_id);
create index embeddings_vec_idx on public.embeddings
  using hnsw (embedding halfvec_cosine_ops) with (m = 16, ef_construction = 64);

-- ============================================================ ai_conversations / ai_messages
-- Consumer assistant chats. RLS: P2 (consumer owns conversation); business staff get
-- aggregated analytics only, never raw consumer chats.
create table public.ai_conversations (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references public.consumers(id) on delete cascade,
  business_id  uuid references public.businesses(id) on delete cascade,  -- null = platform-level chat [SCALE]
  title        text,
  last_message_at timestamptz
  -- +audit, +deleted_at
);
create index ai_conv_user_idx on public.ai_conversations (user_id, last_message_at desc);

create table public.ai_messages (
  id              uuid primary key default uuid_generate_v7(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant','system')),
  content         text not null,
  retrieved_chunks jsonb,                            -- [{embedding_id, score}] provenance
  model           text,
  prompt_template text,                              -- registry key + version (38)
  tokens_in       integer,
  tokens_out      integer,
  latency_ms      integer,
  was_cached      boolean not null default false,
  feedback        text check (feedback in ('up','down')),
  created_at      timestamptz not null default now()
);
create index ai_messages_conv_idx on public.ai_messages (conversation_id, created_at);

-- ============================================================ ai_usage_events
-- Cost metering for ALL AI/OCR compute (budget caps + billing hooks). Service-only.
create table public.ai_usage_events (
  id           uuid primary key default uuid_generate_v7(),
  business_id  uuid references public.businesses(id),
  user_id      uuid references public.profiles(id),
  kind         text not null check (kind in ('chat','embedding','ocr','parse_assist','analytics')),
  model        text,
  units        integer not null,                     -- tokens or pages
  cost_micros  bigint not null default 0,            -- USD micro-dollars
  ref_id       uuid,                                 -- message/receipt/job id
  created_at   timestamptz not null default now()
);
create index ai_usage_biz_day_idx on public.ai_usage_events (business_id, created_at);
```

## Notes

- **Receipts have no soft delete** — they are financial/fraud evidence. Consumer account deletion anonymizes `user_id` linkage per privacy runbook (`15-security.md`), never removes rows inside retention windows.
- **`receipts_number_unique`** allows re-submission after a rejection (rejected rows excluded) but blocks two live claims of the same receipt number at the same business.
- **`halfvec(1024)`** (half-precision) halves index size vs `vector`; recall impact negligible for BGE-M3 — revisit only with eval data (`38`).
- **Why one `embeddings` table** (not per-source): uniform retrieval query, single HNSW index, `business_id` filter for tenant scoping; polymorphic `source_id` is acceptable because rows are derived data — integrity is re-establishable by re-embedding (weekly consistency sweep deletes orphans, `39`).
- **`ai_usage_events`** is the meter for plan caps `[SCALE]` and the AI-cost guardrail metric (`00-vision.md`); written by the LLM gateway + OCR worker on every call.
