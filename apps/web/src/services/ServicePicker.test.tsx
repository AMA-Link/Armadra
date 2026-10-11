import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../app/preferences-store";
import { followInitialSource } from "../app/use-sources-bootstrap";
import { clearJoinOpen, pendingJoinOpen } from "../sources/join-intent";
import type { SourceDescriptor } from "../sources/types";
import { memoryStorage } from "../mobile/testing";
import {
  forgetRecent,
  recentIds,
  recordRecent,
  setEnterIntent,
  takeEnterIntent,
} from "./recent";
import {
  layoutByOrigin,
  layoutServices,
  serviceRowOf,
  type ServiceRow,
} from "./rows";
import { ServicePicker } from "./ServicePicker";
import { initialSourceParam } from "./switcher";

const ISSUER = "https://relay.example.com";

function descriptor(
  sourceId: string,
  patch: Partial<SourceDescriptor> = {},
): SourceDescriptor {
  return {
    sourceId,
    kind: "direct",
    label: sourceId,
    baseUrl: "",
    relayOrigin: "",
    cloudIssuer: "",
    fingerprint: "",
    orderIndex: 0,
    ...patch,
  };
}

const viaRelay = (id: string, label = id) =>
  descriptor(id, {
    kind: "relayed",
    label,
    relayOrigin: ISSUER,
    cloudIssuer: ISSUER,
  });
const viaLan = (id: string, label = id) =>
  descriptor(id, { label, baseUrl: `https://${id}.lan:8443` });

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("行模型与排版", () => {
  it("两条路的主机只一行：首选直连，组按首选路分，第二行列出全部到达方式", () => {
    const both = descriptor("mac", {
      kind: "relayed",
      label: "MacBook",
      baseUrl: "https://mac.lan:8443",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
    });
    const row = serviceRowOf(both, { serviceName: () => "家里" });
    expect(row.routes.map((route) => route.via)).toEqual(["direct", "relayed"]);
    const layout = layoutServices([row, serviceRowOf(viaRelay("nas"))]);
    expect(layout.groups.map((group) => group.key)).toEqual([
      `relay:${ISSUER}`,
      "direct",
    ]);
    expect(layout.groups[1]!.rows).toEqual([row]);
  });

  it("名字缺省是主机名；远程服务名缺省是签发方主机", () => {
    expect(serviceRowOf(viaLan("box", "")).name).toBe("box.lan:8443");
    expect(serviceRowOf(viaRelay("box")).routes[0]!.serviceName).toBe(
      "relay.example.com",
    );
  });

  it("缺省名（§61）：有服务端报的名字用它，没有用地址兜底", () => {
    const named = serviceRowOf(viaLan("box", "工作机"));
    expect(named.defaultName).toBe("box.lan:8443");
    const reported = serviceRowOf({
      ...viaLan("box", ""),
      defaultLabel: "laptop",
    });
    expect(reported).toMatchObject({ name: "laptop", defaultName: "laptop" });
    const renamed = serviceRowOf({
      ...viaRelay("box", "我的"),
      defaultLabel: "studio",
    });
    expect(renamed).toMatchObject({ name: "我的", defaultName: "studio" });
  });

  it("行数超过 3 才单列最近使用", () => {
    const rows = ["a", "b", "c"].map((id) => serviceRowOf(viaLan(id)));
    expect(layoutServices(rows, ["b"]).recent).toEqual([]);
    const four = [...rows, serviceRowOf(viaLan("d"))];
    expect(
      layoutServices(four, ["d", "a"]).recent.map((row) => row.sourceId),
    ).toEqual(["d", "a"]);
  });
});

describe("最近使用与进入意图", () => {
  it("前插去重，最多 3 个；移除连接时一并去掉", () => {
    for (const id of ["a", "b", "c", "d", "b"]) recordRecent(id);
    expect(recentIds()).toEqual(["b", "d", "c"]);
    forgetRecent("d");
    expect(recentIds()).toEqual(["b", "c", "a"]);
  });

  it("意图只取一次", () => {
    setEnterIntent("a");
    expect(takeEnterIntent()).toBe("a");
    expect(takeEnterIntent()).toBeNull();
  });
});

