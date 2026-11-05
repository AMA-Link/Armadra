import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { tempDir } from "../testing/temp-dir";
import {
  DPAPI_MAX_PLAIN_BYTES,
  type DpapiRunner,
  SecretUnavailable,
  dpapiSealer,
  encryptedFileBackend,
  plainFileBackend,
  resolveSecretBackend,
  sealedFileBackend,
  secretsDirectory,
} from "./index";

/** 假的 armadra-winsec：异或一个字节，并记下每次调用（参数与 stdin 长度）。 */
function fakeRunner(): DpapiRunner & {
  calls: { args: readonly string[]; length: number }[];
} {
  const calls: { args: readonly string[]; length: number }[] = [];
  const runner: DpapiRunner = async (_file, args, input) => {
    calls.push({ args, length: input.length });
    if (args[0] === "dpapi-protect") {
      return Buffer.concat([Buffer.from("DP"), input.map((b) => b ^ 0x21)]);
    }
    if (args[0] === "dpapi-unprotect") {
      if (input.subarray(0, 2).toString() !== "DP") {
        throw new Error("armadra-winsec: CryptographicException");
      }
      return Buffer.from(input.subarray(2).map((b) => b ^ 0x21));
    }
    throw new Error("unexpected subcommand");
  };
  return Object.assign(runner, { calls });
}

describe("DPAPI 封存器（假 runner）", () => {
  it("往返；值只走 stdin，命令行里只有子命令", async () => {
    const run = fakeRunner();
    const sealer = dpapiSealer("winsec.exe", { run });
    expect(sealer.kind).toBe("dpapi");
    const sealed = await sealer.seal(Buffer.from("top-secret", "utf8"));
    expect(sealed.toString("utf8")).not.toContain("top-secret");
    expect((await sealer.unseal(sealed)).toString("utf8")).toBe("top-secret");
    expect(run.calls.map((call) => call.args)).toEqual([
      ["dpapi-protect"],
      ["dpapi-unprotect"],
    ]);
  });

  it("runner 失败：SecretUnavailable，原因是代码，不带输入也不带工具输出", async () => {
    const sealer = dpapiSealer("winsec.exe", {
      run: async () => {
        throw new Error("boom top-secret");
      },
    });
    const sealFailure = await sealer
      .seal(Buffer.from("top-secret"))
      .catch((e: unknown) => e);
    expect(sealFailure).toBeInstanceOf(SecretUnavailable);
    expect(sealFailure).toMatchObject({ reason: "dpapi_seal_failed" });
    expect(String((sealFailure as Error).message)).not.toContain("top-secret");
    await expect(sealer.unseal(Buffer.from("x"))).rejects.toMatchObject({
      reason: "dpapi_unseal_failed",
    });
  });

  it("空输出当作失败；被改的密文解不开", async () => {
    await expect(
      dpapiSealer("w", { run: async () => Buffer.alloc(0) }).seal(
        Buffer.from("v"),
      ),
    ).rejects.toMatchObject({ reason: "dpapi_seal_failed" });
    const sealer = dpapiSealer("w", { run: fakeRunner() });
    const sealed = await sealer.seal(Buffer.from("v"));
    sealed[0] = 0;
    await expect(sealer.unseal(sealed)).rejects.toMatchObject({
      reason: "dpapi_unseal_failed",
    });
  });

  it("超限：明文与密文在起子进程之前就被拒", async () => {
    const run = fakeRunner();
    const sealer = dpapiSealer("w", { run });
    await expect(
      sealer.seal(Buffer.alloc(DPAPI_MAX_PLAIN_BYTES + 1)),
    ).rejects.toMatchObject({ reason: "oversized" });
    await expect(
      sealer.unseal(Buffer.alloc(1024 * 1024)),
    ).rejects.toMatchObject({ reason: "oversized" });
    expect(run.calls).toEqual([]);
  });

  it("超时与输出上限作为选项交给 runner", async () => {
    const seen: { timeoutMs: number; maxOutputBytes: number }[] = [];
    const sealer = dpapiSealer("w", {
      timeoutMs: 1234,
      run: async (_f, _a, input, options) => {
        seen.push(options);
        return input;
      },
    });
    await sealer.seal(Buffer.from("v"));
    expect(seen[0]?.timeoutMs).toBe(1234);
    expect(seen[0]?.maxOutputBytes).toBeGreaterThan(DPAPI_MAX_PLAIN_BYTES);
  });

  it("接 sealedFileBackend：数据目录里是 dpapi 信封，没有明文", async () => {
    const dir = tempDir("armadra-dpapi-");
    const backend = sealedFileBackend(
      dir,
      dpapiSealer("w", { run: fakeRunner() }),
    );
    expect(backend.kind).toBe("dpapi");
    await backend.set("armadra-x", "plain-value");
    const raw = readFileSync(join(dir, "armadra-x.sealed"), "utf8");
    expect(raw).not.toContain("plain-value");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kind: "dpapi" });
    expect(await backend.get("armadra-x")).toBe("plain-value");
  });
});

