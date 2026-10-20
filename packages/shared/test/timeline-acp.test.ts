import { describe, expect, it } from "vitest";
import {
  type AcpOpsContext,
  type TimelineItem,
  type TimelineState,
  type TimelineToolItem,
  DIFF_MAX_BYTES,
  TOOL_TEXT_TAIL_BYTES,
  acpTurnBeginOps,
  acpTurnEndOps,
  acpUpdateToOps,
  applyTimelineFrame,
  applyTimelineOps,
  clipTail,
  emptyTimelineState,
  modelCatalogOf,
  reduceAcpUpdate,
  sortedTimelineItems,
  timelineNoticeOps,
  toolInputSummary,
} from "../src/index.js";

let clock = 10_000;
const ctx = (over: Partial<AcpOpsContext> = {}): AcpOpsContext => ({
  turnId: "t1",
  turn: 1,
  at: (clock += 10),
  gen: 0,
  ...over,
});

function feed(
  updates: unknown[],
  start: TimelineState = emptyTimelineState(),
  over: Partial<AcpOpsContext> = {},
): TimelineState {
  let state = start;
  for (const update of updates)
    state = reduceAcpUpdate(state, update, ctx(over)).state;
  return state;
}

const msg = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const think = (text: string) => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const toolCall = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: `T ${toolCallId}`,
  kind: "read",
  status: "pending",
  ...extra,
});
const toolUpd = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  ...extra,
});

const items = (state: TimelineState): TimelineItem[] =>
  sortedTimelineItems(state);
const toolOf = (state: TimelineState, id: string): TimelineToolItem => {
  const item = state.items[`tool:${id}`];
  if (item?.kind !== "tool") throw new Error(`no tool ${id}`);
  return item;
};

