import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { registerSkillContent } from "./skills";
import { tempDir } from "../../testing/temp-dir";
import { grokAllowRules, grokArgs } from "./grok";
import { artifactLayout, injectionFromLayout } from "./inject";
import {
  LAUNCH_GATE,
  launcherFiles,
  runDirectory,
  shimsDirectory,
} from "./launcher";

/**
 * grok 在启动行上拿到什么（契约 §122）：`--rules` 一句话指向技能路径，`--allow`
 * 放行三个画布子命令；不写它的任何文件，注入词接在 `--` 之前。
 */

const BIN = "/data/bin/armadra-hook";

describe("--allow 规则", () => {
  it("canvas / context / browser 三个子命令，裸名与绝对路径各一条（路径不加引号）", () => {
    expect(grokAllowRules(BIN)).toEqual([
      "Bash(armadra-hook canvas *)",
      `Bash(${BIN} canvas *)`,
      "Bash(armadra-hook context *)",
      `Bash(${BIN} context *)`,
      "Bash(armadra-hook browser *)",
      `Bash(${BIN} browser *)`,
    ]);
    // 与 Claude 同一组子命令（`claude-allow.ts`），不多不少。
    expect(grokAllowRules("armadra-hook")).toHaveLength(3);
  });

  it("数据目录带空格：规则照原样写，不转义、不加引号（实测见 grok.ts 注释与契约 §122）", () => {
    const rules = grokAllowRules("/Users/a b/data/bin/armadra-hook");
    expect(rules).toContain("Bash(/Users/a b/data/bin/armadra-hook canvas *)");
    expect(rules.some((rule) => rule.includes("\\"))).toBe(false);
    expect(rules.some((rule) => rule.includes('"'))).toBe(false);
  });

  it("不放行 hook / mcp，也不放行整个程序", () => {
    const text = grokAllowRules(BIN).join("\n");
    expect(text).not.toMatch(/\bhook \*|\bmcp\b/);
    expect(grokAllowRules(BIN).every((rule) => rule.endsWith(" *)"))).toBe(
      true,
    );
    expect(grokAllowRules(BIN).some((rule) => rule === `Bash(${BIN} *)`)).toBe(
      false,
    );
  });
});

describe("grokArgs", () => {
  it("--rules 是一行（.launch 的词不能换行），每条规则前各一个 --allow", () => {
    const args = grokArgs(BIN, "读 /x/SKILL.md。\n\n  再读 y。\n");
    expect(args.slice(0, 2)).toEqual(["--rules", "读 /x/SKILL.md。 再读 y。"]);
    const rest = args.slice(2);
    expect(rest.filter((word) => word === "--allow")).toHaveLength(6);
    for (let index = 0; index < rest.length; index += 2) {
      expect(rest[index]).toBe("--allow");
      expect(rest[index + 1]).toMatch(/^Bash\(/);
    }
  });

  it("没有技能文件：没有 --rules，--allow 照给", () => {
    const args = grokArgs(BIN, undefined);
    expect(args).not.toContain("--rules");
    expect(args[0]).toBe("--allow");
  });
});

describe("injectionFromLayout(grok)", () => {
  const layout = artifactLayout("/data", "grok");
  const content = {
    skill: () => "SKILL",
    instructions: () => "INSTRUCTIONS",
    developerInstructions: (path: string) => `读 ${path}\n了解画布动词。`,
  };
  let off: (() => void) | undefined;
  beforeEach(() => {
    off?.();
    off = registerSkillContent(content);
  });

  it("注入词接在 `--` 之前（placement），环境变量为空，没有任何 grok 的文件路径", () => {
    const injection = injectionFromLayout(
      "grok",
      layout,
      BIN,
      (path): path is string => path === layout.skill,
    );
    expect(injection).toMatchObject({ env: [], placement: "before-separator" });
    expect(injection?.args[0]).toBe("--rules");
    expect(injection?.args[1]).toBe(`读 ${layout.skill} 了解画布动词。`);
    expect(injection?.args).toContain("--allow");
    // 不碰 grok 的配置：参数里没有 `--plugin-dir`、`--settings` 之类要落盘的东西。
    expect(injection?.args.join(" ")).not.toMatch(
      /--(plugin-dir|settings|config)/,
    );
    off?.();
    off = undefined;
  });

  it("技能文件还没生成：没有 --rules", () => {
    const injection = injectionFromLayout(
      "grok",
      layout,
      BIN,
      (_path): _path is string => false,
    );
    expect(injection?.args).not.toContain("--rules");
    expect(injection?.placement).toBe("before-separator");
    off?.();
    off = undefined;
  });
});

describe("真启动器：注入词在 `--` 之前，prompt 原样在后", () => {
  it.runIf(process.platform !== "win32")("sh 跑出来的 argv", () => {
    const root = tempDir("armadra-grok-launch-");
    const injection = {
      args: grokArgs(BIN, "读 SKILL"),
      placement: "before-separator" as const,
    };
    const files = launcherFiles(
      {
        agentId: "grok",
        runDir: runDirectory(root, posix.join),
        shimDir: shimsDirectory(root, posix.join),
        args: injection.args,
        env: [],
        placement: injection.placement,
      },
      posix.join,
    );
    for (const [path, file] of files) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, file.content);
      chmodSync(path, file.mode);
    }
    const out = join(root, "out.json");
    const cli = join(root, "fake-grok");
    writeFileSync(
      cli,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(cli, 0o755);
    const prompt = "--rules x 'quoted' version";
    execFileSync(
      "/bin/sh",
      [
        join(root, "integration", "run", "grok"),
        cli,
        "--model",
        "m",
        "--",
        prompt,
      ],
      {
        env: { PATH: "/usr/bin:/bin", [LAUNCH_GATE]: "node-1" },
        stdio: "ignore",
      },
    );
    const argv = JSON.parse(readFileSync(out, "utf8")) as string[];
    expect(argv).toEqual(["--model", "m", ...injection.args, "--", prompt]);
    // 画布外重跑同一行：一个词不加。
    execFileSync(
      "/bin/sh",
      [join(root, "integration", "run", "grok"), cli, "--", prompt],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdio: "ignore",
      },
    );
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(["--", prompt]);
  });
});
