import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Service worker build output: @serwist/next compiles src/app/sw.ts into
    // public/ on every build. It is minified third-party-shaped code we did not
    // write and cannot fix, and linting it buries real findings under ~90
    // warnings about a bundler's output. The SOURCE, src/app/sw.ts, is linted.
    "public/sw.js",
    "public/sw.js.map",
    "public/swe-worker-*.js",
    "public/swe-worker-*.js.map",
    // Agent worktrees are full checkouts of this repo living INSIDE it, so a
    // bare `eslint .` descends into every one of them and lints the whole
    // codebase again per worktree - ~20k problems while `eslint src scripts`
    // reports 71. That made the lint gate unreadable and cost a task's review
    // an incorrect baseline: the brief claimed "clean apart from one warning"
    // and the implementer had to establish the real number themselves.
    //
    // vitest.config.ts carries the identical exclusion for the identical
    // reason - without it a 3,936-test suite reported 7,840, globbing main
    // plus every live worktree. Any tool that walks the tree from the repo
    // root needs this; if you add one, add the exclusion with it.
    ".claude/worktrees/**",
  ]),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
          message:
            "Raw hex colors are banned in src/. Use MD3 tokens (docs/10-architecture/16-design-system.md).",
        },
        {
          selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{6}\\b/]",
          message:
            "Raw hex colors are banned in src/. Use MD3 tokens (docs/10-architecture/16-design-system.md).",
        },
      ],
    },
  },
]);

export default eslintConfig;
