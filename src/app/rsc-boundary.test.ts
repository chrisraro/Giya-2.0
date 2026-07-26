import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// THE SERVER/CLIENT BOUNDARY, proved rather than remembered.
//
// This test exists because of a production 500 on /notifications. The page is a
// server component and it rendered this:
//
//   <FormPending>{(pending) => <button disabled={pending}>Mark all read</button>}</FormPending>
//
// FormPending lived in a `"use client"` module, so that arrow function was a
// FUNCTION passed from a server component to a client component. React's Flight
// serializer cannot encode a function, and says so at render time:
//
//   Error: Functions cannot be passed directly to Client Components unless you
//   explicitly expose it by marking it with "use server". Or maybe you meant to
//   call this function rather than return it.
//     {children: function children}
//                ^^^^^^^^^^^^^^^^^
//       at stringify (<anonymous>)
//
// The properties that made this expensive to find are all worth stating,
// because they are the properties this test is built to defeat:
//
//   * IT BUILDS. `next build` type-checks and bundles it happily. The failure
//     is a runtime property of the RSC payload, not of the module graph.
//   * IT PASSES UNIT TESTS. In jsdom every component is just a function and a
//     render prop is just a call, so a component test of the same tree is
//     green. There is no boundary in a jsdom render to violate.
//   * IT IS CONDITIONAL. The button only renders when `unread > 0`, so the
//     inbox worked for everyone with nothing unread and 500'd for everyone with
//     something - which is to say, for the people the inbox is for.
//
// So the honest place to prove it is the SOURCE, and the property to prove is
// structural:
//
//   NO SERVER COMPONENT PASSES A FUNCTION TO A CLIENT COMPONENT.
//
// What counts as a violation is narrow on purpose. A function VALUE arriving
// from elsewhere may well be a Server Action, which is exactly what a server
// component is supposed to hand a client component, and this test must not
// flag those - `<form action={markAllNotificationsReadAction}>` is correct and
// stays correct. What is flagged is a function this file wrote and handed over:
// an inline arrow or `function` expression, or an identifier bound to one in
// the same module. Neither of those can be a server reference, so neither can
// ever be serialized.
//
// Test files are excluded. They render in jsdom, where there is no boundary,
// and passing `onClose={vi.fn()}` to a client component in a test is the point.

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
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

/** The `"use client"` / `"use server"` directive at the top of a module, if any. */
function directiveOf(source: ts.SourceFile): string | null {
  const first = source.statements[0];
  if (first === undefined) return null;
  if (!ts.isExpressionStatement(first)) return null;
  if (!ts.isStringLiteral(first.expression)) return null;
  return first.expression.text;
}

/** Resolve an import specifier the way tsconfig's `@/*` -> `src/*` alias does. */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;

  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

const FILES = sourceFiles(SRC);

/** Every module's directive, keyed by absolute path, parsed once. */
const PARSED = new Map<string, ts.SourceFile>();
const DIRECTIVE = new Map<string, string | null>();
for (const file of FILES) {
  const source = parse(file);
  PARSED.set(resolve(file), source);
  DIRECTIVE.set(resolve(file), directiveOf(source));
}

interface Violation {
  file: string;
  line: number;
  component: string;
  prop: string;
}

