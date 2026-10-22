import type { ConsoleTeam, ConsoleUser } from "@/cloud/shell/model";

/**
 * `cloud` 分区的假数据（云端控制台 §7 U1a）。纯对象；名字、邮箱、主机名是数据
 * 不是界面文案。没有网络、没有数据层——数据层是 U1b。
 */
export const CLOUD_USER: ConsoleUser = {
  name: "张三",
  email: "zhangsan@example.com",
  emailVerified: false,
};

export const CLOUD_TEAMS: readonly ConsoleTeam[] = [
  { slug: "rd", name: "研发组", role: "admin" },
  { slug: "lab", name: "Lab", role: "member" },
];

export const CLOUD_COUNTS = { trust: 2 } as const;

export interface CloudHostRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly online: boolean;
  readonly tags: readonly string[];
  /** 距今分钟数，渲染时转相对时间。 */
  readonly seenMinutesAgo: number;
}

export const CLOUD_HOSTS: readonly CloudHostRow[] = [
  {
    id: "h1",
    name: "build-01",
    owner: "张三",
    online: true,
    tags: ["gpu", "ci"],
    seenMinutesAgo: 0,
  },
  {
    id: "h2",
    name: "mac-studio",
    owner: "李四",
    online: false,
    tags: [],
    seenMinutesAgo: 180,
  },
  {
    id: "h3",
    name: "dev-box",
    owner: "王五",
    online: true,
    tags: ["dev"],
    seenMinutesAgo: 2,
  },
  {
    id: "h4",
    name: "edge-02",
    owner: "张三",
    online: false,
    tags: ["edge"],
    seenMinutesAgo: 2880,
  },
];

/** 配额进度的三档（默认 / ≥80% / 100%）。 */
export const CLOUD_QUOTAS = [
  { tone: "default", value: 42 },
  { tone: "warn", value: 86 },
  { tone: "danger", value: 100 },
] as const;
