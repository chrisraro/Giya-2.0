"use client";

import * as React from "react";
import Link from "next/link";

import {
  addAddon,
  addVariant,
  archiveCategory,
  archiveProduct,
  createCategory,
  createProduct,
  removeAddon,
  removeVariant,
  renameCategory,
  reorderCategory,
  toggleProductAvailability,
  updateProduct,
} from "../actions";
import { CategoryList } from "./category-list";
import { ProductList } from "./product-list";
import { ProductForm, type ProductFormOutput } from "./product-form";
import type { MenuCategoryRow, ProductAddonRow, ProductRow, ProductVariantRow } from "../types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface MenuManagerBusiness {
  id: string;
  slug: string;
  name: string;
}

export interface MenuManagerProps {
  business: MenuManagerBusiness;
  categories: MenuCategoryRow[];
  products: ProductRow[];
  variantsByProduct: Record<string, ProductVariantRow[]>;
  addonsByProduct: Record<string, ProductAddonRow[]>;
}

type DialogState = { mode: "create" } | { mode: "edit"; product: ProductRow } | null;

/**
 * Diffs a submitted variant/addon row list against what was originally
 * loaded for a product and applies the minimal set of add/remove calls.
 * There is no update-in-place action for variants or add-ons (see Task 3's
 * actions.ts), so a changed existing row becomes a remove-then-add pair;
 * an unchanged row is left alone entirely.
 */
async function applyRowDiff<TOriginal extends { id: string }, TSubmitted extends { id?: string }>(
  original: TOriginal[],
  submitted: TSubmitted[],
  isUnchanged: (original: TOriginal, submitted: TSubmitted) => boolean,
  remove: (id: string) => Promise<ActionResult>,
  add: (row: TSubmitted) => Promise<ActionResult>,
): Promise<string | null> {
  const submittedIds = new Set(submitted.filter((row) => row.id).map((row) => row.id as string));

  for (const originalRow of original) {
    if (!submittedIds.has(originalRow.id)) {
      const result = await remove(originalRow.id);
      if (!result.ok) return result.message;
    }
  }

  for (const row of submitted) {
    if (row.id) {
      const originalRow = original.find((candidate) => candidate.id === row.id);
      if (originalRow && !isUnchanged(originalRow, row)) {
        const removeResult = await remove(row.id);
        if (!removeResult.ok) return removeResult.message;
        const addResult = await add(row);
        if (!addResult.ok) return addResult.message;
      }
    } else {
      const addResult = await add(row);
      if (!addResult.ok) return addResult.message;
    }
  }

  return null;
}

