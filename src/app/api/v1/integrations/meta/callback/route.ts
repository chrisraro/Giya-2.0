import { NextResponse, type NextRequest } from "next/server";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { BUSINESS_SETTINGS_ROLES } from "@/features/businesses/settings/roles";
import { completeCallback } from "@/features/integrations/meta/server/service";
import { verifyState } from "@/features/integrations/meta/server/state";

// =============================================================================
// GET /api/v1/integrations/meta/callback
// =============================================================================
//
// docs/30-modules/42-integrations.md's connect flow, the second half: callback
// verifies state, exchanges code server-side, lists Pages, user picks Page(s).
//
// -----------------------------------------------------------------------------
// WHY THE URL NAMES NO BUSINESS
// -----------------------------------------------------------------------------
//
// Meta requires every redirect_uri to EXACTLY match an entry in the app's
// "Valid OAuth Redirect URIs" (strict mode, no wildcards). A per-business path
// can never be registered for every merchant, so there is ONE static callback
// (https://www.giya.ph/api/v1/integrations/meta/callback) and the business is
// carried in the server-held `state` (state.ts). The business id is therefore
// read FROM THE VERIFIED STATE, never from the query string or the path.
//
// -----------------------------------------------------------------------------
// THE ORDER OF THE STEPS IS THE SECURITY PROPERTY
// -----------------------------------------------------------------------------
//
//   1. session + role     -> no session, no flow: a callback is a GET an
//                            attacker can make a browser issue, and the state
//                            must be bound to a "who". Owner/manager only.
//   2. VERIFY THE STATE   -> before the code is looked at, let alone exchanged.
//                            Single-use (atomic GETDEL), bound to the user who
//                            started the flow. See state.ts for the attacks.
//   3. tenancy            -> the business the state was minted for must be the
//                            caller's own managed business. Re-checked here
//                            because membership can change inside the 10-minute
//                            window.
//   4. exchange the code  -> only now, and only server-side.
//
// -----------------------------------------------------------------------------
// WHY THIS ROUTE DOES NOT USE defineHandler
// -----------------------------------------------------------------------------
//
// The caller is a BROWSER FOLLOWING A REDIRECT FROM FACEBOOK and the answer must
// be another redirect back to settings; doc 13's JSON envelope means nothing to
// a browser navigation. What is NOT skipped is the discipline: session, state,
// tenancy, and nothing about a failure in the response.
//
// -----------------------------------------------------------------------------
// WHAT THE MERCHANT SEES WHEN SOMETHING GOES WRONG
// -----------------------------------------------------------------------------
//
// A redirect to /business/settings carrying a COARSE outcome and nothing else.
// "State unknown" and "state for another user" are different facts about our
// storage; telling a prober which applies turns a closed door into an oracle
// (src/lib/queue/verify.ts rule 4). The precise reason goes to the server log.
// Neither the code nor any token is ever logged.

/** Where the merchant lands afterwards, with the outcome as a query flag. */
const SETTINGS_PATH = "/business/settings";

type Outcome =
  | "cancelled"
  | "denied"
  | "rejected"
  | "failed"
  | "unavailable"
  | "no_pages"
  | "not_configured";

function back(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(SETTINGS_PATH, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // 303: the browser must follow this with a GET. A 302 after a GET is
  // equivalent in practice, but 303 states the intent and survives a future
  // change of method on this route.
  return NextResponse.redirect(url, 303);
}

function fail(request: NextRequest, outcome: Outcome, logReason: string): NextResponse {
  // The REASON stays here. The merchant gets the coarse outcome.
  console.warn(`[integrations/meta/callback] ${logReason}`);
  return back(request, { meta: outcome });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // --- 1. session and role ------------------------------------------------
  // resolveStaffContext reads the caller's membership under their OWN session
  // and returns null for no session, no active membership, or a role outside
  // the owner/manager pair.
  let staff: Awaited<ReturnType<typeof resolveStaffContext>>;
  try {
    staff = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  } catch (error: unknown) {
    // A failed membership read is not "denied": the merchant did nothing wrong
    // and should be told to retry. Nothing is exchanged either way.
    console.error("[integrations/meta/callback] membership read failed", error);
    return back(request, { meta: "unavailable" });
  }
  if (staff === null) {
    return fail(request, "denied", "callback from a caller who cannot manage a business");
  }

  const query = request.nextUrl.searchParams;

  // Meta reports a declined consent dialog as `error`, not as an absent code.
  // It is a normal outcome, not a failure: the merchant pressed Cancel.
  const providerError = query.get("error");
  if (providerError !== null) {
    // NOTE: `error_description` is Meta's text and is deliberately not
    // forwarded to the merchant or interpolated into the log line.
    console.info(`[integrations/meta/callback] consent was not granted (${providerError})`);
    return back(request, { meta: "cancelled" });
  }

  // --- 2. THE STATE, BEFORE ANYTHING ELSE ---------------------------------
  const state = await verifyState({ state: query.get("state"), userId: staff.userId });
  if (!state.ok) {
    return fail(request, "rejected", `state rejected: ${state.reason}`);
  }

  // --- 3. tenancy, from the state -----------------------------------------
  // The business comes from what WE stored; it must still be the caller's own.
  const businessId = state.businessId;
  if (staff.businessId !== businessId) {
    return fail(request, "denied", `state for ${businessId} completed by a non-manager of it`);
  }

  const code = query.get("code");
  if (code === null || code.length === 0) {
    // A verified state with no code is a malformed callback, not an attack -
    // but there is nothing to exchange either way.
    return fail(request, "failed", `callback for ${businessId} carried no code`);
  }

  // --- 4. exchange, server-side -------------------------------------------
  // The redirect_uri from the STORED state, not rebuilt from this request:
  // Meta requires it to be byte-identical to the one the dialog was opened
  // with, and a value derived from the incoming request is one the caller
  // influences.
  const result = await completeCallback({
    businessId,
    userId: staff.userId,
    code,
    redirectUri: state.redirectUri,
  });

  if (!result.ok) {
    switch (result.failure) {
      case "no_pages":
        // Not an error. The merchant signed in with an account that
        // administers no Page, and the settings screen says exactly that.
        return back(request, { meta: "no_pages" });
      case "unavailable":
        return fail(request, "unavailable", `Meta was unavailable completing ${businessId}`);
      case "not_configured":
        return fail(request, "not_configured", `callback reached a dormant Meta integration`);
      default:
        return fail(request, "failed", `token exchange failed for ${businessId}`);
    }
  }

  // The selection id is opaque and single-use, and it addresses a payload that
  // is encrypted at rest in Redis (selection.ts). No token travels in this URL.
  return back(request, { meta: "select", sid: result.selectionId });
}
