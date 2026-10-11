import { describe, expect, it } from "vitest";
import type { Release } from "@armadra/shared";

import {
  androidUpdate,
  compareVersions,
  isNewer,
  latestAbove,
  managedAssetName,
  managedFallback,
  packageAssets,
  serverUpgradeCommands,
} from "./releases";

function release(version: string, names: string[], sha = true): Release {
  return {
    version,
    tag: `v${version}`,
    publishedAt: "2026-10-20T00:00:00Z",
    prerelease: version.includes("-"),
    notes: "",
    url: `https://github.invalid/releases/v${version}`,
    assets: names.map((name) => ({
      name,
      url: `https://github.invalid/download/v${version}/${name}`,
      size: 1,
      sha256: sha ? "a".repeat(64) : null,
    })),
  };
}

describe("compareVersions", () => {
  it("按 semver 排序，预发布低于正式版", () => {
    expect(compareVersions("0.6.10", "0.6.9")).toBe(1);
    expect(compareVersions("0.6.0-beta.2", "0.6.0")).toBe(-1);
    expect(compareVersions("0.6.0-beta.10", "0.6.0-beta.2")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("不是 semver 的当前版本不让任何发布算作更新", () => {
    expect(isNewer("9.9.9", "dev")).toBe(false);
    expect(isNewer("0.6.1", "0.6.0")).toBe(true);
    expect(isNewer("0.6.0", "0.6.0")).toBe(false);
  });
});

describe("资产", () => {
  it("下载列表去掉清单、签名与摘要", () => {
    const entry = release("0.6.1", [
      "Armadra_0.6.1_darwin-aarch64.dmg",
      "Armadra_0.6.1_darwin-aarch64.zip.sig",
      "latest-darwin-aarch64-mac.yml",
      "latest.json",
      "SHA256SUMS",
      "armadra-mobile_0.6.1_android.apk",
    ]);
    expect(packageAssets(entry).map((asset) => asset.name)).toEqual([
      "Armadra_0.6.1_darwin-aarch64.dmg",
      "armadra-mobile_0.6.1_android.apk",
    ]);
  });

  it("受管安装按平台挑资产名", () => {
    expect(managedAssetName("dmg", "0.6.1", "darwin-aarch64")).toBe(
      "Armadra_0.6.1_darwin-aarch64.dmg",
    );
    expect(managedAssetName("portable", "0.6.1", "windows-x86_64")).toBe(
      "Armadra_0.6.1_windows-x86_64-portable.zip",
    );
    expect(managedAssetName("deb", "0.6.1", "linux-x86_64")).toBe(
      "Armadra_0.6.1_linux-x86_64.deb",
    );
    expect(managedAssetName("pacman", "0.6.1", "linux-x86_64")).toBe(
      "Armadra_0.6.1_linux-x86_64.AppImage",
    );
    expect(managedAssetName("deb", "0.6.1", "darwin-aarch64")).toBeNull();
  });

  it("壳没给下载时从最新发布里补", () => {
    const releases = [
      release("0.6.1", ["Armadra_0.6.1_linux-x86_64.rpm"]),
      release("0.6.0", ["Armadra_0.6.0_linux-x86_64.rpm"]),
    ];
    expect(managedFallback(releases, "0.6.1", "rpm", "linux-x86_64")).toEqual({
      version: "0.6.1",
      url: "https://github.invalid/download/v0.6.1/Armadra_0.6.1_linux-x86_64.rpm",
      notesUrl: "https://github.invalid/releases/v0.6.1",
    });
    expect(managedFallback(releases, null, "rpm", "linux-x86_64")).toBeNull();
    expect(
      managedFallback(releases, "0.6.1", "deb", "linux-x86_64"),
    ).toBeNull();
    expect(managedFallback(releases, "0.6.1", "rpm", null)).toBeNull();
  });
});

describe("Android", () => {
  it("挑比 App 新、带 APK 与 sha256 的最高版本", () => {
    const releases = [
      release("0.7.0", ["armadra-mobile_0.7.0_android.apk"], false),
      release("0.6.2", ["armadra-mobile_0.6.2_android.apk"]),
      release("0.6.1", ["armadra-mobile_0.6.1_android.apk"]),
    ];
    const found = androidUpdate(releases, "0.6.0");
    expect(found?.release.version).toBe("0.6.2");
    expect(found?.sha256).toBe("a".repeat(64));
    expect(androidUpdate(releases, "0.6.2")).toBeNull();
    expect(androidUpdate([release("0.6.1", ["x.apk"])], "0.6.0")).toBeNull();
  });

  it("latestAbove 只看比当前新的", () => {
    const releases = [release("0.6.2", []), release("0.6.1", [])];
    expect(latestAbove(releases, "0.6.1")).toBe("0.6.2");
    expect(latestAbove(releases, "0.6.2")).toBeNull();
  });
});

describe("服务器升级命令", () => {
  it("容器镜像标签与裸机 upgrade 的真实参数", () => {
    const commands = serverUpgradeCommands("0.6.1");
    expect(commands.docker).toBe(
      "docker pull ghcr.io/ama-link/armadra-server:0.6.1",
    );
    expect(commands.binary).toContain("upgrade --binary ");
    expect(commands.binary).toContain("--expect-version 0.6.1 --confirm");
  });
});
