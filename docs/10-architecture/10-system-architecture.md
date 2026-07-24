# 10 — System Architecture

## Topology

```
                        ┌─────────────────────────────┐
                        │        Consumer PWA          │
                        │  Business Portal · Admin     │
                        │  (Next.js 15 / React 19)     │
                        └──────────────┬──────────────┘
                                       │ HTTPS
                        ┌──────────────▼──────────────┐
                        │       Vercel Edge            │
                        │  Edge Middleware:            │
                        │  session refresh · rate-limit │
                        │  headers · locale            │
                        └──────────────┬──────────────┘
               ┌───────────────────────┼────────────────────────┐
               │                       │                        │
   ┌───────────▼──────────┐ ┌─────────▼──────────┐  ┌──────────▼─────────┐
   │  Server Components / │ │  Route Handlers     │  │  Server Actions    │
   │  RSC data fetching   │ │  /api/v1/*          │  │  (portal mutations)│
   └───────────┬──────────┘ └─────────┬──────────┘  └──────────┬─────────┘
               │                      │                        │
               │            ┌─────────▼──────────┐             │
               │            │   Service Layer     │◄────────────┘
               │            │  (domain logic,     │
               │            │   repositories)     │
               │            └──┬────────┬────────┬┘
               │               │        │        │
     ┌─────────▼───────┐ ┌────▼───┐ ┌──▼─────┐ ┌▼──────────────┐
     │    Supabase      │ │Upstash │ │Supabase│ │  Queues (QStash│
     │  Postgres + RLS  │ │ Redis  │ │Storage │ │  + Redis meta) │
     │  pgvector · FTS  │ │        │ │        │ └───────┬───────┘
     │  Auth · Realtime │ └────────┘ └────────┘         │
     └──────────────────┘                     ┌─────────▼─────────────┐
                                              │   Workers (Route      │
                                              │   Handlers, invoked   │
                                              │   by QStash callbacks)│
                                              │  ├─ OCR worker ───────┼──► OCR service (PaddleOCR
                                              │  ├─ AI worker ────────┼──► Groq / vLLM / BGE-M3    + OpenCV, containerized)
                                              │  ├─ Notification ─────┼──► FCM
                                              │  ├─ Email ────────────┼──► Resend
                                              │  ├─ Image processing  │
                                              │  ├─ Export / Cleanup  │
                                              └───────────────────────┘
```

## Core decisions

### D1 — One application, one backend
Next.js is the only application framework. Route Handlers (`/api/v1/*`) serve the public API; Server Actions serve portal-internal mutations; RSC fetches data directly through the service layer. **No Express/Nest/Fastify sidecar, ever.** The single sanctioned exception: the **OCR service** — PaddleOCR + OpenCV are Python and cannot run on Vercel. It runs as a containerized private HTTP service (Fly.io/Railway/Cloud Run), stateless, called only by the OCR worker with a service token. It is infrastructure (like Groq or FCM), not a second backend: it holds no business logic, no DB access — image in, structured text out.

### D2 — Three apps, one codebase
Consumer PWA (`app/(consumer)`), Business Portal (`app/(business)`), Admin Portal (`app/(admin)`) are route groups in one Next.js project sharing the service layer, UI library, and types. Middleware guards each group by role. Split into separate deployments only if build times or blast radius demand it `[SCALE]` — the route-group boundary makes that mechanical.

### D3 — Request/response stays thin; heavy work is queued
Any operation that is slow, external, retryable, or bursty goes through a queue: OCR, AI inference, embeddings, notifications, email, image processing, exports, cleanup. The HTTP layer's job is to validate, enqueue, and answer fast. See `39-background-jobs.md`. QStash (Upstash) delivers jobs back into worker Route Handlers over HTTPS with signatures, retries, and DLQs — chosen because it's serverless-native (no long-lived consumer process needed on Vercel). Redis holds queue metadata: job status keys, progress, dedup locks.

### D4 — Postgres is the source of truth for everything
State lives in Postgres (including job records, notification records, AI chat history). Redis is cache and coordination only — losing Redis entirely must never lose data, only speed. pgvector for embeddings and Postgres FTS for search keep retrieval transactional with its source data; no separate vector DB or search cluster until `[SCALE]` metrics force one.

