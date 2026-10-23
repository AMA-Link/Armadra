import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => vi.fn());
const listed = vi.hoisted(() => ({
  data: [] as { sourceId: string; workspace: { id: string; name: string } }[],
  pending: new Set<string>(),
}));
vi.mock("../app/workspace-actions", () => ({ useOpenWorkspace: () => open }));
vi.mock("../app/workspaces-query", async () => {
  const { useSources, useSourceStates } = await import("../sources/context");
  return {
    useWorkspaces: () => {
      const sources = useSources();
      const states = useSourceStates(sources);
      const perSource = new Map();
      for (const source of sources) {
        const sourceId = source.descriptor.sourceId;
        const local = source.descriptor.kind === "local";
        if (!local && states[sourceId] !== "ready") continue;
        perSource.set(sourceId, {
          isPending: listed.pending.has(sourceId),
          isError: false,
          workspaces: listed.data
            .filter((one) => one.sourceId === sourceId)
            .map((one) => one.workspace),
        });
      }
      return { data: listed.data, perSource, states };
    },
  };
});
const desktop = vi.hoisted(() => ({ on: false }));
vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  isDesktop: () => desktop.on,
}));
const reorder = vi.hoisted(() => vi.fn(async (_ids: readonly string[]) => {}));
vi.mock("../api/remote-services", () => ({ reorderSources: reorder }));

import { usePreferencesStore } from "../app/preferences-store";
import {
  dropUnscopedQueries,
  useSourceSwitchCacheReset,
} from "../app/use-sources-bootstrap";
import type { SourceConnection } from "../sources/connection";
import { SourcesProvider } from "../sources/context";
import { markJoinedByLink } from "../sources/origin";
import {
  createSourceRegistry,
  selectCurrentSource,
  type SourceRegistry,
} from "../sources/registry";
import type { SourceDescriptor, SourceStatus } from "../sources/types";
import { rememberWorkspaces } from "../sources/workspace-cache";
import { WorkspaceGroups, applyOrder } from "./SourceGroups";

/**
 * 侧栏三组：这台电脑、我的其他电脑、他人分享。当前那台是树，其余各段列出
 * 工作空间；离线的灰着列上次的名字；分享的带主人头像、名字与权限。
 */

function connection(
  descriptor: SourceDescriptor,
  state: SourceStatus["state"],
): SourceConnection {
  const listeners = new Set<() => void>();
  let status: SourceStatus = {
    state: "idle",
    via: null,
    since: 0,
    lastError: null,
  };
  return {
    descriptor,
    get status() {
      return status;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    source: { sourceId: descriptor.sourceId } as SourceConnection["source"],
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    async connect() {
      status = { state, via: null, since: 1, lastError: null };
      for (const listener of listeners) listener();
    },
    disconnect() {},
    renew: async () => undefined,
  } as unknown as SourceConnection;
}

const descriptor = (
  sourceId: string,
  orderIndex: number,
  patch: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "direct",
  label: `${sourceId}-label`,
  baseUrl: `https://${sourceId}.test`,
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex,
  ...patch,
});

let registry: SourceRegistry;
beforeEach(async () => {
  localStorage.clear();
  usePreferencesStore.setState({ locale: "en" });
  const states: Record<string, SourceStatus["state"]> = {
    a: "ready",
    b: "offline",
    c: "connecting",
    ann: "ready",
  };
  registry = createSourceRegistry({
    connect: (d) => connection(d, states[d.sourceId] ?? "idle"),
  });
  listed.data = [];
  listed.pending.clear();
});
afterEach(() => {
  cleanup();
  registry.dispose();
  open.mockReset();
  reorder.mockClear();
  desktop.on = false;
});

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SourcesProvider registry={registry}>
        <WorkspaceGroups
          tree={<div data-testid="tree" />}
          renderLocal={(content, current) => (
            <section aria-label="local-shell" data-current={current}>
              {content}
            </section>
          )}
        />
      </SourcesProvider>
    </QueryClientProvider>,
  );
}

const hydrate = (descriptors: SourceDescriptor[]) =>
  act(async () => {
    await registry.hydrate(async () => descriptors);
  });

const order = () =>
  [...document.querySelectorAll("[data-source-group]")].map((one) =>
    one.getAttribute("data-source-group"),
  );

