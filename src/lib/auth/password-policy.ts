import { z } from "zod";

// Doc 15 password policy: min 8. Max 72 because bcrypt (Supabase Auth)
// silently truncates past 72 bytes, so a longer value would give a false
// sense of strength. One schema so every server boundary agrees; the
// client-side forms mirror the same copy for UX only.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export const passwordSchema = z
  .string()
  .min(1, "Password is required")
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
