"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const emptySubscribe = () => () => {};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Hydration-safe mounted check: false on the server snapshot, true on the client.
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  if (!mounted) return null;
  return (
    <Button variant="tonal" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
      <span aria-hidden className="material-symbols-rounded">
        {resolvedTheme === "dark" ? "light_mode" : "dark_mode"}
      </span>
      {resolvedTheme === "dark" ? "Light" : "Dark"}
    </Button>
  );
}
