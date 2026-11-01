import { lazy, type ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CalendarClock,
  FileCode2,
  FolderTree,
  GitCompare,
  Globe,
  Group,
  StickyNote,
  Terminal,
} from "lucide-react";
import {
  DEFAULT_NODE_COLOR,
  defaultNodeSizeOf,
  minNodeSizeOf,
  type CanvasNode,
  type CanvasNodeType,
  type Size,
} from "@armadra/shared";

/**
 * 节点体按种类懒加载（§17「代码分割」）。
 *
 * 这张表以前是八条顶层 import，于是一块空画布也要把八种节点体全部加载：
 * 终端拖着 xterm（443 kB）、编辑器拖着 CodeMirror（862 kB）与语言服务
 * （153 kB）、对比拖着三方合并（834 kB）、便签拖着 react-markdown
 * （544 kB）——实测空闲时页面已加载 6.17 MB JS，其中这一段占 2.8 MB，而画
 * 布上一个节点都没有。
 *
 * `NODE_BODY[type]` 只在画布上真的有那一种节点时才被渲染，所以懒加载的边界
 * 就落在这里最自然。两个渲染点（`ArmadraNode`、`MobileFocusPage`）各自包了
 * `<Suspense fallback={null}>`：节点壳、头部、尺寸都是外面画的，等的只是壳
 * 里那一块，而它本来就要等自己的数据。
 *
 * `NODE_META` 不动：图标与尺寸是同步读的（新建节点要立刻知道默认大小），
 * 而 lucide 图标本来就在入口 chunk 里。
 */
function body<T extends string>(
  name: T,
  load: () => Promise<Record<T, ComponentType<NodeBodyProps>>>,
): ComponentType<NodeBodyProps> {
  return lazy<ComponentType<NodeBodyProps>>(() =>
    load().then((module) => ({ default: module[name] })),
  );
}

/* -------------------------------------------------------------------------- */
/* 契约（计划书 §13.2 / React Flow 计划 §2.2）                                  */
/* -------------------------------------------------------------------------- */

export interface NodeBodyProps {
  id: string;
  node: CanvasNode;
  selected: boolean;
  collapsed: boolean;
  focused: boolean;
}

export interface NodeMeta {
  /** i18n 键，不是文案：渲染时用 `useT()` 翻译，切语言立刻跟着变。 */
  labelKey: string;
  icon: LucideIcon;
  defaultSize: Size;
  minSize: Size;
  defaultColor: string;
  /**
   * 左右两侧的上下文链接把手。§21 起除了分组，**每种节点都有**：
   * 任意两个节点都能连线，连上之后 Agent 就能读对方的内容。
   */
  hasBridgeHandles: boolean;
}

/**
 * 头部拖拽把手。这个类名直接就是 React Flow 的 `dragHandle` 选择器
 * （`sync/project.ts` 投影时给的），所以「哪块能拖」只在这里定义一次。
 */
export const DRAG_HANDLE_CLASS = "drag-handle";
export const NODE_DRAG_HANDLE = `.${DRAG_HANDLE_CLASS}`;

export { COLLAPSED_HEIGHT, HEADER_HEIGHT } from "./geometry";

/** 便签的默认色 = 调色板里的黄（`--node-color-3`）。 */
const STICKY_COLOR = "#ffd60a";

/**
 * 分组由 `flow/nodes/GroupNode.tsx` 自己画，没有节点体。
 * 键保留只为让类型完备：漏登记一种新节点类型必须是编译错误。
 */
const GroupNodeBody: ComponentType<NodeBodyProps> = () => null;

/**
 * 尺寸由 `@armadra/shared` 的黄金比例生成函数给出（#684）：横向节点宽:高 =
 * φ:1，文件列表竖长取 1:φ，core 与页面共用同一张表。数字见计划书 §3.4，
 * `registry.test.ts` 逐条比对；改长边之前先改文档。
 *
 * 长边沿用 2026-09-19 那一轮定下的「内容自己的标准尺寸」（浏览器 1280、终端
 * 960，在 12px 字号下排得下约 120 列），只是短边按比例取。最小尺寸的长边取到
 * 每一条边都不比上一版的最小尺寸大（文件列表竖长，只能是高变大），所以已有
 * 画布里缩小过的节点不会因此低于新的下限。已保存节点的尺寸从不按这张表改写。
 */
