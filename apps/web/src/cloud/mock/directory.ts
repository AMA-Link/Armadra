import type { MeStreamEvent } from "@armadra/platform-protocol/cloud-api";

import type { CloudClient } from "../api/client";
import { CloudConsoleError } from "../api/errors";
import {
  MOCK_ACCOUNT,
  MOCK_HOSTS,
  MOCK_PEOPLE,
  MOCK_PERSONAL,
  MOCK_TEAMS,
  type MockHost,
} from "./fixtures";

/**
 * mock 里「个人空间」页（U3）的带状态数据与处理器：主机目录（筛选与游标分页）、链接、设备、
 * 安全日志、改口令与改邮箱、计划与用量。处理器收原始入参，出参由 `create-mock-client.ts`
 * 按契约校验。
 */
type Input = Record<string, unknown>;

export interface DirectoryOptions {
  /** 换掉缺省的七台主机（空态测试用）。 */
  readonly hosts?: readonly MockHost[];
  /** 追加的主机（翻页测试用）。 */
  readonly extraHosts?: readonly MockHost[];
  /** 清空这些数据（空态测试用）。 */
  readonly without?: readonly ("links" | "pending" | "log")[];
  /** 安全日志额外塞多少条（翻页测试用）。 */
  readonly extraLog?: number;
  /** 多一条待信任请求（赵六的 Pixel 9，团队页的多行测试用）。 */
  readonly moreTrust?: boolean;
  /** 种进协议包黄金夹具里的待信任请求号（契约一致性测试的 `trust.reject` 命中它）。 */
  readonly goldenTrust?: boolean;
}

interface Link {
  linkId: string;
  kind: "source_invite";
  label: string;
  role: string;
  sourceId: string;
  url: string;
  uses: number;
  maxUses: number | null;
  expiresAtMs: number;
  createdAtMs: number;
  revokedAtMs: number | null;
}

interface LogEvent {
  eventId: string;
  action: string;
  deviceName: string | null;
  ipPrefix: string | null;
  atMs: number;
}

export interface DirectoryState {
  hosts: MockHost[];
  links: Link[];
  devices: {
    deviceId: string;
    platform: "browser" | "ios" | "desktop" | "android" | "server";
    name: string;
    lastSeenAtMs: number | null;
    current: boolean;
  }[];
  log: LogEvent[];
  without: ReadonlySet<string>;
  /** 已按主机撤销访问的账号。 */
  revokedAccess: Set<string>;
  /** 待信任请求（已被拒绝的从这里删掉）。 */
  trust: TrustEntry[];
}

/** 待信任请求与云端判背书人要用的两项（不出线）：请求者是不是访客、主机所有者是不是本人。 */
interface TrustEntry {
  row: TrustRow;
  guest: boolean;
  hostOwnedBySelf: boolean;
}

type TrustRow = Awaited<
  ReturnType<CloudClient["trust"]["list"]>
>["requests"][number];

/** 当前口令填这个就答 `credentials_invalid`（其余都算对）。 */
export const WRONG_PASSWORD = "wrong";

const DAY = 86_400_000;
const PAGE_DEFAULT = 50;

