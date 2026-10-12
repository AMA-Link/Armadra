import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrafficRow, TrafficSummaryInput } from "@armadra/shared";

import { usePreferencesStore } from "../app/preferences-store";
import { HostTraffic } from "./HostTraffic";

/** 远程访问页的流量段（契约 §76）：三格、按设备 / 按类别、在线徽标、清零确认、保留期。 */

const api = vi.hoisted(() => ({
  summary: vi.fn(),
  live: vi.fn(),
  clear: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../api/traffic", () => ({
  TRAFFIC_QUERY_KEY: ["traffic"],
  trafficSummary: api.summary,
  trafficLive: api.live,
  clearTraffic: api.clear,
}));

vi.mock("../panels/settings/use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: { traffic: { retentionDays: 180 } } },
    save: { mutate: api.save },
  }),
}));

function row(patch: Partial<TrafficRow>): TrafficRow {
  return {
    key: "",
    label: "",
    peerKind: "",
    principalId: "",
    linkId: "",
    streams: 0,
    bytesIn: 0,
    bytesOut: 0,
    wireBytesIn: 0,
    wireBytesOut: 0,
    ...patch,
  };
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  api.summary.mockImplementation(async (input: TrafficSummaryInput) => ({
    retentionDays: 180,
    rows:
      input.groupBy === "peer"
        ? [
            row({ key: "tunnel", peerKind: "tunnel", wireBytesIn: 9e6 }),
            row({
              key: "d1",
              peerKind: "legacy",
              label: "Pixel · Alice",
              streams: 4,
              bytesIn: 2048,
              bytesOut: 3 * 1024 * 1024,
            }),
            row({
              key: "anonymous",
              peerKind: "anonymous",
              streams: 2,
              bytesIn: 100,
            }),
          ]
        : [
            row({ key: "transport", wireBytesIn: 9e6 }),
            row({ key: "files", streams: 1, bytesOut: 3 * 1024 * 1024 }),
            row({ key: "api", streams: 5, bytesIn: 2148 }),
          ],
  }));
  api.live.mockResolvedValue({
    channels: [
      {
        peerId: "d1",
        peerKind: "legacy",
        label: "Pixel",
        since: 0,
        streams: 1,
        bytesIn: 1,
        bytesOut: 1,
        rateIn: 1024,
        rateOut: 2048,
      },
    ],
  });
  api.clear.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HostTraffic />
    </QueryClientProvider>,
  );
}

const cell = (slot: string) =>
  document.querySelector(`[data-traffic-cell="${slot}"]`)?.textContent ?? "";

describe("HostTraffic", () => {
  it("缺省 7 天按设备：三格只算明文，线路一行不列，匿名有名字；在线徽标带速率", async () => {
    mount();
    await vi.waitFor(() => expect(cell("up")).toContain("3 MB"));
    expect(cell("down")).toContain("2.1 KB");
    expect(cell("streams")).toContain("6");
    expect(screen.getByText("Pixel · Alice")).toBeTruthy();
    expect(screen.getByText("未登录")).toBeTruthy();
    expect(
      document.querySelector('[data-traffic-row="tunnel:tunnel"]'),
    ).toBeNull();
    await vi.waitFor(() =>
      expect(screen.getByText("1 台在线 · ↑ 2 KB/s ↓ 1 KB/s")).toBeTruthy(),
    );
    expect(
      screen.getByRole("combobox", { name: "保留期" }).textContent,
    ).toContain("保留 180 天");
    const input = api.summary.mock.calls[0]![0] as TrafficSummaryInput;
    expect(input.groupBy).toBe("peer");
    expect(input.toMs - input.fromMs).toBe(8 * 86_400_000);
  });

  it("按类别：类别名中文，范围切到全部从 0 起", async () => {
    mount();
    await vi.waitFor(() =>
      expect(screen.getByText("Pixel · Alice")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("radio", { name: "按类别" }));
    await vi.waitFor(() => expect(screen.getByText("文件")).toBeTruthy());
    expect(screen.getByText("接口")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "全部" }));
    fireEvent.click(screen.getByRole("tab", { name: "全部" }));
    await vi.waitFor(() =>
      expect(
        api.summary.mock.calls.some(
          ([input]) => (input as TrafficSummaryInput).fromMs === 0,
        ),
      ).toBe(true),
    );
  });

  it("清零要确认", async () => {
    mount();
    await vi.waitFor(() => expect(cell("up")).toContain("3 MB"));
    fireEvent.click(screen.getByRole("button", { name: "清零" }));
    expect(screen.getByText("清零这台电脑的流量统计？")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "清零" }).at(-1)!);
    });
    await vi.waitFor(() => expect(api.clear).toHaveBeenCalled());
  });
});
