import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../testing/temp-dir";
import {
  BARE_GATE,
  LAUNCH_GATE,
  type LauncherSpec,
  launcherFiles,
  posixLauncher,
  runDirectory,
  shimsDirectory,
} from "./launcher";
import { launchConfig } from "./windows-launcher";

/**
 * 零注入（契约 §113，#975）：`ARMADRA_BARE` 非空时启动器不设注入的变量、
 * 不追加 argv、不走环境分支，凭据兑换照常。POSIX 用真的 `/bin/sh` 跑；
 * Windows 那半是 `.launch` 里的一行，程序本身在 `agent/windows-launch.test.ts`。
 */

const posixOnly = process.platform !== "win32";

let root: string;
let spec: LauncherSpec;

beforeEach(() => {
  root = tempDir("armadra-bare-launch-");
  spec = {
    agentId: "claude",
    runDir: runDirectory(root, posix.join),
    shimDir: shimsDirectory(root, posix.join),
    args: ["--settings", "/data/settings.json", "--plugin-dir", "/data/p"],
    env: [["OPENCODE_CONFIG_DIR", "/data/config"]],
    fallback: { whenEnvAny: ["CLAUDE_CODE_SAFE_MODE"], args: ["--safe"] },
  };
});

function executable(path: string, lines: string[]): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n"), "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** 把 argv 与两个变量记成 JSON 的假 CLI。 */
function fakeCli(out: string): string {
  return executable(join(root, "bin", "claude"), [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  config: process.env.OPENCODE_CONFIG_DIR ?? null,",
    "  secret: process.env.ARMADRA_TEST_SECRET ?? null,",
    "}));",
    "",
  ]);
}

interface Seen {
  argv: string[];
  config: string | null;
  secret: string | null;
}

function launch(
  launcher: string,
  cli: string,
  env: Record<string, string>,
  out: string,
): Seen {
  execFileSync("/bin/sh", [launcher, cli, "x"], {
    env: { PATH: "/usr/bin:/bin", HOME: root, ...env },
  });
  return JSON.parse(readFileSync(out, "utf8")) as Seen;
}

describe("POSIX launcher", () => {
  it("branches on ARMADRA_BARE after the gate and before any injection", () => {
    const text = posixLauncher(spec);
    const bare = text.indexOf(`[ -n "\${${BARE_GATE}:-}" ]`);
    expect(bare).toBeGreaterThan(text.indexOf("|| exec"));
    expect(bare).toBeLessThan(text.indexOf("OPENCODE_CONFIG_DIR="));
    expect(bare).toBeLessThan(text.indexOf("CLAUDE_CODE_SAFE_MODE"));
    expect(bare).toBeLessThan(text.lastIndexOf("--settings"));
  });

  it("keeps the credential exchange ahead of the bare branch", () => {
    const text = posixLauncher({
      ...spec,
      credential: { client: "/data/armadra-hook", variables: ["TOKEN_VAR"] },
    });
    expect(text.indexOf("credential")).toBeLessThan(
      text.indexOf(`${BARE_GATE}:-`),
    );
  });

  it.runIf(posixOnly)("injects with the switch off and not with it on", () => {
    const files = launcherFiles(spec, posix.join);
    for (const [path, file] of files) {
      executable(path, file.content.split("\n"));
    }
    const launcher = join(spec.runDir, "claude");
    execFileSync("/bin/sh", ["-n", launcher]);
    const out = join(root, "out.json");
    const cli = fakeCli(out);
    const node = { [LAUNCH_GATE]: "node-1" };

    expect(launch(launcher, cli, node, out)).toEqual({
      argv: ["x", ...spec.args],
      config: "/data/config",
      secret: null,
    });
    for (const value of ["1", "yes"]) {
      expect(
        launch(launcher, cli, { ...node, [BARE_GATE]: value }, out),
      ).toEqual({ argv: ["x"], config: null, secret: null });
    }
    // 空串不算设置。
    expect(
      launch(launcher, cli, { ...node, [BARE_GATE]: "" }, out).argv,
    ).toEqual(["x", ...spec.args]);
    // 零注入也绕过 mod 的环境分支。
    expect(
      launch(
        launcher,
        cli,
        { ...node, [BARE_GATE]: "1", CLAUDE_CODE_SAFE_MODE: "1" },
        out,
      ).argv,
    ).toEqual(["x"]);
  });

  it.runIf(posixOnly)("still exchanges the node credential when bare", () => {
    const client = executable(join(root, "armadra-hook"), [
      "#!/bin/sh",
      'echo "ARMADRA_TEST_SECRET=s3cret"',
    ]);
    const withCredential: LauncherSpec = {
      ...spec,
      credential: { client, variables: ["ARMADRA_TEST_SECRET"] },
    };
    for (const [path, file] of launcherFiles(withCredential, posix.join)) {
      executable(path, file.content.split("\n"));
    }
    const out = join(root, "out.json");
    const cli = fakeCli(out);
    const seen = launch(
      join(spec.runDir, "claude"),
      cli,
      {
        [LAUNCH_GATE]: "node-1",
        [BARE_GATE]: "1",
        ARMADRA_CREDENTIAL_REF: "ref",
      },
      out,
    );
    expect(seen).toEqual({ argv: ["x"], config: null, secret: "s3cret" });
  });
});

describe("Windows .launch", () => {
  it("names the bare gate beside the node gate, in launcher and shim", () => {
    const run = launchConfig({ ...spec, bare: true }, "run");
    expect(run.trimEnd().endsWith(`bare=${BARE_GATE}`)).toBe(true);
    // 注入的 env 与 arg 仍在文件里：是否生效由程序按这一行决定。
    expect(run).toContain("arg=--settings");
    const shim = launchConfig({ ...spec, bare: true }, "shim", {
      program: "C:\\x\\claude.exe",
      args: [],
    });
    expect(shim).toContain(`bare=${BARE_GATE}`);
    expect(launchConfig(spec, "run")).not.toContain("bare=");
  });
});
