import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const renders = vi.hoisted(() => ({ input: 0, markdown: 0 }));
vi.mock("./parts/ToolInput", () => ({
  ToolInput: () => {
    renders.input += 1;
    return <span data-testid="input" />;
  },
}));
vi.mock("./parts/StreamingMarkdown", () => ({
  StreamingMarkdown: ({ text }: { text: string }) => {
    renders.markdown += 1;
    return <span>{text}</span>;
  },
}));

import { assistantItem, toolItem } from "./fixtures";
import { AssistantRow } from "./rows/AssistantRow";
import { ToolRow } from "./rows/ToolRow";

afterEach(() => {
  cleanup();
  renders.input = 0;
  renders.markdown = 0;
});

describe("row memo", () => {
  it("ToolRow skips re-rendering while rev is unchanged and re-renders when it moves", () => {
    const item = toolItem(1, "t", { input: { command: "ls" } });
    const { rerender } = render(<ToolRow item={item} />);
    fireEvent.click(screen.getByRole("button"));
    const afterOpen = renders.input;
    expect(afterOpen).toBeGreaterThan(0);

    rerender(<ToolRow item={{ ...item }} />);
    expect(renders.input).toBe(afterOpen);

    rerender(<ToolRow item={{ ...item, rev: item.rev + 1 }} />);
    expect(renders.input).toBeGreaterThan(afterOpen);
  });

  it("re-renders when a non-item prop changes", () => {
    const item = toolItem(1, "t", { input: { command: "ls" } });
    const { rerender } = render(<ToolRow item={item} />);
    fireEvent.click(screen.getByRole("button"));
    const before = renders.input;
    rerender(<ToolRow item={item} renderApproval={() => null} />);
    expect(renders.input).toBeGreaterThan(before);
  });

  it("AssistantRow parses markdown again only when its own rev moves", () => {
    const item = assistantItem(1, "hello", 0, true);
    if (item.kind !== "assistant") throw new Error("kind");
    const { rerender } = render(<AssistantRow item={item} />);
    expect(renders.markdown).toBe(1);
    rerender(<AssistantRow item={{ ...item }} />);
    expect(renders.markdown).toBe(1);
    rerender(
      <AssistantRow
        item={{
          ...item,
          rev: item.rev + 1,
          parts: [{ type: "text", text: "hello world" }],
        }}
      />,
    );
    expect(renders.markdown).toBe(2);
  });
});
