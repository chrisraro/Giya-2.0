# 11 — Technology Stack (Decisions & Rules of Use)

Every entry: what we use, why, and the rules that keep it from being misused. Changing any **Locked** decision requires an ADR reviewed against the 100k-business test (`00-vision.md`).

## Frontend

| Choice | Status | Why | Rules of use |
|---|---|---|---|
| **Next.js 15 (App Router)** | Locked | One framework for all three surfaces + API; RSC cuts client JS for content-heavy consumer pages; Vercel deployment | App Router only. Server Components by default; `"use client"` only for interactivity. No Pages Router code. |
| **React 19** | Locked | Actions, `use`, better Suspense — pairs with Server Actions | Use form actions + `useActionState` for portal forms where RHF is overkill. |
| **TypeScript (strict)** | Locked | End-to-end type safety with Supabase generated types + Zod | `strict: true`, `noUncheckedIndexedAccess: true`. No `any` without `// eslint-disable` + justification. |
| **Tailwind CSS v4** | Locked | Speed, consistency, tree-shaken CSS | Design tokens in `@theme`; no arbitrary values where a token exists; no CSS modules/styled-components. |
| **shadcn/ui + Radix UI** | Locked | Accessible primitives we own the code for | Components copied into `src/components/ui`; customize there, never fork per-feature copies. |
| **React Hook Form + Zod** | Locked | Uncontrolled perf + one schema for client and server validation | Every form schema lives in the feature's `schemas.ts`, shared by RHF resolver AND the Server Action/Route Handler. Never validate only client-side. |
| **TanStack Table** | Locked | Headless tables for portal data grids | Server-side pagination/sort/filter for any table that can exceed 100 rows. |
| **Tremor + Recharts** | Locked | Tremor for dashboard KPI/chart blocks fast; Recharts for custom charts Tremor can't express | Prefer Tremor; drop to Recharts only when needed. One chart theme file. |
| **Zustand** | Locked | Minimal client state | ONLY for UI/session-local state (scanner flow state, cart-like drafts, modals). Server data NEVER lives in Zustand — that's TanStack Query's job. |
| **TanStack Query** | Locked | Cache/refetch/optimistic updates for client components | Query keys follow `[domain, entity, params]` registry in `src/lib/query-keys.ts`. Mutations invalidate by key, no manual cache surgery unless optimistic. |
| **Google Maps Platform** | Locked | Maps/places/geocoding for PH coverage | Load only on map surfaces (dynamic import). Cache geocode results in DB (`businesses.location`), never re-geocode per view. Places autocomplete session tokens to control cost. |
| **next-pwa + Service Workers** | Locked | Installability, offline, background sync | Strategy per `41-pwa-offline.md`. SW never caches API responses containing another user's data; caches are versioned and purged on deploy. |

## Backend

| Choice | Status | Why | Rules of use |
|---|---|---|---|
| **Next.js Route Handlers** | Locked | See `10-system-architecture.md` D1. **Do NOT introduce another backend framework.** | Public/API-versioned surface = Route Handlers `/api/v1/*`. Portal-internal mutations = Server Actions. Both call the same service layer — logic lives in services, never in handlers. |
| **Edge Middleware** | Locked | Session refresh, role-based route-group guarding, security headers, coarse rate-limit | Keep it fast (<5ms budget); no DB queries in middleware beyond Supabase session refresh. |
| **Supabase (Postgres 15+)** | Locked | Postgres + Auth + Storage + Realtime + RLS in one, generous scaling path | All access through RLS-aware clients except sanctioned service-role paths (workers, admin services) which are audited. `supabase gen types` in CI; drift fails the build. |
| **pgvector** | Locked | Embeddings co-located with source data, transactional consistency | HNSW indexes; every vector row carries `business_id` for filtered search. |
| **Postgres FTS** | Locked | Search without an extra cluster | Generated `tsvector` columns + GIN; combined with pgvector for hybrid retrieval (`38`). |
| **Supabase Auth** | Locked | Email, Google, Facebook OAuth; JWT with custom claims | Claims design in `12-multi-tenancy-rls.md`. No parallel session system. |
| **Upstash Redis** | Locked | Serverless-friendly cache/rate-limit/locks | Key namespace `{env}:{domain}:{...}` with TTL always set. Redis is disposable: no data that can't be rebuilt from Postgres. |
| **QStash (Upstash)** | Locked | Serverless queue delivery to Route Handler workers; retries, DLQ, signatures | All queues per `39-background-jobs.md`. Workers verify QStash signature + are idempotent. |
| **Supabase Storage** | Locked | Buckets: `avatars`, `business-documents`, `invoice-templates`, `menus`, `products`, `promotions`, `rewards`, `receipts`, `announcements`, `temp`, `exports` | Private by default; public only `avatars`, `menus`, `products`, `promotions`, `rewards`, `announcements` (read). Signed URLs everywhere else. Path convention: `{bucket}/{business_id|user_id}/{uuid}.{ext}`. `temp` auto-purged at 24h, `exports` at 7d. |

