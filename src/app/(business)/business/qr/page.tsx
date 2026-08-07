import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resolvePortalContext } from "@/features/businesses/server/portal-context";

export const dynamic = "force-dynamic";

export default async function QrHubPage() {
  const portalCtx = await resolvePortalContext();
  if (!portalCtx) notFound();

  const business = portalCtx.business;
  const resolverUrl = `https://giya.app/q/${business.slug}`;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-headline-s text-on-surface">QR Code Hub</h1>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Generate, download, and print official QR codes for {business.name}.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <Card variant="outlined" className="p-6 bg-surface">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-title-m font-bold text-on-surface">Storefront QR Code</h2>
            <Badge className="bg-primary-container text-on-primary-container">ACTIVE</Badge>
          </div>
          <p className="text-body-s text-on-surface-variant mb-4">
            Print this poster QR code to place on your counter or table tops.
          </p>

          <div className="rounded-md3-md border border-outline-variant p-4 bg-surface-container/50 text-center font-mono text-label-s text-on-surface mb-4">
            {resolverUrl}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-full bg-primary py-2 text-label-m text-on-primary font-medium hover:opacity-90"
            >
              Download PNG
            </button>
            <button
              type="button"
              className="flex-1 rounded-full border border-outline px-4 py-2 text-label-m text-on-surface font-medium hover:bg-surface-container"
            >
              Print Poster
            </button>
          </div>
        </Card>

        <Card variant="filled" className="p-6 bg-surface-container border border-outline-variant">
          <h2 className="text-title-m font-bold text-on-surface mb-2">Campaign QR Codes</h2>
          <p className="text-body-s text-on-surface-variant mb-4">
            Generate specific QR codes for individual promo campaigns or seasonal events.
          </p>

          <button
            type="button"
            className="rounded-full bg-surface-variant px-4 py-2 text-label-m text-on-surface-variant font-medium hover:bg-surface-container-high"
          >
            Create Campaign QR
          </button>
        </Card>
      </div>
    </main>
  );
}
