"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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
