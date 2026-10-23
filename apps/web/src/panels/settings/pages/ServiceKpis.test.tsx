import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { HostResources } from "@armadra/shared";

import { usePreferencesStore } from "@/app/preferences-store";
import { ServiceKpis } from "./ServiceKpis";

const GIB = 1024 ** 3;

const HOST: HostResources = {
  hostId: "local",
  location: "local",
  platform: "darwin",
  cpuPercent: 42,
  cpuCores: 10,
  memory: {
    totalBytes: 16 * GIB,
    usedBytes: 14 * GIB,
    availableBytes: 2 * GIB,
    swapTotalBytes: null,
    swapUsedBytes: null,
    pressure: null,
  },
  loadAverage: null,
  disk: {
    mountPoint: "/",
    totalBytes: 500 * GIB,
    availableBytes: 10 * GIB,
  },
  power: { source: "ac", batteryPercent: null, charging: null },
  uptimeSeconds: 3 * 86_400 + 4 * 3_600,
  sampledAt: "2026-10-23T08:00:00Z",
};

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

/** 一张托盘：按头上的标签找。 */
function tray(label: string) {
  const header = screen.getByText(label, {
    selector: "[data-slot=tray-header] span",
  });
  return header.closest("[data-slot=settings-kpi]") as HTMLElement;
}

describe("本机服务托盘", () => {
  it("五张：CPU、内存、磁盘、运行时长、活跃会话", () => {
    render(<ServiceKpis resources={HOST} liveSessions={3} />);
    expect(
      screen
        .getAllByText(/./, { selector: "[data-slot=tray-header] span" })
        .map((node) => node.textContent),
    ).toEqual(["CPU", "内存", "磁盘", "运行时长", "活跃会话"]);
    expect(within(tray("运行时长")).getByText("3天 4小时")).toBeTruthy();
    expect(within(tray("CPU")).getByText("10 核")).toBeTruthy();
  });

  it("刻度按 80 / 95 阈值取色：42 品牌、87.5 警告、98 危险", () => {
    render(<ServiceKpis resources={HOST} liveSessions={0} />);
    const toneOf = (label: string) =>
      tray(label).querySelector<HTMLElement>("[data-slot=progress]")!.dataset
        .tone;
    expect(toneOf("CPU")).toBe("brand");
    expect(toneOf("内存")).toBe("warn");
    expect(toneOf("磁盘")).toBe("danger");
  });

  it("运行时长与会话数是值卡，不画刻度", () => {
    render(<ServiceKpis resources={HOST} liveSessions={2} />);
    expect(tray("运行时长").querySelector("[data-slot=progress]")).toBeNull();
    expect(tray("活跃会话").querySelector("[data-slot=progress]")).toBeNull();
  });

  it("还没有样本：每张都是 —，没有刻度也没有 NaN", () => {
    const { container } = render(
      <ServiceKpis resources={null} liveSessions={null} />,
    );
    const values = [
      ...container.querySelectorAll("[data-slot=tray-value]"),
    ].map((node) => node.textContent);
    expect(values).toEqual(["—", "—", "—", "—", "—"]);
    expect(container.querySelector("[data-slot=progress]")).toBeNull();
    expect(container.textContent).not.toContain("NaN");
  });

  it("测不出来的指标是 —，不折成 0", () => {
    render(
      <ServiceKpis
        resources={{
          ...HOST,
          cpuPercent: null,
          disk: null,
          uptimeSeconds: null,
        }}
        liveSessions={1}
      />,
    );
    expect(
      tray("CPU").querySelector("[data-slot=tray-value]")?.textContent,
    ).toBe("—");
    expect(tray("CPU").querySelector("[data-slot=progress]")).toBeNull();
    expect(tray("磁盘").querySelector("[data-slot=progress]")).toBeNull();
    expect(
      tray("运行时长").querySelector("[data-slot=tray-value]")?.textContent,
    ).toBe("—");
  });
});
