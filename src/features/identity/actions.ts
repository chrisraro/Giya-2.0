"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; message: string };

const NOT_SIGNED_IN: ActionResult = {
  ok: false,
  message: "You need to be signed in to do that.",
};

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
