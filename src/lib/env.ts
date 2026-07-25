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
  // Optional for the same reason: the service-role key is a credential and
  // credentials land at the end of the build. Server-side readers that need
  // it (the receipt settings loader, later the processing orchestrator)
  // degrade to documented defaults and log rather than throwing, so a
  // key-less dev environment still runs the pipeline.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
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
    SUPABASE_SERVICE_ROLE_KEY: emptyToUndefined(process.env.SUPABASE_SERVICE_ROLE_KEY),
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