describe("侧栏三组", () => {
  it("只有本机：只有这台电脑一组，内容是树", () => {
    mount();
    expect(document.querySelectorAll("[data-workspace-group]")).toHaveLength(0);
    const shell = screen.getByRole("region", { name: "local-shell" });
    expect(shell.getAttribute("data-current")).toBe("true");
    expect(within(shell).getByTestId("tree")).toBeTruthy();
  });

  it("我的其他电脑与他人分享各一组；分享的带头像、主人名与权限", async () => {
    markJoinedByLink("joined");
    await hydrate([
      descriptor("a", 1),
      descriptor("ann", 2, {
        origin: "shared",
        ownerName: "ann",
        shareRole: "editor",
      }),
      descriptor("joined", 3),
    ]);
    mount();
    const mine = screen.getByRole("region", { name: "My other computers" });
    const shared = screen.getByRole("region", { name: "Shared with me" });
    expect(within(mine).getByRole("region", { name: "a-label" })).toBeTruthy();
    const ann = within(shared).getByRole("region", { name: "ann" });
    expect(within(ann).getByText("A")).toBeTruthy();
    expect(within(ann).getByText("Can edit")).toBeTruthy();
    // 旧 core 不报权限：经链接加入的按只读显示，没有主人名用电脑名。
    const joined = within(shared).getByRole("region", {
      name: "joined-label",
    });
    expect(within(joined).getByText("View only")).toBeTruthy();
    expect(order()).toEqual(["local", "a", "ann", "joined"]);
  });

  it("他人分享按团队分小组：团队在前可折叠、个人分享在后，折叠状态记在本机", async () => {
    await hydrate([
      descriptor("a", 1),
      descriptor("p1", 2, { origin: "shared", ownerName: "pat" }),
      descriptor("t1", 3, {
        origin: "shared",
        ownerName: "ann",
        teamId: "team-1",
        teamName: "R&D",
      }),
      descriptor("t2", 4, {
        origin: "shared",
        ownerName: "bob",
        teamId: "team-2",
        teamName: "Design",
      }),
    ]);
    mount();
    const shared = screen.getByRole("region", { name: "Shared with me" });
    const groups = [...shared.querySelectorAll("[data-team-group]")].map(
      (one) => one.getAttribute("data-team-group"),
    );
    expect(groups).toEqual(["team-1", "team-2", ""]);
    const rd = within(shared).getByRole("region", { name: "R&D" });
    expect(within(rd).getByRole("region", { name: "ann" })).toBeTruthy();
    const personal = within(shared).getByRole("region", { name: "Personal" });
    expect(within(personal).getByRole("region", { name: "pat" })).toBeTruthy();
    // 团队小组在个人分享之前。
    expect(order()).toEqual(["local", "a", "t1", "t2", "p1"]);

    const toggle = within(rd).getByRole("button", { name: "R&D" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(rd).queryByRole("region", { name: "ann" })).toBeNull();
    expect(localStorage.getItem("armadra.sidebar.teams.team-1")).toBe("0");
    expect(localStorage.getItem("armadra.sidebar.teams.team-2")).toBeNull();
  });

  it("折叠状态在重新挂载后还在；只有一个团队且没有个人分享时不画小组标题", async () => {
    localStorage.setItem("armadra.sidebar.teams.team-1", "0");
    await hydrate([
      descriptor("t1", 1, {
        origin: "shared",
        ownerName: "ann",
        teamId: "team-1",
        teamName: "R&D",
      }),
      descriptor("t2", 2, {
        origin: "shared",
        ownerName: "bob",
        teamId: "team-1",
        teamName: "R&D",
      }),
    ]);
    mount();
    const shared = screen.getByRole("region", { name: "Shared with me" });
    // 单团队、无个人分享：没有标题按钮，也就折不起来。
    expect(within(shared).queryByRole("button", { name: "R&D" })).toBeNull();
    expect(within(shared).getByRole("region", { name: "ann" })).toBeTruthy();
    expect(within(shared).getByRole("region", { name: "bob" })).toBeTruthy();
  });

  it("团队小组折叠状态读自本机", async () => {
    localStorage.setItem("armadra.sidebar.teams.team-1", "0");
    await hydrate([
      descriptor("p1", 1, { origin: "shared", ownerName: "pat" }),
      descriptor("t1", 2, {
        origin: "shared",
        ownerName: "ann",
        teamId: "team-1",
        teamName: "R&D",
      }),
    ]);
    mount();
    const toggle = screen.getByRole("button", { name: "R&D" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "ann" })).toBeNull();
    expect(screen.getByRole("region", { name: "pat" })).toBeTruthy();
  });

  it("点一行打开那个工作空间（带上它的源）；当前那台换成树", async () => {
    await hydrate([descriptor("a", 1)]);
    listed.data = [
      { sourceId: "a", workspace: { id: "w-remote", name: "Remote project" } },
      { sourceId: "local", workspace: { id: "w-local", name: "Local" } },
    ];
    mount();
    expect(screen.queryByText("Local")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remote project" }));
    expect(open).toHaveBeenCalledWith(
      { id: "w-remote", name: "Remote project" },
      "a",
    );
    act(() => selectCurrentSource(registry, "a"));
    const a = screen.getByRole("region", { name: "a-label" });
    expect(within(a).getByTestId("tree")).toBeTruthy();
    expect(screen.queryByText("Remote project")).toBeNull();
    // 本机不再是当前：列出本机的工作空间，外壳知道不是当前（不给添加项目）。
    const shell = screen.getByRole("region", { name: "local-shell" });
    expect(shell.getAttribute("data-current")).toBe("false");
    expect(within(shell).getByText("Local")).toBeTruthy();
  });

  it("离线与在连的电脑灰着列上次记下的名字、点不开，不挡本机", async () => {
    rememberWorkspaces("b", [{ id: "w-old", name: "Old project" }]);
    rememberWorkspaces("c", [{ id: "w-slow", name: "Slow project" }]);
    await hydrate([descriptor("b", 1), descriptor("c", 2)]);
    mount();
    expect(screen.getByTestId("tree")).toBeTruthy();
    const b = screen.getByRole("region", { name: "b-label" });
    expect(b.getAttribute("data-state")).toBe("offline");
    expect(within(b).getByText("Offline")).toBeTruthy();
    const old = within(b).getByRole("button", { name: "Old project" });
    expect((old as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(old);
    expect(open).not.toHaveBeenCalled();
    const c = screen.getByRole("region", { name: "c-label" });
    expect(c.getAttribute("data-state")).toBe("loading");
    expect(
      (
        within(c).getByRole("button", {
          name: "Slow project",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("就绪但列表还在路上：这一段在连，用记下的", async () => {
    rememberWorkspaces("a", [{ id: "w1", name: "Cached" }]);
    listed.pending.add("a");
    await hydrate([descriptor("a", 1)]);
    mount();
    const a = screen.getByRole("region", { name: "a-label" });
    expect(a.getAttribute("data-state")).toBe("loading");
    expect(within(a).getByText("Cached")).toBeTruthy();
  });
});

describe("拖动排序", () => {
  it("applyOrder：认得的按拖出的顺序，其余按原顺序跟在后面", async () => {
    await hydrate([descriptor("a", 1), descriptor("b", 2), descriptor("c", 3)]);
    const sections = registry
      .list()
      .filter((one) => one.descriptor.kind !== "local")
      .map((connection) => ({ connection }));
    const ids = (list: readonly { connection: SourceConnection }[]) =>
      list.map((one) => one.connection.descriptor.sourceId);
    expect(ids(applyOrder(sections, null))).toEqual(["a", "b", "c"]);
    expect(ids(applyOrder(sections, ["c", "a"]))).toEqual(["c", "a", "b"]);
    expect(ids(applyOrder(sections, ["gone", "b"]))).toEqual(["b", "a", "c"]);
  });

  it("浏览器页面（源表不在本机 core）：段头不可拖", async () => {
    await hydrate([descriptor("a", 1), descriptor("b", 2)]);
    mount();
    expect(
      screen.queryByRole("button", { name: /Drag to reorder/ }),
    ).toBeNull();
  });

  it("桌面壳：段头用键盘拖到下一位，侧栏先按新顺序画，分享的跟在后面写回", async () => {
    desktop.on = true;
    await hydrate([
      descriptor("a", 1),
      descriptor("b", 2),
      descriptor("ann", 3, { origin: "shared" }),
    ]);
    mount();
    expect(order()).toEqual(["local", "a", "b", "ann"]);
    const handle = screen.getByRole("button", {
      name: "Drag to reorder a-label",
    });
    // jsdom 没有布局：给两段各一个不重叠的位置，键盘传感器才找得到下一位。
    for (const [index, group] of document
      .querySelectorAll<HTMLElement>(
        '[data-workspace-group="mine"] [data-source-group]',
      )
      .entries()) {
      group.getBoundingClientRect = () =>
        ({
          x: 0,
          y: index * 40,
          top: index * 40,
          left: 0,
          bottom: index * 40 + 28,
          right: 200,
          width: 200,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;
    }
    handle.focus();
    await act(async () => {
      fireEvent.keyDown(handle, { key: " ", code: "Space" });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: " ", code: "Space" });
    });
    expect(order()).toEqual(["local", "b", "a", "ann"]);
    expect(reorder).toHaveBeenCalledWith(["b", "a", "ann"]);
  });
});

describe("切源清缓存", () => {
  it('换当前源：不带源前缀的查询清掉，["src", …] 留着', async () => {
    const client = new QueryClient();
    client.setQueryData(["settings"], { a: 1 });
    client.setQueryData(["src", "local", "workspaces"], []);
    await hydrate([descriptor("a", 1)]);
    renderHook(() => useSourceSwitchCacheReset(() => registry), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() =>
      selectCurrentSource(registry, registry.local().descriptor.sourceId),
    );
    expect(client.getQueryData(["settings"])).toEqual({ a: 1 });
    act(() => selectCurrentSource(registry, "a"));
    expect(client.getQueryData(["settings"])).toBeUndefined();
    expect(client.getQueryData(["src", "local", "workspaces"])).toEqual([]);
    dropUnscopedQueries(client);
  });
});
