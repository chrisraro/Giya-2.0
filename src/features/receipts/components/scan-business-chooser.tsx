import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";
import type { BusinessSummary } from "@/features/businesses/server/public-repo";
import { cn } from "@/lib/utils";

import { SCAN_CHOOSER_LIMIT, SCAN_SEARCH_THRESHOLD } from "../scan-entry";

// The `/scan` store chooser: what a consumer sees when they open the scanner
// from the bottom nav instead of from a business page.
//
// This screen is a correctness fence, not a convenience. Generic (unbound)
// scanning is `[V1]` in doc 33's route table and the pipeline has no candidate
// scoring for it, so a receipt submitted with no business_id is rejected
// `wrong_business` every time and, because receipts_sha_unique counts rejected
// rows, cannot then be re-submitted from the right store page. Offering the
// camera here would be offering a guaranteed loss. So the camera is not
// offered: the consumer picks a shop and lands on `/scan?business={id}`, which
// is the flow that works.
//
// A plain server component with no client JavaScript, matching the receipt
// history list: the search box is a GET form and every row is a link, so the
// state survives refresh, back and sharing, and doc 33's "RSC-first, islands
// only" budget is untouched.

export interface ScanBusinessChooserProps {
  /** Shops the consumer has visited before, most recent first. */
  recent: readonly BusinessSummary[];
  /** Every other active shop, alphabetically. */
  businesses: readonly BusinessSummary[];
  /** The active `?q=` search, already sanitised. Undefined means no search. */
  query?: string | undefined;
  /** More shops exist than are listed, so search is the only way to reach them. */
  truncated?: boolean | undefined;
}

export function ScanBusinessChooser({
  recent,
  businesses,
  query,
  truncated = false,
}: ScanBusinessChooserProps) {
  const listed = recent.length + businesses.length;
  const searching = query !== undefined;
  const showSearch = searching || truncated || listed > SCAN_SEARCH_THRESHOLD;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-body-m text-on-surface-variant">
        Pick the shop where you paid. Giya checks your photo against that shop&apos;s receipts, so
        choosing first is what lets the points land. Scanning without picking a shop is not
        available yet.
      </p>

      {showSearch ? <StoreSearchForm query={query} /> : null}

      {listed === 0 ? (
        searching ? (
          <EmptyState
            icon="search_off"
            title="No shops matched"
            body={`Nothing on Giya matches "${query}". Check the spelling, or browse the full list.`}
            action={{ label: "Show all shops", href: "/scan" }}
          />
        ) : (
          <EmptyState
            icon="storefront"
            title="No shops yet"
            body="No shops are live on Giya right now. As soon as one joins, you will be able to scan their receipts from here."
          />
        )
      ) : (
        <>
          {recent.length > 0 ? (
            <StoreSection title="Recently visited" businesses={recent} />
          ) : null}
          {businesses.length > 0 ? (
            <StoreSection
              title={recent.length > 0 ? "All shops" : searching ? "Results" : "Shops on Giya"}
              businesses={businesses}
            />
          ) : null}
          {truncated ? (
            <p className="text-body-s text-on-surface-variant">
              Only the first {SCAN_CHOOSER_LIMIT} shops are listed. Search above to find yours.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function StoreSearchForm({ query }: { query: string | undefined }) {
  return (
    // A GET form, so the result is a shareable, refreshable URL and the page
    // needs no client JavaScript to filter.
    <form action="/scan" method="get" role="search" className="flex items-end gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <label htmlFor="scan-store-search" className="text-label-l text-on-surface">
          Find a shop
        </label>
        <input
          id="scan-store-search"
          name="q"
          type="search"
          inputMode="search"
          autoComplete="off"
          defaultValue={query ?? ""}
          placeholder="Shop name"
          className={cn(
            "h-12 w-full rounded-md3-xs border border-outline bg-surface px-4",
            "text-body-l text-on-surface placeholder:text-on-surface-variant",
            "outline-none transition-colors duration-200 ease-standard",
            "focus:border-primary focus:ring-1 focus:ring-primary",
          )}
        />
      </div>
      <button
        type="submit"
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-md3-xs",
          "bg-secondary-container text-on-secondary-container",
          "transition-colors duration-200 ease-standard hover:opacity-90",
          "outline-none focus-visible:ring-2 focus-visible:ring-primary",
        )}
      >
        <span aria-hidden className="material-symbols-rounded">
          search
        </span>
        <span className="sr-only">Search shops</span>
      </button>
    </form>
  );
}

function StoreSection({
  title,
  businesses,
}: {
  title: string;
  businesses: readonly BusinessSummary[];
}) {
  return (
    <section>
      <h2 className="text-title-m text-on-surface">{title}</h2>
      <ul className="mt-3 space-y-2">
        {businesses.map((business) => (
          <li key={business.id}>
            <StoreRow business={business} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StoreRow({ business }: { business: BusinessSummary }) {
  const caption = [business.businessTypeName, business.cityName].filter(Boolean).join(" · ");

  return (
    <Link
      href={`/scan?business=${business.id}`}
      className={cn(
        "flex items-center gap-3 rounded-md3-md border border-outline-variant bg-surface p-3",
        "transition-colors duration-200 ease-standard hover:bg-surface-container",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary",
      )}
    >
      <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-container text-title-m text-on-primary-container">
        {business.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external merchant-hosted image, next/image domain allowlisting not set up for this slice
          <img src={business.logoUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          business.name.charAt(0).toUpperCase()
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-title-m text-on-surface">{business.name}</span>
        {caption ? (
          <span className="mt-0.5 block truncate text-body-s text-on-surface-variant">
            {caption}
          </span>
        ) : null}
      </span>

      <span aria-hidden className="material-symbols-rounded shrink-0 text-on-surface-variant">
        chevron_right
      </span>
    </Link>
  );
}