export function createDirectoryState(
  options: DirectoryOptions,
): DirectoryState {
  const now = Date.now();
  const host = MOCK_PERSONAL.linkHost;
  const without = new Set(options.without);
  const state: DirectoryState = {
    hosts: [
      ...(options.hosts ?? MOCK_HOSTS),
      ...(options.extraHosts ?? []),
    ].map((row) => ({ ...row })),
    links: [
      {
        linkId: "link_one",
        kind: "source_invite",
        label: MOCK_PERSONAL.linkLabel,
        role: "viewer",
        sourceId: host,
        url: "https://app.example.test/j/link_one",
        uses: 2,
        maxUses: 5,
        expiresAtMs: now + 7 * DAY,
        createdAtMs: now - DAY,
        revokedAtMs: null,
      },
      {
        linkId: "link_old",
        kind: "source_invite",
        label: "",
        role: "editor",
        sourceId: host,
        url: "https://app.example.test/j/link_old",
        uses: 5,
        maxUses: null,
        expiresAtMs: now - DAY,
        createdAtMs: now - 9 * DAY,
        revokedAtMs: null,
      },
      {
        // 团队主机 build-01 上的链接（协议包黄金夹具里的链接号）：个人空间的列表里没有它。
        linkId: "lnk_01JAAAAAAAAAAAAAAAAAAAAAAA",
        kind: "source_invite",
        label: "For Bob",
        role: "editor",
        sourceId: MOCK_HOSTS[0]!.sourceId,
        url: "https://app.example.test/j/lnk_01JAAAAAAAAAAAAAAAAAAAAAAA",
        uses: 0,
        maxUses: null,
        expiresAtMs: now + 30 * DAY,
        createdAtMs: now,
        revokedAtMs: null,
      },
    ],
    devices: MOCK_PERSONAL.devices.map((row) => ({
      deviceId: row.deviceId,
      platform: row.platform,
      name: row.name,
      lastSeenAtMs: now - row.minutesAgo * 60_000,
      current: row.current,
    })),
    log: [
      ...MOCK_PERSONAL.log.map((row, index) => ({
        eventId: `evt_${index}`,
        action: row.action,
        deviceName: row.device,
        ipPrefix: row.ip,
        atMs: now - row.minutesAgo * 60_000,
      })),
      ...Array.from({ length: options.extraLog ?? 0 }, (_, index) => ({
        eventId: `evt_extra_${index}`,
        action: "security.login",
        deviceName: "Chrome",
        ipPrefix: "203.0.113.0/24",
        atMs: now - (10_000 + index) * 60_000,
      })),
    ],
    revokedAccess: new Set(),
    trust: without.has("pending")
      ? []
      : trustRows(options.moreTrust === true, options.goldenTrust === true),
    without,
  };
  if (without.has("links")) state.links = [];
  if (without.has("log")) state.log = [];
  return state;
}

/** 待信任请求的样本：没有校验码（云端不经手它）。 */
function trustRows(more: boolean, golden: boolean): TrustEntry[] {
  const now = Date.now();
  const team = MOCK_TEAMS[0]!.teamId;
  const rows: TrustRow[] = [
    {
      requestId: "trust_ipad",
      sourceId: MOCK_PERSONAL.linkHost,
      sourceName: "build-01",
      teamId: team,
      member: {
        accountId: "acct_mock_lisi",
        email: "lisi@example.com",
        displayName: MOCK_PERSONAL.person,
      },
      device: { name: "iPad", platform: "ios" },
      requestedAtMs: now - 600_000,
      expiresAtMs: now + 3_600_000,
    },
  ];
  if (golden)
    rows.push({
      ...rows[0]!,
      requestId: "trq_01JAAAAAAAAAAAAAAAAAAAAAAA",
    });
  if (more)
    rows.push({
      requestId: "trust_pixel",
      sourceId: MOCK_HOSTS[0]!.sourceId,
      sourceName: "build-01",
      teamId: team,
      member: {
        accountId: MOCK_PEOPLE.guest.accountId,
        email: MOCK_PEOPLE.guest.email,
        displayName: MOCK_PEOPLE.guest.displayName,
      },
      device: { name: "Pixel 9", platform: "android" },
      requestedAtMs: now - 120_000,
      expiresAtMs: now + 3_600_000,
    });
  const entries: TrustEntry[] = rows.map((row) => ({
    row,
    guest: row.member.accountId === MOCK_PEOPLE.guest.accountId,
    hostOwnedBySelf:
      MOCK_HOSTS.find((host) => host.sourceId === row.sourceId)?.owner ??
      row.sourceId === MOCK_PERSONAL.linkHost,
  }));
  // 访客的请求只给主机所有者（云端 `isEndorser`）：别人主机上的访客请求本人看不到。
  if (more)
    entries.push({
      row: {
        ...rows[0]!,
        requestId: "trust_galaxy",
        sourceId: MOCK_HOSTS[1]!.sourceId,
        sourceName: "mac-studio",
        member: { ...MOCK_PEOPLE.guest },
        device: { name: "Galaxy S", platform: "android" },
      },
      guest: true,
      hostOwnedBySelf: false,
    });
  return entries;
}

