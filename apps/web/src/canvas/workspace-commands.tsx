import * as React from "react";
import type { CanvasNode } from "@armadra/shared";

import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/panels/ResponsiveDialog";
import { useT } from "@/app/preferences-store";
import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";
import { registerCanvasCommands, type CanvasCommandId } from "./commands";
import { isCanvasLocked } from "./canvas-lock";
import {
  fitView,
  centerOnNode,
  zoomByStep,
  zoomToLevel,
} from "./flow/use-flow-viewport";
import { getFlow } from "./flow/flow-context";
import { boundingBox, nearestInDirection, nodeBox, type Box } from "./geometry";
import { setTool } from "./interaction/tool-store";
import { selectAllCanvas } from "./select-all";
import { tidySelection } from "./tidy-flow";
import { layoutDirection } from "./layout-direction";
import {
  CANVAS_TOOLS,
  isToolDisabledWhenLocked,
  splitSelectionForDelete,
} from "./tools";
import { removeItems, removeReferences } from "./whiteboard/store";

/**
 * 画布命令表与删除确认（两种引擎共用）。
 *
 * 从 `FlowWorkspace` 原样搬出来：命令只依赖 `canvas-store`、`flow-context` 的
 * 视口句柄与容器，不依赖 React Flow，所以 `next` 引擎的 `BoardWorkspace`
 * 直接复用，不抄一份。
 */

/** 最大化时四周留出的边距（屏幕像素）。 */
export const MAXIMIZE_MARGIN = 24;

/** 删除节点前结束它的终端会话：否则 tmux 里会留下没人看的孤儿进程。 */
function endSessionsOf(nodeIds: readonly string[]): void {
  const document = useCanvasStore.getState().document;
  if (!document) return;
  for (const node of document.nodes) {
    if (!nodeIds.includes(node.id) || node.data.kind !== "terminal") continue;
    const sessionId = node.data.sessionId;
    if (!sessionId) continue;
    void sessionGateway
      .terminate(
        useCanvasStore.getState().workspace?.id ?? "",
        sessionId,
        "session",
      )
      .catch(() => {
        /* 会话可能早已结束；Runtime 的巡检会兜底 */
      });
  }
}

/** 选中项里有活着的会话吗？有就要先弹确认框。 */
function hasLiveSession(ids: readonly string[]): boolean {
  const nodes = useCanvasStore.getState().document?.nodes ?? [];
  return ids.some((id) => {
    const node = nodes.find((item) => item.id === id);
    return node?.data.kind === "terminal" && Boolean(node.data.sessionId);
  });
}

interface PendingDelete {
  nodes: string[];
  edges: string[];
}

/** 删除请求与「结束会话」确认框（两种引擎共用）。 */
export function useCanvasDelete(): {
  requestDelete: (nodes: string[], edges: string[]) => void;
  dialog: React.ReactNode;
} {
  const t = useT();
  const [pendingDelete, setPendingDelete] =
    React.useState<PendingDelete | null>(null);
  const requestDelete = React.useCallback(
    (nodes: string[], edges: string[]) => {
      if (nodes.length === 0 && edges.length === 0) return;
      if (!hasLiveSession(nodes)) {
        const store = useCanvasStore.getState();
        if (edges.length > 0) store.removeEdges(edges);
        if (nodes.length > 0) {
          endSessionsOf(nodes);
          store.removeNodes(nodes);
        }
        return;
      }
      setPendingDelete({ nodes, edges });
    },
    [],
  );

  const confirmDelete = React.useCallback(() => {
    if (!pendingDelete) return;
    const store = useCanvasStore.getState();
    if (pendingDelete.edges.length > 0) store.removeEdges(pendingDelete.edges);
    if (pendingDelete.nodes.length > 0) {
      endSessionsOf(pendingDelete.nodes);
      store.removeNodes(pendingDelete.nodes);
    }
    setPendingDelete(null);
  }, [pendingDelete]);

  const dialog = (
    <>
      <ResponsiveAlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>
              {t("delete.session.title")}
            </ResponsiveAlertDialogTitle>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>
              {t("delete.cancel")}
            </ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              variant="destructive-solid"
              onClick={confirmDelete}
            >
              {t("delete.session.confirm")}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  );
  return { requestDelete, dialog };
}

