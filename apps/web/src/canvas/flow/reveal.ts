import type { Box } from "../geometry";
import { firstDisplayZoom } from "../first-display";

/**
 * 「新建了一个节点，相机动到哪」——只有数学，没有 React。
 *
 * 新建的节点每次都被送到眼前（#684，契约 §3.4）：居中，缩放让它占视口主方向
 * 的 1/φ，但屏幕上的字号（字号 × 缩放）不低于 `--text-meta`。占比与字号下限
 * 的算法在 `canvas/first-display.ts`，手动新建与 Agent 新建共用这一处，所以两
 * 边不会再分叉。
 *
 * 谁该跟过去由 `canvas/created-node.ts` 的闸门判断（别的板、后台页面、手势或
 * 输入进行中都不抢相机）；到了这里就一定动。
 */

export interface CameraTarget {
  /** 居中到这个画布坐标。 */
  x: number;
  y: number;
  zoom: number;
}

/**
 * 新建节点之后的相机目标；`null` = 不动（节点还没量过，宽高为 0）。
 *
 * `container` 量不出来（画布没挂载、单测里没有 DOM）时只剩字号下限：居中并
 * 把缩放抬到下限。
 */
export function cameraForNewNode(input: {
  node: Box;
  container: { width: number; height: number };
  /** 节点里最小正文的字号；终端按它自己的偏好，缺省 12px。 */
  fontPx?: number;
}): CameraTarget | null {
  const { node, container } = input;
  if (
    !Number.isFinite(node.width) ||
    !Number.isFinite(node.height) ||
    node.width <= 0 ||
    node.height <= 0
  ) {
    return null;
  }
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
    zoom: firstDisplayZoom({
      node,
      container,
      ...(input.fontPx === undefined ? {} : { fontPx: input.fontPx }),
    }),
  };
}
