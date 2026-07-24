# 14 — Development Standards

## Repository layout (feature-first)

One repo, one Next.js app, three route groups. Features own their full vertical slice; shared code is promoted deliberately.

```
giya/
├── docs/                          # this documentation (source of truth)
├── supabase/
│   ├── migrations/                # versioned SQL, never edited after apply
│   ├── seed.sql
│   └── tests/                     # pgTAP / RLS matrix tests
├── src/
│   ├── app/
│   │   ├── (consumer)/            # consumer PWA routes
│   │   ├── (business)/            # business portal routes
│   │   ├── (admin)/               # admin portal routes
│   │   ├── (auth)/                # shared auth screens
│   │   └── api/
│   │       └── v1/                # Route Handlers (thin, via createHandler)
│   ├── features/                  # ← the heart of the codebase
│   │   ├── campaigns/
│   │   │   ├── components/        # feature UI
│   │   │   ├── server/            # services + repositories (server-only)
│   │   │   ├── actions.ts         # Server Actions ("use server")
│   │   │   ├── schemas.ts         # Zod (client+server shared)
│   │   │   ├── queries.ts         # TanStack Query hooks + keys
│   │   │   └── types.ts
│   │   ├── points/  receipts/  rewards/  loyalty/  businesses/
│   │   ├── consumers/  menu/  marketing/  analytics/  ai/
│   │   ├── notifications/  reviews/  admin-verification/  cms/ …
│   ├── workers/                   # QStash-invoked handlers (service-role zone)
│   │   ├── ocr/  ai/  notifications/  email/  images/  cleanup/  exports/
│   ├── components/
│   │   ├── ui/                    # shadcn/ui (owned copies)
│   │   └── shared/                # cross-feature composites (charts, tables, upload)
│   ├── lib/
│   │   ├── api/                   # createHandler, envelope, errors, openapi
│   │   ├── supabase/              # server/client/middleware clients, generated types
│   │   ├── authz/                 # permissions.ts (matrix), guards
│   │   ├── ai/                    # llm gateway, embeddings, prompt registry
│   │   ├── queue/                 # enqueue helpers, signatures
│   │   ├── redis.ts  cache-tags.ts  query-keys.ts  utils.ts
│   ├── styles/                    # tailwind theme tokens
│   └── middleware.ts
├── e2e/                           # Playwright
└── .github/workflows/
```

Rules:

- **Dependency direction:** `app → features → lib`. Features may not import from other features' `server/` internals — cross-feature needs go through the other feature's exported service interface (its `server/index.ts`). Enforced by ESLint `import/no-restricted-paths`.
- **`server-only`** package guards every `server/` module; secrets can never leak into client bundles.
- A "feature" maps to a domain module from `30-modules/`, not to a page.

## Layering (repository / service / handler)

- **Repository** (`server/repo.ts`): all SQL/Supabase queries for the feature. Only layer that touches the DB client. Complex data access uses the repository pattern; trivial features may merge repo into service until complexity demands the split — but SQL never appears in handlers/actions/components.
- **Service** (`server/service.ts`): business logic, transactions, cross-feature orchestration, event emission. Pure where possible (points calculation, campaign eligibility are pure functions with unit tests).
- **Handler/Action:** validation + authz + calling one service function + shaping the response. If a handler has an `if` about business rules, the rule is in the wrong layer.
- **Event-driven workflows:** long-running operations emit domain events (`receipt.approved`, `campaign.activated`) → queue jobs. Services never `await` slow external work inline.

## TypeScript & code style

- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`/`as unknown as` without lint-suppression + comment.
- End-to-end types: Supabase generated types (`supabase gen types typescript`) + Zod schemas; DTO types are `z.infer<>`. CI regenerates types and fails on drift.
- ESLint (typescript-eslint strict + import rules) + Prettier, enforced by Husky pre-commit (lint-staged) and CI. No warnings allowed in CI (`--max-warnings 0`).
- Naming: files kebab-case; React components PascalCase; DB snake_case; JSON snake_case; env vars SCREAMING_SNAKE (validated at boot by `src/lib/env.ts` Zod schema — the app refuses to start misconfigured).
- No duplicated business logic: if the same rule exists in two places (e.g. points preview client-side + award server-side), the client imports the same pure function from the feature's shared module.

## Git & delivery

- Trunk-based: short-lived branches → PR → squash-merge to `main`. `main` is always deployable.
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `db:`, `docs:`); scope = feature name (`feat(campaigns): …`). Enforced by commitlint in CI.
- PR checklist (template): schema change ⇒ migration + `20-data/` doc updated + RLS policies + RLS tests; new endpoint ⇒ Zod schemas + error codes registered + rate-limit policy; new queue ⇒ idempotency + DLQ handling; UI ⇒ mobile viewport checked.
- Preview deploy per PR (Vercel) against staging Supabase branch database.

## Database change workflow

1. Write migration in `supabase/migrations/{timestamp}_{slug}.sql` — forward-only; **never edit an applied migration**; corrections are new migrations.
2. Update the relevant `docs/20-data/` file in the same PR (docs are canon).
3. Add/update RLS policies + pgTAP RLS matrix tests.
4. `supabase gen types` — commit generated types.
5. CI applies to preview branch DB → tests → on merge, CI applies to staging → prod apply is a manually-approved CI job.

Constraints beat application checks: enums as `check` constraints or PG enums, FKs always, uniqueness in the DB, money/points as integers with `check (amount_centavos >= 0)` where applicable.

## Definition of Done (any feature)

- [ ] Matrix-permission behavior verified (tests, not manual)
- [ ] RLS tests green for touched tables
- [ ] Unit tests for domain logic; E2E for the happy path if user-facing
- [ ] Error states + empty states + loading states designed (no raw spinners on portals; skeletons)
- [ ] Audit log entries for state changes that matter
- [ ] Docs updated (module doc + schema doc if touched)
- [ ] Sentry shows no new error class in preview
- [ ] Feature flag if risky (`25-schema-platform.md` flags)
- [ ] Design tokens only (no raw color values); component follows `16-design-system.md`
- [ ] Both themes (light/dark) checked on touched screens
