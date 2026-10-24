import type { MeStreamEvent } from "@armadra/platform-protocol/cloud-api";

/**
 * 查询键工厂（云端控制台 §6.2）。全部以 `["cloud", …]` 开头，登出时
 * `removeQueries({ queryKey: cloudKeys.all })`。空间键：个人 `"me"`，团队 `"t:<teamId>"`。
 */
export type SpaceKey = "me" | `t:${string}`;

export const spaceKey = (teamId?: string): SpaceKey =>
  teamId === undefined ? "me" : `t:${teamId}`;

type Filters = Readonly<Record<string, unknown>> | undefined;

export const cloudKeys = {
  all: ["cloud"] as const,
  me: ["cloud", "me"] as const,
  spaces: ["cloud", "spaces"] as const,
  devices: ["cloud", "devices"] as const,
  securityLog: (cursor?: string) =>
    ["cloud", "securityLog", cursor ?? null] as const,
  hosts: (space: SpaceKey, filters?: Filters) =>
    ["cloud", space, "hosts", filters ?? {}] as const,
  host: (space: SpaceKey, hostId: string) =>
    ["cloud", space, "host", hostId] as const,
  access: (space: SpaceKey, hostId: string) =>
    ["cloud", space, "access", hostId] as const,
  /** 某人对某台主机的有效权限；挂在 `access` 之下，随它一起失效。 */
  effective: (space: SpaceKey, hostId: string, accountId: string) =>
    ["cloud", space, "access", hostId, "effective", accountId] as const,
  grants: (space: SpaceKey, filters?: Filters) =>
    ["cloud", space, "grants", filters ?? {}] as const,
  members: (space: SpaceKey) => ["cloud", space, "members"] as const,
  invitations: (space: SpaceKey) => ["cloud", space, "invitations"] as const,
  groups: (space: SpaceKey) => ["cloud", space, "groups"] as const,
  group: (space: SpaceKey, id: string) =>
    ["cloud", space, "group", id] as const,
  requests: (space: SpaceKey, state?: string) =>
    ["cloud", space, "requests", state ?? "pending"] as const,
  links: (space: SpaceKey, filters?: Filters) =>
    ["cloud", space, "links", filters ?? {}] as const,
  trust: (space: SpaceKey) => ["cloud", space, "trust"] as const,
  /**
   * 本浏览器是不是某台主机的受信设备（背书人判定），以及被主机拒绝背书的请求。**不挂在 `trust`
   * 之下**：`deviceTrustRequested` 只让列表过期；判定要是跟着重判，每次判定都可能引出新请求，
   * 形成「重判 → 事件 → 重判」的回环。
   */
  endorse: (space: SpaceKey, sourceId: string) =>
    ["cloud", space, "endorse", sourceId] as const,
  endorseRefused: (space: SpaceKey, requestId: string) =>
    ["cloud", space, "endorse-refused", requestId] as const,
  audit: (space: SpaceKey, filters?: Filters, cursor?: string) =>
    ["cloud", space, "audit", filters ?? {}, cursor ?? null] as const,
  plan: (space: SpaceKey) => ["cloud", space, "plan"] as const,
  usage: (space: SpaceKey) => ["cloud", space, "usage"] as const,
  settings: (space: SpaceKey) => ["cloud", space, "settings"] as const,
  tokens: (space: SpaceKey) => ["cloud", space, "tokens"] as const,
  ops: (...rest: readonly unknown[]) => ["cloud", "ops", ...rest] as const,
};

type Key = readonly unknown[];

/** 键前缀匹配：`["cloud", space, kind, id?]`；`space` 缺省 = 任一空间。 */
const under =
  (kind: string, space?: SpaceKey, id?: string) =>
  (key: Key): boolean =>
    key[0] === "cloud" &&
    (space === undefined || key[1] === space) &&
    key[2] === kind &&
    (id === undefined || key[3] === id);

/**
 * me-stream 事件 → 要重拉的查询（§6.2 第三列），给 `queryClient.invalidateQueries({ predicate })`。
 * 事件没有 `teamId` 就是个人空间；撤销类事件不报空间，作用于全部空间。上下线是就地改缓存
 * （U3 的主机目录），不在这里。
 */
export function invalidationsFor(
  event: MeStreamEvent,
): readonly ((key: Key) => boolean)[] {
  const space = (teamId?: string) =>
    teamId === undefined ? "me" : spaceKey(teamId);
  switch (event.type) {
    case "memberChanged":
      return [
        (key) => key[1] === "spaces",
        under("members", space(event.teamId)),
      ];
    case "invitationChanged":
      return [
        (key) => key[1] === "spaces",
        under("invitations", space(event.teamId)),
        // 我收到的邀请在个人空间的键下（概览的待处理）。
        under("invitations", "me"),
      ];
    case "grantChanged":
      return [
        under("grants", space(event.teamId)),
        under("access", space(event.teamId), event.sourceId),
        // 成员能不能看到这台主机随授予变：目录与详情一并重拉。
        under("hosts", space(event.teamId)),
        under("host", space(event.teamId), event.sourceId),
      ];
    case "accessRevoked":
      // 撤销类事件不报空间：访问清单、有效权限、授予列表，以及本人看得到的主机目录与详情都重拉。
      return [
        under("access", undefined, event.sourceId),
        under("grants"),
        under("hosts"),
        under("host", undefined, event.sourceId),
      ];
    case "accessRequested":
      return [under("requests", space(event.teamId))];
    case "linkUsed":
      return [under("links", space(event.teamId))];
    // 只让请求列表过期；背书判定（`endorse`）不在其中，见 `cloudKeys.endorse`。
    case "deviceTrustRequested":
      return [under("trust", space(event.teamId)), under("trust", "me")];
    case "deviceTrustResolved":
      return [under("trust")];
    case "planChanged": {
      const plan =
        event.space.kind === "team" ? spaceKey(event.space.teamId) : "me";
      return [under("plan", plan), under("usage", plan)];
    }
    default:
      return [];
  }
}
