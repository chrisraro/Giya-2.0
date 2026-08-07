import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface CnameBusinessDTO {
  id: string;
  slug: string;
  name: string;
}

export async function resolveBusinessFromCname(
  hostname: string,
): Promise<CnameBusinessDTO | null> {
  const cleanHost = hostname.toLowerCase().trim();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("businesses")
    .select("id, slug, name")
    .eq("website", cleanHost)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
  };
}
