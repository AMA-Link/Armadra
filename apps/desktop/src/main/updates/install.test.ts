/**
 * 未签名包的安装步骤：脚本生成与参数、Windows 安装器参数，以及在 macOS 上
 * 用真的 `ditto` / `plutil` / `/bin/sh` 走一遍解压、核对版本与替换。
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAC_HELPER_NAME,
  MAC_HELPER_SCRIPT,
  appBundleOf,
  assetNameOf,
  macHelperArgs,
  stagedFileName,
} from "../../shell-core/updates/install-plan";
import {
  launchMacHelper,
  launchWindowsInstaller,
  stageMacBundle,
} from "./install";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "armadra-install-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("the install plan", () => {
  it("passes every path as an argument, never inside the script", () => {
    const args = macHelperArgs({
      script: "/w/update-helper.sh",
      pid: 42,
      installed: "/Applications/Armadra.app",
      replacement: "/w/new/Armadra.app",
      workDir: "/w",
    });
    expect(args).toEqual([
      "/w/update-helper.sh",
      "42",
      "/Applications/Armadra.app",
      "/w/new/Armadra.app",
      "/w",
    ]);
    expect(MAC_HELPER_SCRIPT).not.toContain("/Applications");
    expect(MAC_HELPER_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    // Replaced with ditto, quarantine removed, relaunched.
    expect(MAC_HELPER_SCRIPT).toContain('/usr/bin/ditto "$source" "$target"');
    expect(MAC_HELPER_SCRIPT).toContain("com.apple.quarantine");
    expect(MAC_HELPER_SCRIPT).toContain('"$opener" "$target"');
  });

  it("finds the running bundle only in the shape a bundle has", () => {
    expect(
      appBundleOf("/Applications/Armadra.app/Contents/MacOS/armadra"),
    ).toBe("/Applications/Armadra.app");
    expect(appBundleOf("/usr/local/bin/armadra")).toBeNull();
    expect(appBundleOf("/opt/x/Contents/MacOS/armadra")).toBeNull();
  });

  it("names the staged file after the asset, safely", () => {
    const url =
      "https://github.com/AMA-Link/Armadra/releases/download/v0.6.1/Armadra_0.6.1_darwin-aarch64.zip";
    expect(assetNameOf(url)).toBe("Armadra_0.6.1_darwin-aarch64.zip");
    expect(stagedFileName(url)).toBe("Armadra_0.6.1_darwin-aarch64.zip");
    expect(stagedFileName("https://x.invalid/a/..%2F..%2Fetc")).toBe("_.._etc");
    expect(stagedFileName("https://x.invalid/")).toBe("update.bin");
  });

  it("runs the NSIS installer silently as an update, relaunching after", () => {
    const installer = join(work, "Armadra_0.6.1_windows-x86_64-setup.exe");
    writeFileSync(installer, "MZ");
    const spawned: [string, readonly string[]][] = [];
    expect(
      launchWindowsInstaller(installer, (command, args) =>
        spawned.push([command, args]),
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(spawned).toEqual([[installer, ["--updated", "/S", "--force-run"]]]);
    expect(
      launchWindowsInstaller(join(work, "missing.exe"), () => undefined),
    ).toEqual({ ok: false, reason: "installFailed" });
  });

  it("writes the helper beside the work it does and starts it with sh", () => {
    const spawned: [string, readonly string[]][] = [];
    const result = launchMacHelper(
      {
        pid: 7,
        installed: "/Applications/Armadra.app",
        replacement: join(work, "new", "Armadra.app"),
        workDir: work,
      },
      (command, args) => spawned.push([command, args]),
    );
    expect(result.ok).toBe(true);
    const script = join(work, MAC_HELPER_NAME);
    expect(readFileSync(script, "utf8")).toBe(MAC_HELPER_SCRIPT);
    expect(statSync(script).mode & 0o777).toBe(0o700);
    expect(spawned[0]?.[0]).toBe("/bin/sh");
    expect(spawned[0]?.[1][0]).toBe(script);
  });
});

/** A fake `.app` with a version, as electron-builder lays one out. */
function fakeApp(parent: string, version: string, marker: string): string {
  const app = join(parent, "Armadra.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`,
  );
  writeFileSync(join(app, "Contents", "MacOS", "armadra"), marker);
  return app;
}

