import { redirect } from "next/navigation";

import { EmptyState } from "@/components/consumer/empty-state";
import { MenuManager } from "@/features/menu/components/menu-manager";
import * as repo from "@/features/menu/server/repo";
import type { ProductAddonRow, ProductVariantRow } from "@/features/menu/types";

// Server entry point for the business portal's menu management screen.
// Resolves the caller's business the same way every menu server action
// does (repo.resolveOwnerBusiness - never a client-supplied id), loads
// categories/products plus each product's variants and add-ons, and hands
// the whole tree to <MenuManager> (client) as initial data. Mutations flow
// back through the menu server actions, which call revalidatePath on this
// route, so MenuManager reads categories/products straight from props
// rather than mirroring them into local state.
export default async function BusinessMenuPage() {
  const business = await repo.resolveOwnerBusiness();
  if (!business) {
    redirect("/business/onboarding");
  }

  const [categoriesResult, productsResult] = await Promise.all([
    repo.listCategories(business.id),
    repo.listProducts(business.id),
  ]);

  // A query error (e.g. a transient DB/network failure) is not the same as
  // a business that genuinely has no categories/products yet - surface a
  // distinct "try again" state instead of silently rendering MenuManager
  // with empty lists, which would look identical to a real empty menu.
  if (categoriesResult.error || productsResult.error) {
    return (
      <EmptyState
        icon="error"
        title="Could not load your menu"
        body="Refresh to try again."
      />
    );
  }

  const categories = categoriesResult.data ?? [];
  const products = productsResult.data ?? [];

  const variantsByProduct: Record<string, ProductVariantRow[]> = {};
  const addonsByProduct: Record<string, ProductAddonRow[]> = {};

  await Promise.all(
    products.map(async (product) => {
      const [variantsResult, addonsResult] = await Promise.all([
        repo.listVariants(product.id),
        repo.listAddons(product.id),
      ]);
      variantsByProduct[product.id] = variantsResult.data ?? [];
      addonsByProduct[product.id] = addonsResult.data ?? [];
    }),
  );

  return (
    <MenuManager
      business={{ id: business.id, slug: business.slug, name: business.name }}
      categories={categories}
      products={products}
      variantsByProduct={variantsByProduct}
      addonsByProduct={addonsByProduct}
    />
  );
}
