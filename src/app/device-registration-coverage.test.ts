import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// EVERY PLACE A SESSION IS ESTABLISHED REGISTERS A DEVICE, proved by scanning
// rather than by remembering.
//
// `public.user_devices` sat with no writer at all until T3.4b. The fix was three
// call sites - the password form on /login, the `data.session` branch of
// /signup, and the code exchange in /auth/callback - and a review re-derived
// that set independently and agreed it is complete FOR TODAY'S CODE.
//
// "Complete today" is the problem this file exists for. Nothing fails when a
// fourth auth surface lands: a magic-link page, an SSO callback, an invite
// acceptance that mints a session. The next person adding one will not have had
// this conversation, and the failure is silent - a consumer signs in, their
// device is never recorded, and /profile/devices quietly under-reports which
// browsers are on their account. That is a security-adjacent screen telling
// somebody less than the truth.
//
// So the rule is enforced structurally: any module under src/app that CALLS a
// session-establishing Supabase method must also reach a device-registration
// seam. Anything that legitimately should not is listed below WITH ITS REASON,
// which turns "we forgot" into "somebody wrote down why".
//
// THE SCAN IS AST-BASED, NOT TEXTUAL, and that is load-bearing: the string
// `verifyOtp` appears in a COMMENT in
// src/app/api/v1/auth/forgot-password/route.ts explaining which Supabase
// pattern the recovery email template must use. A grep-shaped version of this
// test would fail on prose.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const APP = join(SRC, "app");

/**
 * Supabase auth calls that leave the CALLER holding a session.
 *
 * `signInWithOAuth` is deliberately NOT here: it only redirects to the
 * provider, and the session it eventually produces is minted by
 * /auth/callback's `exchangeCodeForSession`, which is on the list and does
 * register. `resetPasswordForEmail`, `resend` and `updateUser` establish
 * nothing.
 */
const SESSION_ESTABLISHING = new Set([
  "signInWithPassword",
  "signInWithOtp",
  "signInWithIdToken",
  "signUp",
  "exchangeCodeForSession",
  "verifyOtp",
  "setSession",
]);

/** The two ways a module can reach the device writer. */
const REGISTRATION_SEAMS = new Set(["registerCurrentDevice", "registerDevice"]);

/**
 * Modules that establish a session and correctly register nothing. Every entry
 * is a claim somebody has to defend at review time, which is the point.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "app/auth/confirm/route.ts",
    // Handles ONLY `type=recovery` (it refuses signup/invite/magiclink by
    // design - see its header). The session it mints exists to reach
    // /reset-password, and reset-password/page.tsx calls signOut() on success,
    // so it never outlives the reset. Registering here would write a device row
    // for a browser that is about to be signed out.
    "recovery-only; /reset-password signs out afterwards so the session never persists",
  ],
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** Every identifier this module CALLS, from the AST - never from a comment. */
function calledNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
      else if (ts.isIdentifier(callee)) names.add(callee.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names;
}

interface Finding {
  file: string;
  established: string[];
  registers: boolean;
}

const FINDINGS: Finding[] = [];
for (const file of sourceFiles(APP)) {
  const called = calledNames(parse(file));
  const established = [...called].filter((name) => SESSION_ESTABLISHING.has(name)).sort();
  if (established.length === 0) continue;
  FINDINGS.push({
    file: relative(SRC, resolve(file)).replace(/\\/g, "/"),
    established,
    registers: [...called].some((name) => REGISTRATION_SEAMS.has(name)),
  });
}

describe("device registration coverage", () => {
  it("CRITICAL: every module that establishes a session also registers the device", () => {
    const missing = FINDINGS.filter(
      (finding) => !finding.registers && !EXEMPT.has(finding.file),
    ).map((finding) => `${finding.file} calls ${finding.established.join(", ")}`);

    expect(missing).toEqual([]);
  });

  it("finds the session-establishing modules at all, so an empty scan cannot pass", () => {
    // Without this, a broken walker or a renamed method silently turns the
    // assertion above into `expect([]).toEqual([])`.
    expect(FINDINGS.length).toBeGreaterThanOrEqual(4);
    const scanned = FINDINGS.map((finding) => finding.file);
    expect(scanned).toContain("app/(auth)/login/page.tsx");
    expect(scanned).toContain("app/(auth)/signup/page.tsx");
    expect(scanned).toContain("app/auth/callback/route.ts");
    expect(scanned).toContain("app/auth/confirm/route.ts");
  });

  it("reads calls from the AST, not from prose", () => {
    // `verifyOtp` appears in a comment in the forgot-password route, describing
    // the email-template pattern /auth/confirm implements. A textual scan would
    // flag it and somebody would "fix" it by registering a device on a route
    // that mints no session.
    const forgot = FINDINGS.find((finding) => finding.file.includes("forgot-password"));
    expect(forgot).toBeUndefined();
  });

  it("keeps every exemption pointed at a module that still exists and still needs one", () => {
    // An exemption for a file that no longer establishes a session is dead
    // permission, and dead permission is how the next one gets waved through.
    for (const [file, reason] of EXEMPT) {
      expect(reason.length).toBeGreaterThan(20);
      expect(FINDINGS.map((finding) => finding.file)).toContain(file);
    }
  });
});
