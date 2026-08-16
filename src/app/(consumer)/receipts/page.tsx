import { notFound } from "next/navigation";

import { ReceiptOutbox } from "@/components/pwa/receipt-outbox";
import { ReceiptHistoryList } from "@/features/receipts/components/receipt-history-list";
import { receiptStatusSchema } from "@/features/receipts/schemas";
import { listMyReceipts } from "@/features/receipts/server/repo";
import type { ReceiptStatus } from "@/features/receipts/types";
import { DEFAULT_PAGE_LIMIT } from "@/lib/api/cursor";
import { createClient } from "@/lib/supabase/server";

// /receipts - scan history (doc 33 route inventory: auth, MVP, "Scan history
// list ... status chips filter ... Empty: 'Scan your first receipt' CTA").
//
// WHY A DEDICATED SCREEN RATHER THAN A LIST INSIDE /wallet:
//
//   1. Doc 33's route inventory already reserves `/receipts` for exactly this
//      at MVP, and `/receipts/[id]` beside it at V1. Putting the history in
//      the wallet would leave that route empty and give the [V1] detail
//      screen nowhere to come back to.
//   2. The two surfaces answer different questions. The wallet answers "how
//      many points do I have and what moved them" - it is the LEDGER's view,
//      and doc 33 defines its rows as `points_transactions` entries. Receipt
//      history answers "what happened to the photos I took", which includes
//      every rejected and in-review submission that will never produce a
//      ledger row at all. Folding rejections into a points ledger would put
//      non-events in a list whose entire contract is that every row moved a
//      balance.
//   3. The filter chips need a URL. `?status=rejected` on /receipts is
//      shareable, refresh-safe and back-button-safe; the same filter inside
//      the wallet would either fight the wallet's own URL space or have to
//      become client state.
//
// The wallet still gets the live pending entry doc 36 asks for (see
// WalletReceiptActivity) plus a "See all" link here, so the consumer never
// has to know these are two screens.
//
// First page only. Cursor pagination exists on the API and the repository;
// "load more" on this screen is a client island that is not needed until a
// consumer has more than 25 receipts, and shipping an empty-benefit island
// would cost every consumer the JavaScript.

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parseStatus(raw: string | string[] | undefined): ReceiptStatus | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = receiptStatusSchema.safeParse(value);
  // An unknown ?status= is treated as no filter rather than an error: a
  // hand-edited or stale URL should show the consumer their receipts, not an
  // error page.
  return parsed.success ? parsed.data : null;
}

export default async function ReceiptsPage({ searchParams }: PageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const activeStatus = parseStatus((await searchParams).status);

  const { rows } = await listMyReceipts({
    userId: user.id,
    limit: DEFAULT_PAGE_LIMIT,
    cursor: null,
    status: activeStatus ?? undefined,
  });

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Receipts</h1>
      <p className="mt-1 text-body-m text-on-surface-variant">
        Every receipt you have scanned, and what happened to it.
      </p>

      {/*
        Doc 41 section 3's queue card, the other of the two screens it names.
        It sits ABOVE the history because a queued receipt is not in that list:
        the list comes from Postgres, and these rows have never been uploaded.
        Without the card they would be invisible on the one screen whose whole
        job is answering "what happened to the photos I took".
      */}
      <section className="mt-6">
        <ReceiptOutbox />
      </section>

      <section className="mt-6">
        <ReceiptHistoryList
          receipts={rows.slice(0, DEFAULT_PAGE_LIMIT)}
          activeStatus={activeStatus}
        />
      </section>
    </main>
  );
}
