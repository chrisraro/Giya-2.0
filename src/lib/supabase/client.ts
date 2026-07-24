import { createBrowserClient } from "@supabase/ssr";

import { env } from "@/lib/env";

import type { Database } from "./types";

// Browser client for Client Components. Safe to call repeatedly; the
// underlying client is cheap to construct and holds no server state.
export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