function isFunctionLiteral(node: ts.Node | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** Names bound to a function literal in this module: `const f = () => ...`,
 * `function f() {}`. An identifier resolving to one of these is a local
 * function and can never be a server reference. */
function localFunctionNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isFunctionLiteral(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function violationsIn(file: string): Violation[] {
  const abs = resolve(file);
  const source = PARSED.get(abs);
  if (source === undefined) return [];
  // A `"use client"` module is on the client side of the boundary already;
  // handing a callback to another client component there is ordinary React.
  if (DIRECTIVE.get(abs) === "use client") return [];

  const clientComponents = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveImport(abs, statement.moduleSpecifier.text);
    if (target === null || DIRECTIVE.get(target) !== "use client") continue;

    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name) clientComponents.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) clientComponents.add(element.name.text);
    }
  }
  if (clientComponents.size === 0) return [];

  const locals = localFunctionNames(source);
  const found: Violation[] = [];

  /** An expression this module authored as a function, as opposed to one it
   * merely received (which may legitimately be a Server Action). */
  const isOwnFunction = (node: ts.Expression | undefined): boolean => {
    if (node === undefined) return false;
    if (isFunctionLiteral(node)) return true;
    return ts.isIdentifier(node) && locals.has(node.text);
  };

  const record = (node: ts.Node, component: string, prop: string): void => {
    found.push({
      file: relative(ROOT, file).replaceAll("\\", "/"),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      component,
      prop,
    });
  };

  const check = (
    tagName: ts.JsxTagNameExpression,
    attributes: ts.JsxAttributes,
    children: readonly ts.JsxChild[],
  ): void => {
    // `Foo.Bar` is namespaced off the same import, so the root name decides.
    const tag = tagName.getText(source).split(".")[0] ?? "";
    if (!clientComponents.has(tag)) return;

    for (const attribute of attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;
      const initializer = attribute.initializer;
      if (
        initializer &&
        ts.isJsxExpression(initializer) &&
        isOwnFunction(initializer.expression)
      ) {
        record(attribute, tag, attribute.name.getText(source));
      }
    }

    for (const child of children) {
      if (ts.isJsxExpression(child) && isOwnFunction(child.expression)) {
        record(child, tag, "children");
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      check(
        node.openingElement.tagName,
        node.openingElement.attributes,
        node.children,
      );
    } else if (ts.isJsxSelfClosingElement(node)) {
      check(node.tagName, node.attributes, []);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return found;
}

describe("server/client boundary", () => {
  it("finds source to check", () => {
    // A resolution or glob regression must fail loudly rather than pass by
    // checking nothing.
    expect(FILES.length).toBeGreaterThan(100);
    expect([...DIRECTIVE.values()].filter((d) => d === "use client").length).toBeGreaterThan(10);
  });

  it("resolves the notifications page's client imports", () => {
    // The specific file the outage was on, named so a refactor that moves it
    // cannot silently drop it out of the sweep.
    const page = join(SRC, "app/(consumer)/notifications/page.tsx");
    expect(existsSync(page)).toBe(true);
    expect(DIRECTIVE.get(resolve(page))).not.toBe("use client");

    const markAllRead = join(
      SRC,
      "features/notifications/components/mark-all-read-button.tsx",
    );
    expect(existsSync(markAllRead)).toBe(true);
    // The pending state is read by the client component itself, which is the
    // only shape that works. If this stops being a client module the button
    // cannot call useFormStatus at all.
    expect(DIRECTIVE.get(resolve(markAllRead))).toBe("use client");
  });

  it("passes no function from a server component to a client component", () => {
    const violations = FILES.flatMap(violationsIn);

    // Reported as the whole list rather than one at a time: the message is the
    // fix instructions, and seeing every site at once is what makes it cheap.
    expect(
      violations.map((v) => `${v.file}:${v.line} <${v.component} ${v.prop}={...}>`),
    ).toEqual([]);
  });

  it("catches the exact shape the outage had", () => {
    // Proves the check above is load-bearing rather than vacuously green: the
    // /notifications page before the fix, reduced to its essentials.
    const regressionFile = join(SRC, "app/(consumer)/notifications/page.tsx");
    const before = `
import { FormPending } from "@/components/ui/pending-button";

export default function Page() {
  return (
    <form>
      <FormPending>{(pending) => <button disabled={pending}>Mark all read</button>}</FormPending>
    </form>
  );
}
`;
    const source = ts.createSourceFile(
      regressionFile,
      before,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    // Stand the synthetic module in for the real one, then check it the same
    // way every real file is checked. `pending-button.tsx` is still a
    // `"use client"` module, so the import resolves exactly as it did.
    const previous = PARSED.get(resolve(regressionFile));
    PARSED.set(resolve(regressionFile), source);
    try {
      const violations = violationsIn(regressionFile);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.component).toBe("FormPending");
      expect(violations[0]?.prop).toBe("children");
    } finally {
      if (previous !== undefined) PARSED.set(resolve(regressionFile), previous);
    }
  });
});
