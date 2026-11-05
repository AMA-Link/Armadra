import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  type DpapiRunner,
  readMasterKey,
  rotateMasterKey,
} from "../../desktop/src/core/secrets";
import { MASTER_KEY_ENV, masterKeyFile, serverSecrets } from "./secrets";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "armadra-server-secrets-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("服务器壳的密钥后端", () => {
  it("首启在数据目录里生成 0600 的 master key，条目加密", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, {});
    expect(backend.kind).toBe("file-encrypted");
    const key = join(dir, "secrets", "master.key");
    expect(existsSync(key)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(key).mode & 0o777).toBe(0o600);
    }
    await backend.set("armadra-copilot", "gho_server_token");
    const raw = readFileSync(
      join(dir, "secrets", "armadra-copilot.sealed"),
      "utf8",
    );
    expect(raw).not.toContain("gho_server_token");
    // 重启：同一把钥匙，读得回来。
    expect(await serverSecrets(dir, {}).get("armadra-copilot")).toBe(
      "gho_server_token",
    );
  });

  it(`${MASTER_KEY_ENV} 指到别处：缺了就拒绝启动，不另生成`, () => {
    const dir = dataDir();
    const elsewhere = join(dir, "credentials", "master.key");
    const env = { [MASTER_KEY_ENV]: elsewhere };
    expect(masterKeyFile(dir, env)).toEqual({
      path: elsewhere,
      configured: true,
    });
    expect(() => serverSecrets(dir, env)).toThrow();
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("轮换之后服务器后端照样读得回来", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, {});
    await backend.set("armadra-a", "value-a");
    const keyFile = join(dir, "secrets", "master.key");
    const before = readMasterKey(keyFile);
    expect(rotateMasterKey({ directory: join(dir, "secrets"), keyFile })).toBe(
      1,
    );
    expect(readMasterKey(keyFile)?.equals(before!)).toBe(false);
    expect(await serverSecrets(dir, {}).get("armadra-a")).toBe("value-a");
  });

  it("ARMADRA_SECRET_BACKEND=file 强制明文 0600，不生成钥匙", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, { ARMADRA_SECRET_BACKEND: "file" });
    expect(backend.kind).toBe("file");
    await backend.set("armadra-a", "plain");
    expect(existsSync(join(dir, "secrets", "master.key"))).toBe(false);
    expect(readFileSync(join(dir, "secrets", "armadra-a.token"), "utf8")).toBe(
      "plain",
    );
  });
});

describe("服务器壳在 Windows 上的 DPAPI 选择", () => {
  const xor: DpapiRunner = async (_file, args, input) =>
    args[0] === "dpapi-protect"
      ? Buffer.concat([Buffer.from("DP"), input.map((b) => b ^ 0x21)])
      : Buffer.from(input.subarray(2).map((b) => b ^ 0x21));
  const win = {
    platform: "win32",
    winsec: "C:\\x\\armadra-winsec.exe",
    dpapiRunner: xor,
  } as const;

  it("win32、有工具、没有 master key：dpapi，不生成 master key", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, {}, win);
    expect(backend.kind).toBe("dpapi");
    await backend.set("armadra-copilot", "gho_dpapi_token");
    expect(existsSync(join(dir, "secrets", "master.key"))).toBe(false);
    const raw = readFileSync(
      join(dir, "secrets", "armadra-copilot.sealed"),
      "utf8",
    );
    expect(raw).not.toContain("gho_dpapi_token");
    expect(await serverSecrets(dir, {}, win).get("armadra-copilot")).toBe(
      "gho_dpapi_token",
    );
  });

  it("已有 master.key：继续 file-encrypted，已存的条目不搁浅", async () => {
    const dir = dataDir();
    await serverSecrets(dir, {}, { platform: "linux" }).set(
      "armadra-old",
      "old-value",
    );
    const backend = serverSecrets(dir, {}, win);
    expect(backend.kind).toBe("file-encrypted");
    expect(await backend.get("armadra-old")).toBe("old-value");
  });

  it("master key 由运维指定，或强制了别的后端：不碰 DPAPI", () => {
    const dir = dataDir();
    const elsewhere = join(dir, "credentials", "master.key");
    expect(() =>
      serverSecrets(dir, { [MASTER_KEY_ENV]: elsewhere }, win),
    ).toThrow();
    expect(
      serverSecrets(dir, { ARMADRA_SECRET_BACKEND: "file" }, win).kind,
    ).toBe("file");
    expect(
      serverSecrets(dir, { ARMADRA_SECRET_BACKEND: "file-encrypted" }, win)
        .kind,
    ).toBe("file-encrypted");
  });

  it("找不到工具或不是 win32：照旧 file-encrypted", () => {
    expect(
      serverSecrets(dataDir(), {}, { ...win, winsec: undefined }).kind,
    ).toBe("file-encrypted");
    expect(
      serverSecrets(dataDir(), {}, { ...win, platform: "linux" }).kind,
    ).toBe("file-encrypted");
  });

  it("DPAPI 封的条目遇到 file-encrypted（工具之后丢了）：sealed_by_dpapi", async () => {
    const dir = dataDir();
    await serverSecrets(dir, {}, win).set("armadra-x", "v");
    const fallback = serverSecrets(dir, {}, { ...win, winsec: undefined });
    await expect(fallback.get("armadra-x")).rejects.toMatchObject({
      reason: "sealed_by_dpapi",
    });
  });
});
