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

/** 运营后台的内存数据（名字、邮箱、节点号是数据不是界面文案）。 */
export interface MockOpsAccount {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string;
  readonly plan: string;
  readonly hostCount: number;
  readonly teamCount: number;
  readonly createdAtMs: number;
}

/** 协议包黄金夹具里的运营对象号：契约一致性测试的入参直接命中它们。 */
export const GOLDEN_OPS_ACCOUNT = "acct_01JAAAAAAAAAAAAAAAAAAAAAAA";
export const GOLDEN_OPS_TEAM = "team_01JAAAAAAAAAAAAAAAAAAAAAAA";

export const MOCK_OPS_ACCOUNTS: readonly MockOpsAccount[] = [
  {
    accountId: GOLDEN_OPS_ACCOUNT,
    email: "dev@example.com",
    displayName: "Dev",
    plan: "free",
    hostCount: 1,
    teamCount: 0,
    createdAtMs: Date.UTC(2025, 5, 1),
  },
  {
    accountId: MOCK_ACCOUNT.accountId,
    email: MOCK_ACCOUNT.email,
    displayName: MOCK_ACCOUNT.displayName,
    plan: "free",
    hostCount: 3,
    teamCount: 2,
    createdAtMs: Date.UTC(2025, 0, 9),
  },
  {
    accountId: "acct_mock_lisi",
    email: "lisi@example.com",
    displayName: "李四",
    plan: "free",
    hostCount: 2,
    teamCount: 1,
    createdAtMs: Date.UTC(2025, 2, 2),
  },
];

export interface MockOpsNode {
  readonly node: string;
  readonly region: string;
  readonly online: boolean;
  readonly tunnels: number;
  readonly connections: number;
  readonly draining: boolean;
  readonly lastSeenAtMs: number | null;
}

export const MOCK_OPS_NODES: readonly MockOpsNode[] = [
  {
    node: "relay-1",
    region: "ap-east",
    online: true,
    tunnels: 1,
    connections: 2,
    draining: false,
    lastSeenAtMs: Date.UTC(2025, 9, 9, 9, 4),
  },
  {
    node: "relay-hk-1",
    region: "hk",
    online: true,
    tunnels: 12,
    connections: 31,
    draining: false,
    lastSeenAtMs: Date.UTC(2025, 9, 9, 9, 5),
  },
  {
    node: "relay-sg-1",
    region: "sg",
    online: true,
    tunnels: 4,
    connections: 6,
    draining: true,
    lastSeenAtMs: Date.UTC(2025, 9, 9, 9, 5),
  },
  {
    node: "relay-us-1",
    region: "us",
    online: false,
    tunnels: 0,
    connections: 0,
    draining: false,
    lastSeenAtMs: Date.UTC(2025, 9, 8, 22, 0),
  },
];
