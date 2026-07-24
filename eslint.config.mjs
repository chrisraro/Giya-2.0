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
