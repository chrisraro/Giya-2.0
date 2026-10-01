# Giya — Project Instructions

Loyalty, rewards and CRM platform for Philippine food/retail SMEs. Consumers scan paper
receipts (OCR → points); businesses run campaigns. `docs/` is canon — read `docs/README.md`
"Golden rules" before touching domain logic. Foundation docs (`00-product/`, `10-architecture/`)
beat module docs; `docs/20-data/` is the schema of record.

## Tech Stack
- Next.js 16 (App Router) + React 19, TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), Tailwind v4, MD3 tokens (`npm run gen:tokens`)
- Supabase (Postgres + RLS + Auth + Storage) via `@supabase/ssr`; no ORM — SQL in repos/RPCs
- Upstash Redis (rate limits, idempotency) + QStash (job queue → `/api/jobs/*`)
- Zod v4 for every boundary; react-hook-form; Sentry (only when `SENTRY_DSN` is set)
- AI: Groq LLM, HF embeddings, OCR via Supabase Edge Function `supabase/functions/ocr` (Deno,
  excluded from tsconfig)
- Vitest + Testing Library (jsdom); pgTAP for SQL

## Commands
- Dev `npm run dev` · Build `npm run build` · Test `npm test` (single: `npx vitest run <path>`)
- Lint `npm run lint` (prefer `npx eslint src scripts`)
- pgTAP: `psql "$DATABASE_URL" -f supabase/tests/<suite>.sql` (transaction-wrapped, rolls back)
- Grants gate before review: `scripts/sdd/check-grants.sh`; mutants: `node scripts/sdd/mutants.mjs <spec>`

## Project Structure
- `src/app/` — route groups `(consumer)`, `(business)`, `(admin)`, `(auth)`, `(marketing)`
- `src/app/api/v1/` — public REST (doc 13); `api/jobs/<queue>/` — QStash workers;
  `api/webhooks/` — Meta, PayMongo
- `src/features/<domain>/` — feature-first; `server/` holds `repo.ts` (only DB access),
  `service.ts` (logic), server actions; `components/` holds UI
- `src/lib/` — cross-cutting: `api/handler.ts`, `supabase/{server,client,service}.ts`,
  `queue/`, `log.ts`, `env.ts`, `rate-limit.ts`, `redis.ts`, `ai/`
- `src/workers/` — job bodies invoked by `api/jobs/*`
- `src/components/ui/` — shared primitives; `/design` is the living style guide (dev only)
- `supabase/migrations/NNNN_slug.sql` — forward-only; `supabase/tests/` — pgTAP suites

## Code Style
- Files kebab-case, components PascalCase, DB/JSON snake_case, env SCREAMING_SNAKE
  (validated in `src/lib/env.ts`)
- Imports via `@/…`. Server-only modules start with `import "server-only"`.
- Tests co-located: `foo.ts` → `foo.test.ts` (variants like `process.reentrancy.test.ts` OK)
- No raw hex colors in `src/` (ESLint-enforced) — MD3 tokens only; check light + dark
- Comments explain *why*, often citing the governing doc (`doc 36 Stage 1`). Match that density.

## API & Server Patterns
- Every `/api/v1` route uses `defineHandler` (`src/lib/api/handler.ts`): session → params Zod →
  `authorize` → rate limit → body/query Zod → Idempotency-Key → handler → envelope.
- Domain errors: `throw new ApiError(status, API_ERROR_CODES.X, message)` — never hand-roll a
  response shape.
- Job routes do NOT use `defineHandler`: verify QStash signature first → Zod → `claimJob` →
  work → `finishJob`. Copy `api/jobs/notify.email/route.ts` shape.
- Handlers hold no business `if`s; rules live in the service layer.
- Logs via `src/lib/log.ts` (structured JSON, request ids). Never log secrets/OAuth codes.

## Data Rules (non-negotiable)
- RLS on every user-facing table; authorize server-side even when the UI gates it.
- Points ledger is append-only; corrections are new entries. Money/points are integers.
- Soft delete by default; audit state changes to `audit_logs`.
- Never edit an applied migration — add a new one. Update `docs/20-data/` in the same change,
  add RLS/pgTAP tests, and pin grants on any `SECURITY DEFINER` function.
- Live Supabase project: `zlfxfzlnklqhajacngxf`. Migrations are applied via the Supabase MCP
  `apply_migration` tool, one file at a time, in order.

## Conventions
- Conventional Commits with feature scope, often a task id: `feat(receipts): … (T4.6)`,
  `fix(scan): …`, `test(meta): …`. Feature branches merged with `merge: <summary> (Tn.n)`.
- TDD: failing test first, then green. Review findings get regression tests.
- Agent worktrees live in `.claude/worktrees/` — already excluded from ESLint and Vitest; any
  new tree-walking tool needs the same exclusion.

## Jev Decision Gates (typesafe-jev MCP)
- Use `mcp__typesafe-jev__jev_ask` (batched noul/choice/score over one `state`) at ECC workflow
  gates: plan risk, TDD test validity, review-finding severity, commit-message format,
  pre-merge readiness, security yes/no checks. Prefer one batched call over several single ones.
- Jev judges, never generates. `review`/`abstain` → verify by hand. Use `act_above: 0.9` for
  points ledger, money path, RLS and migrations. Health check: `jev_models`.

## Known Gaps vs Docs
- Doc 14 mentions Husky, commitlint, Prettier and CI — none exist in the repo yet.
- Doc 14 says migrations are `{timestamp}_slug.sql`; the repo uses `NNNN_slug.sql`. Follow the repo.
- No remote deploy yet; secrets live in `.env.local` (gitignored).
