import { colorHex } from "../../whiteboard/palette";
import { canvasScheme } from "../../whiteboard/scheme";
import { peekImage } from "./images";

/**
 * 引擎绘制环境里的颜色与位图（屏幕与导出共用）：颜色名按画布底色取那一套色值
 * （`scheme.ts`：判据是画布底色，不是应用主题）；点阵色叫 `dot`。
 */
export function boardColor(name: string): string {
  const scheme = canvasScheme();
  if (name === "dot") {
    return scheme === "dark" ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)";
  }
  return colorHex(name, scheme);
}

export const boardImage = (key: string) => peekImage(key);
