import { z } from "zod";

// Client-safe environment schema. Only NEXT_PUBLIC_* keys belong here since
// this module can be imported from browser code; Next.js statically inlines
// these at build time, so reads must be direct property accesses (not a
// dynamic key loop) for the inlining to work.
const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  // Optional: when unset, the captcha widget does not render and auth calls
  // omit captchaToken. Build and dev must both work without it.
  NEXT_PUBLIC_HCAPTCHA_SITE_KEY: z.string().optional(),
  // NEXT_PUBLIC_MAPTILER_KEY is deliberately NOT declared here. It is read
  // directly in src/lib/maps/tile-source.ts, and that file explains why: the
  // whole contract of the map surfaces is that an absent key degrades to the
  // address text, so the function that answers "is a basemap available" must
  // never be able to throw - and every read through this module can, because
  // this schema fails as a unit. A missing Supabase URL must not present itself
  // as a broken map.
});

function loadEnv() {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_HCAPTCHA_SITE_KEY: process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Invalid or missing environment variables: ${missing}. Check .env.local.`,
    );
  }

  return parsed.data;
}

export const env = loadEnv();

// Server-only environment schema. These keys must never be referenced at
// module scope (that would pull them into any bundle that imports this
// file, including client bundles) so evaluation is deferred to first call
// of getServerEnv() and memoized from then on.
const serverEnvSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(20),
  REDEMPTION_TOKEN_SECRET: z.string().min(32),
  // Optional: the OCR container (docs/30-modules/36-receipt-ocr-pipeline.md
  // Stage 4) and its credentials arrive at the end of the build. With
  // OCR_SERVICE_URL unset the receipts pipeline selects the deterministic
  // stub provider, so the whole app runs, builds and tests without either
  // key. Setting both switches to the real container with no code change.
  //
  // The pair is deliberately NOT cross-validated here. A refinement on this
  // schema would make an OCR misconfiguration throw for every getServerEnv()
  // caller, taking down auth and rewards over a receipts-only problem. The
  // pairing rule ("URL without token is a misconfiguration") is enforced in
  // src/features/receipts/server/ocr/provider.ts, where the blast radius is
  // exactly the pipeline that needs it.
  OCR_SERVICE_URL: z.string().url().optional(),
  OCR_SERVICE_TOKEN: z.string().min(1).optional(),
  // The Supabase Edge Function OCR path (spec section 2.1), the second choice
  // in the same selection ladder and optional for the same reasons. The URL is
  // the function endpoint itself, e.g.
  // https://{ref}.supabase.co/functions/v1/ocr.
  //
  // OCR_FUNCTION_SECRET is the shared secret the function authenticates on. It
  // is deliberately NOT the service role key: the function needs no database
  // access at all (doc 36 Stage 4: "stateless, no DB access, no business
  // logic"), so authenticating it with the database god-key would spread our
  // highest-privilege credential across every OCR request for a capability the
  // function cannot use. A leaked OCR_FUNCTION_SECRET costs Hugging Face
  // credits and rotates with one command.
  //
  // Not cross-validated here, exactly like the OCR_SERVICE pair above: the
  // pairing rule lives in provider.ts where its blast radius is the receipts
  // pipeline and not every getServerEnv() caller.
  SUPABASE_EDGE_OCR_URL: z.string().url().optional(),
  OCR_FUNCTION_SECRET: z.string().min(1).optional(),
  // Optional for the same reason: the service-role key is a credential and
  // credentials land at the end of the build. Server-side readers that need
  // it (the receipt settings loader, later the processing orchestrator)
  // degrade to documented defaults and log rather than throwing, so a
  // key-less dev environment still runs the pipeline.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  // Optional, and optional for the same "credentials land last" reason as the
  // OCR pair above. HF_TOKEN authenticates two Hugging Face calls: the VLM
  // transcription and the template layout embedding. With it unset,
  // src/features/receipts/embed.ts returns null from embedText and template
  // retrieval falls back to the existing heuristic selection, so the scan
  // still completes. An embedding outage must never fail a receipt.
  HF_TOKEN: z.string().min(1).optional(),
  // Optional override for the embedding model. The DEFAULT lives in
  // src/features/receipts/embed.ts, next to EMBEDDING_DIMENSIONS, because the
  // model and the vector width are one decision and not two: setting this to a
  // model with a different output dimension invalidates every embedding
  // already stored in the vector(384) column. See that file's header.
  HF_EMBED_MODEL: z.string().min(1).optional(),
  // Optional, and it must stay optional. src/lib/ai/llm.ts is the single LLM
  // entry point (docs/30-modules/38-ai-rag-platform.md section 1) and it fails
  // soft by contract: with no key it returns null and the receipt pipeline's
  // deterministic parse tiers stand alone, exactly as they do today. Making
  // this required would take down auth, rewards and the whole app over a
  // missing credential for an advisory feature, and would invert the one
  // safety property that keeps the LLM from being load-bearing.
  //
  // Not cross-validated against GROQ_MODEL, for the same reason the OCR pair
  // above is not: a refinement here throws for every getServerEnv() caller.
  GROQ_API_KEY: z.string().min(20).optional(),
  // The model id. Validated against the registry in src/lib/ai/models.ts
  // rather than here: this schema has no business knowing which models exist,
  // and an unregistered value there degrades to the task default with a
  // warning instead of throwing. An unregistered model has no price, so
  // accepting one silently would mean an unmetered call.
  GROQ_MODEL: z.string().min(1).optional(),

  // ---------------------------------------------------------------------
  // Queue (QStash) and email (Resend). All optional, all for the same
  // reason every credential above is: docs/30-modules/39-background-jobs.md
  // makes Postgres the truth and QStash merely the delivery, so an app with
  // none of these set still writes `jobs` rows, still raises in-app
  // notifications and still serves every screen. What it loses is delivery
  // and speed, which is exactly the degradation doc 39 designs for.
  //
  // src/lib/queue/publish.ts and src/lib/email/client.ts both fail soft on
  // absence, so nothing here needs a cross-field refinement - and a
  // refinement would be actively wrong for the reason the OCR pair states
  // above: it would make a queue misconfiguration throw for every
  // getServerEnv() caller, taking down auth and rewards over it.
  // ---------------------------------------------------------------------

  // The QStash REST base. REGIONAL, not global: `https://qstash.upstash.io`
  // answers 404 on this account, while `https://qstash-us-east-1.upstash.io`
  // serves /v2/publish, /v2/schedules and /v2/topics. Verified live
  // 2026-07-26. There is no default baked into the code precisely because the
  // obvious default is the one that does not work.
  QSTASH_URL: z.string().url().optional(),
  QSTASH_TOKEN: z.string().min(10).optional(),

  // The two signing keys, and they are a PAIR rather than a primary and a
  // spare. Upstash rotates by promoting `next` to `current`, so a request
  // signed either side of a rotation must verify, and src/lib/queue/verify.ts
  // tries both. Configuring only one is legal and halves the rotation window;
  // configuring neither means no request can be verified, which verify.ts
  // treats as "reject everything" rather than "accept everything". See its
  // header: this is the one place in this codebase where absence of a
  // credential must NOT degrade to permissive.
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(10).optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(10).optional(),

  // The public origin the worker callbacks are published to, e.g.
  // https://giya.example. Absent means enqueue writes the `jobs` row and
  // skips the publish, because a callback URL that is not reachable from the
  // internet is not a callback. Localhost during development is exactly that
  // case, which is why this is optional rather than defaulted.
  QSTASH_CALLBACK_ORIGIN: z.string().url().optional(),

  // The app's own public origin, used to turn the app-relative hrefs the copy
  // matrix carries (`/scan/{id}`) into links that work in an email client.
  //
  // A separate key from QSTASH_CALLBACK_ORIGIN even though a real deployment
  // sets both to the same string, because they are two different requirements
  // that only happen to coincide: the callback origin must be reachable BY
  // QSTASH, and this one must be reachable by a person reading their mail. They
  // diverge the moment a tunnel is used for local worker testing. The email
  // renderer falls back from this to the callback origin, and with neither set
  // it drops the link rather than rendering a relative href that goes nowhere.
  APP_ORIGIN: z.string().url().optional(),

  RESEND_API_KEY: z.string().min(10).optional(),

  // The From header. Configurable and defaulted in src/lib/email/client.ts to
  // Resend's shared `onboarding@resend.dev` sandbox sender, which is a
  // PLACEHOLDER: no domain is verified on this account yet, and the key in
  // use is send-scoped so it cannot even read the domains API to find out.
  // Once a domain is verified this becomes something like
  // `Giya <no-reply@giya.ph>` and nothing else changes.
  EMAIL_FROM: z.string().min(3).optional(),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) {
    return cachedServerEnv;
  }

  const parsed = serverEnvSchema.safeParse({
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    REDEMPTION_TOKEN_SECRET: process.env.REDEMPTION_TOKEN_SECRET,
    // An empty string is how a platform dashboard records "set but blank";
    // for an optional key that must read as absent, not as an invalid URL.
    OCR_SERVICE_URL: emptyToUndefined(process.env.OCR_SERVICE_URL),
    OCR_SERVICE_TOKEN: emptyToUndefined(process.env.OCR_SERVICE_TOKEN),
    SUPABASE_EDGE_OCR_URL: emptyToUndefined(process.env.SUPABASE_EDGE_OCR_URL),
    OCR_FUNCTION_SECRET: emptyToUndefined(process.env.OCR_FUNCTION_SECRET),
    SUPABASE_SERVICE_ROLE_KEY: emptyToUndefined(process.env.SUPABASE_SERVICE_ROLE_KEY),
    HF_TOKEN: emptyToUndefined(process.env.HF_TOKEN),
    HF_EMBED_MODEL: emptyToUndefined(process.env.HF_EMBED_MODEL),
    GROQ_API_KEY: emptyToUndefined(process.env.GROQ_API_KEY),
    GROQ_MODEL: emptyToUndefined(process.env.GROQ_MODEL),
    QSTASH_URL: emptyToUndefined(process.env.QSTASH_URL),
    QSTASH_TOKEN: emptyToUndefined(process.env.QSTASH_TOKEN),
    QSTASH_CURRENT_SIGNING_KEY: emptyToUndefined(process.env.QSTASH_CURRENT_SIGNING_KEY),
    QSTASH_NEXT_SIGNING_KEY: emptyToUndefined(process.env.QSTASH_NEXT_SIGNING_KEY),
    QSTASH_CALLBACK_ORIGIN: emptyToUndefined(process.env.QSTASH_CALLBACK_ORIGIN),
    APP_ORIGIN: emptyToUndefined(process.env.APP_ORIGIN),
    RESEND_API_KEY: emptyToUndefined(process.env.RESEND_API_KEY),
    EMAIL_FROM: emptyToUndefined(process.env.EMAIL_FROM),
  });

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Invalid or missing server environment variables: ${missing}. Check .env.local.`,
    );
  }

  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}
