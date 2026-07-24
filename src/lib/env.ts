import { z } from "zod";

// Client-safe environment schema. Only NEXT_PUBLIC_* keys belong here since
// this module can be imported from browser code; Next.js statically inlines
// these at build time, so reads must be direct property accesses (not a
// dynamic key loop) for the inlining to work.
const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

function loadEnv() {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
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
