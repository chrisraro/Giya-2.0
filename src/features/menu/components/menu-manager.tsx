"use client";

import * as React from "react";
import Link from "next/link";

import { Dialog } from "@/components/ui/dialog";

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
  // Set the moment createProduct succeeds during a create-mode submit, and
  // cleared on a fully successful save or when the dialog is (re)opened.
  // Its presence means "a product row already exists for this dialog
  // session" - used so a retry after a partial variant/addon failure routes
  // through updateProduct instead of calling createProduct again and
  // leaving a duplicate, half-configured product behind. See
  // handleSubmitProduct.
  const [createdProductId, setCreatedProductId] = React.useState<string | null>(null);

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
    setCreatedProductId(null);
    setDialog({ mode: "create" });
  }

  function openEditDialog(product: ProductRow) {
    setFormError(null);
    setCreatedProductId(null);
    setDialog({ mode: "edit", product });
  }

  function closeDialog() {
    setDialog(null);
    setFormError(null);
    setCreatedProductId(null);
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

    // A row already exists for this dialog session either because we're
    // genuinely editing a pre-existing product, or because a previous
    // submit's createProduct call already succeeded but a later
    // addVariant/addAddon call failed partway through (createdProductId is
    // set below, right after createProduct resolves, precisely so this
    // check catches that case too). Either way, submitting again must
    // never call createProduct a second time - that would leave a
    // duplicate, half-configured product behind - so it always goes
    // through updateProduct instead.
    const existingProductId = dialog.mode === "edit" ? dialog.product.id : createdProductId;

    let productId: string;

    if (existingProductId) {
      const result = await updateProduct({ productId: existingProductId, ...basePayload });
      if (!result.ok) {
        setFormSubmitting(false);
        setFormError(result.message);
        return;
      }
      productId = existingProductId;
    } else {
      const result = await createProduct({ ...basePayload, isAvailable: true });
      if (!result.ok) {
        setFormSubmitting(false);
        setFormError(result.message);
        return;
      }
      if (!result.data) {
        setFormSubmitting(false);
        setFormError("Something went wrong creating the product. Please try again.");
        return;
      }
      const newProductId = result.data.id;
      // Record the id and move the dialog into edit mode for it *before*
      // attempting the variant/addon adds below. If one of those fails,
      // the dialog stays open pointed at this now-real product: a retry
      // re-enters this function with existingProductId already set (from
      // dialog.mode === "edit", or createdProductId as a fallback) and
      // takes the updateProduct branch above instead of creating a
      // second product.
      setCreatedProductId(newProductId);
      setDialog({ mode: "edit", product: result.data });
      productId = newProductId;
    }

    // Diff against what this product already has on the server. For a
    // brand-new product (this submit's createProduct call just succeeded)
    // that's an empty list, so every submitted row is added; for an
    // existing product - genuine edit or a create retry - it's whatever
    // the last load/revalidation returned, so only the still-missing rows
    // get added and nothing already-saved is recreated.
    const originalVariants = dialog.mode === "edit" ? (variantsByProduct[productId] ?? []) : [];
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

    const originalAddons = dialog.mode === "edit" ? (addonsByProduct[productId] ?? []) : [];
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
    setCreatedProductId(null);
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

      <Dialog
        open={dialog !== null}
        onClose={closeDialog}
        title={dialog?.mode === "edit" ? "Edit product" : "Add product"}
      >
        {dialog ? (
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
        ) : null}
      </Dialog>
    </div>
  );
}