describe("选择服务 · 整页", () => {
  const rows: ServiceRow[] = [
    ...["a", "b", "c"].map((id) => serviceRowOf(viaRelay(id, `relay-${id}`))),
    serviceRowOf(viaLan("d", "Studio")),
  ];

  it("最近使用在前，只有自己的电脑时不分组头，状态胶囊与「当前」在行上", () => {
    render(
      <ServicePicker
        variant="page"
        rows={rows}
        recent={["d"]}
        currentId="a"
        statuses={{ a: "online", d: "offline" }}
        onEnter={vi.fn()}
      />,
    );
    const recent = screen.getByText("最近使用").closest("section")!;
    expect(within(recent as HTMLElement).getByText("Studio")).toBeTruthy();
    expect(screen.getByText("全部")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.getByText("当前")).toBeTruthy();
    expect(screen.getAllByText("离线")).toHaveLength(2);
    // 未知只呼吸、文字只给读屏。
    expect(screen.getAllByText("未知")[0]!.className).toContain("sr-only");
  });

  it("点行进入；行尾移除要先确认", () => {
    const onEnter = vi.fn();
    const onRemove = vi.fn();
    render(
      <ServicePicker
        variant="page"
        rows={rows.slice(3)}
        onEnter={onEnter}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除 Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "移除连接" }));
    expect(onRemove).toHaveBeenCalledWith("d");
    fireEvent.click(screen.getByText("Studio"));
    expect(onEnter).toHaveBeenCalledWith("d");
  });

  it("重命名（§61）：预填现在的名字、占位是缺省名；清空保存交出空串", async () => {
    const onRename = vi.fn();
    render(
      <ServicePicker
        variant="page"
        rows={[
          serviceRowOf({
            ...viaLan("d", "Studio"),
            defaultLabel: "studio-mac",
          }),
        ]}
        onEnter={vi.fn()}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重命名 Studio" }));
    const input = await screen.findByRole("textbox", { name: "名称" });
    expect((input as HTMLInputElement).value).toBe("Studio");
    expect(input.getAttribute("placeholder")).toBe("studio-mac");
    fireEvent.change(input, { target: { value: "  书房  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(onRename).toHaveBeenLastCalledWith("d", "书房");

    fireEvent.click(screen.getByRole("button", { name: "重命名 Studio" }));
    const again = await screen.findByRole("textbox", { name: "名称" });
    fireEvent.change(again, { target: { value: "" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(onRename).toHaveBeenLastCalledWith("d", "");
  });

  it("重命名失败：消息留在对话框里，不关", async () => {
    const onRename = vi
      .fn()
      .mockRejectedValue(new Error("名称应为 1 到 128 个字符"));
    render(
      <ServicePicker
        variant="dialog"
        rows={[serviceRowOf(viaLan("d", "Studio"))]}
        onEnter={vi.fn()}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重命名 Studio" }));
    await screen.findByRole("textbox", { name: "名称" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    expect(screen.getByText("名称应为 1 到 128 个字符")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "名称" })).toBeTruthy();
  });

  it("不给 onRename 就没有重命名", () => {
    render(
      <ServicePicker
        variant="page"
        rows={[serviceRowOf(viaLan("d", "Studio"))]}
        onEnter={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "重命名 Studio" })).toBeNull();
  });

  it("两组：我的电脑 / 他人分享；分享的行写主人、权限与到期，不写路", () => {
    const shared = serviceRowOf({
      ...viaRelay("s", "设计稿"),
      origin: "shared",
      ownerName: "小王",
      shareRole: "viewer",
      shareExpiresAtMs: Date.UTC(2030, 0, 2),
    } as SourceDescriptor);
    const all = [...rows.slice(3), shared];
    expect(layoutByOrigin(all).map((group) => group.key)).toEqual([
      "mine",
      "shared",
    ]);
    render(<ServicePicker variant="page" rows={all} onEnter={vi.fn()} />);
    const heads = screen
      .getAllByRole("heading", { level: 3 })
      .map((head) => head.textContent);
    expect(heads).toEqual(["我的电脑", "他人分享"]);
    const sharedRow = document.querySelector('[data-service-row="s"]')!;
    expect(sharedRow.textContent).toContain("小王 · 查看 · 有效至");
    expect(sharedRow.textContent).not.toContain("互联网");
    expect(document.body.textContent).not.toMatch(/中转|中继|签发方|挂载|隧道/);
  });

  it("没有分享时只有一组，旧数据（无来历）当作自己的", () => {
    expect(layoutByOrigin(rows).map((group) => group.key)).toEqual(["mine"]);
    expect(layoutByOrigin([])).toEqual([]);
  });

  it("失败挂在那一行下面，带动作；登录失效的账号，那几行给「登录」", () => {
    const run = vi.fn();
    const onSignIn = vi.fn();
    render(
      <ServicePicker
        variant="page"
        rows={rows}
        signedOut={[ISSUER]}
        failure={{
          sourceId: "b",
          message: "这台主机不在线",
          action: { label: "重试", run },
        }}
        onEnter={vi.fn()}
        onSignIn={onSignIn}
      />,
    );
    const failure = document.querySelector('[data-service-failure="b"]')!;
    expect(failure.textContent).toContain("这台主机不在线");
    fireEvent.click(within(failure as HTMLElement).getByText("重试"));
    expect(run).toHaveBeenCalled();
    expect(screen.getAllByText("已登出").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "登录" })[0]!);
    expect(onSignIn).toHaveBeenCalledWith(ISSUER);
  });

  it("空表：还没有连接", () => {
    render(<ServicePicker variant="page" rows={[]} onEnter={vi.fn()} />);
    expect(screen.getByText("还没有连接")).toBeTruthy();
  });
});

describe("新窗口的初始当前源（?source=）", () => {
  it("只认像样的标识", () => {
    expect(initialSourceParam("?source=abc123")).toBe("abc123");
    expect(initialSourceParam("?source=../x")).toBeNull();
    expect(initialSourceParam("")).toBeNull();
  });

  it("记下等那个源连上后打开它的工作空间；没有参数什么也不做", () => {
    followInitialSource(null);
    expect(pendingJoinOpen()).toBeNull();
    followInitialSource("lan");
    expect(pendingJoinOpen()).toBe("lan");
    clearJoinOpen();
  });
});
