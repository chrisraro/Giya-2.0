# Giya audit — 13 October 2026

Baseline: `main`, commit `c251633`. Read-only audit of selected high-impact boundaries, recent changes, foundation docs, and Meta integration. Applied ECC production-audit, product-lens, and security-review. This is not an exhaustive security certification or a live production audit. No runtime or schema changes were made.

## Verdict

**Production readiness: 60/100, risky; public launch blocked pending the items below.** This is an engineering judgment, not a measured benchmark. The codebase is substantially stronger than its stale setup notes suggest. It can build and has broad unit coverage. A controlled pilot becomes reasonable after disabling production OCR fabrication, verifying deployed database security, and exercising the actual receipt-to-redemption loop. The intended Meta ads dashboard is not implemented.

**Product: go for a narrow receipt-to-repeat-visit pilot; no evidence yet for product-market fit or 100,000-business readiness.** Meta reporting is feasible but adds a separate permission, asset-selection, reporting, and approval workload. The canonical roadmap explicitly excludes Facebook connections from MVP; do not let approval delays block validation of the core loyalty loop.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Pass |
| `npm test -- --reporter=dot` | 334 files, 5,726 tests passed; 99.32 seconds |
| `npx eslint src scripts` | 0 errors, 12 warnings |
| `npm run build` | Pass; uses local environment, not proof of deployment health |
| `node scripts/ci/check-migrations.mjs` | Pass |
| `bash scripts/sdd/check-grants.sh HEAD~15` | Fail: three RPCs unpinned; run through installed Git Bash |
| Live pgTAP / live migrations / merchant OAuth | Not exercised |
| Browser receipt-to-redemption / load / OCR golden corpus | Not exercised; no dedicated E2E/load/golden harness found in file inventory |

Jev evaluated a minimal evidence summary at `act_above: 0.9`. Meta severity and OCR risk returned `review`, so conclusions were checked manually against source. Jev correctly rejected treating repository migration text as proof of live application. Its answers are triage assistance, not verification.

## Recent improvements confirmed

- CI now runs lint, types, unit tests, migration safety, grants and build. The supplied instruction note saying CI does not exist is stale.
- Meta now has one registrable callback, with single-use server-held state, user binding and membership recheck. This fixes a real onboarding obstruction.
- oEmbed was removed in favor of the Page Plugin; encrypted server-side Page credentials and token-derived capability checks remain.
- Missing figures and failed reads are distinguished from actual zero metrics on Meta surfaces.
- Recent commits added CSP reporting/enforcement, outer business error boundaries, Next proxy naming, honest database reads, and icon/auth performance improvements.
- Receipt processing has authoritative server image hashes, EXIF-removing canonicalization, queued processing, reentrancy tests and database award primitives. Queue claims use compare-and-swap and heartbeat/recovery machinery.

## Confirmed findings

### P1 — Ads reporting is absent from the Meta integration

`src/lib/integrations/meta.ts:104` requests Page/Instagram scopes, including `read_insights`, but not `ads_read`. `server/service.ts` discovers Pages and persists Page tokens. `server/insights.ts:75` reads Page impressions/reach/engagement/views through `/{page_id}/insights`. There is no ad-account discovery or Marketing API reporting path in the inspected integration.

**Impact:** spend, CPC, CPM, CTR, campaign/ad-set/ad performance and attributed ad conversions cannot be supplied by the current connection. The Page Plugin displays public Page content; it does not implement private ads reporting. Facebook sign-in alone does not establish ad-account permission or tenant ownership.

**Fix:** add a separately modeled read-only ads capability, beginning with `ads_read`, authorized ad-account selection and Marketing API insights. Reuse safe state/crypto/tenancy infrastructure, but preserve credential and asset type distinctions. Test with a merchant outside the app's admin/developer/tester roles before claiming public availability.

### P1 — Production OCR can silently fabricate receipt text

`src/features/receipts/server/ocr/provider.ts:263` returns `createStubOcrProvider()` when both service URLs are absent, with no production guard. Partial configuration is rejected, but entirely absent configuration selects plausible fabricated text. The stub is designed to reach approval; the inspected processing path does not reject stub results before award.

**Impact:** a misconfigured production deployment can feed invented purchase data into real loyalty accounting. This is a code-level hazard; this audit does not claim the current live environment is missing credentials.

**Fix:** production must reject missing OCR configuration or route to explicit manual review. Permit fabricated OCR only through an explicit development/test setting. Add a regression covering production with neither URL configured.

### P1 — Required privilege tests missing for sensitive RPCs

The grants gate across `HEAD~15..HEAD` reports `public.purge_business`, `public.purge_all_businesses` (0081), and `public.validate_redemption_as` (0082) without `has_function_privilege` assertions. Direct searches found no references to these RPC names in `supabase/tests`. The migrations contain hardening; missing assertions do not prove exposed grants.

**Fix:** pin anon/authenticated denial and service-role access in transaction-wrapped pgTAP, including actor and redemption restrictions. Execute against a disposable database. The normal current-main diff can be empty and does not establish historical coverage.

### P1 — Job-health failures can look like successful empty results

`src/lib/alerts/job-health.ts` returns `emptyReport(...)` when either health-sweep RPC errors. `src/app/api/jobs/ops.job_health_check/route.ts` returns HTTP 200 for that report. Only a missing service client produces the explicit 503.

**Impact:** the monitor can successfully respond while failing to inspect jobs, hiding the condition it is supposed to detect.

**Fix:** expose an explicit degraded/read-failed result, make it actionable for monitoring, and test database failure separately from a healthy empty result.

### P2 — Redis requests have no explicit timeout or response schema

`src/lib/redis.ts:11` calls fetch without an AbortSignal deadline and casts response JSON to `{ result: unknown }`. Redis supports rate limits, one-time tokens and OAuth state.

