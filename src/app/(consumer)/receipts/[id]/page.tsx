import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getMyConsumerProfile } from "@/features/identity/server/repo";
import { getMyReceipt } from "@/features/receipts/server/repo";

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await getMyConsumerProfile();

  if (!profile) {
    redirect(`/login?next=${encodeURIComponent(`/receipts/${id}`)}`);
  }

  const receipt = await getMyReceipt(id, profile.userId);
  if (!receipt) notFound();

  const isApproved = receipt.status === "approved";
  const isRejected = receipt.status === "rejected";

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-24">
      <header className="mb-6">
        <Link
          href="/receipts"
          className="inline-flex items-center gap-1 text-label-s text-primary hover:underline mb-2"
        >
          <span aria-hidden className="material-symbols-rounded text-sm">
            arrow_back
          </span>
          Back to Receipts
        </Link>
        <div className="flex items-center justify-between">
          <h1 className="text-headline-s text-on-surface">Receipt Details</h1>
          <Badge
            className={
              isApproved
                ? "bg-primary-container text-on-primary-container"
                : isRejected
                ? "bg-error-container text-on-error-container"
                : "bg-surface-variant text-on-surface-variant"
            }
          >
            {receipt.status.toUpperCase()}
          </Badge>
        </div>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Submitted {new Date(receipt.createdAt).toLocaleString("en-PH")}
        </p>
      </header>

      <Card variant="filled" className="mb-6 bg-surface-container p-5 text-on-surface">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-title-m font-bold">
              {receipt.businessName || receipt.merchantName || "Shop Receipt"}
            </h2>
            {receipt.receiptNumber ? (
              <p className="text-label-s text-on-surface-variant">
                Receipt #{receipt.receiptNumber}
              </p>
            ) : null}
          </div>
          {receipt.pointsAwarded !== null ? (
            <div className="text-right">
              <p className="text-label-s text-on-surface-variant">Points Earned</p>
              <p className="font-mono text-title-l font-bold text-primary">
                +{receipt.pointsAwarded} pts
              </p>
            </div>
          ) : null}
        </div>

        {receipt.totalCentavos !== null ? (
          <div className="mt-4 border-t border-outline-variant pt-3 flex justify-between items-center">
            <span className="text-label-m text-on-surface-variant">Total Amount</span>
            <span className="font-mono text-title-m font-bold text-on-surface">
              ₱{(receipt.totalCentavos / 100).toFixed(2)}
            </span>
          </div>
        ) : null}
      </Card>

      {isRejected && receipt.rejectReason ? (
        <Card variant="outlined" className="mb-6 border-error bg-error-container/20 p-4">
          <p className="text-title-s font-semibold text-error">Rejection Note</p>
          <p className="mt-1 text-body-s text-on-surface-variant">
            Reason: {receipt.rejectReason.replace("_", " ")}
          </p>
        </Card>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-title-m text-on-surface">Line Items</h2>
        {receipt.lineItems.length === 0 ? (
          <p className="text-body-s text-on-surface-variant">No parsed line items.</p>
        ) : (
          <div className="space-y-2">
            {receipt.lineItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-md3-md border border-outline-variant bg-surface p-3"
              >
                <div>
                  <p className="text-body-m font-medium text-on-surface">{item.rawText}</p>
                  <p className="text-label-s text-on-surface-variant">
                    Qty: {item.qty} × ₱{((item.unitPriceCentavos ?? 0) / 100).toFixed(2)}
                  </p>
                </div>
                <p className="font-mono text-body-m font-semibold text-on-surface">
                  ₱{((item.lineTotalCentavos ?? 0) / 100).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
