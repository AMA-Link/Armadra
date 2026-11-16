import * as React from "react";
import type { CanvasNode } from "@armadra/shared";
import { createBoard } from "@armadra/board/dom";
import { BoardView, EntityHosts, WorldOverlay } from "@armadra/board/react";

import {
  useT,
  usePreferencesStore,
  useResolvedTheme,
} from "@/app/preferences-store";
import { useBoardAutosave } from "@/save/autosave";
import { stopFollowing } from "@/realtime/session";
import { ContextMenu, ContextMenuTrigger } from "@/ui/context-menu";
import { useCanvasStore } from "@/store/canvas-store";
import { useCanvasReadOnly } from "@/store/canvas/presence";
import { setCanvasLocked, useCanvasLocked } from "../canvas-lock";
import { useCreatedNodeReveal } from "../created-node";
import { usePublishContextLinks } from "../context-links";
import { useOsDrop, usePasteToCanvas } from "../dnd/os-drop";
import { registerEscapeToSelect } from "../escape-to-select";
import {
  CENTER_NODE_EVENT,
  setFlow,
  setFlowContainer,
} from "../flow/flow-context";
import { publishStageView } from "../flow/stage-view";
import { clearAllDrafts } from "../flow/drafts";
import { applyBoardViewport, centerOnNode } from "../flow/use-flow-viewport";
import { CanvasOverlays } from "../flow/overlays/CanvasOverlays";
import { CursorLayer } from "../../realtime/CursorLayer";
import { CommentLayer } from "../../realtime/comments/CommentLayer";
import { setTool, useTool } from "../interaction/tool-store";
import { useLayoutDirectionSync } from "../layout-direction";
import { useCanvasMenus } from "../menus/CanvasMenus";
import { CanvasStylePanel } from "../StylePanel";
import { CanvasTopBar } from "../share/CanvasTopBar";
import { MAX_ZOOM, MIN_ZOOM } from "../zoom";
import {
  registerWorkspaceCommands,
  useCanvasDelete,
} from "../workspace-commands";
import { createBoardAdapter } from "./board-adapter";
import { createBoardEdgeAdapter } from "./edge-adapter";
import { BoardEdges } from "./BoardEdges";
import { BoardMinimap } from "./BoardMinimap";
import { useEdgePointer } from "./use-edge-pointer";
import { BoardConnectionLine } from "./connect-preview";
import { useBoardConnect } from "./use-board-connect";
import { createBoardFlowHandle } from "./flow-handle";
import { renderEntity } from "./hosts";
import { BOARD_SELECTORS, nodeKinds } from "./model";
import { useBoardViewportSync } from "./use-board-viewport";
import { BoardToolLayer } from "./whiteboard/BoardToolLayer";
import { whiteboardKinds } from "./whiteboard/kinds";
import { boardColor, boardImage } from "./whiteboard/paint-env";
import { createWhiteboardSync } from "./whiteboard/sync";
import { createBoardTool } from "./whiteboard/tools";
import { itemAtEvent } from "./whiteboard/interactions";

/**
 * 自研画板引擎的画布（`canvas.engine = "next"`，docs/design/board-engine.md §6.1 B3）。
 *
 * 与 `FlowWorkspace` 并存、读写同一个 `canvas-store`，切换不丢数据。B3 只接节点与
 * 分组：宿主、选择、拖动、换父、缩放、视口、锁定、只读、右键菜单；连线、白板对象、
 * 缩略图与协作光标属于 B4 / B5，`next` 下暂不显示。
 *
 * 和旧画布共用的那部分（命令表、删除确认、自动保存、粘贴 / 拖放、右键菜单内容、
 * 新建节点后的相机）原样复用，不抄一份。
 */
export const BoardWorkspace = React.memo(BoardWorkspaceInner);

const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], .xterm'),
  );

