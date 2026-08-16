import type { MetadataRoute } from "next";
import { tokenHex } from "@/lib/md3-token-hex";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "giya-pwa-v1",
    name: "Giya",
    short_name: "Giya",
    description: "Turn every receipt into rewards.",
    start_url: "/home",
    display: "standalone",
    orientation: "portrait",
    lang: "en-PH",
    background_color: tokenHex("surface"),
    theme_color: tokenHex("surface"),
    icons: [
      { src: "/brand/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/brand/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    shortcuts: [
      {
        name: "Scan Receipt",
        short_name: "Scan",
        description: "Scan a receipt to earn points",
        url: "/scan",
        icons: [{ src: "/brand/icon.svg", sizes: "any" }],
      },
      {
        name: "My Wallet",
        short_name: "Wallet",
        description: "View points balances and claims",
        url: "/wallet",
        icons: [{ src: "/brand/icon.svg", sizes: "any" }],
      },
    ],
  };
}
