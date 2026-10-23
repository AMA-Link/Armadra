/**
 * `motion` 分区的假数据（设计展示页 §2.1）：十个配方各一格，名字与设计系统 §8 的
 * 小节对应。字符串是数据不是界面文案，允许中文（`i18n.test.ts` 排除了本目录）。
 */

/** 十个配方的 `data-sample` 名，顺序就是分区里的顺序。 */
export const MOTION_RECIPES = [
  "press",
  "pop",
  "indicator",
  "text-swap",
  "number-roll",
  "list-stagger",
  "icon-swap",
  "shake",
  "shimmer",
  "check-draw",
] as const;

export type MotionRecipe = (typeof MOTION_RECIPES)[number];

/** 指示器平移：分段控件的三项。 */
export const INDICATOR_ITEMS = ["画布", "列表", "时间线"] as const;

/** 数字滚动：两个来回的值。 */
export const ROLL_VALUES = [1284, 9031] as const;

/** 列表错落：六行（最多前六项错落）。 */
export const STAGGER_ROWS = [
  "claude · 重构保存队列",
  "codex · 修复连线抖动",
  "终端 · pnpm test",
  "便签 · 发布清单",
  "分组 · 前端",
  "浏览器 · 预览",
] as const;

/** 微光：加载中的标签。 */
export const SHIMMER_LABEL = "正在思考";

/** 校验失败：输入框里的值与错误提示。 */
export const SHAKE_VALUE = "armadra/web";

/** 勾画出：转圈停多久（毫秒）再收成对勾，样本里自动循环。 */
export const CHECK_SPIN_MS = 1200;
