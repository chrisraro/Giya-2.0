# 52 — Monitoring & Observability

Stack per `../10-architecture/11-tech-stack.md`: Sentry (errors + performance), OpenTelemetry (traces), Vercel Analytics (web vitals), plus metrics derived from Postgres (`jobs`, `receipts`, `ai_usage_events`, `notifications`) — consistent with D4: the truth for operational state is queryable in Postgres.

## How metrics are collected (serverless reality — nothing long-lived to scrape)

1. **Span-derived metrics:** API/worker latency, error rates, and external-call durations come from OTel spans — no separate counters to maintain.
2. **The metrics probe:** an internal endpoint `/api/internal/metrics` (service-token-guarded, not under `/api/v1`) runs the registered SQL probes — per-queue `jobs` aggregates, `receipts` funnel counts, review-queue depth/age, `ai_usage_events` spend, notification failure rates — and emits them as OTel gauge points. A QStash schedule invokes it **every minute** (rides the `../30-modules/39-background-jobs.md` schedule-sync machinery; probe queries are index-only and budgeted <500ms total; a slow probe is itself an alert).
3. **The job-health check (task 2.5):** `POST /api/jobs/ops.job_health_check` (bearer-guarded on `METRICS_TOKEN` — the same operator trust boundary as the metrics probe above, not a second credential) calls `checkJobHealth()` (`src/lib/alerts/job-health.ts`), which reads `public.sweep_job_health` (0028) and `public.sweep_job_terminal_failures` (0061) and emails `OPS_ALERT_EMAIL` for any of the platform's pg_cron sweeps (`campaigns.sweep`, `claims.expiry_sweep`, `integrity.balance_check`, `points.expiry_sweep`, `points.expiry_warn`, `receipts.stuck_sweep`) that is failing, stale against its own schedule, or has stopped being scheduled entirely. Intended cadence: **every 15 minutes** — tight enough that "at most a daily reminder" per open incident (the checker's own dedupe) stays a meaningful bound on how long a real outage can go unseen, loose enough that a routine mid-run false alarm costs nothing against the route's 20/minute rate-limit headroom. Not yet wired to a live QStash schedule as of this task — the route exists and is fully tested, but the recurring trigger is an external ops action, the same dormant-until-configured state the metrics probe was in before its own schedule existed (`docs/50-ops/53-env-credentials-checklist.md`).
4. **Synthetic monitors (external):** uptime probes on `giya.ph`, `app.giya.ph`, `/api/v1/health` (returns dependency statuses: DB, Redis, QStash publish, OCR `/readyz`, storage) from ≥2 regions every minute; a weekly synthetic full scan→award transaction against production using a dedicated synthetic tenant (excluded from business metrics by `business_id` allowlist).
5. **Provider dashboards** (Vercel, Supabase, Upstash, Groq, Resend, GCP) are linked from the runbook index — used for capacity, not paged alerts, except where webhooked into the alert router.

## Golden signals per surface

| Surface | Signals | Source |
|---|---|---|
| API (`/api/v1/*`) | latency p50/p95/p99, error rate by code (5xx vs 4xx-domain), 429 rate, request volume | OTel spans + Vercel; `request_id` correlation (`../10-architecture/13-api-standards.md`) |
| Queues/workers | per-queue: oldest-queued-job age, queued depth, success rate, duration p95, dead count, attempts histogram | `jobs` table metrics per `../30-modules/39-background-jobs.md` |
| OCR | OCR success rate (service 2xx), receipt auto-approval rate, OCR duration p95 (`ocr_results.duration_ms`), `mean_confidence` distribution, service `/readyz` | worker spans + `ocr_results` + `receipts` |
| AI | chat latency p95 (`ai_messages.latency_ms`), refusal rate, cache hit rate (`ai_messages.was_cached`), token spend (`ai_usage_events`), thumbs-down rate (`ai_messages.feedback`) | `../20-data/24-schema-receipts-ai.md` tables + LLM gateway spans |
| Scan funnel | submitted → processing → approved/review/rejected conversion per hour; review-queue depth + age | `receipts.status` counts |
| Realtime | subscribe success rate, delivery lag on the three sanctioned channels (D5) | client beacon + Supabase metrics |
| Notifications | send success rate per channel, FCM invalid-token rate, email bounce/complaint rate | `notifications.status/error` |
| DB | connection saturation, slow queries (>500ms logged), replication lag [SCALE] | Supabase dashboard + pg_stat exports |

## SLOs

