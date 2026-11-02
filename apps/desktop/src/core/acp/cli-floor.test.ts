import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acpAdapter } from "./adapters";
import { checkCliFloor, forgetCliVersions } from "./cli-floor";
import { startAdapter } from "./host";

/** 起会话前的 CLI 版本核对（#710）。 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  forgetCliVersions();
});

/** PATH 上放一个名叫 `program` 的可执行文件（内容不重要，版本由注入的 run 给）。 */
function installed(program: string): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "armadra-cli-floor-"));
  dirs.push(bin);
  const script = join(bin, program);
  writeFileSync(script, "#!/bin/sh\n", "utf8");
  chmodSync(script, 0o755);
  return { PATH: bin, HOME: bin };
}

describe.skipIf(process.platform === "win32")("checkCliFloor", () => {
  it("answers acp_cli_outdated with the details when the CLI is below the floor", async () => {
    const error = await checkCliFloor(
      "pi",
      installed("pi"),
      async () => "pi 0.80.10\n",
    );
    expect(error).toMatchObject({
      code: "acp_cli_outdated",
      details: {
        agentId: "pi",
        installed: "0.80.10",
        minimum: "0.81.0",
        package: "@earendil-works/pi-coding-agent",
      },
    });
    expect(error?.message).toContain("@earendil-works/pi-coding-agent");
  });

  it("lets the floor itself and newer versions through", async () => {
    for (const banner of ["0.81.0", "v1.5.0", "0.100.2"]) {
      forgetCliVersions();
      expect(
        await checkCliFloor("pi", installed("pi"), async () => banner),
      ).toBeUndefined();
    }
  });

  it("never blocks on a version it could not read, or a CLI that is not installed", async () => {
    expect(
      await checkCliFloor("pi", installed("pi"), async () => undefined),
    ).toBeUndefined();
    expect(
      await checkCliFloor("pi", installed("pi"), async () => "no version"),
    ).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), "armadra-cli-floor-empty-"));
    dirs.push(empty);
    let asked = false;
    expect(
      await checkCliFloor("pi", { PATH: empty, HOME: empty }, async () => {
        asked = true;
        return "0.1.0";
      }),
    ).toBeUndefined();
    expect(asked).toBe(false);
  });

  it("does not ask agents that have no registered floor", async () => {
    let asked = false;
    const run = async () => {
      asked = true;
      return "0.0.1";
    };
    expect(
      await checkCliFloor("claude", installed("claude"), run),
    ).toBeUndefined();
    expect(
      await checkCliFloor("custom:x", installed("pi"), run),
    ).toBeUndefined();
    expect(asked).toBe(false);
  });

  it("asks once per installed file and again after it changes", async () => {
    const env = installed("pi");
    let calls = 0;
    const run = async () => {
      calls += 1;
      return "1.5.0";
    };
    await checkCliFloor("pi", env, run);
    await checkCliFloor("pi", env, run);
    expect(calls).toBe(1);
    // 升级：同一路径上的文件换了（大小变），重新问。
    const path = join(env.PATH as string, "pi");
    writeFileSync(path, "#!/bin/sh\n# upgraded\n", "utf8");
    await checkCliFloor("pi", env, run);
    expect(calls).toBe(2);
  });

  it("does not remember a failed read, so a retry asks again", async () => {
    const env = installed("pi");
    let calls = 0;
    const run = async () => {
      calls += 1;
      return calls === 1 ? undefined : "0.73.1";
    };
    expect(await checkCliFloor("pi", env, run)).toBeUndefined();
    expect(await checkCliFloor("pi", env, run)).toMatchObject({
      code: "acp_cli_outdated",
    });
  });

  it("does not remember an outdated verdict: an upgrade behind the same shim is noticed", async () => {
    const env = installed("pi");
    let calls = 0;
    // 版本管理器的 shim：路径、修改时间、大小都不变，背后的版本升了。
    const run = async () => {
      calls += 1;
      return calls === 1 ? "pi 0.80.10" : "pi 0.82.1";
    };
    expect(await checkCliFloor("pi", env, run)).toMatchObject({
      code: "acp_cli_outdated",
      details: { installed: "0.80.10" },
    });
    expect(await checkCliFloor("pi", env, run)).toBeUndefined();
    expect(calls).toBe(2);
    // 够新的照旧只问一次。
    await checkCliFloor("pi", env, run);
    expect(calls).toBe(2);
  });

  it("reads a pre-release of the floor as below it, and a pre-release of a newer version as fine", async () => {
    const error = await checkCliFloor(
      "pi",
      installed("pi"),
      async () => "pi 0.81.0-beta.2\n",
    );
    expect(error).toMatchObject({
      code: "acp_cli_outdated",
      details: { installed: "0.81.0-beta.2", minimum: "0.81.0" },
    });
    forgetCliVersions();
    expect(
      await checkCliFloor("pi", installed("pi"), async () => "0.82.0-rc.1"),
    ).toBeUndefined();
    forgetCliVersions();
    expect(
      await checkCliFloor("pi", installed("pi"), async () => "0.81.0"),
    ).toBeUndefined();
  });

  it("startAdapter checks a prestarted adapter too and ends the process it was handed", async () => {
    const bin = mkdtempSync(join(tmpdir(), "armadra-cli-floor-start-"));
    dirs.push(bin);
    for (const [name, body] of [
      ["pi", "echo 0.80.10"],
      ["pi-acp", "exit 0"],
    ] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, "utf8");
      chmodSync(join(bin, name), 0o755);
    }
    const terminate = vi.fn(async () => ({}));
    const attach = vi.fn();
    await expect(
      startAdapter(
        acpAdapter("pi") as NonNullable<ReturnType<typeof acpAdapter>>,
        {
          cwd: tmpdir(),
          env: { PATH: bin, HOME: bin },
          prestarted: {
            process: { terminate } as never,
            initialized: {} as never,
            attach,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "acp_cli_outdated" });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
  });
});