describe("消息与思考", () => {
  it("第一个分块 put，后面的 append；操作序号从 state.seq+1 连续", () => {
    let state = emptyTimelineState();
    const first = reduceAcpUpdate(state, msg("Hel"), ctx());
    expect(first.ops.map((o) => `${o.seq}${o.op}`)).toEqual(["1put"]);
    state = first.state;
    const second = reduceAcpUpdate(state, msg("lo"), ctx());
    expect(second.ops).toEqual([
      { seq: 2, op: "append", itemId: "a:1:1", delta: { text: "lo" } },
    ]);
    const item = second.state.items["a:1:1"];
    expect(item).toMatchObject({
      kind: "assistant",
      streaming: true,
      parts: [{ type: "text", text: "Hello" }],
    });
  });

  it("被工具打断后，新文本是新条目 a:1:2，旧的收尾", () => {
    const state = feed([msg("one"), toolCall("c1"), msg("two")]);
    expect(items(state).map((i) => i.id)).toEqual([
      "a:1:1",
      "tool:c1",
      "a:1:2",
    ]);
    expect(state.items["a:1:1"]).toMatchObject({ streaming: false });
    expect(state.items["a:1:2"]).toMatchObject({ streaming: true });
  });

  it("思考：独立条目 th:1:1，收尾时记时长，非文本块忽略", () => {
    const state = feed([
      think("hm"),
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "image", data: "x", mimeType: "image/png" },
      },
      think("m"),
      msg("answer"),
    ]);
    expect(state.items["th:1:1"]).toMatchObject({
      kind: "thought",
      text: "hmm",
      streaming: false,
    });
    const thought = state.items["th:1:1"];
    expect(thought?.kind === "thought" && thought.durationMs).toBeGreaterThan(
      0,
    );
    expect(state.items["a:1:1"]).toMatchObject({ kind: "assistant" });
  });

  it("适配器重发整段或快照式分块不会重复", () => {
    const long = "This sentence is long enough to be a snapshot.";
    const state = feed([
      msg(long),
      msg(long),
      msg(long + " And more words follow here."),
    ]);
    const item = state.items["a:1:1"];
    expect(item?.kind === "assistant" && item.parts).toEqual([
      { type: "text", text: long + " And more words follow here." },
    ]);
  });

  it("短的重复 token 保留", () => {
    const state = feed([msg("a\n"), msg("\n"), msg("b")]);
    const item = state.items["a:1:1"];
    expect(item?.kind === "assistant" && item.parts).toEqual([
      { type: "text", text: "a\n\nb" },
    ]);
  });

  it("文本之后接图片、资源链接、内嵌资源、音频：各成部件，文本再开新部件", () => {
    const blobs: string[] = [];
    const storeBlob: AcpOpsContext["storeBlob"] = (blob) => {
      blobs.push(blob.kind);
      return { blobId: `b${blobs.length}`, bytes: blob.data.length };
    };
    const state = feed(
      [
        msg("see"),
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "AAAA", mimeType: "image/png" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource_link",
            uri: "file:///a.ts",
            name: "a.ts",
            mimeType: "text/plain",
            title: "A",
          },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource",
            resource: {
              uri: "file:///b.ts",
              text: "code",
              mimeType: "text/plain",
            },
          },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "resource",
            resource: {
              uri: "file:///c.bin",
              blob: "QUJD",
              mimeType: "application/octet-stream",
            },
          },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
        },
        msg("after"),
      ],
      emptyTimelineState(),
      { storeBlob },
    );
    const item = state.items["a:1:1"];
    expect(item?.kind === "assistant" && item.parts).toEqual([
      { type: "text", text: "see" },
      { type: "image", mimeType: "image/png", blobId: "b1", bytes: 4 },
      {
        type: "resource_link",
        uri: "file:///a.ts",
        name: "a.ts",
        mimeType: "text/plain",
        title: "A",
      },
      {
        type: "resource",
        uri: "file:///b.ts",
        text: "code",
        mimeType: "text/plain",
      },
      {
        type: "resource",
        uri: "file:///c.bin",
        mimeType: "application/octet-stream",
        blobId: "b2",
        bytes: 4,
      },
      { type: "audio", mimeType: "audio/wav", blobId: "b3", bytes: 8 },
      { type: "text", text: "after" },
    ]);
    expect(blobs).toEqual(["image", "resource", "audio"]);
    expect(JSON.stringify(state.items)).not.toContain("AAAA");
  });

  it("没有 storeBlob 或存储拒绝时只留 dropped，不带 base64", () => {
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "SECRETDATA", mimeType: "image/png" },
    };
    const none = feed([update]);
    const refused = feed([update], emptyTimelineState(), {
      storeBlob: () => null,
    });
    for (const state of [none, refused]) {
      const item = state.items["a:1:1"];
      expect(item?.kind === "assistant" && item.parts).toEqual([
        { type: "image", mimeType: "image/png", dropped: true },
      ]);
      expect(JSON.stringify(state.items)).not.toContain("SECRETDATA");
    }
  });

  it("不认识的内容块与缺字段的块被忽略", () => {
    const state = feed([
      { sessionUpdate: "agent_message_chunk", content: { type: "weird" } },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "resource_link" },
      },
      { sessionUpdate: "agent_message_chunk" },
      { sessionUpdate: "agent_message_chunk", content: null },
    ]);
    expect(items(state)).toEqual([]);
  });
});

describe("用户消息", () => {
  it("回放里的用户消息按回合 id 写入，分块并成一条，附件记引用", () => {
    const state = feed(
      [
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "fix " },
        },
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "it" },
        },
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: "AAAA", mimeType: "image/png" },
        },
      ],
      emptyTimelineState(),
      { source: "replay" },
    );
    expect(state.items["u:t1"]).toMatchObject({
      kind: "user",
      source: "replay",
      text: "fix it",
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });
  });

  it("页面先画的那一句，适配器回显同一句（够长）不再追加", () => {
    const prompt = "please refactor the whole module carefully";
    let state = applyTimelineOps(
      emptyTimelineState(),
      acpTurnBeginOps(emptyTimelineState(), ctx(), { text: prompt }),
    ).state;
    state = feed(
      [
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: prompt },
        },
      ],
      state,
    );
    expect(state.items["u:t1"]).toMatchObject({ text: prompt });
  });
});

