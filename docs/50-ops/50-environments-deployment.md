# 50 — Environments & Deployment

Three environments, one promotion path: `local → staging → production` (`../10-architecture/10-system-architecture.md`). Trunk-based delivery per `../10-architecture/14-development-standards.md`: short-lived branches → PR → squash-merge to `main`; `main` is always deployable.

## Environment matrix

| Component | local | staging | production |
|---|---|---|---|
| Next.js app | `pnpm dev` (localhost:3000) | Vercel project `giya-staging` + per-PR preview deploys | Vercel project `giya` (`giya.ph`, `app.giya.ph`) |
| Supabase | Supabase CLI local stack (`supabase start`: Postgres, Auth, Storage, Realtime) | Dedicated staging project + **preview branch databases** per PR | Dedicated production project (PITR enabled, 14-day window) |
| Upstash Redis | Local Redis container (`docker compose`) with Upstash-compatible REST shim, or a free dev Upstash DB per developer | Staging Upstash DB | Production Upstash DB (larger tier per scaling table) |
| QStash | `npx @upstash/qstash-cli dev` or `QUEUE_INLINE=true` (`../30-modules/39-background-jobs.md`) | Staging QStash instance; schedules synced by CI | Production QStash; schedules synced by CI (drift fails CI) |
| OCR service | Local container (`docker compose up ocr`) | 1 small instance (Fly.io/Railway/Cloud Run), staging service token | ≥2 instances behind health-checked LB; autoscale [SCALE] |
| Groq | Dev key, low rate limit, `ai_usage_events` still metered | Staging key, capped budget | Production key; budget alerts per `52-monitoring-observability.md` |
| FCM | Staging Firebase project (shared local+staging) | Staging Firebase project | Production Firebase project |
| Resend | Test mode key (sandbox — no real delivery) | Test mode + allowlisted internal domain for real-send checks | Live key; `mail.giya.ph` / `news.giya.ph` (`../30-modules/42-integrations.md`) |
| Google Maps | Dev keys, tight quota | Staging keys, referrer-restricted to staging domains | Prod keys, referrer/IP-restricted, budget alerts |
| Sentry | DSN off by default locally | `environment=staging`, all events | `environment=production`, sampled per `52` |
| Domains | localhost | `staging.giya.ph`, `*.vercel.app` previews | `giya.ph` (consumer), `app.giya.ph` (portals), `giya.ph/q/*` (QR short links) |

Rules: **no cross-environment sharing** of Supabase projects, Redis DBs, QStash instances, or keys (`../10-architecture/15-security.md`). Every worker URL (QStash target) is environment-absolute — staging QStash can never call production workers. Redis key namespacing `{env}:{domain}:…` (`../10-architecture/11-tech-stack.md`) is defense-in-depth, not a substitute for separate instances.

## Local development quickstart (the Phase 0 exit criterion, `../00-product/02-roadmap.md`)

```
git clone … && cd giya
cp .env.example .env.local          # dev defaults; src/lib/env.ts refuses to boot if incomplete
pnpm install
supabase start                       # local Postgres + Auth + Storage + Realtime
supabase db reset                    # applies all migrations + seed.sql
pnpm gen:types                       # supabase gen types → src/lib/supabase/types.ts
docker compose up -d ocr redis       # OCR service + local Redis
npx @upstash/qstash-cli dev &        # or set QUEUE_INLINE=true
pnpm dev
pnpm test / pnpm test:rls / pnpm e2e # the suites per 51-testing-strategy.md
```

A developer must be able to clone → migrate → seed → run auth + one queued job end-to-end locally; this flow is itself smoke-tested weekly in CI on a clean runner so "works on a fresh machine" never rots.

## Vercel setup

- Two Vercel projects (staging, production) off the same repo. `main` auto-deploys to staging; production deploys are promoted from a staging-verified build via the release workflow below.
- **Preview deploys per PR** run against a **Supabase preview branch database** (branched from staging, migrations auto-applied by CI) — full-stack preview with isolated data; seeded by `supabase/seed.sql`. Preview env vars are the staging set minus real-send capabilities (Resend test mode enforced).
- Env vars managed in Vercel encrypted store, scoped per environment; `src/lib/env.ts` Zod-validates at boot and the app refuses to start misconfigured (`../10-architecture/14-development-standards.md`).
- `maxDuration` per worker route per `../30-modules/39-background-jobs.md`; ISR for public business pages per the scaling table in `../10-architecture/10-system-architecture.md`.

