import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/store/canvas-store", () => {
  const state = { workspace: { rootPath: "/repo" } };
  const useCanvasStore = <T,>(selector: (s: typeof state) => T) =>
    selector(state);
  useCanvasStore.getState = () => state;
  return { useCanvasStore };
});

import { CodeBlock } from "./CodeBlock";

afterEach(cleanup);

describe("CodeBlock", () => {
  it("puts the copy button in its own column beside the code so it never covers a line", () => {
    render(<CodeBlock>{"const first = 1;\nconst second = 2;"}</CodeBlock>);
    const box = document.querySelector("[data-slot=timeline-code] > div");
    const pre = box?.querySelector("pre");
    const actions = box?.querySelector("[data-slot=acp-actions]");
    // 并排的两列，钮不再绝对定位压在代码上。
    expect(pre?.parentElement).toBe(box);
    expect(actions?.parentElement).toBe(box);
    expect(pre?.className).toContain("flex-1");
    expect(pre?.className).toContain("overflow-x-auto");
    expect(actions?.className).not.toContain("absolute");
  });
});
