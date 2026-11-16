import { defineConfig } from "vitest/config";

// core 与 dom 的纯逻辑都在 Node 环境跑，不用 jsdom：需要 DOM 的东西放进真实浏览器验证。
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
