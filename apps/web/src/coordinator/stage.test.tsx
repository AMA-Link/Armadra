import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import type { DispatchTask } from "./api";
import { ItemStageBadge, nodeStages, useItemStages } from "./stage";

/** 成员节点头部的阶段（契约 §90.4）。 */

function task(nodeId: string, patch: Partial<DispatchTask>): DispatchTask {
  return {
    taskId: `t-${nodeId}`,
    coordinatorNodeId: "lead",
    runnerId: "codex",
    nodeId,
    status: "running",
    startedAt: "2026-10-04T08:00:00.000Z",
    endedAt: null,
    reason: null,
    retryable: false,
    title: null,
    stage: null,
    report: null,
    attention: null,
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());

afterEach(() => {
  cleanup();
  useItemStages.setState({ stages: {} });
});

describe("nodeStages", () => {
  it("keeps the newest row's stage per node and skips rows without one", () => {
    expect(
      nodeStages([
        task("a", { stage: "working", startedAt: "2026-10-04T08:00:00.000Z" }),
        task("a", {
          taskId: "newer",
          stage: "person/review",
          startedAt: "2026-10-04T09:00:00.000Z",
        }),
        task("b", { stage: null }),
      ]),
    ).toEqual({ a: "person/review" });
  });
});

describe("ItemStageBadge", () => {
  function badge(nodeId: string) {
    usePreferencesStore.setState({ locale: "zh-CN" });
    return render(
      <TestProviders>
        <ItemStageBadge nodeId={nodeId} />
      </TestProviders>,
    );
  }

  it("shows a person stage with its label", () => {
    useItemStages.setState({ stages: { a: "person/review" } });
    const view = badge("a");
    const pill = view.container.querySelector("[data-slot='item-stage-badge']");
    expect(pill?.textContent).toBe("待验收");
    expect(pill?.getAttribute("data-tone")).toBe("attention");
  });

  it("follows the table when the stage changes", () => {
    useItemStages.setState({ stages: { a: "person/answer" } });
    const view = badge("a");
    act(() => useItemStages.setState({ stages: { a: "person/failed" } }));
    expect(
      view.container.querySelector("[data-slot='item-stage-badge']")
        ?.textContent,
    ).toBe("失败");
  });

  it("stays quiet for working, idle and nodes without an item", () => {
    useItemStages.setState({ stages: { a: "working", b: "idle" } });
    for (const id of ["a", "b", "c"]) {
      const view = badge(id);
      expect(
        view.container.querySelector("[data-slot='item-stage-badge']"),
      ).toBeNull();
      cleanup();
    }
  });
});
