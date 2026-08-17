import type { MetadataRoute } from "next";
import { tokenHex } from "@/lib/md3-token-hex";

/**
 * The web app manifest (doc 41 section 2).
 *
 * Three of these fields are the difference between "we say we are installable"
 * and being installable, and each was wrong before:
 *
 *   id         "/" is the install's permanent identity. A versioned id like
 *              "giya-pwa-v1" makes the next version read as a DIFFERENT app -
 *              a second icon on the home screen instead of an update to the
 *              one already there.
 *
 *   start_url  "/?source=pwa" is the ONLY signal that separates a launch from
 *              the home screen from a launch in a browser tab. Without the
 *              query there is nothing to attribute an install to, and doc 40's
 *              install funnel has no input.
 *
 *   icons      raster PNG, one purpose per entry. See scripts/generate-pwa-icons.ts
 *              for why SVG does not work here, and why the PNGs are committed.
 *
 * Colours come from the generated MD3 tokens rather than literal hex so the
 * splash screen cannot drift from the app it introduces.
 */

/** One entry per purpose. "any maskable" on a single entry is legal syntax and
 *  a trap: a launcher wanting a maskable icon would crop this exact bitmap, and
 *  a bitmap safe to crop is not the one you want shown uncropped. */
const ICONS: MetadataRoute.Manifest["icons"] = [
  { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  {
    src: "/brand/icon-maskable-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "maskable",
  },
  {
    src: "/brand/icon-maskable-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
  // Android 13+ themed icons: the launcher re-tints the alpha channel to the
  // user's wallpaper palette and ignores the colour we ship.
  {
    src: "/brand/icon-monochrome-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "monochrome",
  },
  {
    src: "/brand/icon-monochrome-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "monochrome",
  },
];

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Giya",
    short_name: "Giya",
    description: "Turn every receipt into rewards.",
    start_url: "/?source=pwa",
    display: "standalone",
    orientation: "portrait",
    lang: "en-PH",
    background_color: tokenHex("surface"),
    theme_color: tokenHex("surface"),
    icons: ICONS,
    shortcuts: [
      {
        name: "Scan receipt",
        short_name: "Scan",
        description: "Scan a receipt to earn points",
        url: "/scan",
        icons: [{ src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "My rewards",
        short_name: "Rewards",
        description: "Browse rewards and your active claims",
        url: "/rewards",
        icons: [{ src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
