import { redirect } from "next/navigation";

import { RedeemScanner } from "@/features/rewards/components/redeem-scanner";
import { resolveOwnerBusiness } from "@/features/businesses/server/resolve-owner-business";

// Server entry point for the staff counter scanner. Resolves the caller's
// business the same way every other portal page does (resolveOwnerBusiness -
// never a client-supplied id) purely to greet staff by name; the scanner
// itself needs no business-scoped data since /api/v1/redemptions/validate
// resolves the claim (and therefore the business) from the token server-side.
export default async function BusinessRedeemPage() {
  const business = await resolveOwnerBusiness();
  if (!business) {
    redirect("/business/onboarding");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">{business.name}</h1>
        <p className="text-body-s text-on-surface-variant">Scan a customer&apos;s reward QR</p>
      </div>
      <RedeemScanner />
    </div>
  );
}