## CI/CD pipelines (GitHub Actions)

### `pr.yml` — every PR
```
1. install + turbo cache
2. lint (--max-warnings 0) + typecheck + commitlint + gitleaks
3. unit tests (domain logic; coverage gate per 51-testing-strategy.md)
4. supabase preview branch: apply migrations → `supabase gen types` drift check (fails on diff)
5. pgTAP suite: RLS matrix + constraint tests (the non-negotiable gate, ../10-architecture/12-multi-tenancy-rls.md)
6. build (Next.js) + OpenAPI generation drift check (../10-architecture/13-api-standards.md)
7. Vercel preview deploy → Playwright E2E golden paths against the preview URL
8. CodeQL (parallel, non-blocking start; blocking on completion for merge queue)
```

### `main.yml` — on merge to `main`
```
1. re-run unit + pgTAP (fast path, cached)
2. apply migrations to STAGING Supabase (auto)          ← per 14 DB workflow
3. deploy staging (Vercel) + sync QStash schedules (staging)
4. full E2E suite + OCR golden-set smoke (51) against staging
5. Sentry release created + sourcemaps uploaded, release tagged {git-sha}
```

### `release.yml` — production (manual trigger, manual approval)
```
1. gate: staging green ≥ 30 min, no new Sentry error class (14 DoD)
2. **manual approval** (GitHub environment protection: production)   ← per 14: prod migration apply is manually approved
3. apply migrations to PRODUCTION Supabase
4. promote build to production Vercel + sync QStash schedules (prod)
5. post-deploy smoke (health endpoint, auth, one scan E2E with synthetic tenant)
6. tag release, notify incident channel
```

Migrations are applied **by CI only, never by hand** (`../10-architecture/11-tech-stack.md`); forward-only, never edited after apply (`14`).

### Migration discipline (the expand → migrate → contract pattern)

Because app rollback is instant but migrations are forward-only, **every migration must be compatible with the previous app release**:

1. **Expand:** add new columns/tables/indexes as nullable/defaulted; create new code paths reading both shapes. Ship.
2. **Migrate:** backfill data via a queued job (`../30-modules/39-background-jobs.md` batching rules — never a single long-running UPDATE that locks a growth table), flip reads to the new shape.
3. **Contract:** a later migration drops the old column/path once no deployable release references it.

Additional rules: `create index concurrently` for any index on `points_transactions`, `receipts`, `notifications`, `audit_logs` (the growth tables, `../20-data/20-data-model.md`); destructive DDL (drop/rename) requires an explicit "contract" note in the PR and two-release separation; every migration PR updates `docs/20-data/` + RLS policies + pgTAP entries in the same PR (`14` DB workflow — an incomplete PR is rejected by the checklist).

### Pipeline failure semantics

- pgTAP RLS failure, type drift, or OpenAPI drift: hard block — no override path exists.
- E2E flake: one auto-retry; second failure blocks (flake fixes are P1 tech debt, not skips).
- Staging migration failure (`main.yml` step 2): pipeline halts before deploy — staging DB and app never diverge; fix-forward migration lands as the next merge.
- A red `main` freezes `release.yml` (cannot promote from a red trunk).

## Secrets management & rotation

- **Stores:** GitHub Actions encrypted secrets (CI-needed only) + Vercel env store (runtime) + OCR host's secret store. No secrets in code, logs, or client bundles; gitleaks + GitHub push protection in CI (`../10-architecture/15-security.md`).
- **Inventory (per environment):** Supabase URL/anon/service-role keys, Supabase access token (CI), QStash token + current/next signing keys, Upstash Redis REST creds, Groq key, FCM service account JSON, Resend key + webhook secret, Maps browser/server keys, Sentry DSN + auth token, OCR service token, redemption-JWT signing key, app-layer AES key (TIN/integration tokens).
- **Rotation runbook:** quarterly scheduled + immediately on suspicion. Order: create new credential → add as `*_NEXT` where dual-read supported (QStash signing keys and redemption JWT keys are dual-key by design) → deploy → retire old → audit-log the rotation. Supabase service-role rotation requires coordinated redeploy (runbook step list kept in `ops/runbooks/rotation.md` in-repo). App-layer AES key rotation uses key-id-prefixed ciphertexts (re-encrypt lazily).
- Break-glass production access per `../10-architecture/15-security.md`: documented, audited, never routine.

