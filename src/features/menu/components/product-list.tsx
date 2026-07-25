"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { formatPeso } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { ProductRow } from "../types";

type ActionResult = { ok: true } | { ok: false; message: string };

export interface ProductListProps {
  title: string;
  products: ProductRow[];
  onAddProduct: () => void;
  onEditProduct: (product: ProductRow) => void;
  onToggleAvailability: (product: ProductRow) => Promise<ActionResult>;
  onArchiveProduct: (product: ProductRow) => Promise<ActionResult>;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  hidden: "Hidden",
  sold_out: "Sold out",
};

function statusPillClass(status: string): string {
  if (status === "sold_out") return "bg-error-container text-on-error-container";
  if (status === "hidden") return "bg-surface-container-high text-on-surface-variant";
  return "bg-secondary-container text-on-secondary-container";
}

export function ProductList({
  title,
  products,
  onAddProduct,
  onEditProduct,
  onToggleAvailability,
  onArchiveProduct,
}: ProductListProps) {
  const [pendingIds, setPendingIds] = React.useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const [confirmArchiveId, setConfirmArchiveId] = React.useState<string | null>(null);

  function setRowPending(id: string, pending: boolean) {
    setPendingIds((prev) => ({ ...prev, [id]: pending }));
  }

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  async function handleToggleAvailability(product: ProductRow) {
    setRowError(product.id, null);
    setRowPending(product.id, true);
    const result = await onToggleAvailability(product);
    setRowPending(product.id, false);
    if (!result.ok) setRowError(product.id, result.message);
  }

  async function handleArchive(product: ProductRow) {
    setRowError(product.id, null);
    setRowPending(product.id, true);
    const result = await onArchiveProduct(product);
    setRowPending(product.id, false);
    setConfirmArchiveId(null);
    if (!result.ok) setRowError(product.id, result.message);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title-l text-on-surface">{title}</h2>
        <Button type="button" variant="tonal" size="md" onClick={onAddProduct}>
          Add product
        </Button>
      </div>

      {products.length === 0 ? (
        <EmptyState
          icon="restaurant_menu"
          title="No items yet"
          body="Add your first product to start building this menu."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => {
            const isPending = Boolean(pendingIds[product.id]);
            const rowError = rowErrors[product.id];
            const isConfirmingArchive = confirmArchiveId === product.id;

            return (
              <li key={product.id}>
                <Card variant="outlined" className="flex h-full flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-title-m text-on-surface">{product.name}</p>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-label-m",
                        statusPillClass(product.status),
                      )}
                    >
                      {STATUS_LABEL[product.status] ?? product.status}
                    </span>
                  </div>

                  <p className="text-title-s text-on-surface-variant">
                    {formatPeso(product.base_price_centavos)}
                  </p>

                  <div className="mt-auto flex flex-col gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={product.is_available}
                      aria-label={
                        product.is_available ? `Mark ${product.name} unavailable` : `Mark ${product.name} available`
                      }
                      disabled={isPending}
                      onClick={() => handleToggleAvailability(product)}
                      className={cn(
                        "flex h-10 items-center justify-between rounded-full px-4 text-label-l transition-colors duration-200 ease-standard",
                        "outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50",
                        product.is_available
                          ? "bg-secondary-container text-on-secondary-container"
                          : "border border-outline bg-transparent text-on-surface-variant",
                      )}
                    >
                      {product.is_available ? "Available" : "Unavailable"}
                    </button>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outlined"
                        size="sm"
                        className="flex-1"
                        onClick={() => onEditProduct(product)}
                      >
                        Edit
                      </Button>
                      {isConfirmingArchive ? (
                        <>
                          <Button
                            type="button"
                            variant="filled"
                            size="sm"
                            className="bg-error text-on-error after:hidden"
                            disabled={isPending}
                            onClick={() => handleArchive(product)}
                          >
                            Confirm
                          </Button>
                          <Button
                            type="button"
                            variant="text"
                            size="sm"
                            onClick={() => setConfirmArchiveId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="text"
                          size="sm"
                          onClick={() => setConfirmArchiveId(product.id)}
                        >
                          Archive
                        </Button>
                      )}
                    </div>
                  </div>

                  {rowError ? (
                    <p role="alert" className="text-body-s text-error">
                      {rowError}
                    </p>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
