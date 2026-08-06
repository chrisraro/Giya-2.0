// @vitest-environment node
//
// B1 (review fix): EXPECTED_JOBS (src/lib/alerts/job-health.ts) is a
// hardcoded list, and a hardcoded list rots the day a migration schedules a
// new job and nobody remembers to add it here too - silently narrowing the
// I5 "did a job stop being scheduled" check to miss the newest job entirely.
// This test greps every migration THIS WORKTREE HAS for `cron.schedule('
// name', ...)` calls and asserts every name found is a member of
// EXPECTED_JOBS.
//
// Deliberately a SUBSET check, not full set equality: this worktree does not
// contain every migration applied to the shared live project (task 2.2's
// `integrity.balance_check` work landed as 0056-0058 in a separate,
// concurrent worktree - see supabase/README.md's "Migration ledger" notes on
// why those three files are not present here). A full equality assertion
// would fail today for a reason that has nothing to do with EXPECTED_JOBS
// being wrong. The subset direction still catches the regression this test
// exists for: a NEW cron.schedule call landing in THIS branch's own
// migrations without a matching EXPECTED_JOBS entry.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import { EXPECTED_JOBS } from "./job-health";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** Every jobname passed as `cron.schedule('name', ...)`'s first argument,
 * across every .sql file this worktree has. Matches the exact call shape
 * every migration in this codebase uses (0028, 0043, 0044, 0053): the name
 * as a single-quoted string immediately following `cron.schedule(`,
 * possibly across a line break. */
function jobNamesScheduledInMigrations(): string[] {
  const names = new Set<string>();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  for (const file of files) {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const pattern = /cron\.schedule\(\s*'([a-zA-Z0-9_.]+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }

  return Array.from(names).sort();
}

describe("EXPECTED_JOBS stays in sync with the migrations this worktree has", () => {
  it("every job scheduled by a local migration is listed in EXPECTED_JOBS", () => {
    const scheduled = jobNamesScheduledInMigrations();

    // A real signal that the scan itself is working, not a vacuous pass: if
    // this ever reads zero, the regex or the migrations directory broke,
    // not that nothing is scheduled.
    expect(scheduled.length).toBeGreaterThan(0);

    const missing = scheduled.filter((name) => !EXPECTED_JOBS.includes(name));
    expect(missing).toEqual([]);
  });
});
