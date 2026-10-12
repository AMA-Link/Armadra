import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../app/preferences-store";
import { TrafficBreakdown } from "./TrafficBreakdown";

/** 流量的三格与比例条（设计 §6.6）：排序、比例、空态、清零入口。 */

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});

afterEach(cleanup);

describe("TrafficBreakdown", () => {
  it("三格是上行 · 下行 · 连接，分项按总量降序、最大的条满格", () => {
    render(
      <TrafficBreakdown
        up={2048}
        down={3 * 1024 * 1024}
        streams={7}
        rows={[
          { key: "api", label: "接口", up: 10, down: 90 },
          { key: "files", label: "文件", up: 0, down: 1000 },
          { key: "agent", label: "Agent", up: 0, down: 0 },
        ]}
      />,
    );
    const cell = (slot: string) =>
      document.querySelector(`[data-traffic-cell="${slot}"]`)?.textContent;
    expect(cell("up")).toContain("2 KB");
    expect(cell("down")).toContain("3 MB");
    expect(cell("streams")).toContain("7");
    const rows = [...document.querySelectorAll("[data-traffic-row]")].map(
      (row) => row.getAttribute("data-traffic-row"),
    );
    expect(rows).toEqual(["files", "api"]);
    expect(screen.getByRole("progressbar", { name: "文件" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清零" })).toBeNull();
  });

  it("全是零：空态，不给清零", () => {
    render(
      <TrafficBreakdown
        up={0}
        down={0}
        streams={0}
        rows={[]}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("暂无流量")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清零" })).toBeNull();
  });
});
