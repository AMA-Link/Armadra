import { act, cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { installDomPolyfills } from "../app/test-harness";
import { ConsoleRoot } from "./ConsoleRoot";
import { createMockApi } from "./mock/create-mock-client";
import { addPendingIds } from "./mock/pending-ids";
import { installConsoleHarness, visit } from "./testkit";
import type { HostEndorser } from "./trust/endorser";

installConsoleHarness();
installDomPolyfills();

const built = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("./trust/browser-endorser", () => ({
  createBrowserEndorser: built.create,
}));

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
    visit("/t/rd/trust");
    const api = addPendingIds(createMockApi(OPTIONS));
    const endorser = fake(true);
    render(<ConsoleRoot api={api} />);
    const rows = await trustRows();
    expect(
      await within(rows[0]!).findByRole("button", { name: "信任" }),
    ).toBeTruthy();
    expect(built.create).toHaveBeenCalledTimes(1);
    expect(built.create).toHaveBeenCalledWith({
      client: api.client,
      issuer: window.location.origin,
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
});
