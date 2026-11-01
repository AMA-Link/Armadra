import type { CanvasNodeType } from "./primitives.js";
import type { Size } from "./nodes.js";

/**
 * 黄金比例（#684）。画布上每一种节点的默认与最小尺寸都由这里生成，core 与
 * 页面共用同一个常量、同一个函数，不再各自写一张尺寸表。
 *
 * 规则：横向节点 宽:高 = φ:1，本来竖长的（文件列表）取 1:φ，宽高都是基准单位
 * {@link GRID_UNIT} 的整数倍（背景点阵的间距）。{@link goldenSize} 是任意长边的
 * 通用生成函数：取整只在较短边上做一次（`round(长边 / φ)`），比例误差不超过
 * φ/2 ≈ 0.81px，落在 1px 容差之内。
 *
 * 只管**新建**：已保存节点的尺寸是用户数据，从不按这张表改写。
 */

/** φ = (1 + √5) / 2 ≈ 1.618。 */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** 比例的容差：长边 − 短边 × φ 的绝对值不超过它（像素）。 */
export const GOLDEN_TOLERANCE_PX = 1;

export type GoldenOrientation = "landscape" | "portrait";

/** 以长边生成黄金比例尺寸；`portrait` 时长边是高。 */
export function goldenSize(
  longEdge: number,
  orientation: GoldenOrientation = "landscape",
): Size {
  const long = Math.max(1, Math.round(longEdge));
  const short = Math.max(1, Math.round(long / GOLDEN_RATIO));
  return orientation === "landscape"
    ? { width: long, height: short }
    : { width: short, height: long };
}

/** 一个尺寸的长边 / 短边。 */
export function aspectOf(size: Size): number {
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  return short > 0 ? long / short : Number.POSITIVE_INFINITY;
}

/** 这个尺寸是不是黄金比例（长边与 短边 × φ 相差不超过容差）。 */
export function isGoldenSize(
  size: Size,
  tolerance: number = GOLDEN_TOLERANCE_PX,
): boolean {
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  return Math.abs(long - short * GOLDEN_RATIO) <= tolerance;
}

/**
 * 画布的基准单位（px）：背景点阵的间距，也是每个节点默认与最小尺寸的公约
 * 数。13 是斐波那契数（点阵间距取 φ 阶梯 13 / 21 / 34 里最密的一档），所以
 * 相邻斐波那契数之比逼近 φ，节点宽高取它们的整数倍时既落在点阵上又是黄金
 * 比例。点阵和节点在同一个画布坐标系里，缩放时比例不变。
 */
export const GRID_UNIT = 13;

/** 点阵间距的可选档（px），φ 阶梯上的斐波那契数；第一档就是 {@link GRID_UNIT}。 */
export const GRID_SPACINGS = [13, 21, 34] as const;

/**
 * 以 {@link GRID_UNIT} 为单位、比例落在 1px 容差内的 (长边, 短边) 格数，从小
 * 到大。长边 × 13 与 短边 × 13 × φ 相差不到 1px 的整数对，长边到 89 格为止只
 * 有这些（相邻斐波那契数及其整数倍里还满足容差的）。
 */
export const GOLDEN_CELLS: readonly (readonly [number, number])[] = [
  [13, 8],
  [21, 13],
  [34, 21],
  [42, 26],
  [55, 34],
  [68, 42],
  [76, 47],
  [89, 55],
];

type Cells = readonly [number, number];

function sizeOfCells(cells: Cells, orientation: GoldenOrientation): Size {
  const [long, short] = cells;
  return orientation === "landscape"
    ? { width: long * GRID_UNIT, height: short * GRID_UNIT }
    : { width: short * GRID_UNIT, height: long * GRID_UNIT };
}

/**
 * 按系数缩放，结果仍是黄金比例**并落在点阵上**：取长边不超过 `长边 × factor`
 * 的最大一档格数，一档都放不下时取最小档。方向沿用输入（宽 ≥ 高为横向）。
 * 手机上新建的节点装不进视口时用它缩小。
 */
export function scaleGoldenSize(size: Size, factor: number): Size {
  const orientation: GoldenOrientation =
    size.width >= size.height ? "landscape" : "portrait";
  const wanted = (Math.max(size.width, size.height) * factor) / GRID_UNIT;
  let pick: Cells = GOLDEN_CELLS[0]!;
  for (const cells of GOLDEN_CELLS) if (cells[0] <= wanted) pick = cells;
  return sizeOfCells(pick, orientation);
}

interface NodeSizeSpec {
  orientation: GoldenOrientation;
  /** 默认尺寸的格数（长边, 短边）。 */
  default: Cells;
  /** 最小尺寸的格数。 */
  min: Cells;
}

/**
 * 每种节点的格数（{@link GOLDEN_CELLS} 里的一档）。会话（终端与 ACP 同一种节点）
 * 用 55×34 格 = 715×442，装得下约 98 列、25 行，相对点阵不再显得巨大；
 * 浏览器与对比这两种要宽屏内容的取 89×55 格。
 */
const NODE_SIZE_SPEC: Readonly<Record<CanvasNodeType, NodeSizeSpec>> = {
  terminal: { orientation: "landscape", default: [55, 34], min: [21, 13] },
  sticky: { orientation: "landscape", default: [21, 13], min: [13, 8] },
  group: { orientation: "landscape", default: [68, 42], min: [13, 8] },
  editor: { orientation: "landscape", default: [55, 34], min: [21, 13] },
  diff: { orientation: "landscape", default: [89, 55], min: [34, 21] },
  files: { orientation: "portrait", default: [34, 21], min: [21, 13] },
  browser: { orientation: "landscape", default: [89, 55], min: [34, 21] },
  automation: { orientation: "landscape", default: [34, 21], min: [21, 13] },
  agentActivity: { orientation: "landscape", default: [34, 21], min: [21, 13] },
};

/** 新建这种节点时的尺寸。 */
export function defaultNodeSizeOf(type: CanvasNodeType): Size {
  const spec = NODE_SIZE_SPEC[type];
  return sizeOfCells(spec.default, spec.orientation);
}

/** 这种节点能缩到的最小尺寸。 */
export function minNodeSizeOf(type: CanvasNodeType): Size {
  const spec = NODE_SIZE_SPEC[type];
  return sizeOfCells(spec.min, spec.orientation);
}

/**
 * 新建绑定 worktree 的 Frame 的尺寸（89×55 格 = 1157×715）：装得下一个默认
 * 会话（715×442）还留出边距。页面（`worktree-frame.ts`、新建菜单）与 core 的
 * `worktree` 动词共用。
 */
export const WORKTREE_FRAME_SIZE: Readonly<Size> = sizeOfCells(
  [89, 55],
  "landscape",
);
