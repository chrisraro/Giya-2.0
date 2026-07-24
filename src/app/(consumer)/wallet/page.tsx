import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { MOCK_BALANCES, MOCK_TRANSACTIONS } from "@/lib/mock/consumer"; // TODO(api): replace mock

const TRANSACTION_ICON: Record<"earn" | "redeem", string> = {
  earn: "add_circle",
  redeem: "redeem",
};

export default function WalletPage() {
  // TODO(api): replace mock — fetch balances and transaction history from the API
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Wallet</h1>

      <section className="mt-6 space-y-2">
        {MOCK_BALANCES.map((balance) => (
          <Card
            key={balance.businessId}
            variant="outlined"
            className="flex items-center justify-between gap-3 p-4"
          >
            <p className="min-w-0 flex-1 truncate text-title-m text-on-surface">
              {balance.businessName}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <p className="font-mono text-title-m text-on-surface">
                {balance.points.toLocaleString()} pts
              </p>
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                chevron_right
              </span>
            </div>
          </Card>
        ))}
      </section>

      <section className="mt-8">
        <h2 className="text-title-m text-on-surface">Activity</h2>
        {MOCK_TRANSACTIONS.length === 0 ? (
          <EmptyState
            icon="receipt_long"
            title="No activity yet"
            body="Your earns and redemptions will show up here."
            className="mt-3"
          />
        ) : (
          <div className="mt-3 space-y-1">
            {MOCK_TRANSACTIONS.map((txn) => (
              <div key={txn.id} className="flex items-center gap-3 rounded-md3-md px-2 py-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                  <span aria-hidden className="material-symbols-rounded text-[20px]">
                    {TRANSACTION_ICON[txn.kind]}
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-l text-on-surface">{txn.description}</p>
                  <p className="truncate text-body-s text-on-surface-variant">
                    {txn.businessName} · {txn.dateLabel}
                  </p>
                </div>
                {txn.kind === "earn" ? (
                  <span className="shrink-0 rounded-full bg-tertiary-container px-2.5 py-1 font-mono text-label-m text-on-tertiary-container">
                    +{txn.points} pts
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-label-m text-on-surface-variant">
                    {txn.points} pts
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
