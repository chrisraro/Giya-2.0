import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resolvePortalContext } from "@/features/businesses/server/portal-context";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const portalCtx = await resolvePortalContext();
  if (!portalCtx) notFound();

  const business = portalCtx.business;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-headline-s text-on-surface">Receipt Templates</h1>
          <p className="mt-1 text-body-s text-on-surface-variant">
            Author and validate custom OCR parsing configs for {business.name}.
          </p>
        </div>
        <button
          type="button"
          className="rounded-full bg-primary px-4 py-2 text-label-m text-on-primary font-medium hover:opacity-90 transition-opacity"
        >
          Upload Sample Receipt
        </button>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <Card variant="outlined" className="p-6 bg-surface">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-title-m font-bold text-on-surface">Active Template</h2>
            <Badge className="bg-primary-container text-on-primary-container">VALIDATED</Badge>
          </div>
          <p className="text-body-s text-on-surface-variant">
            Standard POS thermal receipt template v1.
          </p>

          <div className="mt-4 space-y-2 text-label-s text-on-surface-variant border-t border-outline-variant pt-3">
            <p>• Header Anchor: "GRAND CAFE"</p>
            <p>• Date Format: YYYY-MM-DD</p>
            <p>• Total Field Anchor: "TOTAL PHP"</p>
          </div>
        </Card>

        <Card variant="filled" className="p-6 bg-surface-container border border-outline-variant">
          <h2 className="text-title-m font-bold text-on-surface mb-2">OCR Field Anchors</h2>
          <p className="text-body-s text-on-surface-variant mb-4">
            Configure regex anchors to improve auto-approval confidence rates.
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-label-s font-medium text-on-surface mb-1">
                Merchant Match Pattern
              </label>
              <input
                type="text"
                readOnly
                defaultValue="^GRAND CAFE.*"
                className="w-full rounded-md3-xs border border-outline bg-surface px-3 py-1.5 text-body-s text-on-surface font-mono"
              />
            </div>
            <div>
              <label className="block text-label-s font-medium text-on-surface mb-1">
                Total Amount Regex
              </label>
              <input
                type="text"
                readOnly
                defaultValue="TOTAL\s+P?(\d+\.\d{2})"
                className="w-full rounded-md3-xs border border-outline bg-surface px-3 py-1.5 text-body-s text-on-surface font-mono"
              />
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
