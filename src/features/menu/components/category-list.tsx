"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";

import type { MenuCategoryRow } from "../types";

export interface CategoryListProps {
  categories: MenuCategoryRow[];
  selectedCategoryId: string | "all";
  onSelect: (categoryId: string | "all") => void;
  onAdd: (name: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onRename: (categoryId: string, name: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onReorder: (categoryId: string, direction: "up" | "down") => Promise<{ ok: true } | { ok: false; message: string }>;
  onArchive: (categoryId: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * Left-rail category manager: an "All items" pseudo-entry plus one row per
 * live category. Add is an inline text field (no dialog); rename swaps a
 * row into edit mode in place; reorder swaps sort with the adjacent row;
 * archive asks for a confirm click before calling through. Every action's
 * result surfaces its own inline error - there is no shared error banner -
 * so a failed rename doesn't block a still-pending add, etc.
 */
export function CategoryList({
  categories,
  selectedCategoryId,
  onSelect,
  onAdd,
  onRename,
  onReorder,
  onArchive,
}: CategoryListProps) {
  const [newName, setNewName] = React.useState("");
  const [addError, setAddError] = React.useState<string | null>(null);
  const [addPending, setAddPending] = React.useState(false);

  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const [renamePending, setRenamePending] = React.useState(false);

  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const [pendingIds, setPendingIds] = React.useState<Record<string, boolean>>({});
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

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setAddError("Category name is required.");
      return;
    }
    setAddError(null);
    setAddPending(true);
    const result = await onAdd(trimmed);
    setAddPending(false);
    if (!result.ok) {
      setAddError(result.message);
      return;
    }
    setNewName("");
  }

  function startRename(category: MenuCategoryRow) {
    setRenamingId(category.id);
    setRenameValue(category.name);
    setRenameError(null);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue("");
    setRenameError(null);
  }

  async function handleRenameSubmit(event: React.FormEvent, categoryId: string) {
    event.preventDefault();
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("Category name is required.");
      return;
    }
    setRenamePending(true);
    const result = await onRename(categoryId, trimmed);
    setRenamePending(false);
    if (!result.ok) {
      setRenameError(result.message);
      return;
    }
    cancelRename();
  }

  async function handleReorder(categoryId: string, direction: "up" | "down") {
    setRowError(categoryId, null);
    setRowPending(categoryId, true);
    const result = await onReorder(categoryId, direction);
    setRowPending(categoryId, false);
    if (!result.ok) setRowError(categoryId, result.message);
  }

  async function handleArchive(categoryId: string) {
    setRowError(categoryId, null);
    setRowPending(categoryId, true);
    const result = await onArchive(categoryId);
    setRowPending(categoryId, false);
    setConfirmArchiveId(null);
    if (!result.ok) setRowError(categoryId, result.message);
  }

  return (
    <nav aria-label="Menu categories" className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onSelect("all")}
        aria-current={selectedCategoryId === "all" ? "true" : undefined}
        className={cn(
          "flex h-12 items-center rounded-md3-sm px-4 text-left text-label-l transition-colors duration-200 ease-standard",
          selectedCategoryId === "all"
            ? "bg-secondary-container text-on-secondary-container"
            : "text-on-surface-variant hover:bg-surface-container",
        )}
      >
        All items
      </button>

      {categories.length === 0 ? (
        <p className="px-4 py-2 text-body-s text-on-surface-variant">No categories yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {categories.map((category, index) => {
            const isRenaming = renamingId === category.id;
            const isPending = Boolean(pendingIds[category.id]);
            const rowError = rowErrors[category.id];
            const isConfirmingArchive = confirmArchiveId === category.id;

            return (
              <li key={category.id} className="flex flex-col gap-1">
                {isRenaming ? (
                  <form
                    onSubmit={(event) => handleRenameSubmit(event, category.id)}
                    className="flex items-center gap-2 px-2"
                  >
                    <TextField
                      id={`rename-category-${category.id}`}
                      label="Category name"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      autoFocus
                      {...(renameError ? { errorText: renameError } : {})}
                    />
                    <Button type="submit" variant="tonal" size="sm" disabled={renamePending}>
                      Save
                    </Button>
                    <Button type="button" variant="text" size="sm" onClick={cancelRename}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSelect(category.id)}
                      aria-current={selectedCategoryId === category.id ? "true" : undefined}
                      className={cn(
                        "flex h-12 flex-1 items-center truncate rounded-md3-sm px-4 text-left text-label-l transition-colors duration-200 ease-standard",
                        selectedCategoryId === category.id
                          ? "bg-secondary-container text-on-secondary-container"
                          : "text-on-surface-variant hover:bg-surface-container",
                      )}
                    >
                      {category.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${category.name} up`}
                      disabled={index === 0 || isPending}
                      onClick={() => handleReorder(category.id, "up")}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-30"
                    >
                      <span aria-hidden className="material-symbols-rounded text-[18px]">
                        arrow_upward
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${category.name} down`}
                      disabled={index === categories.length - 1 || isPending}
                      onClick={() => handleReorder(category.id, "down")}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-30"
                    >
                      <span aria-hidden className="material-symbols-rounded text-[18px]">
                        arrow_downward
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Rename ${category.name}`}
                      onClick={() => startRename(category)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <span aria-hidden className="material-symbols-rounded text-[18px]">
                        edit
                      </span>
                    </button>
                    {isConfirmingArchive ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleArchive(category.id)}
                          disabled={isPending}
                          className="rounded-full bg-error px-3 py-1 text-label-m text-on-error"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmArchiveId(null)}
                          className="text-label-m text-on-surface-variant"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Archive ${category.name}`}
                        onClick={() => setConfirmArchiveId(category.id)}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <span aria-hidden className="material-symbols-rounded text-[18px]">
                          archive
                        </span>
                      </button>
                    )}
                  </div>
                )}
                {rowError ? (
                  <p role="alert" className="px-4 text-body-s text-error">
                    {rowError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex items-center gap-2 px-2 pt-2">
        <TextField
          id="new-category-name"
          label="New category"
          placeholder="e.g. Drinks"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          {...(addError ? { errorText: addError } : {})}
        />
        <Button type="submit" variant="tonal" size="md" disabled={addPending}>
          Add
        </Button>
      </form>
    </nav>
  );
}