/** 整理的过渡时长（`--dur-page` 220ms）加一点余量，之后撤掉 `data-tidying`。 */
const TIDY_TRANSITION_MS = 260;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 注册画布命令；返回注销函数。 */
export function registerWorkspaceCommands({
  container,
  requestDelete,
}: {
  container: () => HTMLElement | null;
  requestDelete: (nodes: string[], edges: string[]) => void;
}): () => void {
  const store = () => useCanvasStore.getState();
  const firstSelected = () => store().selectedNodeIds[0] ?? null;

  /** 视口内减去 24px 边距的画布矩形，最大化用。 */
  const maximizeRect = () => {
    const viewport = getFlow()?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
    const rect = container()?.getBoundingClientRect();
    const zoom = viewport.zoom || 1;
    const margin = MAXIMIZE_MARGIN / zoom;
    return {
      x: -viewport.x / zoom + margin,
      y: -viewport.y / zoom + margin,
      width: Math.max((rect?.width ?? 0) / zoom - margin * 2, 200),
      height: Math.max((rect?.height ?? 0) / zoom - margin * 2, 160),
    };
  };

  const boxes = (): { id: string; box: Box }[] => {
    const nodes = store().document?.nodes ?? [];
    return nodes.map((node) => ({ id: node.id, box: nodeBox(nodes, node) }));
  };

  const focus = (direction: "left" | "right" | "up" | "down") => () => {
    const from = firstSelected();
    if (!from) return;
    const next = nearestInDirection(boxes(), from, direction);
    if (!next) return;
    store().selectNodes([next]);
    centerOnNode(next);
  };

  /**
   * 白板工具（F21）。一份表驱动 Dock、快捷键、命令面板；锁定时除选择外
   * 一概不响应。B2 之前只有选择与手真的有效果。
   */
  const toolCommands: Partial<Record<CanvasCommandId, () => void>> = {};
  for (const tool of CANVAS_TOOLS) {
    toolCommands[tool.command] = () => {
      if (isCanvasLocked() && isToolDisabledWhenLocked(tool.id)) return;
      setTool(tool.id);
    };
  }

  let tidyTimer = 0;

  return registerCanvasCommands({
    "canvas.undo": () => store().undo(),
    "canvas.redo": () => store().redo(),
    "canvas.tidy": () => {
      // 目标区域按当前视口的宽高比裹，排出来的矩形才贴合屏幕。
      const stage = container();
      const rect = stage?.getBoundingClientRect();
      const aspect =
        rect && rect.width > 0 && rect.height > 0
          ? rect.width / rect.height
          : undefined;
      // 选区里有 ≥ 2 个顶层单元就只整理选中的（UI 设计 §6.5）。
      const only = tidySelection(store());
      // 过渡只在整理这一下打开（canvas.css），平时拖动不能带缓动。
      if (stage && !prefersReducedMotion()) {
        stage.dataset.tidying = "true";
        window.clearTimeout(tidyTimer);
        tidyTimer = window.setTimeout(() => {
          delete stage.dataset.tidying;
        }, TIDY_TRANSITION_MS);
      }
      store().arrangeNodes({ aspect, only, direction: layoutDirection() });
      // 整理全画布之后 fitView：既然已经裹成一屏的形状，就让它真的落在
      // 一屏里。只整理选中时相机不动，免得把用户正看着的地方带走。
      if (!only) window.requestAnimationFrame(fitView);
    },
    "canvas.fitView": fitView,
    "canvas.zoomIn": () => zoomByStep(1),
    "canvas.zoomOut": () => zoomByStep(-1),
    "canvas.zoom100": () => zoomToLevel(1),
    "canvas.selectAll": () => selectAllCanvas(store()),
    "canvas.delete": () => {
      const state = store();
      const split = splitSelectionForDelete(
        [
          ...state.selectedNodeIds,
          ...state.selectedEdgeIds,
          ...state.selectedItemIds,
        ],
        new Set((state.document?.nodes ?? []).map((node) => node.id)),
        new Set((state.document?.edges ?? []).map((edge) => edge.id)),
        new Set(state.whiteboard.references.map((reference) => reference.id)),
      );
      // 白板对象与引用直接删：没有会话要结束，也没有确认框要弹。
      if (split.items.length > 0) removeItems(split.items);
      if (split.references.length > 0) removeReferences(split.references);
      requestDelete(split.nodes, split.edges);
    },
    "canvas.duplicate": () => store().duplicateNodes(store().selectedNodeIds),
    "canvas.group": () => {
      const state = store();
      const nodes = state.document?.nodes ?? [];
      const members = state.selectedNodeIds.filter((id) => {
        const node = nodes.find((item) => item.id === id);
        return node && node.type !== "group";
      });
      if (members.length === 0) return;
      const rect = boundingBox(
        members
          .map((id) => nodes.find((node) => node.id === id))
          .filter((node): node is CanvasNode => Boolean(node))
          .map((node) => nodeBox(nodes, node)),
      );
      if (!rect) return;
      const padding = 32;
      const groupId = state.addNode("group", {
        position: { x: rect.x - padding, y: rect.y - padding - 12 },
        size: {
          width: rect.width + padding * 2,
          height: rect.height + padding * 2 + 12,
        },
        select: false,
      });
      if (groupId) store().setParent(members, groupId);
    },
    "canvas.maximize": () => {
      const id = firstSelected();
      if (!id) return;
      if (store().maximized[id]) store().restoreNode(id);
      else store().maximizeNode(id, maximizeRect());
    },
    "canvas.restore": () => {
      const id = firstSelected();
      if (id) store().restoreNode(id);
    },
    "canvas.closeNode": () => {
      const id = firstSelected();
      if (id) requestDelete([id], []);
    },
    "canvas.focusLeft": focus("left"),
    "canvas.focusRight": focus("right"),
    "canvas.focusUp": focus("up"),
    "canvas.focusDown": focus("down"),
    // 便签的 Markdown 预览开关由便签自己接管，这里占位免得快捷键落空报错。
    "canvas.toggleMarkdown": () => undefined,
    ...toolCommands,
  });
}
