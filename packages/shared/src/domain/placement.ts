import type { LAYOUT_DIRECTION_CHOICES } from "../completion-settings.js";
import type { Position, Size } from "./nodes.js";

/**
 * 派发出来的从放在哪（契约 §50，ui-wave2 §4.4）。纯函数，core 的控制动词
 * （`open-agent` / `team`）与页面的「派生」共用这一条规矩；间距常量也是整理
 * （`apps/web/src/canvas/tidy.ts`）的间距，两边排出来的样子一致（#319）。
 *
 * - `vertical`：从排在主**下面一层**——`y = 主底 + 层距`；`x` 接在主已有的从里
 *   最右那个的右边（隔兄弟间距），没有从时与主左对齐。
 * - `horizontal`：从排在主**右侧一层**——`x = 主右 + 层距`；`y` 接在已有的从里
 *   最下那个的下面（隔兄弟间距），没有从时与主顶对齐。
 *
 * 落点离任何已有盒子不足一个兄弟间距（{@link boxesTooClose}）就算被占：沿同一
 * 行 / 列跳过挡路的盒子再试；让 64 次还不行就放到所有盒子的下面（纵向）或右边
 * （横向）。已有节点一个不动：居中只在整理时做。
 *
 * 盒子要和主在同一个坐标系里：主在分组里时只传同组的兄弟（坐标相对分组）。
 */

export type LayoutDirection = (typeof LAYOUT_DIRECTION_CHOICES)[number];

export const DEFAULT_LAYOUT_DIRECTION: LayoutDirection = "vertical";

/**
 * 层距：沿连线方向（主 → 从）相邻两层之间的空白。扇出的派发线要在这里弯折、
 * 还要放得下连线标签，所以比兄弟间距大；横向的标签是横着排的，再宽一些。
 */
export const LAYER_GAP: Readonly<Record<LayoutDirection, number>> = {
  vertical: 128,
  horizontal: 160,
};
/** 兄弟间距：同一层相邻两个节点之间的通道，连线能从中间穿过去。 */
export const SIBLING_GAP = 80;
/** 互不相连的两簇之间的空白。 */
export const CLUSTER_GAP = 96;
/** 沿行 / 列最多让几格。 */
export const PLACEMENT_ATTEMPTS = 64;

export interface PlacementBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 两个矩形相距不足 `gap`（含相交）。`gap = 0` 就是严格相交，贴边不算。
 * 整理与派发放置共用这一条「不重叠」的定义。
 */
export function boxesTooClose(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap = 0,
): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/**
 * 新从的左上角。`childIds` 是主已有的从（`role: "supervises"` 边的另一端）；
 * 主不在 `boxes` 里时返回 `null`，由调用方退回自己的缺省落点。
 */
export function dispatchPlacement(
  boxes: readonly PlacementBox[],
  parentId: string,
  size: Size,
  direction: LayoutDirection,
  childIds: readonly string[] = [],
): Position | null {
  const parent = boxes.find((box) => box.id === parentId);
  if (parent === undefined) return null;
  const wanted = new Set(childIds);
  const children = boxes.filter(
    (box) => box.id !== parentId && wanted.has(box.id),
  );
  const vertical = direction === "vertical";
  const layer = LAYER_GAP[direction];

  let at: Position = vertical
    ? {
        x:
          children.length > 0
            ? Math.max(...children.map((box) => box.x + box.width)) +
              SIBLING_GAP
            : parent.x,
        y: parent.y + parent.height + layer,
      }
    : {
        x: parent.x + parent.width + layer,
        y:
          children.length > 0
            ? Math.max(...children.map((box) => box.y + box.height)) +
              SIBLING_GAP
            : parent.y,
      };

  const blockers = () =>
    boxes.filter((box) => boxesTooClose(box, { ...at, ...size }, SIBLING_GAP));
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt += 1) {
    const hit = blockers();
    if (hit.length === 0) break;
    // 跳过挡路的盒子：落点一步到它们的另一侧，不在原地一格一格地挪。
    at = vertical
      ? {
          x: Math.max(...hit.map((box) => box.x + box.width)) + SIBLING_GAP,
          y: at.y,
        }
      : {
          x: at.x,
          y: Math.max(...hit.map((box) => box.y + box.height)) + SIBLING_GAP,
        };
  }
  if (blockers().length > 0) {
    at = vertical
      ? {
          x: parent.x,
          y: Math.max(...boxes.map((box) => box.y + box.height)) + layer,
        }
      : {
          x: Math.max(...boxes.map((box) => box.x + box.width)) + layer,
          y: parent.y,
        };
  }
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  return at;
}
