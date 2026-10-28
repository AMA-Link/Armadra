// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * zod 的 jitless 必须先于第一次构建 schema（zod 构建时就读开关、试探 eval）：生产构建里
 * `lib/zod-config.ts` 与 zod 同一块，块一求值就执行，比任何消费方都早。
 */

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

interface Group {
  readonly name: string;
  readonly priority?: number;
  readonly test: RegExp;
}

describe("zod 的 jitless 先于任何 schema", () => {
  it("生产构建把 zod 与 zod-config 分进同一块，且优先级最高", async () => {
    const data = mkdtempSync(join(tmpdir(), "armadra-zod-config-"));
    temporary.push(data);
    process.env.ARMADRA_DATA_DIR = data;
    const { loadConfigFromFile } = await import("vite");
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      join(webRoot, "vite.config.ts"),
      webRoot,
      "silent",
    );
    const output = loaded?.config.build?.rolldownOptions?.output as {
      codeSplitting?: { groups?: Group[] };
    };
    const groups = output.codeSplitting?.groups ?? [];
    const zod = groups.find((group) => group.name === "zod");
    expect(zod).toBeDefined();
    expect(
      zod!.test.test(
        "/repo/node_modules/.pnpm/zod@4.6.6/node_modules/zod/v4/core/schemas.js",
      ),
    ).toBe(true);
    expect(zod!.test.test(join(webRoot, "src/lib/zod-config.ts"))).toBe(true);
    expect(zod!.test.test(join(webRoot, "src/lib/trusted-types.ts"))).toBe(
      false,
    );
    for (const other of groups)
      if (other !== zod)
        expect(other.priority ?? 0).toBeLessThan(zod!.priority ?? 0);
  });

  it("模块载入即关掉快速路径", async () => {
    const { globalConfig } = await import("zod/v4/core");
    await import("./zod-config");
    expect(globalConfig.jitless).toBe(true);
  });
});