| SLO | Target | Notes |
|---|---|---|
| API availability | 99.9%/30d | Vercel + Supabase composite; error budget ~43 min/month |
| API latency | p95 < 500ms authenticated routes | public cached pages p95 < 200ms |
| Scan end-to-end (submit → approved/review) | p95 < 60s [MVP], < 20s [V1] | first-attempt path per F1 latency budget (`../10-architecture/10-system-architecture.md`) |
| Receipt enqueue ack | p95 < 500ms | F1 |
| Push delivery (transactional) | p95 < 30s from event | enqueue → `sent_at` |
| Realtime status update | p95 < 3s from status write | scan screen UX |
| Rollup freshness | `analytics_daily_business` for D-1 complete by 03:00 Manila | `../30-modules/40-analytics.md` |

Error-budget policy: an SLO burning >25% of monthly budget in 7 days freezes feature deploys for that surface until a remediation lands (fix-forward, `50-environments-deployment.md`).

### SLI definitions (precise, so nobody argues during an incident)

- **API availability** = 1 − (5xx responses ÷ total responses) over `/api/v1/*`, excluding synthetic-tenant traffic and 503s during a declared dependency incident with functioning degradation (`../10-architecture/13-api-standards.md` `DEPENDENCY_UNAVAILABLE`).
- **Scan e2e latency** = `receipts.processed_at − receipts.created_at` for receipts reaching `approved`/`review`/`rejected` **on first job attempt** (retries measure reliability, not the latency SLO); p95 over trailing 1h.
- **Push delivery latency** = `notifications.sent_at − notifications.created_at` for transactional kinds (campaign blasts excluded — they are throughput-shaped by flow control, `../30-modules/39-background-jobs.md`).
- **Queue oldest-age** = `now() − min(scheduled_at)` over `status='queued'` per queue — the one queue number that matters (depth without age is noise).
- **Rollup freshness** = existence of `analytics_daily_business` rows for D-1 for ≥99% of businesses that had D-1 activity, checked at 03:00 Manila.

## Sentry configuration

> **As built (T7.5), which is narrower than the target below.** Sentry is wired
> behind `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` and **no DSN is set anywhere**;
> unset means the SDK is never imported at all. When one is set it will see
> page, server-component, server-action and middleware faults, and it will
> **not** see `/api/v1` faults — `src/lib/api/handler.ts` catches those and
> returns a 500 envelope, so Next never reports a failure. Those live only in
> the structured log. Browser stack traces are minified (no `withSentryConfig`,
> so no sourcemap upload — the release-tagging bullet below is therefore not
> yet true either). The complete record is `src/lib/log.ts`'s JSON line, on
> every surface, DSN or no DSN. Full rationale and the operator warning:
> `53-env-credentials-checklist.md`.

- **Projects/surfaces:** one Sentry project, environments `staging`/`production`, tagged per surface (`consumer|business|admin|api|worker|ocr-service`).
- **Release tagging:** CI sets `release={git-sha}` on deploy + uploads sourcemaps (`50-environments-deployment.md` main.yml); "new error class in preview" blocks DoD (`../10-architecture/14-development-standards.md`).
- **PII scrubbing on** (`../10-architecture/11-tech-stack.md`): server-side `beforeSend` strips emails, phones, TIN patterns, tokens, receipt image URLs; breadcrumbs exclude request bodies; worker payloads logged by `job_id` reference only. `request_id` attached to every event for envelope correlation.
- **Performance:** tracesSampleRate 0.1 API / 1.0 workers (low volume, high value); session replay off for consumer surfaces except opt-in bug reports (`feedback` flow) with masking on — privacy posture per `../10-architecture/15-security.md` / RA 10173.
- **Alert rules:** new error class in production → page; error-rate spike (>3× 1h baseline) → page; regression of resolved issue → email.

## OpenTelemetry

- **Propagation:** one trace spans API → QStash → worker → OCR service/Groq/FCM/Resend. Enqueue attaches `traceparent` as a QStash forwarded header; workers extract and continue; the OCR client and LLM gateway propagate onward (`../30-modules/39-background-jobs.md`). Span attributes always include `business_id` (tenant), `job_id`/`request_id`, queue name — never payload contents.
- **Sampling strategy:** head sampling 10% on API routes; **100% on**: all worker executions, all OCR service calls, all Groq calls, any request that errors (tail-sampled via Sentry link). Rationale: worker volume is low relative to reads and is where the money flows.
- **Instrumentation:** `@vercel/otel` + custom spans in the service layer for: points award transaction, fraud evaluation, retrieval (embed + pgvector query), template parse. Exported to the OTel backend (Sentry performance at MVP; dedicated backend [SCALE] if retention needs grow).
- **Canonical trace (F1, what a healthy scan looks like):**