describe("工具调用", () => {
  it("按 toolCallId 合并：状态前进、内容整体替换、位置与入参保留", () => {
    let state = feed([
      toolCall("c1", {
        kind: "execute",
        rawInput: { command: "pnpm test", cwd: "/repo" },
        locations: [{ path: "/repo/a.ts", line: 3 }],
      }),
    ]);
    expect(toolOf(state, "c1")).toMatchObject({
      toolKind: "execute",
      status: "pending",
      title: "T c1",
      input: { command: "pnpm test", fields: [{ key: "cwd", value: "/repo" }] },
      locations: [{ path: "/repo/a.ts", line: 3 }],
    });
    state = feed(
      [
        toolUpd("c1", {
          status: "in_progress",
          content: [
            { type: "content", content: { type: "text", text: "run" } },
          ],
        }),
      ],
      state,
    );
    state = feed(
      [
        toolUpd("c1", {
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "done" } },
          ],
        }),
      ],
      state,
    );
    const done = toolOf(state, "c1");
    expect(done.status).toBe("completed");
    expect(done.content).toEqual([{ type: "text", text: "done" }]);
    expect(done.locations).toHaveLength(1);
    expect(done.endedAt).toBeGreaterThan(0);
    // 终态之后的迟到更新不倒退。
    state = feed([toolUpd("c1", { status: "in_progress" })], state);
    expect(toolOf(state, "c1").status).toBe("completed");
  });

  it("没有实质变化的更新不产生操作", () => {
    const state = feed([toolCall("c1")]);
    expect(
      acpUpdateToOps(
        state,
        toolCall("c1"),
        ctx({ at: toolOf(state, "c1").startedAt }),
      ),
    ).toEqual([]);
    expect(acpUpdateToOps(state, toolUpd("c1"), ctx())).toEqual([]);
  });

  it("工具 id 缺失、种类 / 状态不认识：忽略或归为 other", () => {
    expect(
      acpUpdateToOps(
        emptyTimelineState(),
        { sessionUpdate: "tool_call", title: "x" },
        ctx(),
      ),
    ).toEqual([]);
    const state = feed([
      toolUpd("c9", { kind: "teleport", status: "weird", title: "Z" }),
    ]);
    expect(toolOf(state, "c9")).toMatchObject({
      toolKind: "other",
      status: "pending",
      title: "Z",
    });
  });

  it("diff、终端、图片、资源链接、内嵌资源都转成结构化内容", () => {
    const state = feed(
      [
        toolCall("c1", {
          kind: "edit",
          content: [
            { type: "diff", path: "/a.ts", oldText: "a", newText: "b" },
            { type: "diff", path: "/new.ts", newText: "x" },
            { type: "terminal", terminalId: "term-1" },
            {
              type: "content",
              content: { type: "image", data: "AAAA", mimeType: "image/png" },
            },
            {
              type: "content",
              content: { type: "resource_link", uri: "file:///r", name: "r" },
            },
            {
              type: "content",
              content: {
                type: "resource",
                resource: { uri: "file:///e", text: "body" },
              },
            },
            { type: "content", content: { type: "text", text: "plain" } },
            {
              type: "content",
              content: { type: "audio", data: "x", mimeType: "audio/wav" },
            },
            { type: "nonsense" },
          ],
        }),
      ],
      emptyTimelineState(),
      { storeBlob: () => ({ blobId: "bb", bytes: 3 }) },
    );
    expect(toolOf(state, "c1").content).toEqual([
      { type: "diff", path: "/a.ts", oldText: "a", newText: "b" },
      { type: "diff", path: "/new.ts", oldText: null, newText: "x" },
      { type: "terminal", terminalId: "term-1" },
      { type: "image", mimeType: "image/png", blobId: "bb", bytes: 3 },
      { type: "resource", uri: "file:///r", name: "r" },
      { type: "resource", uri: "file:///e", text: "body" },
      { type: "text", text: "plain" },
    ]);
  });

  it("输出文本只留尾部 64 KiB，diff 超过 1 MiB 只记行数", () => {
    const big = "x".repeat(TOOL_TEXT_TAIL_BYTES + 1000);
    const hugeDiff = "line\n".repeat(Math.ceil(DIFF_MAX_BYTES / 5) + 10);
    const state = feed([
      toolCall("c1", {
        content: [
          { type: "content", content: { type: "text", text: big } },
          { type: "diff", path: "/huge", oldText: null, newText: hugeDiff },
        ],
      }),
    ]);
    const [text, diff] = toolOf(state, "c1").content;
    expect(text).toMatchObject({
      type: "text",
      truncated: true,
      originalBytes: big.length,
    });
    expect(text?.type === "text" && text.text.length).toBe(
      TOOL_TEXT_TAIL_BYTES,
    );
    expect(diff).toEqual({
      type: "diff",
      path: "/huge",
      truncated: true,
      addedLines: hugeDiff.split("\n").length,
      removedLines: 0,
    });
  });

  it("没有 content 时用 rawOutput 里的文本，不贴 JSON", () => {
    const fromString = feed([
      toolUpd("c1", { status: "completed", rawOutput: "hello" }),
    ]);
    expect(toolOf(fromString, "c1").content).toEqual([
      { type: "text", text: "hello" },
    ]);
    const fromObject = feed([
      toolUpd("c2", { rawOutput: { stdout: "out", code: 0 } }),
    ]);
    expect(toolOf(fromObject, "c2").content).toEqual([
      { type: "text", text: "out" },
    ]);
    const none = feed([toolUpd("c3", { rawOutput: { code: 0 } })]);
    expect(toolOf(none, "c3").content).toEqual([]);
  });

  it("子代理：Task 工具记 subagent，内部调用带 parentToolCallId", () => {
    const state = feed([
      toolCall("sub", { _meta: { claudeCode: { toolName: "Task" } } }),
      toolCall("inner", {
        _meta: { claudeCode: { toolName: "Read", parentToolUseId: "sub" } },
      }),
    ]);
    expect(toolOf(state, "sub").toolKind).toBe("subagent");
    expect(toolOf(state, "inner").parentToolCallId).toBe("sub");
  });

  it("计划按回合 upsert，相同的不重复写", () => {
    const plan = (done: boolean) => ({
      sessionUpdate: "plan",
      entries: [
        {
          content: "step",
          status: done ? "completed" : "pending",
          priority: "high",
        },
        { nope: 1 },
      ],
    });
    let state = feed([plan(false)]);
    expect(state.items["plan:1"]).toMatchObject({
      kind: "plan",
      entries: [{ content: "step", status: "pending", priority: "high" }],
    });
    expect(acpUpdateToOps(state, plan(false), ctx())).toEqual([]);
    state = feed([plan(true)], state);
    expect(state.items["plan:1"]).toMatchObject({
      entries: [{ status: "completed" }],
    });
  });
});

