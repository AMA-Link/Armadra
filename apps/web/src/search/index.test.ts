import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@armadra/shared";

import { emptyWhiteboard, type WhiteboardDoc } from "@/canvas/whiteboard/model";
import {
  boardEntries,
  documentEntries,
  excerpt,
  searchEntries,
  workspaceEntries,
  type SearchEntry,
} from "./index";

const timestamp = "2026-09-05T10:00:00.000Z";

function node(
  id: string,
  title: string,
  data: CanvasNode["data"],
  extra: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id,
    boardId: "board",
    type: data.kind,
    title,
    color: "#5B5BD6",
    position: { x: 0, y: 0 },
    labels: [],
    note: "",
    data,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  } as CanvasNode;
}

const sticky = (id: string, title: string, content: string) =>
  node(id, title, { kind: "sticky", content });
const terminal = (id: string, title: string) =>
  node(id, title, { kind: "terminal" });

const style = { color: "black", size: "m" } as const;
function whiteboard(
  items: { id: string; text?: string; label?: string; alt?: string }[],
): WhiteboardDoc {
  return {
    ...emptyWhiteboard(),
    items: items.map((item, index) =>
      item.label !== undefined
        ? {
            id: item.id,
            kind: "shape" as const,
            geo: "rectangle" as const,
            x: 0,
            y: 0,
            w: 10,
            h: 10,
            z: index,
            style,
            label: item.label,
          }
        : item.alt !== undefined
          ? {
              id: item.id,
              kind: "image" as const,
              assetPath: ".armadra/assets/a.png",
              alt: item.alt,
              x: 0,
              y: 0,
              w: 10,
              h: 10,
              z: index,
              style,
            }
          : {
              id: item.id,
              kind: "text" as const,
              text: item.text ?? "",
              x: 0,
              y: 0,
              w: 10,
              h: 10,
              z: index,
              style,
            },
    ),
  };
}

const alpha = { id: "w1", name: "设计稿" };
const beta = { id: "w2", name: "后端服务" };

function fixture(): SearchEntry[] {
  return [
    ...workspaceEntries([alpha, beta]),
    ...boardEntries(alpha, [
      { id: "b1", name: "首页改版" },
      { id: "b2", name: "组件库" },
    ]),
    ...boardEntries(beta, [{ id: "b3", name: "接口梳理" }]),
    ...documentEntries({
      workspace: alpha,
      board: { id: "b1", name: "首页改版" },
      nodes: [
        terminal("n1", "构建流水线"),
        sticky("n2", "待办", "先修好 tmux 降级那条横幅，再看导出"),
        node("n3", "导航栏方案", { kind: "group" }),
      ],
      whiteboard: whiteboard([
        { id: "i1", text: "首页英雄区文案" },
        { id: "i2", label: "按钮状态" },
        { id: "i3", alt: "登录页截图" },
      ]),
    }),
    ...documentEntries({
      workspace: beta,
      board: { id: "b3", name: "接口梳理" },
      nodes: [
        node("n4", "Button.tsx", { kind: "editor", path: "src/ui/button.tsx" }),
        node("n5", "文档站", {
          kind: "browser",
          url: "https://docs.example/api",
        }),
        node("n6", "迁移脚本", { kind: "terminal", cwd: "/srv/api" }),
      ],
      whiteboard: whiteboard([{ id: "i4", text: "限流策略\n第二行说明" }]),
    }),
  ];
}

const here = { workspaceId: "w1", boardId: "b1" };
const ids = (hits: { entry: SearchEntry }[]) => hits.map((hit) => hit.entry.id);