### D5 — Realtime, sparingly
Supabase Realtime is used for exactly three things: receipt status updates on the consumer scan screen, redemption confirmation on the staff validation screen, and admin queue counters. Everything else polls or refetches via TanStack Query. Realtime channels are tenant-scoped and RLS-authorized.

## Canonical flows

### F1 — Receipt scan → points award (the money flow)
```
Consumer PWA                    API                        Queues/Workers
────────────                    ───                        ──────────────
capture/crop image
  └─ POST /api/v1/receipts  ──► validate JWT + rate limit
     (multipart or            ► store image (private bucket,
      pre-signed upload)         path: {business_id}/{uuid})
                              ► INSERT receipts (status=queued)
                              ► enqueue ocr.process ───────► OCR worker:
                              ◄─ 202 {receipt_id}              preprocess (OpenCV via OCR svc)
subscribe Realtime                                             OCR (PaddleOCR)
  receipts:id=X                                                parse fields (template match)
                                                               fraud checks (37)
                                                             ├─ pass → match business/template
                                                             │        → points engine (35) awards
                                                             │        → status=approved
                                                             │        → enqueue notify.push
                                                             ├─ low confidence → status=review
                                                             │        (human review queue)
                                                             └─ fraud → status=rejected(+reason)
UI updates via Realtime; wallet shows pending→confirmed
```
Latency budget: enqueue ack < 500ms; end-to-end p95 < 60s MVP, < 20s V1.

### F2 — Reward redemption (counter flow)
```
Consumer: taps claimed reward → shows one-time reward QR (short-lived signed token)
Staff device: scans QR → POST /api/v1/redemptions/validate
  ► verify token (single-use, TTL 5 min, Redis lock on jti)
  ► check reward inventory + expiry + consumer standing (not blacklisted)
  ► atomic tx: redemption row + points deduction (if points-priced) + inventory decrement
  ► Realtime confirm to both screens
Offline staff fallback [V1]: 8-char manual code, same validation path.
```

### F3 — AI assistant query
```
Consumer asks question on business page
  ► POST /api/v1/ai/chat  (rate limited per-user + per-business)
  ► cache check (Redis, normalized-question key)         — hit → return
  ► embed query (BGE-M3) → pgvector similarity (business-scoped) + FTS hybrid
  ► LlamaIndex assembles context (top-k chunks, business facts)
  ► Groq inference, streamed to client
  ► log ai_chat_messages + token usage; cache answer
Guardrails: answers only from retrieved business knowledge; refuses out-of-scope;
never invents hours/prices (38-ai-rag-platform.md).
```

### F4 — Campaign activation → marketing send
```
Marketing user activates push campaign
  ► Server Action validates role + campaign state machine (34)
  ► resolve audience segment → materialize recipient set (chunked)
  ► enqueue notify.push batches (500/job) with campaign_id
  ► workers send via FCM, record per-recipient delivery in notifications
  ► analytics events roll up into campaign performance (40)
```

## Scaling model (100k businesses / millions of consumers)

| Layer | At MVP | At SCALE (already designed for) |
|---|---|---|
| Web/API | Vercel serverless, auto-scales | Same; per-route concurrency tuning; ISR for public business pages |
| Postgres | Single Supabase instance, indexes per `20-data/` | Read replicas for analytics; partition `points_transactions`, `receipts`, `audit_logs`, `notifications` by month (`business_id` in every PK/index makes this clean) |
| Search/vector | Postgres FTS + pgvector (HNSW) | Tuned HNSW per-tenant filters; extract to dedicated store only if p95 retrieval > 300ms sustained |
| Queues | QStash, ~10 msg/s | Parallelism via QStash flow-control keys per queue; OCR service horizontal replicas |
| OCR service | 1 container, CPU | Autoscaled replicas; GPU only if throughput demands |
| AI | Groq serverless | Groq primary; self-hosted vLLM for cost arbitrage at volume; embedding batch jobs off-peak |
| Cache | Upstash Redis single region | Same product, larger tier; cache keys already namespaced `{env}:{domain}:` |
| Static/media | Supabase Storage + CDN via signed URLs | Image transformations at upload time (pre-sized variants), CDN-cached public assets |

The invariant: nothing above requires changing application code structure — only infrastructure configuration and migration scripts that were planned from day one.

## Environments

`local` → `staging` → `production`. Each has its own Supabase project, Upstash instances, OCR service deployment, and secrets. Detail in `50-ops/50-environments-deployment.md`.
