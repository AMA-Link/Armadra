import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import type { DispatchTask } from "./api";
import {
  ItemStageBadge,
  nodeStages,
  unreadReplies,
  useItemStages,
} from "./stage";
import { MembersChip } from "./MembersChip";

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
    reply: null,
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());

afterEach(() => {
  cleanup();
  useItemStages.setState({ stages: {}, unreadReplies: {} });
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

describe("unreadReplies", () => {
  const reply = (read: boolean) =>
    ({
      purpose: "result",
      text: "x",
      at: "2026-10-04T08:00:00.000Z",
      read,
    }) as const;

  it("counts the unread replies per coordinator", () => {
    expect(
      unreadReplies([
        task("a", { reply: reply(false) }),
        task("b", { reply: reply(false) }),
        task("c", { reply: reply(true) }),
        task("d", { coordinatorNodeId: "other", reply: reply(false) }),
        task("e", {}),
      ]),
    ).toEqual({ lead: 2, other: 1 });
  });

  it("puts a dot on the coordinator's chip, and only for its own replies", () => {
    useItemStages.setState({ unreadReplies: { lead: 1 } });
    const { container, rerender } = render(
      <TestProviders>
        <MembersChip nodeId="lead" />
      </TestProviders>,
    );
    expect(
      container.querySelector('[data-slot="coordinator-reply-dot"]'),
    ).not.toBeNull();
    rerender(
      <TestProviders>
        <MembersChip nodeId="other" />
      </TestProviders>,
    );
    expect(
      container.querySelector('[data-slot="coordinator-reply-dot"]'),
    ).toBeNull();
    act(() => useItemStages.setState({ unreadReplies: {} }));
  });
});
