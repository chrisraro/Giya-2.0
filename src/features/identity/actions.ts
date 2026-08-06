"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { toErrorMessage } from "@/lib/auth/error-message";
import { createClient } from "@/lib/supabase/server";

import {
  AVATARS_BUCKET,
  AVATAR_ACCEPTED_MIME_TYPES,
  AVATAR_CANONICAL_MIME_TYPE,
  AVATAR_MAX_UPLOAD_BYTES,
  newAvatarObjectPath,
  objectPathFromPublicUrl,
} from "./avatar";
import { profileEditSchema, type ProfileEditInput } from "./profile-schema";
import { canonicalizeAvatarImage, sniffImageFormat } from "./server/avatar-image";

export type ActionResult = { ok: true } | { ok: false; message: string };

/**
 * The avatar actions hand the resulting URL back rather than just "ok", so the
 * edit form can show the new photo immediately instead of guessing at it or
 * waiting for a server round trip to re-deliver its own props. `null` is the
 * result of a successful removal and is a real value, not a missing one.
 */
export type AvatarActionResult =
  | { ok: true; avatarUrl: string | null }
  | { ok: false; message: string };

// Typed as the failure ARM rather than as ActionResult, so it is assignable to
// every result union in this file (ActionResult and AvatarActionResult) instead
// of only the first one.
const NOT_SIGNED_IN: { ok: false; message: string } = {
  ok: false,
  message: "You need to be signed in to do that.",
};

/**
 * The screens these actions serve. Both are `force-dynamic`, so this is belt
 * rather than braces - but a stale render of a profile that says the old name
 * back at someone who just changed it is the exact thing that makes a save feel
 * like it did not happen.
 */
function revalidateProfileSurfaces(): void {
  revalidatePath("/profile");
  revalidatePath("/profile/edit");
}

/**
 * Persists the consumer onboarding wizard's answers: resolves the chosen
 * city name to a `ref_cities.id` (an unrecognized name resolves to null and
 * the action still succeeds, matching doc 30's tolerant-write semantics),
 * then updates the caller's `consumers` row and stamps
 * `profiles.onboarded_at`.
 */
export async function completeConsumerOnboarding({
  cityName,
  pushEnabled,
}: {
  cityName: string | null;
  pushEnabled: boolean;
}): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NOT_SIGNED_IN;
  }

  let cityId: string | null = null;
  if (cityName) {
    const { data: city } = await supabase
      .from("ref_cities")
      .select("id")
      .ilike("name", cityName)
      .maybeSingle();
    cityId = city?.id ?? null;
  }

  const { error: consumerError } = await supabase
    .from("consumers")
    .update({ city_id: cityId, push_enabled: pushEnabled })
    .eq("id", user.id);

  if (consumerError) {
    return { ok: false, message: consumerError.message };
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", user.id);

  if (profileError) {
    return { ok: false, message: profileError.message };
  }

  return { ok: true };
}

/**
 * Persists the `/profile/edit` form: `profiles.display_name` and
 * `consumers.city_id`.
 *
 * NO NEW COLUMN GRANTS WERE NEEDED FOR THIS.
 * 0021_consumer_selfupdate_column_fence.sql already grants `authenticated`
 * UPDATE on exactly `profiles.display_name, avatar_url, phone, locale,
 * onboarded_at, updated_by` and `consumers.city_id, marketing_opt_in,
 * push_enabled, email_enabled, gps_fraud_opt_in, updated_by`. It deliberately
 * withheld `scan_blocked_until`, `last_scan_at`, `lifetime_points_earned`,
 * `referral_code`, `referred_by`, `is_suspended` and the `birth_date` pair, and
 * this action writes none of them. The two columns below are inside the fence
 * that already exists.
 *
 * The Zod bounds come from profile-schema.ts, which mirrors the column's own
 * `char_length(display_name) between 1 and 80` check from 0002_identity.sql.
 * Validating here rather than only in the form is the point: a server action is
 * a public endpoint, and the browser is not the only thing that can call it.
 */
