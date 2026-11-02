import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { TimelineItem } from "@armadra/shared";

vi.mock("@/store/canvas-store", () => {
  const state = { workspace: { rootPath: "/repo" } };
  const useCanvasStore = <T,>(selector: (s: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});
vi.mock("@/files/open-editor", () => ({ openFileInEditor: vi.fn() }));

import { TimelineView } from "./TimelineView";
import { VirtualTurnList } from "./VirtualTurnList";
import {
  activity,
  assistantItem,
  longSession,
  showcaseSession,
  toolItem,
  turnItem,
  userItem,
} from "./fixtures";
import { groupTurns } from "./turns";
import { mockLayout, ROW_PX, VIEWPORT } from "./test-layout";

const RECT = VIEWPORT;

beforeEach(mockLayout);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rows = () => document.querySelectorAll("[data-slot=timeline-turn-row]");

describe("virtualization", () => {
  it("keeps the DOM at visible rows plus overscan for 1000 turns", () => {
    const items = longSession(1000);
    render(<TimelineView items={items} initialRect={RECT} />);
    // 贴底后浏览器会派发 scroll，虚拟列表据此换到末尾那一窗。
    fireEvent.scroll(
      document.querySelector("[data-slot=timeline-scroller]") as HTMLElement,
    );
    const visible = Math.ceil(RECT.height / ROW_PX);
    const count = rows().length;
    expect(count).toBeGreaterThan(0);
    // 3 个回合的 overscan 在两侧。
    expect(count).toBeLessThanOrEqual(visible + 2 * 3 + 2);
    // 贴底：看到的是最后的回合。
    expect(document.body.textContent).toContain("Answer 1000");
    expect(document.body.textContent).not.toContain("Question 1\n");
  });

  it("renders in the same DOM budget when the list grows", () => {
    const small = render(
      <TimelineView items={longSession(50)} initialRect={RECT} />,
    );
    const a = rows().length;
    small.unmount();
    render(<TimelineView items={longSession(2000)} initialRect={RECT} />);
    expect(rows().length).toBe(a);
  });

  it("shows a back-to-bottom button after leaving the bottom and returns on click", () => {
    render(<TimelineView items={longSession(200)} initialRect={RECT} />);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
    const scroller = document.querySelector(
      "[data-slot=timeline-scroller]",
    ) as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 36_000,
    });
    scroller.scrollTop = 10_000;
    fireEvent.scroll(scroller);
    const button = screen.getByRole("button", { name: "回到底部" });
    fireEvent.click(button);
    expect(scroller.scrollTop).toBe(36_000);
    expect(screen.queryByRole("button", { name: "回到底部" })).toBeNull();
  });

  it("asks for older turns once when scrolled near the top", () => {
    const onLoadOlder = vi.fn();
    render(
      <TimelineView
        items={longSession(200)}
        initialRect={RECT}
        onLoadOlder={onLoadOlder}
      />,
    );
    const scroller = document.querySelector(
      "[data-slot=timeline-scroller]",
    ) as HTMLElement;
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    fireEvent.scroll(scroller);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe("VirtualTurnList", () => {
  it("renders only the visible window of arbitrary turn objects", () => {
    const turns = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    render(
      <VirtualTurnList
        turns={turns}
        getKey={(t) => t.id}
        renderTurn={(t) => <div>turn-{t.id}</div>}
        initialRect={RECT}
        overscan={2}
      />,
    );
    expect(rows().length).toBeLessThanOrEqual(
      Math.ceil(600 / ROW_PX) + 2 * 2 + 2,
    );
  });
});

describe("TimelineView", () => {
  it("renders the showcase session through every row kind", () => {
    render(<TimelineView items={showcaseSession()} initialRect={RECT} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Fix the failing test");
    expect(text).toContain("The test passes now");
    const group = document.querySelector("[data-slot=timeline-group]");
    expect(group).toBeTruthy();
    fireEvent.click(group?.querySelector("button") as HTMLElement);
    expect(document.querySelector("[data-slot=timeline-thought]")).toBeTruthy();
  });

  it("shows the skeleton while loading with no items, then the list", () => {
    const { rerender } = render(<TimelineView items={[]} loading />);
    expect(
      document.querySelector("[data-slot=timeline-skeleton]"),
    ).toBeTruthy();
    rerender(<TimelineView items={longSession(2)} initialRect={RECT} />);
    expect(document.querySelector("[data-slot=timeline-skeleton]")).toBeNull();
  });

  it("取更早回合时列表顶部出一条占位，平时没有", () => {
    const { rerender } = render(
      <TimelineView items={longSession(2)} initialRect={RECT} />,
    );
    expect(
      document.querySelector("[data-slot=timeline-loading-more]"),
    ).toBeNull();
    rerender(
      <TimelineView items={longSession(2)} initialRect={RECT} loadingMore />,
    );
    expect(
      document.querySelector("[data-slot=timeline-loading-more]"),
    ).toBeTruthy();
  });

  it("draws only the first plan of a turn in the flow and no plan bar of its own", () => {
    const plan = (turn: number, n: number, rev: number): TimelineItem => ({
      id: `plan:${turn}`,
      kind: "plan",
      turn,
      ord: n,
      rev,
      source: "acp",
      at: 1,
      gen: 1,
      entries: [
        { content: `step ${rev}`, status: "in_progress" },
        { content: "later", status: "pending" },
      ],
    });
    const items = [
      userItem(1, "go"),
      plan(1, 2, 3),
      assistantItem(1, "ok", 0),
      turnItem(1),
    ];
    render(<TimelineView items={items} initialRect={RECT} />);
    // 计划条坐在输入框上方，由会话视图摆；时间线里只留回合内的一行。
    expect(document.querySelector("[data-slot=timeline-plan-bar]")).toBeNull();
    expect(
      document.querySelectorAll("[data-slot=timeline-plan-line]"),
    ).toHaveLength(1);
  });

  it("folds only consecutive read-only calls into groups; commands and edits stay on their own row", () => {
    const items: TimelineItem[] = [
      userItem(1, "go"),
      toolItem(1, "r1", { toolKind: "read", title: "Read one" }),
      toolItem(1, "s1", { toolKind: "search", title: "Search two" }),
      toolItem(1, "x1", { toolKind: "execute", title: "pnpm test" }),
      toolItem(1, "r2", { toolKind: "read", title: "Read three" }),
      toolItem(1, "e1", { toolKind: "edit", title: "Edit four" }),
      toolItem(1, "r3", { toolKind: "read", title: "Read five" }),
      toolItem(1, "f1", { toolKind: "fetch", title: "Fetch six" }),
      turnItem(1),
    ];
    render(<TimelineView items={items} initialRect={RECT} />);
    const groups = [...document.querySelectorAll("[data-slot=timeline-group]")];
    // 读 + 搜一组、读 + 抓取一组；中间的命令、单独的读与编辑不进组。
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.textContent)).toEqual([
      "读了 1 个文件 · 搜索 1 次",
      "读了 1 个文件 · 抓取 1 次",
    ]);
    const solo = [
      ...document.querySelectorAll("[data-slot=timeline-tool]"),
    ].filter((node) => node.closest("[data-slot=timeline-group]") === null);
    expect(solo.map((node) => node.textContent)).toEqual([
      expect.stringContaining("pnpm test"),
      expect.stringContaining("Read three"),
      expect.stringContaining("Edit four"),
    ]);
  });

  it("opens a read group that holds a pending approval and renders the card under its row", () => {
    const approval = {
      id: "ap:1",
      kind: "approval" as const,
      turn: 1,
      ord: 9,
      rev: 9,
      source: "acp" as const,
      at: 1,
      gen: 1,
      pendingId: "p1",
      protocol: "acp",
      toolCallId: "r2",
      options: [],
      state: "pending" as const,
    };
    const items: TimelineItem[] = [
      userItem(1, "go"),
      toolItem(1, "r1", { toolKind: "read", title: "Read one" }),
      toolItem(1, "r2", {
        toolKind: "read",
        title: "Read outside",
        status: "pending",
        endedAt: undefined,
      }),
      approval,
    ];
    render(
      <TimelineView
        items={items}
        initialRect={RECT}
        renderApproval={(a) => <div data-testid="approval">{a.pendingId}</div>}
      />,
    );
    const group = document.querySelector("[data-slot=timeline-group]");
    expect(
      group?.querySelector("[data-slot=timeline-group-body]"),
    ).toBeTruthy();
    const row = screen
      .getByText("Read outside")
      .closest("[data-slot=timeline-tool]");
    expect(row?.querySelector("[data-testid=approval]")).toBeTruthy();
  });

  it("renders approvals inline under their tool and elicitations in the flow", () => {
    const approval = {
      id: "ap:1",
      kind: "approval" as const,
      turn: 1,
      ord: 9,
      rev: 9,
      source: "acp" as const,
      at: 1,
      gen: 1,
      pendingId: "p1",
      protocol: "acp",
      toolCallId: "c1",
      options: [],
      state: "pending" as const,
    };
    const items: TimelineItem[] = [
      userItem(1, "run it"),
      toolItem(1, "c1", { title: "Run" }),
      approval,
    ];
    render(
      <TimelineView
        items={items}
        initialRect={RECT}
        renderApproval={(a) => <div data-testid="approval">{a.pendingId}</div>}
      />,
    );
    const tool = document.querySelector("[data-slot=timeline-tool]");
    expect(tool?.querySelector("[data-testid=approval]")).toBeTruthy();
  });

  it("does not break an activity group around an inline approval", () => {
    const approval = {
      id: "ap:1",
      kind: "approval" as const,
      turn: 1,
      ord: 3,
      rev: 9,
      source: "acp" as const,
      at: 1,
      gen: 1,
      pendingId: "p1",
      protocol: "acp",
      toolCallId: "c1",
      options: [],
      state: "pending" as const,
    };
    const items: TimelineItem[] = [
      toolItem(1, "c1", { title: "One" }),
      approval,
      toolItem(1, "c2", { title: "Two" }),
    ];
    render(
      <TimelineView
        items={items}
        initialRect={RECT}
        renderApproval={() => <i />}
      />,
    );
    expect(
      document.querySelectorAll("[data-slot=timeline-group]"),
    ).toHaveLength(1);
  });

  it("shows the activity line under the list", () => {
    render(
      <TimelineView
        items={longSession(2)}
        activity={activity("thinking")}
        initialRect={RECT}
      />,
    );
    expect(
      document
        .querySelector("[data-slot=timeline-activity]")
        ?.getAttribute("data-phase"),
    ).toBe("thinking");
  });

  it("a streaming delta re-renders only the changed turn", () => {
    const items = longSession(5);
    const a = groupTurns(items);
    const next = items.map((item) =>
      item.id === "a:5:0" && item.kind === "assistant"
        ? {
            ...item,
            rev: item.rev + 100,
            parts: [{ type: "text" as const, text: "longer" }],
          }
        : item,
    );
    const b = groupTurns(next, a);
    expect(b.slice(0, 4).every((block, i) => block === a[i])).toBe(true);
    expect(b[4]).not.toBe(a[4]);
  });

  it("keeps rendering while the list is updated in frames", () => {
    const items = longSession(3);
    const { rerender } = render(
      <TimelineView items={items} initialRect={RECT} />,
    );
    act(() => {
      rerender(
        <TimelineView
          items={[
            ...items,
            userItem(31, "new"),
            assistantItem(31, "streamed", 0, true),
          ]}
          initialRect={RECT}
        />,
      );
    });
    expect(document.body.textContent).toContain("streamed");
  });
});
