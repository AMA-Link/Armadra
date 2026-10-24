import type { CloudClient } from "../api/client";
import { MOCK_HOSTS, MOCK_PEOPLE, MOCK_ACCOUNT, MOCK_TEAMS } from "./fixtures";

/**
 * mock 里「团队审计」的带状态数据与处理器（云端控制台 §3.3.10，U6）：规则对照云端
 * `go/internal/cloud/audit`——筛选 `fromMs`（含）/ `toMs`（不含）/ `actor` / `sourceId` /
 * `action`（前缀），最新的在前，游标分页（一页缺省 100）。只记主体、动作、对象、时间与 IP 前缀。
 * 处理器收原始入参，出参由 `create-mock-client.ts` 按契约校验。
 */
type Input = Record<string, unknown>;
type Event = Awaited<
  ReturnType<CloudClient["audit"]["list"]>
>["events"][number];

interface Row extends Event {
  sourceId?: string;
}

export interface AuditOptions {
  /** 清空审计（空态测试用）。 */
  readonly noAudit?: boolean;
  /** 额外塞多少条（虚拟列表与翻页测试用）。 */
  readonly extraAudit?: number;
}

export interface AuditState {
  rows: Row[];
}

const MIN = 60_000;
const DAY = 86_400_000;
const TEAM = MOCK_TEAMS[0]!.teamId;
const SELF = MOCK_ACCOUNT.accountId;
const BUILD = MOCK_HOSTS[0]!.sourceId;
const STUDIO = MOCK_HOSTS[1]!.sourceId;

const account = (id: string) => ({ kind: "account" as const, id });

export function createAuditState(options: AuditOptions): AuditState {
  if (options.noAudit) return { rows: [] };
  const now = Date.now();
  const at = (minutes: number) => now - minutes * MIN;
  const rows: Row[] = [
    {
      eventId: "evt_a01",
      teamId: TEAM,
      actor: account(SELF),
      action: "grant.create",
      target: { kind: "grant", id: "grant_mock_one" },
      jti: null,
      ipPrefix: "203.0.113.0/24",
      atMs: at(3),
      sourceId: BUILD,
    },
    {
      eventId: "evt_a02",
      teamId: TEAM,
      actor: account(MOCK_PEOPLE.owner.accountId),
      action: "assertion.issue",
      target: { kind: "host", id: STUDIO },
      jti: "jti_01JMOCKASSERTION0000000001",
      ipPrefix: "198.51.100.0/24",
      atMs: at(25),
      sourceId: STUDIO,
    },
    {
      eventId: "evt_a03",
      teamId: TEAM,
      actor: account(SELF),
      action: "member.role",
      target: { kind: "account", id: MOCK_PEOPLE.member.accountId },
      jti: null,
      ipPrefix: "203.0.113.0/24",
      atMs: at(90),
    },
    {
      eventId: "evt_a04",
      teamId: TEAM,
      actor: account(SELF),
      action: "invitation.create",
      target: { kind: "invitation", id: "tinv_mock_qian" },
      jti: null,
      ipPrefix: "203.0.113.0/24",
      atMs: at(300),
    },
    {
      eventId: "evt_a05",
      teamId: TEAM,
      actor: account(MOCK_PEOPLE.owner.accountId),
      action: "link.create",
      target: { kind: "link", id: "lnk_mock_bob" },
      jti: null,
      ipPrefix: "198.51.100.0/24",
      atMs: at(600),
      sourceId: BUILD,
    },
    {
      eventId: "evt_a06",
      teamId: TEAM,
      actor: { kind: "system", id: null },
      action: "grant.expire",
      target: { kind: "grant", id: "grant_mock_old" },
      jti: null,
      ipPrefix: null,
      atMs: at(1_500),
      sourceId: BUILD,
    },
    {
      eventId: "evt_a07",
      teamId: TEAM,
      actor: { kind: "api_token", id: "tok_mock_ci" },
      action: "host.update",
      target: { kind: "host", id: BUILD },
      jti: null,
      ipPrefix: "192.0.2.0/24",
      atMs: at(2_880),
      sourceId: BUILD,
    },
    {
      eventId: "evt_a08",
      teamId: TEAM,
      actor: account(SELF),
      action: "future.unknown_action",
      target: null,
      jti: null,
      ipPrefix: null,
      atMs: at(4_000),
    },
    {
      // 7 天之外：缺省范围里没有，30 天范围里有。
      eventId: "evt_a09",
      teamId: TEAM,
      actor: account(SELF),
      action: "team.settings",
      target: { kind: "team", id: TEAM },
      jti: null,
      ipPrefix: "203.0.113.0/24",
      atMs: now - 20 * DAY,
    },
  ];
  for (let index = 0; index < (options.extraAudit ?? 0); index += 1)
    rows.push({
      eventId: `evt_x${String(index).padStart(4, "0")}`,
      teamId: TEAM,
      actor: account(SELF),
      action: "grant.update",
      target: { kind: "grant", id: `grant_x${index}` },
      jti: null,
      ipPrefix: "203.0.113.0/24",
      atMs: at(100 + index),
      sourceId: BUILD,
    });
  return { rows };
}

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

export const AUDIT_HANDLERS: Readonly<
  Record<string, (input: Input, state: AuditState) => unknown>
> = {
  "audit.list": (input, state) => {
    const from = Number(input.fromMs ?? 0);
    const to = input.toMs === undefined ? Infinity : Number(input.toMs);
    const actor = text(input.actor);
    const sourceId = text(input.sourceId);
    const prefix = text(input.action);
    const matched = state.rows
      .filter(
        (row) =>
          row.atMs >= from &&
          row.atMs < to &&
          (actor === undefined || row.actor.id === actor) &&
          (sourceId === undefined || row.sourceId === sourceId) &&
          (prefix === undefined || row.action.startsWith(prefix)),
      )
      .sort((a, b) => b.atMs - a.atMs || b.eventId.localeCompare(a.eventId));
    const start = Number(input.cursor ?? 0);
    const limit = Number(input.limit ?? 100);
    const slice = matched.slice(start, start + limit);
    return {
      events: slice.map(({ sourceId: _source, ...event }) => event),
      nextCursor: start + limit < matched.length ? String(start + limit) : null,
    };
  },
};
