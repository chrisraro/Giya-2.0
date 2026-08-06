import { z } from "zod";

import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";
import { withMinDelay } from "@/lib/auth/timing";
import { checkRateLimit } from "@/lib/rate-limit";
import { redisKey } from "@/lib/redis";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const bodySchema = z.object({
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .regex(EMAIL_RE, "Enter a valid email address")
    .toLowerCase(),
});

type ForgotPasswordBody = z.infer<typeof bodySchema>;

interface ForgotPasswordResponse {
  message: string;
}

// Two independent budgets, not one, because per-IP and per-address guard
// against different attacks and neither alone is enough:
//
//   Per-IP catches ONE SOURCE hitting MANY addresses - enumeration sweeps,
//   or spraying recovery email at a list of victims who never asked for it
//   (the "email-amplification vector against arbitrary third parties" this
//   route exists to close). Per-address alone would never catch this: each
//   individual address is only hit once, so no single address ever crosses
//   its own threshold.
//
//   Per-address catches ONE TARGET being hit repeatedly - whether from one
//   IP or, by rotating through a botnet/VPN/proxy list, many. Per-IP alone
//   would never catch this: an attacker who simply changes IP between
//   requests resets their IP budget every time while the same victim's
//   inbox (and this app's Supabase Auth email quota) keeps absorbing hits.
//
// A request is refused if EITHER budget is exhausted. Per-IP is generous
// (10/10min) since it is a blunt instrument that could otherwise punish a
// shared NAT (an office, a campus); per-address is tight (3/15min) since
// there is no legitimate reason for the same address to need more than a
// couple of reset links in that window, and it is the one guarding a THIRD
// PARTY's inbox rather than the caller's own budget.
const IP_RATE_LIMIT = 10;
const IP_RATE_LIMIT_WINDOW_SECONDS = 600;
const EMAIL_RATE_LIMIT = 3;
const EMAIL_RATE_LIMIT_WINDOW_SECONDS = 900;

// Floor under the resetPasswordForEmail round trip so a known address (which
// may involve minting a token and handing off to the mail provider) and an
// unknown one (which can short-circuit) are not distinguishable by how long
// the request took. See src/lib/auth/timing.ts. Deliberately applied ONLY
// around this one call, after both rate-limit checks: a request refused for
// being over budget is refused for a reason that has nothing to do with
// whether the address exists (both dimensions key on the caller/address, not
// on Supabase's answer), so there is no reason to slow that path down too -
// doing so would only make a legitimate caller's 429 feel worse for no
// enumeration-resistance benefit.
const MIN_RESPONSE_DELAY_MS = 800;

function rateLimitedError(resetSeconds: number): ApiError {
  return new ApiError(
    429,
    API_ERROR_CODES.RATE_LIMITED,
    "Too many requests. Please wait a moment and try again.",
    undefined,
    { "Retry-After": String(resetSeconds) },
  );
}

export const POST = defineHandler<ForgotPasswordResponse, ForgotPasswordBody>({
  route: "auth-forgot-password",
  schema: bodySchema,
  rateLimit: {
    limit: IP_RATE_LIMIT,
    windowSeconds: IP_RATE_LIMIT_WINDOW_SECONDS,
    keyBy: "ip",
  },
  handler: async ({ body, request, supabase }) => {
    // The email-scoped budget can only be checked here, inside the handler,
    // not via the `rateLimit` config above: doc 13's pipeline runs rate
    // limiting (step 5) before body parsing (step 6), and the address lives
    // in the body. See the file-level comment for why this is a second,
    // independent check rather than a single composite (ip, email) key.
    const emailLimit = await checkRateLimit({
      key: redisKey("rl", "auth-forgot-password-email", body.email),
      limit: EMAIL_RATE_LIMIT,
      windowSeconds: EMAIL_RATE_LIMIT_WINDOW_SECONDS,
    });
    if (!emailLimit.ok) {
      throw rateLimitedError(emailLimit.resetSeconds);
    }

    // Deliberately not branching on the outcome here, in either direction:
    // Supabase's own recovery endpoint answers alike for a registered and
    // an unregistered address, and this route must not reintroduce the leak
    // by treating a rejected promise (network hiccup, provider error) any
    // differently from a resolved one - including via defineHandler's own
    // generic-500 fallback, which is why this needs its own try/catch rather
    // than letting the pipeline's catch-all handle it. The catch block is
    // empty on purpose: surfacing the failure would itself be a second,
    // louder channel for the same leak this route exists to close.
    try {
      await withMinDelay(
        () =>
          supabase.auth.resetPasswordForEmail(body.email, {
            redirectTo: `${request.nextUrl.origin}/auth/callback?next=/reset-password`,
          }),
        MIN_RESPONSE_DELAY_MS,
      );
    } catch {
      // Swallowed intentionally - see comment above.
    }

    return {
      data: { message: "If that address has an account, we've sent a link." },
    };
  },
});
