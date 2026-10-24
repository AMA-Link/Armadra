/**
 * 源表行的小件（契约 §33、§55、§61、§68）：名字的取法与检查、一条路在答案里的样子、
 * 归属与分享信息的列。从 `service.ts` 拆出来，行为不变。
 */

import type { ClientSourceRoute } from "@armadra/shared";

import { fail } from "../http/errors";
import type { CloudLoginShare } from "./source-client";
import type { RouteRow, SourceRow, SourceShare, SourcesStore } from "./store";

export function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 名字（契约 §61）：`label` 是显示的，`defaultLabel` 是服务端报的。给了名字用它；
 * 否则改过名（`label ≠ defaultLabel`）的行留着本地名，没改过的跟着新的缺省名。
 * 服务端这次没报名字（旧对端、目录取不到）时缺省名不变，新行用 `fallback`。
 */
export function naming(
  existing: { label: string; defaultLabel: string } | undefined,
  given: string | undefined,
  advertised: string,
  fallback: string,
): { label: string; defaultLabel: string } {
  const defaultLabel =
    clip(advertised.trim(), 128) ||
    existing?.defaultLabel ||
    existing?.label ||
    clip(fallback.trim(), 128) ||
    "Armadra";
  const renamed =
    existing !== undefined &&
    existing.defaultLabel !== "" &&
    existing.label !== existing.defaultLabel;
  return {
    label: given ?? (renamed ? existing.label : defaultLabel),
    defaultLabel,
  };
}

/**
 * 改名的名字（`sources.update` / `sources.remoteUpdate` 的 `label`）：空串（去首尾
 * 空白后）= 恢复缺省名，答 `null`；其余 1–128 个字符。不给是 `undefined`。
 */
export function renameLabel(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return null;
  return checkLabel(value);
}

/** 显示名：1–128 个字符（表的约束）；不给就是 `undefined`。 */
export function checkLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw fail("bad_request", "名称应为 1 到 128 个字符");
  }
  return trimmed;
}

/** 一条路在答案里的样子（契约 §55）：没有凭据，只有地址与时刻。 */
export function routeJson(route: RouteRow): ClientSourceRoute {
  return {
    via: route.via,
    origin: route.origin,
    cloudIssuer: route.cloudIssuer,
    fingerprint: route.fingerprint,
    preferred: route.preferred,
    lastOkAtMs: route.lastOkAtMs,
  };
}

/** `mine` 的源没有分享信息（契约 §68）。 */
export const MINE = {
  origin: "mine",
  ownerLabel: "",
  shareRole: "",
  shareExpiresAtMs: 0,
  teamId: "",
  teamName: "",
} as const;

/**
 * `cloud/login` 报的分享信息 → 源行的列（契约 §68）。团队（契约 §86）不取自对端的
 * 答案——对端是别人的 core，它的话不作分组依据——只取自接收方自己的云，由调用方给。
 */
export function shareColumns(
  share: CloudLoginShare | undefined,
  team: { teamId: string; teamName: string } = { teamId: "", teamName: "" },
): SourceShare {
  return {
    ownerLabel: clip(share?.ownerName ?? "", 128),
    shareRole: share?.role ?? "",
    shareExpiresAtMs: share?.expiresAtMs ?? 0,
    teamId: clip(team.teamId, 128),
    teamName: clip(team.teamName, 128),
  };
}

/**
 * 挂载的落库：源行建或留（显示名、主体提示），中继这条路 upsert 一行；镜像由
 * 首选路由决定，挂第二个中继不改原来的首选（契约 §55）。
 */
export function saveRelayRoute(
  store: SourcesStore,
  at: number,
  input: {
    sourceId: string;
    existing: SourceRow | undefined;
    label: string;
    defaultLabel: string;
    relayOrigin: string;
    issuer: string;
    principalHint: string;
    /**
     * 按分享链接加入时分享方报的信息（契约 §68）；`undefined` = 用自己的账号挂上
     * （`mine`）。已经是 `mine` 的行按链接再加入一次仍是 `mine`。
     */
    share: CloudLoginShare | undefined | null;
    /** Armadra 云挂载时自己的云得出的团队（契约 §86）。 */
    team?: { teamId: string; teamName: string } | undefined;
  },
): SourceRow {
  const { existing } = input;
  const shared = input.share !== undefined && existing?.origin !== "mine";
  store.upsert({
    sourceId: input.sourceId,
    kind: existing?.kind ?? "relayed",
    label: clip(input.label, 128),
    defaultLabel: clip(input.defaultLabel, 128),
    baseUrl: existing?.baseUrl ?? "",
    relayOrigin: existing?.relayOrigin || input.relayOrigin,
    fingerprint: existing?.fingerprint ?? "",
    cloudIssuer: existing?.relayOrigin ? existing.cloudIssuer : input.issuer,
    principalHint: input.principalHint,
    addedAtMs: existing?.addedAtMs ?? at,
    lastOkAtMs: at,
    orderIndex: existing?.orderIndex ?? store.nextOrder(),
    ...(shared
      ? {
          origin: "shared" as const,
          // 没带团队（个人链接挂载、目录取不到）时留住已有的团队，不清空。
          ...shareColumns(
            input.share ?? undefined,
            input.team ??
              (existing?.origin === "shared" ? existing : undefined),
          ),
        }
      : MINE),
  });
  store.upsertRoute({
    sourceId: input.sourceId,
    via: "relayed",
    origin: input.relayOrigin,
    cloudIssuer: input.issuer,
    fingerprint: "",
    addedAtMs: at,
    lastOkAtMs: at,
  });
  return store.get(input.sourceId) as SourceRow;
}
