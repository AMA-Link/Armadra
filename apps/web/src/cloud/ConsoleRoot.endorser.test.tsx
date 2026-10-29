import { act, cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { installDomPolyfills } from "../app/test-harness";
import { ConsoleRoot } from "./ConsoleRoot";
import { createMockApi } from "./mock/create-mock-client";
import { MOCK_PERSONAL } from "./mock/fixtures";
import { addPendingIds } from "./mock/pending-ids";
import { installConsoleHarness, visit } from "./testkit";
import type { HostEndorser } from "./trust/endorser";

installConsoleHarness();
installDomPolyfills();

const built = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
  channels: [] as unknown[],
}));

vi.mock("./trust/browser-endorser", () => ({
  createBrowserEndorser: built.create,
}));

// 真的通道池，只记下建出来的那一个：背书人与「新建链接」要拿到同一个。
vi.mock("./host-channel", async (importOriginal) => {
  const real = await importOriginal<typeof import("./host-channel")>();
  return {
    ...real,
    createHostChannel: (...args: Parameters<typeof real.createHostChannel>) => {
      const channel = real.createHostChannel(...args);
      built.channels.push(channel);
      return channel;
    },
  };
});

const OPTIONS = { emailVerified: true, moreTrust: true } as const;

function fake(trusted: boolean) {
  const endorser: HostEndorser = {
    canEndorse: vi.fn(async () => trusted),
    approve: vi.fn(async () => undefined),
    dispose: built.dispose,
  };
  built.create.mockReturnValue(endorser);
  return endorser;
}

const trustRows = async () =>
  within(await screen.findByRole("table", { name: "设备信任" }))
    .getAllByRole("row")
    .slice(1);

describe("ConsoleRoot · 背书人注入", () => {
  it("缺省是生产背书人：用页面自己的客户端与来源，信任页据此给「信任」", async () => {
    built.create.mockReset();
    built.channels.length = 0;
    visit("/t/rd/trust");
    const api = addPendingIds(createMockApi(OPTIONS));
    const endorser = fake(true);
    render(<ConsoleRoot api={api} />);
    const rows = await trustRows();
    expect(
      await within(rows[0]!).findByRole("button", { name: "信任" }),
    ).toBeTruthy();
    expect(built.create).toHaveBeenCalledTimes(1);
    // 背书人用 ConsoleRoot 建的那一个通道池（与「新建链接」共用），不自己另建。
    expect(built.channels).toHaveLength(1);
    expect(built.create).toHaveBeenCalledWith({
      client: api.client,
      issuer: window.location.origin,
      channel: built.channels[0],
    });
    expect(endorser.canEndorse).toHaveBeenCalled();
  });

  it("卸载时放掉通道与访问", async () => {
    built.create.mockReset();
    built.dispose.mockReset();
    visit("/t/rd/trust");
    fake(true);
    render(<ConsoleRoot api={addPendingIds(createMockApi(OPTIONS))} />);
    await trustRows();
    cleanup();
    expect(built.dispose).toHaveBeenCalled();
  });

  it("会话丢失时放掉通道与主机会话", async () => {
    built.create.mockReset();
    built.dispose.mockReset();
    visit("/t/rd/trust");
    fake(true);
    const api = addPendingIds(createMockApi(OPTIONS));
    let lose: (() => void) | undefined;
    api.onSessionLost = (listener) => {
      lose = listener;
      return () => undefined;
    };
    render(<ConsoleRoot api={api} />);
    await trustRows();
    built.dispose.mockClear();
    act(() => lose?.());
    expect(built.dispose).toHaveBeenCalled();
  });

  it("显式 null 不建生产背书人：一律「在已信任的设备上处理」", async () => {
    built.create.mockReset();
    visit("/t/rd/trust");
    render(
      <ConsoleRoot
        api={addPendingIds(createMockApi(OPTIONS))}
        endorser={null}
      />,
    );
    const rows = await trustRows();
    expect(
      await within(rows[0]!).findByText("在已信任的设备上处理"),
    ).toBeTruthy();
    expect(built.create).not.toHaveBeenCalled();
  });

  it("调用方给了背书人就用它，不建生产的", async () => {
    built.create.mockReset();
    visit("/t/rd/trust");
    const given: HostEndorser = {
      canEndorse: vi.fn(async () => true),
      approve: vi.fn(async () => undefined),
    };
    render(
      <ConsoleRoot
        api={addPendingIds(createMockApi(OPTIONS))}
        endorser={given}
      />,
    );
    const rows = await trustRows();
    expect(
      await within(rows[0]!).findByRole("button", { name: "信任" }),
    ).toBeTruthy();
    expect(built.create).not.toHaveBeenCalled();
  });

  it("缺省的通道池也给「新建链接」：主人的主机链接页签有按钮；显式 null 就没有", async () => {
    built.create.mockReset();
    fake(true);
    visit(`/me/hosts/${MOCK_PERSONAL.linkHost}?tab=links`);
    render(<ConsoleRoot api={createMockApi(OPTIONS)} />);
    expect(
      await screen.findByRole("button", { name: "新建链接" }),
    ).toBeTruthy();
    cleanup();
    visit(`/me/hosts/${MOCK_PERSONAL.linkHost}?tab=links`);
    render(<ConsoleRoot api={createMockApi(OPTIONS)} hostChannel={null} />);
    expect(await screen.findByText(MOCK_PERSONAL.linkLabel)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建链接" })).toBeNull();
  });
});
