import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { listMyLedger, getMyBalanceForBusiness } from "@/features/rewards/server/repo";
import { listActiveBusinesses } from "@/features/businesses/server/public-repo";

export const dynamic = "force-dynamic";

export default async function WalletBusinessPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;

  const [ledger, businesses] = await Promise.all([
    listMyLedger(businessId),
    listActiveBusinesses({ ids: [businessId], limit: 1 }),
  ]);

  const business = businesses[0];
  const currentBalance = ledger.length > 0 ? ledger[0]!.balanceAfter : 0;

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-24">
      <header className="mb-6">
        <Link
          href="/wallet"
          className="inline-flex items-center gap-1 text-label-s text-primary hover:underline mb-2"
        >
          <span aria-hidden className="material-symbols-rounded text-sm">
            arrow_back
          </span>
          Back to Wallet
        </Link>
        <h1 className="text-headline-s text-on-surface">
          {business ? business.name : "Shop Ledger"}
        </h1>
        <p className="mt-1 text-body-s text-on-surface-variant">Ledger History</p>
      </header>

      <Card variant="filled" className="mb-6 bg-primary-container p-5 text-on-primary-container">
        <p className="text-label-l font-medium">Points Balance</p>
        <p className="mt-1 font-mono text-headline-m">{currentBalance.toLocaleString()}</p>
      </Card>

      <section className="space-y-3">
        <h2 className="text-title-m text-on-surface">Transactions</h2>
        {ledger.length === 0 ? (
          <EmptyState
            icon="receipt_long"
            title="No transactions yet"
            body="Scan receipts at this business to start earning points."
            action={{ label: "Scan receipt", href: `/scan?business=${businessId}` }}
          />
        ) : (
          ledger.map((tx) => {
            const isEarn = tx.type === "earn";
            return (
              <div
                key={tx.id}
                className="flex items-center justify-between rounded-md3-md border border-outline-variant bg-surface p-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        isEarn
                          ? "bg-primary-container text-on-primary-container"
                          : "bg-error-container text-on-error-container"
                      }
                    >
                      {tx.type.toUpperCase()}
                    </Badge>
                    <span className="text-label-s text-on-surface-variant">
                      {new Date(tx.createdAt).toLocaleDateString("en-PH", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                  </div>
                  <p className="mt-1 text-body-s text-on-surface-variant">
                    Balance after: {tx.balanceAfter.toLocaleString()} pts
                  </p>
                </div>
                <p
                  className={`font-mono text-title-m font-bold ${
                    isEarn ? "text-primary" : "text-error"
                  }`}
                >
                  {isEarn ? `+${tx.points}` : `-${tx.points}`} pts
                </p>
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
