import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";
import { useAgentStatusStore } from "@/agent/status-store";
import { useSubagentStore } from "@/agent/subagent-store";
import { useCanvasStore } from "@/store/canvas-store";
import { ShowcaseProviders } from "../harness";
import { SHOWCASE_SECTION_IDS } from "../ShowcaseApp";
import { TONES, TREE_FIXTURES } from "../fixtures/status";
import StatusSection from "./status";

beforeAll(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

function renderSection() {
  return render(
    <ShowcaseProviders>
      <StatusSection />
    </ShowcaseProviders>,
  );
}

describe("status 分区", () => {
  it("已登记", () => {
    expect(SHOWCASE_SECTION_IDS).toContain("status");
  });

  it("八个 tone × 三种形态：每一行点、胶囊、行同一个 tone 同一句文案", () => {
    const { container } = renderSection();
    const rows = container.querySelectorAll("[data-tone-row]");
    expect(rows).toHaveLength(TONES.length);
    for (const row of rows) {
      const tone = row.getAttribute("data-tone-row");
      const dots = row.querySelectorAll("td > [data-slot=status-dot]");
      const pills = row.querySelectorAll("[data-slot=status-pill]");
      const line = row.querySelector("[data-slot=status-line]")!;
      expect(dots).toHaveLength(2);
      expect(pills).toHaveLength(2);
      for (const node of [...dots, ...pills, line])
        expect(node.getAttribute("data-tone")).toBe(tone);
      const phase = line.querySelector(
        "[data-slot=status-line-phase]",
      )!.textContent;
      expect(dots[0]!.getAttribute("aria-label")).toBe(phase);
      expect(pills[0]!.textContent).toBe(phase);
    }
  });

  it("五种树夹具各出 sm 与 md，再加一条折叠", () => {
    const { container } = renderSection();
    expect(TREE_FIXTURES).toHaveLength(5);
    for (const { name } of TREE_FIXTURES) {
      const sample = container.querySelector(`[data-sample="${name}"]`)!;
      expect(
        sample.querySelector("[data-slot=agent-tree][data-size=sm]"),
      ).not.toBeNull();
      expect(
        sample.querySelector("[data-slot=agent-tree][data-size=md]"),
      ).not.toBeNull();
    }
    const folded = container.querySelector('[data-sample="tree · md folded"]')!;
    expect(folded.querySelector("[data-collapsed=true]")).not.toBeNull();
  });

  it("四种状态载体都在，并读假世界：活动卡有 StatusLine 与树，通知行带树", () => {
    const { container } = renderSection();
    for (const name of [
      "AgentActivityNode",
      "SubagentCard",
      "SessionRow",
      "NeedRow",
    ])
      expect(container.querySelector(`[data-sample="${name}"]`)).not.toBeNull();
    const activity = container.querySelector("[data-showcase-activity]")!;
    expect(activity.querySelector("[data-slot=status-line]")).not.toBeNull();
    expect(
      activity.querySelector("[data-slot=agent-tree][data-size=md]"),
    ).not.toBeNull();
    // 没有「转为平台计划」之类的按钮
    expect(
      activity.querySelector("[data-slot=agent-activity-card] button"),
    ).toBeNull();
    const needs = container.querySelector("[data-showcase-needs]")!;
    // 三条通知，只有 ama 那条有下级
    expect(needs.querySelectorAll("[data-need-row]")).toHaveLength(3);
    expect(needs.querySelectorAll("[data-slot=agent-tree]")).toHaveLength(1);
    const sessions = container.querySelector("[data-showcase-sessions]")!;
    expect(
      sessions.querySelectorAll("[data-slot=status-dot][data-size='8']"),
    ).toHaveLength(5);
  });

  it("卸载后还原三个 store", () => {
    const before = {
      document: useCanvasStore.getState().document,
      statuses: useAgentStatusStore.getState().statuses,
      cards: useSubagentStore.getState().cards,
    };
    const { unmount } = renderSection();
    unmount();
    expect(useCanvasStore.getState().document).toBe(before.document);
    expect(useAgentStatusStore.getState().statuses).toBe(before.statuses);
    expect(useSubagentStore.getState().cards).toBe(before.cards);
  });
});
