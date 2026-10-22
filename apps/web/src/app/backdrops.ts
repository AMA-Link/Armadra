/**
 * 窗口背景色板（AMA-Link/Armadra#474）。取值在 `styles/backdrops.css`，这里只有
 * 名字与顺序：`plain` 在最前，也是默认（与改动之前一致）。
 */
export const BACKDROPS = ["plain", "petal", "mist", "meadow", "dusk"] as const;

export type Backdrop = (typeof BACKDROPS)[number];
