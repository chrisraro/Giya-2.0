"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** id of an element (usually a description paragraph) to wire up as aria-describedby. */
  describedById?: string;
  className?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable MD3 dialog primitive: scrim + panel, `role="dialog"` /
 * `aria-modal="true"` / `aria-labelledby` wired to the title. While open it
 * moves focus into the panel, traps Tab/Shift+Tab within it, locks body
 * scroll, and closes on Escape or a scrim click; on close it restores focus
 * to whatever was focused before the dialog opened.
 *
 * Intended to be mounted unconditionally by the caller - `open` toggles
 * visibility rather than the caller conditionally rendering `<Dialog>`
 * itself - so these effects run continuously across open/close transitions
 * instead of re-attaching from scratch each time. See
 * `src/features/menu/components/menu-manager.tsx` for the reference usage.
 */
export function Dialog({ open, onClose, title, children, describedById, className }: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const previouslyFocusedRef = React.useRef<Element | null>(null);

  // Move focus into the panel on open (the first focusable element, or the
  // panel itself if it has none); restore focus to whatever was focused
  // immediately before the dialog opened once it closes again.
  React.useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? panel)?.focus();

    return () => {
      const target = previouslyFocusedRef.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open]);

  // Escape closes the dialog; Tab/Shift+Tab is trapped among the panel's
  // own focusable elements so keyboard focus cannot escape behind the
  // scrim while the dialog is open.
  React.useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Lock body scroll while open; restore whatever it was on close/unmount.
  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(describedById ? { "aria-describedby": describedById } : {})}
        tabIndex={-1}
        className={cn(
          "flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-md3-xl bg-surface-container-high p-6 shadow-md outline-none",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-headline-s text-on-surface">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-highest focus-visible:ring-2 focus-visible:ring-secondary"
          >
            <span aria-hidden className="material-symbols-rounded text-[18px]">
              close
            </span>
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}