describe("条目的建立", () => {
  const entries = fixture();

  it("节点按类型取图标，终端带 agent 用 agent 图标", () => {
    const built = documentEntries({
      workspace: alpha,
      board: { id: "b1", name: "x" },
      nodes: [
        sticky("a", "s", ""),
        node("b", "t", { kind: "terminal", agent: { id: "claude" } } as never),
        node("c", "g", { kind: "group" }),
        node("d", "e", { kind: "editor", path: "a.ts" }),
        node("e", "d", { kind: "diff", repoPath: "/r", scope: "worktree" }),
        node("f", "f", { kind: "files", path: "/" }),
        node("g", "b", { kind: "browser", url: "" }),
      ],
      whiteboard: null,
    });
    expect(built.map((entry) => entry.icon)).toEqual([
      "sticky",
      "agent",
      "group",
      "editor",
      "diff",
      "files",
      "browser",
    ]);
  });

  it("白板对象：文字、形状标签、图片说明各自成条，空文字不建", () => {
    const items = entries.filter((entry) => entry.kind === "item");
    expect(items.map((entry) => entry.icon)).toEqual([
      "text",
      "shape",
      "image",
      "text",
    ]);
    const empty = documentEntries({
      workspace: alpha,
      board: { id: "b1", name: "x" },
      nodes: [],
      whiteboard: whiteboard([{ id: "e", text: "  " }]),
    });
    expect(empty).toHaveLength(0);
  });

  it("白板对象的 id 带 wb: 前缀，标题取第一行", () => {
    const item = entries.find((entry) => entry.title === "限流策略");
    expect(item?.targetId).toBe("wb:i4");
    expect(item?.detail).toContain("第二行说明");
  });
});

describe("按查询找", () => {
  const entries = fixture();

  it("别的工作空间里的画布按名字找得到，次要字段是工作空间名", () => {
    const groups = searchEntries(entries, "接口", here);
    expect(ids(groups.boards)).toEqual(["board:w2:b3"]);
    expect(groups.boards[0]!.entry.workspaceName).toBe("后端服务");
  });

  it("工作空间可以按名字与拼音首字母找到", () => {
    expect(ids(searchEntries(entries, "后端", here).workspaces)).toEqual([
      "workspace:w2",
    ]);
    expect(ids(searchEntries(entries, "sjg", here).workspaces)).toEqual([
      "workspace:w1",
    ]);
  });

  it("画布可以用拼音首字母找", () => {
    expect(ids(searchEntries(entries, "sygb", here).boards)).toEqual([
      "board:w1:b1",
    ]);
    expect(ids(searchEntries(entries, "zjk", here).boards)).toEqual([
      "board:w1:b2",
    ]);
    expect(ids(searchEntries(entries, "syc", here).boards)).toEqual([]);
  });

  it("便签正文命中：节点组，带围绕命中处的摘要", () => {
    const groups = searchEntries(entries, "横幅", here);
    expect(ids(groups.nodes)).toEqual(["node:w1:b1:n2"]);
    expect(groups.nodes[0]!.snippet).toContain("横幅");
  });

  it("路径、网址、目录也能找到节点", () => {
    expect(ids(searchEntries(entries, "button.tsx", here).nodes)).toContain(
      "node:w2:b3:n4",
    );
    expect(ids(searchEntries(entries, "docs.example", here).nodes)).toEqual([
      "node:w2:b3:n5",
    ]);
    expect(ids(searchEntries(entries, "/srv/api", here).nodes)).toEqual([
      "node:w2:b3:n6",
    ]);
  });

  it("Frame 按标题找（group 节点）", () => {
    const groups = searchEntries(entries, "导航栏", here);
    expect(groups.nodes[0]!.entry.icon).toBe("group");
  });

  it("白板内容：文字、形状标签、图片说明，命中后面的行也有摘要", () => {
    expect(ids(searchEntries(entries, "英雄区", here).items)).toEqual([
      "item:w1:b1:i1",
    ]);
    expect(ids(searchEntries(entries, "按钮状态", here).items)).toEqual([
      "item:w1:b1:i2",
    ]);
    expect(ids(searchEntries(entries, "登录页", here).items)).toEqual([
      "item:w1:b1:i3",
    ]);
    const deep = searchEntries(entries, "第二行", here).items;
    expect(ids(deep)).toEqual(["item:w2:b3:i4"]);
    expect(deep[0]!.snippet).toContain("第二行说明");
  });

  it("单行白板文字靠拼音命中时，摘要与标题相同就不重复", () => {
    const hit = searchEntries(entries, "yxq", here).items[0];
    expect(hit?.entry.title).toBe("首页英雄区文案");
    expect(hit?.snippet).toBeUndefined();
  });

  it("多个词都要命中", () => {
    expect(ids(searchEntries(entries, "tmux 导出", here).nodes)).toEqual([
      "node:w1:b1:n2",
    ]);
    expect(ids(searchEntries(entries, "tmux 路径", here).nodes)).toEqual([]);
  });

  it("模糊：中间缺字也能找到", () => {
    expect(ids(searchEntries(entries, "btn.tsx", here).nodes)).toContain(
      "node:w2:b3:n4",
    );
    expect(ids(searchEntries(entries, "qzxv", here).nodes)).toEqual([]);
    expect(ids(searchEntries(entries, "bttn", here).nodes)).toContain(
      "node:w2:b3:n4",
    );
  });

  it("同一块画布里的结果同分时排在前面", () => {
    const both = [
      ...documentEntries({
        workspace: alpha,
        board: { id: "b1", name: "首页改版" },
        nodes: [terminal("x1", "构建")],
        whiteboard: null,
      }),
      ...documentEntries({
        workspace: alpha,
        board: { id: "b2", name: "组件库" },
        nodes: [terminal("x2", "构建")],
        whiteboard: null,
      }),
    ];
    const first = searchEntries(both, "构建", {
      workspaceId: "w1",
      boardId: "b2",
    }).nodes[0]!;
    expect(first.entry.id).toBe("node:w1:b2:x2");
  });

  it("每组按上限截断，且得分高的先留下", () => {
    const many = documentEntries({
      workspace: alpha,
      board: { id: "b1", name: "x" },
      nodes: [
        ...Array.from({ length: 30 }, (_, index) =>
          terminal(`t${index}`, `终端 ${index}`),
        ),
        terminal("exact", "终端"),
      ],
      whiteboard: null,
    });
    const nodes = searchEntries(many, "终端", here, 5).nodes;
    expect(nodes).toHaveLength(5);
    expect(nodes[0]!.entry.title).toBe("终端");
  });
});

