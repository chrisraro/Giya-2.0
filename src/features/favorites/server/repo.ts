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

  if (error || !data) return [];

  return data
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