function BoardWorkspaceInner() {
  const t = useT();
  const theme = useResolvedTheme();
  const preferences = usePreferencesStore((state) => state.whiteboard);
  const locked = useCanvasLocked();
  const readOnly = useCanvasReadOnly();
  const tool = useTool();
  const stage = React.useRef<HTMLDivElement>(null);
  const { requestDelete, dialog } = useCanvasDelete();
  const { handlers: menuHandlers, menus } = useCanvasMenus();

  const board = React.useMemo(
    () =>
      createBoard<CanvasNode>({
        kinds: { ...nodeKinds(), ...whiteboardKinds() },
        color: boardColor,
        image: boardImage,
        selectors: BOARD_SELECTORS,
        // 右键菜单是应用的（Radix）：引擎只发事件，不拦原生 contextmenu。
        nativeContextMenu: true,
        camera: useCanvasStore.getState().document?.board.viewport,
      }),
    [],
  );

  const edgePointer = useEdgePointer(board, stage);
  const spawnMenu = useBoardConnect(board, stage);
  useLayoutDirectionSync();
  useBoardViewportSync(board);
  useBoardAutosave();
  usePasteToCanvas();
  usePublishContextLinks();
  useCreatedNodeReveal();
  const { onDragOver, onDrop } = useOsDrop();

  /* ------------------------------ 生命周期 -------------------------------- */

  React.useEffect(() => {
    const element = stage.current;
    // 白板对象的同步先于节点适配器：二者监听同一个 move 事件，先后顺序决定历史能否合并。
    const whiteboard = createWhiteboardSync(board);
    const adapter = createBoardAdapter(board);
    const edgeAdapter = createBoardEdgeAdapter(board);
    setFlow(createBoardFlowHandle(board, () => stage.current));
    setFlowContainer(element);
    const publish = () => {
      const { x, y, zoom } = board.camera.get();
      publishStageView({
        x,
        y,
        zoom,
        width: element?.clientWidth ?? 0,
        height: element?.clientHeight ?? 0,
      });
    };
    publish();
    const stopZoom = board.on("camera", publish);
    const resize =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(publish)
        : null;
    if (element) resize?.observe(element);
    const offEscape = element
      ? registerEscapeToSelect({ container: element })
      : () => {};
    return () => {
      offEscape();
      stopZoom();
      resize?.disconnect();
      publishStageView(null);
      adapter.destroy();
      whiteboard.destroy();
      edgeAdapter.destroy();
      setFlow(null);
      setFlowContainer(null);
      clearAllDrafts();
      setCanvasLocked(false);
    };
  }, [board]);

  /** 开板一次：视口恢复（`board.id` 变了才算换了一块板）。 */
  // 只订板 id：订整份 document 会让每次平移（视口回写）都重渲整个画布。
  const boardId = useCanvasStore((state) => state.document?.board.id);
  const opened = React.useRef<string | null>(null);
  React.useEffect(() => {
    const document = useCanvasStore.getState().document;
    if (!document || !boardId || opened.current === boardId) return;
    opened.current = boardId;
    applyBoardViewport(document);
  }, [boardId]);

  /** 锁上之后正在用的白板工具也要退回选择。 */
  React.useEffect(() => {
    if (locked) setTool("select");
  }, [locked]);

  /* ------------------------------ 偏好与工具 ------------------------------ */

  React.useEffect(() => {
    board.setOptions({
      grid: preferences.snap ? preferences.gridSize : 0,
      marqueeContain: preferences.wrap,
      inputDevice: preferences.inputMode === "mouse" ? "mouse" : "trackpad",
      readOnly,
      dots: preferences.grid,
      theme,
    });
  }, [board, preferences, readOnly, theme]);

  React.useEffect(() => {
    board.camera.locked = locked;
    board.camera.limits = { min: MIN_ZOOM, max: MAX_ZOOM };
  }, [board, locked]);

  React.useEffect(() => {
    board.setTool(createBoardTool(locked ? "select" : tool, board));
  }, [board, locked, tool]);

  /** 空格 + 拖动平移：空格是修饰键，由键盘层写给引擎（文字输入里不算）。 */
  React.useEffect(() => {
    const set = (space: boolean) => (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTextEntry(event.target)) return;
      board.setModifiers({ space });
    };
    const down = set(true);
    const up = set(false);
    const clear = () => board.setModifiers({ space: false });
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, [board]);

  /* ------------------------------ 命令 ----------------------------------- */

  React.useEffect(
    () =>
      registerWorkspaceCommands({
        container: () => stage.current,
        requestDelete,
      }),
    [requestDelete],
  );

  React.useEffect(() => {
    const onCenter = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId: string }>).detail?.nodeId;
      if (nodeId) centerOnNode(nodeId);
    };
    window.addEventListener(CENTER_NODE_EVENT, onCenter);
    return () => window.removeEventListener(CENTER_NODE_EVENT, onCenter);
  }, []);

  /* ------------------------------ 指针与菜单 ------------------------------ */

  /**
   * 节点体里按下（终端、编辑器、网页）引擎放手，让它们自己拿焦点；但点一下体就把
   * 节点选中是现有的约定（React Flow 版本里 §1.3 有意为之），这里补上。
   */
  const onPointerDownCapture = React.useCallback(
    (event: React.PointerEvent) => {
      const target = event.target as Element;
      // 点空白：引擎接管了这一下（不会让焦点自己离开终端 / 编辑器），手动放掉。
      if (target.hasAttribute("data-board-stage")) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) {
          active.blur();
        }
      }
      // 空白处按在连线上：选中连线，引擎不再看见这次按下（不会开始框选）。
      if (edgePointer.press(event)) {
        event.stopPropagation();
        return;
      }
      if (event.button !== 0 || readOnly) return;
      const host = target.closest("[data-board-id]");
      const id = host?.getAttribute("data-board-id");
      if (!id || !target.closest(BOARD_SELECTORS.editable)) return;
      const state = useCanvasStore.getState();
      const current = state.selectedNodeIds;
      if (event.shiftKey) {
        state.setSelection({
          nodes: current.includes(id)
            ? current.filter((other) => other !== id)
            : [...current, id],
          edges: [],
          items: [],
        });
      } else if (!current.includes(id) || current.length > 1) {
        state.setSelection({ nodes: [id], edges: [], items: [] });
      }
    },
    [readOnly, edgePointer],
  );

  const onContextMenuCapture = React.useCallback(
    (event: React.MouseEvent) => {
      const host = (event.target as Element).closest("[data-board-id]");
      const id =
        (stage.current && itemAtEvent(board, event, stage.current)) ??
        host?.getAttribute("data-board-id");
      const edge = id ? null : edgePointer.edgeAt(event.clientX, event.clientY);
      if (id) menuHandlers.onNodeContextMenu(event, { id } as never);
      else if (edge) menuHandlers.onEdgeContextMenu(event, { id: edge });
      else menuHandlers.onPaneContextMenu(event);
    },
    [board, menuHandlers, edgePointer],
  );

  /** 滚轮移动相机就不再跟随别人；锁定时滚轮不动相机，也就不取消。 */
  const onWheelCapture = React.useCallback(() => {
    if (!locked) stopFollowing();
  }, [locked]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={stage}
          // 壳给的容器是 `relative flex-1` 但不是 flex 容器，所以这里必须自己撑满。
          className="canvas-stage relative h-full w-full min-h-0 min-w-0 flex-1"
          data-engine="next"
          style={{ background: "var(--canvas-bg)" }}
          onDragOverCapture={onDragOver}
          onDropCapture={onDrop}
          onPointerDownCapture={onPointerDownCapture}
          onContextMenuCapture={onContextMenuCapture}
          onWheelCapture={onWheelCapture}
          aria-label={t("canvas.label")}
        >
          <BoardView
            board={board}
            className="absolute inset-0"
            data-board-stage=""
          >
            <EntityHosts<CanvasNode> render={renderEntity} />
            <BoardToolLayer />
            <BoardEdges />
            <BoardConnectionLine />
            {/* 派生层、他人光标与选区、评论钉：世界坐标，跟相机同一个变换。 */}
            <WorldOverlay>
              <CanvasOverlays />
              <CursorLayer />
              <CommentLayer />
            </WorldOverlay>
          </BoardView>
          <BoardMinimap board={board} />
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
