import type { Metadata } from "next";

import { ReceiptCapture } from "@/features/receipts/components/receipt-capture";
import { parseBusinessIdParam, shouldShowOcrStubNote } from "@/features/receipts/scan-entry";

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

  // Read on the SERVER: OCR_SERVICE_URL is a server secret and must not be
  // inlined into the client bundle. Only the boolean crosses the boundary, and
  // it is false in production by construction (see shouldShowOcrStubNote).
  const showOcrStubNote = shouldShowOcrStubNote({
    nodeEnv: process.env.NODE_ENV,
    ocrServiceUrl: process.env.OCR_SERVICE_URL,
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
    </main>
  );
}
