import "server-only";

import type { RoundingMode } from "@/features/points/types";
import type { ScanPreviewRule } from "@/features/receipts/components/scan-preview";
import { createServiceRoleClient } from "@/lib/supabase/service";

// ===========================================================================
// THE SHOP'S OWN BASE EARNING RULE, FOR THE /scan ESTIMATE.
//
// Why this read exists at all: `previewReceiptPointsAction` defaults to 1 point
// per peso when no rate is supplied. That default is fine for an illustration
// and false for a shop, and /scan shows the number to the consumer standing at
// that shop's counter. Estimating 300 points on a 300 peso receipt at a shop
// whose base rule is 1 point per 50 pesos is not "approximate", it is a
// different number, and the consumer has no way to know which one to believe.
// So: preview under the real rule, or do not preview.
//
// WHAT IS DISCLOSED, AND WHY THAT IS ACCEPTABLE. The value that reaches the
// browser is the earning rate of a publicly listed, active shop, shown to a
// signed-in consumer who is standing in that shop with its receipt in hand. It
// is counter signage: the number the merchant advertises to exactly this person
// at exactly this moment. No consumer-owned data crosses this client, and no
// other column of the row does either.
//
// WHY SERVICE ROLE, GIVEN THAT. `points_rules` has exactly three policies, all
// from 0012_campaigns.sql, and all three are staff-scoped
// (`points_rules_staff_select/insert/update`). No client role can read this
// table, and there is no view or RPC over it anywhere in the codebase, so this
// is service-role or no estimate.
//
// A `select` policy would be the WRONG fix, not merely one this task cannot
// make. RLS cannot restrict columns, so a policy publishes the whole row:
// `conditions` (the campaign targeting DSL) and `created_by` / `updated_by`,
// both `uuid references auth.users(id)`. The right long-term shape is a
// two-column view (`business_id`, `rate_centavos_per_point`, `rounding`) joined
// to active businesses, and this module should be repointed onto the ordinary
// client the day one exists.
//
// GATED ON AN AUTHORIZATION ANSWER THIS MODULE DOES NOT ITSELF HAVE. Service
// role means RLS fences nothing here: this function will return the base rule
// of a suspended, deactivated or soft-deleted business as readily as a live
// one. Its only caller therefore resolves the consumer's own RLS-scoped
// `listActiveBusinesses` FIRST and calls this only if that returned the shop -
// see the sequencing comment in src/app/(consumer)/scan/page.tsx. Any new
// caller owes the same check; this module cannot perform it for them.
//
// THROWS on a query error, per `src/features/rewards/server/repo.ts` and
// `src/features/loyalty/server/repo.ts`. `null` means something specific and
// non-exceptional: this shop has no active amount-rate base rule to preview.
// `/scan` catches, because the estimate is a nicety and the capture flow is the
// money path; that decision belongs to the page, not to this read.
// ===========================================================================

/** Doc 35's `points_rules_one_base` partial unique index makes this at most one row. */
export async function loadScanPreviewRule(businessId: string): Promise<ScanPreviewRule | null> {
  const supabase = createServiceRoleClient();
  // Documented degraded path, same as every other caller of this factory: no
  // service-role key configured yet means no estimate, not a broken /scan.
  if (supabase === null) return null;

  const { data, error } = await supabase
    .from("points_rules")
    .select("rate_centavos_per_point, rounding")
    .eq("business_id", businessId)
    .eq("kind", "base")
    // `fixed_per_visit` and `fixed_per_receipt` award the same points whatever
    // the receipt says, so a peso field previewing them would be a control that
    // does nothing. Those shops get no estimate rather than a fake one.
    .eq("rule_type", "amount_rate")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(
      `loadScanPreviewRule: failed to load the base earning rule: ${error.message}`,
    );
  }

  if (data === null) return null;

  // An amount_rate row with a null rate is a half-configured rule, not a rate
  // of zero: dividing by it is what would produce a headline number.
  const rate = data.rate_centavos_per_point;
  if (rate === null || rate <= 0) return null;

  return { rateCentavosPerPoint: rate, rounding: data.rounding as RoundingMode };
}
