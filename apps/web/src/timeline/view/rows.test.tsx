import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { TimelineItem, TimelineToolItem } from "@armadra/shared";

const store = vi.hoisted(() => ({ workspace: { rootPath: "/repo" } }));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});
vi.mock("@/files/open-editor", () => ({ openFileInEditor: vi.fn() }));

import { ActivityGroup, summaryLabel } from "./ActivityGroup";
import { PlanBar } from "./PlanBar";
import {
  assistantItem,
  thoughtItem,
  toolItem,
  turnItem,
  userItem,
} from "./fixtures";
import { AssistantRow } from "./rows/AssistantRow";
import { NoticeRow } from "./rows/NoticeRow";
import { ThoughtRow } from "./rows/ThoughtRow";
import { ToolRow } from "./rows/ToolRow";
import { TurnFooter } from "./rows/TurnFooter";
import { UserRow } from "./rows/UserRow";
import {
  TimelineServicesProvider,
  type TimelineViewServices,
} from "./services";
import { activityGroups } from "@armadra/shared";

const loadBlob = vi.fn(
  async (_id: string) => new Blob(["x"], { type: "image/png" }),
);

beforeEach(() => {
  loadBlob.mockClear();
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

function withServices(
  node: React.ReactNode,
  services: TimelineViewServices = { loadBlob },
) {
  return render(
    <TimelineServicesProvider value={services}>
      {node}
    </TimelineServicesProvider>,
  );
}

const as = <T extends TimelineItem["kind"]>(item: TimelineItem, _kind: T) =>
  item as Extract<TimelineItem, { kind: T }>;

describe("UserRow", () => {
  it("draws a right-aligned bubble with text and attachments", async () => {
    const item = {
      ...as(userItem(1, "hello there"), "user"),
      attachments: [
        {
          kind: "image" as const,
          blobId: "b1",
          mimeType: "image/png",
          name: "shot.png",
        },
        { kind: "file" as const, name: "notes.md", uri: "file:///notes.md" },
      ],
    };
    withServices(<UserRow item={item} />);
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.getByText("notes.md")).toBeTruthy();
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot=timeline-image] img"),
      ).toBeTruthy(),
    );
  });
});