## OCR service deployment

- **Image:** single Dockerfile (PaddleOCR + OpenCV pinned versions per `../10-architecture/11-tech-stack.md`); built in CI, pushed to GHCR tagged `{git-sha}` + `{paddleocr-version}`.
- **Gates:** image build runs the OCR golden-set regression (`51-testing-strategy.md`) — an image that regresses accuracy never ships.
- **Health checks:** `/healthz` (process up) + `/readyz` (models loaded, warm); LB routes only to ready instances.
- **Zero-downtime deploy:** rolling replace (start new → ready → drain old, 60s grace ≥ the 90s client timeout budget means in-flight requests either finish or are retried by the queue — worker retries make OCR deploys safe by construction, `../30-modules/39-background-jobs.md`).
- **Auth:** service token required on every request; network-private to the worker egress where the host supports it.
- Version pinning + golden-set-gated upgrades per `../10-architecture/11-tech-stack.md`.

## Rollback procedures

| Layer | Procedure |
|---|---|
| App (Vercel) | **Instant rollback** to previous deployment (alias flip, seconds). First lever for any bad deploy. |
| Migrations | **Forward-only, fix-forward** (`14`): never `down`-migrate a shared environment. A bad migration gets a corrective migration through the same pipeline (expedited approval allowed). Schema changes are written to be backward-compatible one release back (expand → migrate → contract pattern) so an app rollback never faces a schema it can't run on. |
| Data damage | Supabase **PITR** restore to a fork → surgical repair (copy affected rows back) — full-restore only for catastrophe; ledger tables are append-only so corruption surface is inserts, repaired by compensating entries (`../20-data/20-data-model.md`). |
| OCR service | Redeploy previous image tag (registry retains history). |
| QStash schedules | `scripts/sync-schedules.ts` re-applies the registry from the deployed commit. |
| Feature-level | Prefer `feature_flags` kill switches over deploys for risky features (`14` DoD; flags in `../20-data/25-schema-platform.md`). |

## Deploy cadence & release policy

- **Staging:** continuous — every merge to `main` (multiple/day).
- **Production:** on demand, target ≥2×/week during MVP pilot; never Friday after 15:00 Manila unless SEV-driven; one migration-bearing release in flight at a time.
- **Hotfix path:** branch from `main`, same PR pipeline (nothing skips pgTAP/RLS), expedited human approval on `release.yml`; if the fix is config-shaped, prefer a `feature_flags` flip or Vercel env change over a deploy.
- Deploys announce in the ops channel with release sha, migration list, and the Sentry release link; the deployer watches dashboards for 30 min post-deploy (`52-monitoring-observability.md` new-error-class alert covers the rest).

## Seed data strategy

- `supabase/seed.sql` (local + preview branches): reference data (`ref_cities` PH set, `ref_business_types`, `ref_food_types`), platform admin user, 3 demo businesses (one per verification state) with menus, campaigns of each MVP type, demo consumers with ledger history, sample receipts + templates, feature flags defaulted.
- Staging additionally gets the **synthetic load dataset generator** (`51-testing-strategy.md`) on demand — never run against production.
- Production gets reference data only, applied as ordinary migrations (auditable), plus real onboarding. No demo data in production, ever.
- Seeds are idempotent (`on conflict do nothing`) and re-runnable after `supabase db reset`.

## Backup & disaster recovery posture

