import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

// EVERY LOGOUT GOES THROUGH THE PURGE (doc 41 preamble rule 2).
//
// `LogoutForm` posts PURGE_USER_CACHES and then calls the `signOut` server
// action. That only protects the surfaces that USE it, and this repo has three
// logout buttons in three places written months apart. A fourth added later
// with a plain `<form action={signOut}>` would compile, pass review, look
// identical, and quietly reopen the exposure on that screen.
//
// So the assertion is a SET EQUALITY over who imports the action, not a
// per-file spot check and not a "nobody does the bad thing" scan. A negative
// scan cannot tell "the bad thing is absent" from "everything is absent"; this
// one fails if a new importer appears AND fails if the expected importer
// disappears, so neither direction can pass vacuously.

const SRC = join(process.cwd(), "src");

/** The module that owns the action. Not a caller of it. */
const ACTIONS_MODULE = join("src", "features", "identity", "actions.ts");

/**
 * The ONLY module allowed to call the sign-out action.
 *
 * Adding a path here is a decision that a logout on that screen may leave the
 * previous consumer's `giya-pages-*` documents behind. Wrapping the control in
 * `LogoutForm` costs one import and does not.
 */
const ALLOWED_IMPORTERS = [join("src", "components", "pwa", "logout-form.tsx")];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

/** `import { ..., signOut, ... } from "<anything ending in identity/actions>"`. */
const SIGN_OUT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"([^"]*identity\/actions|\.\.\/actions)"/g;

function importsSignOut(source: string): boolean {
  // Comments stripped first: this file's neighbours discuss `signOut` at length
  // in prose, and one of them quotes an import line.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const match of code.matchAll(SIGN_OUT_IMPORT)) {
    const named = (match[1] ?? "").split(",").map((name) => name.trim());
    if (named.includes("signOut")) return true;
  }
  return false;
}

describe("logout purge coverage (doc 41 preamble rule 2)", () => {
  it("CRITICAL: LogoutForm is the only caller of the sign-out action", () => {
    const importers = sourceFiles(SRC)
      .filter((path) => relative(process.cwd(), path) !== ACTIONS_MODULE)
      .filter((path) => importsSignOut(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path))
      .sort();

    expect(importers).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it("and that caller really posts the purge before it signs out", () => {
    // The set-equality above is only worth anything if the one allowed importer
    // does the thing. Its behaviour - ordering, and surviving a browser with no
    // worker - is asserted by execution in
    // src/components/pwa/logout-form.test.tsx; this is the link between the two
    // files, so a LogoutForm gutted down to a bare <form action={signOut}> is a
    // failure in both places rather than a silent pass here.
    const source = readFileSync(join(process.cwd(), ...ALLOWED_IMPORTERS[0]!.split(sep)), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toContain("postUserCachePurge(");
    expect(code).toContain("await signOut();");
  });
});
