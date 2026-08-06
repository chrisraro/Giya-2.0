import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    passWithNoTests: true,
    // Vitest's default exclude covers node_modules/dist/.git but NOT .claude,
    // and agent worktrees are checked out under .claude/worktrees/. Without
    // this the runner globs the main checkout AND every live worktree, so the
    // suite silently reports ~2x its real size and a worktree's in-progress
    // failures surface as failures of main. Observed for real: a 3936-test
    // suite reported 7840.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.claude/worktrees/**",
    ],
  },
});
