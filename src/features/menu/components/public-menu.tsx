import { EmptyState } from "@/components/consumer/empty-state";
import { formatPeso } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { PublicCategory, PublicProduct } from "@/features/businesses/server/public-repo";

export interface PublicMenuProps {
  categories: PublicCategory[];
}

/** True price-from label: the lowest of the base price and any variant
 * prices, prefixed with "From" only when variants actually exist (a
 * single-price product just shows its price plain). */
function priceLabel(product: PublicProduct): string {
  const prices = [product.basePriceCentavos, ...product.variants.map((v) => v.priceCentavos)];
  const lowest = Math.min(...prices);
  return product.variants.length > 0 ? `From ${formatPeso(lowest)}` : formatPeso(lowest);
}

function ProductCard({ product }: { product: PublicProduct }) {
  const soldOut = product.status === "sold_out";

  return (
    <li
      className={cn(
        "flex items-start justify-between gap-3 rounded-md3-md border border-outline-variant p-4",
        soldOut ? "bg-surface-container-low opacity-60" : "bg-surface",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-title-m text-on-surface">{product.name}</p>
          {soldOut ? (
            <span className="shrink-0 rounded-full bg-error-container px-2.5 py-0.5 text-label-m text-on-error-container">
              Sold out
            </span>
          ) : null}
        </div>
        {product.description ? (
          <p className="mt-1 text-body-s text-on-surface-variant">{product.description}</p>
        ) : null}
        {product.variants.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {product.variants.map((variant) => (
              <span
                key={variant.id}
                className="rounded-full border border-outline px-3 py-1 text-label-m text-on-surface-variant"
              >
                {variant.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <p className="shrink-0 text-title-s text-on-surface-variant">{priceLabel(product)}</p>
    </li>
  );
}

/** Renders a public business's live menu: categories in order, each with
 * its available products. Purely presentational - fed the already-shaped
 * tree from getPublicMenu(), no client-side fetching or interaction. */
export function PublicMenu({ categories }: PublicMenuProps) {
  const hasAnyProducts = categories.some((category) => category.products.length > 0);

  if (categories.length === 0 || !hasAnyProducts) {
    return (
      <EmptyState
        icon="restaurant_menu"
        title="No menu yet"
        body="This store has not added a menu yet."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {categories.map((category) =>
        category.products.length > 0 ? (
          <section key={category.id}>
            <h2 className="text-title-l text-on-surface">{category.name}</h2>
            {category.description ? (
              <p className="mt-1 text-body-s text-on-surface-variant">{category.description}</p>
            ) : null}
            <ul className="mt-3 flex flex-col gap-3">
              {category.products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
