import { createClient } from "@/lib/supabase/server";

export async function isFavorite(businessId: string): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return false;

  const { data } = await (supabase as any)
    .from("favorites")
    .select("id")
    .eq("user_id", user.id)
    .eq("business_id", businessId)
    .maybeSingle();

  return Boolean(data);
}

export async function addFavorite(businessId: string): Promise<{ ok: boolean; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, message: "Unauthenticated" };

  const { error } = await (supabase as any).from("favorites").insert({
    user_id: user.id,
    business_id: businessId,
  });

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function removeFavorite(businessId: string): Promise<{ ok: boolean; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, message: "Unauthenticated" };

  const { error } = await (supabase as any)
    .from("favorites")
    .delete()
    .eq("user_id", user.id)
    .eq("business_id", businessId);

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function listMyFavorites(): Promise<
  { id: string; businessId: string; slug: string; name: string; logoUrl: string | null; cityName: string | null; businessTypeName: string | null }[]
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data, error } = await (supabase as any)
    .from("favorites")
    .select(`
      id,
      business_id,
      businesses (
        id,
        slug,
        name,
        logo_url,
        city_id,
        business_type_id
      )
    `)
    .eq("user_id", user.id);

  // THROWS. It does not return [] for a query error.
  //
  // `[]` does not render as "something went wrong" at either call site: it is
  // /favorites' "No favorites saved yet. Tap the heart icon on any business
  // page to add it to your favorites", and it is /home silently dropping the
  // rail. A consumer whose read had just failed was told, in copy, that the
  // shops they had saved were never saved. `src/features/rewards/server/repo.ts`
  // and `src/features/loyalty/server/repo.ts` both settled this the same way,
  // and this is that convention rather than a third one: fail loud, and let the
  // caller degrade deliberately (/home catches, /favorites does not).
  //
  // `!data` is NOT folded in here. A signed-in consumer with no rows gets
  // `data: []`, which is a genuine answer and stays non-throwing.
  if (error) {
    throw new Error(`listMyFavorites: failed to load favorites: ${error.message}`);
  }

  return (data ?? [])
    .filter((row: any) => Boolean(row.businesses))
    .map((row: any) => ({
      id: row.id,
      businessId: row.business_id,
      slug: row.businesses.slug,
      name: row.businesses.name,
      logoUrl: row.businesses.logo_url,
      cityName: null,
      businessTypeName: null,
    }));
}
