import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { usePreferencesStore } from "../app/preferences-store";
import type { ServiceRow } from "../services/rows";
import { ConnectScreen } from "./ConnectScreen";
import { memoryStorage } from "./testing";

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

const RELAYED_ROW: ServiceRow = {
  sourceId: "s1",
  name: "MacBook",
  defaultName: "MacBook",
  local: false,
  routes: [
    {
      via: "relayed",
      issuer: "https://relay.example.com",
      serviceName: "relay.example.com",
    },
  ],
  lastUsedAt: null,
};
const DIRECT_ROW: ServiceRow = {
  sourceId: "s2",
  name: "192.168.1.8:8443",
  defaultName: "192.168.1.8:8443",
  local: false,
  routes: [{ via: "direct", issuer: "", serviceName: "" }],
  lastUsedAt: null,
};

describe("连接页 · 原生 App", () => {
  it("贴链接连接，失败时错误在输入框下面", async () => {
    const onConnect = vi.fn(async () => "expired" as const);
    render(<ConnectScreen mode="native" onConnect={onConnect} />);
    const connect = screen.getByRole("button", { name: "连接" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText("配对链接");
    fireEvent.change(input, { target: { value: " https://h:1/#pair=x " } });
    fireEvent.click(connect);
    await waitFor(() =>
      expect(screen.getByText("配对链接已失效，请重新扫码")).toBeTruthy(),
    );
    expect(onConnect).toHaveBeenCalledWith(" https://h:1/#pair=x ");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // 改字即清掉错误。
    fireEvent.change(input, { target: { value: "x" } });
    expect(screen.queryByText("配对链接已失效，请重新扫码")).toBeNull();
  });

  it("能扫码时多一个扫码钮，扫到即连", async () => {
    const onConnect = vi.fn(async () => null);
    const onScan = vi.fn(async () => "armadra://pair?host=h:1&ticket=t&fp=0");
    render(
      <ConnectScreen
        mode="native"
        canScan
        onScan={onScan}
        onConnect={onConnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "扫码" }));
    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith(
        "armadra://pair?host=h:1&ticket=t&fp=0",
      ),
    );
  });

  it("不能扫码时没有扫码钮", () => {
    render(<ConnectScreen mode="native" onConnect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "扫码" })).toBeNull();
  });

  it("连不上时说出是哪台", async () => {
    render(
      <ConnectScreen
        mode="native"
        origin="https://10.0.0.2:8443"
        failure="unreachable"
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByText("连不上 10.0.0.2:8443")).toBeTruthy();
  });
});

describe("连接页 · 手机浏览器", () => {
  it("只有地址、一个「连接」与 CA 引导，失败是一条 Alert", async () => {
    const onConnect = vi.fn(async () => "failed" as const);
    render(
      <ConnectScreen
        mode="web"
        origin="https://192.168.1.8:8443"
        caGuide={<div data-testid="ca" />}
        onConnect={onConnect}
      />,
    );
    expect(screen.getByText("192.168.1.8:8443")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("ca")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("配对没有成功")).toBeTruthy();
  });

  it("英文界面同样完整", () => {
    usePreferencesStore.setState({ locale: "en" });
    render(<ConnectScreen mode="native" canScan onConnect={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Connect to Armadra" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan QR code" })).toBeTruthy();
  });
});

