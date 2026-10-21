import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { TimelineItem } from "@armadra/shared";

import { type TimelineDomain, install as installTimeline } from "../timeline";
import { tempDir } from "../testing/temp-dir";
import { AcpFeed } from "./feed";
import { type AcpCore, acpCore } from "./fixture";
import type { AcpHostSession } from "./host";
import { AcpMirror, mirrorPath } from "./mirror";
import { AcpSession, type AcpSessionSink } from "./session";

/**
 * B10：没有 `session/load` 的适配器接回升级前的旧会话——时间线为空、历史只在旧
 * 镜像里时，把镜像导入时间线（设计 §2.6）。
 */

const NODE = "11111111-2222-4333-8444-555555555555";
let open: AcpCore | undefined;
let domain: TimelineDomain;
const dirs: string[] = [];

afterEach(async () => {
  await open?.stop();
  open = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<void> {
  open = await acpCore();
  domain = installTimeline(open.core) as TimelineDomain;
}

function items(rowId: string): TimelineItem[] {
  domain.writer.flush();
  return domain.store.snapshot(rowId, 20)?.items ?? [];
}

function fakeHost(
  sessionId: string,
  extra: Partial<AcpHostSession> = {},
): AcpHostSession {
  return {
    process: { pid: 1, alive: true },
    sessionId,
    opened: "resume",
    resumed: true,
    capabilities: { images: false, embeddedContext: false, load: false },
    modes: null,
    models: null,
    ...extra,
  } as unknown as AcpHostSession;
}

const MODES = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "code", name: "Code", description: "write" },
  ],
};
const MODELS = {
  configId: "model",
  currentModelId: "m1",
  availableModels: [{ modelId: "m1", name: "M1" }],
};

/** 在旧镜像里放一段对话，再用「只能 resume」的假会话接回。 */
function reopen(dataDir: string, rowId: string, seed: boolean) {
  const mirrors = (id: string) => new AcpMirror(mirrorPath(dataDir, NODE, id));
  if (seed) {
    const old = mirrors("old-session");
    old.prompt("读一下 a.ts");
    old.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "好的，我来读。" },
    } as never);
    old.update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read a.ts",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "a.ts" },
    } as never);
    old.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "内容" } }],
    } as never);
    old.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "读完了。" },
    } as never);
    old.prompt("谢谢");
    old.flush();
  }
  const feed = new AcpFeed(domain, {
    rowId,
    nodeId: NODE,
    workspaceId: open!.workspaceId,
    generation: 1,
  });
  const sink: AcpSessionSink = {
    signal: () => undefined,
    publish: () => undefined,
    cancelled: () => undefined,
  };
  const session = new AcpSession({
    rowId,
    generation: 1,
    nodeId: NODE,
    workspaceId: open!.workspaceId,
    agentId: "ama",
    sink,
    mirrorFor: mirrors,
    resumeSessionId: "old-session",
    feed,
  });
  session.opened(fakeHost("old-session"));
  return { feed, session };
}

