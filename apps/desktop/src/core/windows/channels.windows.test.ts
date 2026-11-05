import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ListenSpec, bind, release } from "../listen";
import { channelKey, connectPrivate } from "../private-pipe";
import { tempDir } from "../testing/temp-dir";
import { currentSid, hardenPipe, verifyPipeSddl } from "./acl";

/**
 * Windows private channels on a real runner (#751 P8). Everything here needs
 * Windows: real named pipes, the compiled `armadra-winsec.exe`, `net user`.
 * They run from `vitest.windows.config.mts` (nightly / manual dispatch).
 */
const root = Buffer.alloc(32, 9);
const key = channelKey(root, "runtime");

async function winsecExe(): Promise<string> {
  const { compileWinsecExe } = (await import(
    "../../../scripts/winsec-exe.mjs" as string
  )) as { compileWinsecExe: (output: string) => string };
  return compileWinsecExe(
    join(tempDir("armadra-winsec-"), "armadra-winsec.exe"),
  );
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe.skipIf(process.platform !== "win32")("a squatted pipe name", () => {
  it("is never bound over, and a client refuses what answers there", async () => {
    const name = `armadra-squat-${process.pid}-${randomBytes(3).toString("hex")}`;
    const path = `\\\\.\\pipe\\${name}`;
    // Another process takes the name first and answers anything with noise.
    const squatter = spawn(
      process.execPath,
      [
        "-e",
        `const s=require("net").createServer(c=>{c.on("data",()=>c.write(Buffer.alloc(48,7)));c.on("error",()=>{})});s.listen(${JSON.stringify(path)},()=>console.log("up"));setTimeout(()=>process.exit(0),60000)`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(squatter);
    await new Promise<void>((resolve, reject) => {
      squatter.stdout?.once("data", () => resolve());
      squatter.once("exit", () => reject(new Error("squatter did not start")));
    });
    // The core cannot take the name (the first instance is not ours)…
    const server = httpServer();
    await expect(
      bind(
        server,
        { kind: "pipe", name },
        { channel: { label: "runtime", key } },
      ),
    ).rejects.toThrow();
    // …and a client that finds the squatter instead is not served.
    await expect(
      connectPrivate(path, { label: "runtime", pipe: name, key }, 3000),
    ).rejects.toThrow(/bad server proof/);
  });
});

describe.skipIf(process.platform !== "win32")("a helper that fails", () => {
  it("leaves the pipe unhardened and reports it instead of a descriptor", async () => {
    const name = `armadra-badhelper-${process.pid}`;
    const server = httpServer();
    const spec: ListenSpec = { kind: "pipe", name };
    await bind(server, spec, {
      channel: { label: "runtime", key },
      harden: async () => ({ ok: false, reason: "test" }),
    });
    try {
      const result = await hardenPipe(`\\\\.\\pipe\\${name}`, {
        sid: currentSid(),
        exe: process.execPath,
      });
      expect(result.ok).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      release(spec);
    }
  });
});

describe.skipIf(
  process.platform !== "win32" ||
    process.env.ARMADRA_WINDOWS_SECOND_USER !== "1",
)("a second local user", () => {
  it("cannot open a hardened pipe: access is denied", async () => {
    const exe = await winsecExe();
    process.env.ARMADRA_WINSEC_EXE = exe;
    const name = `armadra-second-${process.pid}-${randomBytes(3).toString("hex")}`;
    const path = `\\\\.\\pipe\\${name}`;
    const user = `armprobe${randomBytes(3).toString("hex")}`;
    // A throwaway local account on a disposable CI runner, deleted below.
    const password = `Aa1!${randomBytes(12).toString("hex")}`;
    const shared = join("C:\\Users\\Public", user);
    const server = httpServer((_req, res) => res.end("served"));
    const spec: ListenSpec = { kind: "pipe", name };
    try {
      await bind(server, spec, {
        channel: { label: "runtime", key },
        requireHardened: true,
      });
      const hardened = await hardenPipe(path);
      expect(hardened.ok, JSON.stringify(hardened)).toBe(true);
      if (hardened.ok)
        expect(verifyPipeSddl(hardened.sddl, currentSid()).ok).toBe(true);

      execFileSync("net", ["user", user, password, "/add", "/y"], {
        stdio: "ignore",
      });
      mkdirSync(shared, { recursive: true });
      execFileSync(
        "icacls",
        [shared, "/grant", `${user}:(OI)(CI)M`, "/grant", "Users:(OI)(CI)RX"],
        { stdio: "ignore" },
      );
      const script = join(shared, "connect.cjs");
      const out = join(shared, "result.json");
      writeFileSync(
        script,
        `const net=require("net");const fs=require("fs");const done=(r)=>{fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(r));process.exit(0)};` +
          `const s=net.connect(${JSON.stringify(path)});s.on("connect",()=>done({connected:true}));s.on("error",e=>done({connected:false,code:e.code}));setTimeout(()=>done({connected:false,code:"TIMEOUT"}),10000);`,
      );
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$p=ConvertTo-SecureString $env:ARM_PW -AsPlainText -Force;$c=New-Object System.Management.Automation.PSCredential($env:ARM_USER,$p);Start-Process -FilePath $env:ARM_NODE -ArgumentList $env:ARM_SCRIPT -Credential $c -Wait -WorkingDirectory $env:ARM_DIR -LoadUserProfile",
        ],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            ARM_PW: password,
            ARM_USER: user,
            ARM_NODE: process.execPath,
            ARM_SCRIPT: script,
            ARM_DIR: shared,
          },
          timeout: 60_000,
        },
      );
      const result = JSON.parse(readFileSync(out, "utf8")) as {
        connected: boolean;
        code?: string;
      };
      expect(result.connected).toBe(false);
      expect(["EPERM", "EACCES"]).toContain(result.code);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      release(spec);
      try {
        execFileSync("net", ["user", user, "/delete"], { stdio: "ignore" });
      } catch {
        // Already gone.
      }
      rmSync(shared, { recursive: true, force: true });
      delete process.env.ARMADRA_WINSEC_EXE;
    }
  }, 120_000);
});
