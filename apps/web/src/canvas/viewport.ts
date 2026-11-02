import { DEFAULT_VIEWPORT, type Viewport } from "@armadra/shared";

import {
  PHONE_NODE_MARGIN,
  firstDisplayZoom,
  fontFloorZoom,
} from "./first-display";

/**
 * 打开画布时的视口（§20「打开比例」）。
 *
 * 结论先行：**首次打开不缩放**。以前这里是 `fitView`，节点一多就落到 70%
 * 左右，浏览器节点里的网页被整体缩小、字号发虚——那是缩放画布，不是缩放
 * 网页。所以现在固定 `zoom: 1`，只把画布平移到内容包围盒的左上角，四周留
 * 40px 边距；空画布回到 `{0,0,1}`。
 */

/** 包围盒只需要位置和尺寸；用最小结构，测试不必造整个 `CanvasNode`。 */
export interface ViewportBox {
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  /** 组员坐标是相对组框的，不参与包围盒。 */
  parentId?: string | null;
}

/** 内容左上角到画布左上角的边距（画布像素 = 屏幕像素，因为 zoom 恒为 1）。 */
export const INITIAL_VIEWPORT_MARGIN = 40;

/** 判断一个视口是不是「从没存过」的那个默认值。 */
export function isDefaultViewport(
  viewport: Viewport | null | undefined,
): boolean {
  return (
    !viewport ||
    (viewport.x === DEFAULT_VIEWPORT.x &&
      viewport.y === DEFAULT_VIEWPORT.y &&
      viewport.zoom === DEFAULT_VIEWPORT.zoom)
  );
}

/**
 * 100% 缩放下把内容左上角对齐到 `margin`。
 *
 * 只看顶层节点：组员的 `position` 是相对父组框的，混进来会把包围盒拉歪。
 * 没有可用节点（空画布 / 全是组员）时返回默认视口。
 */
export function initialViewportFor(
  nodes: readonly ViewportBox[],
  margin: number = INITIAL_VIEWPORT_MARGIN,
): Viewport {
  const roots = nodes.filter((node) => !node.parentId);
  if (roots.length === 0) return { ...DEFAULT_VIEWPORT };

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const node of roots) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { ...DEFAULT_VIEWPORT };
  }

  return { x: margin - minX, y: margin - minY, zoom: 1 };
}

/* ------------------------- 手机上打开画布（#715） ------------------------- */

/** 手机打开视口要用的节点：位置、尺寸与正文字号；组员（有 `parentId`）不参与。 */
export interface OpeningNode {
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string | null;
  /** 节点里最小的正文字号；缺省按 `first-display.NODE_TEXT_PX`。 */
  fontPx?: number;
}

/**
 * 手机上打开一块画布时的视口（#715）。
 *
 * 视口存在画布文档里，多端共用：桌面上停在 10% 看全局，到手机上照搬就是一屏
 * 看不清的小方块。所以手机上存的缩放低于字号下限（#693：屏幕字号 ≥ 12px）时
 * 不照搬，改为把「原视口中心最近的那个节点」按首次显示的规则（占主方向 1/φ，
 * 缩放夹在 [字号下限, 1.25]）居中——用户上次看的是哪一片，打开还在那一片，
 * 只是看得清。
 *
 * 存的缩放够大、从没存过视口（交给 {@link initialViewportFor}，那是 100%）、
 * 画布空着或容器没量到时返回 `null`，调用方照旧。
 */
export function phoneOpeningViewport(input: {
  persisted: Viewport | null | undefined;
  nodes: readonly OpeningNode[];
  container: { width: number; height: number };
}): Viewport | null {
  const { persisted, container } = input;
  if (!persisted || isDefaultViewport(persisted)) return null;
  if (container.width <= 0 || container.height <= 0) return null;
  const roots = input.nodes.filter(
    (node) =>
      !node.parentId &&
      [node.x, node.y, node.width, node.height].every(Number.isFinite) &&
      node.width > 0 &&
      node.height > 0,
  );
  if (roots.length === 0) return null;

  const zoom = persisted.zoom > 0 ? persisted.zoom : 1;
  // 原视口中心落在画布上的哪一点。
  const centre = {
    x: (container.width / 2 - persisted.x) / zoom,
    y: (container.height / 2 - persisted.y) / zoom,
  };
  const distance = (node: OpeningNode) =>
    Math.hypot(
      node.x + node.width / 2 - centre.x,
      node.y + node.height / 2 - centre.y,
    );
  let anchor = roots[0]!;
  for (const node of roots)
    if (distance(node) < distance(anchor)) anchor = node;

  if (zoom >= fontFloorZoom(anchor.fontPx)) return null;

  const next = firstDisplayZoom({
    node: { width: anchor.width, height: anchor.height },
    container,
    ...(anchor.fontPx === undefined ? {} : { fontPx: anchor.fontPx }),
  });
  return cameraOnBox(anchor, next, container);
}