export function MenuManager({
  business,
  categories,
  products,
  variantsByProduct,
  addonsByProduct,
}: MenuManagerProps) {
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<string | "all">("all");
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const [formSubmitting, setFormSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // Derived rather than mirrored into an effect: if the previously-selected
  // category disappears from props (e.g. another tab archived it, or this
  // tab's own archive call just revalidated it away), fall back to "all"
  // on the very next render instead of committing a stale selection.
  const effectiveCategoryId: string | "all" =
    selectedCategoryId !== "all" && !categories.some((category) => category.id === selectedCategoryId)
      ? "all"
      : selectedCategoryId;

  const filteredProducts = React.useMemo(
    () =>
      effectiveCategoryId === "all"
        ? products
        : products.filter((product) => product.category_id === effectiveCategoryId),
    [products, effectiveCategoryId],
  );

  const listTitle =
    effectiveCategoryId === "all"
      ? "All items"
      : (categories.find((category) => category.id === effectiveCategoryId)?.name ?? "Category");

  React.useEffect(() => {
    if (!dialog) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialog]);

  async function handleAddCategory(name: string): Promise<ActionResult> {
    const nextSort = categories.length > 0 ? Math.max(...categories.map((c) => c.sort)) + 1 : 0;
    const result = await createCategory({ name, sort: nextSort });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handleRenameCategory(categoryId: string, name: string): Promise<ActionResult> {
    const result = await renameCategory({ categoryId, name });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handleReorderCategory(categoryId: string, direction: "up" | "down"): Promise<ActionResult> {
    const index = categories.findIndex((category) => category.id === categoryId);
    if (index === -1) return { ok: false, message: "Category not found." };

    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= categories.length) return { ok: true };

    const current = categories[index];
    const neighbor = categories[swapIndex];
    if (!current || !neighbor) return { ok: false, message: "Category not found." };

    const first = await reorderCategory({ categoryId: current.id, sort: neighbor.sort });
    if (!first.ok) return { ok: false, message: first.message };
    const second = await reorderCategory({ categoryId: neighbor.id, sort: current.sort });
    if (!second.ok) return { ok: false, message: second.message };
    return { ok: true };
  }

  async function handleArchiveCategory(categoryId: string): Promise<ActionResult> {
    const result = await archiveCategory({ categoryId });
    if (!result.ok) return { ok: false, message: result.message };
    if (selectedCategoryId === categoryId) setSelectedCategoryId("all");
    return { ok: true };
  }

  async function handleToggleAvailability(product: ProductRow): Promise<ActionResult> {
    const result = await toggleProductAvailability({
      productId: product.id,
      isAvailable: !product.is_available,
    });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  async function handleArchiveProduct(product: ProductRow): Promise<ActionResult> {
    const result = await archiveProduct({ productId: product.id });
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  }

  function openCreateDialog() {
    setFormError(null);
    setDialog({ mode: "create" });
  }

  function openEditDialog(product: ProductRow) {
    setFormError(null);
    setDialog({ mode: "edit", product });
  }

  function closeDialog() {
    setDialog(null);
    setFormError(null);
  }

  async function handleSubmitProduct(values: ProductFormOutput) {
    if (!dialog) return;
    setFormSubmitting(true);
    setFormError(null);

    const basePayload = {
      name: values.name,
      ...(values.description ? { description: values.description } : {}),
      basePriceCentavos: values.basePriceCentavos,
      categoryId: values.categoryId,
      status: values.status,
      images: values.images,
    };

    if (dialog.mode === "create") {
      const result = await createProduct({ ...basePayload, isAvailable: true });
      if (!result.ok) {
        setFormSubmitting(false);
        setFormError(result.message);
        return;
      }
      const productId = result.data?.id;
      if (productId) {
        for (const variant of values.variants) {
          const added = await addVariant({
            productId,
            name: variant.name,
            priceCentavos: variant.priceCentavos,
          });
          if (!added.ok) {
            setFormSubmitting(false);
            setFormError(added.message);
            return;
          }
        }
        for (const addon of values.addons) {
          const added = await addAddon({
            productId,
            name: addon.name,
            priceDeltaCentavos: addon.priceDeltaCentavos,
          });
          if (!added.ok) {
            setFormSubmitting(false);
            setFormError(added.message);
            return;
          }
        }
      }
      setFormSubmitting(false);
      closeDialog();
      return;
    }

    const productId = dialog.product.id;
    const result = await updateProduct({ productId, ...basePayload });
    if (!result.ok) {
      setFormSubmitting(false);
      setFormError(result.message);
      return;
    }

    const originalVariants = variantsByProduct[productId] ?? [];
    const variantError = await applyRowDiff(
      originalVariants,
      values.variants,
      (original, submitted) => original.name === submitted.name && original.price_centavos === submitted.priceCentavos,
      (variantId) => removeVariant({ variantId }),
      (row) => addVariant({ productId, name: row.name, priceCentavos: row.priceCentavos }),
    );
    if (variantError) {
      setFormSubmitting(false);
      setFormError(variantError);
      return;
    }

    const originalAddons = addonsByProduct[productId] ?? [];
    const addonError = await applyRowDiff(
      originalAddons,
      values.addons,
      (original, submitted) =>
        original.name === submitted.name && original.price_delta_centavos === submitted.priceDeltaCentavos,
      (addonId) => removeAddon({ addonId }),
      (row) => addAddon({ productId, name: row.name, priceDeltaCentavos: row.priceDeltaCentavos }),
    );
    if (addonError) {
      setFormSubmitting(false);
      setFormError(addonError);
      return;
    }

    setFormSubmitting(false);
    closeDialog();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-headline-s text-on-surface">{business.name}</h1>
          <p className="text-body-s text-on-surface-variant">Menu management</p>
        </div>
        {business.slug ? (
          <Link
            href={`/b/${business.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center rounded-full border border-outline px-4 text-label-l text-secondary outline-none transition-colors duration-200 ease-standard hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-secondary"
          >
            View public page
          </Link>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        <CategoryList
          categories={categories}
          selectedCategoryId={effectiveCategoryId}
          onSelect={setSelectedCategoryId}
          onAdd={handleAddCategory}
          onRename={handleRenameCategory}
          onReorder={handleReorderCategory}
          onArchive={handleArchiveCategory}
        />

        <ProductList
          title={listTitle}
          products={filteredProducts}
          onAddProduct={openCreateDialog}
          onEditProduct={openEditDialog}
          onToggleAvailability={handleToggleAvailability}
          onArchiveProduct={handleArchiveProduct}
        />
      </div>

      {dialog ? (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
          onClick={closeDialog}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-dialog-title"
            className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-md3-xl bg-surface p-6 shadow-md"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 id="product-dialog-title" className="text-headline-s text-on-surface">
                {dialog.mode === "create" ? "Add product" : "Edit product"}
              </h2>
              <button
                type="button"
                aria-label="Close"
                onClick={closeDialog}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-secondary"
              >
                <span aria-hidden className="material-symbols-rounded text-[18px]">
                  close
                </span>
              </button>
            </div>

            <ProductForm
              categories={categories.map((category) => ({ id: category.id, name: category.name }))}
              {...(dialog.mode === "edit"
                ? {
                    product: dialog.product,
                    variants: variantsByProduct[dialog.product.id] ?? [],
                    addons: addonsByProduct[dialog.product.id] ?? [],
                  }
                : {})}
              onSubmit={handleSubmitProduct}
              onCancel={closeDialog}
              submitting={formSubmitting}
              serverError={formError}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
