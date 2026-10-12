import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../app/preferences-store";
import { memoryStorage } from "../mobile/testing";
import { TrafficLedger, setTrafficLedger } from "../sources/traffic-meter";
import { MonthTrafficLine, SourceTraffic } from "./SourceTraffic";

/** 源的流量段（设计 §6.4）：范围切换、按类别、清零确认、行尾一小行。 */

let ledger: TrafficLedger;

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  vi.stubGlobal("localStorage", memoryStorage());
  ledger = new TrafficLedger({ timers: false });
  setTrafficLedger(ledger);
});

afterEach(() => {
  cleanup();
  setTrafficLedger(undefined);
  vi.unstubAllGlobals();
});

describe("SourceTraffic", () => {
  it("缺省本月；切到今日只看今天；清零要确认", async () => {
    const now = Date.now();
    ledger.record("s1", "terminal", 4096, 1024, 2);
    const yesterday = new TrafficLedger({
      now: () => now - 86_400_000,
      timers: false,
    });
    yesterday.record("s1", "files", 10_000, 0, 1);
    yesterday.flush();
    ledger.record("s2", "api", 1, 1, 1);
    render(<SourceTraffic sourceId="s1" name="工作机" />);
    const down = () =>
      document.querySelector('[data-traffic-cell="down"]')?.textContent;
    const sameMonth =
      new Date(now - 86_400_000).getMonth() === new Date(now).getMonth();
    expect(down()).toContain(sameMonth ? "13.8 KB" : "4 KB");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "今日" }));
    fireEvent.click(screen.getByRole("tab", { name: "今日" }));
    await vi.waitFor(() => expect(down()).toContain("4 KB"));
    expect(
      document.querySelector('[data-traffic-row="terminal"]')?.textContent,
    ).toContain("终端");
    fireEvent.click(screen.getByRole("button", { name: "清零" }));
    expect(screen.getByText("清零 工作机 的流量？")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole("button", { name: "清零" }).at(-1) as HTMLElement,
      );
    });
    expect(ledger.source("s1", "all").totals.bytesIn).toBe(0);
    expect(ledger.source("s2", "all").totals.bytesIn).toBe(1);
    await vi.waitFor(() => expect(screen.getByText("暂无流量")).toBeTruthy());
  });

  it("行尾一小行：没有流量不显示，有就写上下行", () => {
    const { rerender } = render(<MonthTrafficLine totals={undefined} />);
    expect(document.querySelector('[data-slot="month-traffic"]')).toBeNull();
    rerender(
      <MonthTrafficLine
        totals={{
          bytesIn: 180 * 1024 * 1024,
          bytesOut: 12 * 1024 * 1024,
          streams: 3,
        }}
      />,
    );
    const line = document.querySelector('[data-slot="month-traffic"]');
    expect(line?.textContent).toBe("↑ 12 MB ↓ 180 MB");
    expect(line?.getAttribute("aria-label")).toBe(
      "本月上行 12 MB，下行 180 MB",
    );
  });
});
