import { afterEach, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  HOST_LOG,
  currentSid,
  hostLaunch,
  openHostLog,
  systemWhoami,
} from "./link";

/**
 * The SID behind the session host's pipe name comes from Windows' own
 * `whoami.exe`. A bare `whoami` found Git for Windows' GNU one first on a
 * GitHub Actions bash step (`extra operand '/user'`), and the core could not
 * reach any session host.
 */
describe("this user's SID", () => {
  const scrap: (() => void)[] = [];
  afterEach(() => {
    for (const undo of scrap.splice(0).reverse()) undo();
  });

  it("names whoami.exe under the system root, not whatever PATH finds", () => {
    expect(systemWhoami({ SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\whoami.exe",
    );
    expect(systemWhoami({ windir: "E:\\W" })).toBe(
      "E:\\W\\System32\\whoami.exe",
    );
    expect(systemWhoami({})).toBe("C:\\Windows\\System32\\whoami.exe");
  });

  it.runIf(process.platform === "win32")(
    "is read even with another whoami first on PATH",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "armadra-whoami-"));
      writeFileSync(
        join(directory, "whoami.cmd"),
        "@echo whoami: extra operand '/user'\r\n@exit /b 1\r\n",
      );
      writeFileSync(join(directory, "whoami.exe"), "not a program");
      const path = process.env.PATH;
      process.env.PATH = `${directory}${delimiter}${path ?? ""}`;
      scrap.push(() => {
        process.env.PATH = path;
        rmSync(directory, { recursive: true, force: true });
      });
      expect(currentSid()).toMatch(/^S-1-5-/);
    },
  );
});

/**
 * The host runs without a console, so the file its stderr goes to is the only
 * trace it leaves when it leaves unexpectedly (#659).
 */
describe("the host's log", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-host-log-"));
    dirs.push(dir);
    return dir;
  };

  it("lives in the data directory the host serves", () => {
    const dataDir = scratch();
    const bundle = join(dataDir, "host.cjs");
    writeFileSync(bundle, "");
    const launch = hostLaunch(dataDir, { ARMADRA_SESSION_HOST_BUNDLE: bundle });
    expect(launch.logFile).toBe(join(dataDir, HOST_LOG));
  });

  it("is appended to across starts", () => {
    const file = join(scratch(), HOST_LOG);
    for (const line of ["first\n", "second\n"]) {
      const fd = openHostLog(file);
      expect(fd).toBeDefined();
      writeSync(fd as number, line);
      closeSync(fd as number);
    }
    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
  });

  it("keeps one previous file once it grows past the limit", () => {
    const file = join(scratch(), HOST_LOG);
    writeFileSync(file, "x".repeat(32));
    const fd = openHostLog(file, 16);
    expect(fd).toBeDefined();
    closeSync(fd as number);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(32));
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("is skipped, not fatal, when it cannot be opened", () => {
    const file = join(scratch(), "missing", HOST_LOG);
    expect(openHostLog(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});