describe("AssistantRow", () => {
  it("renders every part kind", async () => {
    const item = {
      ...as(assistantItem(1, "x"), "assistant"),
      parts: [
        { type: "text" as const, text: "plain **bold** text" },
        { type: "image" as const, blobId: "img", mimeType: "image/png" },
        {
          type: "resource_link" as const,
          uri: "file:///a/readme.md",
          name: "readme.md",
          mimeType: "text/markdown",
        },
        {
          type: "resource" as const,
          uri: "file:///a/n.txt",
          name: "n.txt",
          text: "inline body",
        },
        {
          type: "resource" as const,
          uri: "file:///a/b.bin",
          name: "b.bin",
          blobId: "bin",
          bytes: 2048,
        },
        { type: "audio" as const, blobId: "aud", mimeType: "audio/wav" },
      ],
    };
    withServices(<AssistantRow item={item} />, { loadBlob, openUri: vi.fn() });
    expect(
      document.querySelector("[data-slot=timeline-markdown]")?.textContent,
    ).toContain("bold");
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot=timeline-image] img"),
      ).toBeTruthy(),
    );
    expect(screen.getByText("readme.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy();
    // 文本资源：折叠，展开后是代码块
    expect(screen.queryByText("inline body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /n\.txt/ }));
    expect(screen.getByText("inline body")).toBeTruthy();
    // 只有 blob 的资源：可下载
    expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    // 音频：展开前不取数据，展开后是原生 audio
    expect(document.querySelector("audio")).toBeNull();
    const calls = loadBlob.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "音频" }));
    await waitFor(() =>
      expect(document.querySelector("audio[controls]")).toBeTruthy(),
    );
    expect(loadBlob.mock.calls.length).toBe(calls + 1);
  });

  it("shows a placeholder for dropped images and hides open without a handler", () => {
    const item = {
      ...as(assistantItem(1, "x"), "assistant"),
      parts: [
        {
          type: "image" as const,
          mimeType: "image/png",
          dropped: true as const,
        },
        { type: "resource_link" as const, uri: "file:///a.txt", name: "a.txt" },
      ],
    };
    withServices(<AssistantRow item={item} />, {});
    expect(
      document.querySelector("[data-slot=timeline-image-missing]"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
  });

  it("opens the full image in a dialog", async () => {
    const item = {
      ...as(assistantItem(1, "x"), "assistant"),
      parts: [{ type: "image" as const, blobId: "img", mimeType: "image/png" }],
    };
    withServices(<AssistantRow item={item} />);
    await waitFor(() => screen.getByRole("button", { name: "查看大图" }));
    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("shows a spinner while streaming with no text yet", () => {
    const item = { ...as(assistantItem(1, "", 0, true), "assistant") };
    withServices(<AssistantRow item={item} />);
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
  });
});

describe("ThoughtRow", () => {
  it("is collapsed by default, shows the duration, expands to markdown", () => {
    const item = as(thoughtItem(1, "deep *thought*"), "thought");
    render(<ThoughtRow item={item} />);
    expect(screen.getByRole("button").textContent).toContain("思考 · 12 s");
    expect(screen.queryByText(/deep/)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/deep/)).toBeTruthy();
  });

  it("shows a spinner in the title while streaming", () => {
    const item = as(thoughtItem(1, "partial", 0, true), "thought");
    render(<ThoughtRow item={item} />);
    expect(
      document.querySelector("[data-streaming] [data-slot=spinner]"),
    ).toBeTruthy();
  });
});

describe("ToolRow", () => {
  const row = (patch: Partial<TimelineToolItem> = {}) =>
    toolItem(1, "t1", patch);

  it("draws kind icon, title, at most two location pills with +N, status and duration", () => {
    render(
      <ToolRow
        item={row({
          title: "Read many",
          locations: [
            { path: "/repo/a.ts", line: 4 },
            { path: "/repo/b.ts" },
            { path: "/repo/c.ts" },
            { path: "/repo/d.ts" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Read many")).toBeTruthy();
    expect(screen.getByText("a.ts:4")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
    expect(screen.queryByText("c.ts")).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("1.2 s")).toBeTruthy();
    const pill = document.querySelector("[data-slot=status-pill]");
    expect(pill?.getAttribute("data-tone")).toBe("done");
    expect(pill?.textContent).toBe("已完成");
  });

  it("maps every status to a tone", () => {
    const tones = {
      pending: "queued",
      in_progress: "working",
      completed: "done",
      failed: "failed",
      cancelled: "paused",
    } as const;
    for (const [status, tone] of Object.entries(tones)) {
      const { unmount } = render(
        <ToolRow
          item={row({ status: status as TimelineToolItem["status"] })}
        />,
      );
      expect(
        document
          .querySelector("[data-slot=status-pill]")
          ?.getAttribute("data-tone"),
      ).toBe(tone);
      unmount();
    }
  });

  it("renders structured input, not raw JSON", () => {
    render(
      <ToolRow
        item={row({
          toolKind: "execute",
          input: {
            command: "pnpm test",
            path: "/repo/src/a.ts",
            line: 7,
            query: "needle",
            url: "https://example.com/x",
            fields: [{ key: "cwd", value: "/repo" }],
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const input = document.querySelector("[data-slot=timeline-tool-input]");
    expect(input?.textContent).toContain("pnpm test");
    expect(input?.textContent).toContain("a.ts:7");
    expect(input?.textContent).toContain("needle");
    expect(input?.textContent).toContain("https://example.com/x");
    expect(input?.textContent).toContain("cwd");
    expect(input?.textContent).not.toContain("{");
  });

  it("renders a diff, a truncated diff summary, text and terminal output", () => {
    render(
      <ToolRow
        item={row({
          toolKind: "edit",
          content: [
            {
              type: "diff",
              path: "/repo/a.ts",
              oldText: "a\n",
              newText: "b\n",
            },
            {
              type: "diff",
              path: "/repo/big.ts",
              truncated: true,
              addedLines: 900,
              removedLines: 12,
            },
            {
              type: "text",
              text: "plain output",
              truncated: true,
              originalBytes: 70_000,
            },
            {
              type: "terminal",
              terminalId: "t",
              command: "ls",
              output: "\u001b[31mfail\u001b[0m\n",
              exitCode: 2,
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("[data-slot=acp-diff]")).toBeTruthy();
    expect(
      document.querySelector("[data-slot=timeline-diff-summary]")?.textContent,
    ).toContain("+900");
    expect(screen.getByText("plain output")).toBeTruthy();
    expect(screen.getByText(/已截断/)).toBeTruthy();
    const terminal = document.querySelector("[data-slot=timeline-terminal]");
    expect(terminal?.textContent).toContain("ls");
    expect(
      terminal?.querySelector("[data-slot=timeline-exit]")?.textContent,
    ).toBe("退出 2");
    const colored = [...(terminal?.querySelectorAll("pre span") ?? [])].find(
      (n) => n.textContent === "fail",
    );
    expect((colored as HTMLElement | undefined)?.style.color).not.toBe("");
  });

  it("renders image and resource content from a tool", async () => {
    withServices(
      <ToolRow
        item={row({
          content: [
            { type: "image", blobId: "i", mimeType: "image/png" },
            {
              type: "resource",
              uri: "file:///x/y.txt",
              name: "y.txt",
              text: "body",
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Read file/ }));
    await waitFor(() =>
      expect(document.querySelector("[data-slot=timeline-image]")).toBeTruthy(),
    );
    expect(screen.getByText("y.txt")).toBeTruthy();
  });

  it("nests subagent calls under the row and keeps the approval card inline", () => {
    const approval = {
      id: "ap:1",
      kind: "approval" as const,
      turn: 1,
      ord: 1,
      rev: 1,
      source: "acp" as const,
      at: 1,
      gen: 1,
      pendingId: "p1",
      protocol: "acp",
      toolCallId: "t1",
      options: [],
      state: "pending" as const,
    };
    const child = toolItem(1, "t2", {
      title: "inner call",
      parentToolCallId: "t1",
    });
    render(
      <ToolRow
        item={row({ toolKind: "subagent", title: "Subagent" })}
        nested={[child]}
        approval={approval}
        renderApproval={(a) => <div data-testid="approval">{a.pendingId}</div>}
      />,
    );
    expect(screen.queryByText("inner call")).toBeNull();
    expect(screen.getByTestId("approval").textContent).toBe("p1");
    fireEvent.click(screen.getByRole("button", { name: /Subagent/ }));
    expect(screen.getByText("inner call")).toBeTruthy();
  });
});

describe("ActivityGroup", () => {
  it("summarizes, stays open while running and collapses once finished", () => {
    const running = [
      toolItem(1, "a", { toolKind: "read" }),
      toolItem(1, "b", {
        toolKind: "read",
        status: "in_progress",
        endedAt: undefined,
      }),
      toolItem(1, "c", { toolKind: "edit" }),
      toolItem(1, "d", { toolKind: "execute", status: "failed" }),
      as(thoughtItem(1, "hm"), "thought"),
    ];
    const [entry] = activityGroups(running);
    if (entry?.type !== "group") throw new Error("expected a group");
    expect(summaryLabel(entry.summary, (k, v) => `${k}:${v?.count}`)).toContain(
      "timeline.group.reads:2",
    );
    const { rerender } = render(<ActivityGroup entry={entry} />);
    expect(
      screen.getByText(
        "读了 2 个文件 · 改了 1 个 · 运行 1 条命令 · 思考 1 次 · 失败 1 项",
      ),
    ).toBeTruthy();
    expect(entry.running).toBe(true);
    expect(screen.getAllByText("Read file").length).toBeGreaterThan(0);

    const done = activityGroups(
      running.map((i) =>
        i.kind === "tool" && i.status === "in_progress"
          ? { ...i, status: "completed" as const }
          : i,
      ),
    );
    const finished = done[0];
    if (finished?.type !== "group") throw new Error("expected a group");
    rerender(<ActivityGroup entry={finished} />);
    expect(screen.queryAllByText("Read file")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("Read file").length).toBeGreaterThan(0);
  });
});

describe("PlanBar", () => {
  const plan = {
    id: "plan:1",
    kind: "plan" as const,
    turn: 1,
    ord: 1,
    rev: 1,
    source: "acp" as const,
    at: 1,
    gen: 1,
    entries: [
      { content: "Write tests", status: "completed" },
      { content: "Fix bug", status: "in_progress" },
      { content: "Ship", status: "pending" },
    ],
  };

  it("shows the current entry and x / n, with a list in the popover", async () => {
    render(<PlanBar plan={plan} />);
    expect(screen.getByText("Fix bug")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "计划" }));
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot=timeline-plan-list]"),
      ).toBeTruthy(),
    );
    expect(
      document.querySelectorAll("[data-slot=timeline-plan-list] li"),
    ).toHaveLength(3);
  });

  it("renders nothing without a plan", () => {
    const { container } = render(<PlanBar plan={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("NoticeRow and TurnFooter", () => {
  const notice = (code: string, params: Record<string, string> = {}) =>
    ({
      id: `n:${code}`,
      kind: "notice",
      turn: 1,
      ord: 1,
      rev: 1,
      source: "core",
      at: 1,
      gen: 1,
      code,
      params,
    }) as unknown as Extract<TimelineItem, { kind: "notice" }>;

  it("draws a centered line with the detail", () => {
    render(<NoticeRow item={notice("mode_changed", { name: "plan" })} />);
    expect(screen.getByText("模式已切换 · plan")).toBeTruthy();
  });

  it("covers error, refusal, cancelled and limit; end_turn draws nothing", () => {
    const onRetry = vi.fn();
    const onContinue = vi.fn();
    const footer = (patch: object) => as(turnItem(1, patch), "turn");

    const { unmount } = render(
      <TurnFooter
        item={footer({ error: { code: "x", message: "boom" } })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("boom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalled();
    unmount();

    render(<TurnFooter item={footer({ stopReason: "refusal" })} />);
    expect(document.querySelector("[data-stop=refusal]")).toBeTruthy();
    cleanup();

    render(
      <TurnFooter
        item={footer({ stopReason: "cancelled" })}
        onContinue={onContinue}
      />,
    );
    expect(screen.getByText("已取消")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    render(
      <TurnFooter
        item={footer({ stopReason: "max_tokens" })}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onContinue).toHaveBeenCalled();
    cleanup();

    const { container } = render(<TurnFooter item={footer({})} />);
    expect(container.textContent).toBe("");
  });
});