## AI / OCR

| Choice | Status | Why | Rules of use |
|---|---|---|---|
| **PaddleOCR** | Locked | Best open-source OCR for receipts incl. mixed EN/Tagalog; free; self-hosted control | Runs only inside the containerized OCR service. Version pinned; upgrades gated by golden-set regression (`51-testing-strategy.md`). |
| **OpenCV** | Locked | Preprocessing: deskew, denoise, contrast, crop, perspective | Same container as PaddleOCR. |
| **Groq API** | Locked (primary inference) | Fast + cheap LLM inference for assistant, parsing assists, analytics narratives | All calls through `src/lib/ai/llm.ts` gateway: model registry, token metering, per-tenant budget caps, retries, fallbacks. No direct SDK calls from features. |
| **vLLM** | Designed-for `[SCALE]` | Self-hosted inference for cost arbitrage at volume | Gateway abstraction above makes provider swap config, not refactor. |
| **BAAI BGE-M3** | Locked | Multilingual (EN/Filipino) embeddings, 1024-dim, strong retrieval | One embedding model platform-wide; model name stored on every embedding row so re-embedding migrations are trackable. |
| **LlamaIndex** | Locked | RAG orchestration: chunking, retrieval, context assembly | Used inside AI workers/services only; not in client bundles. Prompt templates from the prompt registry (`38`), never inline strings. |

## Platform services

| Choice | Status | Why | Rules of use |
|---|---|---|---|
| **Firebase Cloud Messaging** | Locked | Free push for PWA (web push) + future mobile | All sends through notification service + queue; token lifecycle per `42-integrations.md`. |
| **Resend** | Locked | Developer-grade email, React Email templates | Transactional + marketing sends both through email queue; domain auth (SPF/DKIM); suppression list respected. |
| **Sentry** | Locked | Errors + performance, all surfaces + workers | PII scrubbing on; release tagging from CI. |
| **OpenTelemetry** | Locked | Traces across API → queue → worker → external call | Trace context propagated through QStash headers (`52`). |
| **Vercel Analytics** | Locked | Web vitals + audiences | — |
| **GitHub + Actions + Vercel** | Locked | CI/CD per `50-ops/50-environments-deployment.md` | Trunk-based; preview deploys per PR; migrations applied by CI, never by hand. |
| **PayMongo** | Future `[SCALE]` | PH-native payments (cards, GCash, Maya) | Schema hooks exist (`plan`, entitlements); no billing code until SCALE. |
| **QRCode.js** | Locked | Business/campaign/reward/menu QRs; SVG + PNG export | QR payloads are URLs/tokens per `34-campaign-engine.md` — never raw entity IDs. |

## Version & upgrade policy

- Renovate/Dependabot weekly; minor/patch auto-PR, major upgrades require passing full E2E + a named owner.
- Next.js/React majors: adopt within one quarter of stable, behind a spike branch.
- PaddleOCR/BGE-M3/LLM model versions: pinned, upgraded only via golden-set eval gates.
