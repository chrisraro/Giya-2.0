#!/usr/bin/env node
// =============================================================================
// A mutant runner that refuses to lie about a survivor.
// =============================================================================
//
// Usage:
//   node scripts/sdd/mutants.mjs scripts/sdd/mutants/t7-5.json [--only <name>]
//
// A mutant test is only evidence if the edit landed where it was aimed. On a
// recent task in this repo three mutants "survived" - and the summary line was
// indistinguishable from a real survivor - because a single-occurrence
// find-and-replace matched a DIFFERENT function that happened to share the
// snippet. A misfire and a survivor look identical unless the runner refuses to
// confuse them, so this one does:
//
//   1. THE ANCHOR MUST OCCUR EXACTLY ONCE in the target file. Zero occurrences
//      (the code moved) and two or more (the anchor is ambiguous) are both a
//      MISFIRE, and a MISFIRE ABORTS THE WHOLE RUN with a non-zero exit rather
//      than being reported as any kind of result. There is no flag to override
//      this.
//   2. THE BASELINE MUST BE GREEN. The named tests are run unmutated first. A
//      mutant "killed" by a test that was already failing proves nothing.
//   3. THE REPLACEMENT MUST CHANGE THE FILE. An edit that produces identical
//      bytes is a MISFIRE too - it would report every assertion as surviving.
//   4. THE FILE MUST BE RESTORED BYTE-FOR-BYTE, verified after every mutant and
//      again at exit. If a restore ever fails the run stops immediately and
//      says so, because a half-restored source file is worse than no run.
//
// Exit code is 0 only when every mutant was KILLED.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

const args = process.argv.slice(2);
const manifestPath = args.find((arg) => !arg.startsWith("--"));
const onlyIndex = args.indexOf("--only");
const only = onlyIndex === -1 ? null : args[onlyIndex + 1];

if (!manifestPath) {
  console.error("usage: node scripts/sdd/mutants.mjs <manifest.json> [--only <name>]");
  process.exit(2);
}

/** @type {{ mutants: Array<{name: string, file: string, anchor: string, replacement: string, tests: string[], kills: string}> }} */
const manifest = JSON.parse(readFileSync(path.resolve(ROOT, manifestPath), "utf8"));

const selected = only ? manifest.mutants.filter((m) => m.name === only) : manifest.mutants;
if (selected.length === 0) {
  console.error(`no mutant matched ${only ?? "(all)"}`);
  process.exit(2);
}

function abort(message) {
  console.error(`\nMISFIRE - ABORTING RUN\n  ${message}\n`);
  process.exit(2);
}

/**
 * A manifest is written with "\n", but this repo checks tracked files out with
 * CRLF on Windows, so a multi-line anchor matches zero times for a reason that
 * has nothing to do with the code. Normalizing to the FILE's own dominant
 * ending fixes that without weakening anything: the exactly-once rule below
 * still runs, on the normalized form.
 */
function toFileEol(text, source) {
  return source.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
}

function runTests(tests) {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", "--reporter=dot", ...tests],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" },
  );
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// ---- pre-flight: every file readable, every anchor unique, baseline green ----

const originals = new Map();
const testSets = new Set();

for (const mutant of selected) {
  const abs = path.resolve(ROOT, mutant.file);
  if (!originals.has(abs)) {
    originals.set(abs, readFileSync(abs, "utf8"));
  }
  const source = originals.get(abs);
  mutant.anchor = toFileEol(mutant.anchor, source);
  mutant.replacement = toFileEol(mutant.replacement, source);

  const occurrences = source.split(mutant.anchor).length - 1;
  if (occurrences !== 1) {
    abort(
      `${mutant.name}: anchor occurs ${occurrences} time(s) in ${mutant.file}, expected exactly 1.\n` +
        `  anchor: ${JSON.stringify(mutant.anchor)}`,
    );
  }
  if (mutant.anchor === mutant.replacement) {
    abort(`${mutant.name}: replacement is identical to the anchor, so nothing would change.`);
  }
  testSets.add(JSON.stringify(mutant.tests));
}

console.log(`pre-flight: ${selected.length} mutant(s), every anchor unique.`);

for (const encoded of testSets) {
  const tests = JSON.parse(encoded);
  const baseline = runTests(tests);
  if (baseline.code !== 0) {
    abort(`baseline is RED for ${tests.join(" ")} - a kill would prove nothing.\n${baseline.output}`);
  }
  console.log(`pre-flight: baseline green for ${tests.join(" ")}`);
}

// ---- the run -----------------------------------------------------------------

const results = [];

for (const mutant of selected) {
  const abs = path.resolve(ROOT, mutant.file);
  const original = originals.get(abs);
  const mutated = original.replace(mutant.anchor, mutant.replacement);

  if (mutated === original) {
    abort(`${mutant.name}: applying the replacement produced identical bytes.`);
  }

  writeFileSync(abs, mutated, "utf8");
  let outcome;
  try {
    const run = runTests(mutant.tests);
    outcome = run.code === 0 ? "SURVIVED" : "KILLED";
  } finally {
    writeFileSync(abs, original, "utf8");
    if (readFileSync(abs, "utf8") !== original) {
      abort(`${mutant.name}: ${mutant.file} could not be restored. STOP AND CHECK GIT.`);
    }
  }

  results.push({ name: mutant.name, outcome, kills: mutant.kills });
  console.log(`${outcome === "KILLED" ? "KILLED  " : "SURVIVED"} ${mutant.name} - ${mutant.kills}`);
}

// ---- final restore check -----------------------------------------------------

for (const [abs, original] of originals) {
  if (readFileSync(abs, "utf8") !== original) {
    abort(`${abs} is not byte-identical to its pre-run content. STOP AND CHECK GIT.`);
  }
}

const survivors = results.filter((r) => r.outcome === "SURVIVED");
console.log(
  `\n${results.length - survivors.length}/${results.length} killed, ${survivors.length} survived.`,
);
process.exit(survivors.length === 0 ? 0 : 1);
