import Link from "next/link";
import { BusinessCard } from "@/components/consumer/business-card";
import { EmptyState } from "@/components/consumer/empty-state";
import { Card } from "@/components/ui/card";
import {
  listActiveBusinesses,
  listRefBusinessTypes,
  listRefCities,
} from "@/features/businesses/server/public-repo";
import { DiscoverMap } from "@/features/discovery/components/discover-map";

export const dynamic = "force-dynamic";

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; cityId?: string; typeId?: string }>;
}) {
  const { query = "", cityId = "", typeId = "" } = await searchParams;

  const [businesses, cities, types] = await Promise.all([
    listActiveBusinesses({
      query: query.trim() || undefined,
      cityId: cityId || undefined,
      businessTypeId: typeId || undefined,
      limit: 50,
    }),
    listRefCities(),
    listRefBusinessTypes(),
  ]);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-24">
      <header className="mb-6">
        <h1 className="text-headline-s text-on-surface">Discover Shops</h1>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Find local businesses, check reward menus, and start scanning receipts.
        </p>
      </header>

      {/* Search & Filter Form */}
      <form method="GET" action="/discover" className="space-y-3">
        <div className="relative">
          <span
            aria-hidden
            className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
          >
            search
          </span>
          <input
            type="text"
            name="query"
            defaultValue={query}
            placeholder="Search shops by name..."
            className="w-full rounded-md3-md border border-outline bg-surface py-2.5 pl-10 pr-4 text-body-m text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none"
          />
        </div>

        <div className="flex gap-2">
          <select
            name="cityId"
            defaultValue={cityId}
            className="w-1/2 rounded-md3-md border border-outline bg-surface px-3 py-2 text-body-s text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="">All Cities</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>

          <select
            name="typeId"
            defaultValue={typeId}
            className="w-1/2 rounded-md3-md border border-outline bg-surface px-3 py-2 text-body-s text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="">All Categories</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2">
          {query || cityId || typeId ? (
            <Link
              href="/discover"
              className="px-3 py-1.5 text-label-s text-on-surface-variant hover:underline"
            >
              Clear filters
            </Link>
          ) : null}
          <button
            type="submit"
            className="rounded-md3-xs bg-primary px-4 py-1.5 text-label-s text-on-primary"
          >
            Filter
          </button>
        </div>
      </form>

      {/*
        The map of these results, or nothing at all.

        It renders itself away in the two cases that matter and does so before
        emitting any frame or heading, so there is no wrapper here to leave an
        orphan behind: no MapTiler key configured (the current state of this
        branch), and no result carrying coordinates.

        Businesses without coordinates are NOT removed from `businesses`. They
        are absent from the picture and present in the list below.
      */}
      <DiscoverMap businesses={businesses} className="mt-6" />

      {/* Results Section */}
      <section className="mt-6 space-y-3">
        {businesses.length === 0 ? (
          <EmptyState
            icon="storefront"
            title="No matching shops found"
            body="Try adjusting your search keywords or city filter to discover live shops on Giya."
            className="mt-4"
          />
        ) : (
          businesses.map((business) => (
            <BusinessCard key={business.id} business={business} />
          ))
        )}
      </section>
    </main>
  );
}
