// @vitest-environment node
//
// ===========================================================================
// THE FENCE AROUND THE REVIEW TREE.
//
// The plan names this as a risk in its own words: "`parse_meta` reaching a
// consumer surface. It is withheld by the column grant, but T4 introduces the
// first code that reads it. Keep it strictly inside the business portal tree."
//
// The database fence is real but incomplete. 0017 revoked the table-level
// SELECT on `receipts` from `authenticated` and re-granted 13 columns, so a
// consumer's own session genuinely cannot read `parse_meta`, `parse_confidence`,
// `match_confidence`, `reject_note`, `sha256` or `image_hash`. What that grant
// CANNOT stop is our own code reading those columns through the SERVICE ROLE
// and then handing them to a component that a consumer renders. Every module
// in this directory does exactly the first half of that sentence, which is why
// this test exists to forbid the second.
//
// The rule is a directory rule, deliberately, because a directory rule is one
// a reviewer can check by eye: only the business portal routes and this
// directory itself may import from the review tree.
// ===========================================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function posix(path: string): string {
  return relative(process.cwd(), path).split("\\").join("/");
}

const FILES = walk(SRC).map((full) => ({ path: posix(full), source: readFileSync(full, "utf8") }));

/** Every `from "..."` specifier in a file, imports and re-exports alike. */
function specifiers(source: string): string[] {
  return Array.from(source.matchAll(/from\s+["']([^"']+)["']/g)).map((match) => match[1] ?? "");
}

/**
 * The modules that hold, read or render the withheld columns:
 * everything in this directory, plus the review SERVICE, which is the only
 * other module that writes a decision.
 */
function isReviewTreeSpecifier(importer: string, specifier: string): boolean {
  if (specifier.startsWith("@/features/receipts/review")) return true;
  if (specifier === "@/features/receipts/server/review") return true;

  // Relative forms, resolved against the importing file's directory.
  if (specifier.startsWith(".")) {
    const importerDir = importer.slice(0, importer.lastIndexOf("/"));
    const resolved = posix(resolve(process.cwd(), importerDir, specifier));
    return (
      resolved.startsWith("src/features/receipts/review/") ||
      resolved === "src/features/receipts/server/review"
    );
  }
  return false;
}

/** Who is allowed to reach into the review tree at all. */
function isAllowedImporter(path: string): boolean {
  return (
    // The tree itself.
    path.startsWith("src/features/receipts/review/") ||
    // The business portal routes. This is the whole point of the tree.
    path.startsWith("src/app/(business)/") ||
    // The review service and its own suite.
    path === "src/features/receipts/server/review.ts" ||
    path === "src/features/receipts/server/review.test.ts"
  );
}

describe("the review tree stays inside the business portal", () => {
  const offenders = FILES.flatMap((file) =>
    specifiers(file.source)
      .filter((specifier) => isReviewTreeSpecifier(file.path, specifier))
      .filter(() => !isAllowedImporter(file.path))
      .map((specifier) => `${file.path} imports ${specifier}`),
  );

  it("is imported by nothing outside the business portal and the tree itself", () => {
    expect(offenders).toEqual([]);
  });

  it("is imported by no consumer route, no consumer component and no consumer feature component", () => {
    const consumerish = FILES.filter(
      (file) =>
        file.path.startsWith("src/app/(consumer)/") ||
        file.path.startsWith("src/app/(marketing)/") ||
        file.path.startsWith("src/components/consumer/") ||
        /^src\/features\/[^/]+\/components\//.test(file.path),
    );
    expect(consumerish.length).toBeGreaterThan(0);

    const leaks = consumerish.flatMap((file) =>
      specifiers(file.source)
        .filter((specifier) => isReviewTreeSpecifier(file.path, specifier))
        .map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(leaks).toEqual([]);
  });

  it("keeps the consumer API routes clear of it as well", () => {
    const apiRoutes = FILES.filter(
      (file) => file.path.startsWith("src/app/api/") && !file.path.includes(".test."),
    );
    const leaks = apiRoutes.flatMap((file) =>
      specifiers(file.source)
        .filter((specifier) => isReviewTreeSpecifier(file.path, specifier))
        .map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(leaks).toEqual([]);
  });
});

describe("the modules that touch the withheld columns are server-only", () => {
  const WITHHELD = [
    "parse_meta",
    "parse_confidence",
    "match_confidence",
    "reject_note",
    "sha256",
    "image_hash",
  ];

  /**
   * Code with the comments removed, so the prose that discusses these columns
   * all over this codebase does not read as a query. Comments are stripped
   * conservatively: block comments, and lines that are entirely a line
   * comment, which is how every explanatory note in this project is written.
   */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  }

  /** Every string and template literal in the code, which is where column names live. */
  function literals(code: string): string[] {
    return Array.from(code.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g)).map(
      (match) => match[0],
    );
  }

  it("names a withheld column in no module that can reach a browser bundle", () => {
    // The rule, stated as code: a withheld column name may appear in a STRING
    // LITERAL (which is what a PostgREST column list is) only in a module that
    // is fenced with `import "server-only"`. `image_hash_dup` and friends are
    // signal type names rather than columns, and the word boundary keeps them
    // out of this.
    const clientReachable = FILES.filter(
      (file) => !file.source.includes('import "server-only"') && !file.path.includes(".test."),
    );
    expect(clientReachable.length).toBeGreaterThan(0);

    const offenders = clientReachable.flatMap((file) => {
      const strings = literals(codeOnly(file.source)).join("\n");
      return WITHHELD.filter((column) =>
        new RegExp(`\\b${column}\\b`).test(strings),
      ).map((column) => `${file.path} names ${column} in a string literal`);
    });

    expect(offenders).toEqual([]);
  });

  it("marks every service-role reader as server-only", () => {
    const readers = FILES.filter(
      (file) =>
        file.path.startsWith("src/features/receipts/review/") &&
        !file.path.includes(".test.") &&
        file.source.includes("createServiceRoleClient"),
    );
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader.source, `${reader.path} must be server-only`).toContain(
        'import "server-only"',
      );
    }
  });
});
