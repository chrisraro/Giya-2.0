import Link from "next/link";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { getNextPointsExpiryByBusiness } from "@/features/points/server/expiry";
import type { NextExpiryDTO } from "@/features/points/server/expiry";
import {
  WalletReceiptActivity,
  WALLET_RECEIPT_LIMIT,
} from "@/features/receipts/components/wallet-receipt-activity";
import { listMyReceipts } from "@/features/receipts/server/repo";
import { getMyBalances, listMyLedger } from "@/features/rewards/server/repo";
import type { BalanceDTO } from "@/features/rewards/types";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

// RLS-scoped to the signed-in consumer; rendered per-request so a fresh
// earn/redeem - via a receipt scan or claimReward's revalidatePath("/wallet")
// - always shows up immediately.
export const dynamic = "force-dynamic";

const TRANSACTION_ICON: Record<string, string> = {
  earn: "add_circle",
  redeem: "redeem",
  adjust: "tune",
  expire: "schedule",
  clawback: "undo",
  reversal: "undo",
  referral_bonus: "diversity_3",
};

/**
 * One "you have N points at this shop" row.
 *
 * These rows have always ended in a `chevron_right`, the universal promise
 * that tapping goes somewhere, and they went nowhere: they were a plain
 * `<Card>`. Meanwhile `/b/[slug]`, the public business page, had no consumer
 * entry point at all. Those are the same bug from two directions, so the
 * chevron now keeps its promise and points at the shop's page - the one
 * screen that answers the question a balance raises, which is "what can I
 * actually get here?".
 *
 * A row whose slug did not resolve (getMyBalances answers "" when the
 * businesses read misses) renders as the non-interactive card it always was,
 * chevron included. A link to `/b/` is a link to nowhere, and a dead chevron
 * for one unlucky row is better than a 404 for it.
 */
/**
 * "500 pts expire Mar 3, 2027" - the soonest-expiring lot for this business,
 * per doc 35 section 7's FIFO formula (task 1.3). Computed by the SAME SQL
 * the sweep uses (`public.expire_points`, via `public.points_next_expiry`,
 * `src/features/points/server/expiry.ts`), so this number is the number the
 * sweep will eventually take - never a second, independently-computed
 * estimate. Absent when there is nothing left to expire for this pair
 * (rendered as no second line at all, matching the balance row's own
 * "nothing to show" posture elsewhere on this page).
 *
 * KNOWN WINDOW (review M4): `points_next_expiry` deliberately excludes a lot
 * once its `expires_at` has passed (that lot is `expire_points`' job, not the
 * wallet's own read - see 0043's comment on the predicate). Between the
 * instant a lot passes due and the next 02:10 Manila sweep, this line simply
 * omits it: the balance total above still includes those points (the sweep
 * has not run yet), but this caption stops naming them. Accepted rather than
 * narrowed: the alternative (showing an already-past date) reads as more
 * confusing than a caption that quietly moves on to the NEXT lot, and the
 * window is bounded to at most one day.
 */
function NextExpiryLine({ nextExpiry }: { nextExpiry: NextExpiryDTO | null }) {
  if (nextExpiry === null) return null;
  return (
    <p className="truncate text-body-s text-on-surface-variant">
      <span className="font-mono">{nextExpiry.points.toLocaleString()}</span> pts expire{" "}
      {formatExpiryDate(nextExpiry.expiresAt)}
    </p>
  );
}

function BalanceRow({
  balance,
  nextExpiry,
}: {
  balance: BalanceDTO;
  nextExpiry: NextExpiryDTO | null;
}) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-title-m text-on-surface">{balance.businessName}</p>
        <NextExpiryLine nextExpiry={nextExpiry} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <p className="font-mono text-title-m text-on-surface">
          {balance.pointsBalance.toLocaleString()} pts
        </p>
        <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
          chevron_right
        </span>
      </div>
    </>
  );

  if (!balance.businessSlug) {
    return (
      <Card variant="outlined" className="flex items-center justify-between gap-3 p-4">
        {body}
      </Card>
    );
  }

  return (
    <Link
      href={`/b/${balance.businessSlug}`}
      className={cn(
        "flex items-center justify-between gap-3 rounded-md3-md border border-outline-variant bg-surface p-4",
        "transition-colors duration-200 ease-standard hover:bg-surface-container",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary",
      )}
    >
      {body}
    </Link>
  );
}

function formatTxnDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Day-level, no time-of-day: an expiry date is a calendar day (doc 35's own
 * "12 months after the day you earn them"), not an instant. */
function formatExpiryDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export default async function WalletPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [balancesResult, ledger, receipts] = await Promise.all([
    // getMyBalances() throws on a genuine query error (not just "no rows") -
    // see its doc comment in repo.ts. Fail SOFT here rather than let that
    // take the whole page down or, worse, silently degrade to `[]`: post-fix
    // `[]` renders the SAME "No balances yet" empty state as a real failure
    // would, and telling a consumer with a real balance that they have none
    // is the single most alarming lie this app could tell - precisely the
    // trust failure doc 03's loyalty research flags as what makes users call
    // a program a scam. So the failure carries its own flag through to the
    // render instead of being flattened into the empty case.
    getMyBalances()
      .then((balances) => ({ ok: true as const, balances }))
      .catch((error: unknown) => {
        console.error("[wallet] failed to load balances, showing the failure state instead of an empty one", error);
        return { ok: false as const, balances: [] as BalanceDTO[] };
      }),
    listMyLedger(),
    // Doc 36's wallet UX contract: the pending "Processing receipt" entry.
    // Read from the database rather than mirrored from the submit response,
    // because by the time POST /api/v1/receipts has answered 202 the row
    // already exists at status='queued' and this page is force-dynamic. See
    // the note at the top of WalletReceiptActivity for why that is the better
    // source of truth than an optimistic local entry.
    user
      ? listMyReceipts({ userId: user.id, limit: WALLET_RECEIPT_LIMIT, cursor: null })
      : Promise.resolve({ rows: [] }),
  ]);
  const balances = balancesResult.balances;
  const balancesFailed = !balancesResult.ok;
  // LedgerEntryDTO only carries businessId; balances (from every business
  // the caller has a business_customers row with) is the cheapest source
  // for the display name without a second per-row lookup. Empty on a failed
  // read too - a missing display name degrades gracefully (see its render
  // site below), unlike fabricating a balance ever would.
  const businessNameById = new Map(balances.map((balance) => [balance.businessId, balance.businessName]));

  // Task 1.3: the soonest-expiring lot per business (doc 35 section 7),
  // fetched only once the business ids are known - see
  // src/features/points/server/expiry.ts for why this is a service-role RPC
  // rather than a plain table read.
  const expiryByBusiness = user
    ? await getNextPointsExpiryByBusiness(
        user.id,
        balances.map((balance) => balance.businessId),
      )
    : new Map<string, NextExpiryDTO>();

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Wallet</h1>

      <section className="mt-6 space-y-2">
        {balancesFailed ? (
          // Deliberately distinct from "No balances yet" below: that state
          // means the read succeeded and genuinely found nothing, this one
          // means the read never completed. Rendering the same screen for
          // both would tell a consumer with a real balance that it is gone.
          <EmptyState
            icon="error"
            title="We couldn't load your balances"
            body="Your points are safe - pull to refresh or try again in a moment."
          />
        ) : balances.length === 0 ? (
          <EmptyState
            icon="account_balance_wallet"
            title="No balances yet"
            body="Earn points at a business to see your balance here."
          />
        ) : (
          balances.map((balance) => (
            <BalanceRow
              key={balance.businessId}
              balance={balance}
              nextExpiry={expiryByBusiness.get(balance.businessId) ?? null}
            />
          ))
        )}

        {/* The expiry rule is stated where the balance is read, not only in the
            terms. Doing it the other way round is how a loyalty programme ends
            up accused of moving the goalposts: a rule nobody met until their
            points vanished reads as retroactive even when it was written down
            all along. Shown only when there is a balance, because there is
            nothing to qualify otherwise. */}
        {balances.length > 0 ? (
          <p className="pt-1 text-body-s text-on-surface-variant">
            Points expire 12 months after you earn them, counted separately for each time you earn.
          </p>
        ) : null}
      </section>

      {user ? (
        <WalletReceiptActivity
          userId={user.id}
          initialReceipts={receipts.rows.slice(0, WALLET_RECEIPT_LIMIT)}
        />
      ) : null}

      <section className="mt-8">
        <h2 className="text-title-m text-on-surface">Activity</h2>
        {ledger.length === 0 ? (
          <EmptyState
            icon="receipt_long"
            title="No activity yet"
            body="Your earns and redemptions will show up here."
            className="mt-3"
          />
        ) : (
          <div className="mt-3 space-y-1">
            {ledger.map((txn) => {
              const isEarn = txn.type === "earn";
              return (
                <div key={txn.id} className="flex items-center gap-3 rounded-md3-md px-2 py-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                    <span aria-hidden className="material-symbols-rounded text-[20px]">
                      {TRANSACTION_ICON[txn.type] ?? "swap_horiz"}
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-l text-on-surface capitalize">{txn.type}</p>
                    <p className="truncate text-body-s text-on-surface-variant">
                      {businessNameById.get(txn.businessId) ?? ""} · {formatTxnDate(txn.createdAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 font-mono text-label-m",
                      isEarn
                        ? "bg-tertiary-container text-on-tertiary-container"
                        : "text-on-surface-variant",
                    )}
                  >
                    {txn.points > 0 ? "+" : ""}
                    {txn.points} pts
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