/**
 * 在 `zoom` 下把一块矩形摆进容器（#730）：放得下的方向居中；比容器还大的方向
 * 把近端（左 / 上）对齐到 {@link PHONE_NODE_MARGIN}，近端一定看得见，另一头
 * 可以平移过去——以前一律居中，宽节点两头都出屏、左缘再也看不到。
 */
export function cameraOnBox(
  box: { x: number; y: number; width: number; height: number },
  zoom: number,
  container: { width: number; height: number },
): Viewport {
  const place = (start: number, size: number, room: number) => {
    const span = size * zoom;
    return span <= room - PHONE_NODE_MARGIN * 2
      ? room / 2 - (start + size / 2) * zoom
      : PHONE_NODE_MARGIN - start * zoom;
  };
  return {
    x: place(box.x, box.width, container.width),
    y: place(box.y, box.height, container.height),
    zoom,
  };
}

/** 适应视图四周留的比例边距。 */
export const FIT_PADDING = 0.05;

/** 手机「适应」要的盒子：位置、尺寸、正文字号与是否选中；组员不参与。 */
export interface FitBox extends OpeningNode {
  selected?: boolean;
}

/**
 * 手机上的「适应」（#730）。
 *
 * 整块内容放进屏幕后字号仍不低于下限（#693）就返回 `null`，调用方走普通的
 * 适应；放不下时不再缩到 10%，而是把**选中的节点**（没选中就是离当前视口中心
 * 最近的那个）放到可读的缩放下对准——一屏看全和看得清二选一，手机上选看得清。
 * 对准用 {@link cameraOnBox}，比屏幕宽的节点左缘可见。
 */
export function phoneFitViewport(input: {
  boxes: readonly FitBox[];
  current: Viewport;
  container: { width: number; height: number };
}): Viewport | null {
  const { container, current } = input;
  if (container.width <= 0 || container.height <= 0) return null;
  const roots = input.boxes.filter(
    (box) =>
      !box.parentId &&
      [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
      box.width > 0 &&
      box.height > 0,
  );
  if (roots.length === 0) return null;

  const floor = Math.max(...roots.map((box) => fontFloorZoom(box.fontPx)));
  const all = boundsOf(roots);
  if (fitZoom(all, container) >= floor) return null;

  const selected = roots.filter((box) => box.selected);
  let focus: readonly FitBox[];
  if (selected.length > 0) {
    focus = selected;
  } else {
    const zoom = current.zoom > 0 ? current.zoom : 1;
    const centre = {
      x: (container.width / 2 - current.x) / zoom,
      y: (container.height / 2 - current.y) / zoom,
    };
    const distance = (box: FitBox) =>
      Math.hypot(
        box.x + box.width / 2 - centre.x,
        box.y + box.height / 2 - centre.y,
      );
    focus = [roots.reduce((a, b) => (distance(b) < distance(a) ? b : a))];
  }
  const box = boundsOf(focus);
  const focusFloor = Math.max(
    ...focus.map((item) => fontFloorZoom(item.fontPx)),
  );
  // 只缩小不放大（与普通适应一致）；字号下限优先于「放得下」。
  const zoom = Math.max(focusFloor, Math.min(fitZoom(box, container), 1));
  return cameraOnBox(box, zoom, container);
}

function boundsOf(boxes: readonly OpeningNode[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 把盒子（含 {@link FIT_PADDING} 边距）放进容器的缩放，不夹范围。 */
function fitZoom(
  box: { width: number; height: number },
  container: { width: number; height: number },
): number {
  const pad = 1 + FIT_PADDING * 2;
  return Math.min(
    container.width / (box.width * pad),
    container.height / (box.height * pad),
  );
}
