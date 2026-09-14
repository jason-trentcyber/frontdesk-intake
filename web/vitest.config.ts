import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ADR-0030: e2e/ is Playwright's testDir (its own runner, its own
    // CLI, `pnpm test:e2e`) - excluded here, on top of vitest's own
    // defaults, so vitest and Playwright never both try to collect the
    // same files.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
