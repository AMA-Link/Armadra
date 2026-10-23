/**
 * 源表行的小件（契约 §33、§55、§61、§68）：名字的取法与检查、一条路在答案里的样子、
 * 归属与分享信息的列。从 `service.ts` 拆出来，行为不变。
 */

import type { ClientSourceRoute } from "@armadra/shared";

import { fail } from "../http/errors";
import type { CloudLoginShare } from "./source-client";
import type { RouteRow, SourceShare } from "./store";

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

/** `cloud/login` 报的分享信息 → 源行的三列（契约 §68）。 */
export function shareColumns(share: CloudLoginShare | undefined): SourceShare {
  return {
    ownerLabel: clip(share?.ownerName ?? "", 128),
    shareRole: share?.role ?? "",
    shareExpiresAtMs: share?.expiresAtMs ?? 0,
    teamId: clip(share?.teamId ?? "", 128),
    teamName: clip(share?.teamName ?? "", 128),
  };
}