describe("头部值与提示", () => {
  const modes = {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "code", name: "Code" },
    ],
  };
  const configOptions = (current: string) => [
    {
      id: "model",
      category: "model",
      currentValue: current,
      options: [
        { value: "m1", name: "Model 1" },
        {
          group: "g",
          options: [{ value: "m2", name: "Model 2", description: "d" }],
        },
      ],
    },
  ];

  it("用量、命令、标题进头部；相同的值不重复写", () => {
    let state = feed([
      {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 0.5, currency: "USD" },
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "init", description: "d" }, { name: "" }],
      },
      { sessionUpdate: "session_info_update", title: "Refactor" },
    ]);
    expect(state.head).toEqual({
      usage: { used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } },
      commands: [{ name: "init", description: "d" }],
      title: "Refactor",
    });
    expect(
      acpUpdateToOps(
        state,
        {
          sessionUpdate: "usage_update",
          used: 10,
          size: 100,
          cost: { amount: 0.5, currency: "USD" },
        },
        ctx(),
      ),
    ).toEqual([]);
    state = feed(
      [{ sessionUpdate: "session_info_update", title: null }],
      state,
    );
    expect(state.head.title).toBeNull();
  });

  it("模式切换：头部当前模式 + 一条 mode_changed 提示", () => {
    let state = applyTimelineOps(emptyTimelineState(), [
      { seq: 1, op: "head", head: { modes } },
    ]).state;
    state = feed(
      [{ sessionUpdate: "current_mode_update", currentModeId: "code" }],
      state,
    );
    expect(state.head.modes?.currentModeId).toBe("code");
    const notice = items(state).find((i) => i.kind === "notice");
    expect(notice).toMatchObject({
      code: "mode_changed",
      params: { modeId: "code", name: "Code" },
    });
    expect(
      acpUpdateToOps(
        state,
        { sessionUpdate: "current_mode_update", currentModeId: "code" },
        ctx(),
      ),
    ).toEqual([]);
    // 还没有模式目录时不画（与旧页面一致）。
    expect(
      acpUpdateToOps(
        emptyTimelineState(),
        { sessionUpdate: "current_mode_update", currentModeId: "code" },
        ctx(),
      ),
    ).toEqual([]);
  });

  it("模型目录：有目录才跟，当前模型变了写 model_changed", () => {
    const catalog = modelCatalogOf(configOptions("m1"));
    expect(catalog).toEqual({
      currentModelId: "m1",
      availableModels: [
        { modelId: "m1", name: "Model 1" },
        { modelId: "m2", name: "Model 2", description: "d" },
      ],
    });
    expect(
      acpUpdateToOps(
        emptyTimelineState(),
        {
          sessionUpdate: "config_option_update",
          configOptions: configOptions("m2"),
        },
        ctx(),
      ),
    ).toEqual([]);
    let state = applyTimelineOps(emptyTimelineState(), [
      { seq: 1, op: "head", head: { models: catalog } },
    ]).state;
    state = feed(
      [
        {
          sessionUpdate: "config_option_update",
          configOptions: configOptions("m2"),
        },
      ],
      state,
    );
    expect(state.head.models?.currentModelId).toBe("m2");
    expect(items(state).find((i) => i.kind === "notice")).toMatchObject({
      code: "model_changed",
      params: { modelId: "m2", name: "Model 2" },
    });
    expect(modelCatalogOf("x")).toBeNull();
    expect(modelCatalogOf([{ id: "other", options: [] }])).toBeNull();
  });

  it("timelineNoticeOps：n:<turn>:<code>:<seq>", () => {
    const state = applyTimelineOps(
      emptyTimelineState(),
      timelineNoticeOps(emptyTimelineState(), ctx(), "driver_switched", {
        to: "terminal",
      }),
    ).state;
    expect(Object.keys(state.items)).toEqual(["n:1:driver_switched:1"]);
  });
});

