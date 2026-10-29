import { defineConfig } from "vitest/config";

/**
 * The shell's own unit tests. Everything under `src/` runs here; the build
 * scripts keep their `node:test` suites (`scripts/*.test.mjs`), which the
 * package's `test` script runs after this one.
 *
 * `pool: "forks"` because several tests spawn real child processes and signal
 * them — the assertions about SIGTERM, reaping and stdout draining are only
 * worth anything against a real OS process.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/out/**",
      // The one test that launches a real Chromium runs on its own afterwards
      // (`vitest.live.config.mts`): under two hundred parallel workers the
      // browser's start-up outran its budget often enough to be a flake, and a
      // flake teaches people to ignore the only test that proves the pipe
      // protocol against the real thing.
      "**/*live.integration.test.ts",
    ],
    environment: "node",
    pool: "forks",
    // Each file's `tempDir()` directories are removed after it (and any tmux
    // server under them stopped).
    setupFiles: ["src/core/testing/setup.ts"],
    // One migrated database template for the whole run (fixtures copy it).
    globalSetup: ["src/core/testing/db-template.global.ts"],
    // The Host and Runtime process tests wait on real timeouts.
    testTimeout: 60_000,
    // 钩子做的是和测试同一类的真活（起 core、开库、关监听、删目录）。默认的
    // 10 秒在 Windows runner 上不够：两百多个 fork 并行时导入就要几分钟，
    // `Hook timed out in 10000ms` 随机落在不同文件上（parity-mail、
    // parity-git-repository、github/http、conversations、resources/service）。
    // 与测试用同一个上限；真卡死的钩子照样会超时。
    hookTimeout: 60_000,
    // 工程规范化 §5：覆盖率只出报告、不设门槛。CI 只在 Linux 作业里开
    // （ARMADRA_COVERAGE=1），本机用 `pnpm test:coverage` 或 `vitest run --coverage`。
    coverage: {
      enabled: process.env.ARMADRA_COVERAGE === "1",
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/core/testing/**"],
    },
  },
});
