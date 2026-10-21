import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const parsed = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    parsed.calls.push(children);
    return <p data-testid="md">{children}</p>;
  },
}));

import { StreamingMarkdown } from "./parts/StreamingMarkdown";

beforeEach(() => {
  parsed.calls = [];
});
afterEach(cleanup);

describe("StreamingMarkdown", () => {
  it("re-parses only the last block when a chunk arrives", () => {
    const head = "first block\n\nsecond block\n\n```\ncode\n\nfence\n```\n\n";
    const { rerender, getAllByTestId } = render(
      <StreamingMarkdown text={`${head}tai`} />,
    );
    expect(getAllByTestId("md")).toHaveLength(4);
    expect(parsed.calls).toHaveLength(4);
    parsed.calls = [];

    rerender(<StreamingMarkdown text={`${head}tail of`} />);
    expect(parsed.calls).toEqual(["tail of"]);
    parsed.calls = [];

    rerender(<StreamingMarkdown text={`${head}tail of the message`} />);
    expect(parsed.calls).toEqual(["tail of the message"]);
  });

  it("parses the new block once and freezes the old last block", () => {
    const { rerender } = render(<StreamingMarkdown text={"one\n\ntw"} />);
    parsed.calls = [];
    rerender(<StreamingMarkdown text={"one\n\ntwo\n\nthr"} />);
    expect(parsed.calls).toEqual(["two\n\n", "thr"]);
  });

  it("does not re-parse anything when the text is unchanged", () => {
    const { rerender } = render(<StreamingMarkdown text={"a\n\nb"} />);
    parsed.calls = [];
    rerender(<StreamingMarkdown text={"a\n\nb"} />);
    expect(parsed.calls).toEqual([]);
  });

  it("long text: per-chunk parse count stays constant", () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `para ${i}`);
    const text = paragraphs.join("\n\n");
    const { rerender } = render(<StreamingMarkdown text={text} />);
    expect(parsed.calls).toHaveLength(300);
    parsed.calls = [];
    rerender(<StreamingMarkdown text={`${text} more`} />);
    expect(parsed.calls).toEqual(["para 299 more"]);
  });
});