```
POST /api/v1/receipts                                [api]     180ms
├─ zod.validate + authz + ratelimit                            12ms
├─ storage.upload receipts/{user_id}/{uuid}.jpg                95ms
├─ db.insert receipts (status=queued)                          9ms
└─ qstash.publish ocr.process  ──── traceparent ────┐          40ms
                                                    ▼
POST /api/workers/ocr.process                        [worker]  8.4s
├─ jobs.claim (queued→running)                                 7ms
├─ ocr-service /process (preprocess+OCR)             [http]    5.1s
├─ parse.template match_confidence=0.94                        120ms
├─ fraud.evaluate (4 signals, 0 tripped)                       85ms
├─ points.award (tx: ledger + business_customers)              45ms
├─ db.update receipts status=approved                          8ms
└─ qstash.publish notify.push ─────────────────────► [worker]  1.2s → FCM
```

  A scan-latency page starts by pulling this trace for the slowest recent receipts — the slow span names the culprit without log spelunking.

## Dashboards (built from the above; Tremor admin tiles + provider dashboards)

1. **Platform health** — API golden signals, uptime, error budget burn.
2. **Queue health** — per-queue depth/age/success/dead (`39` metrics), reconciler activity.
3. **Scan pipeline** — funnel conversion, auto-approval rate vs target, OCR duration, review-queue depth/age, reject reasons.
4. **AI/RAG** — latency, cache hit, refusal, token cost by `ai_usage_events.kind`, per-tenant top spenders, eval-set score trend (`51-testing-strategy.md`).
5. **Fraud** — signals by type/severity, leak rate, clawback volume, review outcomes.
6. **Notifications** — per-channel success, bounce/complaint, campaign fan-out throughput.
7. **Business metrics** — WASC, verified active businesses, GMV proxy, redemption rate (`../30-modules/40-analytics.md` platform metrics).
8. **Cost** — see Cost monitoring.

## Alerting matrix

**Pages (24/7, on-call):**

| Condition | Threshold |
|---|---|
| API 5xx rate | >2% for 5 min |
| API availability probe fail | 3 consecutive (multi-region synthetic) |
| Queue dead-letter | any `jobs.status='dead'` on `ocr.process`, `notify.*` within 15 min; >10 on any queue |
| Oldest queued job age | >10 min on `ocr.process`; >30 min others |
| OCR success rate | <80% over 15 min (service or approval-pipeline failure) |
| **Balance drift** | any drift found by `integrity.balance_check` (`39`) — ledger integrity is page-worthy at any hour |
| **Fraud leak spike** | clawback points >3× 7d baseline in 24h, or `fraud_signals` `severity='block'` spike >5× |
| Realtime down | scan-status delivery failing >5 min |
| Cert/domain | TLS expiry <14d unresolved, DNS/HSTS probe failure |
| Security | auth-failure spike (credential stuffing pattern per `../10-architecture/15-security.md`), service-role use outside fenced paths |

**Emails/Slack (business hours):**

| Condition | Threshold |
|---|---|
| AI budget breach | tenant daily cap hits (top-10 list), platform Groq spend >80% monthly budget |
| OCR/AI quality drift | golden-set weekly run below gate; eval accuracy <95% [V1] |
| Auto-approval rate | <70% [MVP] / <85% [V1] trailing 7d — roadmap guardrail (`../00-product/02-roadmap.md`) |
| Email reputation | bounce >2% or complaint >0.1% daily (`../30-modules/42-integrations.md`) |
| Rollup freshness miss | D-1 not complete by 03:00 Manila |
| Cleanup drift | `temp`/`exports` bucket size growing against TTL expectations |
| Dependency budgets | Maps/Resend/Upstash/Supabase usage >80% of plan or budget |
| WASC / business monitors | see below |

## Business-metric monitors (weekly review, alert on trend break)

- **WASC** (north star, `../00-product/00-vision.md`): weekly level + growth; alert if growth <10%/mo for 2 consecutive months during V1 (roadmap exit criterion regression).
- **Auto-approval rate** vs roadmap targets (also an email alert above).
- **Fraud leak rate** vs guardrail (<1% MVP exit, <0.5% target).
- **Redemption rate** and **business 90-day retention** — dashboards with quarter-over-quarter trend; no automated alert (product review input).
- **AI cost per WASC** (guardrail): `sum(ai_usage_events.cost_micros)` ÷ WASC, weekly.

