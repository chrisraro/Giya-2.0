// @vitest-environment node
//
// ===========================================================================
// THE FENCE AROUND THE ADMIN TREE.
//
// The mirror of `features/receipts/review/isolation.test.ts`, and it exists
// because of a specific consequence of this slice: that file's allowlist was
// WIDENED to let the admin portal reuse doc 37's evidence renderer. Widening a
// fence is only safe if the thing let through carries its own, and this is it.
//
// What is behind this fence is strictly more dangerous than what is behind the
// review one. The review tree holds one tenant's withheld columns. This tree
// holds:
//
//   * service-role reads with NO tenancy predicate at all - every business's
//     receipts, every consumer's platform-wide standing, every fraud signal;
//   * the cross-tenant duplicate resolution the business queue is forbidden
//     from doing, including the other tenant's name and the other account's
//     name;
//   * the consequences ladder: cooldown, suspension and a ledger clawback.
//
// Doc 37's philosophy is unambiguous about the audience: "fraud internals are
// never exposed to the submitter", and 0017 keeps `fraud_signals` invisible to
// consumers for exactly that reason. So the rule is a directory rule, the same
// kind the review tree uses, because it is one a reviewer can check by eye:
// only the admin routes and this directory may import from here.
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

function isAdminTreeSpecifier(importer: string, specifier: string): boolean {
  if (specifier.startsWith("@/features/admin")) return true;
  if (specifier.startsWith("@/components/admin")) return true;

  if (specifier.startsWith(".")) {
    const importerDir = importer.slice(0, importer.lastIndexOf("/"));
    const resolved = posix(resolve(process.cwd(), importerDir, specifier));
    return (
      resolved.startsWith("src/features/admin/") || resolved.startsWith("src/components/admin/")
    );
  }
  return false;
}

function isAllowedImporter(path: string): boolean {
  return (
    path.startsWith("src/features/admin/") ||
    path.startsWith("src/components/admin/") ||
    path.startsWith("src/app/(admin)/")
  );
}

describe("the admin tree stays inside the admin portal", () => {
  it("is imported by nothing outside the admin routes and the tree itself", () => {
    const offenders = FILES.flatMap((file) =>
      specifiers(file.source)
        .filter((specifier) => isAdminTreeSpecifier(file.path, specifier))
        .filter(() => !isAllowedImporter(file.path))
        .map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("is imported by no consumer route, no marketing route and no consumer component", () => {
    const consumerish = FILES.filter(
      (file) =>
        file.path.startsWith("src/app/(consumer)/") ||
        file.path.startsWith("src/app/(marketing)/") ||
        file.path.startsWith("src/components/consumer/"),
    );
    expect(consumerish.length).toBeGreaterThan(0);

    const leaks = consumerish.flatMap((file) =>
      specifiers(file.source)
        .filter((specifier) => isAdminTreeSpecifier(file.path, specifier))
        .map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(leaks).toEqual([]);
  });

  it("is imported by no business portal route either", () => {
    // Not a consumer concern, a tenancy one: everything in this tree reads
    // across tenants, so a business surface pulling any of it in would be a
    // cross-tenant leak with no policy standing behind it.
    const businessFiles = FILES.filter((file) => file.path.startsWith("src/app/(business)/"));
    expect(businessFiles.length).toBeGreaterThan(0);

    const leaks = businessFiles.flatMap((file) =>
      specifiers(file.source)
        .filter((specifier) => isAdminTreeSpecifier(file.path, specifier))
        .map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(leaks).toEqual([]);
  });

  it("keeps every API route clear of it", () => {
    const apiRoutes = FILES.filter(
      (file) => file.path.startsWith("src/app/api/") && !file.path.includes(".test."),
    );
    const leaks = apiRoutes.flatMap((file) =>
      specifiers(file.source)
        .filter((specifier) => isAdminTreeSpecifier(file.path, specifier))
        .map((specifier) => `${file.path} imports ${specifier}`),
    );
    expect(leaks).toEqual([]);
  });
});

describe("the cross-tenant readers are server-only", () => {
  it("marks every module that builds a service-role client as server-only", () => {
    const readers = FILES.filter(
      (file) =>
        file.path.startsWith("src/features/admin/") &&
        !file.path.includes(".test.") &&
        file.source.includes("createServiceRoleClient"),
    );
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader.source, `${reader.path} must be server-only`).toContain('import "server-only"');
    }
  });

  it("keeps the session gate server-only too", () => {
    // `resolveAdminContext` is the ONLY fence on every read in this tree. A
    // client-importable copy of it would be a client-importable claim about who
    // is an admin.
    const access = FILES.find((file) => file.path === "src/features/admin/access.ts");
    expect(access?.source).toContain('import "server-only"');
  });
});

describe("the consumer copy matrix is untouched by this slice", () => {
  it("names no fraud signal type in any consumer surface", () => {
    // Doc 37: "fraud internals are never exposed to the submitter". The signal
    // vocabulary is the most direct form of that exposure - knowing which
    // detector tripped is the recipe for evading it - so no consumer-facing
    // module may name one, whether it got there through this slice or any
    // other.
    const SIGNALS = [
      "image_hash_dup",
      "ocr_similarity_dup",
      "receipt_number_dup",
      "timestamp_anomaly",
      "gps_mismatch",
      "amount_anomaly",
      "ai_confidence_low",
      "staff_self_scan",
    ];

    const consumerish = FILES.filter(
      (file) =>
        !file.path.includes(".test.") &&
        (file.path.startsWith("src/app/(consumer)/") ||
          file.path.startsWith("src/app/(marketing)/") ||
          file.path.startsWith("src/components/consumer/")),
    );
    expect(consumerish.length).toBeGreaterThan(0);

    const offenders = consumerish.flatMap((file) =>
      SIGNALS.filter((signal) => file.source.includes(signal)).map(
        (signal) => `${file.path} names ${signal}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
