import type { Metadata } from "next";

import { listActiveBusinesses } from "@/features/businesses/server/public-repo";
import { ReceiptCapture } from "@/features/receipts/components/receipt-capture";
import { ScanBusinessChooser } from "@/features/receipts/components/scan-business-chooser";
import { ScanPreview } from "@/features/receipts/components/scan-preview";
import {
  parseBusinessIdParam,
  parseStoreQueryParam,
  shouldShowOcrStubNote,
} from "@/features/receipts/scan-entry";
import { loadScanPreviewRule } from "@/features/receipts/server/preview-rule";
import { loadScanTargets } from "@/features/receipts/server/scan-targets";

export const metadata: Metadata = {
  title: "Scan a receipt | Giya",
};

// Reads searchParams, so this renders per request. Nothing here is cacheable
// anyway: the pre-bound business comes from the link the consumer followed.
export const dynamic = "force-dynamic";

type ScanSearchParams = Record<string, string | string[] | undefined>;

export default async function ScanPage({
  searchParams,
}: {
  searchParams: Promise<ScanSearchParams>;
}) {
  const params = await searchParams;
  const businessId = parseBusinessIdParam(params.business ?? params.business_id);

  // NO BUSINESS, NO CAMERA. Generic scan is `[V1]` in doc 33's route table and
  // the pipeline never implemented it: buildMatchCandidates only ever offers
  // the pre-bound business, so an unbound receipt scores against nothing and is
  // rejected `wrong_business`, and receipts_sha_unique (total, includes
  // rejected rows) then blocks re-submitting the same photo from the right
  // store page. Rendering the capture flow here would hand the consumer a
  // guaranteed rejection and burn their receipt. The chooser is the fix: pick
  // the shop, land on /scan?business={id}, which is the flow that works.
  //
  // parseBusinessIdParam drops anything that is not a UUID, so a hand-typed
  // `?business=coffee` arrives here as undefined and lands on the chooser too.
  if (businessId === undefined) {
    const query = parseStoreQueryParam(params.q);
    const targets = await loadScanTargets({ query });

    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 pt-6 pb-8">
        <div>
          <h1 className="text-headline-m text-on-surface">Which shop is this from?</h1>
        </div>

        <ScanBusinessChooser
          recent={targets.recent}
          businesses={targets.businesses}
          query={query}
          truncated={targets.truncated}
        />
      </main>
    );
  }

  // Read on the SERVER: OCR_SERVICE_URL is a server secret and must not be
  // inlined into the client bundle. Only the boolean crosses the boundary, and
  // it is false in production by construction (see shouldShowOcrStubNote).
  const showOcrStubNote = shouldShowOcrStubNote({
    nodeEnv: process.env.NODE_ENV,
    ocrServiceUrl: process.env.OCR_SERVICE_URL,
  });

  // THE ESTIMATE IS OPTIONAL; THE CAMERA IS NOT.
  //
  // Both reads exist only to feed the "~N pts at <shop>" preview, and both
  // degrade to "no preview" rather than take down the capture flow, which is
  // the money path this page exists for. The rule read throws on a query error
  // (house convention) and is caught here, deliberately, for that reason.
  //
  // ---------------------------------------------------------------------------
  // AUTHORIZATION FIRST, PRIVILEGED READ SECOND. THESE ARE SEQUENTIAL ON PURPOSE.
  // ---------------------------------------------------------------------------
  // `listActiveBusinesses` is the consumer's own RLS-scoped read and is the only
  // thing on this page that answers "may this person see this shop at all".
  // `loadScanPreviewRule` runs under service_role and is fenced by nothing: it
  // returns the base rule of a suspended, deactivated or soft-deleted business
  // just as readily as a live one.
  //
  // Running them in one Promise.all and discarding the rule at render time was
  // the obvious shape and the wrong one. Nothing leaked, but only because the
  // JSX happened to check for a business it could name - which makes "we never
  // read a rule for a business the consumer cannot see" true by render-time
  // accident rather than by construction, and one refactor from being false.
  // The privileged call is now unreachable unless the unprivileged one has
  // already said yes.
  //
  // Cost: one extra round trip, on the estimate path only, on a page that is
  // already force-dynamic and whose capture flow waits on neither read.
  const boundBusiness = (await listActiveBusinesses({ ids: [businessId], limit: 1 }))[0] ?? null;

  // One value rather than a business and a rule checked separately at render:
  // after the sequencing above, "no business" and "no rule" are not independent
  // states, and a second render-time guard for the first of them would be a
  // guard whose removal changes nothing.
  const estimate =
    boundBusiness === null
      ? null
      : await loadScanPreviewRule(businessId)
          .then((rule) => (rule === null ? null : { businessName: boundBusiness.name, rule }))
          .catch((error: unknown) => {
            console.error(
              "[scan] preview rule read failed; rendering /scan without the estimate",
              error,
            );
            return null;
          });

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 pt-6 pb-8">
      <div>
        <h1 className="text-headline-m text-on-surface">Scan a receipt</h1>
        <p className="mt-1 text-body-m text-on-surface-variant">
          Take a photo of your receipt to earn points.
        </p>
      </div>

      <ReceiptCapture businessId={businessId} showOcrStubNote={showOcrStubNote} />

      {/* Rendered ONLY with both a shop to name and that shop's own rule to
          compute under. ScanPreview falls back to 1 point per peso when given
          no rule, and a shop earning 1 point per ₱50 would then be quoted
          double what its receipts actually pay. Nothing beats a wrong number
          here, so the guard is on the page rather than inside the component. */}
      {estimate === null ? null : (
        <ScanPreview businessName={estimate.businessName} rule={estimate.rule} />
      )}
    </main>
  );
}
