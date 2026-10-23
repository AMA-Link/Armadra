import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../app/preferences-store";
import { installDomPolyfills } from "../app/test-harness";
import { BoardRow } from "./BoardRow";

beforeAll(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

const board = {
  id: "b1",
  workspaceId: "w1",
  name: "画布 1",
  sortOrder: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  whiteboard: "",
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
} as unknown as Parameters<typeof BoardRow>[0]["board"];

function renderRow(signal?: Parameters<typeof BoardRow>[0]["signal"]) {
  return render(
    <ul>
      <BoardRow
        board={board}
        active={false}
        pinned={false}
        {...(signal ? { signal } : {})}
        canDelete
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onTogglePin={vi.fn()}
        onRename={vi.fn()}
      />
    </ul>,
  );
}

describe("BoardRow 信号点", () => {
  it("需要你：StatusDot 6 attention，带读屏名", () => {
    renderRow({ attention: true, unread: true });
    const dot = screen.getByRole("img", { name: "需要你" });
    expect(dot.getAttribute("data-slot")).toBe("status-dot");
    expect(dot.getAttribute("data-size")).toBe("6");
    expect(dot.getAttribute("data-tone")).toBe("attention");
  });

  it("只有未读：StatusDot 6 unread；什么都没有就不画", () => {
    renderRow({ attention: false, unread: true });
    expect(
      document
        .querySelector("[data-slot=status-dot]")
        ?.getAttribute("data-tone"),
    ).toBe("unread");
    cleanup();
    renderRow();
    expect(document.querySelector("[data-slot=status-dot]")).toBeNull();
  });

  it("侧栏专用的 SignalDot 已删除", () => {
    expect(Object.keys(import.meta.glob("./SignalDot.*"))).toEqual([]);
  });
});
