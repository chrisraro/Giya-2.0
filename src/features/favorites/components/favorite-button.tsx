"use client";

import { useTransition, useState } from "react";
import { toggleFavoriteAction } from "../server/actions";

export function FavoriteButton({
  businessId,
  initialIsFavorite,
}: {
  businessId: string;
  initialIsFavorite: boolean;
}) {
  const [isFav, setIsFav] = useState(initialIsFavorite);
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    const next = !isFav;
    setIsFav(next);
    startTransition(async () => {
      const res = await toggleFavoriteAction(businessId, isFav);
      if (!res.ok) {
        setIsFav(isFav); // revert on failure
      }
    });
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={isPending}
      aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
      className="inline-flex size-10 items-center justify-center rounded-full bg-surface-container-highest/80 text-on-surface hover:bg-surface-container-highest transition-colors"
    >
      <span
        aria-hidden
        className={`material-symbols-rounded text-xl ${
          isFav ? "text-error fill-1" : "text-on-surface-variant"
        }`}
      >
        {isFav ? "favorite" : "favorite_border"}
      </span>
    </button>
  );
}
