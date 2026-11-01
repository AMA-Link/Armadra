import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import type { MirroredStatus } from "@/agent/status-store";
import { scoped } from "../sources/scope";
import { StalledBadge } from "./StalledBadge";

const NODE = "00000000-0000-4000-8000-000000000001";

const status = (extra: Partial<MirroredStatus> = {}): MirroredStatus =>
  ({
    nodeId: NODE,
    workspaceId: "w",
    agentId: "claude",
    state: "working",
    unread: false,
    verified: true,
    restored: false,
    updatedAt: "2026-10-04T08:00:00.000Z",
    ...extra,
  }) as MirroredStatus;

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  useAgentStatusStore.setState({ statuses: {} });
});
afterEach(cleanup);

describe("节点头的看门狗标记（契约 §91）", () => {
  it("没有标记不画，三种标记各是一句话，标记消失就跟着消失", () => {
    render(
      <TestProviders>
        <StalledBadge nodeId={NODE} />
      </TestProviders>,
    );
    expect(document.querySelector('[data-slot="stalled-badge"]')).toBeNull();
    for (const [kind, text] of [
      ["stalled", "停滞"],
      ["idleWaiting", "空等"],
      ["needsHuman", "久未处理"],
    ] as const) {
      act(() =>
        useAgentStatusStore.setState({
          statuses: { [scoped(NODE)]: status({ stalled: kind }) },
        }),
      );
      expect(screen.getByText(text)).toBeTruthy();
    }
    act(() =>
      useAgentStatusStore.setState({
        statuses: { [scoped(NODE)]: status() },
      }),
    );
    expect(document.querySelector('[data-slot="stalled-badge"]')).toBeNull();
  });

  it("英文界面用英文", () => {
    usePreferencesStore.setState({ locale: "en" });
    useAgentStatusStore.setState({
      statuses: { [scoped(NODE)]: status({ stalled: "stalled" }) },
    });
    render(
      <TestProviders>
        <StalledBadge nodeId={NODE} />
      </TestProviders>,
    );
    expect(screen.getByText("Stalled")).toBeTruthy();
  });
});
