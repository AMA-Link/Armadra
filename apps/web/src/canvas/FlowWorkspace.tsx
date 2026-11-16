import * as React from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow,
} from "@xyflow/react";
import type { BoardDocument } from "@armadra/shared";
import "@xyflow/react/dist/style.css";
import "../styles/canvas.css";
import { useCanvasReadOnly } from "../store/canvas/presence";
import { CanvasTopBar } from "./share/CanvasTopBar";
import { CursorLayer } from "../realtime/CursorLayer";
import { followMoveHandlers, stopFollowing } from "../realtime/session";
import { CommentLayer } from "../realtime/comments/CommentLayer";

import { ContextMenu, ContextMenuTrigger } from "@/ui/context-menu";
import { useT } from "@/app/preferences-store";
import { usePreferencesStore, useResolvedTheme } from "@/app/preferences-store";
import { canvasColorScheme } from "@/app/use-canvas-preferences";
import { useBoardAutosave } from "@/save/autosave";
import { useCanvasStore } from "@/store/canvas-store";
import { setCanvasLocked, useCanvasLocked } from "./canvas-lock";
import {
  registerWorkspaceCommands,
  useCanvasDelete,
} from "./workspace-commands";
import { useCreatedNodeReveal } from "./created-node";
import { registerEscapeToSelect } from "./escape-to-select";
import { installTouchCreate } from "./interaction/touch-create";
import { usePublishContextLinks } from "./context-links";
import { useOsDrop, usePasteToCanvas } from "./dnd/os-drop";
import { flowOptions } from "./flow/flow-options";
import {
  CENTER_NODE_EVENT,
  setFlow,
  setFlowContainer,
} from "./flow/flow-context";
import { clearAllDrafts } from "./flow/drafts";
import ConnectionLine from "./flow/edges/ConnectionLine";
import { edgeTypes } from "./flow/edges/edge-types";
import { nodeTypes } from "./flow/nodes/node-types";
import { useFlowNodes } from "./flow/use-flow-nodes";
import {
  applyBoardViewport,
  centerOnNode,
  useViewportSync,
} from "./flow/use-flow-viewport";
import { setTool, useTool } from "./interaction/tool-store";
import {
  CONNECTION_RADIUS,
  DELETE_KEY_CODE,
  NODE_DRAG_THRESHOLD,
  SELECTION_KEY_CODE,
} from "./interaction/keyboard";
import { useCanvasMenus } from "./menus/CanvasMenus";
import { Minimap } from "./flow/Minimap";
import { FlowStagePublisher } from "./flow/FlowStagePublisher";
import { CanvasOverlays } from "./flow/overlays/CanvasOverlays";
import { CanvasStylePanel } from "./StylePanel";
import { ToolLayer } from "./whiteboard/tools/ToolLayer";
import { resetProjectionCache } from "./sync/project";
import { MAX_ZOOM, MIN_ZOOM } from "./zoom";
import { useLayoutDirectionSync } from "./layout-direction";
import { useConnectEndSpawn } from "./flow/use-connect-end";
import { isZoomWheel, zoomCanvasByWheel } from "./interaction/wheel-zoom";

/**
 * 画布本体（React Flow 计划 §2.1）。
 *
 * `canvas-store` 是唯一内存真相；React Flow 是受控视图。这个组件只负责
 * 装配——把投影与回调接上（`flow/use-flow-nodes.ts`）、把实例交给
 * `flow/flow-context`、把命令表、右键菜单、自动保存、拖放、视口恢复接回来。
 *
 * §5.3 的四个挂载点在这里：`nodeTypes` / `edgeTypes` 两个常量文件、
 * `<ToolLayer />` 与 `<CanvasMenus />` 两个插槽、`onBoardOpened(document)`
 * 钩子。后面几批只碰那四处，不改这个文件。
 */

/**
 * 打开一块画布时跑一次的钩子（§5.3 的挂载点）。
 *
 * B1–B5 需要在开板时初始化什么（缩略图、内容引用的缓存…）就往这里加，
 * 不必改 `FlowWorkspace` 的其它部分。B0 只做视口恢复。
 */
function onBoardOpened(document: BoardDocument): void {
  applyBoardViewport(document);
}

const ATTRIBUTION = { hideAttribution: true } as const;

