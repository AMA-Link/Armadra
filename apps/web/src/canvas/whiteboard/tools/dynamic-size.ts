import {
  getBaseSize,
  getNextStyle,
  setDerivedSize,
} from "../../interaction/tool-store";
import { scaledSize } from "../palette";

/**
 * 「动态尺寸」（§2.10）：缩小时新对象自动粗一档。改的是
 * `tool-store.nextStyle`，所以样式面板显示的也是这一档，不会出现
 * 「面板写着 M、画出来是 L」。
 *
 * 缩放**永远**从 `getBaseSize()` 算，不拿上一笔的结果再缩一次——那样档位
 * 只升不降，回到 100% 也退不回来。开关关掉时同样把档位放回基准，否则最后
 * 一次缩放的结果会一直挂在那里。
 */
export function applyDynamicSize(enabled: boolean, zoom: number): void {
  const base = getBaseSize();
  const size = enabled ? scaledSize(base, zoom) : base;
  if (size !== getNextStyle().size) setDerivedSize(size);
}
