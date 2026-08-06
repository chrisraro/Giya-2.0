import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows Tailwind's OWN font-size scale (`text-xs`..`text-9xl`)
// as the "font-size" conflict group. This repo's MD3 type scale is a set of
// custom `@utility text-title-s` (etc) rules in globals.css that tailwind-merge
// has never seen, so - left unregistered - it falls back to classifying them as
// unrecognized `text-*` classes, which land in its permissive "text-color" catch-
// all group: the SAME group as `text-on-surface`. That means composing a
// type-scale class with a color class through `cn()` silently deleted the SIZE
// class and kept only the color (`cn("text-title-s", "text-on-surface")` ->
// `"text-on-surface"`) - a repo-wide, effectively invisible bug, since any test
// that only asserts the surviving color class stays green. See
// src/lib/utils.test.ts and task-5's review findings (C1) for how this was
// caught: it silently broke every reward name's type size in that task despite
// a fully green suite.
//
// The fix registers the MD3 scale as an ADDITION to tailwind-merge's existing
// "font-size" group (not a new group), so it keeps that group's normal
// self-conflict behavior (two sizes still resolve to the last one) while
// permanently separating every MD3 size class from the "text-color" group.
const twMergeMd3 = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "display-l",
            "display-m",
            "display-s",
            "headline-l",
            "headline-m",
            "headline-s",
            "title-l",
            "title-m",
            "title-s",
            "body-l",
            "body-m",
            "body-s",
            "label-l",
            "label-m",
            "label-s",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMergeMd3(clsx(inputs));
}
