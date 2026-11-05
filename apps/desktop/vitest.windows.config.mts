import { defineConfig } from "vitest/config";

/**
 * The Windows-only private-channel scenarios (`*.windows.test.ts`): a pipe name
 * squatted by another process, constrained PowerShell, a second local user. They
 * create accounts and spawn processes as them, so they run in the nightly
 * workflow (`windows-private-channels`) and by manual dispatch, not in every
 * PR's parallel suite (see the `exclude` in `vitest.config.mts`).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.windows.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    setupFiles: ["src/core/testing/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