**Impact:** a stalled dependency can consume request duration on several critical flows. Preserve existing fail-closed policies while adding a bounded timeout and validation of Redis error/success envelopes.

### P2 — Map markup nests links

`src/features/businesses/components/business-location.tsx` wraps `StaticMap` in an anchor, while the map's attribution renders its own anchors. React emitted the nested-anchor hydration warning during the passing test run.

**Fix:** keep attribution outside the directions anchor or use a separate map click target. Verify actual browser hydration and attribution interaction.

## Release and integration uncertainties

- Migration 0083 explicitly says “WRITTEN, NOT APPLIED” and addresses public QR enumeration, document permissions and a dead definer function. Verify the live migration ledger, effective policies and pgTAP before accepting the fixes as deployed. Do not infer current live exposure from the file header alone.
- Meta Page token lifecycle is internally inconsistent: callback code records expiry from the user token onto Page rows (`service.ts:174`), while `tokens.ts:174` sends the stored Page token to the user-token exchange after 45 days. Verify the supported flow and actual token type/expiry with Meta; do not promise indefinitely renewable credentials based on mocks.
- The Page metric list is fixed and sent as one request against v25.0. Validate every metric and `days_28` against the live API. Search surfaced deprecation concerns, but accessible primary evidence was insufficient to mark individual metrics conclusively invalid.
- Ordinary-merchant Advanced Access, app mode, verification and approval status were not available to this audit. Successful app-role testing is insufficient evidence.
- Source comments still describe old OCR engines and missing Meta credentials. Foundation docs still reference older stack/tool choices. Update operational truth and explicit amendments; comments are not deployment evidence.
- Only OCR, email and operations job routes are present. Broader documented push/embedding/export schedules need capability-specific verification before being promised.

## Architecture assessment

Retain the Next.js modular monolith, Supabase tenancy/RLS, atomic ledger RPCs and asynchronous worker boundary. These are sensible choices for a small team. No rewrite or new backend is justified by this audit.

The risk is operational consistency: app checks, RLS, definer grants, applied migrations and tests must agree. A wide UI and thousands of mocked tests do not establish that consistency. The receipt processor is over 3,600 lines, increasing change/review cost; stabilize behavior before splitting stage responsibilities behind the existing interface. Recommendations code named `getVectorRecommendations` currently ignores its user/query arguments and fetches ten active businesses; no production call site was found. It is not evidence of delivered personalization.

The 100,000-business objective remains a design aspiration. Require measured database query plans, connection budgets, queue throughput, realtime subscriptions, provider quotas, p95 latency and per-active-business costs before making a capacity claim.

## Meta reporting construction order

1. Define the contract: read-only account/campaign reporting, merchant-selected assets, explicit date range, account currency/timezone, permission and freshness states. Exclude publishing from this reporting consent unless separately needed.
2. Establish one authorized test ad account and prove access with the actual app/token. Discover accessible accounts, paginate, and require deliberate binding to the Giya tenant. Page access is not evidence of ad-account ownership.
3. Store the appropriate encrypted user/system-user credential and typed ad-account bindings. Introduce forward-only schema amendments with RLS/grant tests. Preserve actor identity and reauthorization behavior.
4. Read `act_<account_id>/insights`. Begin with spend, impressions, reach and clicks. Preserve provider money precision; convert to integer minor units using the currency's scale. Do not aggregate currencies indiscriminately or sum overlapping reach.
5. Add cached/background synchronization, last-success timestamp, explicit stale/error states, quota handling and tenant-scoped retry/deduplication. Preserve prior good data when synchronization fails.
6. Validate totals against Ads Manager for the same timezone, dates, attribution window, level and definitions. Add conversion/ROAS only when returned and correctly defined; receipt scans do not by themselves prove ad attribution.
7. Complete the required production access/review process and demonstrate connection, revocation, missing permission, no accounts and real reporting with a non-app-role merchant. Treat external approval as a release dependency, not a guaranteed timeline.

Meta's own public Marketing API collection states that accessing other people's ad accounts needs Advanced Access for `ads_read` and/or `ads_management`, and supports user/system-user access tokens. Its insights examples expose spend, impressions, clicks, actions and reach:

- [Meta Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi)
- [Meta ad insights request](https://www.postman.com/meta/facebook-marketing-api/request/u07tack/get-ad-insights-l1)

Direct Meta documentation requests returned 429/unavailable. Exact current dashboard prerequisites, metric availability and token renewal must therefore be verified in the actual Meta app before implementation is finalized.

## Product brief and next steps

The best initial customer hypothesis is an owner of a small food/retail business who wants measurable repeat visits without changing the POS. The first value is a genuine purchase converted into points and a successfully redeemed reward. The ten-star ambition is useful CRM and measurable retention; the MVP remains the receipt-to-reward loop. Demand, willingness to pay, retention and operating margins were not provided, so market fit cannot be scored credibly from source.

Test with a geographically concentrated cohort and measure merchant activation, repeat scans, redemption, review/support minutes, OCR success, fraud loss and willingness to pay. Include reward subsidy and human review labor in unit economics, alongside compute and messaging. Consumer scanning effort and counter training are real friction even without POS integration. Compare participating stores over time; separate correlation from demonstrated incremental visits.

An ads dashboard alone overlaps the native reporting merchants already have. Giya becomes more valuable if it connects campaigns to retained customers and repeat purchases using defensible measurement. That linkage is a further product/attribution problem, not something granted by Facebook login.

Priority: disable production stub OCR → verify live security migrations and RPC grants → fix monitoring's false-success path → exercise real scan/award/redemption and outage recovery → deliver a read-only ads reporting slice → validate retention and willingness to pay before broadening scope.
