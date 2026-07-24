"use client";

import * as React from "react";
import { ThemeToggle } from "@/components/design/theme-toggle";

export interface TopbarProps {
  title: string;
  onMenuClick: () => void;
  menuButtonRef?: React.Ref<HTMLButtonElement>;
}

/** Sticky business portal header: mobile hamburger, page title, theme toggle, owner avatar. */
export function Topbar({ title, onMenuClick, menuButtonRef }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container px-4 lg:px-6">
      <button
        ref={menuButtonRef}
        type="button"
        aria-label="Open navigation"
        onClick={onMenuClick}
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high focus-visible:ring-2 focus-visible:ring-secondary lg:hidden"
      >
        <span aria-hidden className="material-symbols-rounded">
          menu
        </span>
      </button>
      <h1 className="min-w-0 flex-1 truncate text-title-l text-on-surface">{title}</h1>
      <ThemeToggle />
      <span
        role="img"
        aria-label="Ramon Dela Cruz"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-label-m text-on-secondary-container"
      >
        RD
      </span>
    </header>
  );
}
