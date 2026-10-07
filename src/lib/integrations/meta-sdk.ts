import "server-only";

import { getServerEnv } from "@/lib/env";

/**
 * Giya's Meta app id for the browser SDK (`appId=` on sdk.js), so the Page
 * Plugin is attributed to Giya's Meta app rather than rendered anonymously.
 * Public by nature - Meta prints it in every plugin iframe URL. Read on the
 * server and passed down, so the env schema never ships to the client.
 */
export function getMetaAppIdForSdk(): string | null {
  try {
    return getServerEnv().META_APP_ID ?? null;
  } catch {
    return null;
  }
}