describe("连接页 · 配对码", () => {
  // `input-otp` 聚焦时探一下密码管理器的徽标位置；jsdom 没有这个方法。
  beforeEach(() => {
    document.elementFromPoint = () => null;
  });

  function typeCode(value: string) {
    const input = screen.getByLabelText("配对码");
    fireEvent.change(input, { target: { value } });
  }

  it("手机浏览器手输地址打开：一上来就是 8 位配对码，输满自动兑换", async () => {
    const onCode = vi.fn(async () => null);
    const onSignIn = vi.fn();
    render(
      <ConnectScreen
        mode="web"
        origin="https://192.168.1.8:8443"
        codeFirst
        onCode={onCode}
        onSignIn={onSignIn}
        onConnect={vi.fn()}
      />,
    );
    expect(
      document.querySelectorAll("[data-slot=input-otp-slot]"),
    ).toHaveLength(8);
    expect(
      document.querySelectorAll("[data-slot=input-otp-group]"),
    ).toHaveLength(2);
    // 没有「改用配对链接」：这一页没有票。
    expect(screen.queryByRole("button", { name: "改用配对链接" })).toBeNull();
    typeCode("3f7k9q2m");
    // 没有地址栏时第二个参数是空串。
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("3F7K9Q2M", ""));
    fireEvent.click(screen.getByRole("button", { name: "账号登录" }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it("兑换失败：错误在下面，输入清空", async () => {
    const onCode = vi.fn(async () => "codeInvalid" as const);
    render(
      <ConnectScreen
        mode="web"
        origin="https://192.168.1.8:8443"
        codeFirst
        onCode={onCode}
        onConnect={vi.fn()}
      />,
    );
    typeCode("3F7K9Q2M");
    await waitFor(() =>
      expect(screen.getByText("配对码不对或已过期")).toBeTruthy(),
    );
    expect((screen.getByLabelText("配对码") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("原生 App：第三个入口「输入配对码」，可以切回链接", async () => {
    const onCode = vi.fn(async () => null);
    render(
      <ConnectScreen
        mode="native"
        origin="https://10.0.0.2:8443"
        canScan
        onScan={vi.fn()}
        onCode={onCode}
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "扫码" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "输入配对码" }));
    expect(screen.queryByLabelText("配对链接")).toBeNull();
    typeCode("ABCD2345");
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("ABCD2345", ""));
    fireEvent.click(screen.getByRole("button", { name: "改用配对链接" }));
    expect(screen.getByLabelText("配对链接")).toBeTruthy();
  });

  it("原生 App 首次连接（§73）：配对码页多一栏地址，地址随码一起交出", async () => {
    const onCode = vi.fn(async () => null);
    render(
      <ConnectScreen
        mode="native"
        codeAddress
        onCode={onCode}
        onConnect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "输入配对码" }));
    const address = screen.getByLabelText("地址") as HTMLInputElement;
    expect(address.value).toBe("");
    // 没填地址输满码：不交，提示地址不对。
    typeCode("ABCD2345");
    await waitFor(() => expect(screen.getByText("地址不对")).toBeTruthy());
    expect(onCode).not.toHaveBeenCalled();
    fireEvent.change(address, { target: { value: " 192.168.1.5:8443 " } });
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(onCode).toHaveBeenCalledWith("ABCD2345", "192.168.1.5:8443"),
    );
  });

  it("记下过来源时地址栏预填它的主机；失败文案带上输入的地址", async () => {
    const onCode = vi.fn(async () => "unreachable" as const);
    render(
      <ConnectScreen
        mode="native"
        origin="https://10.0.0.2:8443"
        codeAddress
        onCode={onCode}
        onConnect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "输入配对码" }));
    expect((screen.getByLabelText("地址") as HTMLInputElement).value).toBe(
      "10.0.0.2:8443",
    );
    typeCode("ABCD2345");
    await waitFor(() =>
      expect(screen.getByText("连不上 10.0.0.2:8443")).toBeTruthy(),
    );
  });

  it("没给 onCode 就没有这个入口", () => {
    render(<ConnectScreen mode="native" onConnect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "输入配对码" })).toBeNull();
  });
});

