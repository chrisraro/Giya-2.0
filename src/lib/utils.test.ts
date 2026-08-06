import { describe, expect, it } from "vitest";

import { cn } from "./utils";

// ===========================================================================
// Controller-verified regression (task-5 review, C1): tailwind-merge does not
// know about this repo's MD3 type-scale utilities (`text-title-s` etc, defined
// as custom `@utility` rules in globals.css, not Tailwind's own `text-xs..9xl`
// scale). Left unregistered, tailwind-merge falls back to treating them as
// unrecognized `text-*` classes, which lands them in the same permissive
// "text-color" conflict group as `text-on-surface` - so composing a type-scale
// class with a color class through `cn()` silently deleted the SIZE class and
// kept only the color. This is invisible to any test that only asserts the
// surviving color class, which is exactly how it shipped unnoticed in task 5:
// every reward name lost `text-title-s`/`text-title-m` and every assertion
// still passed because it only checked the color class.
// ===========================================================================

describe("cn", () => {
  it("keeps an MD3 type-scale class when a color class follows it", () => {
    expect(cn("text-title-s", "text-on-surface")).toBe("text-title-s text-on-surface");
    expect(cn("text-title-m", "text-on-surface")).toBe("text-title-m text-on-surface");
    expect(cn("text-body-s", "text-on-surface-variant")).toBe("text-body-s text-on-surface-variant");
    expect(cn("text-label-s", "text-on-surface-variant", "mt-2")).toBe(
      "text-label-s text-on-surface-variant mt-2",
    );
  });

  it("keeps an MD3 type-scale class when a color class precedes it", () => {
    expect(cn("text-on-surface", "text-title-s")).toBe("text-on-surface text-title-s");
  });

  it("still resolves a conflict between two MD3 type-scale classes to the later one", () => {
    // The whole point of a "font-size" class GROUP is that same-group classes
    // still conflict; only cross-group (size vs color) conflicts were the bug.
    expect(cn("text-title-s", "text-title-m")).toBe("text-title-m");
    expect(cn("text-label-l", "text-label-s")).toBe("text-label-s");
  });

  it("still resolves a conflict between two color classes to the later one", () => {
    expect(cn("text-on-surface", "text-on-surface-variant")).toBe("text-on-surface-variant");
  });

  it("covers every MD3 scale step, not just the ones this task happened to use", () => {
    const scale = [
      "display-l", "display-m", "display-s",
      "headline-l", "headline-m", "headline-s",
      "title-l", "title-m", "title-s",
      "body-l", "body-m", "body-s",
      "label-l", "label-m", "label-s",
    ];
    for (const step of scale) {
      expect(cn(`text-${step}`, "text-on-surface")).toBe(`text-${step} text-on-surface`);
    }
  });
});
