# 15 — Security

All items `[MVP]` unless tagged. Compliance target: PH **Data Privacy Act of 2012 (RA 10173)** — Giya processes personal data of millions of consumers and business documents (permits, TINs).

## Threat model (what we defend against, ranked)

1. **Points/reward fraud** — fake, altered, borrowed, or replayed receipts; redemption replay; self-dealing staff. → `37-fraud-detection.md` + ledger design + single-use redemption tokens.
2. **Cross-tenant data leakage** — business A reading business B's customers/sales. → RLS everywhere + RLS matrix tests + `404`-not-`403` for foreign-tenant resources.
3. **Account takeover** — credential stuffing on consumer accounts holding points. → rate limits, breach-password protection (Supabase), device sessions, notification on new device.
4. **Document theft** — business permits/TINs in storage. → private buckets, short-TTL signed URLs, access audited.
5. **Abuse of AI surface** — prompt injection via business content, cost-drain attacks. → `38-ai-rag-platform.md` guardrails + budgets.
6. **Platform admin abuse / insider risk** — → least privilege, full audit, no shared admin accounts.

## Authentication

- Supabase Auth: email+password (verified email required before scanning), Google OAuth, Facebook OAuth `[V1]`.
- Passwords: Supabase defaults + leaked-password protection on; min length 8.
- Sessions: JWT (≤1h) + rotating refresh tokens; middleware refreshes server-side. Custom claims per `12-multi-tenancy-rls.md`.
- Device sessions: `user_devices` records device/UA/last-seen; consumers and staff can list + revoke devices; revocation kills refresh token server-side.
- MFA (TOTP) for platform admins — mandatory `[V1]`; available for business owners `[V1]`.
- Password reset + email-change flows: current-session notification email, 1h token TTL, single-use.

## Authorization

- Permission matrix (`00-product/01`) enforced **server-side on every protected action** — route guards (claims) + RLS (defense in depth). UI hiding is never the control.
- Principle of least privilege includes infrastructure: service-role confined per `12`; separate Supabase keys per environment; Vercel env vars scoped per environment; no human uses service-role in production (break-glass procedure documented, audited).
- Admin actions on tenant data always require a recorded reason (audit row).

## Transport & headers

Set in `next.config.ts` / middleware for all responses:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Content-Security-Policy`: nonce-based script-src; `frame-ancestors 'none'`; explicit allowlist for Supabase, Google Maps, FCM, Sentry, Vercel; `upgrade-insecure-requests`. Report-only first 2 weeks, then enforced.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera allowed only on scanner route origin-wide policy: `camera=(self)`), `X-Frame-Options: DENY`.
- CSRF: Server Actions (Next built-in origin checks) + SameSite=Lax cookies; state-changing Route Handlers require JSON content-type + custom header (`X-Requested-With`) which, combined with CORS (no cross-origin allowed), blocks form-based CSRF. No cookies accepted on `/api/v1` from foreign origins.

## Input & upload safety

- Zod validation at every boundary (client, action/handler, worker payloads).
- Uploads: content-type + magic-byte sniffing, size caps (receipts ≤ 10MB, docs ≤ 20MB), image re-encode via sharp on ingest (strips EXIF/GPS except when consumer opts into GPS fraud-check; strips embedded payloads), filename regenerated to UUID (never user-controlled paths).
- SQL injection: no string-built SQL; Supabase client / parameterized queries only. `search_path` pinned on all `security definer` functions.
- SSRF: no user-supplied URLs fetched server-side (Meta/Maps integrations use fixed hosts).

## Storage security

- Buckets private by default; public read only: `avatars`, `menus`, `products`, `promotions`, `rewards`, `announcements`.
- `business-documents`, `receipts`, `invoice-templates`, `exports`, `temp`: private; access via signed URLs, TTL 5 min (documents/receipts) / 1h (exports); generation requires the same permission as the owning row and is audit-logged for `business-documents`.
- Storage RLS policies mirror table policies (path prefix = `business_id`/`user_id`).

## Rate limiting & abuse

Per `13-api-standards.md` table. Additionally: signup velocity per IP/device fingerprint, OCR/AI endpoints per-tenant daily budgets, exponential backoff lockout on auth failures (5 fails → 15 min), CAPTCHA hook on auth `[V1]` if credential stuffing observed.

## Encryption & secrets

- TLS 1.2+ everywhere; Postgres encrypted at rest (Supabase), storage encrypted at rest.
- App-level encryption (AES-256-GCM via `pgsodium`/app KMS) for high-sensitivity columns: TIN and government-ID numbers in `business_verifications` — displayed masked (`***-***-123`) except to super_admin with reason.
- Secrets in Vercel/GitHub encrypted stores; rotation runbook; no secrets in code, logs, or client bundles (`src/lib/env.ts` separates `server`/`client` schemas).
- Redemption QR tokens: signed JWT (separate signing key), `jti` single-use in Redis, TTL 5 min.

## Audit logging

`audit_logs` (schema in `25-schema-platform.md`) captures: actor (user/system/worker), actor role, action verb, entity type + id, `business_id` when tenant-scoped, before/after diff (JSONB, PII-minimized), reason (required for admin overrides), request_id, IP, UA. Insert-only (no update/delete grants). Coverage: every state change that matters — verification decisions, role changes, campaign lifecycle, manual points adjustments, reward inventory changes, suspensions, feature-flag flips, signed-URL grants on documents, admin logins. Retention: 2 years hot, then archived `[SCALE]`.

## Privacy (RA 10173)

- Privacy policy + granular consent at registration (marketing comms opt-in separate from ToS).
- Data minimization: GPS on receipts is opt-in; no contact scraping.
- Consumer rights: export-my-data (export queue) `[V1]`, delete-my-account (soft delete + 30-day purge of PII, ledger rows anonymized not deleted — financial integrity) `[V1]`.
- Businesses see consumer data only for their own customers and only what the CRM needs (name, visits, points — never email/phone unless consumer opts in to direct marketing `[V1]`).
- Breach response runbook: NPC notification within 72h of qualifying breach; Sentry alert → incident channel → runbook (`52-monitoring-observability.md`).

## Security testing

- RLS matrix tests (every table, every role) in CI — the single highest-value control.
- Dependency audit (`npm audit` + Renovate) weekly; CodeQL on PRs.
- Pre-launch external penetration test `[V1]`; annual thereafter.
- Secrets scanning (GitHub push protection + gitleaks in CI).
