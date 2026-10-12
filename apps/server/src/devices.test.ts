import { describe, expect, it } from "vitest";

import { parseCommandLine } from "./cli";
import { CloudCliError, type LocalCore } from "./cloud";
import { runDevices } from "./devices";

/** `armadra-server devices …`（契约 §77.3）：参数先于连接校验，调的是 `/api/devices/*`。 */

function fakeCore() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const core: LocalCore = {
    call: async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (path === "/api/devices")
        return {
          devices: [
            {
              deviceId: "a".repeat(32),
              principalId: "b".repeat(32),
              principalName: "Dev",
              label: "iPhone",
              platform: "ios",
              status: "pending",
              pendingId: "c".repeat(32),
              fingerprint: "abcdefghijklmnopqrstuvwxyz234567",
            },
          ],
        };
      if (path === "/api/devices/approve")
        return { device: { deviceId: "a".repeat(32), label: "iPhone" } };
      return { ok: true };
    },
  };
  return { core, calls };
}

async function run(argv: string[]) {
  const parsed = parseCommandLine(argv);
  if (parsed.kind !== "run") throw new Error(JSON.stringify(parsed));
  const { core, calls } = fakeCore();
  let connected = 0;
  const out: string[] = [];
  await runDevices(
    parsed.positionals,
    parsed.values,
    "/tmp/x",
    {
      connect: async () => {
        connected += 1;
        return core;
      },
    },
    (_document, text) => out.push(text()),
  );
  return { calls, connected, out };
}

describe("devices 子命令", () => {
  it("list 打出状态、名字、指纹前 16 位与待确认 id", async () => {
    const { out } = await run(["devices", "list"]);
    expect(out[0]).toContain("pending");
    expect(out[0]).toContain("iPhone");
    expect(out[0]).toContain("abcd efgh ijkl mnop");
    expect(out[0]).toContain("c".repeat(32));
  });

  it("approve 带校验码调 /api/devices/approve", async () => {
    const { calls } = await run([
      "devices",
      "approve",
      "c".repeat(32),
      "--sas",
      "482 913",
    ]);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/devices/approve",
        body: { pendingId: "c".repeat(32), sas: "482913" },
      },
    ]);
  });

  it("校验码不是 6 位数字：用法错误，不去连运行中的服务", async () => {
    await expect(
      run(["devices", "approve", "c".repeat(32), "--sas", "12"]),
    ).rejects.toBeInstanceOf(CloudCliError);
  });

  it("revoke 要 --principal", async () => {
    await expect(run(["devices", "revoke", "a".repeat(32)])).rejects.toThrow(
      /--principal/,
    );
    const { calls } = await run([
      "devices",
      "revoke",
      "a".repeat(32),
      "--principal",
      "b".repeat(32),
    ]);
    expect(calls[0]).toMatchObject({ path: "/api/devices/revoke" });
  });
});