describe("回合边界", () => {
  it("开始：回合条目 + 用户消息；重复调用不产生操作", () => {
    const empty = emptyTimelineState();
    const ops = acpTurnBeginOps(empty, ctx(), {
      text: "go",
      clientTurnId: "c1",
      author: "me",
    });
    const state = applyTimelineOps(empty, ops).state;
    expect(state.items["turn:t1"]).toMatchObject({
      kind: "turn",
      ord: 0,
      permissionWaitMs: 0,
    });
    expect(state.items["u:t1"]).toMatchObject({
      kind: "user",
      ord: 1,
      text: "go",
      clientTurnId: "c1",
      author: "me",
    });
    expect(acpTurnBeginOps(state, ctx(), { text: "go" })).toEqual([]);
  });

  it("结束：收尾流式条目，写 endedAt 与停止原因；重复结束无操作", () => {
    let state = applyTimelineOps(
      emptyTimelineState(),
      acpTurnBeginOps(emptyTimelineState(), ctx(), { text: "go" }),
    ).state;
    state = feed([think("t"), msg("answer")], state);
    const ops = acpTurnEndOps(state, ctx(), {
      stopReason: "end_turn",
      usage: { used: 5, size: 10 },
    });
    state = applyTimelineOps(state, ops).state;
    expect(state.items["a:1:1"]).toMatchObject({ streaming: false });
    expect(state.items["turn:t1"]).toMatchObject({
      stopReason: "end_turn",
      usage: { used: 5, size: 10 },
    });
    expect(acpTurnEndOps(state, ctx(), { stopReason: "end_turn" })).toEqual([]);
  });

  it("被打断或出错：没结束的工具记 cancelled，挂着的审批记 cancelled；正常结束不动工具", () => {
    const approval: TimelineItem = {
      id: "ap:p1",
      kind: "approval",
      turn: 1,
      ord: 5,
      rev: 0,
      source: "acp",
      at: 1,
      gen: 0,
      pendingId: "p1",
      protocol: "acp",
      options: [],
      state: "pending",
    };
    let state = feed([
      toolCall("c1", { status: "in_progress" }),
      toolCall("c2", { status: "completed" }),
    ]);
    state = applyTimelineOps(state, [
      { seq: state.seq + 1, op: "put", item: approval },
    ]).state;
    const cancelled = applyTimelineOps(
      state,
      acpTurnEndOps(state, ctx(), { stopReason: "cancelled" }),
    ).state;
    expect(toolOf(cancelled, "c1").status).toBe("cancelled");
    expect(toolOf(cancelled, "c2").status).toBe("completed");
    expect(cancelled.items["ap:p1"]).toMatchObject({ state: "cancelled" });
    const failed = applyTimelineOps(
      state,
      acpTurnEndOps(state, ctx(), { error: { code: "boom", message: "x" } }),
    ).state;
    expect(failed.items["turn:t1"]).toMatchObject({
      error: { code: "boom", message: "x" },
    });
    expect(toolOf(failed, "c1").status).toBe("cancelled");
    const normal = applyTimelineOps(
      state,
      acpTurnEndOps(state, ctx(), { stopReason: "end_turn" }),
    ).state;
    expect(toolOf(normal, "c1").status).toBe("in_progress");
  });
});

