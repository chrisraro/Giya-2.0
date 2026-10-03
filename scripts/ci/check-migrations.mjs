#!/usr/bin/env node
// Migration-safety gate for CI. Scans only migrations NEWER than 0082: older
// files are applied history (CLAUDE.md "never edit an applied migration") and
// 0075/0077 are deliberately neutralised data wipes, so flagging them would
// make the gate permanently red.
//
// Rules, each of which is a real incident class in this repo:
//   create-table-if-not-exists  silently no-ops against a drifted table, so the
//                               migration "succeeds" without the schema it claims
//   truncate / delete-from      a top-level data wipe runs on every environment
//                               the migration touches (0075/0077). Inside a
//                               function body it only runs when called, which is
//                               the purge-RPC design, so function bodies are fine.
//   lone-dollar-quote           a line that is just `as $` (instead of `as $$`)
//                               leaves the body unterminated and swallows the
//                               rest of the file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_CHECKED = 83; // migrations numbered > 0082

// Mask comments and string literals with spaces (keeping newlines) so the
// keyword scan cannot be fooled by prose like `-- delete from x` or 'truncate'.
// Dollar-quoted bodies are tracked here too: each masked char is annotated with
// whether it sits inside a non-DO dollar-quoted body.
function scan(sql) {
  const n = sql.length;
  const masked = new Array(n);
  const inBody = new Array(n).fill(false);
  let i = 0;
  let bodyTag = null; // current dollar-quote tag while inside one
  let bodyIsDo = false;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (bodyTag === null) {
      if (two === "--") {
        while (i < n && sql[i] !== "\n") masked[i++] = " ";
        continue;
      }
      if (two === "/*") {
        while (i < n && sql.slice(i, i + 2) !== "*/") masked[i] = sql[i++] === "\n" ? "\n" : " ";
        if (i < n) { masked[i++] = " "; masked[i++] = " "; }
        continue;
      }
      if (c === "'") {
        masked[i++] = " ";
        while (i < n) {
          if (sql[i] === "'" && sql[i + 1] === "'") { masked[i++] = " "; masked[i++] = " "; continue; }
          if (sql[i] === "'") { masked[i++] = " "; break; }
          masked[i] = sql[i] === "\n" ? "\n" : " ";
          i++;
        }
        continue;
      }
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const before = masked.slice(Math.max(0, i - 40), i).join("").trimEnd();
        bodyIsDo = /\bdo$/i.test(before);
        bodyTag = m[0];
        for (let k = 0; k < m[0].length; k++) masked[i + k] = " ";
        i += m[0].length;
        continue;
      }
      masked[i++] = c;
    } else {
      if (sql.startsWith(bodyTag, i)) {
        for (let k = 0; k < bodyTag.length; k++) masked[i + k] = " ";
        i += bodyTag.length;
        bodyTag = null;
        continue;
      }
      // A DO block runs at migration time, so it is NOT exempt.
      inBody[i] = !bodyIsDo;
      masked[i] = c;
      i++;
    }
  }
  return { masked: masked.join(""), inBody };
}

export function checkMigrationSql(file, sql) {
  const violations = [];
  const lineOf = (idx) => sql.slice(0, idx).split("\n").length;
  const add = (line, rule, message) => violations.push({ file, line, rule, message });

  const { masked, inBody } = scan(sql);

  for (const m of masked.matchAll(/\bcreate\s+table\s+if\s+not\s+exists\b/gi)) {
    add(lineOf(m.index), "create-table-if-not-exists", "`create table if not exists` hides schema drift; use `create table`");
  }
  for (const m of masked.matchAll(/\btruncate\b/gi)) {
    if (!inBody[m.index]) add(lineOf(m.index), "truncate", "top-level `truncate` wipes data on every environment");
  }
  for (const m of masked.matchAll(/\bdelete\s+from\b/gi)) {
    if (!inBody[m.index]) add(lineOf(m.index), "delete-from", "`delete from` outside a function body wipes data at migrate time");
  }

  // Raw-line check: `as $` alone on a line (optionally with trailing comment).
  sql.split("\n").forEach((text, idx) => {
    if (/^\s*as\s+\$\s*(--.*)?$/i.test(text)) {
      add(idx + 1, "lone-dollar-quote", "`as $` is not a dollar-quote opener; write `as $$`");
    }
  });

  return violations;
}

export function migrationNumber(name) {
  const m = /^(\d+)_/.exec(name);
  return m ? Number(m[1]) : null;
}

export function checkMigrationsDir(dir, firstChecked = FIRST_CHECKED) {
  const violations = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const num = migrationNumber(name);
    if (num === null || num < firstChecked) continue;
    violations.push(...checkMigrationSql(`supabase/migrations/${name}`, readFileSync(join(dir, name), "utf8")));
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? "supabase/migrations";
  const violations = checkMigrationsDir(dir);
  for (const v of violations) console.error(`${v.file}:${v.line}: [${v.rule}] ${v.message}`);
  if (violations.length > 0) {
    console.error(`\n${violations.length} migration safety violation(s).`);
    process.exit(1);
  }
  console.log("migration safety: ok");
}
