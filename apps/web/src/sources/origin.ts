import {
  SHARE_ROLES,
  type ShareRole,
  type SourceDescriptor,
  type SourceOrigin,
} from "./types";

/**
 * 一台电脑是我的还是别人分享的（契约 §68）。
 *
 * 新 core 在源表的每一行带 `origin`、主人名、权限与到期；旧 core 不带，页面
 * 自己推：经分享链接加入过的源记在本地（{@link markJoinedByLink}），算别人的，
 * 其余算我的。core 报了就以 core 为准。
 */

const JOINED_KEY = "armadra.sources.joinedByLink";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJoined(): string[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(JOINED_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((one): one is string => typeof one === "string")
      : [];
  } catch {
    return [];
  }
}

/** 记下这个源是经分享链接加入的（旧 core 不报 `origin` 时据此判为别人的）。 */
export function markJoinedByLink(sourceId: string): void {
  const joined = readJoined();
  if (joined.includes(sourceId)) return;
  try {
    storage()?.setItem(JOINED_KEY, JSON.stringify([...joined, sourceId]));
  } catch {
    /* 记不下只是旧 core 上分到「我的」那一组。 */
  }
}

export function joinedByLink(sourceId: string): boolean {
  return readJoined().includes(sourceId);
}

/** 这台电脑归哪一边：本机总是我的；core 报了用它的，否则按是否经链接加入。 */
export function originOf(descriptor: SourceDescriptor): SourceOrigin {
  if (descriptor.kind === "local") return "mine";
  if (descriptor.origin !== undefined) return descriptor.origin;
  return joinedByLink(descriptor.sourceId) ? "shared" : "mine";
}

function isShareRole(value: unknown): value is ShareRole {
  return (SHARE_ROLES as readonly unknown[]).includes(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

type ShareFields = Pick<
  SourceDescriptor,
  "origin" | "ownerName" | "shareRole" | "shareExpiresAt"
>;

/**
 * 源表一行里与归属有关的字段 → 描述上的可选字段。认不出、没有的一律不出现
 * （旧 core）；名字接受 `ownerName` 与 `ownerLabel`，到期接受毫秒的两种拼法。
 */
export function shareFieldsOf(row: object): ShareFields {
  const raw = row as Record<string, unknown>;
  const origin =
    raw.origin === "mine" || raw.origin === "shared" ? raw.origin : undefined;
  const ownerName = text(raw.ownerName) ?? text(raw.ownerLabel);
  const shareRole = isShareRole(raw.shareRole) ? raw.shareRole : undefined;
  const shareExpiresAt = time(raw.shareExpiresAtMs) ?? time(raw.shareExpiresAt);
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(ownerName === undefined ? {} : { ownerName }),
    ...(shareRole === undefined ? {} : { shareRole }),
    ...(shareExpiresAt === undefined ? {} : { shareExpiresAt }),
  };
}

/** 别人分享来的电脑缺省按只读显示（分享缺省只读）。 */
export function shareRoleOf(descriptor: SourceDescriptor): ShareRole {
  return descriptor.shareRole ?? "viewer";
}
