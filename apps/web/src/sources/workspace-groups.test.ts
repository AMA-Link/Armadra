import { beforeEach, describe, expect, it } from "vitest";

import type { SourceConnection } from "./connection";
import { markJoinedByLink } from "./origin";
import type { SourceDescriptor, SourceState } from "./types";
import {
  CACHED_WORKSPACES_PER_SOURCE,
  cachedWorkspaces,
  forgetWorkspaces,
  rememberWorkspaces,
} from "./workspace-cache";
import {
  type SourceListing,
  groupByTeam,
  groupWorkspaces,
  initialOf,
} from "./workspace-groups";

const descriptor = (
  sourceId: string,
  patch: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "direct",
  label: sourceId,
  baseUrl: `https://${sourceId}.test`,
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex: 1,
  ...patch,
});

const connection = (
  d: SourceDescriptor,
  state: SourceState = "ready",
): SourceConnection =>
  ({
    descriptor: d,
    status: { state, via: null, since: 0, lastError: null },
  }) as unknown as SourceConnection;

const LOCAL = connection(descriptor("local", { kind: "local" }));
const listing = (
  names: string[],
  patch: Partial<SourceListing> = {},
): SourceListing => ({
  isPending: false,
  isError: false,
  workspaces: names.map((name) => ({ id: `id-${name}`, name })),
  ...patch,
});

beforeEach(() => localStorage.clear());

describe("侧栏三组", () => {
  it("本机、我的其他电脑、他人分享；空组不出现，组内保持源表顺序", () => {
    markJoinedByLink("joined");
    const groups = groupWorkspaces({
      sources: [
        LOCAL,
        connection(descriptor("studio")),
        connection(descriptor("ann", { origin: "shared", ownerName: "Ann" })),
        connection(descriptor("joined")),
        connection(descriptor("laptop")),
      ],
      states: {},
      listings: new Map([
        ["local", listing(["Home"])],
        ["studio", listing(["Render"])],
        ["ann", listing(["Book"])],
        ["joined", listing(["Notes"])],
        ["laptop", listing([])],
      ]),
      cached: () => [],
    });
    expect(groups.map((group) => group.key)).toEqual([
      "local",
      "mine",
      "shared",
    ]);
    const ids = groups.map((group) =>
      group.sections.map((one) => one.connection.descriptor.sourceId),
    );
    expect(ids).toEqual([["local"], ["studio", "laptop"], ["ann", "joined"]]);
    expect(groups[0]!.sections[0]!.workspaces.map((one) => one.name)).toEqual([
      "Home",
    ]);

    const zeroConfig = groupWorkspaces({
      sources: [LOCAL],
      states: {},
      listings: new Map([["local", listing(["Home"])]]),
      cached: () => [],
    });
    expect(zeroConfig.map((group) => group.key)).toEqual(["local"]);
  });

  it("离线、在连、要登录的电脑列上次记下的名字，不挡本机", () => {
    const cache: Record<string, { id: string; name: string }[]> = {
      down: [{ id: "w1", name: "Old" }],
      slow: [{ id: "w2", name: "Pending" }],
      locked: [{ id: "w3", name: "Locked" }],
    };
    const groups = groupWorkspaces({
      sources: [
        LOCAL,
        connection(descriptor("down"), "offline"),
        connection(descriptor("slow"), "connecting"),
        connection(descriptor("locked"), "unauthorized"),
      ],
      states: {},
      listings: new Map([["local", listing(["Home"])]]),
      cached: (sourceId) => cache[sourceId] ?? [],
    });
    const [local, mine] = groups;
    expect(local!.sections[0]).toMatchObject({ state: "ready", stale: false });
    expect(
      mine!.sections.map((one) => [
        one.state,
        one.stale,
        one.workspaces[0]!.name,
      ]),
    ).toEqual([
      ["offline", true, "Old"],
      ["loading", true, "Pending"],
      ["offline", true, "Locked"],
    ]);
  });

  it("等对端上线（waitingForSource）：和离线一样灰着，列记下的名字", () => {
    const groups = groupWorkspaces({
      sources: [LOCAL, connection(descriptor("away"), "waitingForSource")],
      states: {},
      listings: new Map([["local", listing(["Home"])]]),
      cached: () => [{ id: "w1", name: "Old" }],
    });
    expect(groups[1]!.sections[0]).toMatchObject({
      state: "offline",
      stale: true,
    });
  });

  it("就绪但查询还在路上或失败：在连 / 离线，用记下的；状态以订阅到的为准", () => {
    const groups = groupWorkspaces({
      sources: [
        LOCAL,
        connection(descriptor("a"), "connecting"),
        connection(descriptor("b")),
      ],
      states: { a: "ready" },
      listings: new Map([
        ["local", listing([], { isPending: true })],
        ["a", listing([], { isPending: true })],
        ["b", listing([], { isError: true })],
      ]),
      cached: () => [{ id: "c", name: "Cached" }],
    });
    expect(groups[0]!.sections[0]).toMatchObject({
      state: "loading",
      stale: false,
      workspaces: [],
    });
    expect(groups[1]!.sections.map((one) => one.state)).toEqual([
      "loading",
      "offline",
    ]);
    expect(groups[1]!.sections[1]!.workspaces[0]!.name).toBe("Cached");
  });

  it("首字母头像", () => {
    expect(initialOf(" ann")).toBe("A");
    expect(initialOf("王小明")).toBe("王");
    expect(initialOf("")).toBe("?");
  });
});

