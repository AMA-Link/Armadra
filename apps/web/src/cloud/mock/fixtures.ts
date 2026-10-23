import type { z } from "zod";
import type {
  meSpaceSchema,
  sourceSummarySchema,
} from "@armadra/platform-protocol/cloud-api";

/**
 * mock 的内存数据（云端控制台 §6.3）：一个账号、两个团队、七台主机。名字、邮箱、主机名是
 * 数据不是界面文案；与展示页 `fixtures/cloud.ts` 的人与团队一致。
 */
export type MockSpace = z.infer<typeof meSpaceSchema>;
export type MockHost = z.infer<typeof sourceSummarySchema>;
export type MockRole = "owner" | "admin" | "member" | "billing" | "guest";

export const MOCK_ACCOUNT = {
  accountId: "acct_mock_zhangsan",
  email: "zhangsan@example.com",
  displayName: "张三",
  emailVerified: false,
} as const;

export interface MockTeam {
  readonly teamId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: MockRole;
  readonly plan: string;
}

export const MOCK_TEAMS: readonly MockTeam[] = [
  {
    teamId: "team_mock_rd",
    slug: "rd",
    name: "研发组",
    role: "admin",
    plan: "team",
  },
  {
    teamId: "team_mock_lab",
    slug: "lab",
    name: "Lab",
    role: "member",
    plan: "free",
  },
];

/** 协议包黄金夹具里的主机号：第一台用它，夹具入参能直接命中。 */
const GOLDEN_ID = "0123456789abcdef0123456789abcdef";
const hex = (n: number) =>
  n === 1 ? GOLDEN_ID : n.toString(16).padStart(32, "0");

const host = (
  n: number,
  name: string,
  ownerName: string,
  online: boolean,
  minutesAgo: number,
  team?: MockTeam,
): MockHost => ({
  sourceId: hex(n),
  name,
  kind: n % 3 === 0 ? "server" : "desktop",
  online,
  lastSeenAtMs: Date.UTC(2025, 9, 9, 9, 6) - minutesAgo * 60_000,
  owner: ownerName === MOCK_ACCOUNT.displayName,
  ownerName,
  via: ownerName === MOCK_ACCOUNT.displayName ? "owner" : "team",
  relayOrigin: "https://relay.armadra.test",
  coreVersion: "0.9.3",
  ...(team ? { space: { kind: "team" as const, teamId: team.teamId } } : {}),
});

export const MOCK_HOSTS: readonly MockHost[] = [
  host(1, "build-01", "张三", true, 0, MOCK_TEAMS[0]),
  host(2, "mac-studio", "李四", false, 180, MOCK_TEAMS[0]),
  host(3, "dev-box", "王五", true, 2, MOCK_TEAMS[0]),
  host(4, "gpu-lab", "赵六", true, 5, MOCK_TEAMS[1]),
  host(5, "nas", "张三", false, 4_320),
  host(6, "laptop", "张三", true, 1),
  host(7, "ci-runner", "李四", false, 60, MOCK_TEAMS[1]),
];

/** 角色能满足的团队范围（能力设计 §2.1）。 */
export const ROLE_SCOPES: Readonly<Record<MockRole, readonly string[]>> = {
  owner: ["team:owner", "team:admin", "team:member"],
  admin: ["team:admin", "team:member"],
  member: ["team:member"],
  billing: ["team:billing"],
  guest: [],
};

/** 设备授权页（`/device`）的样本码：`pending` 在等批准，`expired` 已过期，`limited` 猜码被限流；别的都是查无此码。 */
export const MOCK_DEVICE_CODES = {
  pending: "BCDF-GHJK",
  expired: "LMNP-QRST",
  limited: "VWXZ-BCDF",
} as const;

export const MOCK_DEVICE_REQUEST = { name: "build-01" } as const;

/** 分享链接落地页（`/j/`）的样本：`gone` 已失效，`exhausted` 次数用完。 */
export const MOCK_LINK = {
  gone: "gone0000000000aa",
  exhausted: "used0000000000aa",
  sourceName: "studio",
} as const;