describe("连接页 · 多连接（添加连接）", () => {
  const FP = "9b3e7c1a04d85f62e1a7b90c3d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4";
  const outcomes = () => {
    const relay = {
      begin: vi.fn(),
      beginDevice: vi.fn(),
      pollDevice: vi.fn(),
      openVerification: vi.fn(async () => true),
      cancelDevice: vi.fn(),
      isCloud: vi.fn(async () => false),
      join: vi.fn(),
      trust: vi.fn(),
      mount: vi.fn(),
      reset: vi.fn(),
    };
    return relay;
  };
  const base = {
    mode: "native" as const,
    canScan: true,
    onConnect: vi.fn(async () => null),
    onScan: vi.fn(async () => null),
  };

  it("没有连接时直接是几种方式：扫码、配对链接、Armadra 云、中转账号；没有预告字样", () => {
    render(<ConnectScreen {...base} relay={outcomes()} />);
    expect(screen.getByRole("button", { name: "扫码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "配对链接" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Armadra 云" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "中转账号" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SaaS|即将|预留|敬请/);
  });

  it("「配对链接」有不依赖文案的标记，点了才出输入框（真机插桩用例按它走）", () => {
    render(<ConnectScreen {...base} relay={outcomes()} />);
    expect(
      document.querySelector('[data-slot="mobile-connect"] input'),
    ).toBeNull();
    const link = document.querySelector<HTMLButtonElement>(
      '[data-slot="mobile-connect"] [data-connect-method="link"]',
    );
    expect(link?.textContent).toBe("配对链接");
    fireEvent.click(link as HTMLButtonElement);
    expect(
      document.querySelector('[data-slot="mobile-connect"] input'),
    ).not.toBeNull();
  });

  it("个人中转：地址、账号、口令 → 核对指纹 → 选择主机 → 挂载", async () => {
    const relay = outcomes();
    relay.begin.mockResolvedValue({ kind: "fingerprint", fingerprint: FP });
    relay.trust.mockResolvedValue({
      kind: "sources",
      sources: [
        { sourceId: "s1", name: "MacBook", online: true },
        { sourceId: "s2", name: "Studio", online: false },
      ],
    });
    relay.mount.mockResolvedValue({ kind: "done" });
    render(<ConnectScreen {...base} relay={relay} />);
    fireEvent.click(screen.getByRole("button", { name: "中转账号" }));
    const signIn = screen.getByRole("button", { name: "登录" });
    expect((signIn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "pw" },
    });
    fireEvent.click(signIn);
    await waitFor(() => expect(screen.getByText("核对指纹")).toBeTruthy());
    expect(relay.begin).toHaveBeenCalledWith({
      issuer: "relay.example.com",
      account: "owner",
      password: "pw",
    });
    // 主机与指纹分组显示，便于逐段比对。
    expect(screen.getByText("relay.example.com")).toBeTruthy();
    expect(screen.getByText("9b3e7c1a 04d85f62")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "信任并继续" }));
    await waitFor(() => expect(screen.getByText("选择主机")).toBeTruthy());
    // 在线的默认选中，离线的不能选。
    const online = screen.getByRole("checkbox", { name: "MacBook" });
    expect(online.getAttribute("aria-checked")).toBe("true");
    const offline = screen.getByRole("checkbox", { name: /Studio/ });
    expect((offline as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(relay.mount).toHaveBeenCalledWith(["s1"]));
  });

  it("要人机验证：升起挑战面板，令牌到了带着刚填的账号口令再登录一次", async () => {
    const relay = outcomes();
    relay.begin
      .mockResolvedValueOnce({ kind: "challenge", siteKey: "0xSITE" })
      .mockResolvedValueOnce({ kind: "done" });
    render(<ConnectScreen {...base} relay={relay} initialView="relay" />);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "o" } });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    const frame = await waitFor(() => {
      const found = document.querySelector("iframe");
      if (found === null) throw new Error("no frame");
      return found;
    });
    const url = new URL(frame.getAttribute("src")!);
    expect(url.origin).toBe("https://relay.example.com");
    expect(url.searchParams.get("siteKey")).toBe("0xSITE");
    expect(relay.begin).toHaveBeenCalledTimes(1);
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "armadra-challenge", token: "tk-9" },
        origin: "https://relay.example.com",
        // 面板只认它内嵌的那个挑战页发来的消息。
        source: (frame as HTMLIFrameElement).contentWindow,
      }),
    );
    await waitFor(() =>
      expect(relay.begin).toHaveBeenLastCalledWith({
        issuer: "relay.example.com",
        account: "o",
        password: "pw",
        challengeToken: "tk-9",
      }),
    );
  });

  it("人机验证没通过：给原因，不再自动弹面板", async () => {
    const relay = outcomes();
    relay.begin.mockResolvedValue({
      kind: "failure",
      failure: "challengeInvalid",
    });
    render(<ConnectScreen {...base} relay={relay} initialView="relay" />);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "o" } });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await screen.findByText("人机验证没有通过，请重试");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("口令错：错误在口令框下面，改字即清掉", async () => {
    const relay = outcomes();
    relay.begin.mockResolvedValue({ kind: "failure", failure: "credentials" });
    render(<ConnectScreen {...base} relay={relay} initialView="relay" />);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "o" } });
    const password = screen.getByLabelText("口令");
    fireEvent.change(password, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(screen.getByText("账号或口令不对")).toBeTruthy(),
    );
    expect(password.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(password, { target: { value: "bad2" } });
    expect(screen.queryByText("账号或口令不对")).toBeNull();
  });

  it("取消核对指纹：回到添加连接，并让中转那一步作废", async () => {
    const relay = outcomes();
    render(
      <ConnectScreen
        {...base}
        relay={relay}
        initialView="fingerprint"
        initialFingerprint={FP}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(relay.reset).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "中转账号" })).toBeTruthy();
  });

  it("贴进链接框的分享链接与扫到的二维码都走挂载；别的仍是配对", async () => {
    const relay = outcomes();
    relay.join.mockResolvedValue({ kind: "done" });
    const share = `https://relay.example.com/j/${"0".repeat(32)}#${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;
    const onScan = vi.fn(async () => share);
    const onConnect = vi.fn(async () => null);
    render(
      <ConnectScreen
        {...base}
        relay={relay}
        onScan={onScan}
        onConnect={onConnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "扫码" }));
    await waitFor(() => expect(relay.join).toHaveBeenCalledWith(share));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("收到分享深链：一打开就挂载一次", async () => {
    const relay = outcomes();
    relay.join.mockResolvedValue({ kind: "done" });
    const link = `armadra://join?link=${"0".repeat(32)}&issuer=${encodeURIComponent("https://relay.example.com")}&s=${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;
    render(
      <ConnectScreen {...base} relay={relay} initialLink={link} autoJoin />,
    );
    await waitFor(() => expect(relay.join).toHaveBeenCalledWith(link));
    expect(relay.join).toHaveBeenCalledTimes(1);
  });

  it("连接列表：点一行进入；移除要先确认", async () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        connections={[RELAYED_ROW, DIRECT_ROW]}
        activeId="s1"
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText("当前")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除 MacBook" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移除连接" }));
    expect(onRemove).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByText("MacBook"));
    expect(onOpen).toHaveBeenCalledWith("s1");
    // 进入中（页面随即重载）整表不可点，免得连点两下。
    expect(
      (
        screen.getByRole("button", {
          name: "移除 MacBook",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // 添加连接在列表下面。
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    expect(screen.getByRole("button", { name: "中转账号" })).toBeTruthy();
  });

  it("流量（§76）：行尾本月上下行；点「流量」看这个源的分项，返回回到列表", async () => {
    const { TrafficLedger, setTrafficLedger } = await import(
      "../sources/traffic-meter"
    );
    vi.stubGlobal("localStorage", memoryStorage());
    const ledger = new TrafficLedger({ timers: false });
    setTrafficLedger(ledger);
    ledger.record("s1", "terminal", 2048, 1024, 1);
    try {
      render(
        <ConnectScreen
          {...base}
          relay={outcomes()}
          connections={[RELAYED_ROW, DIRECT_ROW]}
          activeId="s1"
        />,
      );
      expect(
        document.querySelector('[data-slot="month-traffic"]')?.textContent,
      ).toBe("↑ 1 KB ↓ 2 KB");
      fireEvent.click(screen.getByRole("button", { name: "MacBook 的流量" }));
      expect(screen.getByRole("heading", { name: "MacBook" })).toBeTruthy();
      expect(
        document.querySelector('[data-traffic-row="terminal"]'),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "返回" }));
      expect(screen.getByRole("heading", { name: "选择服务" })).toBeTruthy();
    } finally {
      setTrafficLedger(undefined);
      vi.unstubAllGlobals();
    }
  });

  it("标题是「选择服务」，在线状态与到达方式在行上", () => {
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        connections={[RELAYED_ROW, DIRECT_ROW]}
        statuses={{ s1: "online", s2: "offline" }}
        activeId="s1"
      />,
    );
    expect(screen.getByRole("heading", { name: "选择服务" })).toBeTruthy();
    expect(screen.getByText("在线")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getByText("互联网")).toBeTruthy();
    expect(screen.getByText("局域网")).toBeTruthy();
    // 都是自己的电脑：只有一组，没有组头。
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("有他人分享时分两组：我的电脑 / 他人分享，不出现“这台电脑”", () => {
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        connections={[
          RELAYED_ROW,
          { ...DIRECT_ROW, origin: "shared", ownerName: "小王" },
        ]}
        activeId="s1"
      />,
    );
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["我的电脑", "他人分享"]);
    expect(screen.queryByText("本机")).toBeNull();
    expect(screen.queryByText("这台电脑")).toBeNull();
  });

  it("进不去的那一行：失败挂在它下面；经中继而需要重新登录时给「登录」", async () => {
    const relay = outcomes();
    render(
      <ConnectScreen
        {...base}
        relay={relay}
        initialFailure="expired"
        failedId="s1"
        connections={[RELAYED_ROW, DIRECT_ROW]}
        activeId="s1"
      />,
    );
    const failure = document.querySelector('[data-service-failure="s1"]');
    expect(failure?.textContent).toContain("配对链接已失效");
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    // 中转表单预填那个远程服务。
    await waitFor(() =>
      expect((screen.getByLabelText("地址") as HTMLInputElement).value).toBe(
        "https://relay.example.com",
      ),
    );
    expect(screen.getByLabelText("口令")).toBeTruthy();
  });

  it("登录失效的是 Armadra 云：点「登录」直达设备码，用那个连接自己的签发方，没有地址与口令", async () => {
    const relay = outcomes();
    relay.isCloud.mockResolvedValue(true);
    relay.beginDevice.mockResolvedValue({
      kind: "device",
      userCode: "BCDF-GHJK",
      expiresAtMs: Date.now() + 600_000,
      intervalMs: 5_000,
    });
    render(
      <ConnectScreen
        {...base}
        relay={relay}
        initialFailure="expired"
        failedId="s1"
        connections={[RELAYED_ROW, DIRECT_ROW]}
        activeId="s1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(relay.beginDevice).toHaveBeenCalledWith({
        issuer: "https://relay.example.com",
      }),
    );
    expect(relay.isCloud).toHaveBeenCalledWith("https://relay.example.com");
    await screen.findByText("BCDF-GHJK");
    expect(screen.queryByLabelText("地址")).toBeNull();
    expect(screen.queryByLabelText("账号")).toBeNull();
    expect(screen.queryByLabelText("口令")).toBeNull();
  });

  it("从画布回来的：「返回」回到当前那一个", () => {
    const onOpen = vi.fn();
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        connections={[RELAYED_ROW, DIRECT_ROW]}
        activeId="s2"
        manage
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onOpen).toHaveBeenCalledWith("s2");
  });

  it("选中的连接连不上：原因显示在列表上方，一动手就清掉", () => {
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        initialFailure="offline"
        connections={[RELAYED_ROW]}
        activeId="s1"
      />,
    );
    expect(screen.getByText("这台主机不在线")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    expect(screen.queryByText("这台主机不在线")).toBeNull();
  });
});

