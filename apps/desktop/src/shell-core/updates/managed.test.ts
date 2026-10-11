import { describe, expect, it } from "vitest";

import {
  NSIS_UNINSTALLER,
  detectManagedPackage,
  managedAssetName,
  managedDownload,
  type InstallFacts,
} from "./managed";

function facts(overrides: Partial<InstallFacts>): InstallFacts {
  return {
    platform: "darwin",
    execPath: "/Applications/Armadra.app/Contents/MacOS/armadra",
    resourcesPath: "/Applications/Armadra.app/Contents/Resources",
    env: {},
    exists: () => false,
    read: () => null,
    ...overrides,
  };
}

describe("detectManagedPackage", () => {
  it("macOS: an app in Applications is ours to replace", () => {
    expect(detectManagedPackage(facts({}))).toBeNull();
  });

  it("macOS: running from the mounted dmg or a translocated copy is not", () => {
    expect(
      detectManagedPackage(
        facts({
          execPath: "/Volumes/Armadra/Armadra.app/Contents/MacOS/armadra",
        }),
      ),
    ).toBe("dmg");
    expect(
      detectManagedPackage(
        facts({
          execPath:
            "/private/var/folders/x/AppTranslocation/ABC/d/Armadra.app/Contents/MacOS/armadra",
        }),
      ),
    ).toBe("dmg");
  });

  it("Windows: an NSIS install leaves its uninstaller beside the executable", () => {
    const execPath =
      "C:\\Users\\a\\AppData\\Local\\Programs\\Armadra\\Armadra.exe";
    const seen: string[] = [];
    expect(
      detectManagedPackage(
        facts({
          platform: "win32",
          execPath,
          exists: (path) => {
            seen.push(path);
            return path.endsWith(NSIS_UNINSTALLER);
          },
        }),
      ),
    ).toBeNull();
    expect(seen).toEqual([
      `C:\\Users\\a\\AppData\\Local\\Programs\\Armadra\\${NSIS_UNINSTALLER}`,
    ]);
  });

  it("Windows: the portable zip has no uninstaller, the portable target sets its variable", () => {
    expect(
      detectManagedPackage(
        facts({
          platform: "win32",
          execPath: "D:\\tools\\Armadra\\Armadra.exe",
        }),
      ),
    ).toBe("portable");
    expect(
      detectManagedPackage(
        facts({
          platform: "win32",
          execPath: "C:\\Temp\\x\\Armadra.exe",
          env: { PORTABLE_EXECUTABLE_DIR: "D:\\" },
          exists: () => true,
        }),
      ),
    ).toBe("portable");
  });

  it("Linux: AppImage is ours, deb / rpm / pacman belong to the package manager", () => {
    const linux = {
      platform: "linux",
      execPath: "/opt/Armadra/armadra",
      resourcesPath: "/opt/Armadra/resources",
    };
    expect(
      detectManagedPackage(
        facts({ ...linux, env: { APPIMAGE: "/home/a/Armadra.AppImage" } }),
      ),
    ).toBeNull();
    for (const type of ["deb", "rpm", "pacman"] as const) {
      expect(
        detectManagedPackage(
          facts({
            ...linux,
            read: (path) =>
              path === "/opt/Armadra/resources/package-type"
                ? `${type}\n`
                : null,
          }),
        ),
      ).toBe(type);
    }
    // Neither: an unpacked copy nothing installed.
    expect(detectManagedPackage(facts(linux))).toBe("portable");
  });
});

describe("managedAssetName", () => {
  it("names the asset the release publishes for each kind", () => {
    expect(managedAssetName("dmg", "0.6.1", "darwin-aarch64")).toBe(
      "Armadra_0.6.1_darwin-aarch64.dmg",
    );
    expect(managedAssetName("portable", "0.6.1", "windows-x86_64")).toBe(
      "Armadra_0.6.1_windows-x86_64-portable.zip",
    );
    expect(managedAssetName("deb", "0.6.1", "linux-x86_64")).toBe(
      "Armadra_0.6.1_linux-x86_64.deb",
    );
    expect(managedAssetName("rpm", "0.6.1", "linux-aarch64")).toBe(
      "Armadra_0.6.1_linux-aarch64.rpm",
    );
    expect(managedAssetName("pacman", "0.6.1", "linux-x86_64")).toBe(
      "Armadra_0.6.1_linux-x86_64.AppImage",
    );
    expect(managedAssetName("deb", "0.6.1", "darwin-aarch64")).toBeNull();
  });
});

describe("managedDownload", () => {
  const base = "https://github.com/AMA-Link/Armadra/releases/download";
  const release = (tag: string, names: string[], prerelease = false) => ({
    tag_name: tag,
    draft: false,
    prerelease,
    html_url: `https://github.com/AMA-Link/Armadra/releases/tag/${tag}`,
    assets: names.map((name) => ({
      name,
      browser_download_url: `${base}/${tag}/${name}`,
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
    })),
  });
  const query = {
    channel: "stable" as const,
    currentVersion: "0.6.0",
    target: "linux-x86_64",
    checkedAtMs: 1,
  };

  it("offers the newest release's matching installer", () => {
    const index = [
      release("v0.6.1", [
        "Armadra_0.6.1_linux-x86_64.deb",
        "Armadra_0.6.1_linux-x86_64.AppImage",
      ]),
      release("v0.7.0-beta.1", ["Armadra_0.7.0-beta.1_linux-x86_64.deb"], true),
    ];
    expect(managedDownload(index, query, "deb")).toEqual({
      version: "0.6.1",
      url: `${base}/v0.6.1/Armadra_0.6.1_linux-x86_64.deb`,
      notesUrl: "https://github.com/AMA-Link/Armadra/releases/tag/v0.6.1",
    });
    expect(
      managedDownload(index, { ...query, channel: "beta" }, "deb")?.version,
    ).toBe("0.7.0-beta.1");
  });

  it("is nothing when there is no newer release or no such asset", () => {
    expect(
      managedDownload(
        [release("v0.6.0", ["Armadra_0.6.0_linux-x86_64.deb"])],
        query,
        "deb",
      ),
    ).toBeNull();
    expect(
      managedDownload(
        [release("v0.6.1", ["Armadra_0.6.1_linux-x86_64.AppImage"])],
        query,
        "rpm",
      ),
    ).toBeNull();
    expect(managedDownload("garbage", query, "deb")).toBeNull();
  });
});
