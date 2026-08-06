import { z } from "zod";

import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";
import { RECOVERY_COOKIE_NAME, clearRecoveryCookieHeader } from "@/lib/auth/recovery-cookie";

const bodySchema = z.object({
  password: z.string().min(1, "Password is required"),
});

type ResetPasswordBody = z.infer<typeof bodySchema>;

interface ResetPasswordResponse {
  message: string;
}

// POST /api/v1/auth/reset-password - the ONLY place updateUser() is called
// for a password reset. This is what makes the recovery cookie a genuine
// authorization control rather than just a UI hint: reset-password/page.tsx
// still asks GET /auth/recovery-status on mount to decide what to RENDER,
// but that check has no enforcement power of its own - a client could
// always skip straight to submitting the form. This route is what actually
// refuses the write when the cookie is not there, requireSession (doc 13
// step 2) is what refuses it when there is no session at all, and the two
// checks are deliberately independent: a signed-in user with no recovery
// cookie is a 403, not a 401, since they ARE authenticated, just not
// authorized for this specific action.
export const POST = defineHandler<
  ResetPasswordResponse,
  ResetPasswordBody,
  Record<string, string | string[]>,
  Record<string, string>,
  true
>({
  route: "auth-reset-password",
  requireSession: true,
  schema: bodySchema,
  authorize: ({ request }) => {
    const verified = request.cookies.get(RECOVERY_COOKIE_NAME)?.value === "1";
    if (!verified) {
      throw new ApiError(
        403,
        API_ERROR_CODES.FORBIDDEN,
        "That link expired or was already used.",
      );
    }
    return undefined;
  },
  handler: async ({ body, supabase }) => {
    const { error } = await supabase.auth.updateUser({ password: body.password });
    if (error) {
      // The caller already holds a valid, recovery-authorized session at
      // this point, so - unlike src/app/api/v1/auth/forgot-password/route.ts,
      // which must never let its response vary by outcome - surfacing
      // Supabase's own message (e.g. its password policy) is not an
      // enumeration leak, just ordinary form validation feedback. The
      // cookie is deliberately NOT cleared on this path: the recovery
      // window should still let the caller correct the password and retry
      // without needing a whole new email.
      throw new ApiError(422, API_ERROR_CODES.VALIDATION_FAILED, error.message);
    }

    return {
      data: { message: "Password updated." },
      // Clears the recovery cookie now that it has done its one job.
      // Leaving it live for its full 10-minute TTL past a successful reset
      // would let the caller sign in normally with the new password,
      // navigate back to /reset-password, and have recovery-status still
      // answer verified: true - an ordinary session passing the recovery
      // gate, which is exactly the property this whole design exists to
      // prevent (see recovery-cookie.ts's own comment on this).
      headers: { "Set-Cookie": clearRecoveryCookieHeader() },
    };
  },
});
