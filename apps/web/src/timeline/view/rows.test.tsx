import * as React from "react";
import { act } from "react";
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
import { formatDuration } from "./format";
import { latestPlan, PlanBar } from "./PlanBar";
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
import { DONE_FLASH_MS, titleMentionsPath, ToolRow } from "./rows/ToolRow";
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

describe("UserRow actions", () => {
  it("edits and resends through the stable callback, only when given", () => {
    const onEdit = vi.fn();
    const item = as(userItem(1, "ask me"), "user");
    const view = withServices(<UserRow item={item} onEdit={onEdit} />);
    fireEvent.click(screen.getByLabelText("编辑后重发"));
    expect(onEdit).toHaveBeenCalledWith("ask me");
    view.unmount();
    withServices(<UserRow item={item} />);
    expect(screen.queryByLabelText("编辑后重发")).toBeNull();
    expect(screen.getByLabelText("复制")).toBeTruthy();
  });
});

describe("AssistantRow regenerate", () => {
  it("resends the turn prompt; hidden without callback, prompt or while streaming", () => {
    const onRegenerate = vi.fn();
    const item = as(assistantItem(1, "an answer"), "assistant");
    const view = withServices(
      <AssistantRow item={item} prompt="the ask" onRegenerate={onRegenerate} />,
    );
    fireEvent.click(screen.getByLabelText("重新生成"));
    expect(onRegenerate).toHaveBeenCalledWith("the ask");
    view.unmount();
    const without = withServices(<AssistantRow item={item} prompt="the ask" />);
    expect(screen.queryByLabelText("重新生成")).toBeNull();
    without.unmount();
    const noPrompt = withServices(
      <AssistantRow item={item} onRegenerate={onRegenerate} />,
    );
    expect(screen.queryByLabelText("重新生成")).toBeNull();
    noPrompt.unmount();
    withServices(
      <AssistantRow
        item={{ ...item, streaming: true }}
        prompt="the ask"
        onRegenerate={onRegenerate}
      />,
    );
    expect(screen.queryByLabelText("重新生成")).toBeNull();
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
  it("is collapsed by default, says how long it thought, expands to markdown", () => {
    const item = as(thoughtItem(1, "deep *thought*"), "thought");
    render(<ThoughtRow item={item} />);
    // 结束后固定成「思考了 12 s」，没有微光。
    expect(screen.getByRole("button").textContent).toBe("思考了 12 s");
    expect(
      document.querySelector("[data-slot=shimmer]")?.className,
    ).not.toContain("anim-shimmer");
    expect(screen.queryByText(/deep/)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/deep/)).toBeTruthy();
  });

  it("shows non-text thought blocks next to the text", () => {
    const item = {
      ...as(thoughtItem(1, ""), "thought"),
      parts: [{ type: "audio" as const, blobId: "a", mimeType: "audio/wav" }],
    };
    withServices(<ThoughtRow item={item} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("[data-slot=timeline-audio]")).toBeTruthy();
  });

  it("shimmers the label and counts up while streaming", () => {
    const item = {
      ...as(thoughtItem(1, "partial", 0, true), "thought"),
      at: 1_000,
    };
    render(<ThoughtRow item={item} now={13_000} />);
    const row = document.querySelector("[data-streaming]")!;
    const shimmer = row.querySelector("[data-slot=shimmer]") as HTMLElement;
    expect(shimmer.className).toContain("anim-shimmer");
    expect(shimmer.textContent).toBe("思考");
    expect(row.textContent).toBe("思考12 s");
    // 不再用转圈，微光就是「还在想」。
    expect(row.querySelector("[data-slot=spinner]")).toBeNull();
  });

  it("falls back to the plain label when a finished thought has no duration", () => {
    const item = {
      ...as(thoughtItem(1, "old"), "thought"),
      durationMs: undefined,
    };
    render(<ThoughtRow item={item} />);
    expect(screen.getByRole("button").textContent).toBe("思考");
  });
});

describe("ToolRow", () => {
  const row = (patch: Partial<TimelineToolItem> = {}) =>
    toolItem(1, "t1", patch);

  it("draws kind icon, title, at most two file names with +N and duration, no pill when completed", () => {
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
    // 完成了就不挂状态字，图标位已经说明了。
    expect(document.querySelector("[data-slot=status-pill]")).toBeNull();
  });

  it("does not repeat a file name the title already shows", () => {
    render(
      <ToolRow
        item={row({
          title: "Write note.txt",
          locations: [{ path: "/repo/note.txt" }, { path: "/repo/other.ts" }],
        })}
      />,
    );
    const names = [
      ...document.querySelectorAll("[data-slot=timeline-tool-location]"),
    ].map((node) => node.textContent);
    expect(names).toEqual(["other.ts"]);
  });

  it("keeps the location chip when the title only contains the name as a fragment", () => {
    render(
      <ToolRow
        item={row({
          title: "Read ts files",
          locations: [{ path: "/repo/a.ts", line: 5 }, { path: "/repo/a" }],
        })}
      />,
    );
    expect(
      [...document.querySelectorAll("[data-slot=timeline-tool-location]")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["a.ts:5", "a"]);
  });

  it("keeps the line number when the title already names the file", () => {
    render(
      <ToolRow
        item={row({
          title: "Read src/config.ts",
          locations: [{ path: "/repo/src/config.ts", line: 12 }],
        })}
      />,
    );
    const chips = [
      ...document.querySelectorAll("[data-slot=timeline-tool-location]"),
    ];
    // 文件名不重复，行号还在；悬停提示是完整路径。
    expect(chips.map((node) => node.textContent)).toEqual([":12"]);
    expect(chips[0]?.getAttribute("title")).toBe("/repo/src/config.ts");
  });

  it("matches the title by whole words on directory boundaries", () => {
    expect(titleMentionsPath("Write note.txt", "/repo/note.txt")).toBe(true);
    expect(titleMentionsPath("读取 src/config.ts", "/repo/src/config.ts")).toBe(
      true,
    );
    expect(titleMentionsPath("Edit `a/b.ts:12:3`", "/r/a/b.ts")).toBe(true);
    expect(titleMentionsPath("Read /repo/x.ts", "/repo/x.ts")).toBe(true);
    expect(titleMentionsPath("Read C:\\repo\\x.ts", "C:\\repo\\x.ts")).toBe(
      true,
    );
    // 片段、跨目录边界、单字符都不算。
    expect(titleMentionsPath("Read ts files", "/repo/a.ts")).toBe(false);
    expect(titleMentionsPath("Read config.ts", "/repo/myconfig.ts")).toBe(
      false,
    );
    expect(titleMentionsPath("Read a file", "/repo/a")).toBe(false);
    expect(titleMentionsPath("", "/repo/a.ts")).toBe(false);
  });

  it("hangs approvals of nested calls under their own rows and opens the row for a pending one", () => {
    const approval = (state: "pending" | "answered") => ({
      id: "ap:2",
      kind: "approval" as const,
      turn: 1,
      ord: 2,
      rev: 1,
      source: "acp" as const,
      at: 1,
      gen: 1,
      pendingId: "p2",
      protocol: "acp",
      toolCallId: "t2",
      options: [],
      state,
    });
    const child = toolItem(1, "t2", {
      title: "inner call",
      parentToolCallId: "t1",
    });
    const renderApproval = (a: { pendingId: string }) => (
      <div data-testid="approval">{a.pendingId}</div>
    );
    const { rerender } = render(
      <ToolRow
        item={row({ toolKind: "subagent", title: "Subagent" })}
        nested={[child]}
        approvals={new Map([["t2", approval("pending")]])}
        renderApproval={renderApproval}
      />,
    );
    // 内部调用在等人答复：子代理那一行自己展开，卡片就在内部那一行下面。
    expect(screen.getByText("inner call")).toBeTruthy();
    expect(
      screen
        .getByTestId("approval")
        .closest("[data-slot=timeline-tool-approval]")
        ?.parentElement?.querySelector("[data-slot=timeline-tool-body]"),
    ).toBeNull();
    // 没有待答的审批时仍然折着。
    rerender(
      <ToolRow
        item={row({ toolKind: "subagent", title: "Subagent" })}
        nested={[child]}
        approvals={new Map([["t2", approval("answered")]])}
        renderApproval={renderApproval}
      />,
    );
    expect(screen.queryByText("inner call")).toBeNull();
  });

  it("expands the locations hidden behind +N in the body", () => {
    render(
      <ToolRow
        item={row({
          locations: [
            { path: "/repo/a.ts" },
            { path: "/repo/b.ts" },
            { path: "/repo/c.ts", line: 7 },
            { path: "/repo/d.ts" },
          ],
        })}
      />,
    );
    expect(
      document.querySelector("[data-slot=timeline-tool-locations]"),
    ).toBeNull();
    fireEvent.click(screen.getAllByRole("button")[0]!);
    const list = document.querySelector("[data-slot=timeline-tool-locations]");
    expect(
      [...list!.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["/repo/c.ts:7", "/repo/d.ts"]);
  });

  it("spells out only the statuses the icon cannot: waiting, failed, cancelled", () => {
    const tones = {
      pending: "queued",
      in_progress: null,
      completed: null,
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
          ?.getAttribute("data-tone") ?? null,
      ).toBe(tone);
      unmount();
    }
  });

  it("leaves the failure to the approval outcome when a person rejected the call", () => {
    const approval = (optionId: string) => ({
      id: "ap1",
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
      options: [
        { optionId: "ok", name: "Allow", kind: "allow_once" as const },
        { optionId: "no", name: "Reject", kind: "reject_once" as const },
      ],
      state: "answered" as const,
      answer: { optionId },
    });
    const pill = () => document.querySelector("[data-slot=status-pill]");
    const { unmount } = render(
      <ToolRow item={row({ status: "failed" })} approval={approval("no")} />,
    );
    expect(pill()).toBeNull();
    unmount();
    // 允许了还失败：照样标「失败」。
    render(
      <ToolRow item={row({ status: "failed" })} approval={approval("ok")} />,
    );
    expect(pill()?.getAttribute("data-tone")).toBe("failed");
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
    // 退出码在卡片标题行上，终端块里不再重复。
    expect(
      document.querySelector("[data-slot=timeline-tool-exit]")?.textContent,
    ).toBe("退出 2");
    expect(terminal?.querySelector("[data-slot=timeline-exit]")).toBeNull();
    const colored = [...(terminal?.querySelectorAll("pre span") ?? [])].find(
      (n) => n.textContent === "fail",
    );
    expect((colored as HTMLElement | undefined)?.style.color).not.toBe("");
  });

  it("does not repeat the command in the input when the terminal shows it", () => {
    render(
      <ToolRow
        item={row({
          toolKind: "execute",
          input: {
            command: "pnpm test",
            fields: [{ key: "cwd", value: "/repo" }],
          },
          content: [
            {
              type: "terminal",
              terminalId: "t",
              command: "pnpm test",
              output: "ok",
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(
      document.querySelector("[data-slot=timeline-tool-input]")?.textContent,
    ).not.toContain("pnpm test");
    expect(
      document.querySelector("[data-slot=timeline-terminal]")?.textContent,
    ).toContain("pnpm test");
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

  it("renders audio content from a tool", () => {
    withServices(
      <ToolRow
        item={row({
          content: [{ type: "audio", blobId: "a", mimeType: "audio/wav" }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Read file/ }));
    expect(document.querySelector("[data-slot=timeline-audio]")).toBeTruthy();
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

describe("ActivityGroup approvals", () => {
  it("opens a finished group while one of its rows waits for an answer", () => {
    const [entry] = activityGroups([
      toolItem(1, "a", { toolKind: "read", title: "Read a" }),
      toolItem(1, "b", { toolKind: "search", title: "Search b" }),
    ]);
    if (entry?.type !== "group") throw new Error("expected a group");
    const approval = (state: "pending" | "answered") => ({
      id: "ap:1",
      kind: "approval" as const,
      turn: 1,
      ord: 3,
      rev: 1,
      source: "acp" as const,
      at: 1,
      gen: 1,
      pendingId: "p1",
      protocol: "acp",
      toolCallId: "b",
      options: [],
      state,
    });
    const renderApproval = () => <div data-testid="approval" />;
    const { rerender } = render(
      <ActivityGroup
        entry={entry}
        approvals={new Map([["b", approval("answered")]])}
        renderApproval={renderApproval}
      />,
    );
    expect(screen.queryByText("Read a")).toBeNull();
    rerender(
      <ActivityGroup
        entry={entry}
        approvals={new Map([["b", approval("pending")]])}
        renderApproval={renderApproval}
      />,
    );
    expect(screen.getByText("Read a")).toBeTruthy();
    expect(screen.getByTestId("approval")).toBeTruthy();
    // 用户手动收起之后以用户为准。
    fireEvent.click(screen.getByRole("button", { name: /读了 1 个文件/ }));
    expect(screen.queryByText("Read a")).toBeNull();
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
    // 步骤前是状态圆点：完成 / 进行中 / 排队。
    expect(
      [
        ...document.querySelectorAll(
          "[data-slot=timeline-plan-list] [data-slot=status-dot]",
        ),
      ].map((dot) => dot.getAttribute("data-tone")),
    ).toEqual(["done", "working", "queued"]);
  });

  it("marks entry priority in the list", async () => {
    render(
      <PlanBar
        plan={{
          ...plan,
          entries: [
            { content: "A", status: "pending", priority: "high" },
            { content: "B", status: "pending", priority: "low" },
            { content: "C", status: "pending", priority: "other" },
            { content: "D", status: "pending" },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "计划" }));
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot=timeline-plan-list]"),
      ).toBeTruthy(),
    );
    expect(
      [...document.querySelectorAll("[data-slot=timeline-plan-priority]")].map(
        (mark) => [
          mark.getAttribute("data-priority"),
          mark.getAttribute("aria-label"),
        ],
      ),
    ).toEqual([
      ["high", "高优先级"],
      ["low", "低优先级"],
    ]);
  });

  it("draws progress as a 20-cell tick bar", () => {
    render(<PlanBar plan={plan} />);
    const bar = document.querySelector("[data-slot=progress]")!;
    expect(bar.getAttribute("data-variant")).toBe("ticks");
    expect(bar.querySelectorAll("[data-slot=progress-tick]")).toHaveLength(20);
    // 1 / 3 ≈ 33% → 7 格亮
    expect(
      bar.querySelectorAll("[data-slot=progress-tick][data-filled=true]"),
    ).toHaveLength(7);
  });

  it("opens the list upward because it sits above the input", async () => {
    render(<PlanBar plan={plan} className="mb-1" />);
    const trigger = screen.getByRole("button", { name: "计划" });
    expect(trigger.className).toContain("mb-1");
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot=popover-content]"),
      ).toBeTruthy(),
    );
    expect(
      document
        .querySelector("[data-slot=popover-content]")
        ?.getAttribute("data-side"),
    ).toBe("top");
  });

  it("picks the latest plan of the timeline", () => {
    const first = { ...plan, id: "plan:1", turn: 1 };
    const second = {
      ...plan,
      id: "plan:2",
      turn: 2,
      entries: [{ content: "Newer", status: "pending" }],
    };
    expect(
      latestPlan([
        userItem(1, "a"),
        first,
        userItem(2, "b"),
        second,
        turnItem(2),
      ])?.id,
    ).toBe("plan:2");
    expect(latestPlan([userItem(1, "a")])).toBeNull();
    expect(latestPlan([])).toBeNull();
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

  it("draws the Pi unverified notice with the version, or without one", () => {
    const { unmount } = render(
      <NoticeRow item={notice("pi_unverified", { version: "2.1.0" })} />,
    );
    expect(
      screen.getByText("Pi 未经验证，部分功能可能不可用 · 2.1.0"),
    ).toBeTruthy();
    unmount();
    render(<NoticeRow item={notice("pi_unverified")} />);
    expect(screen.getByText("Pi 未经验证，部分功能可能不可用")).toBeTruthy();
  });

  it("maps an error code to text and falls back to the raw code", () => {
    const { unmount } = render(
      <NoticeRow item={notice("error", { code: "acp_auth_required" })} />,
    );
    expect(screen.getByText("出错 · 需要登录")).toBeTruthy();
    unmount();
    render(<NoticeRow item={notice("error", { code: "weird_code" })} />);
    expect(screen.getByText("出错 · weird_code")).toBeTruthy();
  });

  it("folds a compaction summary until opened", () => {
    render(
      <NoticeRow item={notice("compacted", { summary: "kept: the plan" })} />,
    );
    expect(screen.queryByText("kept: the plan")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("kept: the plan")).toBeTruthy();
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

describe("ToolRow 界面（设计系统 §5.1）", () => {
  const row = (patch: Partial<TimelineToolItem> = {}) =>
    toolItem(1, "t1", patch);

  it("is a 28px row; only commands get the monospace name", () => {
    const { unmount } = render(
      <ToolRow item={row({ title: "pnpm test", toolKind: "execute" })} />,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-size")).toBe("sm");
    const name = screen.getByText("pnpm test");
    expect(name.className).toContain("font-mono");
    expect(name.className).toContain("text-meta");
    unmount();
    render(<ToolRow item={row({ title: "Read config", toolKind: "read" })} />);
    expect(screen.getByText("Read config").className).not.toContain(
      "font-mono",
    );
  });

  it("is a bordered card; the body sits inside it on the same left edge", () => {
    render(
      <ToolRow item={row({ input: { command: "ls" }, toolKind: "execute" })} />,
    );
    fireEvent.click(screen.getByRole("button"));
    const card = document.querySelector(
      "[data-slot=timeline-tool] > [data-slot=collapsible]",
    );
    expect(card?.className).toContain("border-border");
    expect(screen.getByRole("button").className).toContain(
      "px-[calc(--spacing(2.5)-1px)]",
    );
    const body = document.querySelector("[data-slot=timeline-tool-body] > div");
    expect(body?.className).toContain("border-t");
    expect(body?.className).toContain("px-2.5");
    expect(body?.className).not.toContain("ml-");
  });

  it("nested rows have no frame of their own", () => {
    render(<ToolRow item={row()} plain />);
    const card = document.querySelector(
      "[data-slot=timeline-tool] > [data-slot=collapsible]",
    );
    expect(card?.className).not.toContain("border");
  });

  it("shimmers the name and spins only while running", () => {
    const { rerender } = render(
      <ToolRow item={row({ status: "in_progress" })} />,
    );
    expect(document.querySelector("[data-slot=shimmer]")?.className).toContain(
      "anim-shimmer",
    );
    expect(
      document.querySelector("[data-slot=spinner][data-state=spinning]"),
    ).toBeTruthy();
    rerender(<ToolRow item={row({ status: "completed" })} />);
    expect(
      document.querySelector("[data-slot=shimmer]")?.className,
    ).not.toContain("anim-shimmer");
  });

  it("closes a run into a check mark that then gives way to the kind icon", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ToolRow item={row({ status: "in_progress" })} />,
      );
      rerender(<ToolRow item={row({ status: "completed", endedAt: 2000 })} />);
      expect(
        document.querySelector("[data-slot=spinner][data-state=done]"),
      ).toBeTruthy();
      act(() => void vi.advanceTimersByTime(DONE_FLASH_MS + 10));
      expect(document.querySelector("[data-slot=spinner]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash a check for a row that was already finished", () => {
    render(<ToolRow item={row({ status: "completed" })} />);
    expect(document.querySelector("[data-slot=spinner]")).toBeNull();
  });

  it("sums +N −M over the diffs and uses the line counts of truncated ones", () => {
    render(
      <ToolRow
        item={row({
          toolKind: "edit",
          content: [
            {
              type: "diff",
              path: "/repo/a.ts",
              oldText: "a\n",
              newText: "b\nc\n",
            },
            {
              type: "diff",
              path: "/repo/big.ts",
              truncated: true,
              addedLines: 10,
              removedLines: 4,
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByRole("button").querySelector("[data-slot=diff-counts]")
        ?.textContent,
    ).toBe("+12−5");
    cleanup();
    render(<ToolRow item={row({ toolKind: "read" })} />);
    expect(document.querySelector("[data-slot=diff-counts]")).toBeNull();
  });
});

describe("命令条目（#908）", () => {
  const command = (patch: Partial<TimelineToolItem> = {}) =>
    toolItem(1, "cmd", {
      toolKind: "execute",
      title: "python3 -c 'import sys; sys.exit(3)'",
      input: { command: "python3 -c 'import sys; sys.exit(3)'" },
      ...patch,
    });

  it("标题行写退出码与耗时；非零退出不再叠「失败」", () => {
    render(
      <ToolRow
        item={command({
          status: "failed",
          content: [
            { type: "terminal", terminalId: "cmd", output: "", exitCode: 3 },
          ],
        })}
      />,
    );
    const exit = document.querySelector("[data-slot=timeline-tool-exit]");
    expect(exit?.textContent).toBe("退出 3");
    expect(exit?.getAttribute("data-variant")).toBe("destructive");
    expect(
      document.querySelector("[data-slot=timeline-tool-duration]")?.textContent,
    ).toBe(formatDuration(1200));
    expect(screen.queryByText("失败")).toBeNull();
  });

  it("被终止的命令写「已终止」", () => {
    render(
      <ToolRow
        item={command({
          status: "failed",
          content: [{ type: "terminal", terminalId: "cmd", exitCode: null }],
        })}
      />,
    );
    expect(
      document.querySelector("[data-slot=timeline-tool-exit]")?.textContent,
    ).toBe("已终止");
  });

  it("终端部件没带命令行时用入参里的；入参不再重复，结束了没有输出写「无输出」", () => {
    render(
      <ToolRow
        item={command({
          status: "completed",
          content: [{ type: "terminal", terminalId: "cmd", exitCode: 0 }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const line = document.querySelector(
      "[data-slot=timeline-terminal-command]",
    );
    expect(line?.textContent).toContain("sys.exit(3)");
    expect(
      document.querySelector("[data-slot=timeline-tool-input]")?.textContent ??
        "",
    ).not.toContain("sys.exit(3)");
    expect(
      document.querySelector("[data-slot=timeline-terminal-empty]")
        ?.textContent,
    ).toBe("无输出");
  });

  it("运行中自动展开看输出、实时计时；结束后收起", () => {
    const running = command({
      status: "in_progress",
      endedAt: undefined,
      content: [{ type: "terminal", terminalId: "cmd", output: "step 1\n" }],
    });
    const { rerender } = render(
      <ToolRow item={running} now={running.startedAt + 3_000} />,
    );
    expect(screen.getByText("step 1")).toBeTruthy();
    expect(
      document.querySelector("[data-slot=timeline-tool-duration]")?.textContent,
    ).toBe(formatDuration(3_000));
    rerender(
      <ToolRow
        item={{
          ...running,
          rev: running.rev + 1,
          status: "completed",
          endedAt: running.startedAt + 4_000,
          content: [
            {
              type: "terminal",
              terminalId: "cmd",
              output: "step 1\n",
              exitCode: 0,
            },
          ],
        }}
      />,
    );
    expect(screen.queryByText("step 1")).toBeNull();
  });
});

describe("条目共用一条左缘、宽度跟着节点走（#908）", () => {
  it("助手正文没有最大宽度，与卡片同一档内边距", () => {
    withServices(
      <AssistantRow item={as(assistantItem(1, "hi"), "assistant")} />,
    );
    const row = document.querySelector("[data-slot=timeline-assistant]");
    expect(row?.className).not.toMatch(/max-w-/);
    expect(row?.className).toContain("px-2.5");
    expect(row?.className).toContain("border-transparent");
  });

  it("提问左对齐、占满宽度", () => {
    withServices(<UserRow item={as(userItem(1, "ask"), "user")} />);
    const row = document.querySelector("[data-slot=timeline-user]");
    expect(row?.className).not.toMatch(/max-w-|self-end|items-end/);
    expect(document.querySelector("[data-role=user]")?.className).toContain(
      "px-2.5",
    );
  });

  it("活动组的成员没有各自的边框", () => {
    const entry = activityGroups(
      [
        toolItem(1, "r1", { title: "Read a" }),
        toolItem(1, "r2", { title: "Read b" }),
      ],
      { groupable: () => true },
    )[0];
    if (entry?.type !== "group") throw new Error("expected a group");
    render(<ActivityGroup entry={entry} />);
    fireEvent.click(screen.getAllByRole("button")[0] as HTMLElement);
    const members = document.querySelectorAll(
      "[data-slot=timeline-group-body] [data-slot=timeline-tool] > [data-slot=collapsible]",
    );
    expect(members.length).toBe(2);
    for (const member of members) {
      expect(member.className).not.toContain("border");
    }
  });
});