describe("镜像派生", () => {
  it("镜像非空而时间线为空：导入，内容与镜像一致，条目标 replay", async () => {
    await boot();
    const dataDir = tempDir("armadra-acp-import-");
    dirs.push(dataDir);
    reopen(dataDir, "row-a", true);
    const all = items("row-a");
    expect(all.filter((i) => i.kind === "turn")).toHaveLength(2);
    const users = all.filter((i) => i.kind === "user");
    expect(users.map((i) => (i as { text: string }).text)).toEqual([
      "读一下 a.ts",
      "谢谢",
    ]);
    const assistant = all.filter((i) => i.kind === "assistant");
    expect(JSON.stringify(assistant)).toContain("好的，我来读。");
    expect(JSON.stringify(assistant)).toContain("读完了。");
    expect(all.find((i) => i.kind === "tool")).toMatchObject({
      toolCallId: "t1",
      status: "completed",
      title: "Read a.ts",
    });
    expect(
      all
        .filter((i) => i.kind !== "notice" && i.kind !== "approval")
        .every((i) => i.source === "replay"),
    ).toBe(true);
  });

  it("重复接回幂等：不重复写", async () => {
    await boot();
    const dataDir = tempDir("armadra-acp-import-");
    dirs.push(dataDir);
    reopen(dataDir, "row-b", true);
    const first = items("row-b").filter((i) => i.kind !== "notice");
    reopen(dataDir, "row-b", false);
    const second = items("row-b").filter((i) => i.kind !== "notice");
    expect(second).toEqual(first);
  });

  it("时间线已有内容：不导入", async () => {
    await boot();
    const dataDir = tempDir("armadra-acp-import-");
    dirs.push(dataDir);
    const existing = new AcpFeed(domain, {
      rowId: "row-c",
      nodeId: NODE,
      workspaceId: open!.workspaceId,
      generation: 1,
    });
    existing.beginTurn("1-1", { text: "已有" });
    existing.endTurn({ stopReason: "end_turn" });
    reopen(dataDir, "row-c", true);
    const users = items("row-c").filter((i) => i.kind === "user");
    expect(users.map((i) => (i as { text: string }).text)).toEqual(["已有"]);
  });

  it("镜像为空：什么都不写", async () => {
    await boot();
    const dataDir = tempDir("armadra-acp-import-");
    dirs.push(dataDir);
    reopen(dataDir, "row-d", false);
    expect(items("row-d").filter((i) => i.kind === "turn")).toHaveLength(0);
  });

  it("能 load 的适配器：回放写过之后不再导入", async () => {
    await boot();
    const feed = new AcpFeed(domain, {
      rowId: "row-e",
      nodeId: NODE,
      workspaceId: open!.workspaceId,
      generation: 1,
    });
    feed.update(
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "q" },
      },
      true,
    );
    expect(
      feed.importFrames([
        {
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "旧" },
          },
        },
      ]),
    ).toBe(false);
    feed.ready();
    const users = items("row-e").filter((i) => i.kind === "user");
    expect(users).toHaveLength(1);
  });
});

describe("初始目录写进时间线头部", () => {
  function openWith(rowId: string, extra: Partial<AcpHostSession>) {
    const feed = new AcpFeed(domain, {
      rowId,
      nodeId: NODE,
      workspaceId: open!.workspaceId,
      generation: 1,
    });
    const dataDir = tempDir("armadra-acp-head-");
    dirs.push(dataDir);
    const session = new AcpSession({
      rowId,
      generation: 1,
      nodeId: NODE,
      workspaceId: open!.workspaceId,
      agentId: "ama",
      sink: {
        signal: () => undefined,
        publish: () => undefined,
        cancelled: () => undefined,
      },
      mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
      feed,
    });
    session.opened(fakeHost("s1", extra));
    domain.writer.flush();
    return { feed, session };
  }

  it("头部带出模式、模型目录与 promptCapabilities，重开后仍在", async () => {
    await boot();
    const { feed } = openWith("row-h", {
      modes: MODES,
      models: MODELS,
      capabilities: { images: true, embeddedContext: false, load: false },
    } as never);
    const head = domain.store.snapshot("row-h", 5)?.head;
    expect(head?.modes).toEqual(MODES);
    expect(head?.models).toEqual({
      currentModelId: "m1",
      availableModels: [{ modelId: "m1", name: "M1" }],
    });
    expect(head?.promptCapabilities).toEqual({
      image: true,
      embeddedContext: false,
    });
    // 同样的目录再写一次：不产生新的操作。
    const seq = domain.writer.state("row-h")?.seq;
    feed.catalog({
      modes: head?.modes,
      models: head?.models,
      promptCapabilities: head?.promptCapabilities,
    });
    expect(domain.writer.state("row-h")?.seq).toBe(seq);
  });

  it("有目录之后 current_mode_update 生效", async () => {
    await boot();
    const { feed } = openWith("row-m", { modes: MODES } as never);
    feed.update(
      { sessionUpdate: "current_mode_update", currentModeId: "code" },
      false,
    );
    domain.writer.flush();
    expect(domain.store.snapshot("row-m", 5)?.head.modes?.currentModeId).toBe(
      "code",
    );
  });
});
