import * as React from "react";
import {
  getNodesBounds,
  getViewportForBounds,
  useOnViewportChange,
  type Viewport as FlowViewport,
} from "@xyflow/react";
import type { BoardDocument, Size } from "@armadra/shared";

import { useCanvasStore } from "@/store/canvas-store";
import { defaultNodeSize, minNodeSize, nodeFontPx } from "@/store/defaults";
import { isCompactLayout } from "@/platform/layout";
import { usePreferencesStore } from "@/app/preferences-store";
import { stopFollowing } from "@/realtime/session";
import type { Box } from "../geometry";
import { fitNewNodeSize } from "../first-display";
import { initialViewportFor, isDefaultViewport } from "../viewport";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_DURATION,
  ZOOM_STEP,
  clampZoom,
} from "../zoom";
import { containerSize, getFlow } from "./flow-context";
import { cameraForNewNode } from "./reveal";

/**
 * 视口（React Flow 计划 §1.2 F10 / §2.9，归属 canvas）。
 *
 * 存储值一直是 React Flow 语义（`{x, y, zoom}`，§3.4），所以打开画布就是
 * `setViewport(board.viewport)`，一行换算都没有。
 *
 * 相机 → 文档是**节流**而不是防抖：连续平移时每 300ms 记一次，松手后最后
 * 一次也会落下。平移不置 dirty，`save/autosave.ts` 有单独的视口通道。
 */

export const CAMERA_THROTTLE_MS = 300;

/** 适应视图时四周留的比例边距。 */
const FIT_PADDING = 0.05;
const FIT_DURATION = 200;

/** 「居中到那个节点」时至少放大到这个比例，否则等于定位到一个点。 */
const CENTER_MIN_ZOOM = 0.6;

/** 视口动画时长：关掉「动画」偏好时为 0（§2.10）。 */
function duration(base: number): number {
  return usePreferencesStore.getState().whiteboard.animation ? base : 0;
}

/** 画布上所有对象的外包围盒；节点、分组与白板对象都算在内。 */
export function visibleBounds(): Box | null {
  const flow = getFlow();
  if (!flow) return null;
  const nodes = flow.getNodes();
  if (nodes.length === 0) return null;
  const rect = getNodesBounds(nodes);
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return null;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * 适应视图：**只缩小不放大**（§20）。够放得下就停在 100%，
 * Dock 的「适应」与 `canvas.fitView` 走的是同一条路径。
 */
export function fitView(): void {
  const flow = getFlow();
  const bounds = visibleBounds();
  if (!flow || !bounds) return;
  const { width, height } = containerSize();
  if (width <= 0 || height <= 0) return;
  const target = getViewportForBounds(
    { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    width,
    height,
    MIN_ZOOM,
    1,
    FIT_PADDING,
  );
  void flow.setViewport(
    { ...target, zoom: clampZoom(Math.min(target.zoom, 1)) },
    { duration: duration(FIT_DURATION) },
  );
}

/** 缩放到某一档，锚点是容器中心。Dock 按钮与快捷键都走这里，是人动的视口，取消跟随（#327）。 */
export function zoomToLevel(level: number): void {
  const flow = getFlow();
  if (!flow) return;
  stopFollowing();
  void flow.zoomTo(clampZoom(level), { duration: duration(ZOOM_DURATION) });
}

export function zoomByStep(direction: 1 | -1): void {
  const flow = getFlow();
  if (!flow) return;
  const current = flow.getViewport().zoom;
  zoomToLevel(direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP);
}

/** 会话侧栏点一行 → 把画布居中到那个节点。 */
export function centerOnNode(nodeId: string): void {
  const flow = getFlow();
  if (!flow) return;
  const node = flow.getNode(nodeId);
  if (!node) return;
  const rect = getNodesBounds([node]);
  const zoom = Math.max(flow.getViewport().zoom, CENTER_MIN_ZOOM);
  void flow.setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, {
    zoom: clampZoom(zoom),
    duration: duration(FIT_DURATION),
  });
}

/* ---------------------------- 新建节点后的相机 ---------------------------- */

/**
 * 新建节点之后的相机（契约 §3.4，#684）。
 *
 * 新建的节点每次都被送到眼前：居中，缩放让它占视口主方向的 1/φ，屏幕上的
 * 字号不低于 `--text-meta`。数学在 `flow/reveal.ts` 与 `canvas/first-display.ts`，
 * 这里只负责量与动。手动新建与 Agent 新建走的是同一个函数，所以两边不会再
 * 分叉。
 *
 * 只在 React Flow **已经量过**这个节点时才动（`getNodesBounds` 给出有效
 * 矩形）。刚 `addNode` 完那一帧投影还没落地，所以按一张很短的时间表重试；
 * 量不出来就一次也不动相机，宁可不动也不要对着一个错的矩形居中。
 */
/** 等投影落地的重试表（毫秒）；成功一次之后剩下的都空跑。 */
export const REVEAL_RETRY_DELAYS: readonly number[] = [0, 120, 320];

/** React Flow 量到的节点矩形；没量到（或尺寸不可知）时是 `null`。 */
function measuredNodeBounds(nodeId: string): Box | null {
  const flow = getFlow();
  const node = flow?.getNode(nodeId);
  if (!node) return null;
  const rect = getNodesBounds([node]);
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height))
    return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * 手机上、文档里还是默认尺寸（或根本没写 `size`，core 的控制动词就这样建）
 * 的新节点：装不进视口就等比缩小，保持中心不动。手动新建在 `addNode` 里就
 * 已经是装得下的尺寸，调用方指定过别的尺寸的也不碰。返回是否改了。
 */