describe.runIf(process.platform === "darwin")("on macOS, for real", () => {
  function zipOf(version: string): string {
    const source = join(work, `src-${version}`);
    mkdirSync(source);
    const app = fakeApp(source, version, `new ${version}`);
    const zip = join(work, `Armadra-${version}.zip`);
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    return zip;
  }

  it("unpacks the zip and accepts the bundle only at the offered version", async () => {
    const zip = zipOf("0.6.1");
    const staged = await stageMacBundle(zip, "0.6.1", join(work, "w"));
    expect(staged).toEqual({
      ok: true,
      value: join(work, "w", "new", "Armadra.app"),
    });
    expect(await stageMacBundle(zip, "0.7.0", join(work, "w2"))).toEqual({
      ok: false,
      reason: "sourceMalformed",
    });
    writeFileSync(join(work, "broken.zip"), "not a zip");
    expect(
      await stageMacBundle(join(work, "broken.zip"), "0.6.1", join(work, "w3")),
    ).toEqual({ ok: false, reason: "installFailed" });
  });

  /** Runs the helper to completion against a process that already exited. */
  function runHelper(
    installed: string,
    replacement: string,
    helperWork: string,
  ) {
    mkdirSync(helperWork, { recursive: true });
    const opened = join(work, "opened");
    const opener = join(work, "opener.sh");
    writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${opened}"\n`, {
      mode: 0o755,
    });
    const gone = spawnSync("/usr/bin/true");
    const script = join(helperWork, MAC_HELPER_NAME);
    writeFileSync(script, MAC_HELPER_SCRIPT, { mode: 0o700 });
    const result = spawnSync(
      "/bin/sh",
      macHelperArgs({
        script,
        pid: gone.pid ?? 999_999,
        installed,
        replacement,
        workDir: helperWork,
        opener,
      }),
      { encoding: "utf8", timeout: 30_000 },
    );
    return {
      status: result.status,
      opened: existsSync(opened) ? readFileSync(opened, "utf8").trim() : "",
    };
  }

  it("replaces the installed app and relaunches it", () => {
    const apps = join(work, "Applications");
    mkdirSync(apps);
    const installed = fakeApp(apps, "0.6.0", "old");
    const fresh = join(work, "fresh");
    mkdirSync(fresh);
    const replacement = fakeApp(fresh, "0.6.1", "new");
    const helperWork = join(work, "helper");
    const outcome = runHelper(installed, replacement, helperWork);
    expect(outcome).toEqual({ status: 0, opened: installed });
    expect(
      readFileSync(join(installed, "Contents", "MacOS", "armadra"), "utf8"),
    ).toBe("new");
    // Nothing left behind: no previous copy, no work directory.
    expect(existsSync(join(apps, ".Armadra.app.previous"))).toBe(false);
    expect(existsSync(helperWork)).toBe(false);
  });

  it("puts the previous app back when the copy fails", () => {
    const apps = join(work, "Applications");
    mkdirSync(apps);
    const installed = fakeApp(apps, "0.6.0", "old");
    const helperWork = join(work, "helper");
    const outcome = runHelper(
      installed,
      join(work, "does-not-exist.app"),
      helperWork,
    );
    expect(outcome).toEqual({ status: 1, opened: installed });
    expect(
      readFileSync(join(installed, "Contents", "MacOS", "armadra"), "utf8"),
    ).toBe("old");
    expect(readFileSync(join(helperWork, "helper.log"), "utf8")).toMatch(
      /restoring the previous one/,
    );
  });
});
