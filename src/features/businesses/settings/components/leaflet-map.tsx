"use client";

import * as React from "react";
import * as L from "leaflet";

import "leaflet/dist/leaflet.css";

import { MAP_PIN_CLASS, MAP_PIN_SIZE } from "@/components/maps/map-chrome";
import type { Coordinates } from "@/lib/maps/coordinates";
import { MAP_MAX_ZOOM, tileUrlTemplate, type MapColorScheme } from "@/lib/maps/tile-source";

// ===========================================================================
// THE INTERACTIVE MAP. The only module in the codebase that imports Leaflet.
//
// It is loaded exclusively through `next/dynamic(..., { ssr: false })` from
// ./location-picker.tsx, which is what keeps Leaflet and its stylesheet in
// their own chunk, out of the server bundle and out of the settings route's
// initial JavaScript. Import it statically from anywhere and that property is
// silently lost, so: do not.
//
// LIBRARY CHOICE - Leaflet, not MapLibre GL. Both are BSD and both are the
// genuine open-source options, so the decision came down to what this app is:
//
//   Weight. Leaflet is ~42KB gzipped, all of it. MapLibre GL JS is ~230KB
//   gzipped plus a web worker, before a single tile. Doc 33 sets a 90KB gzip
//   per-route JS budget; MapLibre is two and a half budgets for one control on
//   one screen, on a mobile-first PWA whose users are largely on Philippine
//   mobile data.
//
//   Tiles. MapLibre's advantage is vector tiles, and vector tiles are genuinely
//   better - crisp at any zoom, restyleable at runtime, one dark theme away
//   from a light one. But they arrive with a style JSON, a glyph server and a
//   sprite sheet, all provider-shaped, which is exactly the coupling that makes
//   "swap the tile provider" a project instead of a line. Raster XYZ tiles are
//   the portable primitive: every provider serves them at the same URL shape,
//   and the public page can render them as plain <img> with no library at all
//   (see components/maps/static-map.tsx). That second point is decisive - the
//   static map on /b/[slug] is only possible because the tiles are images.
//
//   What we give up: pinch-zoom sharpness on high-DPI screens, and runtime
//   restyling. The first is handled by asking the provider for a dark basemap
//   rather than restyling one; the second we do not need, because a merchant
//   setting a pin needs to recognise their street, not to theme it.
//
// MOBILE SCROLL. The classic failure is a phone user swiping to scroll the page,
// landing on the map, and panning the map instead - trapped. Handled by making
// gestures OPT-IN: while `active` is false every gesture handler is off, so a
// touchmove over the map bubbles and the page scrolls exactly as it does over a
// paragraph. The merchant enables the map with a deliberate tap and can lock it
// again. `scrollWheelZoom` is off in both states: a desktop wheel over a map
// inside a long form should scroll the form.
// ===========================================================================

/**
 * The handful of imperative operations the surrounding picker needs. Handed
 * over through an `onReady` callback rather than a forwarded ref, because
 * `next/dynamic` does not reliably forward refs and this module is only ever
 * reached through `next/dynamic`.
 */
export interface MapControls {
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
}

export interface LeafletMapProps {
  /** Where to look. Changing it (with `viewNonce`) re-centres the map. */
  readonly center: Coordinates;
  /**
   * Bumped by the parent whenever it wants a re-centre, including a re-centre
   * to coordinates the map is already showing (search for the same address
   * twice). Without it, an equality check on `center` would swallow the second.
   */
  readonly viewNonce: number;
  /** The pin, or null when the merchant has not placed one yet. */
  readonly value: Coordinates | null;
  readonly onChange: (value: Coordinates) => void;
  readonly scheme: MapColorScheme;
  /** Gesture handlers on. See the MOBILE SCROLL note above. */
  readonly active: boolean;
  readonly zoom: number;
  /** Called with the controls once the map exists, and with null on teardown. */
  readonly onReady: (controls: MapControls | null) => void;
}

const GESTURE_HANDLERS = ["dragging", "touchZoom", "doubleClickZoom", "boxZoom", "keyboard"] as const;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function pinIcon(): L.DivIcon {
  return L.divIcon({
    // Empty, so Leaflet's own `leaflet-div-icon` box (a white square with a
    // border) is not drawn behind our pin.
    className: "",
    html: `<span class="${MAP_PIN_CLASS}"></span>`,
    iconSize: [MAP_PIN_SIZE, MAP_PIN_SIZE],
    // The teardrop's point is the bottom-CENTRE of its box after the rotation,
    // so that is the anchor. Centring the box instead would put the pin's point
    // a pin-height north of the shop, which is about 30 metres at this zoom.
    iconAnchor: [MAP_PIN_SIZE / 2, MAP_PIN_SIZE],
  });
}

