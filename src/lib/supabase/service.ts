import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

import type { Database } from "./types";

// Service-role Supabase client. This client BYPASSES RLS entirely, so it must
// never be reachable from client code: the "server-only" import above is the
// build-time fence (same pattern as src/features/rewards/server/token.ts), and
// nothing here reads a request cookie, so it can never accidentally act as a
// signed-in user.
//
// Why it exists: several tables in this codebase are deliberately unreadable by
// every client role. The one this module was added for is `settings` at
// scope='platform' (supabase/migrations/0017_receipts.sql) - those rows are the
// fraud rulebook (velocity caps, pHash bands, the composite review threshold,
// how many rejections are free) and publishing them to a signed-in consumer
// would hand an abuser the exact numbers to stay under. The migration therefore
// gives platform rows NO client select policy at all, which makes a server-side
// service-role read the only way to see them.
//
// Returns null when SUPABASE_SERVICE_ROLE_KEY is unset rather than throwing.
// The key is a credential and credentials arrive at the end of the build, so
// every caller has to have a documented degraded path anyway (the settings
// loader falls back to its hardcoded defaults and logs). A throw here would
// turn "no credential yet" into an unhandled pipeline failure, which is exactly
// what the fallbacks exist to prevent.
// Read straight from process.env rather than through getServerEnv(), which
// validates the WHOLE server schema as a unit and throws naming every missing
// key. Going through it defeated the contract stated directly above: a
// deployment missing an unrelated required variable (UPSTASH_REDIS_REST_URL,
// REDEMPTION_TOKEN_SECRET) threw here even though the service-role key itself
// was present and correct. That is not hypothetical - it took out all eight
// business portal routes at once, because the portal LAYOUT calls
// countPendingReview, which calls this, and an exception in a layout has no
// route-level boundary to land in. The same-shaped validation still applies
// (the schema declares min(20)), so a truncated or placeholder key is still
// treated as absent rather than handed to Supabase.
export function createServiceRoleClient(): SupabaseClient<Database> | null {
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const serviceRoleKey = raw !== undefined && raw.length >= 20 ? raw : undefined;
  if (serviceRoleKey === undefined) return null;

  return createSupabaseClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: {
      // No user session is ever involved: no storage to persist to, no token
      // to refresh, and no URL to detect a session in. Leaving these on would
      // have the client try to write to a storage adapter that does not exist
      // in a server runtime.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
