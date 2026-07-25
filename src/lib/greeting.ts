// Time-of-day greeting for the consumer home header.
//
// Giya is a Philippine product and every consumer surface is priced, dated and
// scheduled in Manila time (see the Asia/Manila formatters in
// src/app/(consumer)/wallet/page.tsx and the receipts pipeline). The greeting
// has to agree with that: a consumer opening the app at 7pm in Cebu must not be
// wished "magandang umaga" because the server that rendered the page happens to
// sit in UTC. So the hour is read through an Intl formatter pinned to
// Asia/Manila rather than off the Date's local fields.

/** The one time zone every consumer-facing date in this app is expressed in. */
export const MANILA_TIME_ZONE = "Asia/Manila";

// hourCycle "h23" rather than hour12:false: with hour12:false some engines fall
// back to the h24 cycle and report midnight as "24", which would silently push
// the small hours into the "gabi" branch.
const MANILA_HOUR_FORMAT = new Intl.DateTimeFormat("en-PH", {
  timeZone: MANILA_TIME_ZONE,
  hour: "numeric",
  hourCycle: "h23",
});

/** The hour of the day (0 to 23) that `now` falls on in Manila. */
export function manilaHour(now: Date): number {
  return Number.parseInt(MANILA_HOUR_FORMAT.format(now), 10);
}

/**
 * The Filipino greeting that fits the Manila hour: umaga through the morning,
 * tanghali across noon, hapon for the afternoon, gabi from 6pm. Returns the
 * greeting alone, with no name attached, because the caller may not have one:
 * a profile row with no display name renders "Magandang gabi" on its own
 * rather than a dangling comma.
 */
export function filipinoGreeting(now: Date): string {
  const hour = manilaHour(now);
  if (hour < 12) return "Magandang umaga";
  if (hour < 13) return "Magandang tanghali";
  if (hour < 18) return "Magandang hapon";
  return "Magandang gabi";
}

/** The home header's date line, e.g. "Sunday, July 26". */
export function manilaDateCaption(now: Date): string {
  return new Intl.DateTimeFormat("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: MANILA_TIME_ZONE,
  }).format(now);
}
