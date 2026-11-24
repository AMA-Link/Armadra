import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { DELIVERY_LANES, DELIVERY_PHRASES } from "@armadra/shared";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { DeliveryBadge } from "./DeliveryBadge";
import { withChildren } from "./fixtures";
import { useDeliveryBoard } from "./store";

beforeAll(() => installDomPolyfills());

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));

afterEach(() => {
  cleanup();
  useDeliveryBoard.getState().reset();
});

function put(
  lane: string,
  phrase: string,
  children: ReturnType<typeof withChildren>["children"] = null,
) {
  useDeliveryBoard.setState({
    rows: {
      n1: {
        nodeId: "n1",
        taskId: null,
        lane: lane as never,
        phrase,
        pulls: [],
        offBoardAtMs: null,
        children,
      },
    },
  });
}

function badge() {
  return render(
    <TestProviders>
      <DeliveryBadge nodeId="n1" />
    </TestProviders>,
  );
}

const slot = "[data-slot='delivery-badge']";

describe("DeliveryBadge", () => {
  it.each([
    ["needsYou", "ciFailing", "CI 失败", "failed"],
    ["inReview", "awaitingReview", "等待评审", "queued"],
    ["readyToMerge", "mergeable", "可合并", "done"],
  ])("draws %s", (lane, phrase, text, tone) => {
    put(lane, phrase);
    const pill = badge().container.querySelector(slot);
    expect(pill?.textContent).toBe(text);
    expect(pill?.getAttribute("data-tone")).toBe(tone);
  });

  it("stays quiet for working, off board and unknown nodes", () => {
    for (const lane of ["working", "offBoard"] as const) {
      put(lane, DELIVERY_PHRASES[lane][0]);
      expect(badge().container.querySelector(slot)).toBeNull();
      cleanup();
    }
    useDeliveryBoard.setState({ rows: {} });
    expect(badge().container.querySelector(slot)).toBeNull();
    expect(DELIVERY_LANES).toContain("working");
  });

  it("draws the sub-task phrases on working nodes with a count", () => {
    put("working", "waitingOnChildren", withChildren(2, 1).children);
    const view = badge();
    expect(view.container.querySelector(slot)?.textContent).toBe(
      "等待子任务 1/2",
    );
    expect(view.container.querySelector(slot)?.getAttribute("data-tone")).toBe(
      "queued",
    );
    expect(view.container.textContent).toContain("1/2");
    act(() => put("working", "collecting", withChildren(2, 2).children));
    expect(view.container.querySelector(slot)?.textContent).toBe("汇总中");
  });

  it("hints at sub-tasks that need you on a plain working node", () => {
    put("working", "working", withChildren(2, 0, 1).children);
    const pill = badge().container.querySelector(slot);
    expect(pill?.textContent).toBe("1 个子任务需要你");
    expect(pill?.getAttribute("data-tone")).toBe("attention");
  });

  it("opens the sub-task list from the count", async () => {
    put("working", "waitingOnChildren", withChildren(1, 0, 0, ["x"]).children);
    badge();
    fireEvent.click(screen.getByRole("button", { name: "子任务" }));
    expect(await screen.findAllByText("未命名")).toHaveLength(1);
  });

  it("follows the store", () => {
    put("needsYou", "needsApproval");
    const view = badge();
    expect(view.container.querySelector(slot)?.textContent).toBe("待批准");
    act(() => put("inReview", "checksRunning"));
    expect(view.container.querySelector(slot)?.textContent).toBe("检查中");
    act(() => put("working", "working"));
    expect(view.container.querySelector(slot)).toBeNull();
  });
});