export const NODE_META: Record<CanvasNodeType, NodeMeta> = {
  terminal: {
    labelKey: "node.terminal",
    icon: Terminal,
    defaultSize: defaultNodeSizeOf("terminal"),
    minSize: minNodeSizeOf("terminal"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  sticky: {
    labelKey: "node.sticky",
    icon: StickyNote,
    defaultSize: defaultNodeSizeOf("sticky"),
    minSize: minNodeSizeOf("sticky"),
    defaultColor: STICKY_COLOR,
    hasBridgeHandles: true,
  },
  group: {
    labelKey: "node.group",
    icon: Group,
    defaultSize: defaultNodeSizeOf("group"),
    minSize: minNodeSizeOf("group"),
    defaultColor: DEFAULT_NODE_COLOR,
    // frame 自己有标签与裁剪，把手在它身上没有意义。
    hasBridgeHandles: false,
  },
  editor: {
    labelKey: "node.editor",
    icon: FileCode2,
    defaultSize: defaultNodeSizeOf("editor"),
    minSize: minNodeSizeOf("editor"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  diff: {
    labelKey: "node.diff",
    icon: GitCompare,
    defaultSize: defaultNodeSizeOf("diff"),
    minSize: minNodeSizeOf("diff"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  files: {
    labelKey: "node.files",
    icon: FolderTree,
    defaultSize: defaultNodeSizeOf("files"),
    minSize: minNodeSizeOf("files"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  browser: {
    labelKey: "node.browser",
    icon: Globe,
    defaultSize: defaultNodeSizeOf("browser"),
    minSize: minNodeSizeOf("browser"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: true,
  },
  // 两张 Host 侧卡片：内容都从 Host 读，连线拿不到任何东西，所以不给把手。
  automation: {
    labelKey: "node.automation",
    icon: CalendarClock,
    defaultSize: defaultNodeSizeOf("automation"),
    minSize: minNodeSizeOf("automation"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: false,
  },
  agentActivity: {
    labelKey: "node.agentActivity",
    icon: Activity,
    defaultSize: defaultNodeSizeOf("agentActivity"),
    minSize: minNodeSizeOf("agentActivity"),
    defaultColor: DEFAULT_NODE_COLOR,
    hasBridgeHandles: false,
  },
};

export const NODE_BODY: Record<CanvasNodeType, ComponentType<NodeBodyProps>> = {
  terminal: body("TerminalNode", () => import("./TerminalNode")),
  sticky: body("StickyNode", () => import("./StickyNode")),
  group: GroupNodeBody,
  editor: body("EditorNode", () => import("./EditorNode")),
  diff: body("DiffNode", () => import("./DiffNode")),
  files: body("FilesNode", () => import("./FilesNode")),
  browser: body("BrowserNode", () => import("./browser")),
  automation: body("AutomationNode", () => import("./AutomationNode")),
  agentActivity: body("AgentActivityNode", () => import("./AgentActivityNode")),
};

/**
 * 这些类型自己渲染 `NodeShell`，`ArmadraShapeUtil` 不再包一层。
 *
 * 原因很实际：它们的头部按钮（中断 / 保存 / 刷新 / 面包屑 / 地址栏）
 * 的状态就住在节点体里，从外面包壳就得把状态再抬一层。便签没有头部插槽，
 * 走通用包壳。
 */
export const NODE_SHELL_SELF: ReadonlySet<CanvasNodeType> =
  new Set<CanvasNodeType>([
    "terminal",
    "editor",
    "diff",
    "files",
    "browser",
    "automation",
    "agentActivity",
  ]);

export function nodeMeta(type: CanvasNodeType): NodeMeta {
  return NODE_META[type];
}

export function defaultNodeSize(type: CanvasNodeType): Size {
  return nodeMeta(type).defaultSize;
}

export function minNodeSize(type: CanvasNodeType): Size {
  return nodeMeta(type).minSize;
}
