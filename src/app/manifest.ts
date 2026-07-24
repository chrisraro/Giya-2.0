import type { MetadataRoute } from "next";
import { tokenHex } from "@/lib/md3-token-hex";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Giya",
    short_name: "Giya",
    description: "Turn every receipt into rewards.",
    start_url: "/home",
    display: "standalone",
    background_color: tokenHex("surface"),
    theme_color: tokenHex("surface"),
    icons: [
      { src: "/brand/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/brand/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
