import { BusinessCard } from "@/components/consumer/business-card";
import { EmptyState } from "@/components/consumer/empty-state";
import { listMyFavorites } from "@/features/favorites/server/repo";

export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
  const favorites = await listMyFavorites();

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-24">
      <header className="mb-6">
        <h1 className="text-headline-s text-on-surface">Your Favorites</h1>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Quickly access your bookmarked shops and check their latest offers.
        </p>
      </header>

      {favorites.length === 0 ? (
        <EmptyState
          icon="favorite"
          title="No favorites saved yet"
          body="Tap the heart icon on any business page to add it to your favorites."
          action={{ label: "Discover shops", href: "/discover" }}
          className="mt-6"
        />
      ) : (
        <div className="space-y-3">
          {favorites.map((fav) => (
            <BusinessCard
              key={fav.id}
              business={{
                id: fav.businessId,
                slug: fav.slug,
                name: fav.name,
                logoUrl: fav.logoUrl,
                cityName: fav.cityName,
                businessTypeName: fav.businessTypeName,
              }}
            />
          ))}
        </div>
      )}
    </main>
  );
}
