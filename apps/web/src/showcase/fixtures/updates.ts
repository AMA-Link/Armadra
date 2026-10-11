import type { UpdateReleases } from "@armadra/shared";
import type { HostSide } from "@/updates/state";
import type { ShellOffer, ShellUpdateState } from "@/updates/shell-updater";

/**
 * `updates` 分区的假数据（设计展示页 §2.1）：更新设计 §4.1 的十一种状态，各
 * 一对「后台服务的回答 + 桌面壳的状态」，交给真的 `mergeUpdatesState` 去合并。
 * 纯对象，无副作用。
 */

const OFFER: ShellOffer = {
  version: "0.9.0",
  target: "darwin-aarch64",
  manifestUrl: "https://releases.armadra.test/latest-darwin-aarch64-mac.yml",
  packageUrl: "https://releases.armadra.test/Armadra-0.9.0-arm64.zip",
  sha256: "ab".repeat(32),
  sizeBytes: 96 * 1_048_576,
  signed: true,
  notesUrl: "https://releases.armadra.test/notes/0.9.0",
};

const answered = (
  verdict: "upToDate" | "available" | "unavailable",
  reasonCode = "",
): HostSide => ({
  kind: "answered",
  verdict,
  reasonCode,
  retryAfterMs: 0,
  checkedAtMs: Date.UTC(2026, 9, 3, 8, 0, 0),
  release:
    verdict === "available"
      ? {
          version: OFFER.version,
          channel: "stable",
          notesUrl: OFFER.notesUrl,
          sizeBytes: OFFER.sizeBytes,
          signature: "present",
        }
      : null,
});

/** 已安装的版本（只在「当前版本」一行出现）。 */
export const INSTALLED = "0.8.4";

export const UPDATE_STATES: readonly {
  id: string;
  host: HostSide;
  shell: ShellUpdateState;
}[] = [
  {
    id: "notConfigured",
    host: { kind: "notAsked" },
    shell: {
      state: "notConfigured",
      missing: { pubkey: true, endpoints: false },
    },
  },
  {
    id: "localBuild",
    host: { kind: "notAsked" },
    shell: { state: "localBuild" },
  },
  {
    id: "shellUnsupported",
    host: answered("available"),
    shell: { state: "unsupported", reason: "notDesktop" },
  },
  {
    id: "managedPackage",
    host: { kind: "notAsked" },
    shell: {
      state: "unsupported",
      reason: "managedPackage",
      managed: {
        package: "dmg",
        download: {
          version: OFFER.version,
          url: "https://releases.armadra.test/Armadra_0.9.0_darwin-aarch64.dmg",
          notesUrl: OFFER.notesUrl,
        },
      },
    },
  },
  { id: "idle", host: { kind: "notAsked" }, shell: { state: "idle" } },
  { id: "checking", host: { kind: "checking" }, shell: { state: "checking" } },
  {
    id: "upToDate",
    host: answered("upToDate"),
    shell: { state: "upToDate", checkedAtMs: 1 },
  },
  {
    id: "unavailable",
    host: answered("unavailable", "SOURCE_UNREACHABLE"),
    shell: {
      state: "unavailable",
      reason: "sourceUnreachable",
      retryAfterMs: 15 * 60_000,
      checkedAtMs: 1,
    },
  },
  {
    id: "available",
    host: answered("available"),
    shell: { state: "available", offer: OFFER },
  },
  {
    id: "downloading",
    host: answered("available"),
    shell: {
      state: "downloading",
      offer: OFFER,
      receivedBytes: 38 * 1_048_576,
      totalBytes: OFFER.sizeBytes,
    },
  },
  {
    id: "downloaded",
    host: answered("available"),
    shell: { state: "downloaded", offer: OFFER, phase: "ready", problem: null },
  },
  {
    id: "failed",
    host: answered("available"),
    shell: { state: "failed", reason: "digestMismatch", offer: OFFER },
  },
];

const asset = (name: string, size: number) => ({
  name,
  url: `https://releases.armadra.test/download/${name}`,
  size,
  sha256: "cd".repeat(32),
});

/** 版本历史（契约 §64）的一份答案：当前 0.8.4，最新 0.9.0，GitHub 限流中。 */
export const RELEASES: UpdateReleases = {
  current: INSTALLED,
  channel: "stable",
  checkedAt: Date.UTC(2026, 9, 3, 8, 0, 0),
  latest: OFFER.version,
  error: {
    code: "rateLimited",
    message: "rate limited",
    retryAfterMs: 20 * 60_000,
  },
  releases: [
    {
      version: OFFER.version,
      tag: "v0.9.0",
      publishedAt: "2026-10-03T08:00:00Z",
      prerelease: false,
      notes:
        "## 新功能\n\n- 关于页的版本历史\n- 手机端下载并安装新版本\n\n## 修复\n\n- 未签名的安装包也能验证后安装",
      url: OFFER.notesUrl,
      assets: [
        asset("Armadra_0.9.0_darwin-aarch64.dmg", 120 * 1_048_576),
        asset("armadra-mobile_0.9.0_android.apk", 42 * 1_048_576),
      ],
    },
    {
      version: "0.9.0-beta.1",
      tag: "v0.9.0-beta.1",
      publishedAt: "2026-09-28T08:00:00Z",
      prerelease: true,
      notes: "- 预览版",
      url: "https://releases.armadra.test/notes/0.9.0-beta.1",
      assets: [],
    },
    {
      version: INSTALLED,
      tag: `v${INSTALLED}`,
      publishedAt: "2026-09-20T08:00:00Z",
      prerelease: false,
      notes: "- 稳定性修复",
      url: "https://releases.armadra.test/notes/0.8.4",
      assets: [],
    },
  ],
};