export async function saveConsumerProfile(input: ProfileEditInput): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NOT_SIGNED_IN;

  const parsed = profileEditSchema.safeParse(input);
  if (!parsed.success) {
    // `||` and not `??`: a Zod issue with an empty message is falsy but not
    // nullish, and `??` would let "" through to render as a blank alert. That
    // is the live bug toErrorMessage exists for; the same rule applies here.
    return {
      ok: false,
      message: parsed.error.issues[0]?.message || "That did not look right. Have another look.",
    };
  }

  const { displayName, cityName } = parsed.data;

  let cityId: string | null = null;
  if (cityName !== null) {
    const { data: city, error: cityError } = await supabase
      .from("ref_cities")
      .select("id")
      .ilike("name", cityName)
      .maybeSingle();

    if (cityError) return { ok: false, message: toErrorMessage(cityError) };

    // completeConsumerOnboarding tolerates an unknown city and stores null,
    // because onboarding must never be blocked by it. This surface is the
    // opposite: the consumer is here specifically to change something, and
    // quietly saving "no city" over the city they just picked would be a save
    // that reports success and did the wrong thing.
    if (!city) {
      return {
        ok: false,
        message: "We could not match that city. Pick one from the list and try again.",
      };
    }
    cityId = city.id;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ display_name: displayName })
    .eq("id", user.id);

  if (profileError) return { ok: false, message: toErrorMessage(profileError) };

  const { error: consumerError } = await supabase
    .from("consumers")
    .update({ city_id: cityId })
    .eq("id", user.id);

  if (consumerError) return { ok: false, message: toErrorMessage(consumerError) };

  revalidateProfileSurfaces();
  return { ok: true };
}

/** The caller's current `profiles.avatar_url`, or null. */
async function readAvatarUrl(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("id", userId)
    .maybeSingle();
  return data?.avatar_url ?? null;
}

/**
 * Deletes an object that is no longer pointed at, best effort.
 *
 * Best effort is deliberate and is the whole ordering rule of this file: the
 * row is repointed FIRST and the old object removed second, so a failure here
 * leaves an orphaned object rather than a profile pointing at a hole. An orphan
 * costs storage; a hole is a broken avatar on someone's own profile.
 */
async function discardAvatarObject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  publicUrl: string | null,
): Promise<void> {
  const path = objectPathFromPublicUrl(publicUrl);
  if (path === null) return;

  const { error } = await supabase.storage.from(AVATARS_BUCKET).remove([path]);
  if (error) {
    console.error("[avatars] could not remove a replaced avatar object", error);
  }
}

/**
 * Uploads a new avatar and points `profiles.avatar_url` at it.
 *
 * Takes FormData because the payload is a file: React serializes a File across
 * the action boundary inside FormData and nowhere else.
 *
 * The bytes that reach the bucket are NOT the bytes the consumer picked. They
 * are re-encoded to a square JPEG first, which strips the EXIF GPS tag a phone
 * camera writes - and 0064's bucket is PUBLIC, so that step is load-bearing
 * rather than tidy. The declared Content-Type is not trusted for this: it is
 * whatever the browser put on the multipart part, so the format is decided by
 * sniffing magic bytes.
 *
 * The upload runs on the SESSION client, not the service role, on purpose.
 * `upload` needs `insert` on storage.objects, so 0064's owner-prefix policy is
 * evaluated against the caller: even if the path construction were wrong,
 * Postgres would refuse to write into another consumer's folder. The service
 * role would bypass exactly the fence that makes this safe.
 */