export function LeafletMap({
  center,
  viewNonce,
  value,
  onChange,
  scheme,
  active,
  zoom,
  onReady,
}: LeafletMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<L.Map | null>(null);
  const markerRef = React.useRef<L.Marker | null>(null);
  const layerRef = React.useRef<L.TileLayer | null>(null);

  // `onChange` lands in Leaflet event handlers that are bound once. Reading it
  // through a ref keeps those handlers from capturing a stale closure without
  // having to tear the map down and rebuild it on every parent render.
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const onReadyRef = React.useRef(onReady);
  React.useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // --- create once ------------------------------------------------------
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = L.map(container, {
      center: [center.lat, center.lng],
      zoom,
      // Ours are rendered in the picker at 48px, because Leaflet's are 26px and
      // doc 16 puts the floor at 48 on touch surfaces.
      zoomControl: false,
      // Ours is rendered outside the map, always visible, as a licence
      // condition rather than a collapsible corner widget.
      attributionControl: false,
      // A wheel over a map inside a long settings form must scroll the form.
      // Never enabled, in either state.
      scrollWheelZoom: false,
    });
    mapRef.current = map;

    // Clicking bare map moves the pin. Alongside dragging the pin itself, this
    // is the fastest way to correct a fix that landed on the wrong side of the
    // street, which is the common real-world case.
    map.on("click", (event: L.LeafletMouseEvent) => {
      onChangeRef.current({ lat: event.latlng.lat, lng: event.latlng.lng });
    });

    onReadyRef.current({
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
    });

    return () => {
      onReadyRef.current(null);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      layerRef.current = null;
    };
    // Creation only. Every prop below is applied by its own effect, so that a
    // changed prop never destroys and rebuilds the map underneath the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- tile layer, and the theme ----------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const template = tileUrlTemplate(scheme);
    if (!template) return;

    layerRef.current?.remove();
    layerRef.current = L.tileLayer(template, {
      maxZoom: MAP_MAX_ZOOM,
      // Leaflet's `attribution` option is deliberately unset: the credit is
      // rendered by the picker as ordinary, always-visible text rather than
      // inside a control that Leaflet lets users collapse.
    }).addTo(map);
  }, [scheme]);

  // --- the pin ----------------------------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    if (!markerRef.current) {
      const marker = L.marker([value.lat, value.lng], {
        icon: pinIcon(),
        draggable: true,
        keyboard: true,
        alt: "Your shop's location. Drag to move it.",
      }).addTo(map);

      marker.on("dragend", () => {
        const position = marker.getLatLng();
        onChangeRef.current({ lat: position.lat, lng: position.lng });
      });

      markerRef.current = marker;
      return;
    }

    markerRef.current.setLatLng([value.lat, value.lng]);
  }, [value]);

  // --- re-centre --------------------------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Doc 16: anything beyond subtle honours reduced motion. A fly-to is a
    // half-second of continuous movement across the whole viewport, which is
    // squarely the kind of thing that triggers vestibular symptoms - so for
    // those users it is an instant jump, not a shorter animation.
    if (prefersReducedMotion()) {
      map.setView([center.lat, center.lng], zoom, { animate: false });
      return;
    }

    map.flyTo([center.lat, center.lng], zoom, { duration: 0.8 });
  }, [center, viewNonce, zoom]);

  // --- gesture handlers -------------------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const name of GESTURE_HANDLERS) {
      const handler = map[name];
      // `keyboard` and friends are optional Leaflet handlers; a build that
      // excluded one would leave the property undefined rather than throw.
      if (!handler) continue;
      if (active) handler.enable();
      else handler.disable();
    }

    const marker = markerRef.current;
    if (marker) {
      if (active) marker.dragging?.enable();
      else marker.dragging?.disable();
    }
  }, [active, value]);

  return (
    <div
      ref={containerRef}
      // `role="application"` tells a screen reader that arrow keys belong to
      // this widget rather than to the reading cursor, which is true once the
      // map is active. The picker's search results and coordinate readout are
      // the path for anyone who would rather not.
      role="application"
      aria-label="Map of your shop's location. Use the search box or the detect button if you would rather not use the map."
      className="h-full w-full"
    />
  );
}

export default LeafletMap;
