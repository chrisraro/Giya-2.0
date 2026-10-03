// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkMigrationSql, checkMigrationsDir, migrationNumber } from "./check-migrations.mjs";

const rules = (sql) => checkMigrationSql("m.sql", sql).map((v) => v.rule);

describe("checkMigrationSql", () => {
  it("passes a plain migration", () => {
    expect(rules("create table public.x (id uuid);\nalter table public.x enable row level security;")).toEqual([]);
  });

  it("flags create table if not exists with its line", () => {
    const v = checkMigrationSql("m.sql", "-- hi\nCREATE TABLE IF NOT EXISTS public.x (id int);");
    expect(v).toEqual([expect.objectContaining({ rule: "create-table-if-not-exists", line: 2 })]);
  });

  it("flags top-level truncate and delete from", () => {
    expect(rules("truncate public.a;\n\ndelete from public.b;")).toEqual(["truncate", "delete-from"]);
  });

  it("allows delete from and truncate inside a function body", () => {
    const sql = `create function public.purge() returns void language plpgsql as $$
begin
  delete from public.a;
  truncate public.b;
end;
$$;
create function public.f() returns void language plpgsql as $body$ begin delete from public.c; end $body$;`;
    expect(rules(sql)).toEqual([]);
  });

  it("flags a delete after a function body has closed", () => {
    const sql = "create function f() returns void as $$ begin null; end $$ language plpgsql;\ndelete from public.a;";
    expect(checkMigrationSql("m.sql", sql)).toEqual([expect.objectContaining({ rule: "delete-from", line: 2 })]);
  });

  it("does not exempt a DO block, which runs at migrate time", () => {
    expect(rules("do $$ begin delete from public.a; end $$;")).toEqual(["delete-from"]);
  });

  it("ignores keywords in comments and string literals", () => {
    const sql = "-- delete from x\n/* truncate y\n create table if not exists z */\ncomment on table t is 'delete from it; truncate';";
    expect(rules(sql)).toEqual([]);
  });

  it("flags a lone `as $` line", () => {
    const v = checkMigrationSql("m.sql", "create function f() returns int language sql\nas $\nselect 1;\n$;");
    expect(v).toEqual([expect.objectContaining({ rule: "lone-dollar-quote", line: 2 })]);
  });

  it("does not flag `as $$`", () => {
    expect(rules("create function f() returns int language sql\nas $$ select 1 $$;")).toEqual([]);
  });
});

describe("checkMigrationsDir", () => {
  it("parses migration numbers", () => {
    expect(migrationNumber("0083_x.sql")).toBe(83);
    expect(migrationNumber("README.md")).toBeNull();
  });

  it("scans only migrations newer than 0082 and reports file:line", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0082_old.sql"), "truncate public.a;");
    writeFileSync(join(dir, "0083_new.sql"), "select 1;\ntruncate public.a;");
    const v = checkMigrationsDir(dir);
    expect(v).toEqual([expect.objectContaining({ file: "supabase/migrations/0083_new.sql", line: 2, rule: "truncate" })]);
  });

  it("is clean on the real repo migrations", () => {
    expect(checkMigrationsDir("supabase/migrations")).toEqual([]);
  });
});