export async function saveConsumerAvatar(formData: FormData): Promise<AvatarActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NOT_SIGNED_IN;

  const file = formData.get("avatar");
  if (file === null || typeof file === "string" || file.size === 0) {
    return { ok: false, message: "Pick a photo first, then save." };
  }

  if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
    const megabytes = Math.floor(AVATAR_MAX_UPLOAD_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `That photo is larger than ${megabytes} MB. Try a smaller one.`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffImageFormat(bytes) === null) {
    return {
      ok: false,
      message: `Photos here can be ${AVATAR_ACCEPTED_MIME_TYPES.map(shortFormatName).join(", ")}.`,
    };
  }

  let canonical: Uint8Array;
  try {
    canonical = await canonicalizeAvatarImage(bytes);
  } catch (error) {
    console.error("[avatars] could not re-encode an upload", error);
    return { ok: false, message: "We could not read that photo. Try a different one." };
  }

  // Read the OLD url before anything is written, so the cleanup below knows what
  // it is replacing even if the update succeeds and the read would then return
  // the new value.
  const previousUrl = await readAvatarUrl(supabase, user.id);

  const objectPath = newAvatarObjectPath(user.id);
  const { error: uploadError } = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(objectPath, canonical, {
      contentType: AVATAR_CANONICAL_MIME_TYPE,
      upsert: false,
    });

  if (uploadError) {
    console.error("[avatars] upload failed", uploadError);
    return { ok: false, message: toErrorMessage(uploadError) };
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(objectPath);

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id);

  if (updateError) {
    // The object landed but nothing points at it. Remove it rather than leave a
    // public orphan behind a failed save: this is the one case where cleaning up
    // the NEW object is right, because the profile still points at the old one.
    await discardAvatarObject(supabase, publicUrl);
    return { ok: false, message: toErrorMessage(updateError) };
  }

  // Only now is the previous object unreferenced.
  await discardAvatarObject(supabase, previousUrl);

  revalidateProfileSurfaces();
  return { ok: true, avatarUrl: publicUrl };
}

/**
 * Clears `profiles.avatar_url` and removes the object behind it.
 *
 * Removing the object matters and is not optional tidiness: the bucket is
 * public and CDN-served, so a row cleared without a delete leaves a
 * permanently-fetchable copy of a face the consumer just took down. "Remove"
 * has to mean removed.
 *
 * Idempotent: removing an avatar that is not there succeeds and writes nothing.
 */
export async function removeConsumerAvatar(): Promise<AvatarActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NOT_SIGNED_IN;

  const previousUrl = await readAvatarUrl(supabase, user.id);
  if (previousUrl === null) {
    revalidateProfileSurfaces();
    return { ok: true, avatarUrl: null };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ avatar_url: null })
    .eq("id", user.id);

  if (error) return { ok: false, message: toErrorMessage(error) };

  await discardAvatarObject(supabase, previousUrl);

  revalidateProfileSurfaces();
  return { ok: true, avatarUrl: null };
}

/** "image/jpeg" -> "JPEG". Copy, not logic: the alert reads to a person. */
function shortFormatName(mimeType: string): string {
  return (mimeType.split("/")[1] ?? mimeType).toUpperCase();
}

/**
 * Ends the caller's session for real, then sends them to /login.
 *
 * This has to be a server action rather than a link: signing out means
 * deleting the `sb-*` auth cookies, and only a Server Action or Route Handler
 * may write cookies in Next.js. The server client built by
 * src/lib/supabase/server.ts hands @supabase/ssr a `setAll` that writes
 * straight to the request's cookie store, so `auth.signOut()` clearing the
 * session locally is what physically expires those cookies on the response;
 * the swallow-on-failure `catch` in that factory only applies to Server
 * Components, and this is not one.
 *
 * Errors are deliberately not surfaced. `signOut()` drops the local session
 * before it ever calls the Auth server, so a network failure still leaves the
 * caller signed out on this device, and stranding them on a page that still
 * looks signed-in would be strictly worse than continuing to /login.
 *
 * The redirect is last and outside any try/catch on purpose: `redirect()`
 * signals by throwing, so catching around it would swallow the navigation.
 */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Registers a new business for the signed-in owner via the
 * `register_business` RPC. The wizard's business type and city fields are
 * display names (e.g. "Cafe", "Cebu"); the RPC accepts a slug or display
 * name case-insensitively, so they are forwarded as-is.
 */
export async function registerBusiness({
  name,
  type,
  city,
  address,
}: {
  name: string;
  type: string;
  city: string;
  address: string;
}): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NOT_SIGNED_IN;
  }

  const { error } = await supabase.rpc("register_business", {
    p_name: name,
    p_type: type,
    p_city: city,
    p_address: address,
  });

  if (error) {
    return { ok: false, message: error.message };
  }

  return { ok: true };
}
