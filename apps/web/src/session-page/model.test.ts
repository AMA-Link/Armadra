import { describe, expect, it } from "vitest";

import {
  buildSessionItems,
  buildSessionTree,
  filterTree,
  flatten,
  groupTree,
  type BoardSource,
} from "./model";
import {
  agentNode,
  document,
  plainTerminal,
  row,
  supervises,
} from "./fixtures";

const canvas: BoardSource = {
  boardId: "b1",
  name: "Main",
  onSessionBoard: false,
  document: document(
    "b1",
    [
      agentNode("lead", "b1"),
      agentNode("worker", "b1"),
      agentNode("helper", "b1"),
      plainTerminal("shell", "b1"),
    ],
    [supervises("b1", "lead", "worker"), supervises("b1", "worker", "helper")],
  ),
};
const sessions: BoardSource = {
  boardId: "b2",
  name: "",
  onSessionBoard: true,
  document: document("b2", [agentNode("solo", "b2", { driver: "acp" })]),
};

describe("buildSessionItems", () => {
  it("只收带 Agent 的终端，会话板按本地化名字标注", () => {
    const items = buildSessionItems([canvas, sessions], [], [], "会话");
    expect(items.map((item) => item.nodeId).sort()).toEqual([
      "helper",
      "lead",
      "solo",
      "worker",
    ]);
    const solo = items.find((item) => item.nodeId === "solo")!;
    expect(solo).toMatchObject({ boardName: "会话", onSessionBoard: true });
    expect(items.find((item) => item.nodeId === "lead")).toMatchObject({
      boardName: "Main",
      onSessionBoard: false,
    });
  });

  it("并入会话行，没有进程的没有 session", () => {
    const items = buildSessionItems(
      [canvas],
      [row("lead", { state: "working" })],
      [],
      "会话",
    );
    expect(items.find((i) => i.nodeId === "lead")?.session?.state).toBe(
      "working",
    );
    expect(items.find((i) => i.nodeId === "worker")?.session).toBeUndefined();
  });

  it("刚新开的会话在文档里出现之前先画出来，出现之后不重复", () => {
    const pending = {
      nodeId: "fresh",
      boardId: "b2",
      title: "New",
      agentId: "codex",
      driver: "terminal" as const,
    };
    const before = buildSessionItems([canvas], [], [pending], "会话");
    expect(before.find((i) => i.nodeId === "fresh")).toMatchObject({
      title: "New",
      onSessionBoard: true,
      boardName: "会话",
    });
    const withDoc: BoardSource = {
      ...sessions,
      document: document("b2", [agentNode("fresh", "b2", { title: "Real" })]),
    };
    const after = buildSessionItems([withDoc], [], [pending], "会话");
    expect(after.filter((i) => i.nodeId === "fresh")).toHaveLength(1);
    expect(after[0]?.title).toBe("Real");
  });
});

describe("buildSessionTree", () => {
  it("下级挂在上级下面，链可以很深", () => {
    const tree = buildSessionTree(buildSessionItems([canvas], [], [], "会话"));
    expect(tree).toHaveLength(1);
    expect(tree[0]?.item.nodeId).toBe("lead");
    expect(tree[0]?.children[0]?.item.nodeId).toBe("worker");
    expect(tree[0]?.children[0]?.children[0]?.item.nodeId).toBe("helper");
  });

  it("上级不是会话时下级当根；互相盯着的环也不丢条目", () => {
    const loop: BoardSource = {
      boardId: "b1",
      name: "Main",
      onSessionBoard: false,
      document: document(
        "b1",
        [agentNode("a", "b1"), agentNode("b", "b1")],
        [supervises("b1", "a", "b"), supervises("b1", "b", "a")],
      ),
    };
    const items = buildSessionItems([loop], [], [], "会话");
    expect(
      flatten(buildSessionTree(items))
        .map((i) => i.nodeId)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("groupTree / filterTree", () => {
  it("下级在等人时整棵树排进「需要你」", () => {
    const items = buildSessionItems(
      [canvas],
      [
        row("lead", { state: "idle" }),
        row("worker", { state: "waiting", pendingId: "p1" }),
      ],
      [],
      "会话",
    );
    const groups = groupTree(buildSessionTree(items));
    expect(groups.map((g) => g.bucket)).toEqual(["attention"]);
  });

  it("没有会话行的归「启动中」", () => {
    const items = buildSessionItems([sessions], [], [], "会话");
    expect(groupTree(buildSessionTree(items))[0]?.bucket).toBe("starting");
  });

  it("过滤命中下级时保留它的上级", () => {
    const tree = buildSessionTree(buildSessionItems([canvas], [], [], "会话"));
    const hit = filterTree(tree, "help");
    expect(flatten(hit).map((i) => i.nodeId)).toEqual([
      "lead",
      "worker",
      "helper",
    ]);
    expect(filterTree(tree, "nothing")).toEqual([]);
  });
});