/** 游标就是偏移量；缺省一页 50 条。 */
function page<T>(rows: readonly T[], input: Input) {
  const start = Number(input.cursor ?? 0);
  const limit = typeof input.limit === "number" ? input.limit : PAGE_DEFAULT;
  const next = start + limit;
  return {
    rows: rows.slice(start, next),
    nextCursor: next < rows.length ? String(next) : null,
  };
}

const inSpace = (row: MockHost, space: Input["space"]) => {
  const wanted = space as { kind: string; teamId?: string } | undefined;
  return (
    wanted === undefined ||
    (wanted.kind === "personal"
      ? row.space === undefined
      : row.space?.kind === "team" && row.space.teamId === wanted.teamId)
  );
};

const hostOf = (state: DirectoryState, id: unknown) => {
  const found = state.hosts.find((row) => row.sourceId === id);
  if (!found) throw new CloudConsoleError("not_found", 404);
  return found;
};

export type DirectoryHandler = (input: Input, state: DirectoryState) => unknown;

export const DIRECTORY_HANDLERS: Readonly<Record<string, DirectoryHandler>> = {
  "sources.list": (input, state) => {
    const status = input.status as string | undefined;
    const q = typeof input.q === "string" ? input.q.toLowerCase() : "";
    const tags = (input.tag as string[] | undefined) ?? [];
    const rows = state.hosts.filter(
      (row) =>
        inSpace(row, input.space) &&
        status !== "revoked" &&
        (status === undefined || (status === "online") === row.online) &&
        row.name.toLowerCase().includes(q) &&
        tags.every((tag) => row.tags?.includes(tag)),
    );
    const { rows: sources, nextCursor } = page(rows, input);
    return { sources, nextCursor };
  },
  "sources.update": (input, state) => {
    const row = hostOf(state, input.sourceId);
    if (typeof input.name === "string") row.name = input.name;
    return { ...row, trustedOrigins: [], capabilities: [], registeredAtMs: 0 };
  },
  "sources.revoke": (input, state) => {
    hostOf(state, input.sourceId);
    state.hosts = state.hosts.filter((row) => row.sourceId !== input.sourceId);
    return {};
  },
  "sources.accessList": (input, state) => {
    hostOf(state, input.sourceId);
    return {
      access: [
        {
          accountId: MOCK_ACCOUNT.accountId,
          email: MOCK_ACCOUNT.email,
          via: "owner" as const,
          linkId: null,
          grantedAtMs: Date.now() - 9 * DAY,
        },
        {
          accountId: "acct_mock_lisi",
          email: "lisi@example.com",
          via: "link" as const,
          linkId: "link_one",
          grantedAtMs: Date.now() - DAY,
        },
        {
          accountId: "acct_mock_wangwu",
          email: "wangwu@example.com",
          via: "team" as const,
          linkId: null,
          grantedAtMs: Date.now() - 3 * DAY,
        },
      ].filter((row) => !state.revokedAccess.has(row.accountId)),
    };
  },
  "sources.accessRevoke": (input, state) => {
    hostOf(state, input.sourceId);
    state.revokedAccess.add(String(input.accountId));
    return {};
  },
  "links.list": (input, state) => {
    const space = input.space as { kind: string; teamId?: string } | undefined;
    const links = state.links.filter((link) => {
      const host = state.hosts.find((row) => row.sourceId === link.sourceId);
      return (
        (input.sourceId === undefined || link.sourceId === input.sourceId) &&
        (host === undefined || inSpace(host, space))
      );
    });
    return { links };
  },
  "links.update": (input, state) => {
    const link = state.links.find((row) => row.linkId === input.linkId);
    if (!link) throw new CloudConsoleError("not_found", 404);
    link.label = String(input.label);
    return link;
  },
  "links.revoke": (input, state) => {
    const link = state.links.find((row) => row.linkId === input.linkId);
    if (!link) throw new CloudConsoleError("not_found", 404);
    link.revokedAtMs = Date.now();
    return {};
  },
  "me.devices": (_input, state) => ({
    devices: state.devices.map((row) => ({ ...row })),
  }),
  "me.deviceRevoke": (input, state) => {
    const row = state.devices.find(
      (device) => device.deviceId === input.deviceId,
    );
    // 退出本机不行；已经不在的设备当作退出过了（幂等）。
    if (row?.current) throw new CloudConsoleError("not_found", 404);
    state.devices = state.devices.filter((device) => device !== row);
    return {};
  },
  "me.securityLog": (input, state) => {
    const { rows, nextCursor } = page(state.log, input);
    return { events: rows, nextCursor };
  },
  "me.emailChange": (input) => {
    if (input.password === WRONG_PASSWORD)
      throw new CloudConsoleError("credentials_invalid", 401);
    if (input.newEmail === "taken@example.com")
      throw new CloudConsoleError("email_taken", 409);
    return {};
  },
  "auth.changePassword": (input) => {
    if (input.password === WRONG_PASSWORD)
      throw new CloudConsoleError("credentials_invalid", 401);
    if (String(input.newPassword).length < 8)
      throw new CloudConsoleError("password_too_short", 400);
    return undefined;
  },
  "billing.plan": (input) => ({
    space: input.space,
    plan: "free",
    status: "active" as const,
    seats: 1,
    periodEndsAtMs: null,
  }),
  "billing.usage": (input) => ({
    space: input.space,
    period: "2025-10",
    usage: [
      { metric: "hosts", value: 2, limit: 3 },
      { metric: "traffic", value: 1_288_490_189, limit: 5_368_709_120 },
    ],
  }),
  "trust.list": (input, state) => {
    const space = input.space as { kind: string; teamId?: string } | undefined;
    return {
      requests: state.trust
        .filter(
          (entry) =>
            (!entry.guest || entry.hostOwnedBySelf) &&
            (space === undefined ||
              (space.kind === "team" && entry.row.teamId === space.teamId)),
        )
        .map((entry) => entry.row),
    };
  },
  "trust.reject": (input, state) => {
    const entry = state.trust.find(
      (item) => item.row.requestId === input.requestId,
    );
    if (!entry) throw new CloudConsoleError("not_found", 404);
    state.trust = state.trust.filter((item) => item !== entry);
    return {};
  },
  "invitations.list": (input, state) => ({
    invitations:
      input.box === "received" && !state.without.has("pending")
        ? [
            {
              invitationId: "inv_rd",
              kind: "team" as const,
              email: MOCK_ACCOUNT.email,
              state: "pending" as const,
              teamId: MOCK_TEAMS[0]!.teamId,
              teamRole: "member" as const,
              invitedBy: MOCK_PERSONAL.person,
              createdAtMs: Date.now() - DAY,
              expiresAtMs: Date.now() + 6 * DAY,
              decidedAtMs: null,
            },
          ]
        : [],
  }),
};

/** 测试从外面推一条 me-stream 事件时，让目录状态跟着变，之后的重拉不会把它改回去。 */
export function applyEventToDirectory(
  state: DirectoryState,
  event: MeStreamEvent,
) {
  const row =
    "sourceId" in event
      ? state.hosts.find((host) => host.sourceId === event.sourceId)
      : undefined;
  if (event.type === "sourceOnline" && row) {
    row.online = true;
    row.lastSeenAtMs = event.sinceMs;
  } else if (event.type === "sourceOffline" && row) {
    row.online = false;
    row.lastSeenAtMs = event.atMs;
  } else if (event.type === "sourceRevoked")
    state.hosts = state.hosts.filter((host) => host !== row);
}
