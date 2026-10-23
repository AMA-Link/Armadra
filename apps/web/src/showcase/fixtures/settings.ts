import type { HostResources, UsageProvider } from "@armadra/shared";

/**
 * `settings` 分区的假数据（设计展示页 §2.1，设计系统 §5.17）：用量托盘、本机服务托盘、
 * 导航徽标。纯对象，无副作用；时钟钉在 {@link NOW}，倒计时每次截图都一样。
 */

export const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);

const iso = (offsetMinutes: number): string =>
  new Date(NOW + offsetMinutes * 60_000).toISOString();

/** 三家各一种形态：高占用（warn）· 正常带余额 · 取不到（`—` + 失败胶囊）。 */
export const USAGE_PROVIDERS: readonly UsageProvider[] = [
  {
    id: "claude",
    status: "ok",
    windows: [
      { key: "five_hour", label: "5h", usedPercent: 82, resetsAt: iso(134) },
      { key: "seven_day", label: "7d", usedPercent: 41, resetsAt: iso(3_100) },
    ],
    fetchedAt: iso(-1),
  },
  {
    id: "codex",
    status: "ok",
    windows: [
      { key: "primary", label: "5h", usedPercent: 41, resetsAt: iso(75) },
    ],
    credits: { balance: 1200 },
    fetchedAt: iso(-1),
  },
  {
    id: "copilot",
    status: "error",
    reason: "network",
    windows: [],
    fetchedAt: null,
  },
];

const GB = 1024 ** 3;

/** 内存与磁盘高占用（warn / danger 刻度）。 */
export const SERVICE_RESOURCES: HostResources = {
  hostId: "local",
  location: "local",
  platform: "darwin",
  cpuPercent: 37.5,
  cpuCores: 12,
  memory: {
    totalBytes: 32 * GB,
    usedBytes: 27 * GB,
    availableBytes: 5 * GB,
    swapTotalBytes: 4 * GB,
    swapUsedBytes: 0,
    pressure: "normal",
  },
  loadAverage: { one: 2.1, five: 1.8, fifteen: 1.5 },
  disk: {
    mountPoint: "/",
    totalBytes: 1024 * GB,
    availableBytes: 40 * GB,
  },
  power: { source: "ac", batteryPercent: null, charging: null },
  uptimeSeconds: 3 * 86_400 + 5 * 3_600,
  sampledAt: iso(0),
};

/** 这台机器测不出来的指标：全是 `null`，托盘写 `—` 且不画刻度。 */
export const SERVICE_RESOURCES_UNKNOWN: HostResources = {
  ...SERVICE_RESOURCES,
  cpuPercent: null,
  cpuCores: null,
  memory: {
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    swapTotalBytes: null,
    swapUsedBytes: null,
    pressure: null,
  },
  loadAverage: null,
  disk: null,
  uptimeSeconds: null,
};

/** 外壳样本里导航行尾的徽标：计数与提示点各一。 */
export const NAV_BADGES = {
  notifications: { kind: "count", count: 3 },
  agents: { kind: "count", count: 1 },
  service: { kind: "dot", tone: "attention" },
} as const;
