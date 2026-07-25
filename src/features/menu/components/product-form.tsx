"use client";

import * as React from "react";
import { useFieldArray, useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";
import { formatPeso, pesoToCentavos } from "@/lib/money";

import {
  productStatusSchema,
  type ProductStatus,
  DESCRIPTION_MAX_LENGTH,
  PRODUCT_IMAGES_MAX,
  PRODUCT_NAME_MAX_LENGTH,
  VARIANT_NAME_MAX_LENGTH,
  ADDON_NAME_MAX_LENGTH,
} from "../schemas";
import type { ProductAddonRow, ProductRow, ProductVariantRow } from "../types";

// Shared visual treatment for native <select>/<textarea> controls, mirroring
// TextField's height/border/radius/focus classes by hand (same rationale as
// the onboarding wizard's fieldControlClass: these element types aren't
// covered by TextField's input-only props type).
const fieldControlClass = cn(
  "rounded-md3-xs border bg-surface px-4 text-body-l text-on-surface",
  "outline-none transition-colors duration-200 ease-standard",
);

function controlBorderClass(hasError: boolean) {
  return hasError
    ? "border-error focus:border-error focus:ring-1 focus:ring-error"
    : "border-outline focus:border-primary focus:ring-1 focus:ring-primary";
}

/**
 * A peso amount typed as a string, validated as parseable via
 * `pesoToCentavos` (accepts up to 2 decimal digits, no negatives). Kept
 * string-first in form state so the input never fights the user mid-type
 * (e.g. while they're still typing "12." before the cents digits).
 */
function isValidPeso(value: string): boolean {
  try {
    pesoToCentavos(value);
    return true;
  } catch {
    return false;
  }
}

const priceStringSchema = z
  .string()
  .min(1, "Price is required")
  .refine(isValidPeso, "Enter a valid price");

const imageRowSchema = z.object({
  url: z.string().min(1, "Enter an image URL").url("Enter a valid URL"),
});

// These field bounds are kept in sync with the canonical schemas in
// ../schemas.ts (productSchema/variantSchema/addonSchema, which mirror the
// DB checks) via the imported constants above, so the two can't silently
// drift apart. The z.string() calls stay local rather than reusing
// productSchema.shape.* directly because this form wants its own
// UX-friendly messages ("Name is required") instead of zod's defaults.
const variantRowSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(1, "Variant name is required")
    .max(VARIANT_NAME_MAX_LENGTH, `Keep it under ${VARIANT_NAME_MAX_LENGTH} characters`),
  price: priceStringSchema,
});

const addonRowSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(1, "Add-on name is required")
    .max(ADDON_NAME_MAX_LENGTH, `Keep it under ${ADDON_NAME_MAX_LENGTH} characters`),
  priceDelta: priceStringSchema,
});

const productFormSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(PRODUCT_NAME_MAX_LENGTH, `Name must be ${PRODUCT_NAME_MAX_LENGTH} characters or fewer`),
  description: z
    .string()
    .max(DESCRIPTION_MAX_LENGTH, `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`)
    .optional(),
  basePrice: priceStringSchema,
  categoryId: z.string(),
  status: productStatusSchema,
  images: z.array(imageRowSchema).max(PRODUCT_IMAGES_MAX, `Up to ${PRODUCT_IMAGES_MAX} images`),
  variants: z.array(variantRowSchema),
  addons: z.array(addonRowSchema),
});

type ProductFormValues = z.infer<typeof productFormSchema>;

export interface ProductFormCategoryOption {
  id: string;
  name: string;
}

export interface ProductFormOutput {
  name: string;
  description?: string;
  basePriceCentavos: number;
  categoryId: string | null;
  status: ProductStatus;
  images: string[];
  variants: { id?: string; name: string; priceCentavos: number }[];
  addons: { id?: string; name: string; priceDeltaCentavos: number }[];
}

export interface ProductFormProps {
  categories: ProductFormCategoryOption[];
  product?: ProductRow;
  variants?: ProductVariantRow[];
  addons?: ProductAddonRow[];
  onSubmit: (values: ProductFormOutput) => void;
  onCancel: () => void;
  submitting?: boolean;
  serverError?: string | null;
}

const STATUS_OPTIONS: { value: ProductStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "hidden", label: "Hidden" },
  { value: "sold_out", label: "Sold out" },
];

