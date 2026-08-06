# 53 - Environment credentials checklist

Running inventory of every credential Giya needs, what breaks without it, and
when it is required. The user supplies external credentials at the end of the
build, so this file is the handover list. Update it whenever a slice adds a
dependency.

Status legend: **SET** = present in `.env.local` today. **NEEDED NOW** = a
shipped feature cannot run without it. **END OF BUILD** = the module that uses
it is built and dormant, waiting on the credential.

`.env.local` is gitignored and must never be committed. No value belongs in
this file, only names.

## Required now

| Variable | Service | Status | Without it |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase | SET | Nothing works |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase | SET | Nothing works |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | SET (2026-07-26, verified HTTP 200 against the live project) | Without it the receipt pipeline and the review queue cannot run. `receipts`, `ocr_results`, `fraud_signals` and `audit_logs` are service-role-write-only by design, so a consumer cannot hand themselves an approved receipt with an invented total. Submission errors and no receipt is created; the review queue renders its unavailable state. Found in the dashboard under Project Settings, API. **Check the ref before using it:** the key is a JWT whose payload must read `"ref":"zlfxfzlnklqhajacngxf"`, the live project. Decode the middle segment and look, because the retired project `dcnpuvtbftpbcjcvfnlt` still exists and its keys still work against it, so a wrong key fails in a confusing way rather than an obvious one. See `supabase/README.md` "Project history". |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis | SET | Redemption tokens fail closed, rate limiting fails open, idempotency 503s |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis | SET | Same. **Rotate before production**: this value was pasted into a chat transcript |
| `REDEMPTION_TOKEN_SECRET` | self-generated | SET | Redemption QR codes cannot be signed or verified |
| `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` | hCaptcha | SET | Signup and signin lose bot protection. The matching secret lives in the Supabase dashboard, not here |

## End of build