describe("工作空间名缓存", () => {
  it("记下、读回、相同不重写、按源忘掉", () => {
    expect(cachedWorkspaces("a")).toEqual([]);
    rememberWorkspaces("a", [{ id: "1", name: "One", extra: true } as never]);
    rememberWorkspaces("b", [{ id: "2", name: "Two" }]);
    expect(cachedWorkspaces("a")).toEqual([{ id: "1", name: "One" }]);
    const before = localStorage.getItem("armadra.sources.workspaceNames");
    rememberWorkspaces("a", [{ id: "1", name: "One" }]);
    expect(localStorage.getItem("armadra.sources.workspaceNames")).toBe(before);
    forgetWorkspaces("a");
    expect(cachedWorkspaces("a")).toEqual([]);
    expect(cachedWorkspaces("b")).toEqual([{ id: "2", name: "Two" }]);
  });

  it("上限与坏数据", () => {
    rememberWorkspaces(
      "a",
      Array.from({ length: CACHED_WORKSPACES_PER_SOURCE + 5 }, (_, i) => ({
        id: String(i),
        name: `W${i}`,
      })),
    );
    expect(cachedWorkspaces("a")).toHaveLength(CACHED_WORKSPACES_PER_SOURCE);
    localStorage.setItem(
      "armadra.sources.workspaceNames",
      JSON.stringify({ a: [{ id: 1 }, { id: "x", name: "ok" }], b: "nope" }),
    );
    expect(cachedWorkspaces("a")).toEqual([{ id: "x", name: "ok" }]);
    expect(cachedWorkspaces("b")).toEqual([]);
    localStorage.setItem("armadra.sources.workspaceNames", "{broken");
    expect(cachedWorkspaces("a")).toEqual([]);
  });
});

describe("groupByTeam（契约 §86）", () => {
  const section = (id: string, patch: Partial<SourceDescriptor>) => ({
    connection: connection(descriptor(id, { origin: "shared", ...patch })),
    state: "ready" as const,
    workspaces: [],
    stale: false,
  });

  it("按团队分，团队按首次出现的顺序，个人分享在后；没名字退回标识前 8 位", () => {
    const layout = groupByTeam([
      section("p1", {}),
      section("a1", { teamId: "team-aaaaaaaa-1", teamName: "" }),
      section("b1", { teamId: "team-b", teamName: "设计组" }),
      section("a2", { teamId: "team-aaaaaaaa-1", teamName: "研发组" }),
    ]);
    expect(layout.teams.map((team) => [team.teamId, team.name])).toEqual([
      ["team-aaaaaaaa-1", "研发组"],
      ["team-b", "设计组"],
    ]);
    expect(
      layout.teams[0]!.sections.map(
        (one) => one.connection.descriptor.sourceId,
      ),
    ).toEqual(["a1", "a2"]);
    expect(
      layout.personal.map((one) => one.connection.descriptor.sourceId),
    ).toEqual(["p1"]);
    expect(
      groupByTeam([section("a", { teamId: "abcdefghijkl" })]).teams[0]!.name,
    ).toBe("abcdefgh");
  });
});