export function ProductForm({
  categories,
  product,
  variants = [],
  addons = [],
  onSubmit,
  onCancel,
  submitting = false,
  serverError = null,
}: ProductFormProps) {
  const defaultValues = React.useMemo<ProductFormValues>(
    () => ({
      name: product?.name ?? "",
      description: product?.description ?? "",
      basePrice: product ? formatPeso(product.base_price_centavos, { symbol: false }) : "",
      categoryId: product?.category_id ?? "",
      status: (product?.status as ProductStatus | undefined) ?? "active",
      images: ((product?.images as string[] | null) ?? []).map((url) => ({ url: String(url) })),
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        price: formatPeso(v.price_centavos, { symbol: false }),
      })),
      addons: addons.map((a) => ({
        id: a.id,
        name: a.name,
        priceDelta: formatPeso(a.price_delta_centavos, { symbol: false }),
      })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-derive when the product being edited changes
    [product?.id],
  );

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues,
  });

  const imageFields = useFieldArray({ control, name: "images" });
  const variantFields = useFieldArray({ control, name: "variants" });
  const addonFields = useFieldArray({ control, name: "addons" });

  const submit: SubmitHandler<ProductFormValues> = (values) => {
    onSubmit({
      name: values.name,
      ...(values.description ? { description: values.description } : {}),
      basePriceCentavos: pesoToCentavos(values.basePrice),
      categoryId: values.categoryId === "" ? null : values.categoryId,
      status: values.status,
      images: values.images.map((row) => row.url),
      variants: values.variants.map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        name: row.name,
        priceCentavos: pesoToCentavos(row.price),
      })),
      addons: values.addons.map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        name: row.name,
        priceDeltaCentavos: pesoToCentavos(row.priceDelta),
      })),
    });
  };

  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="flex flex-col gap-6">
      {serverError ? (
        <p role="alert" className="text-body-s text-error">
          {serverError}
        </p>
      ) : null}

      <TextField
        id="product-name"
        label="Name"
        placeholder="e.g. Iced Caramel Latte"
        {...(errors.name?.message ? { errorText: errors.name.message } : {})}
        {...register("name")}
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="product-description" className="text-label-l text-on-surface">
          Description
        </label>
        <textarea
          id="product-description"
          rows={3}
          placeholder="Optional details customers see on the menu"
          aria-invalid={Boolean(errors.description) || undefined}
          aria-describedby={errors.description ? "product-description-error" : undefined}
          className={cn(fieldControlClass, "py-3", controlBorderClass(Boolean(errors.description)))}
          {...register("description")}
        />
        {errors.description ? (
          <p id="product-description-error" role="alert" className="text-body-s text-error">
            {errors.description.message}
          </p>
        ) : null}
      </div>

      <TextField
        id="product-base-price"
        label="Base price"
        placeholder="0.00"
        inputMode="decimal"
        {...(errors.basePrice?.message ? { errorText: errors.basePrice.message } : {})}
        {...register("basePrice")}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="product-category" className="text-label-l text-on-surface">
            Category
          </label>
          <select
            id="product-category"
            className={cn(fieldControlClass, "h-12", controlBorderClass(false))}
            {...register("categoryId")}
          >
            <option value="">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="product-status" className="text-label-l text-on-surface">
            Status
          </label>
          <select
            id="product-status"
            className={cn(fieldControlClass, "h-12", controlBorderClass(false))}
            {...register("status")}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
        <legend className="px-1 text-title-s text-on-surface">Images</legend>
        <p className="text-body-s text-on-surface-variant">
          TODO(storage): uploads arrive with the storage slice. For now, paste an image URL per row.
        </p>
        {imageFields.fields.map((field, index) => {
          const urlError = errors.images?.[index]?.url?.message;
          return (
            <div key={field.id} className="flex items-start gap-2">
              <div className="flex-1">
                <TextField
                  id={`product-image-${index}`}
                  label={`Image ${index + 1}`}
                  placeholder="https://..."
                  {...(urlError ? { errorText: urlError } : {})}
                  {...register(`images.${index}.url` as const)}
                />
              </div>
              <Button
                type="button"
                variant="text"
                size="sm"
                className="mt-8"
                aria-label={`Remove image ${index + 1}`}
                onClick={() => imageFields.remove(index)}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="tonal"
          size="sm"
          className="self-start"
          disabled={imageFields.fields.length >= 6}
          onClick={() => imageFields.append({ url: "" })}
        >
          Add image
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
        <legend className="px-1 text-title-s text-on-surface">Variants</legend>
        {variantFields.fields.map((field, index) => {
          const nameError = errors.variants?.[index]?.name?.message;
          const priceError = errors.variants?.[index]?.price?.message;
          return (
            <div key={field.id} className="flex items-start gap-2">
              <div className="flex-1">
                <TextField
                  id={`product-variant-name-${index}`}
                  label="Name"
                  placeholder="e.g. Large"
                  {...(nameError ? { errorText: nameError } : {})}
                  {...register(`variants.${index}.name` as const)}
                />
              </div>
              <div className="w-32">
                <TextField
                  id={`product-variant-price-${index}`}
                  label="Price"
                  placeholder="0.00"
                  inputMode="decimal"
                  {...(priceError ? { errorText: priceError } : {})}
                  {...register(`variants.${index}.price` as const)}
                />
              </div>
              <Button
                type="button"
                variant="text"
                size="sm"
                className="mt-8"
                aria-label={`Remove variant ${index + 1}`}
                onClick={() => variantFields.remove(index)}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="tonal"
          size="sm"
          className="self-start"
          onClick={() => variantFields.append({ name: "", price: "" })}
        >
          Add variant
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
        <legend className="px-1 text-title-s text-on-surface">Add-ons</legend>
        {addonFields.fields.map((field, index) => {
          const nameError = errors.addons?.[index]?.name?.message;
          const priceError = errors.addons?.[index]?.priceDelta?.message;
          return (
            <div key={field.id} className="flex items-start gap-2">
              <div className="flex-1">
                <TextField
                  id={`product-addon-name-${index}`}
                  label="Name"
                  placeholder="e.g. Extra shot"
                  {...(nameError ? { errorText: nameError } : {})}
                  {...register(`addons.${index}.name` as const)}
                />
              </div>
              <div className="w-32">
                <TextField
                  id={`product-addon-price-${index}`}
                  label="Price"
                  placeholder="0.00"
                  inputMode="decimal"
                  {...(priceError ? { errorText: priceError } : {})}
                  {...register(`addons.${index}.priceDelta` as const)}
                />
              </div>
              <Button
                type="button"
                variant="text"
                size="sm"
                className="mt-8"
                aria-label={`Remove add-on ${index + 1}`}
                onClick={() => addonFields.remove(index)}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="tonal"
          size="sm"
          className="self-start"
          onClick={() => addonFields.append({ name: "", priceDelta: "" })}
        >
          Add add-on
        </Button>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="button" variant="text" size="touch" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="filled" size="touch" className="flex-1" disabled={submitting}>
          {submitting ? "Saving..." : "Save product"}
        </Button>
      </div>
    </form>
  );
}
