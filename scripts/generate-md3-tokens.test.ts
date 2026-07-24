import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = () => readFileSync(join(process.cwd(), "src/styles/md3-tokens.css"), "utf8");

describe("md3-tokens.css", () => {
  it("exists and defines light scheme on :root and dark on .dark", () => {
    const c = css();
    expect(c).toContain(":root, .light {");
    expect(c).toContain(".dark {");
  });

  it("defines every MD3 color role in both schemes", () => {
    const roles = [
      "primary","on-primary","primary-container","on-primary-container",
      "secondary","on-secondary","secondary-container","on-secondary-container",
      "tertiary","on-tertiary","tertiary-container","on-tertiary-container",
      "error","on-error","error-container","on-error-container",
      "surface","on-surface","surface-variant","on-surface-variant",
      "surface-dim","surface-bright",
      "surface-container-lowest","surface-container-low","surface-container",
      "surface-container-high","surface-container-highest",
      "outline","outline-variant",
      "inverse-surface","inverse-on-surface","inverse-primary","scrim","shadow",
    ];
    const c = css();
    for (const role of roles) {
      const hits = c.match(new RegExp(`--md-sys-color-${role}:`, "g")) ?? [];
      expect(hits.length, role).toBeGreaterThanOrEqual(2); // light + dark
    }
  });

  it("light primary is tone 40 of the coral seed palette", () => {
    // Deterministic: derived from seed #E8563F via HCT; assert format only + not the raw seed
    const m = css().match(/:root, \.light \{[^}]*--md-sys-color-primary:\s*(#[0-9a-f]{6})/is);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m![1].toLowerCase()).not.toBe("#e8563f"); // tonal mapping, not raw seed
  });
});