describe("连接页 · Armadra 云（设备码）", () => {
  const device = {
    kind: "device" as const,
    userCode: "BCDF-GHJK",
    expiresAtMs: Date.now() + 600_000,
    intervalMs: 5_000,
  };
  const setup = () => {
    const relay = {
      begin: vi.fn(),
      beginDevice: vi.fn(async () => device),
      pollDevice: vi.fn(),
      openVerification: vi.fn(async () => true),
      cancelDevice: vi.fn(),
      isCloud: vi.fn(async () => true),
      join: vi.fn(),
      trust: vi.fn(),
      mount: vi.fn(),
      reset: vi.fn(),
    };
    relay.pollDevice.mockResolvedValue({ kind: "pending" });
    return relay;
  };
  const base = {
    mode: "native" as const,
    canScan: false,
    onConnect: vi.fn(async () => null),
    onScan: vi.fn(async () => null),
  };
  /** 到「等待批准」那一页。 */
  const waiting = async (
    relay: ReturnType<typeof setup>,
    extra: Partial<React.ComponentProps<typeof ConnectScreen>> = {},
  ) => {
    render(
      <ConnectScreen {...base} {...extra} relay={relay} initialView="cloud" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await tick(0);
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();
  };
  /** 推进假时钟并让排队的异步收尾。 */
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("添加连接里有「Armadra 云」：只剩「登录」，没有地址、账号与口令输入", () => {
    render(<ConnectScreen {...base} relay={setup()} />);
    fireEvent.click(screen.getByRole("button", { name: "Armadra 云" }));
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
    // 显示的是默认地址的主机。
    expect(screen.getByText("app.armadra.com")).toBeTruthy();
  });

  it("构建时覆盖了云地址：登录用覆盖值，界面仍没有地址输入", async () => {
    vi.stubEnv("VITE_ARMADRA_CLOUD_ISSUER", "https://cloud.example.test");
    try {
      const relay = setup();
      render(<ConnectScreen {...base} relay={relay} />);
      fireEvent.click(screen.getByRole("button", { name: "Armadra 云" }));
      expect(screen.getByText("cloud.example.test")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await tick(0);
      expect(relay.beginDevice).toHaveBeenCalledWith({
        issuer: "https://cloud.example.test",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("点「登录」发起设备码，显示用户码与等待批准；按间隔轮询，批准后进选主机", async () => {
    const relay = setup();
    await waiting(relay);
    expect(relay.beginDevice).toHaveBeenCalledWith({
      issuer: "https://app.armadra.com",
    });
    expect(screen.getByText("等待在浏览器中批准")).toBeTruthy();
    expect(screen.getByRole("button", { name: "在浏览器中打开" })).toBeTruthy();
    // 不再有任何账号口令输入。
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await tick(4_999);
    expect(relay.pollDevice).not.toHaveBeenCalled();
    await tick(1);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();

    relay.pollDevice.mockResolvedValue({
      kind: "sources",
      sources: [{ sourceId: "s1", name: "MacBook", online: true }],
    });
    await tick(5_000);
    expect(screen.getByRole("checkbox", { name: /MacBook/ })).toBeTruthy();
    expect(screen.queryByText("BCDF-GHJK")).toBeNull();
    await tick(60_000);
    expect(relay.pollDevice).toHaveBeenCalledTimes(2);
  });

  it("在浏览器中打开：再开一次批准页", async () => {
    const relay = setup();
    await waiting(relay);
    fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
    expect(relay.openVerification).toHaveBeenCalledTimes(1);
  });

  it("回到前台立即补一次轮询，不等下一个间隔", async () => {
    const relay = setup();
    await waiting(relay);
    await tick(5_000);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    await tick(2_000);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(0);
    expect(relay.pollDevice).toHaveBeenCalledTimes(2);
  });

  it("浏览器里批准后深链回到 App：收到事件立即问一次，不等间隔；离开等待页即取消订阅", async () => {
    const relay = setup();
    let notify: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const onDeviceApproved = vi.fn((listener: () => void) => {
      notify = listener;
      return unsubscribe;
    });
    await waiting(relay, { onDeviceApproved });
    expect(onDeviceApproved).toHaveBeenCalledTimes(1);
    expect(relay.pollDevice).not.toHaveBeenCalled();
    act(() => notify());
    await tick(0);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    // 事件不重载页面：设备码还在。
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();
    expect(relay.cancelDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("事件到时正有一次在途：那一次答完 pending 后马上再问，批准的结果不被错过", async () => {
    const relay = setup();
    let notify: () => void = () => undefined;
    await waiting(relay, {
      onDeviceApproved: (listener) => {
        notify = listener;
        return () => undefined;
      },
    });
    let release: (answer: unknown) => void = () => undefined;
    relay.pollDevice.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    await tick(5_000);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    act(() => notify());
    await tick(0);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    relay.pollDevice.mockResolvedValue({
      kind: "sources",
      sources: [{ sourceId: "s1", name: "MacBook", online: true }],
    });
    release({ kind: "pending" });
    await tick(0);
    expect(relay.pollDevice).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("checkbox", { name: /MacBook/ })).toBeTruthy();
  });

  it("轮询在途：显示「正在确认」，取消被禁用，不会作废当前设备码；答复回来后恢复", async () => {
    const relay = setup();
    await waiting(relay);
    let release: (answer: unknown) => void = () => undefined;
    relay.pollDevice.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    await tick(5_000);
    expect(screen.getByText("正在确认")).toBeTruthy();
    expect(screen.queryByText("等待在浏览器中批准")).toBeNull();
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel.hasAttribute("disabled")).toBe(true);
    fireEvent.click(cancel);
    expect(relay.cancelDevice).not.toHaveBeenCalled();
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();

    release({ kind: "pending" });
    await tick(0);
    expect(screen.getByText("等待在浏览器中批准")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "取消" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("在途的一次答出终结（拒绝）：「新设备码」不再被「正在确认」锁住", async () => {
    const relay = setup();
    await waiting(relay);
    let release: (answer: unknown) => void = () => undefined;
    relay.pollDevice.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    await tick(5_000);
    release({ kind: "failure", failure: "denied" });
    await tick(0);
    expect(screen.queryByText("正在确认")).toBeNull();
    expect(
      screen.getByRole("button", { name: "新设备码" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("被拒绝：显示原因并停止轮询，「新设备码」重新发起", async () => {
    const relay = setup();
    relay.pollDevice.mockResolvedValue({ kind: "failure", failure: "denied" });
    await waiting(relay);
    await tick(5_000);
    expect(screen.getByText("已在浏览器中拒绝")).toBeTruthy();
    expect(screen.queryByText("等待在浏览器中批准")).toBeNull();
    await tick(60_000);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "新设备码" }));
    await tick(0);
    expect(relay.beginDevice).toHaveBeenCalledTimes(2);
    expect(relay.beginDevice).toHaveBeenLastCalledWith({
      issuer: "https://app.armadra.com",
    });
    expect(screen.getByText("等待在浏览器中批准")).toBeTruthy();
  });

  it("过期：给原因", async () => {
    const relay = setup();
    relay.pollDevice.mockResolvedValue({
      kind: "failure",
      failure: "deviceExpired",
    });
    await waiting(relay);
    await tick(5_000);
    expect(screen.getByText("设备码已过期")).toBeTruthy();
  });

  it("被限流：按对端给的时间退避再问，期间界面不报错", async () => {
    const relay = setup();
    relay.pollDevice
      .mockResolvedValueOnce({ kind: "retry", afterMs: 12_000 })
      .mockResolvedValue({ kind: "pending" });
    await waiting(relay);
    await tick(5_000);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    await tick(11_999);
    expect(relay.pollDevice).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(relay.pollDevice).toHaveBeenCalledTimes(2);
    expect(screen.getByText("等待在浏览器中批准")).toBeTruthy();
  });

  it("取消：丢掉设备码、不再轮询，回到地址页", async () => {
    const relay = setup();
    await waiting(relay);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(relay.cancelDevice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
    await tick(60_000);
    expect(relay.pollDevice).not.toHaveBeenCalled();
  });

  it("发起失败：原因显示在「登录」上方，可再点，不进等待页", async () => {
    const relay = setup();
    relay.beginDevice.mockResolvedValue({
      kind: "failure",
      failure: "notCloud",
    } as never);
    render(<ConnectScreen {...base} relay={relay} initialView="cloud" />);
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await tick(0);
    expect(screen.getByText("这个地址不是 Armadra 云")).toBeTruthy();
    expect(relay.pollDevice).not.toHaveBeenCalled();
  });

  it("账号口令表单里填了云的地址：begin 改走设备码时同样进等待页", async () => {
    const relay = setup();
    relay.begin.mockResolvedValue(device);
    render(<ConnectScreen {...base} relay={relay} initialView="relay" />);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "cloud.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "o" } });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await tick(0);
    expect(screen.getByText("BCDF-GHJK")).toBeTruthy();
    expect(screen.getByText("等待在浏览器中批准")).toBeTruthy();
  });
});
