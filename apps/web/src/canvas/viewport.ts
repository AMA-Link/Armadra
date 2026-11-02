import { DEFAULT_VIEWPORT, type Viewport } from "@armadra/shared";

import { firstDisplayZoom, fontFloorZoom } from "./first-display";

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
  return {
    x: container.width / 2 - (anchor.x + anchor.width / 2) * next,
    y: container.height / 2 - (anchor.y + anchor.height / 2) * next,
    zoom: next,
  };
}
