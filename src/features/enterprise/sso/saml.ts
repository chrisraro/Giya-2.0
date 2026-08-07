import "server-only";

import { createClient } from "@/lib/supabase/server";

export interface SamlSsoConfigDTO {
  id: string;
  businessId: string;
  domain: string;
  provider: "okta" | "azure_ad" | "ping_identity" | "custom_saml";
  entityId: string;
  ssoUrl: string;
}

export async function resolveSamlSsoConfig(
  email: string,
): Promise<SamlSsoConfigDTO | null> {
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[1]) return null;

  const domain = parts[1].toLowerCase();
  const supabase = await createClient();

  const { data, error } = await (supabase as any)
    .from("enterprise_sso_configs")
    .select("id, business_id, domain, provider, entity_id, sso_url")
    .eq("domain", domain)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    businessId: data.business_id,
    domain: data.domain,
    provider: data.provider,
    entityId: data.entity_id,
    ssoUrl: data.sso_url,
  };
}
