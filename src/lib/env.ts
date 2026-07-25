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
});

type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) {
    return cachedServerEnv;
  }

  const parsed = serverEnvSchema.safeParse({
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    REDEMPTION_TOKEN_SECRET: process.env.REDEMPTION_TOKEN_SECRET,
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