describe("端到端：core 写入，页面按帧收敛", () => {
  it("同一串更新经 reduceAcpUpdate 出帧，页面重复 / 乱序 / 丢帧后与 core 一致", () => {
    const updates: unknown[] = [
      msg("Hello "),
      msg("world"),
      think("hmm"),
      toolCall("c1", { kind: "execute" }),
      toolUpd("c1", {
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      }),
      msg("done"),
      { sessionUpdate: "plan", entries: [{ content: "a" }] },
      { sessionUpdate: "usage_update", used: 1, size: 2 },
      { sessionUpdate: "garbage" },
    ];
    let core = emptyTimelineState();
    const frames = [] as {
      from: number;
      to: number;
      ops: ReturnType<typeof acpUpdateToOps>;
    }[];
    for (const update of updates) {
      const from = core.seq;
      const step = reduceAcpUpdate(core, update, ctx());
      core = step.state;
      if (step.ops.length > 0)
        frames.push({ from, to: core.seq, ops: step.ops });
    }
    // 乱序 + 重复 + 丢一帧；最后补一次 sync。
    const order = [3, 0, 0, 5, 1, 2, 4, 6, 6];
    let page = emptyTimelineState();
    for (const index of order) {
      const frame = frames[index];
      if (frame) page = applyTimelineFrame(page, frame).state;
    }
    // 按序补齐剩下的。
    for (const frame of frames) page = applyTimelineFrame(page, frame).state;
    expect(page.items).toEqual(core.items);
    expect(page.head).toEqual(core.head);
    expect(page.seq).toBe(core.seq);
  });
});

describe("toolInputSummary / clipTail", () => {
  it("按字段名取命令、路径、行号、查询、URL，其余标量折成键值", () => {
    expect(
      toolInputSummary({
        command: ["git", "status"],
        timeout: 5,
        nested: { a: 1 },
      }),
    ).toEqual({
      command: "git status",
      fields: [{ key: "timeout", value: "5" }],
    });
    expect(
      toolInputSummary({ file_path: "/a.ts", offset: 12, limit: 50 }),
    ).toEqual({
      path: "/a.ts",
      line: 12,
      fields: [{ key: "limit", value: "50" }],
    });
    expect(toolInputSummary({ pattern: "foo", url: "https://x" })).toEqual({
      query: "foo",
      url: "https://x",
    });
    expect(toolInputSummary("ls -la")).toEqual({ command: "ls -la" });
    expect(toolInputSummary({ nested: { a: 1 } })).toBeUndefined();
    expect(toolInputSummary(null)).toBeUndefined();
    expect(toolInputSummary("")).toBeUndefined();
  });

  it("键值最多 12 个，值截到 400 字", () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < 20; i++) raw[`k${i}`] = "v".repeat(500);
    const summary = toolInputSummary(raw);
    expect(summary?.fields).toHaveLength(12);
    expect(summary?.fields?.[0]?.value).toHaveLength(400);
  });

  it("clipTail 在字符边界上切，不产生乱码", () => {
    expect(clipTail("short")).toEqual({ text: "short" });
    const text = "字".repeat(100);
    const clipped = clipTail(text, 10);
    expect(clipped.truncated).toBe(true);
    expect(clipped.originalBytes).toBe(300);
    expect(clipped.text).toBe("字字字");
    expect(clipped.text).not.toContain("�");
  });
});