| Variable | Service | Needed for | Notes |
|---|---|---|---|
| `SUPABASE_EDGE_OCR_URL` | Supabase Edge Function | **Pointing the app at the deployed Google Vision OCR.** | `https://zlfxfzlnklqhajacngxf.supabase.co/functions/v1/ocr`. **The function is deployed and verified live; this variable is what makes the app USE it.** Until both this and `OCR_FUNCTION_SECRET` are set, `getOcrProvider()` falls through to the stub and every `ocr_results` row is written `engine='stub'` from fabricated text. |
| `OCR_FUNCTION_SECRET` | Supabase Edge Function | Authenticating to it | Already set as a function secret on the project; the app needs the same value locally. If the URL is set and this is not, provider selection throws rather than silently falling back to the stub, which in production would mint points for receipts nobody photographed. |
| `OCR_SERVICE_URL` | PaddleOCR container | The escape hatch, not the default | Outranks the Edge Function in `getOcrProvider()` deliberately: if Vision has to be abandoned, standing up the container must work by setting ONE variable, not by first unsetting two. Not needed today. |
| `OCR_SERVICE_TOKEN` | PaddleOCR container | Same | If the URL is set and this is not, provider selection throws rather than silently falling back to the stub. |
| `GROQ_API_KEY` | Groq | LLM parse-assist (now MVP), AI chat and RAG | **SET and verified 2026-07-26.** All LLM access goes through `src/lib/ai/llm.ts` per doc 38. The account has 15 text-only models and NO vision model, which is why a separate OCR step is required rather than optional. Rotate before production, it was pasted in chat. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Cloud Vision | Receipt OCR. **This is the money path.** | **SET on the Edge Function and verified live 2026-07-26.** A FUNCTION SECRET, not an app variable: `supabase secrets set` on project `zlfxfzlnklqhajacngxf`, service account `giya-vision-ocr@giya-ocr-production.iam.gserviceaccount.com`. Despite the Google-SDK name it holds the service account JSON **inline**, not a file path, because an Edge Function has no filesystem to read one from. Rotate before production, it was pasted in chat. |
| `GOOGLE_CLOUD_PROJECT_ID` | Google Cloud Vision | Quota and billing attribution (`x-goog-user-project`) | `giya-ocr-production`. Function secret, set alongside the credential. |
| `HF_TOKEN` | Hugging Face | The embeddings behind template retrieval | **SET and verified 2026-07-26** (account `Giya2026`). `all-MiniLM-L6-v2`, 384 dims. Rotate before production, it was pasted in chat. **`canPay: false`**, so embedding calls draw on free monthly credits and will throttle under real load. Note `embedText` fails soft, so an exhausted quota degrades template retrieval to the pre-embedding heuristic rather than stopping scans. **No longer used for OCR:** transcription moved to Google Cloud Vision on 2026-07-26. |
| ~~`HF_VLM_MODEL`~~ | Hugging Face | **RETIRED 2026-07-26** | The Edge Function's OCR engine was `google/gemma-4-26B-A4B-it` until Vision replaced it. Vision transcribed every ground-truth field correctly including "Pandesal Bilao", which the VLM read as "Bilbao", in 589ms against the VLM's 1.6-1.8s, and it returns real bounding boxes and real confidences where the VLM returned prose. The secret is still set on the project and is now inert; delete it at the next rotation. Rows read by the old engine are identifiable as `ocr_results.engine = 'hf-vlm'`. |
| `HF_EMBED_MODEL` | Hugging Face | Which model produces template vectors | `sentence-transformers/all-MiniLM-L6-v2`. 384 dims, pinned to the vector column width; changing it invalidates every stored embedding. |
| `QSTASH_TOKEN` | Upstash QStash | Background jobs | Publishing side. Confirm the exact name against the Upstash SDK when the jobs slice lands |
| `QSTASH_CURRENT_SIGNING_KEY` | Upstash QStash | Background jobs | Worker verifies `Upstash-Signature` against current plus next (doc 39) |
| `QSTASH_NEXT_SIGNING_KEY` | Upstash QStash | Background jobs | Rotation pair for the above |
| `RESEND_API_KEY` | Resend | Transactional email | Also unblocks Supabase email confirmation and the leaked-password advisor, both currently blocked on having no email provider |
| `RESEND_WEBHOOK_SECRET` | Resend | Delivery and bounce webhooks | |
| `META_APP_ID` | Meta | Facebook auth and marketing integrations | |
| `META_APP_SECRET` | Meta | Same | The old Giya codebase held only placeholders, so these must be created fresh |
| `NEXT_PUBLIC_MAPS_BROWSER_KEY` | Maps provider | Store locator, browser side | |
| `MAPS_SERVER_KEY` | Maps provider | Geocoding, server side | |
| `METRICS_TOKEN` | self-generated | Bearer-guards `GET /api/internal/metrics` (doc 52's per-minute probe) | Optional and safe to leave unset - the route answers 404 rather than running open. Generate a random value ≥16 characters when the probe is wired into the alert router; shorter values are treated as not configured (`src/app/api/internal/metrics/route.ts`). Reused as the same bearer for `POST /api/jobs/ops.job_health_check` (task 2.5) - both are operator-only diagnostic/action routes behind the same trust boundary, so this does not introduce a second credential. |
| `OPS_ALERT_EMAIL` | self-generated | Recipient for `src/lib/alerts/job-health.ts` (task 2.5's "alert a human when a scheduled job fails") | Optional and safe to leave unset - the check still runs, still reads `sweep_job_health`, still logs every incident it finds; it only sends no mail. A plain email address, validated locally by the checker (basic shape check), not enforced by the schema. Also gated on `RESEND_API_KEY` being set, same as every other email this codebase sends (`src/lib/email/send.ts`). |
| `INTEGRATION_TOKEN_AES_KEY` | self-generated | Encrypting stored third-party integration tokens (doc 42) | |
| `PAYMONGO_SECRET_KEY` | PayMongo | Billing | Later phase, not MVP |
| `PAYMONGO_WEBHOOK_SECRET` | PayMongo | Billing webhooks | Later phase, not MVP |
| Sentry DSN | Sentry | Error tracking and OTel traces (doc 52) | Name to confirm when monitoring is wired |
| Web push keys | Web Push / FCM | Push notifications | VAPID pair or FCM credentials depending on the transport chosen in the notifications slice |

## Configured outside env

These are set in a dashboard rather than a file, and are easy to forget.

- **hCaptcha secret** - Supabase dashboard, Auth settings. Already configured.
- **Google OAuth** - Supabase dashboard, Auth providers. Client id and secret.
- **Facebook OAuth** - Supabase dashboard, Auth providers, using the Meta app above.
- **Custom access token hook** - ENABLED 2026-07-26 via the Management API, verified by a real sign-in that returned `app_metadata.biz`. Was: Every policy in the database uses the table-truth helper `private.is_active_staff` instead of JWT claims, so the app works without it, but the claims-only admin surfaces need it before they ship. See `supabase/README.md`.
- **Leaked password protection** - requires the **Pro plan**, not an email provider as previously recorded. The Management API rejects it outright on the free plan. Raises a standing advisor warning until the project is upgraded.
- **Email confirmation** - Supabase dashboard. Currently off for dev convenience. Must be ON in production.

## Before production

- Rotate `UPSTASH_REDIS_REST_TOKEN` (exposed in a chat transcript).
- Rotate the Supabase `service_role` key for `zlfxfzlnklqhajacngxf`. One was exposed in a chat transcript on 2026-07-25 and it belongs to the LIVE project, so this rotation is real rather than precautionary.
- Regenerate `REDEMPTION_TOKEN_SECRET` for the production environment rather than reusing the dev value.
- Enable email confirmation and leaked-password protection once Resend is connected.
- Enable the access token hook if any admin surface has shipped.