function fitNodeToPhone(nodeId: string): boolean {
  if (!isCompactLayout()) return false;
  const state = useCanvasStore.getState();
  const node = state.document?.nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  const standard = defaultNodeSize(node.type);
  const current = node.size ?? standard;
  if (current.width !== standard.width || current.height !== standard.height) {
    return false;
  }
  const next = fitNewNodeSize({
    size: current,
    min: minNodeSize(node.type),
    container: containerSize(),
    fontPx: nodeFontPx(node.type),
  });
  if (next.width === current.width && next.height === current.height) {
    return false;
  }
  state.resizeNode(nodeId, next, {
    x: Math.round(node.position.x + (current.width - next.width) / 2),
    y: Math.round(node.position.y + (current.height - next.height) / 2),
  });
  return true;
}

/** 量到了就按规则动一次相机；量不到返回 false，让调用方再试一次。 */
function centreOnMeasured(nodeId: string, expected: Size | null): boolean {
  const flow = getFlow();
  const rect = measuredNodeBounds(nodeId);
  if (!flow || !rect) return false;
  // 刚缩小过：量到的还是缩小之前的矩形就再等一拍，免得对着旧尺寸算缩放。
  if (
    expected &&
    (Math.abs(rect.width - expected.width) > 1 ||
      Math.abs(rect.height - expected.height) > 1)
  ) {
    return false;
  }
  const type = useCanvasStore
    .getState()
    .document?.nodes.find((item) => item.id === nodeId)?.type;
  const target = cameraForNewNode({
    node: rect,
    container: containerSize(),
    ...(type ? { fontPx: nodeFontPx(type) } : {}),
  });
  if (!target) return false;
  void flow.setCenter(target.x, target.y, {
    zoom: target.zoom,
    duration: duration(FIT_DURATION),
  });
  return true;
}

export function revealNewNode(nodeId: string): void {
  const flow = getFlow();
  if (!flow) return;
  let done = false;
  let expected: Size | null = null;
  const attempt = () => {
    if (done) return;
    if (expected === null && fitNodeToPhone(nodeId)) {
      expected =
        useCanvasStore
          .getState()
          .document?.nodes.find((item) => item.id === nodeId)?.size ?? null;
    }
    done = centreOnMeasured(nodeId, expected);
  };
  for (const delay of REVEAL_RETRY_DELAYS) {
    if (delay === 0) attempt();
    else setTimeout(attempt, delay);
  }
}

/**
 * 首次打开一块画布：从没存过视口（或还是默认的 `{0,0,1}`）就按 100% 对齐
 * 内容左上角；存过的视口原样恢复，用户上次停在哪就还在哪。
 */
export function applyBoardViewport(document: BoardDocument): void {
  const persisted = document.board.viewport;
  if (!isDefaultViewport(persisted)) {
    useCanvasStore.getState().setViewport(persisted);
    return;
  }
  useCanvasStore.getState().setViewport(
    initialViewportFor(
      document.nodes.map((node) => ({
        x: node.position.x,
        y: node.position.y,
        parentId: node.parentId ?? null,
      })),
    ),
  );
}

/** 相机 → 文档，节流 300ms。必须在 `<ReactFlow>` 的 provider 之下调用。 */
export function useViewportSync(): void {
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = React.useRef<FlowViewport | null>(null);

  const flush = React.useCallback(() => {
    timer.current = null;
    const latest = pending.current;
    if (!latest) return;
    useCanvasStore.getState().setViewport({
      x: latest.x,
      y: latest.y,
      zoom: clampZoom(latest.zoom),
    });
  }, []);

  useOnViewportChange({
    onChange: React.useCallback(
      (viewport: FlowViewport) => {
        pending.current = viewport;
        if (timer.current) return;
        timer.current = setTimeout(flush, CAMERA_THROTTLE_MS);
      },
      [flush],
    ),
    // 松手时立刻落一次：节流窗口里的最后一段位移不该等到下一次平移才写。
    onEnd: React.useCallback(
      (viewport: FlowViewport) => {
        pending.current = viewport;
        if (timer.current) clearTimeout(timer.current);
        flush();
      },
      [flush],
    ),
  });

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}

export { MAX_ZOOM, MIN_ZOOM };
