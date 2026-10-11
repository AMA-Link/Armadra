import { describe, expect, it } from "vitest";

import {
  compareVersions,
  digestSha256,
  filterChannel,
  latestVersion,
  parseRelease,
  parseReleases,
  parseVersion,
} from "./releases";
import { githubRelease } from "./github.fixture";

const HEX = "ab".repeat(32);

describe("parseVersion / compareVersions", () => {
  it("认 v 前缀、预发布与构建元数据，拒不是 semver 的标签", () => {
    expect(parseVersion("v0.6.1")).toEqual({
      major: 0,
      minor: 6,
      patch: 1,
      prerelease: [],
    });
    expect(parseVersion("1.2.3-beta.2+build.5")?.prerelease).toEqual([
      "beta",
      "2",
    ]);
    for (const tag of ["", "latest", "v1.2", "v01.2.3", "1.2.3.4", "nightly"]) {
      expect(parseVersion(tag), tag).toBeNull();
    }
  });

  it("按 semver 优先级比较（数字按数值，预发布低于正式版）", () => {
    const ordered = [
      "0.9.0",
      "0.10.0-alpha",
      "0.10.0-alpha.1",
      "0.10.0-alpha.beta",
      "0.10.0-beta.2",
      "0.10.0-beta.11",
      "0.10.0-rc.1",
      "0.10.0",
      "0.10.1",
      "1.0.0",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      const lower = parseVersion(ordered[index - 1] as string)!;
      const higher = parseVersion(ordered[index] as string)!;
      expect(compareVersions(lower, higher), ordered[index]).toBe(-1);
      expect(compareVersions(higher, lower), ordered[index]).toBe(1);
    }
    expect(
      compareVersions(parseVersion("v1.0.0")!, parseVersion("1.0.0+x")!),
    ).toBe(0);
  });
});

describe("parseRelease", () => {
  it("字段改成契约形状，资产带 sha256（来自 digest）", () => {
    const parsed = parseRelease(
      githubRelease("v0.6.1", {
        assets: [
          {
            name: "armadra-mobile_0.6.1_android.apk",
            browser_download_url: "https://example.test/a.apk",
            size: 1234,
            digest: `sha256:${HEX.toUpperCase()}`,
          },
          {
            name: "latest.json",
            browser_download_url: "https://example.test/latest.json",
            size: 10,
            digest: null,
          },
          { name: "", browser_download_url: "https://example.test/x" },
        ],
      }),
    );
    expect(parsed?.release).toEqual({
      version: "0.6.1",
      tag: "v0.6.1",
      publishedAt: "2026-10-20T00:00:00Z",
      prerelease: false,
      notes: "notes v0.6.1",
      url: "https://releases.example.test/tag/v0.6.1",
      assets: [
        {
          name: "armadra-mobile_0.6.1_android.apk",
          url: "https://example.test/a.apk",
          size: 1234,
          sha256: HEX,
        },
        {
          name: "latest.json",
          url: "https://example.test/latest.json",
          size: 10,
          sha256: null,
        },
      ],
    });
  });

  it("草稿与非 semver 标签跳过；带 - 的标签一律算预发布", () => {
    expect(parseRelease(githubRelease("v1.0.0", { draft: true }))).toBeNull();
    expect(parseRelease(githubRelease("nightly"))).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease(githubRelease("v1.0.0-rc.1"))?.release.prerelease).toBe(
      true,
    );
    expect(
      parseRelease(githubRelease("v1.0.0", { prerelease: true }))?.release
        .prerelease,
    ).toBe(true);
  });

  it("没有发布时刻用创建时刻；正文缺省是空串", () => {
    const parsed = parseRelease(
      githubRelease("v1.0.0", { published_at: null, body: null }),
    );
    expect(parsed?.release.publishedAt).toBe("2026-10-19T00:00:00Z");
    expect(parsed?.release.notes).toBe("");
  });

  it("digest 只认 sha256:<64 位十六进制>", () => {
    expect(digestSha256(`sha256:${HEX}`)).toBe(HEX);
    expect(digestSha256("sha512:abcd")).toBeNull();
    expect(digestSha256("sha256:xyz")).toBeNull();
    expect(digestSha256(undefined)).toBeNull();
  });
});

describe("parseReleases / filterChannel / latestVersion", () => {
  const page = [
    githubRelease("v0.5.1"),
    githubRelease("v0.10.0-beta.1"),
    githubRelease("v0.6.0"),
    githubRelease("v0.9.2"),
    githubRelease("0.9.2"),
    githubRelease("garbage"),
  ];

  it("semver 降序，同一版本只留第一条", () => {
    const versions = parseReleases(page).map((entry) => entry.release.version);
    expect(versions).toEqual(["0.10.0-beta.1", "0.9.2", "0.6.0", "0.5.1"]);
    expect(parseReleases(page)[1]?.release.tag).toBe("v0.9.2");
  });

  it("不是数组的文档是错误", () => {
    expect(() => parseReleases({ message: "Not Found" })).toThrow(TypeError);
  });

  it("stable 跳过预发布，beta 全要", () => {
    const all = parseReleases(page);
    expect(
      filterChannel(all, "stable").map((entry) => entry.release.version),
    ).toEqual(["0.9.2", "0.6.0", "0.5.1"]);
    expect(filterChannel(all, "beta")).toHaveLength(4);
  });

  it("latest 是过滤后最高且高于 current 的；没有或 current 不是版本号时是 null", () => {
    const all = parseReleases(page);
    expect(latestVersion(filterChannel(all, "stable"), "0.6.0")).toBe("0.9.2");
    expect(latestVersion(filterChannel(all, "beta"), "0.6.0")).toBe(
      "0.10.0-beta.1",
    );
    expect(latestVersion(filterChannel(all, "stable"), "0.9.2")).toBeNull();
    expect(latestVersion(filterChannel(all, "stable"), "1.0.0")).toBeNull();
    expect(
      latestVersion(filterChannel(all, "stable"), "development"),
    ).toBeNull();
    expect(latestVersion([], "0.1.0")).toBeNull();
    // 正式版高于同号的预发布。
    expect(latestVersion(filterChannel(all, "stable"), "0.9.2-rc.1")).toBe(
      "0.9.2",
    );
  });
});
