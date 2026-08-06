import { createClient } from "@/lib/supabase/server";

// The signed-in consumer's own identity, for the two surfaces that are ABOUT
// the person rather than about their points: the /home greeting and /profile.
//
// RLS is the authorization boundary, same convention as every other repo in
// this codebase (see src/features/rewards/server/repo.ts): profiles and
// consumers both carry self-select policies, so the `.eq("id", user.id)`
// filters below are defense in depth, not the gate. The city name is resolved
// through ref_cities with a second single-row read rather than a PostgREST
// embed, matching getBusinessBySlug, because the generated Database types do
// not model embedded joins anywhere in this repo.

export interface ConsumerProfileDTO {
  userId: string;
  /** `profiles.display_name`. "" when no profile row is readable. */
  displayName: string;
  /** The session's email. "" when the session carries none (phone sign-up). */
  email: string;
  /** `consumers.city_id` resolved through `ref_cities`. Null when unset. */
  cityName: string | null;
  /**
   * `profiles.avatar_url`: the PUBLIC URL of an object in the `avatars` bucket
   * (0064). Null when the consumer has never set one, which is the common case
   * and is a real empty state rather than a missing value - /profile renders its
   * initials circle for it and always has.
   */
  avatarUrl: string | null;
}

/**
 * The caller's profile, or null when there is no session at all.
 *
 * Null is the signal the consumer pages gate on: it means "nobody is signed
 * in", and both /home and /profile turn it into a redirect to /login rather
 * than rendering a page shaped like a personal account. It is deliberately not
 * conflated with "signed in but the profile row is missing", which returns a
 * DTO with an empty displayName and renders the real, name-less version of the
 * page.
 */
export async function getMyConsumerProfile(): Promise<ConsumerProfileDTO | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const [{ data: profile }, { data: consumer }] = await Promise.all([
    supabase.from("profiles").select("display_name, avatar_url").eq("id", user.id).maybeSingle(),
    supabase.from("consumers").select("city_id").eq("id", user.id).maybeSingle(),
  ]);

  let cityName: string | null = null;
  if (consumer?.city_id) {
    const { data: city } = await supabase
      .from("ref_cities")
      .select("name")
      .eq("id", consumer.city_id)
      .maybeSingle();
    cityName = city?.name ?? null;
  }

  return {
    userId: user.id,
    displayName: profile?.display_name ?? "",
    email: user.email ?? "",
    cityName,
    // `|| null` and not `?? null`: the column is nullable text, and a row that
    // somehow holds "" is "no avatar", not an <img> pointed at the current page.
    avatarUrl: profile?.avatar_url || null,
  };
}