describe("挑后端：Windows 上的 DPAPI", () => {
  const dataDir = () => tempDir("armadra-dpapi-select-");
  const exe = "C:\\app\\cli\\armadra-winsec.exe";

  it("win32、找得到工具、没有壳封存器：dpapi", async () => {
    const run = fakeRunner();
    const resolved = resolveSecretBackend({
      dataDir: dataDir(),
      env: {},
      platform: "win32",
      winsec: exe,
      dpapiRunner: run,
    });
    expect(resolved.backend.kind).toBe("dpapi");
    await resolved.backend.set("armadra-x", "v");
    expect(await resolved.backend.get("armadra-x")).toBe("v");
  });

  it("找不到工具：照旧是明文文件；其它平台不看工具", () => {
    const base = { dataDir: dataDir(), env: {} };
    expect(
      resolveSecretBackend({ ...base, platform: "win32", winsec: undefined })
        .backend.kind,
    ).toBe("file");
    expect(
      resolveSecretBackend({ ...base, platform: "linux", winsec: exe }).backend
        .kind,
    ).toBe("file");
  });

  it("强制值与壳给的后端优先于 DPAPI", () => {
    const common = { platform: "win32", winsec: exe } as const;
    expect(
      resolveSecretBackend({
        ...common,
        dataDir: dataDir(),
        env: { ARMADRA_SECRET_BACKEND: "file" },
      }).backend.kind,
    ).toBe("file");
    expect(
      resolveSecretBackend({
        ...common,
        dataDir: dataDir(),
        env: { ARMADRA_SECRET_BACKEND: "file-encrypted" },
      }).backend.kind,
    ).toBe("file-encrypted");
    const injected = plainFileBackend(dataDir());
    expect(
      resolveSecretBackend({
        ...common,
        dataDir: dataDir(),
        env: {},
        injected,
      }).backend,
    ).toBe(injected);
  });

  it("壳的 safeStorage 通道（ipc:dpapi）优先：没通道就拒绝，不改走工具", async () => {
    const resolved = resolveSecretBackend({
      dataDir: dataDir(),
      env: { ARMADRA_SECRET_SEALER: "ipc:dpapi" },
      platform: "win32",
      winsec: exe,
    });
    await expect(resolved.backend.get("armadra-x")).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });

  it("数据目录里已有明文条目：继续用明文，不把它们搁浅", async () => {
    const dir = dataDir();
    const directory = secretsDirectory(dir);
    await plainFileBackend(directory).set("armadra-old", "old-value");
    const resolved = resolveSecretBackend({
      dataDir: dir,
      env: {},
      platform: "win32",
      winsec: exe,
      dpapiRunner: fakeRunner(),
    });
    expect(resolved.backend.kind).toBe("file");
    expect(await resolved.backend.get("armadra-old")).toBe("old-value");
  });

  it("别的后端封的条目：报 sealed_by_<kind>，不悄悄读", async () => {
    const dir = dataDir();
    const directory = secretsDirectory(dir);
    await encryptedFileBackend({
      directory,
      keyFile: join(directory, "master.key"),
      createKey: true,
    }).set("armadra-x", "v");
    const dpapi = sealedFileBackend(
      directory,
      dpapiSealer("w", { run: fakeRunner() }),
    );
    await expect(dpapi.get("armadra-x")).rejects.toMatchObject({
      reason: "sealed_by_file-encrypted",
    });
  });
});

describe("Windows 真 DPAPI（只在 Windows runner 上跑）", () => {
  // 没有本地 Windows 机器：这些用例只在 CI 的 Windows runner 上真的编译并调用
  // armadra-winsec.exe，其余平台跳过。
  it.skipIf(process.platform !== "win32")(
    "封存再解封；密文不同于明文；被改的密文失败",
    async () => {
      const scripts = fileURLToPath(
        new URL("../../../scripts/winsec-exe.mjs", import.meta.url),
      );
      const { compileWinsecExe } = (await import(
        pathToFileURL(scripts).href
      )) as { compileWinsecExe: (output: string) => string };
      const dir = tempDir("armadra-dpapi-real-");
      mkdirSync(dir, { recursive: true });
      const exe = compileWinsecExe(join(dir, "armadra-winsec.exe"));
      const sealer = dpapiSealer(exe);
      const plain = Buffer.from("real-dpapi-value-\u00e9", "utf8");
      const sealed = await sealer.seal(plain);
      expect(sealed.equals(plain)).toBe(false);
      expect(sealed.includes(plain)).toBe(false);
      expect((await sealer.unseal(sealed)).equals(plain)).toBe(true);
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
      await expect(sealer.unseal(tampered)).rejects.toMatchObject({
        reason: "dpapi_unseal_failed",
      });
      // 整条路径：后端挑选 -> 信封 -> 读回。
      const resolved = resolveSecretBackend({
        dataDir: dir,
        env: {},
        platform: "win32",
        winsec: exe,
      });
      expect(resolved.backend.kind).toBe("dpapi");
      await resolved.backend.set("armadra-real", "round-trip");
      expect(await resolved.backend.get("armadra-real")).toBe("round-trip");
    },
    60_000,
  );
});
