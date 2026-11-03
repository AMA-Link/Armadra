/**
 * 桌面壳本机设备上闲置会话的清理规则（#770）。纯函数，不碰库。
 *
 * 桌面壳的页面与托盘各自用私有通道签的票配会话，全部落在同一台「本机桌面」
 * 设备上（`service.ts::reusableLocalDevice`）。页面重启、整页重载之外的情形
 * （应用重启、按源另开的窗口关掉、托盘换了 core 端口）都没人撤上一条，它们
 * 只能等 30 天的绝对期限，「登录会话」于是一台设备几百条。
 *
 * 规则只有一条：同一台本机设备、同一种客户端（页面 / 壳进程）里，已经闲置超过
 * 一个访问期的会话撤掉。闲置 = 访问密钥已过期（一个访问期里没有刷新）**并且**
 * 最近一次认证也在一个访问期之前（再宽出最近活动一分钟的记录粒度）。还开着的页面每个访问期都会刷新，托盘每次
 * 用都会认证，所以活着的会话不会被认成闲置。
 */

/**
 * 最近活动（`last_seen_at_ms`）最多这么久写一次（`service.ts` 认证时节流）。记下的
 * 时刻可能比真正那次认证早这么久，判闲置时把它算作余量。
 */
export const LAST_SEEN_RESOLUTION_MS = 60 * 1000;

/** 本机设备上会话的客户端种类：页面（浏览器 UA）或壳自己的进程（托盘）。 */
export type ShellClient = "page" | "process";

/** 页面是 Chromium，UA 以 `Mozilla/` 开头；托盘用 Node 的 `fetch`。 */
export function shellClient(userAgent: string): ShellClient {
  return userAgent.startsWith("Mozilla/") ? "page" : "process";
}

/** 判闲置要用到的那几列。 */
export interface SweepCandidate {
  readonly sessionId: string;
  readonly userAgent: string;
  readonly createdAtMs: number;
  readonly accessExpiresAtMs: number;
  readonly lastSeenAtMs: number;
}

/** 这条会话最后一次被用的时刻：建、认证、刷新（刷新把访问期往后推一整段）。 */
export function lastActiveAtMs(
  session: SweepCandidate,
  accessTtlMs: number,
): number {
  return Math.max(
    session.createdAtMs,
    session.lastSeenAtMs,
    session.accessExpiresAtMs - accessTtlMs,
  );
}

/** 闲置超过一个访问期（加上最近活动的记录粒度）。 */
export function idle(
  session: SweepCandidate,
  now: number,
  accessTtlMs: number,
): boolean {
  return (
    now - lastActiveAtMs(session, accessTtlMs) >
    accessTtlMs + LAST_SEEN_RESOLUTION_MS
  );
}

/**
 * 壳刚为 `client` 配上 `keep` 这条会话：同一设备、同一种客户端里闲置的撤掉。
 * `keep` 本身与另一种客户端的会话一律不动。
 */
export function staleOnPair(
  sessions: readonly SweepCandidate[],
  options: {
    readonly keep: string;
    readonly client: ShellClient;
    readonly now: number;
    readonly accessTtlMs: number;
  },
): string[] {
  return sessions
    .filter(
      (session) =>
        session.sessionId !== options.keep &&
        shellClient(session.userAgent) === options.client &&
        idle(session, options.now, options.accessTtlMs),
    )
    .map((session) => session.sessionId);
}

/**
 * core 启动时的一次清理：同一规则，只是没有「刚配上的那条」——每种客户端留
 * 最近用过的一条，其余闲置的撤掉。留下的那条若也闲置，壳下一次为这种客户端
 * 配对时由 {@link staleOnPair} 撤掉。
 */
export function staleOnStartup(
  sessions: readonly SweepCandidate[],
  options: { readonly now: number; readonly accessTtlMs: number },
): string[] {
  const newest = new Map<ShellClient, SweepCandidate>();
  for (const session of sessions) {
    const client = shellClient(session.userAgent);
    const current = newest.get(client);
    if (
      current === undefined ||
      lastActiveAtMs(session, options.accessTtlMs) >
        lastActiveAtMs(current, options.accessTtlMs)
    )
      newest.set(client, session);
  }
  const stale: string[] = [];
  for (const session of sessions) {
    const client = shellClient(session.userAgent);
    if (newest.get(client)?.sessionId === session.sessionId) continue;
    if (idle(session, options.now, options.accessTtlMs))
      stale.push(session.sessionId);
  }
  return stale;
}