/**
 * **画布自己订阅，不跟着应用壳重渲。**
 *
 * `AppShell` 里挂着一排查询与事件订阅：一次会话结束会让 `sessions` /
 * `git-status` / `board` 几个查询接连失效，实测一次会话状态跳动里 `AppShell`
 * 为根的重渲有四次、每次约 1,045 个组件，而画布这一整棵子树就在里面
 * （`docs/status/canvas-performance-baseline.md`）。
 *
 * 它一个 prop 都不收，所以 `memo` 是一道干净的墙：壳自己重渲多少次都到此为
 * 止，画布只在它订阅的 store 真的变了的时候重画。
 */
export const FlowWorkspace = React.memo(function FlowWorkspace() {
  // provider 跟着旧引擎走（`useReactFlow` 要它），不在应用根上（B4：外面不再认 React Flow）。
  return (
    <ReactFlowProvider>
      <FlowWorkspaceInner />
    </ReactFlowProvider>
  );
});

function FlowWorkspaceInner() {
  const t = useT();
  const flow = useReactFlow();
  const theme = useResolvedTheme();
  const preferences = usePreferencesStore((state) => state.whiteboard);
  // 锁定状态住在 `canvas-lock.ts`：Dock 的工具组在这棵树之外，要一起读。
  const locked = useCanvasLocked();
  const { requestDelete, dialog } = useCanvasDelete();
  const container = React.useRef<HTMLDivElement>(null);
  // ⌘ / Ctrl + 滚轮在画布任何地方都是缩放，自己在捕获阶段算，不靠 React Flow
  // 的 `useKeyPress`：焦点落在终端或 webview 里时它收不到 keydown，于是
  // Ctrl + 滚轮变成了平移（用户反馈 2026-09-22）。原生监听而不是 React 的
  // `onWheel`：后者是被动的，`preventDefault` 拦不住页面缩放。
  React.useEffect(() => {
    const stage = container.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!isZoomWheel(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // 自己缩放走的是程序化 `setViewport`，`onMove` 认不出是人动的。
      if (zoomCanvasByWheel(event)) stopFollowing();
    };
    stage.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => stage.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  const flowBindings = useFlowNodes();
  // 从 Agent 把手拖到空白处松手 = 在落点开「派发」菜单（ui-wave2 §6.3）。
  const { onConnectEnd: spawnOnDrop, menu: spawnMenu } = useConnectEndSpawn();
  const bindings = React.useMemo(
    () => ({
      ...flowBindings,
      onConnectEnd: (
        event: MouseEvent | TouchEvent,
        connection: Parameters<typeof flowBindings.onConnectEnd>[1],
      ) => {
        flowBindings.onConnectEnd(event, connection);
        spawnOnDrop(event, connection);
      },
    }),
    [flowBindings, spawnOnDrop],
  );
  // 布局方向（契约 §50）：派发线的走向、整理与「派生」的落点都读它。
  useLayoutDirectionSync();
  // 右键菜单插槽（§5.3）：`handlers` 摊给 `<ReactFlow>`，`menus` 摆在
  // 触发器后面。四种菜单的分流与目标状态都在 `menus/CanvasMenus.tsx`。
  const { handlers: menuHandlers, menus } = useCanvasMenus();
  useViewportSync();
  useBoardAutosave();
  usePasteToCanvas();
  usePublishContextLinks();
  // Agent 用控制动词建的节点也要被送到眼前，和菜单里建的一样（`created-node.ts`）。
  useCreatedNodeReveal();
  const { onDragOver, onDrop } = useOsDrop();

  /* ------------------------------ 生命周期 -------------------------------- */

  React.useEffect(() => {
    setFlow(flow);
    setFlowContainer(container.current);
    const offEscape = container.current
      ? registerEscapeToSelect({ container: container.current })
      : () => {};
    // 触屏上空白处长按 / 双击 = 在那一点右键，出同一个新建菜单（#715）。
    const offTouchCreate = container.current
      ? installTouchCreate(container.current)
      : () => {};
    return () => {
      offEscape();
      offTouchCreate();
      setFlow(null);
      setFlowContainer(null);
      clearAllDrafts();
      resetProjectionCache();
      // 画布卸载时把锁一起解开，换画布不会带着上一块的锁定状态。
      setCanvasLocked(false);
    };
  }, [flow]);

  /** 开板一次：视口恢复（`board.id` 变了才算换了一块板）。 */
  const boardId = useCanvasStore((state) => state.document?.board.id);
  const document = useCanvasStore((state) => state.document);
  const opened = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!document || !boardId || opened.current === boardId) return;
    opened.current = boardId;
    onBoardOpened(document);
  }, [boardId, document]);

  /** 锁上之后正在用的白板工具也要退回选择，否则还能继续画。 */
  React.useEffect(() => {
    if (locked) setTool("select");
  }, [locked]);

  /* ------------------------------ 命令 ----------------------------------- */

  React.useEffect(
    () =>
      registerWorkspaceCommands({
        container: () => container.current,
        requestDelete,
      }),
    [flow, requestDelete],
  );

  React.useEffect(() => {
    const onCenter = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      if (nodeId) centerOnNode(nodeId);
    };
    window.addEventListener(CENTER_NODE_EVENT, onCenter);
    return () => window.removeEventListener(CENTER_NODE_EVENT, onCenter);
  }, []);

  /* ------------------------------ 渲染 ------------------------------------ */

  // 手形工具改 `panOnDrag` / `selectionOnDrag` / `nodesDraggable` 三项
  // （`flow-options`），所以当前工具也是这张表的输入。
  const tool = useTool();
  // 编辑租约在别的设备手里（core JSON §9）：拖、连都关掉，平移缩放照旧。
  // store 的 commit 入口也会拦，这里是让手势一开始就不发生。
  const readOnly = useCanvasReadOnly();
  const options = React.useMemo(
    () => flowOptions({ whiteboard: preferences, locked, tool, readOnly }),
    [locked, preferences, readOnly, tool],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={container}
          // 壳给的容器是 `relative flex-1` 但不是 flex 容器，所以这里必须
          // 自己撑满（只写 flex-1 会塌成 0 高，画布整块看不见）。
          className="canvas-stage relative h-full w-full min-h-0 min-w-0 flex-1"
          style={{ background: "var(--canvas-bg)" }}
          onDragOverCapture={onDragOver}
          onDropCapture={onDrop}
          aria-label={t("canvas.label")}
        >
          <ReactFlow
            {...bindings}
            {...options}
            // 右下角的「React Flow」链接不显示（2026-09-14 反馈）。MIT 许可
            // 不要求它；React Flow 只对商业项目提出订阅 Pro 的请求，与此无关。
            proOptions={ATTRIBUTION}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={canvasColorScheme(preferences.background, theme)}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            // 终端不能卸载：xterm 的 `fit()` 一旦量到 0×0，回到视口时
            // 行列数就错了（F01）。
            onlyRenderVisibleElements={false}
            // 全应用只有 `keybindings.ts` 一个键盘监听器（F13）。
            deleteKeyCode={DELETE_KEY_CODE}
            selectionKeyCode={SELECTION_KEY_CODE}
            nodeDragThreshold={NODE_DRAG_THRESHOLD}
            connectionRadius={CONNECTION_RADIUS}
            connectionMode={ConnectionMode.Loose}
            // 选中一个终端不该让它压过别人（§2.4）。
            elevateNodesOnSelect={false}
            // 方向键归 `canvas.focus*`，Tab 循环焦点会和节点体抢。
            disableKeyboardA11y
            {...menuHandlers}
            // 自己拖动、滚轮或捏合移动视口就不再跟随别人（#327）。
            {...followMoveHandlers}
            // 预览线与落成后的边共用同一条贝塞尔（§2.5，B1）。
            connectionLineComponent={ConnectionLine}
          >
            {preferences.grid ? (
              <Background
                variant={BackgroundVariant.Dots}
                gap={preferences.gridSize}
                color="var(--canvas-dot)"
              />
            ) : null}
            {/* 派生层（rope / 子代理卡片）：坐标是画布坐标，
                `<ViewportPortal>` 已经替我们做完相机变换（F07）。 */}
            {/* 状态缩略图（F20，B1）。它是 `<Panel>`，位置在 canvas.css 里。 */}
            <Minimap />
            <FlowStagePublisher />
            <ViewportPortal>
              <CanvasOverlays />
              {/* 实时板上别人的光标与选区（补全架构 §6.4）；非实时板不画。 */}
              <CursorLayer />
              {/* 评论钉与评论模式（契约 §16.3）；任何板都有。 */}
              <CommentLayer />
            </ViewportPortal>
            {/* 白板工具覆盖层（`whiteboard/tools/ToolLayer.tsx`）。 */}
            <ToolLayer />
          </ReactFlow>
          <CanvasStylePanel />
          <CanvasTopBar />
        </div>
      </ContextMenuTrigger>

      {menus}
      {spawnMenu}

      {dialog}
    </ContextMenu>
  );
}
