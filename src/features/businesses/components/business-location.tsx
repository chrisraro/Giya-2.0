import { StaticMap } from "@/components/maps/static-map";
import { buttonVariants } from "@/components/ui/button";
import { directionsUrl, formatCoordinates, type Coordinates } from "@/lib/maps/coordinates";
import { cn } from "@/lib/utils";

// ===========================================================================
// "Where to find us", on the public business page.
//
// The owner's requirement in their own words: "consumers will not guess anymore
// the directions of the business address. They can see it on the business
// profile when they tap it."
//
// This is a SERVER component and stays one. It ships no client JavaScript: the
// map is a static tile mosaic (../../../components/maps/static-map.tsx) and the
// directions control is an anchor. See that file for why the public page does
// not get an interactive map.
//
// THE DEGRADATION LADDER, worst case first, because the middle rungs are the
// normal state for most merchants today and none of them may look broken:
//
//   no address, no pin      The whole block is omitted. No empty heading.
//   address, no pin         Address text alone. This is where every business
//                           sits until its owner opens the picker, so it is the
//                           common case and not an error state.
//   address and pin         Address text, a map, and a directions link.
//   pin, no tile key        Address text and a directions link, no picture. The
//                           link is two numbers in a URL and needs no basemap,
//                           so the requirement survives a missing tile key
//                           intact.
//
// ACCESSIBILITY. The map is decorative and everything it conveys is reachable
// without it: the address is text, the coordinates are text, and "Get
// directions" is a labelled link in the tab order. A screen-reader or
// keyboard-only visitor never has to touch, hover or pan anything. The map
// image is wrapped in the same link rather than being separately interactive,
// so there is one target and one announcement instead of two that do the
// same thing.
// ===========================================================================

export interface BusinessLocationProps {
  readonly name: string;
  readonly addressText: string | null;
  readonly coordinates: Coordinates | null;
}

export function BusinessLocation({ name, addressText, coordinates }: BusinessLocationProps) {
  if (!addressText && !coordinates) return null;

  const directions = coordinates ? directionsUrl(coordinates) : null;

  return (
    <section className="mt-6 px-4">
      <h2 className="text-title-l text-on-surface">Where to find us</h2>

      {addressText ? (
        <address className="mt-2 not-italic text-body-m text-on-surface-variant">
          {addressText}
        </address>
      ) : null}

      {coordinates && directions ? (
        <>
          <a
            href={directions}
            target="_blank"
            rel="noopener noreferrer"
            // The picture is a shortcut to the same place the button below
            // goes. `tabIndex={-1}` keeps it out of the tab order so keyboard
            // users meet one directions control, not two identical ones; the
            // button underneath is the labelled, focusable path.
            tabIndex={-1}
            aria-hidden
            className="mt-3 block rounded-md3-md outline-none"
          >
            <StaticMap center={coordinates} label={name} />
          </a>

          <div className="mt-3 flex flex-col gap-2">
            <a
              href={directions}
              target="_blank"
              rel="noopener noreferrer"
              // Named for the destination rather than "Get directions" alone,
              // so a screen reader reading links out of context still knows
              // which shop this leads to.
              aria-label={`Get directions to ${name}`}
              className={cn(buttonVariants({ variant: "tonal", size: "touch" }), "w-full")}
            >
              <span aria-hidden className="material-symbols-rounded">
                directions
              </span>
              Get directions
            </a>
            <p className="text-label-s text-on-surface-variant">
              Opens in your maps app.{" "}
              <span className="font-mono">{formatCoordinates(coordinates)}</span>
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
