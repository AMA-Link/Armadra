import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { within } from "@testing-library/react";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { DeliveryPanel } from "./DeliveryPanel";
import { pull } from "./fixtures";
import { useDeliveryBoard, type DeliveryRow } from "./store";

const center = vi.hoisted(() => vi.fn());
vi.mock("@/canvas/flow/flow-context", async (original) => ({
  ...(await original<object>()),
  requestCenterOnNode: center,
}));

const NOW = Date.now();

function row(nodeId: string, patch: Partial<DeliveryRow>): DeliveryRow {
  return {
    nodeId,
    taskId: null,
    lane: "inReview",
    phrase: "awaitingReview",
    pulls: [],
    offBoardAtMs: null,
    children: null,
    ...patch,
  };
}

function node(id: string, title: string) {
  return { id, title, data: { kind: "terminal" } };
}

beforeAll(() => installDomPolyfills());

beforeEach(() => {
  center.mockReset();
  usePreferencesStore.setState({ locale: "zh-CN" });
  useCanvasStore.setState({
    boardId: "b1",
    document: {
      board: { id: "b1" },
      nodes: ["a", "b", "c", "d", "e", "f"].map((id) => node(id, `节点 ${id}`)),
      edges: [],
    } as never,
  });
  useCanvasStore.getState().setPanel("delivery", "drawer");
});

afterEach(() => {
  cleanup();
  useDeliveryBoard.getState().reset();
  useCanvasStore.getState().setPanel("delivery", "closed");
});

function show(rows: DeliveryRow[]) {
  useDeliveryBoard.setState({
    rows: Object.fromEntries(rows.map((r) => [r.nodeId, r])),
  });
  return render(
    <TestProviders>
      <DeliveryPanel />
    </TestProviders>,
  );
}

function lane(name: string) {
  return screen.getByRole("region", { name: new RegExp(`^${name}`) });
}

describe("DeliveryPanel", () => {
  it("lays out the four lanes in order with counts", () => {
    show([
      row("a", { lane: "needsYou", phrase: "ciFailing" }),
      row("b", { lane: "working", phrase: "working" }),
      row("c", { lane: "inReview" }),
      row("d", { lane: "readyToMerge", phrase: "mergeable" }),
      row("e", { lane: "needsYou", phrase: "blocked" }),
    ]);
    const lanes = [
      ...document.querySelectorAll("[data-slot='delivery-lane']"),
    ].map((el) => el.getAttribute("data-lane"));
    expect(lanes).toEqual(["needsYou", "working", "inReview", "readyToMerge"]);
    expect(lane("需要你").querySelector("h3")?.textContent).toBe("需要你2");
    expect(lane("可合并").querySelector("h3")?.textContent).toBe("可合并1");
  });

  it("shows an empty state for an empty lane", () => {
    show([row("a", { lane: "needsYou", phrase: "blocked" })]);
    expect(within(lane("进行中")).getByText("暂无")).toBeTruthy();
  });

  it("shows title, phrase and pull links with the least ready pull first", () => {
    show([
      row("a", {
        pulls: [
          pull({ number: 8, review: "approved" }),
          pull({ number: 9, mergeable: "conflicting" }),
        ],
      }),
    ]);
    const card = within(lane("审查中"));
    expect(card.getByText("节点 a")).toBeTruthy();
    expect(card.getByText("等待评审")).toBeTruthy();
    const links = card.getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["#9", "#8"]);
    expect(card.getAllByRole("link")[0]?.getAttribute("target")).toBe("_blank");
  });

  it("puts a lane's problem cards first", () => {
    show([
      row("a", { pulls: [pull({ review: "approved" })] }),
      row("b", { pulls: [pull({ mergeable: "conflicting" })] }),
      row("c", {}),
    ]);
    const titles = within(lane("审查中"))
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(titles).toEqual(["节点 b", "节点 a", "节点 c"]);
  });

  it("centers on the node when a card is clicked", () => {
    show([row("b", { lane: "needsYou", phrase: "blocked" })]);
    fireEvent.click(screen.getByRole("button", { name: "定位到 节点 b" }));
    expect(center).toHaveBeenCalledWith("b");
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(["b"]);
  });

  it("skips nodes that are no longer on the canvas", () => {
    show([row("gone", { lane: "needsYou", phrase: "blocked" })]);
    expect(lane("需要你").querySelector("h3")?.textContent).toBe("需要你0");
  });

  it("keeps merged and closed collapsed, expands on demand, hides stale", () => {
    show([
      row("a", { lane: "offBoard", phrase: "merged", offBoardAtMs: NOW }),
      row("b", { lane: "offBoard", phrase: "closed", offBoardAtMs: NOW }),
      row("c", {
        lane: "offBoard",
        phrase: "merged",
        offBoardAtMs: NOW - 25 * 3_600_000,
      }),
    ]);
    const trigger = screen.getByRole("button", {
      name: "已合并 1 · 已关闭 1",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("节点 a")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("节点 a")).toBeTruthy();
    expect(screen.getByText("节点 b")).toBeTruthy();
    expect(screen.queryByText("节点 c")).toBeNull();
    const rows = [
      ...document.querySelectorAll("[data-slot='delivery-off-row']"),
    ];
    const tones = rows.map((r) =>
      r.querySelector("[data-tone]")?.getAttribute("data-tone"),
    );
    expect(tones).toEqual(["done", "idle"]);
  });

  it("omits the off-board area when there is nothing to show", () => {
    show([row("a", { lane: "needsYou", phrase: "blocked" })]);
    expect(
      document.querySelector("[data-slot='delivery-off-board']"),
    ).toBeNull();
  });

  it("closes from the header button", () => {
    show([]);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(useCanvasStore.getState().panels.delivery).toBe("closed");
  });
});
