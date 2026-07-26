import { NextResponse, type NextRequest } from "next/server";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { BUSINESS_SETTINGS_ROLES } from "@/features/businesses/settings/roles";
import { callbackUrl, completeCallback } from "@/features/integrations/meta/server/service";
import { verifyState } from "@/features/integrations/meta/server/state";

// =============================================================================
// GET /api/v1/businesses/{businessId}/integrations/meta/callback
// =============================================================================
//
// docs/30-modules/42-integrations.md's connect flow, the second half: "callback
// `/api/v1/businesses/{businessId}/integrations/meta/callback` verifies state,
// exchanges code server-side, lists Pages, user picks Page(s)".
//
// -----------------------------------------------------------------------------
// THE ORDER OF THE FIRST FOUR STEPS IS THE SECURITY PROPERTY
// -----------------------------------------------------------------------------
//
//   1. session            -> no session, no flow. A callback is a GET an
//                            attacker can make a browser issue; without this
//                            step there is no "who" to bind anything to.
//   2. tenancy            -> the caller must be an active owner/manager OF THE
//                            BUSINESS IN THE PATH. The path segment is
//                            attacker-controlled, so it is checked against the
//                            caller's real membership, never trusted.
//   3. VERIFY THE STATE   -> before the code is looked at, let alone exchanged.
//                            See state.ts for the three attacks this stops;
//                            the shortest version is that an unverified
//                            callback lets an attacker attach THEIR Facebook
//                            Page to a merchant's tenant.
//   4. exchange the code  -> only now, and only server-side.
//
// -----------------------------------------------------------------------------
// WHY THIS ROUTE DOES NOT USE defineHandler
// -----------------------------------------------------------------------------
//
// Two reasons, both about what the caller is. This endpoint is not called by
// our client; it is called by a BROWSER FOLLOWING A REDIRECT FROM FACEBOOK, and
// its answer must be another redirect that lands the merchant back on their
// settings screen. Doc 13's JSON envelope has no meaning to a browser
// navigation - a merchant would see a page of JSON.
//
// Nor is it a public contract despite living under /api/v1: the URL shape is
// doc 42's, and it is registered with Meta rather than with any client of
// ours. What is NOT skipped is the discipline: session, tenancy, state, and
// nothing about a failure in the response.
//
// -----------------------------------------------------------------------------
// WHAT THE MERCHANT SEES WHEN SOMETHING GOES WRONG
// -----------------------------------------------------------------------------
//
// A redirect to /business/settings carrying a COARSE outcome and nothing else.
// "State unknown", "state for another business" and "state for another user"
// are three different facts about our storage, and telling whoever is probing
// this endpoint which one applies turns a closed door into an oracle - the
// same rule src/lib/queue/verify.ts states as its rule 4. The precise reason
// goes to the server log.

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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ businessId: string }> },
): Promise<NextResponse> {
  const { businessId } = await context.params;

  // --- 1 + 2. session and tenancy -----------------------------------------
  // resolveStaffContext reads the caller's membership under their OWN session
  // and returns null for no session, no active membership, or a role outside
  // the owner/manager pair.
  const staff = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  if (staff === null || staff.businessId !== businessId) {
    // The two cases are collapsed on purpose: "you are not signed in" and
    // "that is not your business" are the same answer to someone probing.
    return fail(request, "denied", `callback for ${businessId} from a caller who cannot manage it`);
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

  // --- 3. THE STATE, BEFORE ANYTHING ELSE ---------------------------------
  const state = await verifyState({
    state: query.get("state"),
    businessId,
    userId: staff.userId,
  });
  if (!state.ok) {
    return fail(request, "rejected", `state rejected for ${businessId}: ${state.reason}`);
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
  // with, and a value derived from the incoming request is a value the caller
  // influences. `callbackUrl` is referenced here only so the two constructions
  // cannot silently diverge.
  const redirectUri = state.redirectUri || callbackUrl(request.nextUrl.origin, businessId);

  const result = await completeCallback({
    businessId,
    userId: staff.userId,
    code,
    redirectUri,
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
