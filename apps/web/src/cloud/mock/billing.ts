import { CloudConsoleError } from "../api/errors";
import { MOCK_TEAMS } from "./fixtures";
import { roleIn, type TeamsState } from "./teams";

/**
 * mock 里「计划与用量」的处理器（云端控制台 §3.3.11，U6）。规则对照云端 `go/internal/cloud/billing`：
 * 个人空间由本人看；团队空间只放 owner 与 billing（`teams.MinBilling`），其余角色答
 * `team_role_insufficient`；`periodEndsAtMs` 总是带（Free 也有本周期结束日，页面不显示它）；
 * 席位 = 非访客成员数；同时连接目前云端恒报 0；`granularity = "day"` 给本计费周期每天一条，未到的天是 0。
 */
type Input = Record<string, unknown>;

const GB = 1_073_741_824;
const DAY = 86_400_000;

const teamOf = (space: unknown) => {
  const wire = space as { kind?: string; teamId?: string } | undefined;
  return wire?.kind === "team"
    ? MOCK_TEAMS.find((team) => team.teamId === wire.teamId)
    : undefined;
};

function guard(input: Input, state: TeamsState) {
  const team = teamOf(input.space);
  if (!team) return undefined;
  const role = roleIn(state, team.teamId);
  if (role !== "owner" && role !== "billing")
    throw new CloudConsoleError("team_role_insufficient", 403);
  return team;
}

/** 各空间的用量样本：个人 Free；研发组（团队版）宽松；Lab（Free）主机用尽、成员接近、流量超出。 */
function usageFor(slug: string | undefined) {
  if (slug === "rd")
    return [
      { metric: "hosts" as const, value: 7, limit: 9 },
      { metric: "members" as const, value: 6, limit: null },
      { metric: "guests" as const, value: 2, limit: 6 },
      { metric: "concurrent" as const, value: 0, limit: 60 },
      { metric: "traffic" as const, value: 38 * GB, limit: 150 * GB },
    ];
  if (slug === "lab")
    return [
      { metric: "hosts" as const, value: 3, limit: 3 },
      { metric: "members" as const, value: 4, limit: 5 },
      { metric: "guests" as const, value: 1, limit: 2 },
      { metric: "concurrent" as const, value: 0, limit: 10 },
      { metric: "traffic" as const, value: 5.4 * GB, limit: 5 * GB },
    ];
  return [
    { metric: "hosts" as const, value: 2, limit: 3 },
    { metric: "traffic" as const, value: 1_288_490_189, limit: 5 * GB },
  ];
}

/** 本计费周期（UTC 自然月）每天一条；今天之后的天是 0。 */
function dailyTraffic(now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const today = now.getUTCDate();
  return Array.from({ length: days }, (_, index) => ({
    startMs: Date.UTC(year, month, 1) + index * DAY,
    relayBytes:
      index + 1 > today ? 0 : Math.round((((index * 37) % 11) + 1) * 0.25 * GB),
  }));
}

export const BILLING_HANDLERS: Readonly<
  Record<string, (input: Input, state: TeamsState) => unknown>
> = {
  "billing.plan": (input, state) => {
    const team = guard(input, state);
    const now = new Date();
    const members = state.teams
      .find((row) => row.teamId === team?.teamId)
      ?.members.filter((member) => member.role !== "guest").length;
    return {
      space: input.space,
      plan: team?.plan ?? "free",
      status: "active" as const,
      seats: team ? (members ?? 1) : 1,
      periodEndsAtMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    };
  },
  "billing.usage": (input, state) => {
    const team = guard(input, state);
    const now = new Date();
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      space: input.space,
      period,
      usage: usageFor(team?.slug),
      ...(input.granularity === "day" ? { series: dailyTraffic(now) } : {}),
    };
  },
};