| Asset | Mechanism | Objectives |
|---|---|---|
| Postgres (prod) | Supabase PITR, 14-day window + daily logical dump to a separate cloud account (blast-radius isolation) | RPO ≤ 5 min (PITR); RTO ≤ 4h for full restore, ≤ 1h for surgical row repair |
| Storage buckets | Provider durability + weekly manifest reconciliation (DB paths ↔ objects); `receipts`/`business-documents` are the irreplaceable classes | Orphan/missing-object report weekly |
| Redis / QStash | **No backup by design** — rebuildable from Postgres (D4, `../10-architecture/10-system-architecture.md`); the `jobs` reconciler re-publishes lost deliveries (`../30-modules/39-background-jobs.md`) | Recovery = flush + warm |
| Config | Env var inventory exported (encrypted) at each rotation; QStash schedules re-synced from repo; Vercel/GitHub settings captured in `ops/runbooks/` | Rebuild-from-repo drill annually |

DR drill: restore staging from a production logical dump (PII-masked transform in the restore script) quarterly — proves backups and gives staging realistic data shape at the same time.

## Launch checklist (pilot / production go-live)

1. RLS audit green: full pgTAP matrix + manual spot audit; zero cross-tenant findings (`../00-product/02-roadmap.md` exit criteria).
2. Load test passed at pilot targets (`51-testing-strategy.md` k6 profiles); scan e2e p95 < 60s.
3. OCR golden set ≥ thresholds; auto-approval ≥70% on pilot template corpus.
4. Security: headers verified (CSP enforced after report-only window), rate limits verified, signed-URL TTLs verified, secrets rotated fresh, gitleaks clean (`../10-architecture/15-security.md`).
5. Observability: dashboards live, alert routes tested (page + email test firing), Sentry release tagging verified (`52-monitoring-observability.md`).
6. Ops: PITR confirmed enabled, rotation runbook + incident runbooks committed, on-call rota set, NPC breach-response contacts filled (`../10-architecture/15-security.md`).
7. Domains/DNS: apex + app + short-link routes, HSTS preload submitted, SPF/DKIM/DMARC verified (`../30-modules/42-integrations.md`).
8. Legal/CMS: `cms_pages` terms + privacy published, consent flows verified, `cms_pages.version` re-consent hook tested.
9. Data: production reference seeds applied; `analytics.daily_rollup`, `integrity.balance_check`, cleanup schedules firing and observed for 3 consecutive days in staging.
10. Kill switches: feature flags exist for scanner, AI surfaces, and campaign sends; flipping each verified in staging.

## Change checklists (small rituals that prevent big incidents)

**Adding an environment variable:** add to `src/lib/env.ts` (server or client schema — client vars must be `NEXT_PUBLIC_` and secret-free) → add to `.env.example` with a safe default or `__REQUIRED__` marker → set in Vercel staging + production and GitHub Actions if CI needs it → note in the secrets inventory above if secret → deploy staging first (boot validation catches misconfiguration before prod).

**Adding a QStash schedule or queue:** registry entry in `../30-modules/39-background-jobs.md` first (doc is canon) → worker + tests per the PR checklist (`14`) → `scripts/sync-schedules.ts` picks it up; CI drift check proves doc ↔ QStash agreement.

**Changing a bucket or its policy:** update `../10-architecture/11-tech-stack.md` bucket table + `../10-architecture/15-security.md` storage rules in the same PR; storage RLS policies migrate like table policies (pgTAP-covered).

## Runbook index (`ops/runbooks/` in-repo; linked from every alert)

| Runbook | Covers |
|---|---|
| `rotation.md` | Secret/key rotation order incl. dual-key services |
| `queue-dead-letter.md` | Dead-job triage + replay procedure (`39`) |
| `balance-drift.md` | `integrity.balance_check` findings → ledger investigation → audited `adjust` |
| `ocr-service.md` | Restart, rollback to previous image, fixture-mode toggle |
| `realtime-outage.md` | Flip polling fallback flag, comms template |
| `restore.md` | PITR fork → surgical repair; full-restore decision tree |
| `breach.md` | `../10-architecture/15-security.md` NPC 72h flow, evidence preservation |
| `deploy-freeze.md` | Error-budget freeze entry/exit criteria (`52`) |

## Schema deltas proposed

None. This document introduces no new tables or columns.
