#!/usr/bin/env node
// `npm run ci`: the same gates .github/workflows/ci.yml runs, in the same order
// (minus `npm ci`). Kept as one node script rather than an `&&` chain in
// package.json so it behaves the same under cmd.exe and bash.
import { execFileSync, spawnSync } from "node:child_process";

// Placeholders so `next build` can collect page data without real credentials.
// Obviously fake on purpose: nothing here may ever reach a real service.
export const BUILD_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "ci-placeholder-anon-key-not-a-real-secret-0000",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "ci-placeholder-upstash-token-not-real-0000",
  REDEMPTION_TOKEN_SECRET: "ci-placeholder-redemption-secret-not-real-000000000000",
};

function sh(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  return r.status === 0;
}

function grantsBase() {
  if (process.env.GRANTS_BASE) return process.env.GRANTS_BASE;
  for (const ref of ["origin/main", "main"]) {
    try {
      return execFileSync("git", ["merge-base", "HEAD", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // try the next ref
    }
  }
  return null;
}

const steps = [
  ["typecheck", () => sh("npx", ["tsc", "--noEmit"])],
  ["lint (errors block, warnings do not)", () => sh("npx", ["eslint", "src", "scripts"])],
  ["unit tests", () => sh("npx", ["vitest", "run"])],
  ["migration safety", () => sh("node", ["scripts/ci/check-migrations.mjs"])],
  [
    "grants gate",
    () => {
      const base = grantsBase();
      if (!base) {
        console.log("no main ref to diff against; skipping grants gate");
        return true;
      }
      return sh("bash", ["scripts/sdd/check-grants.sh", base]);
    },
  ],
  ["build", () => sh("npm", ["run", "build"], BUILD_ENV)],
];

for (const [name, run] of steps) {
  console.log(`\n=== ci: ${name} ===`);
  if (!run()) {
    console.error(`\nci FAILED at: ${name}`);
    process.exit(1);
  }
}
console.log("\nci: all steps passed");
