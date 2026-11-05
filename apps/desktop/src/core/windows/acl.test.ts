import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/temp-dir";
import {
  WINSEC_EXE_NAME,
  findWinsecExe,
  hardenDataRoot,
  hardenPipe,
  pipeSddl,
  verifyPipeSddl,
  winsecCandidates,
  currentSid,
} from "./acl";

const SID = "S-1-5-21-1004336348-1177238915-682003330-1001";

describe("verifying a pipe descriptor", () => {
  it("accepts exactly the descriptor we set", () => {
    expect(verifyPipeSddl(pipeSddl(SID), SID)).toEqual({ ok: true });
    // Spellings Windows may print back.
    expect(
      verifyPipeSddl(
        `D:PAI(D;;GA;;;S-1-5-2)(A;;FA;;;S-1-5-18)(A;;GA;;;${SID})`,
        SID,
      ),
    ).toEqual({ ok: true });
    expect(
      verifyPipeSddl(`D:P(D;;0x1f01ff;;;NU)(A;;GA;;;${SID})(A;;GA;;;SY)`, SID),
    ).toEqual({ ok: true });
    expect(
      verifyPipeSddl(
        "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;LA)",
        "S-1-5-21-1-2-3-500",
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ["the default descriptor", "D:(A;;GA;;;WD)(A;;GA;;;SY)(A;;GA;;;BA)"],
    ["Everyone allowed", `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;WD)`],
    ["not protected", `D:(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;${SID})`],
    [
      "another user",
      `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;S-1-5-21-9-9-9-1001)`,
    ],
    ["the deny not first", `D:P(A;;GA;;;SY)(D;;GA;;;NU)(A;;GA;;;${SID})`],
    ["no network deny", `D:P(A;;GA;;;SY)(A;;GA;;;${SID})(A;;GA;;;BA)`],
    ["an extra ACE", `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;${SID})(A;;GA;;;BA)`],
    ["read-only user", `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GR;;;${SID})`],
    ["two SYSTEMs", `D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;S-1-5-18)`],
    ["an inheritance flag", `D:P(D;;GA;;;NU)(A;OICI;GA;;;SY)(A;;GA;;;${SID})`],
    ["an owner part", `O:SYD:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;${SID})`],
    ["empty", ""],
  ])("refuses %s", (_name, sddl) => {
    expect(verifyPipeSddl(sddl, SID).ok).toBe(false);
  });
});

describe("hardening a pipe through a helper", () => {
  const pipe = "\\\\.\\pipe\\armadra-test-pipe";

  it("runs the helper with the pipe and the SID and checks the answer", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const result = await hardenPipe(pipe, {
      sid: SID,
      exe: "C:\\app\\cli\\armadra-winsec.exe",
      run: async (file, args) => {
        calls.push({ file, args });
        return `${pipeSddl(SID)}\r\n`;
      },
    });
    expect(result).toEqual({ ok: true, method: "exe", sddl: pipeSddl(SID) });
    expect(calls).toEqual([
      {
        file: "C:\\app\\cli\\armadra-winsec.exe",
        args: ["harden-pipe", pipe, SID],
      },
    ]);
  });

  it("fails when the read-back is not the descriptor we asked for", async () => {
    const result = await hardenPipe(pipe, {
      sid: SID,
      exe: "x.exe",
      run: async () => "D:(A;;GA;;;WD)",
    });
    expect(result.ok).toBe(false);
  });

  it("does not turn a helper that fails into a PowerShell run", async () => {
    const files: string[] = [];
    const result = await hardenPipe(pipe, {
      sid: SID,
      exe: "x.exe",
      run: async (file) => {
        files.push(file);
        throw new Error("blocked by policy");
      },
    });
    expect(result).toEqual({ ok: false, reason: "blocked by policy" });
    expect(files).toEqual(["x.exe"]);
  });

  it("falls back to PowerShell without a helper, naming the pipe by environment", async () => {
    const seen: { file: string; env: NodeJS.ProcessEnv; script: string }[] = [];
    const result = await hardenPipe(pipe, {
      sid: SID,
      exe: undefined,
      env: { SystemRoot: "C:\\Windows" },
      run: async (file, args, options) => {
        seen.push({ file, env: options.env, script: args.at(-1) ?? "" });
        return `${pipeSddl(SID)}\n`;
      },
    });
    expect(result).toMatchObject({ ok: true, method: "powershell" });
    expect(seen[0]?.file).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(seen[0]?.env.ARMADRA_PIPE_NAME).toBe("armadra-test-pipe");
    expect(seen[0]?.env.ARMADRA_PIPE_SDDL).toBe(pipeSddl(SID));
    // Values travel in the environment, never in the script text.
    expect(seen[0]?.script).not.toContain("armadra-test-pipe");
    expect(seen[0]?.script).not.toContain(SID);
  });

  it("refuses anything that is not a named pipe path", async () => {
    for (const path of ["C:\\temp\\x", "\\\\.\\pipe\\", "/tmp/x.sock"]) {
      const result = await hardenPipe(path, {
        sid: SID,
        exe: "x.exe",
        run: async () => pipeSddl(SID),
      });
      expect(result.ok).toBe(false);
    }
  });

  it("locates the helper beside the app and honours an override", () => {
    const directory = tempDir("armadra-winsec-");
    const candidates = winsecCandidates({
      resourcesPath: join(directory, "res"),
      execPath: join(directory, "bin", "Armadra.exe"),
      moduleDir: join(directory, "out", "core"),
    });
    expect(candidates[0]).toBe(join(directory, "res", "cli", WINSEC_EXE_NAME));
    expect(candidates).toHaveLength(3);
    expect(candidates[2]).toBe(join(directory, "out", "cli", WINSEC_EXE_NAME));
    expect(findWinsecExe({}, candidates)).toBeUndefined();
    // An override that is not a file means none — not a search for another.
    expect(
      findWinsecExe({ ARMADRA_WINSEC_EXE: join(directory, "nope.exe") }, [
        process.execPath,
      ]),
    ).toBeUndefined();
  });
});

describe("narrowing the data directory root", () => {
  it("does nothing off Windows", () => {
    const directory = tempDir("armadra-root-");
    expect(
      hardenDataRoot(directory, {
        platform: "linux",
        icacls: () => {
          throw new Error("must not run");
        },
      }),
    ).toBe(true);
  });

  it("runs icacls once per SID, granting only SYSTEM and the user", () => {
    const directory = tempDir("armadra-root-");
    const calls: (readonly string[])[] = [];
    const options = {
      platform: "win32" as const,
      sid: () => SID,
      icacls: (args: readonly string[]) => void calls.push(args),
    };
    expect(hardenDataRoot(directory, options)).toBe(true);
    expect(hardenDataRoot(directory, options)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      directory,
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "/grant:r",
      `*${SID}:(OI)(CI)F`,
    ]);
    expect(
      readFileSync(join(directory, ".acl-owner-only"), "utf8").trim(),
    ).toBe(SID);
  });

  it("warns and returns false when icacls fails, leaving no marker", () => {
    const directory = tempDir("armadra-root-");
    const warnings: string[] = [];
    expect(
      hardenDataRoot(directory, {
        platform: "win32",
        sid: () => SID,
        icacls: () => {
          throw new Error("denied");
        },
        warn: (message) => warnings.push(message),
      }),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(existsSync(join(directory, ".acl-owner-only"))).toBe(false);
  });
});

/**
 * The tests below need a real Windows machine: they build the helper with the
 * system `csc.exe`, bind a real named pipe and read its descriptor back. They
 * run on the Windows runner only.
 */
describe.skipIf(process.platform !== "win32")("on Windows", () => {
  it("reads this user's SID", () => {
    expect(currentSid()).toMatch(/^S-1-5-/);
  });

  it("hardens a real pipe through the compiled helper and through PowerShell", async () => {
    const { compileWinsecExe } = await import(
      "../../../scripts/winsec-exe.mjs" as string
    );
    const directory = tempDir("armadra-winsec-real-");
    const exe = compileWinsecExe(
      join(directory, "armadra-winsec.exe"),
    ) as string;
    expect(existsSync(exe)).toBe(true);
    const sid = currentSid();

    for (const method of ["exe", "powershell"] as const) {
      const path = `\\\\.\\pipe\\armadra-winsec-${process.pid}-${method}`;
      const server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      try {
        const result = await hardenPipe(path, {
          sid,
          exe: method === "exe" ? exe : undefined,
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: true,
          method,
        });
        // The pipe still serves this user afterwards.
        const user = spawn(process.execPath, [
          "-e",
          `const s=require("net").connect(${JSON.stringify(path)});s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))`,
        ]);
        const code = await new Promise<number | null>((resolve) =>
          user.on("exit", resolve),
        );
        expect(code).toBe(0);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }, 60_000);

  it("reports a failure when the helper cannot do it, and does not fall back to PowerShell", async () => {
    const path = `\\\\.\\pipe\\armadra-winsec-bad-${process.pid}`;
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    try {
      // A real program that is not the helper: it exits non-zero.
      const result = await hardenPipe(path, {
        sid: currentSid(),
        exe: process.execPath,
      });
      expect(result.ok).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);
});
