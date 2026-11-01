import type { CanvasNodeData, CanvasNodeType, Size } from "@armadra/shared";
import { t, usePreferencesStore } from "../app/preferences-store";
import { NODE_TEXT_PX, fitNewNodeSize } from "../canvas/first-display";
import { containerSize } from "../canvas/flow/flow-context";
import { nodeMeta } from "../nodes/registry";
import { isCompactLayout } from "../platform/layout";

/**
 * 新建节点时的默认值 —— docs/contracts/v3-agent-terminal-plan.md §3.4。
 *
 * 尺寸 / 颜色 / 标签的唯一真相是 `nodes/registry.ts` 的 `nodeMeta()`（归属
 * nodes agent），这里只做转发，绝不复制那张表——两处各写一份尺寸是上一版
 * 「节点尺寸对不上」的根因。
 *
 * ⚠ 所有查表都发生在函数体里而不是模块顶层：`store → nodes/registry →
 * NodeShell → store` 是一个合法的 ESM 环，顶层求值会拿到未初始化的绑定。
 */

/**
 * 浏览器节点的默认页：Google 搜索。裸 `google.com` 带 `X-Frame-Options:
 * SAMEORIGIN`，在 iframe 里一片空白；`webhp?igu=1` 是 Google 自己保留的可嵌入
 * 入口（实测无 frame 限制），从它发起的搜索会带着 `igu=1` 一路可见。
 */
export const DEFAULT_BROWSER_URL = "https://www.google.com/webhp?igu=1";

/**
 * 占位引用（自动化设计 §3）。计划卡片与活动卡片都必须指向真实的对象，
 * 所以它们没有「空默认值」：调用方必须覆盖，这两个常量只是为了让
 * `defaultNodeData` 对每种类型都有返回值，本身永远不该被保存下来。
 */
const PLACEHOLDER_REFERENCE = "unbound";
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

export { COLLAPSED_HEIGHT } from "../nodes/geometry";

export function defaultNodeSize(type: CanvasNodeType): Size {
  return { ...nodeMeta(type).defaultSize };
}

export function minNodeSize(type: CanvasNodeType): Size {
  return { ...nodeMeta(type).minSize };
}

/**
 * 这种节点里最小正文的字号（px）：都是 `--text-meta`，终端跟着自己的字号偏
 * 好（可调到 10）。字号下限（字号 × 缩放 ≥ 12px）按它算。
 */
export function nodeFontPx(type: CanvasNodeType): number {
  return type === "terminal"
    ? Math.min(NODE_TEXT_PX, usePreferencesStore.getState().terminal.fontSize)
    : NODE_TEXT_PX;
}

/**
 * **新建**时的尺寸（#684）：默认的黄金比例尺寸；手机（紧凑布局，横竖屏）上
 * 在字号下限的缩放下装不进视口时，等比缩小到装得下。已保存节点的尺寸不经过
 * 这里。
 */
export function newNodeSize(type: CanvasNodeType): Size {
  const size = defaultNodeSize(type);
  if (!isCompactLayout()) return size;
  return fitNewNodeSize({
    size,
    min: minNodeSize(type),
    container: containerSize(),
    fontPx: nodeFontPx(type),
  });
}

export function defaultNodeColor(type: CanvasNodeType): string {
  return nodeMeta(type).defaultColor;
}

/**
 * 头部标题的默认值；用户随时可以改写。
 *
 * 标题一旦写进文档就是用户数据，所以在这里按**当时**的语言定死，
 * 之后切语言不会把已有节点的标题改掉。
 */
export function defaultNodeTitle(type: CanvasNodeType): string {
  return t(nodeMeta(type).labelKey);
}

export interface NodeDataContext {
  /** 工作空间根目录：files / diff 节点的落点。 */
  workspaceRoot?: string;
}

/**
 * 每种节点的最小可用 data。调用方给的 `data` 会浅覆盖在它上面，
 * 所以「打开某个文件」只需要传 `{ path }`。
 */
export function defaultNodeData(
  type: CanvasNodeType,
  context: NodeDataContext = {},
): CanvasNodeData {
  const root = context.workspaceRoot?.trim() || ".";
  switch (type) {
    case "terminal":
      return { kind: "terminal" };
    case "sticky":
      return { kind: "sticky", content: "" };
    case "group":
      return { kind: "group" };
    case "editor":
      // `path` 是必填且非空；真实路径由打开文件的一方覆盖。
      return { kind: "editor", path: root };
    case "diff":
      return { kind: "diff", repoPath: root, scope: "worktree" };
    case "files":
      return { kind: "files", path: root };
    case "browser":
      return { kind: "browser", url: DEFAULT_BROWSER_URL };
    // 两张 Host 侧卡片没有「空可用值」：一张必须指向真实的 Host 计划，另一张
    // 必须指向被观察的节点，所以这里给的占位一定会被调用方覆盖，绝不落库。
    case "automation":
      return {
        kind: "automation",
        planId: PLACEHOLDER_REFERENCE,
        planWorkspaceId: PLACEHOLDER_REFERENCE,
        executionHostId: PLACEHOLDER_REFERENCE,
      };
    case "agentActivity":
      return {
        kind: "agentActivity",
        sourceNodeId: EMPTY_UUID,
        source: "loop",
        sessionId: "",
        executionHostId: "",
        generation: 0,
        nativeJobId: "",
      };
  }
}