describe("空查询", () => {
  const entries = fixture();

  it("列工作空间与画布（当前工作空间的画布在前），节点只列当前画布，白板对象不列", () => {
    const groups = searchEntries(entries, "", {
      workspaceId: "w2",
      boardId: "b3",
    });
    expect(ids(groups.boards)).toEqual([
      "board:w2:b3",
      "board:w1:b1",
      "board:w1:b2",
    ]);
    expect(ids(groups.nodes)).toEqual([
      "node:w2:b3:n4",
      "node:w2:b3:n5",
      "node:w2:b3:n6",
    ]);
    expect(groups.items).toEqual([]);
    expect(groups.workspaces).toHaveLength(2);
  });
});

describe("长列表", () => {
  it("两万个节点上一次查询在几百毫秒内完成，且每组只返回上限条", () => {
    const nodes = Array.from({ length: 20_000 }, (_, index) =>
      sticky(
        `s${index}`,
        `便签 ${index}`,
        `第 ${index} 条记录的正文，写得稍微长一点`,
      ),
    );
    const entries = documentEntries({
      workspace: alpha,
      board: { id: "b1", name: "大画布" },
      nodes,
      whiteboard: null,
    });
    const started = performance.now();
    const groups = searchEntries(entries, "记录 正文 1999", here);
    const elapsed = performance.now() - started;
    expect(groups.nodes.length).toBeLessThanOrEqual(8);
    expect(groups.nodes[0]!.entry.title).toContain("1999");
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe("excerpt", () => {
  it("短正文原样返回，空白压成单个空格", () => {
    expect(excerpt("一行\n  两行", [])).toBe("一行 两行");
  });

  it("围绕第一个命中的词截一段，两端加省略号", () => {
    const text = `${"前文".repeat(40)}目标词${"后文".repeat(40)}`;
    const out = excerpt(text, ["目标词"], 30);
    expect(out).toContain("目标词");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("没命中时截开头", () => {
    const out = excerpt("甲".repeat(100), ["乙"], 20);
    expect(out).toBe(`${"甲".repeat(20)}…`);
  });
});
