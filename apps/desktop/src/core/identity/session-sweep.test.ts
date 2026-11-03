import { describe, expect, it } from "vitest";
import {
  LAST_SEEN_RESOLUTION_MS,
  type SweepCandidate,
  idle,
  lastActiveAtMs,
  shellClient,
  staleOnPair,
  staleOnStartup,
} from "./session-sweep";

const TTL = 15 * 60 * 1000;
const NOW = 1_800_000_000_000;
const PAGE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Electron/42.11.6 Safari/537.36";
const TRAY = "node";

/** 一条在 `activeAgo` 之前最后一次被用、之后再没刷新的会话。 */
function session(
  sessionId: string,
  userAgent: string,
  activeAgo: number,
): SweepCandidate {
  const at = NOW - activeAgo;
  return {
    sessionId,
    userAgent,
    createdAtMs: at,
    accessExpiresAtMs: at + TTL,
    lastSeenAtMs: at,
  };
}

describe("shellClient", () => {
  it("浏览器 UA 是页面，其余（Node 的 fetch、空串）是壳进程", () => {
    expect(shellClient(PAGE)).toBe("page");
    expect(shellClient(TRAY)).toBe("process");
    expect(shellClient("")).toBe("process");
    expect(shellClient("undici")).toBe("process");
  });
});

describe("idle", () => {
  it("最后一次活动取建、认证、刷新里最晚的", () => {
    const refreshed: SweepCandidate = {
      sessionId: "a",
      userAgent: PAGE,
      createdAtMs: NOW - 10 * TTL,
      lastSeenAtMs: NOW - 9 * TTL,
      // 半个访问期之前刷新过一次。
      accessExpiresAtMs: NOW + TTL / 2,
    };
    expect(lastActiveAtMs(refreshed, TTL)).toBe(NOW - TTL / 2);
    expect(idle(refreshed, NOW, TTL)).toBe(false);
  });

  it("一个访问期加一分钟的记录粒度以内不算，超过才算", () => {
    const edge = TTL + LAST_SEEN_RESOLUTION_MS;
    expect(idle(session("a", PAGE, edge), NOW, TTL)).toBe(false);
    expect(idle(session("a", PAGE, edge + 1), NOW, TTL)).toBe(true);
  });

  it("访问期过了但刚认证过的不算闲置", () => {
    const seen: SweepCandidate = {
      ...session("a", TRAY, 3 * TTL),
      lastSeenAtMs: NOW - 1_000,
    };
    expect(idle(seen, NOW, TTL)).toBe(false);
  });
});

describe("staleOnPair", () => {
  const sessions = [
    session("current", PAGE, 0),
    session("old-page", PAGE, 2 * TTL),
    session("recent-page", PAGE, TTL / 3),
    session("old-tray", TRAY, 5 * TTL),
  ];

  it("页面配对：只撤闲置的页面会话，不撤刚配上的那条与托盘", () => {
    expect(
      staleOnPair(sessions, {
        keep: "current",
        client: "page",
        now: NOW,
        accessTtlMs: TTL,
      }),
    ).toEqual(["old-page"]);
  });

  it("托盘配对：只撤闲置的托盘会话", () => {
    expect(
      staleOnPair([...sessions, session("tray-now", TRAY, 0)], {
        keep: "tray-now",
        client: "process",
        now: NOW,
        accessTtlMs: TTL,
      }),
    ).toEqual(["old-tray"]);
  });

  it("刚配上的那条即使看起来闲置也不撤", () => {
    expect(
      staleOnPair([session("current", PAGE, 9 * TTL)], {
        keep: "current",
        client: "page",
        now: NOW,
        accessTtlMs: TTL,
      }),
    ).toEqual([]);
  });
});

describe("staleOnStartup", () => {
  it("每种客户端留最近的一条，其余闲置的撤掉", () => {
    const sessions = [
      ...Array.from({ length: 300 }, (_, i) =>
        session(`page-${i}`, PAGE, (i + 2) * TTL),
      ),
      ...Array.from({ length: 200 }, (_, i) =>
        session(`tray-${i}`, TRAY, (i + 2) * TTL),
      ),
    ];
    const stale = staleOnStartup(sessions, { now: NOW, accessTtlMs: TTL });
    expect(stale).toHaveLength(498);
    expect(stale).not.toContain("page-0");
    expect(stale).not.toContain("tray-0");
  });

  it("一个访问期以内用过的都留着", () => {
    const sessions = [
      session("page-a", PAGE, 0),
      session("page-b", PAGE, TTL / 2),
      session("page-c", PAGE, 3 * TTL),
      session("tray-a", TRAY, TTL / 4),
    ];
    expect(staleOnStartup(sessions, { now: NOW, accessTtlMs: TTL })).toEqual([
      "page-c",
    ]);
  });

  it("没有会话就什么也不撤", () => {
    expect(staleOnStartup([], { now: NOW, accessTtlMs: TTL })).toEqual([]);
  });
});
