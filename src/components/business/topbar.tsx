"use client";

import * as React from "react";
import { ThemeToggle } from "@/components/design/theme-toggle";

export interface TopbarProps {
  title: string;
  onMenuClick: () => void;
  menuButtonRef?: React.Ref<HTMLButtonElement>;
  /**
   * `profiles.display_name` of the signed-in user, resolved server-side in the
   * portal layout. Null when there is no profile row or it could not be read.
   */
  userName?: string | null;
  /** Up to two initials derived from `userName`; null renders a neutral glyph. */
  userInitials?: string | null;
  /** The name of the business this session actually belongs to. */
  businessName?: string | null;
}

/**
 * Sticky business portal header: mobile hamburger, page title, business name,
 * theme toggle, and the signed-in user's avatar.
 *
 * The avatar carries the caller's OWN identity or none at all. It used to be
 * hardcoded, which meant every staff member of every tenant saw the same two
 * letters and the same accessible name in the chrome of all eight portal
 * routes: a screen reader announced somebody else's name as the account
 * control. When there is no readable name, the fallback is a person glyph
 * labelled "Your account", never a placeholder person.
 */
export function Topbar({
  title,
  onMenuClick,
  menuButtonRef,
  userName = null,
  userInitials = null,
  businessName = null,
}: TopbarProps) {
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
      {businessName !== null && (
        <span className="hidden max-w-56 truncate text-body-m text-on-surface-variant sm:inline">
          {businessName}
        </span>
      )}
      <ThemeToggle />
      <span
        role="img"
        aria-label={userName ?? "Your account"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-label-m text-on-secondary-container"
      >
        {userInitials ?? (
          <span aria-hidden className="material-symbols-rounded text-[18px]">
            person
          </span>
        )}
      </span>
    </header>
  );
}
