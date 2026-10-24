import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PERSONAL } from "../mock/fixtures";
import { h1, mount, installConsoleHarness } from "../testkit";

installConsoleHarness();

const LAPTOP = MOCK_PERSONAL.linkHost;
const NAS = "00000000000000000000000000000005";

const rowOf = (name: string) =>
  screen.getByRole("link", { name }).closest("tr") as HTMLElement;

describe("me-stream 就地更新", () => {
  it("sourceOffline / sourceOnline 就地改状态列，不重拉目录", async () => {
    const api = mount("/me/hosts");
    await screen.findByText("laptop");
    const list = vi.spyOn(api.client.sources, "list");
    expect(within(rowOf("laptop")).getByText("在线")).toBeTruthy();

    act(() =>
      api.emit({ type: "sourceOffline", sourceId: LAPTOP, atMs: Date.now() }),
    );
    // react-query 通知订阅者是异步的。
    await waitFor(() =>
      expect(within(rowOf("laptop")).getByText("离线")).toBeTruthy(),
    );
    expect(within(rowOf("laptop")).queryByText("在线")).toBeNull();

    act(() =>
      api.emit({
        type: "sourceOnline",
        sourceId: NAS,
        sinceMs: Date.now(),
        relayOrigin: "https://relay.armadra.test",
      }),
    );
    await waitFor(() =>
      expect(within(rowOf("nas")).getByText("在线")).toBeTruthy(),
    );
    expect(within(rowOf("nas")).getByText("刚刚")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it("sourceRevoked 把那台主机从目录去掉", async () => {
    const api = mount("/me/hosts");
    await screen.findByText("laptop");
    act(() => api.emit({ type: "sourceRevoked", sourceId: LAPTOP }));
    await waitFor(() => expect(screen.queryByText("laptop")).toBeNull());
    expect(screen.getByText("nas")).toBeTruthy();
  });

  it("详情页：上下线就地改页头状态；被撤销后整页找不到", async () => {
    const api = mount(`/me/hosts/${LAPTOP}`);
    await h1();
    expect(screen.getByText("在线")).toBeTruthy();
    act(() =>
      api.emit({ type: "sourceOffline", sourceId: LAPTOP, atMs: Date.now() }),
    );
    expect(await screen.findByText("离线")).toBeTruthy();
    act(() => api.emit({ type: "sourceRevoked", sourceId: LAPTOP }));
    expect(await screen.findByText("找不到这个页面")).toBeTruthy();
  });

  it("linkUsed 把链接的用量就地加一，不重拉列表", async () => {
    const api = mount("/me/links");
    await screen.findByText("给小李看进度");
    const list = vi.spyOn(api.client.links, "list");
    expect(screen.getByText("2 / 5")).toBeTruthy();
    act(() =>
      api.emit({
        type: "linkUsed",
        linkId: "link_one",
        sourceId: LAPTOP,
        by: { guest: true },
        atMs: Date.now(),
      }),
    );
    expect(await screen.findByText("3 / 5")).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });
});
