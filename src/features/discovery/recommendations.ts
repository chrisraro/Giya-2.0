import { createClient } from "@/lib/supabase/server";
import type { BusinessSummary } from "@/features/businesses/server/public-repo";

export async function getVectorRecommendations(
  userId: string | null,
  searchQuery?: string,
): Promise<BusinessSummary[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("businesses")
    .select(`
      id,
      slug,
      name,
      logo_url,
      city_id,
      business_type_id
    `)
    .eq("status", "active")
    .limit(10);

  if (error || !data) return [];

  return data.map((b) => ({
    id: b.id,
    slug: b.slug,
    name: b.name,
    logoUrl: b.logo_url,
    cityName: null,
    businessTypeName: null,
  }));
}
