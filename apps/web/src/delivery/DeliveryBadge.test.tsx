import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DELIVERY_LANES, DELIVERY_PHRASES } from "@armadra/shared";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { DeliveryBadge } from "./DeliveryBadge";
import { useDeliveryBoard } from "./store";

beforeAll(() => installDomPolyfills());

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));

afterEach(() => {
  cleanup();
  useDeliveryBoard.getState().reset();
});

function put(lane: string, phrase: string) {
  useDeliveryBoard.setState({
    rows: {
      n1: {
        nodeId: "n1",
        taskId: null,
        lane: lane as never,
        phrase,
        pulls: [],
        offBoardAtMs: null,
        children: null,
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
