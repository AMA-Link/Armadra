import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { cloudKeys } from "./keys";
import { applyMeStreamEvent, resyncCloudQueries } from "./stream";

const row = (sourceId: string, online: boolean) => ({
  sourceId,
  name: sourceId,
  online,
  lastSeenAtMs: 1,
});

/** 目录缓存是 `useInfiniteQuery` 的形状：`{ pages: [{ sources }], pageParams }`。 */
function seeded() {
  const client = new QueryClient();
  const listKey = cloudKeys.hosts("me", { limit: 50 });
  const previewKey = cloudKeys.hosts("me", { limit: 5 });
  const teamKey = cloudKeys.hosts("t:t1", { limit: 50 });
  const data = (...rows: ReturnType<typeof row>[]) => ({
    pages: [{ sources: rows, nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(listKey, data(row("a", true), row("b", false)));
  client.setQueryData(previewKey, data(row("a", true)));
  client.setQueryData(teamKey, data(row("a", true)));
  client.setQueryData(cloudKeys.host("me", "a"), row("a", true));
  client.setQueryData(cloudKeys.links("me", {}), {
    links: [
      { linkId: "l1", uses: 2 },
      { linkId: "l2", uses: 0 },
    ],
  });
  const sources = (key: readonly unknown[]) =>
    (
      client.getQueryData(key) as {
        pages: { sources: ReturnType<typeof row>[] }[];
      }
    ).pages[0]!.sources;
  return { client, listKey, previewKey, teamKey, sources };
}

describe("applyMeStreamEvent（缓存层）", () => {
  it("sourceOffline 改所有目录与详情里的那一台，不碰别的主机，也不标过期", () => {
    const { client, listKey, previewKey, teamKey, sources } = seeded();
    applyMeStreamEvent(client, {
      type: "sourceOffline",
      sourceId: "a",
      atMs: 9,
    });
    for (const key of [listKey, previewKey, teamKey])
      expect(sources(key)[0]).toMatchObject({ online: false, lastSeenAtMs: 9 });
    expect(sources(listKey)[1]).toMatchObject({ sourceId: "b", online: false });
    expect(client.getQueryData(cloudKeys.host("me", "a"))).toMatchObject({
      online: false,
      lastSeenAtMs: 9,
    });
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
  });

  it("sourceOnline 记上线时间与在线", () => {
    const { client, listKey, sources } = seeded();
    applyMeStreamEvent(client, {
      type: "sourceOnline",
      sourceId: "b",
      sinceMs: 77,
      relayOrigin: "https://relay.test",
    });
    expect(sources(listKey)[1]).toMatchObject({
      online: true,
      lastSeenAtMs: 77,
    });
  });

  it("带 status 筛选的目录：上下线不就地改，而是让那份缓存过期", () => {
    const { client, listKey, sources } = seeded();
    const filtered = cloudKeys.hosts("me", { status: "online", limit: 50 });
    client.setQueryData(filtered, {
      pages: [{ sources: [row("a", true)], nextCursor: null }],
      pageParams: [undefined],
    });
    applyMeStreamEvent(client, {
      type: "sourceOffline",
      sourceId: "a",
      atMs: 9,
    });
    expect(sources(filtered)[0]).toMatchObject({ online: true });
    expect(client.getQueryState(filtered)?.isInvalidated).toBe(true);
    expect(sources(listKey)[0]).toMatchObject({ online: false });
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
  });

  it("所有目录里都没有这台主机：让目录过期重拉", () => {
    const { client, listKey } = seeded();
    applyMeStreamEvent(client, {
      type: "sourceOnline",
      sourceId: "new",
      sinceMs: 1,
      relayOrigin: "https://relay.test",
    });
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("sourceRevoked 把它从全部目录里去掉，详情标为过期去重拉", () => {
    const { client, listKey, previewKey, teamKey, sources } = seeded();
    applyMeStreamEvent(client, { type: "sourceRevoked", sourceId: "a" });
    expect(sources(listKey).map((entry) => entry.sourceId)).toEqual(["b"]);
    expect(sources(previewKey)).toEqual([]);
    expect(sources(teamKey)).toEqual([]);
    expect(client.getQueryState(cloudKeys.host("me", "a"))?.isInvalidated).toBe(
      true,
    );
  });

  it("linkUsed 只给那一条链接的用量加一", () => {
    const { client } = seeded();
    applyMeStreamEvent(client, {
      type: "linkUsed",
      linkId: "l1",
      by: { guest: true },
      atMs: 1,
    });
    expect(client.getQueryData(cloudKeys.links("me", {}))).toEqual({
      links: [
        { linkId: "l1", uses: 3 },
        { linkId: "l2", uses: 0 },
      ],
    });
  });

  it("其余事件只让对应的键过期（没有人看的查询不立刻重拉）", () => {
    const client = new QueryClient();
    client.setQueryData(cloudKeys.trust("me"), { requests: [] });
    client.setQueryData(cloudKeys.trust("t:t1"), { requests: [] });
    applyMeStreamEvent(client, {
      type: "deviceTrustRequested",
      requestId: "r",
      sourceId: "s",
      teamId: "t1",
      atMs: 1,
    });
    // 团队的与「我收到的」（个人空间键下）都过期。
    expect(client.getQueryState(cloudKeys.trust("t:t1"))?.isInvalidated).toBe(
      true,
    );
    expect(client.getQueryState(cloudKeys.trust("me"))?.isInvalidated).toBe(
      true,
    );
  });

  it("ping 与不认识的事件什么也不做", () => {
    const { client, listKey, sources } = seeded();
    applyMeStreamEvent(client, { type: "ping", ts: 1 });
    expect(sources(listKey)).toHaveLength(2);
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
  });

  it("resyncCloudQueries 让除运营数据外的云端查询全部过期", () => {
    const { client, listKey } = seeded();
    client.setQueryData(cloudKeys.ops("nodes"), { nodes: [] });
    resyncCloudQueries(client);
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(cloudKeys.ops("nodes"))?.isInvalidated).toBe(
      false,
    );
  });
});