## Structured logging

- JSON logs everywhere (API, workers, OCR service): `level`, `msg`, `request_id`/`job_id`, `business_id`, `trace_id`, surface. Never logged: tokens, receipt image URLs/signed URLs, emails/phones/TINs, raw payload bodies (`../10-architecture/15-security.md`).
- Correlation contract: `request_id` (API envelope) ↔ `job_id` (queue) ↔ `trace_id` (OTel) ↔ Sentry event — any one identifier reaches the other three. Support workflows start from the `request_id` a user reports.
- Retention: Vercel/host log retention is short by design — anything needed beyond days must be a domain row (`audit_logs`, `jobs.last_error`, `notifications.error`), per D4.

## On-call & alert routing

- Alert router: Sentry + probe alerts → PagerDuty-class service (page) or ops channel/email (notify) per the matrix above. Every page maps to exactly one runbook; an alert that fires without an action taken twice in a month is retuned or demoted (alert-fatigue budget: <2 non-actionable pages/week).
- Rota: single on-call at MVP (founding team rotation), business-hours-only SEV3/4; escalation after 15 min unacknowledged. Quiet hours suppress only email-tier alerts — pages are 24/7.
- **Weekly ops review (30 min, standing):** SLO burn, top Sentry classes, queue/dead-letter trends, OCR/AI quality trend vs gates, cost-per-WASC lines, alert-fatigue audit. Output: at most 3 ops actions into the backlog with owners.

## Incident response

| Severity | Definition | Response |
|---|---|---|
| SEV1 | Money/points integrity at risk (ledger drift, fraud leak, mass wrong awards), platform down, data breach suspected | Page; incident commander assigned; status page; fix-forward or Vercel rollback immediately; postmortem required |
| SEV2 | Core loop degraded (scan pipeline slow/failing, redemptions failing) | Page in hours, 24/7 ack; workaround within 4h |
| SEV3 | Non-core degraded (AI assistant down, analytics stale, email delayed) | Business hours; feature flag off if user-visible |
| SEV4 | Cosmetic/tooling | Backlog |

Runbooks in-repo (`ops/runbooks/`): queue-dead-letter replay (`39` replay procedure), balance-drift investigation, OCR-service restart/rollback, token/secret rotation (`50-environments-deployment.md`), Realtime outage fallback (polling flag), **breach response** — suspected personal-data breach follows `../10-architecture/15-security.md`: Sentry alert → incident channel → runbook → NPC notification within **72h** of qualifying breach; audit trail from `audit_logs` + access logs. Every SEV1/SEV2 gets a blameless postmortem with actions tracked to close.

## Cost monitoring

Budgets set per environment; tracked monthly with 50/80/100% alerts:

| Line | Meter | Notes |
|---|---|---|
| Groq (chat, parse_assist, analytics narratives) | `ai_usage_events.cost_micros` by `kind` + provider dashboard | per-tenant daily caps enforced by LLM gateway (`../10-architecture/11-tech-stack.md`); breach = email alert + gateway soft-refusal |
| Embeddings | `ai_usage_events.kind='embedding'` | batch off-peak [SCALE] |
| OCR compute | container host billing + `ai_usage_events.kind='ocr'` units (pages) | cost/receipt trend line; GPU decision gate (`../10-architecture/10-system-architecture.md` scaling table) |
| Upstash (Redis + QStash) | provider metrics: commands/day, messages/day | queue message volume vs `jobs` row counts sanity check |
| Supabase | DB size, egress, storage GB, MAU auth | storage driven by receipts bucket — retention policy review at each 2× growth |
| Vercel | function GB-hours (workers dominate), bandwidth | `maxDuration` budgets per `39` keep worker cost bounded |
| Resend / Maps | provider dashboards + `../30-modules/42-integrations.md` controls | |

**Unit economics:** the platform cost dashboard divides each line by WASC to report **cost per WASC** (vision guardrail) and flags any line whose per-WASC cost rises 2 consecutive months — the trigger for the [SCALE] cost levers (vLLM migration, OCR autoscaling profile, replica offload).

## Schema deltas proposed

None. All monitors read existing tables (`jobs`, `receipts`, `ocr_results`, `ai_usage_events`, `ai_messages`, `notifications`, `fraud_signals`, `points_transactions`, `analytics_daily_business`); synthetic-probe results and provider metrics live outside the product schema.
