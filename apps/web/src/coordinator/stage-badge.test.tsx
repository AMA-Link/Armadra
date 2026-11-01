import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import type { DispatchTask } from "./api";
import {
  WorkItemStageBadge,
  personStages,
  useWorkItemStages,
} from "./stage-badge";

/**
 * 成员节点头部的工作项阶段（#682）：只画要人处理的那几种，取每个节点最新那一项。
 */

function task(patch: Partial<DispatchTask>): DispatchTask {
  return {
    taskId: "t",
    coordinatorNodeId: "lead",
    runnerId: "codex",
    nodeId: "m1",
    status: "running",
    startedAt: "2026-11-02T08:00:00.000Z",
    endedAt: null,
    reason: null,
    retryable: false,
    title: null,
    report: null,
    attention: null,
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  useWorkItemStages.setState({ stages: {} });
});

afterEach(() => cleanup());

describe("personStages", () => {
  it("每个节点取最新那一项，只留 person/*", () => {
    expect(
      personStages([
        task({ taskId: "old", stage: "person/review" }),
        task({
          taskId: "new",
          stage: "working",
          startedAt: "2026-11-02T09:00:00.000Z",
        }),
        task({ taskId: "b", nodeId: "m2", stage: "person/answer" }),
        task({ taskId: "c", nodeId: "m3" }),
      ]),
    ).toEqual({ m2: "person/answer" });
  });
});

describe("WorkItemStageBadge", () => {
  it("待验收画一枚徽标；不等人的阶段不画", () => {
    useWorkItemStages.setState({ stages: { m1: "person/review" } });
    const { container, rerender } = render(<WorkItemStageBadge nodeId="m1" />);
    const badge = container.querySelector('[data-slot="work-item-stage"]');
    expect(badge?.textContent).toBe("待验收");
    expect(badge?.getAttribute("data-variant")).toBe("warn");
    rerender(<WorkItemStageBadge nodeId="m2" />);
    expect(container.querySelector('[data-slot="work-item-stage"]')).toBeNull();
  });

  it("失败与投递失败用 destructive", () => {
    useWorkItemStages.setState({ stages: { m1: "person/delivery" } });
    const { container } = render(<WorkItemStageBadge nodeId="m1" />);
    expect(
      container
        .querySelector('[data-slot="work-item-stage"]')
        ?.getAttribute("data-variant"),
    ).toBe("destructive");
  });
});
